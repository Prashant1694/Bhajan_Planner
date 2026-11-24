/**
 * Admin Pro Live Broadcast Studio (Mode A Dual-Bus Mixer + Stereo Master)
 * - Behringer 2-channel digital split (Ch1 Instruments / Ch2 Vocals)
 * - Independent channel HPF, 3-band EQ, Vocal Compressor & PFL Solo
 * - 5-band Master EQ + Mandir Hall Reverb + Brickwall Safety Limiter
 * - Real-time Earphone Monitor with output device selection (setSinkId)
 * - Dedicated AudioWorklet -> Web Worker Stereo MP3 Encoder (up to 320 kbps)
 */
(function (window, document) {
  "use strict";

  const boot = window.__LIVE_STUDIO_BOOT__ || {};
  const csrfToken =
    (document.querySelector('meta[name="csrf-token"]') &&
      document.querySelector('meta[name="csrf-token"]').getAttribute("content")) ||
    window.csrfToken ||
    "";

  let presets = Array.isArray(boot.presets) ? boot.presets.slice() : [];
  let streamState = boot.streamState || { isLive: false, listenerCount: 0 };
  let bhajansList = Array.isArray(boot.bhajans) ? boot.bhajans.slice() : [];

  const defaultConfig =
    (presets[0] && JSON.parse(JSON.stringify(presets[0].config))) || {
      mode: "split",
      swapChannels: false,
      inst: { gain: 100, mute: false, hpf: 45, low: 0, mid: 0, high: 0 },
      vocal: { gain: 100, mute: false, hpf: 85, low: 0, mid: 0, high: 0, comp: true },
      reverb: { wet: 14, decay: 1.4 },
      master: {
        b80: 0,
        b250: 0,
        b1k: 0,
        b3k5: 0,
        b10k: 0,
        limiter: true,
        gain: 100,
        bypass: false
      }
    };

  let activeConfig = JSON.parse(JSON.stringify(defaultConfig));
  let soloChannel = null; // null | "inst" | "vocal"
  let broadcastMuted = false;
  let monitorEnabled = false;
  let monitorVolume = 0.8;

  // Web Audio & Worker instances
  let activeSourceMode = "device"; // "device" | "file"
  let testFileObj = null;
  let testFileUrl = null;
  let testFileAudioEl = null;
  let mediaStream = null;
  let audioCtx = null;
  let workletNode = null;
  let encoderWorker = null;
  let ws = null;
  let ingestToken = null;
  let isLive = Boolean(streamState.isLive);
  let intentionalStop = false;
  let reconnectTimer = null;
  let statsTimer = null;
  let meterRaf = null;
  let liveStartedMs = streamState.startedAt ? Date.parse(streamState.startedAt) : null;
  let bytesSentTotal = 0;
  let recordedChunks = [];
  let backupDownloadUrl = null;
  let eventSource = null;

  // DSP Nodes
  let nodes = null;
  let monitorAudioEl = null;

  function $(id) {
    return document.getElementById(id);
  }

  function apiHeaders(extra) {
    return Object.assign(
      {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken
      },
      extra || {}
    );
  }

  function showStudioMessage(text, isError) {
    const box = $("lsStudioNotice");
    if (!box) return;
    if (!text) {
      box.style.display = "none";
      box.textContent = "";
      return;
    }
    box.style.display = "block";
    box.textContent = text;
    box.style.borderColor = isError ? "#dc2626" : "rgba(217, 119, 6, 0.4)";
    box.style.color = isError ? "#dc2626" : "var(--ink, #1c1917)";
  }

  function buildImpulseResponse(ctx, seconds) {
    const rate = ctx.sampleRate || 48000;
    const len = Math.max(rate * 0.3, Math.floor(rate * Math.min(3.0, Math.max(0.4, seconds))));
    const impulse = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const decay = Math.pow(1 - i / len, 2.6);
        const white = Math.random() * 2 - 1;
        lp = lp * 0.65 + white * 0.35;
        data[i] = lp * decay * 0.6;
      }
    }
    return impulse;
  }

  function rampParam(param, value) {
    if (!param || !audioCtx) return;
    param.setTargetAtTime(value, audioCtx.currentTime, 0.025);
  }

  function applyConfigToGraph() {
    if (!nodes || !audioCtx) return;
    const c = activeConfig;
    const isSplit = c.mode !== "stereo";

    // Channel swap matrix
    if (isSplit) {
      rampParam(nodes.ch1FromL.gain, c.swapChannels ? 0 : 1);
      rampParam(nodes.ch1FromR.gain, c.swapChannels ? 1 : 0);
      rampParam(nodes.ch2FromL.gain, c.swapChannels ? 1 : 0);
      rampParam(nodes.ch2FromR.gain, c.swapChannels ? 0 : 1);
      rampParam(nodes.splitMasterGate.gain, 1);
      rampParam(nodes.stereoPassGain.gain, 0);
    } else {
      rampParam(nodes.splitMasterGate.gain, 0);
      rampParam(nodes.stereoPassGain.gain, 1);
    }

    // Channel 1 (Instruments)
    rampParam(nodes.instGain.gain, (c.inst.gain || 0) / 100);
    rampParam(nodes.instMuteGain.gain, c.inst.mute ? 0 : 1);
    rampParam(nodes.instHpf.frequency, Math.max(20, c.inst.hpf || 20));
    rampParam(nodes.instEqLow.gain, c.inst.low || 0);
    rampParam(nodes.instEqMid.gain, c.inst.mid || 0);
    rampParam(nodes.instEqHigh.gain, c.inst.high || 0);

    // Channel 2 (Vocals)
    rampParam(nodes.vocalGain.gain, (c.vocal.gain || 0) / 100);
    rampParam(nodes.vocalMuteGain.gain, c.vocal.mute ? 0 : 1);
    rampParam(nodes.vocalHpf.frequency, Math.max(20, c.vocal.hpf || 20));
    rampParam(nodes.vocalEqLow.gain, c.vocal.low || 0);
    rampParam(nodes.vocalEqMid.gain, c.vocal.mid || 0);
    rampParam(nodes.vocalEqHigh.gain, c.vocal.high || 0);

    if (c.vocal.comp) {
      rampParam(nodes.vocalComp.threshold, -18);
      rampParam(nodes.vocalComp.ratio, 3.5);
    } else {
      rampParam(nodes.vocalComp.threshold, 0);
      rampParam(nodes.vocalComp.ratio, 1);
    }

    // Reverb send
    const wetAmount = isSplit ? (c.reverb.wet || 0) / 100 : (c.reverb.wet || 0) / 160;
    rampParam(nodes.reverbSendGain.gain, wetAmount);

    // 5-Band Master EQ
    const bypass = Boolean(c.master.bypass);
    rampParam(nodes.m80.gain, bypass ? 0 : c.master.b80 || 0);
    rampParam(nodes.m250.gain, bypass ? 0 : c.master.b250 || 0);
    rampParam(nodes.m1k.gain, bypass ? 0 : c.master.b1k || 0);
    rampParam(nodes.m3k5.gain, bypass ? 0 : c.master.b3k5 || 0);
    rampParam(nodes.m10k.gain, bypass ? 0 : c.master.b10k || 0);

    // Limiter
    if (c.master.limiter !== false) {
      rampParam(nodes.limiter.threshold, -1.5);
      rampParam(nodes.limiter.ratio, 20);
    } else {
      rampParam(nodes.limiter.threshold, 0);
      rampParam(nodes.limiter.ratio, 1);
    }

    rampParam(nodes.masterOutGain.gain, (c.master.gain || 100) / 100);
    rampParam(nodes.broadcastMuteGain.gain, broadcastMuted ? 0 : 1);

    // Earphone Monitor & PFL Solo routing
    if (!monitorEnabled) {
      rampParam(nodes.monMasterGain.gain, 0);
      rampParam(nodes.monInstPflGain.gain, 0);
      rampParam(nodes.monVocalPflGain.gain, 0);
    } else if (soloChannel === "inst") {
      rampParam(nodes.monMasterGain.gain, 0);
      rampParam(nodes.monInstPflGain.gain, monitorVolume);
      rampParam(nodes.monVocalPflGain.gain, 0);
    } else if (soloChannel === "vocal") {
      rampParam(nodes.monMasterGain.gain, 0);
      rampParam(nodes.monInstPflGain.gain, 0);
      rampParam(nodes.monVocalPflGain.gain, monitorVolume);
    } else {
      rampParam(nodes.monMasterGain.gain, monitorVolume);
      rampParam(nodes.monInstPflGain.gain, 0);
      rampParam(nodes.monVocalPflGain.gain, 0);
    }
  }

  function bindVal(sliderId, labelId, suffix, getter, setter) {
    const el = $(sliderId);
    const lbl = $(labelId);
    if (!el) return;
    el.value = String(getter());
    if (lbl) lbl.textContent = `${getter()}${suffix}`;
    el.oninput = function () {
      const val = Number(el.value);
      setter(val);
      if (lbl) lbl.textContent = `${val}${suffix}`;
      applyConfigToGraph();
    };
  }

  function syncUiFromConfig() {
    const c = activeConfig;
    const modeSelect = $("lsInputMode");
    if (modeSelect) modeSelect.value = c.mode === "stereo" ? "stereo" : "split";

    const swapBtn = $("lsSwapBtn");
    if (swapBtn) swapBtn.classList.toggle("is-toggled", Boolean(c.swapChannels));

    const compBtn = $("lsVocalCompBtn");
    if (compBtn) {
      compBtn.classList.toggle("is-toggled", Boolean(c.vocal.comp));
      compBtn.textContent = c.vocal.comp ? "Vocal Comp: ON" : "Vocal Comp: OFF";
    }

    const eqBypassBtn = $("lsMasterBypassBtn");
    if (eqBypassBtn) {
      eqBypassBtn.classList.toggle("is-toggled", Boolean(c.master.bypass));
      eqBypassBtn.textContent = c.master.bypass ? "EQ Bypassed" : "EQ Active";
    }

    const limBtn = $("lsLimiterBtn");
    if (limBtn) {
      const limOn = c.master.limiter !== false;
      limBtn.classList.toggle("is-toggled", limOn);
      limBtn.textContent = limOn ? "Limiter: ON (-1.5dB)" : "Limiter: OFF";
    }

    const instMuteBtn = $("lsInstMuteBtn");
    if (instMuteBtn) instMuteBtn.classList.toggle("is-muted-active", Boolean(c.inst.mute));
    const vocalMuteBtn = $("lsVocalMuteBtn");
    if (vocalMuteBtn) vocalMuteBtn.classList.toggle("is-muted-active", Boolean(c.vocal.mute));

    bindVal("lsInstGain", "lsInstGainVal", "%", () => c.inst.gain, (v) => (c.inst.gain = v));
    bindVal("lsInstHpf", "lsInstHpfVal", " Hz", () => c.inst.hpf, (v) => (c.inst.hpf = v));
    bindVal("lsInstLow", "lsInstLowVal", " dB", () => c.inst.low, (v) => (c.inst.low = v));
    bindVal("lsInstMid", "lsInstMidVal", " dB", () => c.inst.mid, (v) => (c.inst.mid = v));
    bindVal("lsInstHigh", "lsInstHighVal", " dB", () => c.inst.high, (v) => (c.inst.high = v));

    bindVal("lsVocalGain", "lsVocalGainVal", "%", () => c.vocal.gain, (v) => (c.vocal.gain = v));
    bindVal("lsVocalHpf", "lsVocalHpfVal", " Hz", () => c.vocal.hpf, (v) => (c.vocal.hpf = v));
    bindVal("lsVocalLow", "lsVocalLowVal", " dB", () => c.vocal.low, (v) => (c.vocal.low = v));
    bindVal("lsVocalMid", "lsVocalMidVal", " dB", () => c.vocal.mid, (v) => (c.vocal.mid = v));
    bindVal("lsVocalHigh", "lsVocalHighVal", " dB", () => c.vocal.high, (v) => (c.vocal.high = v));

    bindVal("lsReverbWet", "lsReverbWetVal", "%", () => c.reverb.wet, (v) => (c.reverb.wet = v));
    bindVal(
      "lsReverbDecay",
      "lsReverbDecayVal",
      "s",
      () => c.reverb.decay,
      (v) => {
        c.reverb.decay = v;
        if (nodes && audioCtx && nodes.convolver) {
          nodes.convolver.buffer = buildImpulseResponse(audioCtx, v);
        }
      }
    );

    bindVal("lsMaster80", "lsMaster80Val", " dB", () => c.master.b80, (v) => (c.master.b80 = v));
    bindVal("lsMaster250", "lsMaster250Val", " dB", () => c.master.b250, (v) => (c.master.b250 = v));
    bindVal("lsMaster1k", "lsMaster1kVal", " dB", () => c.master.b1k, (v) => (c.master.b1k = v));
    bindVal("lsMaster3k5", "lsMaster3k5Val", " dB", () => c.master.b3k5, (v) => (c.master.b3k5 = v));
    bindVal("lsMaster10k", "lsMaster10kVal", " dB", () => c.master.b10k, (v) => (c.master.b10k = v));
    bindVal("lsMasterGain", "lsMasterGainVal", "%", () => c.master.gain, (v) => (c.master.gain = v));

    const splitGrid = $("lsChannelsGrid");
    if (splitGrid) {
      splitGrid.style.opacity = c.mode === "stereo" ? "0.45" : "1";
    }
    applyConfigToGraph();
  }

  function renderPresetOptions(selectedId) {
    const sel = $("lsPresetSelect");
    const delBtn = $("lsDeletePresetBtn");
    if (!sel) return;
    sel.innerHTML = "";
    for (const p of presets) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.isBuiltIn ? `${p.name} (Built-in)` : `${p.name} (Custom)`;
      sel.appendChild(opt);
    }
    if (selectedId && presets.some((p) => p.id === selectedId)) {
      sel.value = selectedId;
    }
    const chosen = presets.find((p) => p.id === sel.value);
    if (delBtn) {
      delBtn.disabled = !chosen || chosen.isBuiltIn;
    }
  }

  async function refreshAudioDevices(requestPermission) {
    if (!window.isSecureContext) {
      showStudioMessage("Audio capture requires http://localhost:5000 or HTTPS.", true);
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      showStudioMessage("Browser media device API unavailable. Open over HTTPS or localhost.", true);
      return;
    }
    try {
      if (requestPermission === true && navigator.mediaDevices.getUserMedia) {
        const temp = await navigator.mediaDevices.getUserMedia({ audio: true });
        temp.getTracks().forEach((t) => t.stop());
      }

      const list = await navigator.mediaDevices.enumerateDevices();
      const inSel = $("lsAudioInputSelect");
      const outSel = $("lsMonitorOutputSelect");
      const prevIn = inSel ? inSel.value : "";
      const prevOut = outSel ? outSel.value : "";

      if (inSel) {
        inSel.innerHTML = "";
        const inputs = list.filter((d) => d.kind === "audioinput");
        const needsPermission =
          inputs.length > 0 && inputs.every((d) => !d.label && !d.deviceId);
        if (inputs.length === 0 || needsPermission) {
          const opt = document.createElement("option");
          opt.value = "";
          opt.textContent = needsPermission
            ? "Click 'Detect / Refresh Devices' to allow audio access"
            : "No audio inputs detected (plug in interface and click Detect)";
          inSel.appendChild(opt);
        } else {
          inputs.forEach((d, idx) => {
            const opt = document.createElement("option");
            opt.value = d.deviceId;
            opt.textContent = d.label || `Audio Input ${idx + 1}`;
            inSel.appendChild(opt);
          });
          if (prevIn && inputs.some((d) => d.deviceId === prevIn)) {
            inSel.value = prevIn;
          } else {
            const behringer = inputs.find((d) => /behringer|umc|usb audio|line/i.test(d.label || ""));
            if (behringer) inSel.value = behringer.deviceId;
          }
        }
      }

      if (outSel) {
        outSel.innerHTML = "";
        const defaultOpt = document.createElement("option");
        defaultOpt.value = "";
        defaultOpt.textContent = "System Default Earphones / Output";
        outSel.appendChild(defaultOpt);
        const outputs = list.filter((d) => d.kind === "audiooutput");
        outputs.forEach((d, idx) => {
          if (!d.deviceId || d.deviceId === "default") return;
          const opt = document.createElement("option");
          opt.value = d.deviceId;
          opt.textContent = d.label || `Audio Output ${idx + 1}`;
          outSel.appendChild(opt);
        });
        if (prevOut && outputs.some((d) => d.deviceId === prevOut)) {
          outSel.value = prevOut;
        }
      }
      if (requestPermission === true) {
        showStudioMessage("Audio devices refreshed successfully!", false);
      }
    } catch (err) {
      showStudioMessage("Could not access audio interfaces: " + err.message, true);
    }
  }

  function updateMetersLoop() {
    if (!nodes || !audioCtx) return;

    function measurePeak(analyser, fillEl, clipEl) {
      if (!analyser || !fillEl) return;
      const arr = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(arr);
      let peak = 0;
      for (let i = 0; i < arr.length; i++) {
        const a = Math.abs(arr[i]);
        if (a > peak) peak = a;
      }
      const db = peak > 0.00001 ? 20 * Math.log10(peak) : -60;
      const pct = Math.max(0, Math.min(100, ((db + 54) / 54) * 100));
      fillEl.style.width = `${pct.toFixed(1)}%`;
      if (clipEl) {
        clipEl.classList.toggle("is-clipping", peak >= 0.96);
      }
    }

    measurePeak(nodes.instAnalyser, $("lsInstMeterFill"), $("lsInstClip"));
    measurePeak(nodes.vocalAnalyser, $("lsVocalMeterFill"), $("lsVocalClip"));
    measurePeak(nodes.masterAnalyser, $("lsMasterMeterFill"), $("lsMasterClip"));

    meterRaf = window.requestAnimationFrame(updateMetersLoop);
  }

  async function initAudioEngine(requestedMode) {
    const mode = requestedMode || activeSourceMode || "device";
    if (
      audioCtx &&
      activeSourceMode === mode &&
      ((mode === "device" && mediaStream) || (mode === "file" && testFileAudioEl))
    ) {
      if (audioCtx.state === "suspended") await audioCtx.resume();
      if (mode === "file" && testFileAudioEl && testFileAudioEl.paused) {
        await testFileAudioEl.play();
      }
      return;
    }

    if (audioCtx) {
      await releaseAudioEngine();
    }

    activeSourceMode = mode;
    let hwChannels = 2;
    let hwRate = 48000;

    if (mode === "file") {
      if (!testFileUrl) {
        throw new Error("Please select an audio file (MP3/WAV) first.");
      }
      testFileAudioEl = document.createElement("audio");
      testFileAudioEl.src = testFileUrl;
      testFileAudioEl.loop = Boolean($("lsTestFileLoopCheck")?.checked);
      testFileAudioEl.preload = "auto";
    } else {
      const inSel = $("lsAudioInputSelect");
      const deviceId = inSel && inSel.value ? inSel.value : undefined;

      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId ? { ideal: deviceId } : undefined,
          channelCount: { ideal: 2 },
          sampleRate: { ideal: 48000 },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      });

      await refreshAudioDevices(false);

      const track = mediaStream.getAudioTracks()[0];
      const settings = track && typeof track.getSettings === "function" ? track.getSettings() : {};
      hwChannels = settings.channelCount || 1;
      hwRate = settings.sampleRate || 48000;
    }

    const hwPill = $("lsHwInfoPill");
    if (hwPill) {
      hwPill.textContent =
        mode === "file"
          ? `Test File (${testFileObj ? testFileObj.name : "Audio"}) · ${hwRate} Hz · 2 ch`
          : `${hwRate} Hz · ${hwChannels} ch`;
    }

    const monoWarn = $("lsMonoWarning");
    if (monoWarn) {
      monoWarn.style.display =
        mode === "device" && hwChannels < 2 && activeConfig.mode === "split" ? "block" : "none";
    }

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioCtx({
      sampleRate: hwRate,
      latencyHint: "interactive"
    });
    if (audioCtx.state === "suspended") {
      await audioCtx.resume();
    }

    await audioCtx.audioWorklet.addModule("/js/live-stream-worklet.js?v=1.0");

    const source =
      mode === "file"
        ? audioCtx.createMediaElementSource(testFileAudioEl)
        : audioCtx.createMediaStreamSource(mediaStream);
    const splitter = audioCtx.createChannelSplitter(Math.max(2, source.channelCount || 2));
    source.connect(splitter);

    if (mode === "file" && testFileAudioEl) {
      await testFileAudioEl.play();
    }

    const ch1FromL = audioCtx.createGain();
    const ch1FromR = audioCtx.createGain();
    const ch2FromL = audioCtx.createGain();
    const ch2FromR = audioCtx.createGain();
    splitter.connect(ch1FromL, 0);
    splitter.connect(ch1FromR, 1);
    splitter.connect(ch2FromL, 0);
    splitter.connect(ch2FromR, 1);

    // Ch1 Instruments
    const instGain = audioCtx.createGain();
    const instHpf = audioCtx.createBiquadFilter();
    instHpf.type = "highpass";
    instHpf.Q.value = 0.707;
    const instEqLow = audioCtx.createBiquadFilter();
    instEqLow.type = "lowshelf";
    instEqLow.frequency.value = 90;
    const instEqMid = audioCtx.createBiquadFilter();
    instEqMid.type = "peaking";
    instEqMid.frequency.value = 450;
    instEqMid.Q.value = 1.0;
    const instEqHigh = audioCtx.createBiquadFilter();
    instEqHigh.type = "highshelf";
    instEqHigh.frequency.value = 4500;
    const instAnalyser = audioCtx.createAnalyser();
    instAnalyser.fftSize = 1024;
    const instMuteGain = audioCtx.createGain();

    ch1FromL.connect(instGain);
    ch1FromR.connect(instGain);
    instGain
      .connect(instHpf)
      .connect(instEqLow)
      .connect(instEqMid)
      .connect(instEqHigh)
      .connect(instAnalyser)
      .connect(instMuteGain);

    // Ch2 Vocals
    const vocalGain = audioCtx.createGain();
    const vocalHpf = audioCtx.createBiquadFilter();
    vocalHpf.type = "highpass";
    vocalHpf.Q.value = 0.707;
    const vocalEqLow = audioCtx.createBiquadFilter();
    vocalEqLow.type = "lowshelf";
    vocalEqLow.frequency.value = 220;
    const vocalEqMid = audioCtx.createBiquadFilter();
    vocalEqMid.type = "peaking";
    vocalEqMid.frequency.value = 3200;
    vocalEqMid.Q.value = 1.1;
    const vocalEqHigh = audioCtx.createBiquadFilter();
    vocalEqHigh.type = "highshelf";
    vocalEqHigh.frequency.value = 9000;
    const vocalComp = audioCtx.createDynamicsCompressor();
    vocalComp.knee.value = 10;
    vocalComp.attack.value = 0.006;
    vocalComp.release.value = 0.16;
    const vocalAnalyser = audioCtx.createAnalyser();
    vocalAnalyser.fftSize = 1024;
    const vocalMuteGain = audioCtx.createGain();

    ch2FromL.connect(vocalGain);
    ch2FromR.connect(vocalGain);
    vocalGain
      .connect(vocalHpf)
      .connect(vocalEqLow)
      .connect(vocalEqMid)
      .connect(vocalEqHigh)
      .connect(vocalComp)
      .connect(vocalAnalyser)
      .connect(vocalMuteGain);

    // Dual-mono center sum + Reverb send
    const mixCenterMerger = audioCtx.createChannelMerger(2);
    instMuteGain.connect(mixCenterMerger, 0, 0);
    instMuteGain.connect(mixCenterMerger, 0, 1);
    vocalMuteGain.connect(mixCenterMerger, 0, 0);
    vocalMuteGain.connect(mixCenterMerger, 0, 1);

    const splitMasterGate = audioCtx.createGain();
    const stereoPassGain = audioCtx.createGain();
    mixCenterMerger.connect(splitMasterGate);
    source.connect(stereoPassGain);

    const reverbSendGain = audioCtx.createGain();
    const convolver = audioCtx.createConvolver();
    convolver.buffer = buildImpulseResponse(audioCtx, activeConfig.reverb.decay || 1.4);
    mixCenterMerger.connect(reverbSendGain);
    stereoPassGain.connect(reverbSendGain);
    reverbSendGain.connect(convolver);

    // 5-Band Master EQ
    const m80 = audioCtx.createBiquadFilter();
    m80.type = "lowshelf";
    m80.frequency.value = 80;
    const m250 = audioCtx.createBiquadFilter();
    m250.type = "peaking";
    m250.frequency.value = 250;
    m250.Q.value = 1.0;
    const m1k = audioCtx.createBiquadFilter();
    m1k.type = "peaking";
    m1k.frequency.value = 1000;
    m1k.Q.value = 0.9;
    const m3k5 = audioCtx.createBiquadFilter();
    m3k5.type = "peaking";
    m3k5.frequency.value = 3500;
    m3k5.Q.value = 1.1;
    const m10k = audioCtx.createBiquadFilter();
    m10k.type = "highshelf";
    m10k.frequency.value = 10000;

    const limiter = audioCtx.createDynamicsCompressor();
    limiter.knee.value = 0;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.08;

    const masterOutGain = audioCtx.createGain();
    const broadcastMuteGain = audioCtx.createGain();
    const masterAnalyser = audioCtx.createAnalyser();
    masterAnalyser.fftSize = 1024;

    splitMasterGate.connect(m80);
    stereoPassGain.connect(m80);
    convolver.connect(m80);

    m80.connect(m250).connect(m1k).connect(m3k5).connect(m10k).connect(limiter).connect(masterOutGain);
    masterOutGain.connect(broadcastMuteGain).connect(masterAnalyser);

    workletNode = new AudioWorkletNode(audioCtx, "bp-pcm-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2]
    });
    const silentSink = audioCtx.createGain();
    silentSink.gain.value = 0;
    masterAnalyser.connect(workletNode).connect(silentSink).connect(audioCtx.destination);

    // Earphone monitor routing (supports PFL Solo & setSinkId)
    const monitorDest = audioCtx.createMediaStreamDestination();
    const monMasterGain = audioCtx.createGain();
    const monInstPflGain = audioCtx.createGain();
    const monVocalPflGain = audioCtx.createGain();
    const monStereoMerger = audioCtx.createChannelMerger(2);

    masterOutGain.connect(monMasterGain).connect(monitorDest);
    instAnalyser.connect(monStereoMerger, 0, 0);
    instAnalyser.connect(monStereoMerger, 0, 1);
    const vocalPflMerger = audioCtx.createChannelMerger(2);
    vocalAnalyser.connect(vocalPflMerger, 0, 0);
    vocalAnalyser.connect(vocalPflMerger, 0, 1);

    monStereoMerger.connect(monInstPflGain).connect(monitorDest);
    vocalPflMerger.connect(monVocalPflGain).connect(monitorDest);

    if (!monitorAudioEl) {
      monitorAudioEl = document.createElement("audio");
      monitorAudioEl.autoplay = true;
      monitorAudioEl.playsInline = true;
      monitorAudioEl.style.display = "none";
      document.body.appendChild(monitorAudioEl);
    }
    monitorAudioEl.srcObject = monitorDest.stream;
    const outSel = $("lsMonitorOutputSelect");
    if (outSel && outSel.value && typeof monitorAudioEl.setSinkId === "function") {
      try {
        await monitorAudioEl.setSinkId(outSel.value);
      } catch (_) {}
    }

    nodes = {
      source,
      splitter,
      ch1FromL,
      ch1FromR,
      ch2FromL,
      ch2FromR,
      instGain,
      instHpf,
      instEqLow,
      instEqMid,
      instEqHigh,
      instAnalyser,
      instMuteGain,
      vocalGain,
      vocalHpf,
      vocalEqLow,
      vocalEqMid,
      vocalEqHigh,
      vocalComp,
      vocalAnalyser,
      vocalMuteGain,
      splitMasterGate,
      stereoPassGain,
      reverbSendGain,
      convolver,
      m80,
      m250,
      m1k,
      m3k5,
      m10k,
      limiter,
      masterOutGain,
      broadcastMuteGain,
      masterAnalyser,
      monitorDest,
      monMasterGain,
      monInstPflGain,
      monVocalPflGain
    };

    workletNode.port.onmessage = function (ev) {
      const msg = ev.data;
      if (msg && msg.type === "pcm" && encoderWorker && isLive) {
        encoderWorker.postMessage(
          { type: "encode", left: msg.left, right: msg.right },
          [msg.left.buffer, msg.right.buffer]
        );
      }
    };

    applyConfigToGraph();
    if (meterRaf) window.cancelAnimationFrame(meterRaf);
    updateMetersLoop();
    updateHeroStatusUi();
  }

  async function releaseAudioEngine() {
    if (meterRaf) {
      window.cancelAnimationFrame(meterRaf);
      meterRaf = null;
    }
    if (monitorAudioEl) {
      try {
        monitorAudioEl.pause();
        monitorAudioEl.srcObject = null;
      } catch (_) {}
    }
    if (workletNode) {
      try {
        workletNode.port.onmessage = null;
        workletNode.disconnect();
      } catch (_) {}
      workletNode = null;
    }
    if (audioCtx) {
      try {
        await audioCtx.close();
      } catch (_) {}
      audioCtx = null;
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
    }
    if (testFileAudioEl) {
      try {
        testFileAudioEl.pause();
        testFileAudioEl.src = "";
      } catch (_) {}
      testFileAudioEl = null;
    }
    if ($("lsTestFilePauseBtn")) {
      $("lsTestFilePauseBtn").style.display = "none";
      $("lsTestFilePauseBtn").textContent = "Pause File";
    }
    nodes = null;
    updateHeroStatusUi();
  }

  function startEncoderWorker(sampleRate, kbps) {
    if (encoderWorker) {
      try {
        encoderWorker.terminate();
      } catch (_) {}
    }
    encoderWorker = new Worker("/js/live-stream-encoder-worker.js?v=1.0");
    encoderWorker.onmessage = function (ev) {
      const msg = ev.data;
      if (!msg) return;
      if (msg.type === "chunk" && msg.buffer) {
        const u8 = new Uint8Array(msg.buffer);
        if ($("lsBackupRecordCheck") && $("lsBackupRecordCheck").checked) {
          recordedChunks.push(u8);
        }
        if (ws && ws.readyState === WebSocket.OPEN && isLive) {
          ws.send(msg.buffer);
          bytesSentTotal += u8.byteLength;
        }
      }
    };
    encoderWorker.postMessage({ type: "init", channels: 2, sampleRate, kbps });
  }

  function openIngestSocket(token) {
    if (!token || !isLive) return;
    if (ws) {
      try {
        ws.close();
      } catch (_) {}
    }
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/ws/live-stream/ingest?token=${encodeURIComponent(token)}`;
    ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";

    ws.onopen = function () {
      showStudioMessage("Connected to broadcast relay — streaming live audio!", false);
      updateHeroStatusUi();
    };

    ws.onmessage = function (ev) {
      try {
        const msg = JSON.parse(ev.data);
        if (msg && msg.type === "pong" && typeof msg.listeners === "number") {
          const el = $("lsListenerCount");
          if (el) el.textContent = String(msg.listeners);
        }
      } catch (_) {}
    };

    ws.onclose = function () {
      if (isLive && !intentionalStop && ingestToken) {
        showStudioMessage("Connection interrupted — reconnecting automatically...", true);
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          if (isLive && !intentionalStop) openIngestSocket(ingestToken);
        }, 1500);
      }
    };
  }

  function updateHeroStatusUi() {
    const orb = $("lsStatusOrb");
    const statusText = $("lsStatusText");
    const goLiveBtn = $("lsGoLiveBtn");
    const stopBtn = $("lsStopBtn");
    const bitrateSel = $("lsBitrateSelect");
    const soundcheckBtn = $("lsSoundcheckBtn");

    if (orb) {
      orb.classList.toggle("is-live", isLive);
      orb.classList.toggle("is-soundcheck", !isLive && Boolean(audioCtx));
    }
    if (statusText) {
      if (isLive) {
        statusText.textContent = "ON AIR · Streaming Live";
      } else if (audioCtx) {
        statusText.textContent = "Soundcheck Active (Offline)";
      } else {
        statusText.textContent = "Offline — Ready to Connect Interface";
      }
    }
    if (goLiveBtn) goLiveBtn.disabled = isLive;
    if (stopBtn) stopBtn.disabled = !isLive;
    if (bitrateSel) bitrateSel.disabled = isLive;
    if (soundcheckBtn) {
      soundcheckBtn.textContent = audioCtx ? "Restart / Switch Input" : "Start Audio Soundcheck";
    }
  }

  function formatElapsed(ms) {
    const sec = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const mm = String(m).padStart(2, "0");
    const ss = String(s).padStart(2, "0");
    return h > 0 ? `${String(h).padStart(2, "0")}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  function startTelemetryLoop() {
    clearInterval(statsTimer);
    statsTimer = setInterval(() => {
      if (isLive && liveStartedMs) {
        const el = $("lsElapsedTime");
        if (el) el.textContent = formatElapsed(Date.now() - liveStartedMs);
        const mb = (bytesSentTotal / (1024 * 1024)).toFixed(2);
        const sentEl = $("lsBytesSent");
        if (sentEl) sentEl.textContent = `${mb} MB sent`;
      }
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: "ping" }));
        } catch (_) {}
      }
    }, 1000);
  }

  async function goLive() {
    try {
      showStudioMessage("Initializing 320 kbps audio capture & broadcast...", false);
      intentionalStop = false;
      recordedChunks = [];
      if (backupDownloadUrl) {
        URL.revokeObjectURL(backupDownloadUrl);
        backupDownloadUrl = null;
      }
      const backupBox = $("lsBackupBox");
      if (backupBox) backupBox.style.display = "none";

      await initAudioEngine();

      const kbps = Number($("lsBitrateSelect")?.value || 320);
      const title = ($("lsStreamTitle")?.value || "Live Bhajan Session").trim();
      const accessMode = $("lsAccessModeSelect")?.value || "public";
      const sessionDate = $("lsSessionDateInput")?.value || "";
      const notifyDevotees = Boolean($("lsNotifyDevoteesCheck")?.checked);

      const res = await fetch("/api/admin/live-stream/start", {
        method: "POST",
        credentials: "same-origin",
        headers: apiHeaders(),
        body: JSON.stringify({
          title,
          session_date: sessionDate,
          bitrate_kbps: kbps,
          access_mode: accessMode,
          notify_devotees: notifyDevotees
        })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to start broadcast");
      }

      ingestToken = data.ingestToken;
      isLive = true;
      liveStartedMs = Date.now();
      bytesSentTotal = 0;

      startEncoderWorker(audioCtx.sampleRate || 48000, kbps);
      openIngestSocket(ingestToken);
      startTelemetryLoop();
      updateHeroStatusUi();
    } catch (err) {
      isLive = false;
      updateHeroStatusUi();
      showStudioMessage("Go Live failed: " + err.message, true);
    }
  }

  async function stopBroadcast() {
    intentionalStop = true;
    clearTimeout(reconnectTimer);
    clearInterval(statsTimer);
    isLive = false;

    if (encoderWorker) {
      encoderWorker.postMessage({ type: "flush" });
    }

    setTimeout(async () => {
      if (ws) {
        try {
          ws.close(1000, "Admin ended stream");
        } catch (_) {}
        ws = null;
      }
      if (encoderWorker) {
        try {
          encoderWorker.terminate();
        } catch (_) {}
        encoderWorker = null;
      }
      ingestToken = null;

      try {
        await fetch("/api/admin/live-stream/stop", {
          method: "POST",
          credentials: "same-origin",
          headers: apiHeaders(),
          body: JSON.stringify({})
        });
      } catch (_) {}

      if (recordedChunks.length > 0) {
        const blob = new Blob(recordedChunks, { type: "audio/mpeg" });
        backupDownloadUrl = URL.createObjectURL(blob);
        const dl = $("lsBackupDownloadLink");
        const box = $("lsBackupBox");
        const sizeEl = $("lsBackupSizeText");
        if (dl) {
          dl.href = backupDownloadUrl;
          dl.download = `bhajan-live-${new Date().toISOString().slice(0, 10)}.mp3`;
        }
        if (sizeEl) {
          sizeEl.textContent = `${(blob.size / (1024 * 1024)).toFixed(2)} MB MP3 ready`;
        }
        if (box) box.style.display = "flex";
      }

      updateHeroStatusUi();
      showStudioMessage("Live broadcast ended cleanly.", false);
    }, 180);
  }

  function renderBhajanPickerList(activeSubmissionId) {
    const listEl = $("lsBhajanPickerList");
    if (!listEl) return;
    listEl.innerHTML = "";
    if (!bhajansList || bhajansList.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ls-hero-sub";
      empty.textContent = "No scheduled bhajans found for this session date.";
      listEl.appendChild(empty);
      return;
    }

    bhajansList.forEach((b, idx) => {
      const row = document.createElement("div");
      const active = activeSubmissionId && Number(activeSubmissionId) === Number(b.id);
      row.className = "ls-bhajan-item" + (active ? " is-now-singing" : "");

      const meta = document.createElement("div");
      meta.className = "ls-bhajan-meta";

      const titleEl = document.createElement("div");
      titleEl.className = "ls-bhajan-title";
      titleEl.textContent = `${idx + 1}. ${b.title}`;

      const singerEl = document.createElement("div");
      singerEl.className = "ls-bhajan-singer";
      singerEl.textContent = [b.singer_name, b.deity, b.scale].filter(Boolean).join(" · ");

      meta.appendChild(titleEl);
      meta.appendChild(singerEl);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ls-btn" + (active ? " ls-btn-go-live" : "");
      btn.textContent = active ? "Singing Now" : "Set Live";
      btn.onclick = () => setNowSingingItem(b);

      row.appendChild(meta);
      row.appendChild(btn);
      listEl.appendChild(row);
    });
  }

  async function setNowSingingItem(bhajan) {
    if (!isLive) {
      showStudioMessage("Start Go Live first before updating Now Singing.", true);
      return;
    }
    try {
      const payload = bhajan
        ? {
            submission_id: bhajan.id,
            title: bhajan.title,
            singer_name: bhajan.singer_name,
            master_id: bhajan.master_id
          }
        : { clear: true };

      const res = await fetch("/api/admin/live-stream/now-singing", {
        method: "POST",
        credentials: "same-origin",
        headers: apiHeaders(),
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to update Now Singing");

      renderBhajanPickerList(data.nowSinging ? data.nowSinging.submissionId : null);
      const curLabel = $("lsNowSingingCurrent");
      if (curLabel) {
        curLabel.textContent = data.nowSinging
          ? `${data.nowSinging.title} — ${data.nowSinging.singerName || ""}`
          : "None selected";
      }
    } catch (err) {
      showStudioMessage(err.message, true);
    }
  }

  function wireStudioEvents() {
    renderPresetOptions(presets[0] ? presets[0].id : null);
    syncUiFromConfig();
    renderBhajanPickerList(streamState.nowSinging ? streamState.nowSinging.submissionId : null);
    updateHeroStatusUi();
    refreshAudioDevices(false);

    if (navigator.mediaDevices && typeof navigator.mediaDevices.addEventListener === "function") {
      navigator.mediaDevices.addEventListener("devicechange", () => refreshAudioDevices(false));
    }

    if ($("lsRefreshDevicesBtn")) {
      $("lsRefreshDevicesBtn").onclick = () => refreshAudioDevices(true);
    }
    if ($("lsSoundcheckBtn")) {
      $("lsSoundcheckBtn").onclick = async () => {
        try {
          activeSourceMode = "device";
          await releaseAudioEngine();
          await initAudioEngine("device");
          showStudioMessage("Audio interface connected for soundcheck!", false);
        } catch (err) {
          showStudioMessage("Audio input error: " + err.message, true);
        }
      };
    }

    if ($("lsTestFileInput")) {
      $("lsTestFileInput").onchange = function () {
        const file = this.files && this.files[0] ? this.files[0] : null;
        if (testFileUrl) {
          URL.revokeObjectURL(testFileUrl);
          testFileUrl = null;
        }
        testFileObj = file;
        if (file) {
          testFileUrl = URL.createObjectURL(file);
          if ($("lsUseTestFileBtn")) $("lsUseTestFileBtn").disabled = false;
          if ($("lsTestFileStatus")) {
            $("lsTestFileStatus").textContent = `Loaded: ${file.name} (${(file.size / (1024 * 1024)).toFixed(2)} MB)`;
          }
        } else {
          if ($("lsUseTestFileBtn")) $("lsUseTestFileBtn").disabled = true;
          if ($("lsTestFileStatus")) $("lsTestFileStatus").textContent = "No test file selected";
        }
      };
    }

    if ($("lsUseTestFileBtn")) {
      $("lsUseTestFileBtn").onclick = async () => {
        try {
          activeSourceMode = "file";
          await releaseAudioEngine();
          await initAudioEngine("file");
          if (!monitorEnabled) {
            monitorEnabled = true;
            if ($("lsMonitorToggleBtn")) {
              $("lsMonitorToggleBtn").classList.add("is-toggled");
              $("lsMonitorToggleBtn").textContent = "Earphone Monitor: ON";
            }
            applyConfigToGraph();
          }
          if (monitorAudioEl) {
            await monitorAudioEl.play().catch(() => {});
          }
          if ($("lsTestFilePauseBtn")) {
            $("lsTestFilePauseBtn").style.display = "inline-flex";
            $("lsTestFilePauseBtn").textContent = "Pause File";
          }
          showStudioMessage(
            "Streaming test audio file into Studio EQ & Earphone Monitor. Click Go Live Now to broadcast!",
            false
          );
        } catch (err) {
          showStudioMessage("Test file error: " + err.message, true);
        }
      };
    }

    if ($("lsTestFilePauseBtn")) {
      $("lsTestFilePauseBtn").onclick = async function () {
        if (!testFileAudioEl) return;
        if (testFileAudioEl.paused) {
          await testFileAudioEl.play().catch(() => {});
          this.textContent = "Pause File";
        } else {
          testFileAudioEl.pause();
          this.textContent = "Resume File";
        }
      };
    }

    if ($("lsTestFileLoopCheck")) {
      $("lsTestFileLoopCheck").onchange = function () {
        if (testFileAudioEl) testFileAudioEl.loop = Boolean(this.checked);
      };
    }

    if ($("lsInputMode")) {
      $("lsInputMode").onchange = function () {
        activeConfig.mode = this.value === "stereo" ? "stereo" : "split";
        syncUiFromConfig();
      };
    }

    if ($("lsSwapBtn")) {
      $("lsSwapBtn").onclick = function () {
        activeConfig.swapChannels = !activeConfig.swapChannels;
        syncUiFromConfig();
      };
    }

    if ($("lsInstMuteBtn")) {
      $("lsInstMuteBtn").onclick = function () {
        activeConfig.inst.mute = !activeConfig.inst.mute;
        syncUiFromConfig();
      };
    }
    if ($("lsVocalMuteBtn")) {
      $("lsVocalMuteBtn").onclick = function () {
        activeConfig.vocal.mute = !activeConfig.vocal.mute;
        syncUiFromConfig();
      };
    }

    if ($("lsInstSoloBtn")) {
      $("lsInstSoloBtn").onclick = function () {
        soloChannel = soloChannel === "inst" ? null : "inst";
        if (soloChannel && !monitorEnabled) {
          monitorEnabled = true;
          if ($("lsMonitorToggleBtn")) {
            $("lsMonitorToggleBtn").classList.add("is-toggled");
            $("lsMonitorToggleBtn").textContent = "Earphone Monitor: ON";
          }
        }
        $("lsInstSoloBtn").classList.toggle("is-solo-active", soloChannel === "inst");
        if ($("lsVocalSoloBtn")) $("lsVocalSoloBtn").classList.remove("is-solo-active");
        applyConfigToGraph();
      };
    }

    if ($("lsVocalSoloBtn")) {
      $("lsVocalSoloBtn").onclick = function () {
        soloChannel = soloChannel === "vocal" ? null : "vocal";
        if (soloChannel && !monitorEnabled) {
          monitorEnabled = true;
          if ($("lsMonitorToggleBtn")) {
            $("lsMonitorToggleBtn").classList.add("is-toggled");
            $("lsMonitorToggleBtn").textContent = "Earphone Monitor: ON";
          }
        }
        $("lsVocalSoloBtn").classList.toggle("is-solo-active", soloChannel === "vocal");
        if ($("lsInstSoloBtn")) $("lsInstSoloBtn").classList.remove("is-solo-active");
        applyConfigToGraph();
      };
    }

    if ($("lsVocalCompBtn")) {
      $("lsVocalCompBtn").onclick = function () {
        activeConfig.vocal.comp = !activeConfig.vocal.comp;
        syncUiFromConfig();
      };
    }

    if ($("lsMasterBypassBtn")) {
      $("lsMasterBypassBtn").onclick = function () {
        activeConfig.master.bypass = !activeConfig.master.bypass;
        syncUiFromConfig();
      };
    }

    if ($("lsLimiterBtn")) {
      $("lsLimiterBtn").onclick = function () {
        activeConfig.master.limiter = activeConfig.master.limiter === false;
        syncUiFromConfig();
      };
    }

    if ($("lsBroadcastMuteBtn")) {
      $("lsBroadcastMuteBtn").onclick = function () {
        broadcastMuted = !broadcastMuted;
        this.classList.toggle("is-muted-active", broadcastMuted);
        this.textContent = broadcastMuted ? "Broadcast Muted (On-Air Silence)" : "Mute Broadcast";
        applyConfigToGraph();
      };
    }

    if ($("lsMonitorToggleBtn")) {
      $("lsMonitorToggleBtn").onclick = async function () {
        try {
          if (!audioCtx) await initAudioEngine();
          monitorEnabled = !monitorEnabled;
          this.classList.toggle("is-toggled", monitorEnabled);
          this.textContent = monitorEnabled ? "Earphone Monitor: ON" : "Earphone Monitor: OFF";
          applyConfigToGraph();
          if (monitorEnabled && monitorAudioEl) {
            await monitorAudioEl.play().catch(() => {});
          }
        } catch (err) {
          showStudioMessage("Could not start earphone monitor: " + err.message, true);
        }
      };
    }

    if ($("lsMonitorVol")) {
      $("lsMonitorVol").oninput = function () {
        monitorVolume = Number(this.value) / 100;
        if ($("lsMonitorVolVal")) $("lsMonitorVolVal").textContent = `${this.value}%`;
        applyConfigToGraph();
      };
    }

    if ($("lsMonitorOutputSelect")) {
      $("lsMonitorOutputSelect").onchange = async function () {
        if (monitorAudioEl && typeof monitorAudioEl.setSinkId === "function") {
          try {
            await monitorAudioEl.setSinkId(this.value || "");
          } catch (err) {
            showStudioMessage("Could not switch monitor output: " + err.message, true);
          }
        }
      };
    }

    if ($("lsPresetSelect")) {
      $("lsPresetSelect").onchange = function () {
        const chosen = presets.find((p) => p.id === this.value);
        if (chosen && chosen.config) {
          activeConfig = JSON.parse(JSON.stringify(chosen.config));
          syncUiFromConfig();
          if (nodes && audioCtx && nodes.convolver) {
            nodes.convolver.buffer = buildImpulseResponse(audioCtx, activeConfig.reverb.decay || 1.4);
          }
          if ($("lsDeletePresetBtn")) {
            $("lsDeletePresetBtn").disabled = chosen.isBuiltIn;
          }
        }
      };
    }

    if ($("lsSavePresetBtn")) {
      $("lsSavePresetBtn").onclick = async function () {
        const name = window.prompt("Enter a name for this EQ & Effects preset:", "Mandir Custom Mix");
        if (!name || !name.trim()) return;
        try {
          const res = await fetch("/api/admin/live-stream/presets", {
            method: "POST",
            credentials: "same-origin",
            headers: apiHeaders(),
            body: JSON.stringify({ name: name.trim(), config: activeConfig })
          });
          const data = await res.json();
          if (!res.ok || !data.success) throw new Error(data.error || "Save failed");

          presets = presets.filter((p) => p.id !== data.preset.id && p.name !== data.preset.name);
          presets.push(data.preset);
          renderPresetOptions(data.preset.id);
          showStudioMessage(`Preset "${data.preset.name}" saved to database.`, false);
        } catch (err) {
          showStudioMessage(err.message, true);
        }
      };
    }

    if ($("lsDeletePresetBtn")) {
      $("lsDeletePresetBtn").onclick = async function () {
        const selId = $("lsPresetSelect") ? $("lsPresetSelect").value : "";
        const chosen = presets.find((p) => p.id === selId);
        if (!chosen || chosen.isBuiltIn || !chosen.dbId) return;
        if (!window.confirm(`Delete custom preset "${chosen.name}"?`)) return;
        try {
          const res = await fetch(`/api/admin/live-stream/presets/${chosen.dbId}`, {
            method: "DELETE",
            credentials: "same-origin",
            headers: apiHeaders()
          });
          if (!res.ok) throw new Error("Failed to delete preset");
          presets = presets.filter((p) => p.id !== chosen.id);
          renderPresetOptions(presets[0] ? presets[0].id : null);
          showStudioMessage(`Deleted preset "${chosen.name}".`, false);
        } catch (err) {
          showStudioMessage(err.message, true);
        }
      };
    }

    if ($("lsGoLiveBtn")) $("lsGoLiveBtn").onclick = goLive;
    if ($("lsStopBtn")) $("lsStopBtn").onclick = stopBroadcast;
    if ($("lsClearNowSingingBtn")) $("lsClearNowSingingBtn").onclick = () => setNowSingingItem(null);

    if ($("lsLoadDateBhajansBtn")) {
      $("lsLoadDateBhajansBtn").onclick = async () => {
        const d = $("lsSessionDateInput")?.value || "";
        const res = await fetch(`/api/admin/live-stream/bhajans?date=${encodeURIComponent(d)}`, {
          credentials: "same-origin"
        });
        const data = await res.json();
        if (res.ok && data.success) {
          bhajansList = data.bhajans || [];
          renderBhajanPickerList(streamState.nowSinging ? streamState.nowSinging.submissionId : null);
        }
      };
    }

    // Subscribe to server SSE so listener count stays live even before WS ping
    if (typeof EventSource === "function") {
      eventSource = new EventSource("/api/live-stream/events");
      eventSource.addEventListener("status", (ev) => {
        try {
          const data = JSON.parse(ev.data);
          streamState = data;
          const cnt = $("lsListenerCount");
          if (cnt) cnt.textContent = String(data.listenerCount || 0);
        } catch (_) {}
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wireStudioEvents);
  } else {
    wireStudioEvents();
  }
})(window, document);
