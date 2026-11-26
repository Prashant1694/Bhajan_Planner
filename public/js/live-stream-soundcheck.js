/**
 * Mandatory Dual-Input Identification, Channel Isolation & Hardware Soundcheck
 * UMD module: works in browser (window.LiveStreamSoundcheck) and Node.js tests.
 *
 * Physical Hardware Mapping (Behringer 2-Channel USB Interface):
 *   - Default: Physical Input 1 -> Vocals Bus | Physical Input 2 -> Instruments Bus
 *   - Supports reversing via `swapChannels`
 *   - Never silently passes 1-channel duplicated mono when dual independent stems are required
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.LiveStreamSoundcheck = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const STAGE_VOCAL = "stage1_vocal";
  const STAGE_INST = "stage2_inst";
  const STAGE_BOTH = "stage3_both";
  const STAGE_VERIFIED = "verified";

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  function linearToDb(lin) {
    const val = Number(lin) || 0;
    if (val <= 0.00001) return -96;
    return Math.max(-96, 20 * Math.log10(val));
  }

  function createSoundcheckSession(info = {}) {
    const sampleRate = Number(info.sampleRate) || 48000;
    const channelCount = Number(info.channelCount) || 2;
    const deviceName = String(info.deviceName || "Audio Interface");
    const sourceType = info.sourceType || "wasapi"; // "wasapi" | "asio" | "file"
    const swapChannels = Boolean(info.swapChannels);
    const singleChannelAllowed = Boolean(info.singleChannelAllowed);

    return {
      stage: STAGE_VOCAL,
      deviceName,
      sourceType,
      sampleRate,
      channelCount,
      swapChannels,
      singleChannelAllowed,
      connected: info.connected !== false,
      disconnectedReason: null,
      clipCountVocal: 0,
      clipCountInst: 0,
      latest: {
        vocalPeakDb: -96,
        vocalRmsDb: -96,
        instPeakDb: -96,
        instRmsDb: -96,
        corr12: 0,
        noiseFloorVocalDb: -96,
        noiseFloorInstDb: -96
      },
      monoDuplicationDetected: false,
      monoDuplicationFrames: 0,
      stage1Pass: false,
      stage2Pass: false,
      stage3Pass: false,
      history: []
    };
  }

  /**
   * Ingest one telemetry block from the audio engine / AudioWorklet.
   * rawCh1 is always Physical Input 1; rawCh2 is always Physical Input 2.
   * When swapChannels is false: Vocals <- Physical In 1, Instruments <- Physical In 2.
   * When swapChannels is true:  Vocals <- Physical In 2, Instruments <- Physical In 1.
   */
  function ingestTelemetryFrame(session, frame = {}) {
    if (!session) return null;

    const raw1Peak = Number(frame.peak1 ?? 0);
    const raw1Rms = Number(frame.rms1 ?? 0);
    const raw2Peak = Number(frame.peak2 ?? 0);
    const raw2Rms = Number(frame.rms2 ?? 0);
    const corr12 = Number(frame.corr12 ?? 0);

    const vocalPeak = session.swapChannels ? raw2Peak : raw1Peak;
    const vocalRms = session.swapChannels ? raw2Rms : raw1Rms;
    const instPeak = session.swapChannels ? raw1Peak : raw2Peak;
    const instRms = session.swapChannels ? raw1Rms : raw2Rms;

    const vocalPeakDb = linearToDb(vocalPeak);
    const vocalRmsDb = linearToDb(vocalRms);
    const instPeakDb = linearToDb(instPeak);
    const instRmsDb = linearToDb(instRms);

    if (vocalPeak >= 0.985) session.clipCountVocal += 1;
    if (instPeak >= 0.985) session.clipCountInst += 1;

    // Estimate resting noise floor from quiet frames (< -38 dBFS)
    if (vocalRmsDb > -90 && vocalRmsDb < -38) {
      session.latest.noiseFloorVocalDb =
        session.latest.noiseFloorVocalDb <= -90
          ? vocalRmsDb
          : session.latest.noiseFloorVocalDb * 0.8 + vocalRmsDb * 0.2;
    }
    if (instRmsDb > -90 && instRmsDb < -38) {
      session.latest.noiseFloorInstDb =
        session.latest.noiseFloorInstDb <= -90
          ? instRmsDb
          : session.latest.noiseFloorInstDb * 0.8 + instRmsDb * 0.2;
    }

    session.latest.vocalPeakDb = vocalPeakDb;
    session.latest.vocalRmsDb = vocalRmsDb;
    session.latest.instPeakDb = instPeakDb;
    session.latest.instRmsDb = instRmsDb;
    session.latest.corr12 = clamp(corr12, -1, 1);

    // Detect Windows mono-duplicated driver bug: both inputs loud, nearly identical peak & corr > 0.97
    const bothAudible = vocalPeakDb > -36 && instPeakDb > -36;
    const nearIdenticalLevel = Math.abs(vocalPeakDb - instPeakDb) < 0.8;
    const highCorrelation = Math.abs(corr12) > 0.97;
    if (session.sourceType !== "file" && (session.channelCount < 2 || (bothAudible && nearIdenticalLevel && highCorrelation))) {
      session.monoDuplicationFrames += 1;
      if (session.monoDuplicationFrames >= 3 || session.channelCount < 2) {
        session.monoDuplicationDetected = true;
      }
    } else if (bothAudible && Math.abs(corr12) < 0.85) {
      session.monoDuplicationFrames = 0;
      session.monoDuplicationDetected = false;
    }

    // Evaluate stage isolation thresholds (>= 12 dB separation)
    if (session.stage === STAGE_VOCAL) {
      const vocalActive = vocalPeakDb >= -42;
      const instQuiet = instPeakDb <= -48 || vocalPeakDb - instPeakDb >= 12;
      if (vocalActive && instQuiet && !session.monoDuplicationDetected) {
        session.stage1Pass = true;
      }
    } else if (session.stage === STAGE_INST) {
      const instActive = instPeakDb >= -42;
      const vocalQuiet = vocalPeakDb <= -48 || instPeakDb - vocalPeakDb >= 12;
      if (instActive && vocalQuiet && !session.monoDuplicationDetected) {
        session.stage2Pass = true;
      }
    } else if (session.stage === STAGE_BOTH) {
      if (vocalPeakDb >= -42 && instPeakDb >= -42 && !session.monoDuplicationDetected) {
        session.stage3Pass = true;
      }
    }

    return {
      vocalPeakDb,
      vocalRmsDb,
      instPeakDb,
      instRmsDb,
      corr12: session.latest.corr12,
      monoDuplicationDetected: session.monoDuplicationDetected,
      stage1Pass: session.stage1Pass,
      stage2Pass: session.stage2Pass,
      stage3Pass: session.stage3Pass
    };
  }

  function setSoundcheckStage(session, nextStage) {
    if (!session) return null;
    const allowed = [STAGE_VOCAL, STAGE_INST, STAGE_BOTH, STAGE_VERIFIED];
    if (allowed.includes(nextStage)) {
      session.stage = nextStage;
    }
    return session.stage;
  }

  function markDisconnected(session, reason) {
    if (!session) return;
    session.connected = false;
    session.disconnectedReason = reason || "Audio interface disconnected.";
  }

  function evaluateReadiness(session, options = {}) {
    if (!session) {
      return {
        ready: false,
        canRecordDualStems: false,
        severity: "error",
        message: "Initialize audio device soundcheck first."
      };
    }

    const requireDualInput = options.requireDualInput !== false && !session.singleChannelAllowed;

    if (!session.connected) {
      return {
        ready: false,
        canRecordDualStems: false,
        severity: "error",
        message: session.disconnectedReason || "Audio interface disconnected. Reconnect USB cable and restart soundcheck."
      };
    }

    if (session.channelCount < 2 && requireDualInput && session.sourceType !== "file") {
      return {
        ready: false,
        canRecordDualStems: false,
        severity: "error",
        message:
          `Only ${session.channelCount} input channel detected on "${session.deviceName}". ` +
          "Set Windows Sound Control Panel -> Recording -> Advanced to 2 channel, 24-bit, 48000 Hz (or launch Local ASIO Bridge)."
      };
    }

    if (session.monoDuplicationDetected && requireDualInput && session.sourceType !== "file") {
      return {
        ready: false,
        canRecordDualStems: false,
        severity: "error",
        message:
          "Input 1 and Input 2 carry identical summed mono audio (corr > 0.97). " +
          "Check Behringer stereo USB driver or switch to Local ASIO Bridge before recording dry stems."
      };
    }

    const dualVerified = session.stage1Pass && session.stage2Pass && session.stage3Pass;
    if (dualVerified || session.stage === STAGE_VERIFIED) {
      return {
        ready: true,
        canRecordDualStems: true,
        severity: "ok",
        message:
          `Verified dual independent inputs @ ${session.sampleRate} Hz (${session.sourceType.toUpperCase()}). ` +
          `${session.swapChannels ? "In 2 -> Vocals, In 1 -> Instruments" : "In 1 -> Vocals, In 2 -> Instruments"}.`
      };
    }

    return {
      ready: true,
      canRecordDualStems: session.channelCount >= 2 && !session.monoDuplicationDetected,
      severity: "warn",
      message: "Device connected. Run Step 1 (Vocals), Step 2 (Instruments), and Step 3 (Both) to verify channel isolation."
    };
  }

  return {
    STAGE_VOCAL,
    STAGE_INST,
    STAGE_BOTH,
    STAGE_VERIFIED,
    linearToDb,
    createSoundcheckSession,
    ingestTelemetryFrame,
    setSoundcheckStage,
    markDisconnected,
    evaluateReadiness
  };
});
