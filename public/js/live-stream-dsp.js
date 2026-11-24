/**
 * Unified Web Audio DSP, Per-Track Modular FX Rack & Offline Mastering Engine
 * UMD module: works in browser (window.LiveStreamDsp) and Node.js tests.
 * Zero external dependencies.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.LiveStreamDsp = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DEFAULT_FREQ_POINTS = [
    20, 32, 50, 80, 125, 200, 250, 350, 500, 750,
    1000, 1500, 2200, 3500, 5000, 7500, 10000, 14000, 18000
  ];

  const FX_CATALOG = {
    eq: {
      type: "eq",
      name: "5-Band Parametric EQ",
      shortName: "EQ-5",
      defaultParams: { b80: 0, b250: 0, b1k: 0, b3k5: 0, b10k: 0 },
      presets: {
        flat: { label: "Flat", params: { b80: 0, b250: 0, b1k: 0, b3k5: 0, b10k: 0 } },
        vocal_clarity: { label: "Vocal Clarity", params: { b80: -2, b250: -3, b1k: 0.5, b3k5: 3.5, b10k: 2.5 } },
        warm_harmonium: { label: "Warm Harmonium", params: { b80: 2.5, b250: -1.5, b1k: 1, b3k5: 0.5, b10k: -1.5 } },
        crisp_tabla: { label: "Tabla Punch", params: { b80: 3.5, b250: -2.5, b1k: 0, b3k5: 2.5, b10k: 3 } },
        de_mud: { label: "De-Mud / Clean", params: { b80: -1, b250: -4.5, b1k: 0, b3k5: 1.5, b10k: 1 } }
      },
      controls: [
        { key: "b80", label: "Low Shelf (80 Hz)", min: -12, max: 12, step: 0.5, unit: " dB" },
        { key: "b250", label: "Mud Cut (250 Hz)", min: -12, max: 12, step: 0.5, unit: " dB" },
        { key: "b1k", label: "Body (1 kHz)", min: -12, max: 12, step: 0.5, unit: " dB" },
        { key: "b3k5", label: "Presence (3.5 kHz)", min: -12, max: 12, step: 0.5, unit: " dB" },
        { key: "b10k", label: "Air / Brilliance (10k)", min: -12, max: 12, step: 0.5, unit: " dB" }
      ]
    },
    filter: {
      type: "filter",
      name: "HPF / LPF Filter",
      shortName: "Filter",
      defaultParams: { hpfHz: 80, lpfHz: 18000, q: 0.7 },
      controls: [
        { key: "hpfHz", label: "Low Cut (HPF)", min: 20, max: 400, step: 5, unit: " Hz" },
        { key: "lpfHz", label: "High Cut (LPF)", min: 2000, max: 20000, step: 250, unit: " Hz" },
        { key: "q", label: "Slope Q", min: 0.5, max: 4, step: 0.1, unit: " Q" }
      ]
    },
    compressor: {
      type: "compressor",
      name: "Dynamics Compressor",
      shortName: "Comp",
      defaultParams: { threshold: -18, ratio: 3.5, knee: 10, attackMs: 8, releaseMs: 180, makeupDb: 0 },
      controls: [
        { key: "threshold", label: "Threshold", min: -40, max: 0, step: 1, unit: " dB" },
        { key: "ratio", label: "Ratio", min: 1, max: 16, step: 0.5, unit: ":1" },
        { key: "knee", label: "Soft Knee", min: 0, max: 30, step: 1, unit: " dB" },
        { key: "attackMs", label: "Attack", min: 1, max: 100, step: 1, unit: " ms" },
        { key: "releaseMs", label: "Release", min: 40, max: 600, step: 10, unit: " ms" },
        { key: "makeupDb", label: "Makeup Gain", min: -6, max: 12, step: 0.5, unit: " dB" }
      ]
    },
    deesser: {
      type: "deesser",
      name: "Vocal De-Esser",
      shortName: "De-Ess",
      defaultParams: { freqHz: 6500, cutDb: 3, q: 3.2 },
      controls: [
        { key: "freqHz", label: "Center Freq", min: 4000, max: 10000, step: 100, unit: " Hz" },
        { key: "cutDb", label: "Reduction", min: 0, max: 12, step: 0.5, unit: " dB" },
        { key: "q", label: "Bandwidth Q", min: 1, max: 6, step: 0.2, unit: " Q" }
      ]
    },
    reverb: {
      type: "reverb",
      name: "Mandir Hall Reverb",
      shortName: "Reverb",
      defaultParams: { wet: 18, decay: 1.5, toneHz: 8500 },
      controls: [
        { key: "wet", label: "Wet Mix", min: 0, max: 60, step: 1, unit: "%" },
        { key: "decay", label: "Decay Time", min: 0.4, max: 3.5, step: 0.1, unit: " s" },
        { key: "toneHz", label: "HF Damping", min: 2000, max: 16000, step: 250, unit: " Hz" }
      ]
    },
    delay: {
      type: "delay",
      name: "Stereo Echo / Delay",
      shortName: "Delay",
      defaultParams: { timeMs: 260, feedback: 25, wet: 15, toneHz: 4500 },
      controls: [
        { key: "timeMs", label: "Delay Time", min: 40, max: 800, step: 10, unit: " ms" },
        { key: "feedback", label: "Feedback", min: 0, max: 70, step: 2, unit: "%" },
        { key: "wet", label: "Echo Mix", min: 0, max: 60, step: 1, unit: "%" },
        { key: "toneHz", label: "Warmth Tone", min: 1000, max: 12000, step: 250, unit: " Hz" }
      ]
    },
    saturation: {
      type: "saturation",
      name: "Analog Tape / Tube Warmth",
      shortName: "Warmth",
      defaultParams: { drive: 25, mix: 40, outputDb: 0 },
      controls: [
        { key: "drive", label: "Tape Drive", min: 0, max: 100, step: 2, unit: "%" },
        { key: "mix", label: "Blend Mix", min: 0, max: 100, step: 5, unit: "%" },
        { key: "outputDb", label: "Output Trim", min: -12, max: 6, step: 0.5, unit: " dB" }
      ]
    },
    limiter: {
      type: "limiter",
      name: "Brickwall Limiter",
      shortName: "Limit",
      defaultParams: { ceilingDb: -1.5, releaseMs: 80 },
      controls: [
        { key: "ceilingDb", label: "Ceiling", min: -6, max: 0, step: 0.1, unit: " dB" },
        { key: "releaseMs", label: "Release", min: 20, max: 250, step: 5, unit: " ms" }
      ]
    }
  };

  let fxIdSeq = 1;

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function dbToGain(db) {
    return Math.pow(10, db / 20);
  }

  function gainToDb(gain) {
    if (!(gain > 0)) return -Infinity;
    return 20 * Math.log10(gain);
  }

  function createDefaultFxSlot(type, overrides) {
    const def = FX_CATALOG[type];
    if (!def) {
      throw new Error(`Unknown FX type: ${type}`);
    }
    const ov = overrides || {};
    const paramOverrides = ov.params && typeof ov.params === "object" ? ov.params : ov;
    const params = {};
    Object.keys(def.defaultParams).forEach((k) => {
      params[k] = paramOverrides[k] !== undefined ? Number(paramOverrides[k]) : def.defaultParams[k];
    });
    return {
      id: ov.id || `fx-${Date.now().toString(36)}-${fxIdSeq++}`,
      type: def.type,
      name: def.name,
      enabled: ov.enabled !== false,
      params
    };
  }

  /**
   * Generate a synthetic devotional hall impulse response stereo AudioBuffer.
   */
  function buildHallImpulseResponse(ctx, decaySeconds) {
    const sampleRate = ctx.sampleRate || 48000;
    const clampedDecay = clamp(Number(decaySeconds) || 1.4, 0.4, 3.5);
    const length = Math.max(1, Math.floor(sampleRate * clampedDecay));
    const buffer = ctx.createBuffer(2, length, sampleRate);
    const fadeInSamples = Math.min(length, Math.floor(sampleRate * 0.015));

    for (let ch = 0; ch < 2; ch += 1) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < length; i += 1) {
        const progress = i / length;
        const decayEnv = Math.pow(1 - progress, 2.2);
        const onset = fadeInSamples > 0 && i < fadeInSamples ? i / fadeInSamples : 1;
        data[i] = (Math.random() * 2 - 1) * decayEnv * onset * 0.6;
      }
    }
    return buffer;
  }

  function buildSaturationCurve(drivePct) {
    const samples = 1024;
    const curve = new Float32Array(samples);
    const k = clamp(Number(drivePct) || 0, 0, 100) / 100 * 6 + 0.01;
    const denom = Math.tanh(k);
    for (let i = 0; i < samples; i += 1) {
      const x = (i * 2) / (samples - 1) - 1;
      curve[i] = Math.tanh(k * x) / denom;
    }
    return curve;
  }

  function setParam(param, value, ctx, instant) {
    if (!param) return;
    if (instant || !ctx || typeof param.setTargetAtTime !== "function") {
      param.value = value;
      return;
    }
    param.setTargetAtTime(value, ctx.currentTime, 0.02);
  }

  function createSingleFxSlotNodes(ctx, slot, isOffline) {
    const slotIn = ctx.createGain();
    const slotOut = ctx.createGain();
    const dryBypass = ctx.createGain();
    const wetActive = ctx.createGain();
    slotIn.connect(dryBypass).connect(slotOut);
    wetActive.connect(slotOut);

    let enabled = slot.enabled !== false;
    let params = Object.assign({}, (FX_CATALOG[slot.type] && FX_CATALOG[slot.type].defaultParams) || {}, slot.params || {});

    function syncBypass(instant) {
      setParam(dryBypass.gain, enabled ? 0 : 1, ctx, instant);
      setParam(wetActive.gain, enabled ? 1 : 0, ctx, instant);
    }

    let updateImpl = function () {};

    if (slot.type === "eq") {
      const b80 = ctx.createBiquadFilter(); b80.type = "lowshelf"; b80.frequency.value = 80;
      const b250 = ctx.createBiquadFilter(); b250.type = "peaking"; b250.frequency.value = 250; b250.Q.value = 1.2;
      const b1k = ctx.createBiquadFilter(); b1k.type = "peaking"; b1k.frequency.value = 1000; b1k.Q.value = 1.0;
      const b3k5 = ctx.createBiquadFilter(); b3k5.type = "peaking"; b3k5.frequency.value = 3500; b3k5.Q.value = 1.2;
      const b10k = ctx.createBiquadFilter(); b10k.type = "highshelf"; b10k.frequency.value = 10000;
      slotIn.connect(b80).connect(b250).connect(b1k).connect(b3k5).connect(b10k).connect(wetActive);
      updateImpl = function (p, instant) {
        setParam(b80.gain, clamp(Number(p.b80) || 0, -18, 18), ctx, instant);
        setParam(b250.gain, clamp(Number(p.b250) || 0, -18, 18), ctx, instant);
        setParam(b1k.gain, clamp(Number(p.b1k) || 0, -18, 18), ctx, instant);
        setParam(b3k5.gain, clamp(Number(p.b3k5) || 0, -18, 18), ctx, instant);
        setParam(b10k.gain, clamp(Number(p.b10k) || 0, -18, 18), ctx, instant);
      };
    } else if (slot.type === "filter") {
      const hpf = ctx.createBiquadFilter(); hpf.type = "highpass";
      const lpf = ctx.createBiquadFilter(); lpf.type = "lowpass";
      slotIn.connect(hpf).connect(lpf).connect(wetActive);
      updateImpl = function (p, instant) {
        const qVal = clamp(Number(p.q) || 0.7, 0.3, 8);
        setParam(hpf.frequency, clamp(Number(p.hpfHz) || 80, 20, 2000), ctx, instant);
        setParam(hpf.Q, qVal, ctx, instant);
        setParam(lpf.frequency, clamp(Number(p.lpfHz) || 18000, 500, 22000), ctx, instant);
        setParam(lpf.Q, qVal, ctx, instant);
      };
    } else if (slot.type === "compressor") {
      const comp = ctx.createDynamicsCompressor();
      const makeup = ctx.createGain();
      slotIn.connect(comp).connect(makeup).connect(wetActive);
      updateImpl = function (p, instant) {
        setParam(comp.threshold, clamp(Number(p.threshold ?? -18), -60, 0), ctx, instant);
        setParam(comp.ratio, clamp(Number(p.ratio) || 3.5, 1, 20), ctx, instant);
        setParam(comp.knee, clamp(Number(p.knee ?? 10), 0, 40), ctx, instant);
        setParam(comp.attack, clamp((Number(p.attackMs) || 8) / 1000, 0.001, 0.5), ctx, instant);
        setParam(comp.release, clamp((Number(p.releaseMs) || 180) / 1000, 0.01, 1.0), ctx, instant);
        setParam(makeup.gain, dbToGain(clamp(Number(p.makeupDb) || 0, -18, 18)), ctx, instant);
      };
    } else if (slot.type === "deesser") {
      const ds = ctx.createBiquadFilter(); ds.type = "peaking";
      slotIn.connect(ds).connect(wetActive);
      updateImpl = function (p, instant) {
        setParam(ds.frequency, clamp(Number(p.freqHz) || 6500, 2500, 12000), ctx, instant);
        setParam(ds.Q, clamp(Number(p.q) || 3.2, 0.8, 8), ctx, instant);
        setParam(ds.gain, -clamp(Number(p.cutDb) || 0, 0, 15), ctx, instant);
      };
    } else if (slot.type === "reverb") {
      const dry = ctx.createGain();
      const send = ctx.createGain();
      const conv = ctx.createConvolver();
      const tone = ctx.createBiquadFilter(); tone.type = "lowpass";
      const ret = ctx.createGain();
      slotIn.connect(dry).connect(wetActive);
      slotIn.connect(send).connect(conv).connect(tone).connect(ret).connect(wetActive);
      let lastDecay = null;
      updateImpl = function (p, instant) {
        const wetPct = clamp(Number(p.wet) || 0, 0, 100);
        const decay = clamp(Number(p.decay) || 1.5, 0.4, 3.5);
        if (lastDecay === null || Math.abs(lastDecay - decay) > 0.05) {
          conv.buffer = buildHallImpulseResponse(ctx, decay);
          lastDecay = decay;
        }
        setParam(tone.frequency, clamp(Number(p.toneHz) || 8500, 1200, 20000), ctx, instant);
        setParam(dry.gain, 1 - (wetPct / 100) * 0.25, ctx, instant);
        setParam(ret.gain, (wetPct / 100) * 0.75, ctx, instant);
      };
    } else if (slot.type === "delay") {
      const dry = ctx.createGain();
      const del = ctx.createDelay(1.0);
      const fb = ctx.createGain();
      const tone = ctx.createBiquadFilter(); tone.type = "lowpass";
      const wetG = ctx.createGain();
      slotIn.connect(dry).connect(wetActive);
      slotIn.connect(del).connect(tone).connect(wetG).connect(wetActive);
      tone.connect(fb).connect(del);
      updateImpl = function (p, instant) {
        setParam(del.delayTime, clamp((Number(p.timeMs) || 260) / 1000, 0.01, 0.95), ctx, instant);
        setParam(fb.gain, clamp((Number(p.feedback) || 0) / 100, 0, 0.72), ctx, instant);
        setParam(tone.frequency, clamp(Number(p.toneHz) || 4500, 500, 18000), ctx, instant);
        setParam(wetG.gain, clamp((Number(p.wet) || 0) / 100, 0, 0.8), ctx, instant);
      };
    } else if (slot.type === "saturation") {
      const dry = ctx.createGain();
      const shaper = ctx.createWaveShaper();
      shaper.oversample = "2x";
      const wetG = ctx.createGain();
      const trim = ctx.createGain();
      slotIn.connect(dry).connect(trim).connect(wetActive);
      slotIn.connect(shaper).connect(wetG).connect(trim);
      let lastDrive = null;
      updateImpl = function (p, instant) {
        const d = clamp(Number(p.drive) || 0, 0, 100);
        if (lastDrive === null || Math.abs(lastDrive - d) > 0.5) {
          shaper.curve = buildSaturationCurve(d);
          lastDrive = d;
        }
        const m = clamp(Number(p.mix) || 0, 0, 100) / 100;
        setParam(dry.gain, 1 - m, ctx, instant);
        setParam(wetG.gain, m, ctx, instant);
        setParam(trim.gain, dbToGain(clamp(Number(p.outputDb) || 0, -18, 12)), ctx, instant);
      };
    } else if (slot.type === "limiter") {
      const lim = ctx.createDynamicsCompressor();
      lim.knee.value = 0;
      lim.ratio.value = 20;
      lim.attack.value = 0.001;
      slotIn.connect(lim).connect(wetActive);
      updateImpl = function (p, instant) {
        setParam(lim.threshold, clamp(Number(p.ceilingDb ?? -1.5), -12, 0), ctx, instant);
        setParam(lim.release, clamp((Number(p.releaseMs) || 80) / 1000, 0.01, 0.5), ctx, instant);
      };
    } else {
      slotIn.connect(wetActive);
    }

    syncBypass(true);
    updateImpl(params, true);

    return {
      input: slotIn,
      output: slotOut,
      type: slot.type,
      updateParams(nextParams) {
        params = Object.assign({}, params, nextParams || {});
        updateImpl(params, isOffline);
      },
      setEnabled(nextEnabled) {
        enabled = Boolean(nextEnabled);
        syncBypass(isOffline);
      }
    };
  }

  /**
   * Build a sequential per-track or master modular FX chain from an array of FX slots.
   */
  function buildModularFxChain(ctx, fxRack) {
    const isOffline = typeof OfflineAudioContext !== "undefined" && ctx instanceof OfflineAudioContext;
    const input = ctx.createGain();
    const output = ctx.createGain();
    const slotsMap = new Map();
    const list = Array.isArray(fxRack) ? fxRack : [];

    let cursor = input;
    for (let i = 0; i < list.length; i += 1) {
      const slot = list[i];
      if (!slot || !FX_CATALOG[slot.type]) continue;
      if (isOffline && slot.enabled === false) continue;
      const built = createSingleFxSlotNodes(ctx, slot, isOffline);
      cursor.connect(built.input);
      cursor = built.output;
      if (slot.id) {
        slotsMap.set(slot.id, built);
      }
    }
    cursor.connect(output);

    return {
      input,
      output,
      slots: slotsMap
    };
  }

  /**
   * Build the complete 2-channel devotional DSP + Master Bus graph for either
   * real-time AudioContext or OfflineAudioContext.
   */
  function buildChannelAndMasterDsp(ctx, cfg) {
    const config = cfg || {};
    const isOffline = typeof OfflineAudioContext !== "undefined" && ctx instanceof OfflineAudioContext;

    const instIn = ctx.createGain();
    const vocalIn = ctx.createGain();
    const stereoIn = ctx.createGain();

    const instHpf = ctx.createBiquadFilter(); instHpf.type = "highpass"; instHpf.Q.value = 0.707;
    const instEqLow = ctx.createBiquadFilter(); instEqLow.type = "lowshelf"; instEqLow.frequency.value = 120;
    const instEqMid = ctx.createBiquadFilter(); instEqMid.type = "peaking"; instEqMid.frequency.value = 1000; instEqMid.Q.value = 1.0;
    const instEqHigh = ctx.createBiquadFilter(); instEqHigh.type = "highshelf"; instEqHigh.frequency.value = 8000;
    const instGain = ctx.createGain();

    const vocalHpf = ctx.createBiquadFilter(); vocalHpf.type = "highpass"; vocalHpf.Q.value = 0.707;
    const vocalEqLow = ctx.createBiquadFilter(); vocalEqLow.type = "lowshelf"; vocalEqLow.frequency.value = 140;
    const vocalEqMid = ctx.createBiquadFilter(); vocalEqMid.type = "peaking"; vocalEqMid.frequency.value = 2500; vocalEqMid.Q.value = 1.1;
    const vocalDeesser = ctx.createBiquadFilter(); vocalDeesser.type = "peaking"; vocalDeesser.frequency.value = 6500; vocalDeesser.Q.value = 3.2;
    const vocalEqHigh = ctx.createBiquadFilter(); vocalEqHigh.type = "highshelf"; vocalEqHigh.frequency.value = 9000;
    const vocalComp = ctx.createDynamicsCompressor(); vocalComp.knee.value = 10; vocalComp.attack.value = 0.008; vocalComp.release.value = 0.18;
    const vocalGain = ctx.createGain();

    const mixBus = ctx.createGain();
    const reverbSend = ctx.createGain();
    const convolver = ctx.createConvolver();
    const reverbReturn = ctx.createGain();

    const m80 = ctx.createBiquadFilter(); m80.type = "lowshelf"; m80.frequency.value = 80;
    const m250 = ctx.createBiquadFilter(); m250.type = "peaking"; m250.frequency.value = 250; m250.Q.value = 1.2;
    const m1k = ctx.createBiquadFilter(); m1k.type = "peaking"; m1k.frequency.value = 1000; m1k.Q.value = 1.0;
    const m3k5 = ctx.createBiquadFilter(); m3k5.type = "peaking"; m3k5.frequency.value = 3500; m3k5.Q.value = 1.2;
    const m10k = ctx.createBiquadFilter(); m10k.type = "highshelf"; m10k.frequency.value = 10000;

    const glueComp = ctx.createDynamicsCompressor(); glueComp.knee.value = 12; glueComp.attack.value = 0.02; glueComp.release.value = 0.25;
    const limiter = ctx.createDynamicsCompressor(); limiter.knee.value = 0; limiter.attack.value = 0.001; limiter.release.value = 0.08;
    const masterGain = ctx.createGain();

    instIn.connect(instHpf).connect(instEqLow).connect(instEqMid).connect(instEqHigh).connect(instGain).connect(mixBus);
    vocalIn.connect(vocalHpf).connect(vocalEqLow).connect(vocalEqMid).connect(vocalDeesser).connect(vocalEqHigh).connect(vocalComp).connect(vocalGain);
    vocalGain.connect(mixBus);
    vocalGain.connect(reverbSend);
    reverbSend.connect(convolver).connect(reverbReturn).connect(mixBus);
    stereoIn.connect(mixBus);

    mixBus.connect(m80).connect(m250).connect(m1k).connect(m3k5).connect(m10k).connect(glueComp).connect(limiter).connect(masterGain);

    let lastDecay = null;

    function updateConfig(nextCfg, instant) {
      const c = nextCfg || {};
      const inst = c.inst || {};
      const vocal = c.vocal || {};
      const reverb = c.reverb || {};
      const master = c.master || {};
      const useInstant = Boolean(instant || isOffline);

      setParam(instHpf.frequency, Number(inst.hpf) || 45, ctx, useInstant);
      setParam(instEqLow.gain, Number(inst.low) || 0, ctx, useInstant);
      setParam(instEqMid.gain, Number(inst.mid) || 0, ctx, useInstant);
      setParam(instEqHigh.gain, Number(inst.high) || 0, ctx, useInstant);
      setParam(instGain.gain, inst.mute ? 0 : (Number(inst.gain ?? 100) / 100), ctx, useInstant);

      setParam(vocalHpf.frequency, Number(vocal.hpf) || 85, ctx, useInstant);
      setParam(vocalEqLow.gain, Number(vocal.low) || 0, ctx, useInstant);
      setParam(vocalEqMid.gain, Number(vocal.mid) || 0, ctx, useInstant);
      setParam(vocalDeesser.gain, -clamp(Number(vocal.deesser) || 0, 0, 12), ctx, useInstant);
      setParam(vocalEqHigh.gain, Number(vocal.high) || 0, ctx, useInstant);
      setParam(vocalGain.gain, vocal.mute ? 0 : (Number(vocal.gain ?? 112) / 100), ctx, useInstant);

      const vocalCompOn = vocal.comp !== false;
      setParam(vocalComp.threshold, vocalCompOn ? -18 : 0, ctx, useInstant);
      setParam(vocalComp.ratio, vocalCompOn ? 3.5 : 1, ctx, useInstant);

      const wetPct = clamp(Number(reverb.wet) || 0, 0, 100);
      setParam(reverbSend.gain, wetPct > 0 ? 1 : 0, ctx, useInstant);
      setParam(reverbReturn.gain, (wetPct / 100) * 0.65, ctx, useInstant);

      const decay = clamp(Number(reverb.decay) || 1.4, 0.4, 3.5);
      if (lastDecay === null || Math.abs(lastDecay - decay) > 0.05) {
        convolver.buffer = buildHallImpulseResponse(ctx, decay);
        lastDecay = decay;
      }

      const eqBypass = Boolean(master.bypass);
      setParam(m80.gain, eqBypass ? 0 : (Number(master.b80) || 0), ctx, useInstant);
      setParam(m250.gain, eqBypass ? 0 : (Number(master.b250) || 0), ctx, useInstant);
      setParam(m1k.gain, eqBypass ? 0 : (Number(master.b1k) || 0), ctx, useInstant);
      setParam(m3k5.gain, eqBypass ? 0 : (Number(master.b3k5) || 0), ctx, useInstant);
      setParam(m10k.gain, eqBypass ? 0 : (Number(master.b10k) || 0), ctx, useInstant);

      const glueOn = master.glueComp !== false;
      setParam(glueComp.threshold, glueOn ? -14 : 0, ctx, useInstant);
      setParam(glueComp.ratio, glueOn ? 2.2 : 1, ctx, useInstant);

      const limiterOn = master.limiter !== false;
      setParam(limiter.threshold, limiterOn ? -1.5 : 0, ctx, useInstant);
      setParam(limiter.ratio, limiterOn ? 20 : 1, ctx, useInstant);

      setParam(masterGain.gain, clamp(Number(master.gain ?? 100) / 100, 0, 1.5), ctx, useInstant);
    }

    updateConfig(config, true);

    return {
      instIn,
      vocalIn,
      stereoIn,
      output: masterGain,
      nodes: {
        instHpf, instEqLow, instEqMid, instEqHigh, instGain,
        vocalHpf, vocalEqLow, vocalEqMid, vocalDeesser, vocalEqHigh, vocalComp, vocalGain,
        reverbSend, convolver, reverbReturn, mixBus,
        m80, m250, m1k, m3k5, m10k, glueComp, limiter, masterGain
      },
      updateConfig
    };
  }

  /**
   * Apply a smooth offline Noise Gate to a mono Float32Array (modified in-place and returned).
   */
  function applyNoiseGateOffline(samples, sampleRate, thresholdDb, holdMs, releaseMs) {
    if (!samples || !samples.length) return samples;
    const sr = Number(sampleRate) || 48000;
    const threshLin = dbToGain(thresholdDb === undefined ? -48 : Number(thresholdDb));
    const holdSamples = Math.max(1, Math.round((sr * (holdMs === undefined ? 80 : holdMs)) / 1000));
    const releaseSamples = Math.max(1, Math.round((sr * (releaseMs === undefined ? 120 : releaseMs)) / 1000));
    const attackSamples = Math.max(1, Math.round((sr * 8) / 1000));

    const floorGain = 0.005;
    const envCoeff = Math.exp(-1 / Math.max(1, Math.round(sr * 0.008)));
    const attackStep = 1 / attackSamples;
    const releaseStep = (1 - floorGain) / releaseSamples;

    let env = 0;
    let holdCounter = 0;
    let gateGain = floorGain;

    for (let i = 0; i < samples.length; i += 1) {
      const absVal = Math.abs(samples[i]);
      if (absVal > env) {
        env = absVal;
      } else {
        env = env * envCoeff + absVal * (1 - envCoeff);
      }

      if (env >= threshLin) {
        holdCounter = holdSamples;
        gateGain = Math.min(1, gateGain + attackStep);
      } else if (holdCounter > 0) {
        holdCounter -= 1;
        gateGain = Math.min(1, gateGain + attackStep);
      } else {
        gateGain = Math.max(floorGain, gateGain - releaseStep);
      }

      samples[i] *= gateGain;
    }

    return samples;
  }

  function createBiquad(b0, b1, b2, a0, a1, a2) {
    return {
      b0: b0 / a0,
      b1: b1 / a0,
      b2: b2 / a0,
      a1: a1 / a0,
      a2: a2 / a0
    };
  }

  function getKWeightingBiquads(sampleRate) {
    const fs = Number(sampleRate) || 48000;

    if (Math.abs(fs - 48000) < 1) {
      return {
        stage1: {
          b0: 1.53512485958697,
          b1: -2.69169618940638,
          b2: 1.19839281085285,
          a1: -1.69065929318241,
          a2: 0.73248077421585
        },
        stage2: {
          b0: 1.0,
          b1: -2.0,
          b2: 1.0,
          a1: -1.99004745483398,
          a2: 0.99007225036621
        }
      };
    }

    const db = 3.999843853973347;
    const f0 = 1681.974450955533;
    const Q = 0.7071752369554196;
    const K = Math.tan((Math.PI * f0) / fs);
    const Vh = Math.pow(10, db / 20);
    const Vb = Math.pow(Vh, 0.4996667741545416);
    const a0s = 1 + K / Q + K * K;
    const stage1 = createBiquad(
      Vh + (Vb * K) / Q + K * K,
      2 * (K * K - Vh),
      Vh - (Vb * K) / Q + K * K,
      a0s,
      2 * (K * K - 1),
      1 - K / Q + K * K
    );

    const f0hp = 38.13547087602444;
    const Qhp = 0.5003270373238773;
    const Khp = Math.tan((Math.PI * f0hp) / fs);
    const a0hp = 1 + Khp / Qhp + Khp * Khp;
    const stage2 = createBiquad(
      1, -2, 1,
      a0hp,
      2 * (Khp * Khp - 1),
      1 - Khp / Qhp + Khp * Khp
    );

    return { stage1, stage2 };
  }

  function applyBiquadInPlace(arr, coeff) {
    const { b0, b1, b2, a1, a2 } = coeff;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < arr.length; i += 1) {
      const x0 = arr[i];
      const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = x0;
      y2 = y1;
      y1 = y0;
      arr[i] = y0;
    }
  }

  function kWeightChannel(samples, biquads) {
    const out = new Float32Array(samples.length);
    out.set(samples);
    applyBiquadInPlace(out, biquads.stage1);
    applyBiquadInPlace(out, biquads.stage2);
    return out;
  }

  function measureIntegratedLufs(left, right, sampleRate) {
    if (!left || !left.length) return -Infinity;
    const sr = Number(sampleRate) || 48000;
    const chR = right && right.length === left.length ? right : null;

    let maxPeak = 0;
    for (let i = 0; i < left.length; i += 1) {
      const aL = Math.abs(left[i]);
      if (aL > maxPeak) maxPeak = aL;
      if (chR) {
        const aR = Math.abs(chR[i]);
        if (aR > maxPeak) maxPeak = aR;
      }
    }
    if (maxPeak === 0) return -Infinity;

    const biquads = getKWeightingBiquads(sr);
    const kwL = kWeightChannel(left, biquads);
    const kwR = chR ? kWeightChannel(chR, biquads) : kwL;

    const blockSamples = Math.max(1, Math.round(sr * 0.4));
    const stepSamples = Math.max(1, Math.round(sr * 0.1));

    const blockEnergies = [];
    if (kwL.length < blockSamples) {
      let sum = 0;
      for (let i = 0; i < kwL.length; i += 1) {
        sum += kwL[i] * kwL[i] + kwR[i] * kwR[i];
      }
      blockEnergies.push(sum / kwL.length);
    } else {
      for (let start = 0; start + blockSamples <= kwL.length; start += stepSamples) {
        let sum = 0;
        const end = start + blockSamples;
        for (let i = start; i < end; i += 1) {
          sum += kwL[i] * kwL[i] + kwR[i] * kwR[i];
        }
        blockEnergies.push(sum / blockSamples);
      }
    }

    const absGateEnergies = [];
    for (let i = 0; i < blockEnergies.length; i += 1) {
      const e = blockEnergies[i];
      if (e > 0 && (-0.691 + 10 * Math.log10(e)) > -70) {
        absGateEnergies.push(e);
      }
    }
    if (!absGateEnergies.length) return -Infinity;

    let absMean = 0;
    for (let i = 0; i < absGateEnergies.length; i += 1) absMean += absGateEnergies[i];
    absMean /= absGateEnergies.length;
    const relThreshold = -0.691 + 10 * Math.log10(absMean) - 10;

    const relGateEnergies = [];
    for (let i = 0; i < absGateEnergies.length; i += 1) {
      const e = absGateEnergies[i];
      if (-0.691 + 10 * Math.log10(e) > relThreshold) {
        relGateEnergies.push(e);
      }
    }
    const finalSet = relGateEnergies.length ? relGateEnergies : absGateEnergies;
    let finalMean = 0;
    for (let i = 0; i < finalSet.length; i += 1) finalMean += finalSet[i];
    finalMean /= finalSet.length;

    return -0.691 + 10 * Math.log10(finalMean);
  }

  function measurePeakDb(left, right) {
    let maxPeak = 0;
    for (let i = 0; i < left.length; i += 1) {
      const aL = Math.abs(left[i]);
      if (aL > maxPeak) maxPeak = aL;
      if (right) {
        const aR = Math.abs(right[i]);
        if (aR > maxPeak) maxPeak = aR;
      }
    }
    return gainToDb(maxPeak);
  }

  function normalizeToTargetLufs(left, right, opts) {
    const options = opts || {};
    const targetLufs = options.targetLufs !== undefined ? Number(options.targetLufs) : -14;
    const ceilingDb = options.ceilingDb !== undefined ? Number(options.ceilingDb) : -1.0;
    const sampleRate = Number(options.sampleRate) || 48000;

    const inputLufs = measureIntegratedLufs(left, right, sampleRate);
    if (!Number.isFinite(inputLufs)) {
      return {
        left,
        right,
        inputLufs: -Infinity,
        outputLufs: -Infinity,
        gainDb: 0,
        peakDb: -Infinity,
        limiterEngaged: false
      };
    }

    const gainDb = clamp(targetLufs - inputLufs, -24, 24);
    const linearGain = dbToGain(gainDb);
    const ceilingLin = dbToGain(ceilingDb);
    let limiterEngaged = false;

    for (let i = 0; i < left.length; i += 1) {
      let vL = left[i] * linearGain;
      if (Math.abs(vL) > ceilingLin) {
        vL = Math.sign(vL) * ceilingLin;
        limiterEngaged = true;
      }
      left[i] = vL;

      if (right) {
        let vR = right[i] * linearGain;
        if (Math.abs(vR) > ceilingLin) {
          vR = Math.sign(vR) * ceilingLin;
          limiterEngaged = true;
        }
        right[i] = vR;
      }
    }

    const outputLufs = measureIntegratedLufs(left, right, sampleRate);
    const peakDb = measurePeakDb(left, right);

    return {
      left,
      right,
      inputLufs,
      outputLufs,
      gainDb,
      peakDb,
      limiterEngaged
    };
  }

  function evalBiquadDb(type, freqHz, q, dbGain, evalFreqHz, sampleRate) {
    if (Math.abs(dbGain) < 0.001) return 0;
    const fs = sampleRate || 48000;
    const A = Math.pow(10, dbGain / 40);
    const w0 = (2 * Math.PI * freqHz) / fs;
    const cosW0 = Math.cos(w0);
    const sinW0 = Math.sin(w0);
    const alpha = type === "peaking"
      ? sinW0 / (2 * q)
      : (sinW0 / 2) * Math.sqrt((A + 1 / A) * (1 / 0.707 - 1) + 2);

    let b0, b1, b2, a0, a1, a2;
    if (type === "lowshelf") {
      const sq = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) - (A - 1) * cosW0 + sq);
      b1 = 2 * A * ((A - 1) - (A + 1) * cosW0);
      b2 = A * ((A + 1) - (A - 1) * cosW0 - sq);
      a0 = (A + 1) + (A - 1) * cosW0 + sq;
      a1 = -2 * ((A - 1) + (A + 1) * cosW0);
      a2 = (A + 1) + (A - 1) * cosW0 - sq;
    } else if (type === "highshelf") {
      const sq = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) + (A - 1) * cosW0 + sq);
      b1 = -2 * A * ((A - 1) + (A + 1) * cosW0);
      b2 = A * ((A + 1) + (A - 1) * cosW0 - sq);
      a0 = (A + 1) - (A - 1) * cosW0 + sq;
      a1 = 2 * ((A - 1) - (A + 1) * cosW0);
      a2 = (A + 1) - (A - 1) * cosW0 - sq;
    } else {
      b0 = 1 + alpha * A;
      b1 = -2 * cosW0;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cosW0;
      a2 = 1 - alpha / A;
    }

    const w = (2 * Math.PI * evalFreqHz) / fs;
    const cosW = Math.cos(w);
    const sinW = Math.sin(w);
    const cos2W = Math.cos(2 * w);
    const sin2W = Math.sin(2 * w);

    const numRe = b0 + b1 * cosW + b2 * cos2W;
    const numIm = -b1 * sinW - b2 * sin2W;
    const denRe = a0 + a1 * cosW + a2 * cos2W;
    const denIm = -a1 * sinW - a2 * sin2W;

    const magSq = (numRe * numRe + numIm * numIm) / Math.max(1e-18, denRe * denRe + denIm * denIm);
    return 10 * Math.log10(Math.max(1e-12, magSq));
  }

  function computeEqCurvePoints(masterConfig, freqs) {
    const m = masterConfig || {};
    const list = Array.isArray(freqs) && freqs.length ? freqs : DEFAULT_FREQ_POINTS;
    if (m.bypass) {
      return list.map((f) => ({ freq: f, db: 0 }));
    }

    const bands = [
      { type: "lowshelf", freq: 80, q: 0.707, gain: Number(m.b80) || 0 },
      { type: "peaking", freq: 250, q: 1.2, gain: Number(m.b250) || 0 },
      { type: "peaking", freq: 1000, q: 1.0, gain: Number(m.b1k) || 0 },
      { type: "peaking", freq: 3500, q: 1.2, gain: Number(m.b3k5) || 0 },
      { type: "highshelf", freq: 10000, q: 0.707, gain: Number(m.b10k) || 0 }
    ];

    return list.map((f) => {
      let totalDb = 0;
      for (let i = 0; i < bands.length; i += 1) {
        totalDb += evalBiquadDb(bands[i].type, bands[i].freq, bands[i].q, bands[i].gain, f, 48000);
      }
      return { freq: f, db: Math.round(totalDb * 100) / 100 };
    });
  }

  return {
    DEFAULT_FREQ_POINTS,
    FX_CATALOG,
    createDefaultFxSlot,
    buildModularFxChain,
    buildHallImpulseResponse,
    buildChannelAndMasterDsp,
    applyNoiseGateOffline,
    measureIntegratedLufs,
    normalizeToTargetLufs,
    computeEqCurvePoints
  };
});
