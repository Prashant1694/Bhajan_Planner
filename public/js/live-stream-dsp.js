/**
 * Unified Web Audio DSP, Per-Track Modular FX Rack & Studio Mastering Engine
 * UMD module: works in browser (window.LiveStreamDsp) and Node.js unit/regression tests.
 * Zero external dependencies — 100% local CPU execution.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.LiveStreamDsp = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : self, function () {
  "use strict";

  const DEFAULT_FREQ_POINTS = [
    20, 32, 50, 80, 125, 200, 250, 350, 500, 750,
    1000, 1500, 2200, 3500, 5000, 7500, 10000, 14000, 18000
  ];

  // ITU-R BS.1770-4 4-phase polyphase 12-tap FIR interpolation kernels for 4x True Peak
  const BS1770_PHASES = [
    [0.001708984375, -0.0291748046875, -0.0189208984375, -0.00830078125, 0.302978515625, 0.90380859375, -0.2236328125, 0.097412109375, -0.05126953125, 0.02734375, -0.013671875, 0.00537109375],
    [0.00146484375, -0.0262451171875, -0.02685546875, 0.130615234375, 0.6929931640625, 0.45361328125, -0.2589111328125, 0.129638671875, -0.068359375, 0.03662109375, -0.0185546875, 0.00732421875],
    [0.000732421875, -0.0185546875, 0.03662109375, -0.068359375, 0.129638671875, -0.2589111328125, 0.45361328125, 0.6929931640625, 0.130615234375, -0.02685546875, -0.0262451171875, 0.00146484375],
    [0.00537109375, -0.013671875, 0.02734375, -0.05126953125, 0.097412109375, -0.2236328125, 0.90380859375, 0.302978515625, -0.00830078125, -0.0189208984375, -0.0291748046875, 0.001708984375]
  ];

  const FX_CATALOG = {
    eq: {
      type: "eq",
      name: "5-Band Parametric EQ",
      shortName: "EQ-5",
      defaultParams: {
        b80: 0, b250: 0, b1k: 0, b3k5: 0, b10k: 0,
        f80: 80, f250: 250, f1k: 1000, f3k5: 3500, f10k: 10000,
        q80: 0.707, q250: 1.2, q1k: 1.0, q3k5: 1.2, q10k: 0.707,
        hpfHz: 20, lpfHz: 20000, hpfSlope: 12,
        on1: 1, on2: 1, on3: 1, on4: 1, on5: 1,
        linearPhase: 0
      },
      presets: {
        flat: { label: "Flat", params: { b80: 0, b250: 0, b1k: 0, b3k5: 0, b10k: 0, hpfHz: 20, lpfHz: 20000 } },
        vocal_clarity: { label: "Natural Vocal Clarity", params: { b80: -2, b250: -3, b1k: 0.5, b3k5: 3.0, b10k: 2.0, hpfHz: 85, hpfSlope: 12 } },
        warm_harmonium: { label: "Harmonium EQ", params: { b80: 2.0, b250: -1.5, f1k: 1100, b1k: 1.0, b3k5: 0.5, b10k: -1.0, hpfHz: 45 } },
        crisp_tabla: { label: "Tabla EQ", params: { b80: 3.0, f250: 320, b250: -2.5, b1k: 0, b3k5: 2.5, b10k: 2.5, hpfHz: 38 } },
        de_mud: { label: "De-Mud / Clean", params: { b80: -1, b250: -4.0, b1k: 0, b3k5: 1.5, b10k: 1.0, hpfHz: 60 } },
        streaming_master: { label: "Master Tonal Curve", params: { b80: 0.5, b250: -1.5, b1k: 0, b3k5: 1.5, b10k: 1.0, hpfHz: 28, linearPhase: 1 } }
      },
      controls: [
        { key: "hpfHz", label: "Low Cut HPF", min: 20, max: 300, step: 5, unit: " Hz" },
        { key: "hpfSlope", label: "HPF Slope", min: 12, max: 24, step: 12, unit: " dB/oct" },
        { key: "lpfHz", label: "High Cut LPF", min: 2000, max: 20000, step: 250, unit: " Hz" },
        { key: "b80", label: "Low Shelf (80 Hz)", min: -12, max: 12, step: 0.5, unit: " dB" },
        { key: "b250", label: "Mud Cut (250 Hz)", min: -12, max: 12, step: 0.5, unit: " dB" },
        { key: "b1k", label: "Body (1 kHz)", min: -12, max: 12, step: 0.5, unit: " dB" },
        { key: "b3k5", label: "Presence (3.5 kHz)", min: -12, max: 12, step: 0.5, unit: " dB" },
        { key: "b10k", label: "Air / Brilliance (10k)", min: -12, max: 12, step: 0.5, unit: " dB" },
        { key: "linearPhase", label: "Linear-Phase FIR", min: 0, max: 1, step: 1, unit: "" }
      ]
    },
    filter: {
      type: "filter",
      name: "HPF / LPF Filter",
      shortName: "Filter",
      defaultParams: { hpfHz: 80, lpfHz: 18000, q: 0.707, slope: 12 },
      presets: {
        vocal_rumble: { label: "Vocal Rumble Cut", params: { hpfHz: 90, lpfHz: 20000, q: 0.707, slope: 24 } },
        tabla_sub_tight: { label: "Tabla Sub Tight", params: { hpfHz: 42, lpfHz: 18500, q: 0.707, slope: 12 } },
        harmonium_warm: { label: "Harmonium Warmth", params: { hpfHz: 48, lpfHz: 11500, q: 0.707, slope: 12 } },
        focused_mid: { label: "Radio / Broadcast Band", params: { hpfHz: 160, lpfHz: 9000, q: 0.85, slope: 24 } }
      },
      controls: [
        { key: "hpfHz", label: "Low Cut (HPF)", min: 20, max: 400, step: 5, unit: " Hz" },
        { key: "lpfHz", label: "High Cut (LPF)", min: 2000, max: 20000, step: 250, unit: " Hz" },
        { key: "q", label: "Resonance Q", min: 0.5, max: 4, step: 0.1, unit: " Q" },
        { key: "slope", label: "Filter Slope", min: 12, max: 24, step: 12, unit: " dB/oct" }
      ]
    },
    compressor: {
      type: "compressor",
      name: "Dynamics Compressor",
      shortName: "Comp",
      defaultParams: {
        threshold: -18, ratio: 3.5, knee: 10, attackMs: 8, releaseMs: 180, makeupDb: 0,
        scHpfHz: 60, peakMode: 0, mix: 100
      },
      presets: {
        vocal_smooth: { label: "Vocal Leveler", params: { threshold: -18, ratio: 3.2, knee: 10, attackMs: 8, releaseMs: 160, makeupDb: 1.5, scHpfHz: 80, peakMode: 0 } },
        vocal_presence: { label: "Vocal Presence Comp", params: { threshold: -20, ratio: 4.0, knee: 8, attackMs: 6, releaseMs: 140, makeupDb: 2.0, scHpfHz: 95, peakMode: 0 } },
        tabla_snap: { label: "Tabla Control", params: { threshold: -16, ratio: 3.5, knee: 6, attackMs: 18, releaseMs: 120, makeupDb: 1.0, scHpfHz: 45, peakMode: 1 } },
        harmonium_smooth: { label: "Harmonium Smooth", params: { threshold: -18, ratio: 2.4, knee: 12, attackMs: 15, releaseMs: 240, makeupDb: 0.5, scHpfHz: 60, peakMode: 0 } },
        master_glue: { label: "Master Glue", params: { threshold: -14, ratio: 2.0, knee: 14, attackMs: 22, releaseMs: 260, makeupDb: 0.5, scHpfHz: 60, peakMode: 0 } }
      },
      controls: [
        { key: "threshold", label: "Threshold", min: -40, max: 0, step: 1, unit: " dB" },
        { key: "ratio", label: "Ratio", min: 1, max: 16, step: 0.5, unit: ":1" },
        { key: "knee", label: "Soft Knee", min: 0, max: 30, step: 1, unit: " dB" },
        { key: "attackMs", label: "Attack", min: 1, max: 100, step: 1, unit: " ms" },
        { key: "releaseMs", label: "Release", min: 40, max: 600, step: 10, unit: " ms" },
        { key: "makeupDb", label: "Makeup Gain", min: -6, max: 12, step: 0.5, unit: " dB" },
        { key: "scHpfHz", label: "Sidechain HPF", min: 20, max: 250, step: 5, unit: " Hz" },
        { key: "peakMode", label: "RMS(0) / Peak(1)", min: 0, max: 1, step: 1, unit: "" },
        { key: "mix", label: "Parallel Mix", min: 0, max: 100, step: 5, unit: "%" }
      ]
    },
    gate: {
      type: "gate",
      name: "Hysteresis Gate / Expander",
      shortName: "Gate",
      defaultParams: {
        thresholdDb: -48, hysteresisDb: 4, attackMs: 4, holdMs: 90, releaseMs: 220, rangeDb: -18, scHpfHz: 80
      },
      presets: {
        gentle_vocal_expander: { label: "Gentle Vocal Expander", params: { thresholdDb: -50, hysteresisDb: 4, attackMs: 4, holdMs: 110, releaseMs: 240, rangeDb: -14, scHpfHz: 90 } },
        mandir_room_cleanup: { label: "Mandir Room Noise", params: { thresholdDb: -46, hysteresisDb: 4.5, attackMs: 4, holdMs: 120, releaseMs: 280, rangeDb: -18, scHpfHz: 80 } },
        tabla_bleed_control: { label: "Tabla Bleed Guard", params: { thresholdDb: -42, hysteresisDb: 5, attackMs: 2, holdMs: 140, releaseMs: 320, rangeDb: -16, scHpfHz: 60 } }
      },
      controls: [
        { key: "thresholdDb", label: "Open Threshold", min: -72, max: -18, step: 1, unit: " dB" },
        { key: "hysteresisDb", label: "Hysteresis", min: 0, max: 12, step: 0.5, unit: " dB" },
        { key: "attackMs", label: "Attack Time", min: 1, max: 40, step: 1, unit: " ms" },
        { key: "holdMs", label: "Hold Time", min: 10, max: 400, step: 10, unit: " ms" },
        { key: "releaseMs", label: "Release", min: 40, max: 800, step: 10, unit: " ms" },
        { key: "rangeDb", label: "Floor Attenuation", min: -48, max: 0, step: 1, unit: " dB" },
        { key: "scHpfHz", label: "Key HPF", min: 20, max: 250, step: 10, unit: " Hz" }
      ]
    },
    deesser: {
      type: "deesser",
      name: "Vocal De-Esser",
      shortName: "De-Ess",
      defaultParams: { freqHz: 6500, thresholdDb: -26, cutDb: 4, q: 3.2, attackMs: 1.5, releaseMs: 65, wideband: 0 },
      presets: {
        natural_sibilance: { label: "Natural Sibilance", params: { freqHz: 6500, thresholdDb: -26, cutDb: 4, q: 3.2, attackMs: 1.5, releaseMs: 65, wideband: 0 } },
        bright_mic_tamer: { label: "Bright Condenser", params: { freqHz: 7400, thresholdDb: -28, cutDb: 5.5, q: 2.8, attackMs: 1.0, releaseMs: 55, wideband: 0 } },
        chorus_wideband: { label: "Chorus Softener", params: { freqHz: 6000, thresholdDb: -24, cutDb: 3.5, q: 2.4, attackMs: 2.0, releaseMs: 80, wideband: 1 } }
      },
      controls: [
        { key: "freqHz", label: "Center Freq", min: 4000, max: 10000, step: 100, unit: " Hz" },
        { key: "thresholdDb", label: "Threshold", min: -45, max: -6, step: 1, unit: " dB" },
        { key: "cutDb", label: "Max Reduction", min: 0, max: 12, step: 0.5, unit: " dB" },
        { key: "q", label: "Bandwidth Q", min: 1, max: 6, step: 0.2, unit: " Q" },
        { key: "attackMs", label: "Attack", min: 0.5, max: 10, step: 0.5, unit: " ms" },
        { key: "releaseMs", label: "Release", min: 20, max: 200, step: 5, unit: " ms" },
        { key: "wideband", label: "Split(0)/Wide(1)", min: 0, max: 1, step: 1, unit: "" }
      ]
    },
    reverb: {
      type: "reverb",
      name: "Mandir Hall Reverb",
      shortName: "Reverb",
      defaultParams: {
        wet: 16, decay: 1.5, preDelayMs: 22, roomSize: 65,
        toneHz: 7800, lfDampHz: 180, earlyLevel: 45, stereoWidth: 110
      },
      presets: {
        small_mandir: { label: "Small Mandir", params: { wet: 14, decay: 0.9, preDelayMs: 12, roomSize: 40, toneHz: 8500, lfDampHz: 180, earlyLevel: 50, stereoWidth: 95 } },
        medium_prayer_hall: { label: "Medium Prayer Hall", params: { wet: 18, decay: 1.4, preDelayMs: 20, roomSize: 62, toneHz: 7600, lfDampHz: 180, earlyLevel: 45, stereoWidth: 110 } },
        large_mandir_hall: { label: "Large Mandir Hall", params: { wet: 22, decay: 2.1, preDelayMs: 32, roomSize: 82, toneHz: 6500, lfDampHz: 200, earlyLevel: 40, stereoWidth: 120 } },
        concert_hall: { label: "Concert Hall", params: { wet: 24, decay: 2.6, preDelayMs: 38, roomSize: 92, toneHz: 6800, lfDampHz: 160, earlyLevel: 38, stereoWidth: 125 } },
        vocal_plate: { label: "Vocal Plate", params: { wet: 15, decay: 1.25, preDelayMs: 18, roomSize: 52, toneHz: 9500, lfDampHz: 260, earlyLevel: 32, stereoWidth: 115 } },
        studio_room: { label: "Studio Room", params: { wet: 10, decay: 0.65, preDelayMs: 8, roomSize: 30, toneHz: 9000, lfDampHz: 220, earlyLevel: 58, stereoWidth: 88 } }
      },
      controls: [
        { key: "wet", label: "Wet Mix", min: 0, max: 60, step: 1, unit: "%" },
        { key: "decay", label: "Decay Time", min: 0.4, max: 3.5, step: 0.1, unit: " s" },
        { key: "preDelayMs", label: "Pre-Delay", min: 0, max: 120, step: 2, unit: " ms" },
        { key: "roomSize", label: "Room Size", min: 15, max: 100, step: 5, unit: "%" },
        { key: "toneHz", label: "HF Damping", min: 2000, max: 16000, step: 250, unit: " Hz" },
        { key: "lfDampHz", label: "LF Damping HPF", min: 40, max: 500, step: 10, unit: " Hz" },
        { key: "earlyLevel", label: "Early Refl.", min: 0, max: 100, step: 5, unit: "%" },
        { key: "stereoWidth", label: "Stereo Width", min: 0, max: 150, step: 5, unit: "%" }
      ]
    },
    delay: {
      type: "delay",
      name: "Stereo Echo / Delay",
      shortName: "Delay",
      defaultParams: {
        timeMs: 260, rightTimeMs: 390, bpm: 0, syncSubdiv: 0,
        feedback: 25, hpfHz: 220, toneHz: 4500, stereoWidth: 110, pingPong: 1, modDepthMs: 0.6, wet: 15
      },
      presets: {
        slapback_vocal: { label: "Vocal Slap", params: { timeMs: 115, rightTimeMs: 135, bpm: 0, feedback: 12, hpfHz: 280, toneHz: 5200, pingPong: 0, wet: 10 } },
        devotional_echo: { label: "Mandir Echo", params: { timeMs: 260, rightTimeMs: 390, bpm: 0, feedback: 24, hpfHz: 240, toneHz: 4400, pingPong: 1, wet: 14 } },
        dotted_eighth_space: { label: "Dotted 1/8 Sync", params: { bpm: 92, syncSubdiv: 2, feedback: 30, hpfHz: 260, toneHz: 3800, stereoWidth: 125, pingPong: 1, wet: 16 } }
      },
      controls: [
        { key: "timeMs", label: "Left Delay", min: 40, max: 900, step: 10, unit: " ms" },
        { key: "rightTimeMs", label: "Right Delay", min: 40, max: 900, step: 10, unit: " ms" },
        { key: "bpm", label: "Tempo Sync BPM", min: 0, max: 180, step: 2, unit: " BPM" },
        { key: "syncSubdiv", label: "Subdivision (0-3)", min: 0, max: 3, step: 1, unit: "" },
        { key: "feedback", label: "Feedback", min: 0, max: 75, step: 2, unit: "%" },
        { key: "hpfHz", label: "Feedback HPF", min: 40, max: 1000, step: 20, unit: " Hz" },
        { key: "toneHz", label: "Warmth LPF", min: 1000, max: 12000, step: 250, unit: " Hz" },
        { key: "stereoWidth", label: "Echo Width", min: 0, max: 150, step: 5, unit: "%" },
        { key: "modDepthMs", label: "Tape Mod Depth", min: 0, max: 2.5, step: 0.1, unit: " ms" },
        { key: "pingPong", label: "Ping-Pong (0/1)", min: 0, max: 1, step: 1, unit: "" },
        { key: "wet", label: "Echo Mix", min: 0, max: 60, step: 1, unit: "%" }
      ]
    },
    saturation: {
      type: "saturation",
      name: "Analog Tape / Tube Warmth",
      shortName: "Warmth",
      defaultParams: { mode: 0, drive: 22, bias: 10, toneHz: 11000, mix: 35, outputDb: 0, autoGain: 1 },
      presets: {
        warm_tape_subtle: { label: "Subtle Tape", params: { mode: 0, drive: 20, bias: 0, toneHz: 11500, mix: 35, outputDb: 0, autoGain: 1 } },
        tube_vocal_harmonic: { label: "Tube Vocal Silk", params: { mode: 1, drive: 30, bias: 16, toneHz: 12000, mix: 30, outputDb: 0, autoGain: 1 } },
        harmonium_body: { label: "Harmonium Body", params: { mode: 0, drive: 28, bias: 8, toneHz: 9500, mix: 45, outputDb: 0, autoGain: 1 } },
        master_analog_glue: { label: "Master Tape Glue", params: { mode: 0, drive: 14, bias: 0, toneHz: 14000, mix: 25, outputDb: 0, autoGain: 1 } }
      },
      controls: [
        { key: "mode", label: "Tape(0) / Tube(1)", min: 0, max: 1, step: 1, unit: "" },
        { key: "drive", label: "Analog Drive", min: 0, max: 100, step: 2, unit: "%" },
        { key: "bias", label: "Tube Bias", min: 0, max: 50, step: 2, unit: "%" },
        { key: "toneHz", label: "Warmth Tone", min: 3000, max: 18000, step: 500, unit: " Hz" },
        { key: "mix", label: "Blend Mix", min: 0, max: 100, step: 5, unit: "%" },
        { key: "autoGain", label: "Auto Level-Match", min: 0, max: 1, step: 1, unit: "" },
        { key: "outputDb", label: "Output Trim", min: -12, max: 6, step: 0.5, unit: " dB" }
      ]
    },
    stereo_width: {
      type: "stereo_width",
      name: "Stereo M/S Imaging",
      shortName: "Width",
      defaultParams: { widthPct: 100, bassMonoHz: 120 },
      presets: {
        natural_mandir_stage: { label: "Natural Stage", params: { widthPct: 108, bassMonoHz: 110 } },
        mono_bass_focus: { label: "Tight Low-End", params: { widthPct: 100, bassMonoHz: 160 } },
        wide_ensemble: { label: "Wide Ensemble", params: { widthPct: 128, bassMonoHz: 120 } }
      },
      controls: [
        { key: "widthPct", label: "Stereo Width", min: 0, max: 160, step: 5, unit: "%" },
        { key: "bassMonoHz", label: "Bass Mono Split", min: 20, max: 300, step: 10, unit: " Hz" }
      ]
    },
    limiter: {
      type: "limiter",
      name: "True-Peak Brickwall Limiter",
      shortName: "Limit",
      defaultParams: { ceilingDb: -1.0, thresholdDb: -2.0, lookaheadMs: 2.5, releaseMs: 80 },
      presets: {
        streaming_minus_1dbtp: { label: "-1.0 dBTP Stream", params: { ceilingDb: -1.0, thresholdDb: -2.0, lookaheadMs: 2.5, releaseMs: 80 } },
        broadcast_minus_2dbtp: { label: "-2.0 dBTP Safe", params: { ceilingDb: -2.0, thresholdDb: -3.5, lookaheadMs: 3.0, releaseMs: 90 } },
        gentle_safety: { label: "Gentle Peak Guard", params: { ceilingDb: -0.8, thresholdDb: -1.0, lookaheadMs: 2.0, releaseMs: 110 } }
      },
      controls: [
        { key: "ceilingDb", label: "True-Peak Ceiling", min: -6, max: 0, step: 0.1, unit: " dB" },
        { key: "thresholdDb", label: "Drive Threshold", min: -12, max: 0, step: 0.5, unit: " dB" },
        { key: "lookaheadMs", label: "Lookahead", min: 0.5, max: 5, step: 0.5, unit: " ms" },
        { key: "releaseMs", label: "Release", min: 20, max: 250, step: 5, unit: " ms" }
      ]
    }
  };

  // Part 12: 8 Professional Mandir DAW Chain Presets
  const DAW_CHAIN_PRESETS = {
    natural_vocal_processing: {
      id: "natural_vocal_processing",
      label: "Natural Vocal Processing",
      targetRole: "ch1",
      slots: [
        { type: "eq", params: { hpfHz: 85, hpfSlope: 12, b80: -1.5, b250: -2.5, b1k: 0, b3k5: 2.0, b10k: 1.5 } },
        { type: "deesser", params: { freqHz: 6500, thresholdDb: -26, cutDb: 4.0, q: 3.2 } },
        { type: "compressor", params: { threshold: -18, ratio: 3.2, knee: 10, attackMs: 8, releaseMs: 160, makeupDb: 1.5, scHpfHz: 80 } }
      ]
    },
    harmonium_eq: {
      id: "harmonium_eq",
      label: "Harmonium EQ",
      targetRole: "ch2",
      slots: [
        { type: "eq", params: { hpfHz: 45, hpfSlope: 12, b80: 2.0, b250: -2.0, f1k: 1100, b1k: 1.0, b3k5: 0.5, b10k: -1.0 } },
        { type: "saturation", params: { mode: 0, drive: 18, toneHz: 10000, mix: 30, autoGain: 1 } }
      ]
    },
    tabla_eq: {
      id: "tabla_eq",
      label: "Tabla EQ",
      targetRole: "ch2",
      slots: [
        { type: "eq", params: { hpfHz: 38, hpfSlope: 12, b80: 3.0, f250: 320, b250: -2.5, b1k: 0, b3k5: 2.5, b10k: 2.0 } },
        { type: "compressor", params: { threshold: -16, ratio: 3.2, knee: 6, attackMs: 18, releaseMs: 120, makeupDb: 1.0, scHpfHz: 45, peakMode: 1 } }
      ]
    },
    vocal_deesser: {
      id: "vocal_deesser",
      label: "Vocal De-Esser",
      targetRole: "ch1",
      slots: [
        { type: "deesser", params: { freqHz: 6600, thresholdDb: -27, cutDb: 5.0, q: 3.0, attackMs: 1.5, releaseMs: 60, wideband: 0 } }
      ]
    },
    mandir_hall_reverb: {
      id: "mandir_hall_reverb",
      label: "Mandir Hall Reverb",
      targetRole: "ch1",
      slots: [
        { type: "reverb", params: { wet: 18, decay: 1.4, preDelayMs: 20, roomSize: 62, toneHz: 7600, lfDampHz: 180, earlyLevel: 45, stereoWidth: 110 } }
      ]
    },
    vocal_compressor: {
      id: "vocal_compressor",
      label: "Vocal Compressor",
      targetRole: "ch1",
      slots: [
        { type: "gate", params: { thresholdDb: -50, hysteresisDb: 4, attackMs: 4, holdMs: 100, releaseMs: 220, rangeDb: -14, scHpfHz: 85 } },
        { type: "compressor", params: { threshold: -18, ratio: 3.5, knee: 10, attackMs: 7, releaseMs: 155, makeupDb: 1.5, scHpfHz: 80 } }
      ]
    },
    master_glue: {
      id: "master_glue",
      label: "Master Glue",
      targetRole: "master",
      slots: [
        { type: "compressor", params: { threshold: -14, ratio: 2.0, knee: 14, attackMs: 22, releaseMs: 260, makeupDb: 0.5, scHpfHz: 60 } },
        { type: "saturation", params: { mode: 0, drive: 14, toneHz: 14000, mix: 25, autoGain: 1 } }
      ]
    },
    streaming_master: {
      id: "streaming_master",
      label: "Streaming Master (-14 LUFS)",
      targetRole: "master",
      slots: [
        { type: "eq", params: { hpfHz: 28, hpfSlope: 12, b80: 0.5, b250: -1.5, b1k: 0, b3k5: 1.5, b10k: 1.0, linearPhase: 1 } },
        { type: "compressor", params: { threshold: -14, ratio: 2.0, knee: 14, attackMs: 22, releaseMs: 260, makeupDb: 0.5, scHpfHz: 60 } },
        { type: "stereo_width", params: { widthPct: 108, bassMonoHz: 120 } },
        { type: "limiter", params: { ceilingDb: -1.0, thresholdDb: -2.0, lookaheadMs: 2.5, releaseMs: 80 } }
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
      wetDry: ov.wetDry != null ? clamp(Number(ov.wetDry), 0, 100) : 100,
      params
    };
  }

  /* ===================== RBJ Cookbook Biquads & Parametric EQ ===================== */

  function computeBiquadCoeffs(type, freqHz, q, dbGain, sampleRate) {
    const fs = Math.max(8000, Number(sampleRate) || 48000);
    const f0 = clamp(Number(freqHz) || 1000, 10, fs * 0.45);
    const safeQ = clamp(Number(q) || 0.7071, 0.25, 16);
    const gainDb = clamp(Number(dbGain) || 0, -24, 24);
    const A = Math.pow(10, gainDb / 40);
    const w0 = (2 * Math.PI * f0) / fs;
    const cosW0 = Math.cos(w0);
    const sinW0 = Math.sin(w0);

    let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;

    if (type === "highpass") {
      const alpha = sinW0 / (2 * safeQ);
      b0 = (1 + cosW0) / 2;
      b1 = -(1 + cosW0);
      b2 = (1 + cosW0) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cosW0;
      a2 = 1 - alpha;
    } else if (type === "lowpass") {
      const alpha = sinW0 / (2 * safeQ);
      b0 = (1 - cosW0) / 2;
      b1 = 1 - cosW0;
      b2 = (1 - cosW0) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cosW0;
      a2 = 1 - alpha;
    } else if (type === "bandpass") {
      const alpha = sinW0 / (2 * safeQ);
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
      a0 = 1 + alpha;
      a1 = -2 * cosW0;
      a2 = 1 - alpha;
    } else if (type === "notch") {
      const alpha = sinW0 / (2 * safeQ);
      b0 = 1;
      b1 = -2 * cosW0;
      b2 = 1;
      a0 = 1 + alpha;
      a1 = -2 * cosW0;
      a2 = 1 - alpha;
    } else if (type === "lowshelf") {
      if (Math.abs(gainDb) < 0.001) return { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
      const alpha = (sinW0 / 2) * Math.sqrt((A + 1 / A) * (1 / safeQ - 1) + 2);
      const sq = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) - (A - 1) * cosW0 + sq);
      b1 = 2 * A * ((A - 1) - (A + 1) * cosW0);
      b2 = A * ((A + 1) - (A - 1) * cosW0 - sq);
      a0 = (A + 1) + (A - 1) * cosW0 + sq;
      a1 = -2 * ((A - 1) + (A + 1) * cosW0);
      a2 = (A + 1) + (A - 1) * cosW0 - sq;
    } else if (type === "highshelf") {
      if (Math.abs(gainDb) < 0.001) return { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
      const alpha = (sinW0 / 2) * Math.sqrt((A + 1 / A) * (1 / safeQ - 1) + 2);
      const sq = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) + (A - 1) * cosW0 + sq);
      b1 = -2 * A * ((A - 1) + (A + 1) * cosW0);
      b2 = A * ((A + 1) + (A - 1) * cosW0 - sq);
      a0 = (A + 1) - (A - 1) * cosW0 + sq;
      a1 = 2 * ((A - 1) - (A + 1) * cosW0);
      a2 = (A + 1) - (A - 1) * cosW0 - sq;
    } else {
      // peaking EQ
      if (Math.abs(gainDb) < 0.001) return { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
      const alpha = sinW0 / (2 * safeQ);
      b0 = 1 + alpha * A;
      b1 = -2 * cosW0;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cosW0;
      a2 = 1 - alpha / A;
    }

    return {
      b0: b0 / a0,
      b1: b1 / a0,
      b2: b2 / a0,
      a1: a1 / a0,
      a2: a2 / a0
    };
  }

  function createBiquad(b0, b1, b2, a0, a1, a2) {
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
  }

  function evalBiquadCoeffDb(coeff, evalFreqHz, sampleRate) {
    const fs = sampleRate || 48000;
    const w = (2 * Math.PI * clamp(evalFreqHz, 5, fs * 0.49)) / fs;
    const cosW = Math.cos(w);
    const sinW = Math.sin(w);
    const cos2W = Math.cos(2 * w);
    const sin2W = Math.sin(2 * w);
    const numRe = coeff.b0 + coeff.b1 * cosW + coeff.b2 * cos2W;
    const numIm = -coeff.b1 * sinW - coeff.b2 * sin2W;
    const denRe = 1 + coeff.a1 * cosW + coeff.a2 * cos2W;
    const denIm = -coeff.a1 * sinW - coeff.a2 * sin2W;
    const magSq = (numRe * numRe + numIm * numIm) / Math.max(1e-18, denRe * denRe + denIm * denIm);
    return 10 * Math.log10(Math.max(1e-12, magSq));
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

  function buildEqStages(eqParams, sampleRate) {
    const m = eqParams || {};
    if (m.bypass) return [];
    const sr = Number(sampleRate) || 48000;
    const stages = [];
    const hpfHz = Number(m.hpfHz) || 20;
    if (hpfHz > 22) {
      const cHpf = computeBiquadCoeffs("highpass", hpfHz, 0.7071, 0, sr);
      stages.push(cHpf);
      if (Number(m.hpfSlope) === 24) stages.push(cHpf);
    }
    const lpfHz = Number(m.lpfHz) || 20000;
    if (lpfHz < 19500) {
      stages.push(computeBiquadCoeffs("lowpass", lpfHz, 0.7071, 0, sr));
    }

    const bands = [
      { on: m.on1 !== 0, type: "lowshelf", freq: Number(m.f80) || 80, q: Number(m.q80) || 0.7071, gain: Number(m.b80) || 0 },
      { on: m.on2 !== 0, type: "peaking", freq: Number(m.f250) || 250, q: Number(m.q250) || 1.2, gain: Number(m.b250) || 0 },
      { on: m.on3 !== 0, type: "peaking", freq: Number(m.f1k) || 1000, q: Number(m.q1k) || 1.0, gain: Number(m.b1k) || 0 },
      { on: m.on4 !== 0, type: "peaking", freq: Number(m.f3k5) || 3500, q: Number(m.q3k5) || 1.2, gain: Number(m.b3k5) || 0 },
      { on: m.on5 !== 0, type: "highshelf", freq: Number(m.f10k) || 10000, q: Number(m.q10k) || 0.7071, gain: Number(m.b10k) || 0 }
    ];
    for (let i = 0; i < bands.length; i++) {
      const b = bands[i];
      if (!b.on || Math.abs(b.gain) < 0.01) continue;
      stages.push(computeBiquadCoeffs(b.type, b.freq, b.q, b.gain, sr));
    }
    return stages;
  }

  /**
   * Synthesize a symmetric Type-I Blackman-windowed Linear-Phase FIR EQ kernel.
   * Group delay is exactly Math.floor((tapCount - 1) / 2) samples (0 phase distortion).
   */
  function buildLinearPhaseEqKernel(eqParams, sampleRate = 48000, tapCount = 513) {
    const N = tapCount % 2 === 1 ? Math.max(65, tapCount) : Math.max(65, tapCount + 1);
    const M = (N - 1) / 2;
    const kernel = new Float32Array(N);
    const stages = buildEqStages(eqParams, sampleRate);
    if (stages.length === 0) {
      kernel[M] = 1;
      return kernel;
    }

    const K = 512;
    const mag = new Float32Array(K + 1);
    const fs = Number(sampleRate) || 48000;
    for (let k = 0; k <= K; k++) {
      const freq = Math.max(5, (k / K) * (fs * 0.49));
      let db = 0;
      for (let s = 0; s < stages.length; s++) {
        db += evalBiquadCoeffDb(stages[s], freq, fs);
      }
      mag[k] = dbToGain(clamp(db, -24, 24));
    }

    // Cosine transform + Blackman window for symmetric Type-I zero-phase response
    for (let n = 0; n < N; n++) {
      const d = n - M;
      let acc = mag[0] + (d % 2 === 0 ? mag[K] : -mag[K]);
      for (let k = 1; k < K; k++) {
        acc += 2 * mag[k] * Math.cos((Math.PI * k * d) / K);
      }
      const raw = acc / (2 * K);
      const u = (2 * Math.PI * n) / (N - 1);
      const win = 0.42 - 0.5 * Math.cos(u) + 0.08 * Math.cos(2 * u);
      kernel[n] = raw * win;
    }

    // Normalize DC / 0 dB center calibration
    let dcGain = 0;
    for (let n = 0; n < N; n++) dcGain += kernel[n];
    const targetDc = stages.every((st) => evalBiquadCoeffDb(st, 1000, fs) === 0) ? 1 : null;
    if (targetDc && Math.abs(dcGain) > 1e-6) {
      const scale = 1 / dcGain;
      for (let n = 0; n < N; n++) kernel[n] *= scale;
    }
    return kernel;
  }

  function buildLinearPhaseEqImpulseResponse(ctx, eqParams, tapCount = 513) {
    const sr = (ctx && ctx.sampleRate) || 48000;
    const kernel = buildLinearPhaseEqKernel(eqParams, sr, tapCount);
    const buf = ctx.createBuffer(2, kernel.length, sr);
    buf.getChannelData(0).set(kernel);
    buf.getChannelData(1).set(kernel);
    return buf;
  }

  /**
   * Process stereo Float32 arrays through a parametric EQ specification offline,
   * automatically routing Linear-Phase FIR with zero-latency offset compensation when linearPhase=1.
   */
  function processParametricEqOffline(left, right, eqParams, sampleRate = 48000) {
    const m = eqParams || {};
    if (m.linearPhase) {
      return processLinearPhaseEqOffline(left, right, m, sampleRate, 513);
    }
    const outL = new Float32Array(left);
    const outR = right ? new Float32Array(right) : null;
    if (m.bypass) return { left: outL, right: outR };

    const stages = buildEqStages(m, sampleRate);
    for (let s = 0; s < stages.length; s++) {
      applyBiquadInPlace(outL, stages[s]);
      if (outR) applyBiquadInPlace(outR, stages[s]);
    }
    return { left: outL, right: outR };
  }

  function processLinearPhaseEqOffline(left, right, eqParams, sampleRate = 48000, tapCount = 513) {
    const m = eqParams || {};
    const outL = new Float32Array(left.length);
    const outR = right ? new Float32Array(right.length) : null;
    if (m.bypass) {
      outL.set(left);
      if (outR) outR.set(right);
      return { left: outL, right: outR, latencySamples: 0 };
    }
    const kernel = buildLinearPhaseEqKernel(m, sampleRate, tapCount);
    const N = kernel.length;
    const half = (N - 1) >> 1;

    function convolveCompensated(src, dst) {
      const len = src.length;
      for (let i = 0; i < len; i++) {
        let acc = 0;
        const nMin = Math.max(0, half - (len - 1 - i));
        const nMax = Math.min(N - 1, i + half);
        for (let k = nMin; k <= nMax; k++) {
          const srcIdx = i + half - k;
          if (srcIdx >= 0 && srcIdx < len) {
            acc += src[srcIdx] * kernel[k];
          }
        }
        dst[i] = acc;
      }
    }
    convolveCompensated(left, outL);
    if (outR) convolveCompensated(right, outR);
    return { left: outL, right: outR, latencySamples: half };
  }

  function processFilterOffline(left, right, params = {}, sampleRate = 48000) {
    const outL = new Float32Array(left);
    const outR = right ? new Float32Array(right) : null;
    const sr = Number(sampleRate) || 48000;
    const hpfHz = Number(params.hpfHz) || 20;
    const lpfHz = Number(params.lpfHz) || 20000;
    const q = clamp(Number(params.q) || 0.7071, 0.3, 8);
    const stages = [];
    if (hpfHz > 22) {
      const cH = computeBiquadCoeffs("highpass", hpfHz, q, 0, sr);
      stages.push(cH);
      if (Number(params.slope) === 24) stages.push(cH);
    }
    if (lpfHz < 19500) {
      const cL = computeBiquadCoeffs("lowpass", lpfHz, q, 0, sr);
      stages.push(cL);
      if (Number(params.slope) === 24) stages.push(cL);
    }
    for (let i = 0; i < stages.length; i++) {
      applyBiquadInPlace(outL, stages[i]);
      if (outR) applyBiquadInPlace(outR, stages[i]);
    }
    return { left: outL, right: outR };
  }

  /* ===================== Mandir Hall & Convolution Reverb ===================== */

  /**
   * Generate a realistic stereo Mandir Hall impulse response with:
   *  - Configurable Pre-delay (ms)
   *  - 12 stereo-decorrelated early reflection taps
   *  - Progressive 1-pole air-absorption HF damping (high frequencies decay faster)
   *  - Mud control LF rolloff
   *  - Mid/Side stereo width adjustment
   */
  function buildHallImpulseResponse(ctx, decayOrOpts) {
    const sampleRate = (ctx && ctx.sampleRate) || 48000;
    const isNum = typeof decayOrOpts === "number";
    const opts = isNum ? { decay: decayOrOpts } : (decayOrOpts || {});

    const preset = opts.preset && FX_CATALOG.reverb.presets[opts.preset]
      ? FX_CATALOG.reverb.presets[opts.preset].params
      : null;
    const eff = Object.assign({}, FX_CATALOG.reverb.defaultParams, preset || {}, opts);

    const decay = clamp(Number(eff.decay) || 1.5, 0.35, 4.0);
    const preDelayMs = clamp(Number(eff.preDelayMs) || 0, 0, 140);
    const roomSizeNorm = clamp(Number(eff.roomSize ?? 65) / 100, 0.15, 1.0);
    const hfCutoff = clamp(Number(eff.toneHz ?? 7800), 1500, 18000);
    const lfCutoff = clamp(Number(eff.lfDampHz ?? 180), 20, 600);
    const earlyAmt = clamp(Number(eff.earlyLevel ?? 45) / 100, 0, 1);
    const widthFactor = clamp(Number(eff.stereoWidth ?? 110) / 100, 0, 1.5);

    const preDelaySamples = Math.floor((sampleRate * preDelayMs) / 1000);
    const tailLength = Math.max(1, Math.floor(sampleRate * decay));
    const totalLength = Math.max(64, preDelaySamples + tailLength);

    const buffer = ctx.createBuffer(2, totalLength, sampleRate);
    const ch0 = buffer.getChannelData(0);
    const ch1 = buffer.getChannelData(1);

    // Deterministic seeded PRNG for consistent acoustic response in tests & sessions
    let seedL = 0x13579bdf;
    let seedR = 0x2468ace1;
    const nextRandL = () => {
      seedL = (seedL * 1664525 + 1013904223) >>> 0;
      return (seedL / 4294967296) * 2 - 1;
    };
    const nextRandR = () => {
      seedR = (seedR * 1664525 + 1013904223) >>> 0;
      return (seedR / 4294967296) * 2 - 1;
    };

    // 1. Discrete stereo-decorrelated Early Reflections
    const tapOffsetsMs = [5.2, 8.7, 13.1, 17.6, 22.8, 28.4, 34.9, 41.2, 48.7, 56.3, 64.5, 73.1];
    for (let t = 0; t < tapOffsetsMs.length; t++) {
      const scaledMs = preDelayMs + tapOffsetsMs[t] * (0.45 + roomSizeNorm * 0.75);
      const idx = Math.floor((scaledMs / 1000) * sampleRate);
      if (idx >= totalLength) continue;
      const amp = (1 - t / tapOffsetsMs.length) * 0.42 * earlyAmt;
      const side = (t % 2 === 0 ? 1 : -1) * 0.35;
      ch0[idx] += amp * (0.8 + side);
      ch1[idx] += amp * (0.8 - side);
    }

    // 2. Late diffuse hall tail with progressive air absorption (1-pole LPF) + LF mud HPF
    const rt60Coeff = -6.907755 / tailLength; // -60 dB at tailLength
    const lpAlpha = Math.exp((-2 * Math.PI * hfCutoff) / sampleRate);
    const hpAlpha = Math.exp((-2 * Math.PI * lfCutoff) / sampleRate);
    let lpL = 0, lpR = 0, hpPrevInL = 0, hpOutL = 0, hpPrevInR = 0, hpOutR = 0;
    const fadeIn = Math.max(1, Math.floor(sampleRate * 0.012));

    for (let i = 0; i < tailLength; i++) {
      const targetIdx = preDelaySamples + i;
      const onset = i < fadeIn ? i / fadeIn : 1;
      const env = Math.exp(rt60Coeff * i) * onset * 0.38;

      const rawL = nextRandL() * env;
      const rawR = nextRandR() * env;

      // Progressive HF damping
      lpL = (1 - lpAlpha) * rawL + lpAlpha * lpL;
      lpR = (1 - lpAlpha) * rawR + lpAlpha * lpR;

      // 1-pole LF damping HPF
      hpOutL = hpAlpha * (hpOutL + lpL - hpPrevInL);
      hpPrevInL = lpL;
      hpOutR = hpAlpha * (hpOutR + lpR - hpPrevInR);
      hpPrevInR = lpR;

      ch0[targetIdx] += hpOutL;
      ch1[targetIdx] += hpOutR;
    }

    // 3. Apply Mid/Side stereo width adjustment across entire IR
    if (Math.abs(widthFactor - 1) > 0.01) {
      for (let i = 0; i < totalLength; i++) {
        const mid = 0.5 * (ch0[i] + ch1[i]);
        const side = 0.5 * (ch0[i] - ch1[i]) * widthFactor;
        ch0[i] = mid + side;
        ch1[i] = mid - side;
      }
    }

    return buffer;
  }

  /* ===================== Offline Dynamics, De-Esser, Saturation & Limiter ===================== */

  function processCompressorOffline(left, right, params = {}, sampleRate = 48000) {
    const outL = new Float32Array(left);
    const outR = right ? new Float32Array(right) : null;
    const thr = Number(params.threshold ?? -18);
    const ratio = Math.max(1, Number(params.ratio ?? 3.5));
    const knee = Math.max(0, Number(params.knee ?? 10));
    const attMs = Math.max(0.5, Number(params.attackMs ?? 8));
    const relMs = Math.max(10, Number(params.releaseMs ?? 180));
    const makeup = dbToGain(Number(params.makeupDb ?? 0));
    const scHpfHz = Number(params.scHpfHz ?? 60);
    const peakMode = Boolean(params.peakMode || params.detection === "peak");
    const mix = clamp(Number(params.mix ?? 100) / 100, 0, 1);

    const scCoeff = computeBiquadCoeffs("highpass", scHpfHz, 0.7071, 0, sampleRate);
    let sx1L = 0, sx2L = 0, sy1L = 0, sy2L = 0;
    let sx1R = 0, sx2R = 0, sy1R = 0, sy2R = 0;

    const attCoeff = Math.exp(-1 / Math.max(1, (sampleRate * attMs) / 1000));
    const relCoeff = Math.exp(-1 / Math.max(1, (sampleRate * relMs) / 1000));
    let envSq = 0;
    let smoothGrDb = 0;
    let maxGrDb = 0;

    for (let i = 0; i < outL.length; i++) {
      const rawL = outL[i];
      const rawR = outR ? outR[i] : rawL;

      const scL = scCoeff.b0 * rawL + scCoeff.b1 * sx1L + scCoeff.b2 * sx2L - scCoeff.a1 * sy1L - scCoeff.a2 * sy2L;
      sx2L = sx1L; sx1L = rawL; sy2L = sy1L; sy1L = scL;
      const scR = outR
        ? scCoeff.b0 * rawR + scCoeff.b1 * sx1R + scCoeff.b2 * sx2R - scCoeff.a1 * sy1R - scCoeff.a2 * sy2R
        : scL;
      sx2R = sx1R; sx1R = rawR; sy2R = sy1R; sy1R = scR;

      if (peakMode) {
        const pkSq = Math.max(scL * scL, scR * scR);
        envSq = pkSq > envSq ? pkSq : relCoeff * envSq + (1 - relCoeff) * pkSq;
      } else {
        const energy = 0.5 * (scL * scL + scR * scR);
        const c = energy > envSq ? attCoeff : relCoeff;
        envSq = c * envSq + (1 - c) * energy;
      }
      const envDb = gainToDb(Math.sqrt(Math.max(1e-12, envSq)));

      let targetGr = 0;
      if (knee > 0 && Math.abs(envDb - thr) <= knee * 0.5) {
        const d = envDb - thr + knee * 0.5;
        targetGr = ((1 - 1 / ratio) * d * d) / (2 * knee);
      } else if (envDb > thr) {
        targetGr = (envDb - thr) * (1 - 1 / ratio);
      }
      smoothGrDb = 0.8 * smoothGrDb + 0.2 * targetGr;
      if (smoothGrDb > maxGrDb) maxGrDb = smoothGrDb;

      const wetGain = dbToGain(-smoothGrDb) * makeup;
      outL[i] = rawL * (1 - mix) + rawL * wetGain * mix;
      if (outR) outR[i] = rawR * (1 - mix) + rawR * wetGain * mix;
    }

    return { left: outL, right: outR, maxGrDb };
  }

  /**
   * Apply a smooth hysteresis Noise Gate / Expander with Sidechain Key HPF (in-place and returned).
   */
  function applyNoiseGateOffline(samples, sampleRate, thresholdDb, holdMs, releaseMs, opts = {}) {
    if (!samples || !samples.length) return samples;
    const sr = Number(sampleRate) || 48000;
    const thrDb = thresholdDb === undefined ? -48 : Number(thresholdDb);
    const hystDb = Math.max(0, Number(opts.hysteresisDb ?? 3.5));
    const openLin = dbToGain(thrDb);
    const closeLin = dbToGain(thrDb - hystDb);
    const holdSamples = Math.max(1, Math.round((sr * (holdMs === undefined ? 80 : holdMs)) / 1000));
    const releaseSamples = Math.max(1, Math.round((sr * (releaseMs === undefined ? 120 : releaseMs)) / 1000));
    const attackSamples = Math.max(1, Math.round((sr * (opts.attackMs ?? 8)) / 1000));
    const floorGain = opts.rangeDb != null ? dbToGain(Math.min(0, Number(opts.rangeDb))) : 0.005;
    const scHpfHz = Number(opts.scHpfHz ?? 60);
    const scHpf = scHpfHz > 22 ? computeBiquadCoeffs("highpass", scHpfHz, 0.7071, 0, sr) : null;

    const envCoeff = Math.exp(-1 / Math.max(1, Math.round(sr * 0.008)));
    const attackStep = 1 / attackSamples;
    const releaseStep = (1 - floorGain) / releaseSamples;

    let env = 0;
    let holdCounter = 0;
    let gateGain = 1;
    let isOpen = false;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;

    for (let i = 0; i < samples.length; i += 1) {
      const s = samples[i];
      let det = s;
      if (scHpf) {
        det = scHpf.b0 * s + scHpf.b1 * x1 + scHpf.b2 * x2 - scHpf.a1 * y1 - scHpf.a2 * y2;
        x2 = x1; x1 = s; y2 = y1; y1 = det;
      }
      const absVal = Math.abs(det);
      env = absVal > env ? absVal : env * envCoeff + absVal * (1 - envCoeff);

      if (env >= openLin) {
        isOpen = true;
        holdCounter = holdSamples;
      } else if (holdCounter > 0) {
        holdCounter -= 1;
      } else if (env < closeLin) {
        isOpen = false;
      }

      gateGain = isOpen
        ? Math.min(1, gateGain + attackStep)
        : Math.max(floorGain, gateGain - releaseStep);
      samples[i] = s * gateGain;
    }

    return samples;
  }

  function processExpanderGateOffline(left, right, params = {}, sampleRate = 48000) {
    const outL = new Float32Array(left);
    const outR = right ? new Float32Array(right) : null;
    const opts = {
      hysteresisDb: params.hysteresisDb ?? 4,
      attackMs: params.attackMs ?? 4,
      rangeDb: params.rangeDb ?? -18,
      scHpfHz: params.scHpfHz ?? 80
    };
    applyNoiseGateOffline(outL, sampleRate, params.thresholdDb ?? -48, params.holdMs ?? 90, params.releaseMs ?? 220, opts);
    if (outR) {
      applyNoiseGateOffline(outR, sampleRate, params.thresholdDb ?? -48, params.holdMs ?? 90, params.releaseMs ?? 220, opts);
    }
    return { left: outL, right: outR };
  }

  /**
   * True dynamic Split-Band / Wideband Vocal De-Esser.
   * Only reduces gain when sibilance energy inside bandpass exceeds thresholdDb.
   */
  function processDeEsserOffline(left, right, params = {}, sampleRate = 48000) {
    const outL = new Float32Array(left);
    const outR = right ? new Float32Array(right) : null;
    const freqHz = clamp(Number(params.freqHz ?? 6500), 2500, 12000);
    const q = clamp(Number(params.q ?? 3.2), 0.8, 8);
    const thrDb = Number(params.thresholdDb ?? -26);
    const maxCutDb = clamp(Number(params.cutDb ?? 4), 0, 15);
    const attMs = Math.max(0.2, Number(params.attackMs ?? 1.5));
    const relMs = Math.max(10, Number(params.releaseMs ?? 65));
    const wideband = Boolean(params.wideband);
    if (maxCutDb <= 0.01) return { left: outL, right: outR, maxGrDb: 0 };

    const bp = computeBiquadCoeffs("bandpass", freqHz, q, 0, sampleRate);
    let x1L = 0, x2L = 0, y1L = 0, y2L = 0;
    let x1R = 0, x2R = 0, y1R = 0, y2R = 0;
    const attCoeff = Math.exp(-1 / Math.max(1, (sampleRate * attMs) / 1000));
    const relCoeff = Math.exp(-1 / Math.max(1, (sampleRate * relMs) / 1000));
    let env = 0;
    let smoothGain = 1;
    let minGain = 1;

    for (let i = 0; i < outL.length; i++) {
      const sL = outL[i];
      const bpL = bp.b0 * sL + bp.b1 * x1L + bp.b2 * x2L - bp.a1 * y1L - bp.a2 * y2L;
      x2L = x1L; x1L = sL; y2L = y1L; y1L = bpL;

      let bpR = bpL;
      if (outR) {
        const sR = outR[i];
        bpR = bp.b0 * sR + bp.b1 * x1R + bp.b2 * x2R - bp.a1 * y1R - bp.a2 * y2R;
        x2R = x1R; x1R = sR; y2R = y1R; y1R = bpR;
      }

      const sibAbs = Math.max(Math.abs(bpL), Math.abs(bpR));
      const c = sibAbs > env ? attCoeff : relCoeff;
      env = c * env + (1 - c) * sibAbs;
      const sibDb = gainToDb(env);
      const redDb = sibDb > thrDb ? Math.min(maxCutDb, (sibDb - thrDb) * 0.75) : 0;
      const gTarget = dbToGain(-redDb);
      smoothGain = 0.85 * smoothGain + 0.15 * gTarget;
      if (smoothGain < minGain) minGain = smoothGain;

      if (wideband) {
        outL[i] = sL * smoothGain;
        if (outR) outR[i] = outR[i] * smoothGain;
      } else {
        outL[i] = (sL - bpL) + bpL * smoothGain;
        if (outR) outR[i] = (outR[i] - bpR) + bpR * smoothGain;
      }
    }
    return { left: outL, right: outR, maxGrDb: -gainToDb(minGain) };
  }

  /**
   * Nonlinear analog transfer curve for WaveShaperNode (real-time Web Audio) & offline processor.
   * mode === 0 -> Tape symmetric saturation (odd harmonics)
   * mode === 1 -> Tube asymmetric saturation (odd + warm 2nd harmonic)
   * Note: small-signal unity slope normalized by k so level-matched auto-gain stays balanced.
   */
  function buildSaturationCurve(drivePct, mode = 0, biasPct = 10, autoGain = true) {
    const samples = 2048;
    const curve = new Float32Array(samples);
    const driveNorm = clamp(Number(drivePct) || 0, 0, 100) / 100;
    const k = driveNorm * 5.0 + 0.05;
    const bias = mode === 1 ? clamp(Number(biasPct) || 0, 0, 60) / 100 * 0.35 : 0;
    const dcOffset = bias > 0 ? Math.tanh(k * bias) : 0;
    const denom = autoGain ? Math.max(0.05, k * (1 - driveNorm * 0.32)) : Math.max(0.01, Math.tanh(k));

    for (let i = 0; i < samples; i += 1) {
      const x = (i * 2) / (samples - 1) - 1;
      const driven = Math.tanh(k * (x + bias)) - dcOffset;
      curve[i] = clamp(driven / denom, -1.25, 1.25);
    }
    return curve;
  }

  /**
   * 4x Oversampled anti-aliased Tape / Tube Saturation offline processor with DC blocker, tone LPF & auto-gain level matching.
   */
  function processSaturationOffline(left, right, params = {}, sampleRate = 48000) {
    const mode = Number(params.mode) === 1 || params.mode === "tube" ? 1 : 0;
    const drivePct = clamp(Number(params.drive ?? 22), 0, 100);
    const bias = mode === 1 ? clamp(Number(params.bias ?? 10), 0, 60) / 100 * 0.32 : 0;
    const mix = clamp(Number(params.mix ?? 35) / 100, 0, 1);
    const toneHz = clamp(Number(params.toneHz ?? 11000), 2500, 20000);
    const autoGain = params.autoGain !== 0 && params.autoGain !== false;
    const outTrim = dbToGain(clamp(Number(params.outputDb ?? 0), -18, 12));

    const driveNorm = drivePct / 100;
    const k = driveNorm * 5.0 + 0.05;
    const dcOffset = bias > 0 ? Math.tanh(k * bias) : 0;
    // Small-signal unity normalization so RMS tracks input cleanly on A/B bypass
    const normFactor = autoGain ? 1 / Math.max(0.05, k * (1 - driveNorm * 0.32)) : 1 / Math.max(0.05, Math.tanh(k));
    const dcAlpha = Math.exp((-2 * Math.PI * 18) / sampleRate);
    const lpCoeff = computeBiquadCoeffs("lowpass", toneHz, 0.7071, 0, sampleRate);
    const aaAlpha = Math.exp((-2 * Math.PI * (sampleRate * 0.42)) / (sampleRate * 4));

    function shapeChannel(src) {
      const out = new Float32Array(src.length);
      let prev = 0;
      let aa = 0;
      let hpPrev = 0, hpOut = 0;
      for (let i = 0; i < src.length; i++) {
        const cur = src[i];
        let acc = 0;
        for (let s = 1; s <= 4; s++) {
          const interp = prev + (cur - prev) * (s * 0.25);
          const sat = (Math.tanh(k * (interp + bias)) - dcOffset) * normFactor;
          aa = (1 - aaAlpha) * sat + aaAlpha * aa;
          acc = aa;
        }
        prev = cur;
        hpOut = dcAlpha * (hpOut + acc - hpPrev);
        hpPrev = acc;
        out[i] = (cur * (1 - mix) + hpOut * mix) * outTrim;
      }
      applyBiquadInPlace(out, lpCoeff);
      return out;
    }

    return {
      left: shapeChannel(left),
      right: right ? shapeChannel(right) : null
    };
  }

  function processReverbOffline(left, right, params = {}, sampleRate = 48000) {
    const sr = Number(sampleRate) || 48000;
    const inL = left;
    const inR = right || left;
    const len = inL.length;
    const wetPct = clamp(Number(params.wet ?? 16), 0, 100);
    const wetGain = (wetPct / 100) * 0.85;
    const dryGain = 1 - (wetPct / 100) * 0.25;

    let irL, irR;
    if (params.customIrData && Array.isArray(params.customIrData.left) && params.customIrData.left.length > 0) {
      const cap = Math.min(params.customIrData.left.length, sr * 4);
      irL = new Float32Array(params.customIrData.left.slice(0, cap));
      irR = Array.isArray(params.customIrData.right)
        ? new Float32Array(params.customIrData.right.slice(0, cap))
        : irL;
    } else {
      const mockCtx = {
        sampleRate: sr,
        createBuffer(ch, bLen) {
          const arrs = Array.from({ length: ch }, () => new Float32Array(bLen));
          return { numberOfChannels: ch, length: bLen, getChannelData: (idx) => arrs[idx] };
        }
      };
      const irBuf = buildHallImpulseResponse(mockCtx, params);
      irL = irBuf.getChannelData(0);
      irR = irBuf.getChannelData(1);
    }

    const wetL = new Float32Array(len);
    const wetR = new Float32Array(len);
    const irLen = Math.min(irL.length, sr * 3);
    for (let i = 0; i < len; i++) {
      const sL = inL[i];
      const sR = inR[i];
      if (sL === 0 && sR === 0) continue;
      const limit = Math.min(len - i, irLen);
      for (let k = 0; k < limit; k++) {
        wetL[i + k] += sL * irL[k];
        wetR[i + k] += sR * irR[k];
      }
    }

    const outL = new Float32Array(len);
    const outR = right ? new Float32Array(len) : null;
    for (let i = 0; i < len; i++) {
      outL[i] = inL[i] * dryGain + wetL[i] * wetGain;
      if (outR) outR[i] = inR[i] * dryGain + wetR[i] * wetGain;
    }
    return { left: outL, right: outR };
  }

  function resolveDelayTimesMs(params) {
    const p = params || {};
    let ltMs = Number(p.timeMs ?? 260);
    let rtMs = Number(p.rightTimeMs ?? ltMs);
    const bpm = Number(p.bpm) || 0;
    if (bpm >= 30) {
      const beatMs = 60000 / bpm;
      const subdiv = Number(p.syncSubdiv) || 0;
      const mult = subdiv === 1 ? 0.5 : subdiv === 2 ? 0.75 : subdiv === 3 ? 0.6667 : 1.0;
      ltMs = beatMs * mult;
      rtMs = p.pingPong ? ltMs * 0.75 : ltMs;
    }
    return {
      leftMs: clamp(ltMs, 10, 1900),
      rightMs: clamp(rtMs, 10, 1900)
    };
  }

  function processDelayOffline(left, right, params = {}, sampleRate = 48000) {
    const sr = Number(sampleRate) || 48000;
    const inL = left;
    const inR = right || left;
    const len = inL.length;
    const { leftMs, rightMs } = resolveDelayTimesMs(params);
    const fb = clamp((Number(params.feedback ?? 25)) / 100, 0, 0.85);
    const wetGain = clamp((Number(params.wet ?? 15)) / 100, 0, 0.85);
    const pingPong = Boolean(params.pingPong);
    const widthFactor = clamp((Number(params.stereoWidth ?? 110)) / 100, 0, 1.5);
    const modDepthSamples = clamp(Number(params.modDepthMs ?? 0.6), 0, 3) * (sr / 1000);
    const hpf = computeBiquadCoeffs("highpass", clamp(Number(params.hpfHz ?? 220), 20, 1500), 0.7071, 0, sr);
    const lpf = computeBiquadCoeffs("lowpass", clamp(Number(params.toneHz ?? 4500), 500, 18000), 0.7071, 0, sr);

    const maxDelay = Math.ceil(sr * 2.0) + 16;
    const bufL = new Float32Array(maxDelay);
    const bufR = new Float32Array(maxDelay);
    const baseDelayL = Math.max(1, (leftMs / 1000) * sr);
    const baseDelayR = Math.max(1, (rightMs / 1000) * sr);
    let wIdx = 0;
    let hx1L = 0, hx2L = 0, hy1L = 0, hy2L = 0, lx1L = 0, lx2L = 0, ly1L = 0, ly2L = 0;
    let hx1R = 0, hx2R = 0, hy1R = 0, hy2R = 0, lx1R = 0, lx2R = 0, ly1R = 0, ly2R = 0;

    const outL = new Float32Array(len);
    const outR = right ? new Float32Array(len) : null;

    for (let i = 0; i < len; i++) {
      const mod = modDepthSamples > 0 ? Math.sin((2 * Math.PI * 0.65 * i) / sr) * modDepthSamples : 0;
      const dL = clamp(baseDelayL + mod, 1, maxDelay - 4);
      const dR = clamp(baseDelayR - mod, 1, maxDelay - 4);

      const rpL = (wIdx - dL + maxDelay) % maxDelay;
      const iL0 = Math.floor(rpL);
      const fL = rpL - iL0;
      const tapL = bufL[iL0] * (1 - fL) + bufL[(iL0 + 1) % maxDelay] * fL;

      const rpR = (wIdx - dR + maxDelay) % maxDelay;
      const iR0 = Math.floor(rpR);
      const fR = rpR - iR0;
      const tapR = bufR[iR0] * (1 - fR) + bufR[(iR0 + 1) % maxDelay] * fR;

      // Feedback-loop HPF + LPF damping
      const fhL = hpf.b0 * tapL + hpf.b1 * hx1L + hpf.b2 * hx2L - hpf.a1 * hy1L - hpf.a2 * hy2L;
      hx2L = hx1L; hx1L = tapL; hy2L = hy1L; hy1L = fhL;
      const flL = lpf.b0 * fhL + lpf.b1 * lx1L + lpf.b2 * lx2L - lpf.a1 * ly1L - lpf.a2 * ly2L;
      lx2L = lx1L; lx1L = fhL; ly2L = ly1L; ly1L = flL;

      const fhR = hpf.b0 * tapR + hpf.b1 * hx1R + hpf.b2 * hx2R - hpf.a1 * hy1R - hpf.a2 * hy2R;
      hx2R = hx1R; hx1R = tapR; hy2R = hy1R; hy1R = fhR;
      const flR = lpf.b0 * fhR + lpf.b1 * lx1R + lpf.b2 * lx2R - lpf.a1 * ly1R - lpf.a2 * ly2R;
      lx2R = lx1R; lx1R = fhR; ly2R = ly1R; ly1R = flR;

      if (pingPong) {
        const monoSum = 0.5 * (inL[i] + inR[i]);
        bufL[wIdx] = monoSum + flR * fb;
        bufR[wIdx] = flL * fb;
      } else {
        bufL[wIdx] = inL[i] + flL * fb;
        bufR[wIdx] = inR[i] + flR * fb;
      }
      wIdx = (wIdx + 1) % maxDelay;

      const midW = 0.5 * (tapL + tapR);
      const sideW = 0.5 * (tapL - tapR) * widthFactor;
      outL[i] = inL[i] + (midW + sideW) * wetGain;
      if (outR) outR[i] = inR[i] + (midW - sideW) * wetGain;
    }

    return { left: outL, right: outR };
  }

  function processStereoWidthOffline(left, right, params = {}, sampleRate = 48000) {
    const outL = new Float32Array(left.length);
    const outR = right ? new Float32Array(right.length) : null;
    if (!right) {
      outL.set(left);
      return { left: outL, right: null };
    }
    const width = clamp((Number(params.widthPct ?? 100)) / 100, 0, 1.6);
    const bassMonoHz = clamp(Number(params.bassMonoHz ?? 120), 20, 350);
    const sideHpf = bassMonoHz > 22 ? computeBiquadCoeffs("highpass", bassMonoHz, 0.7071, 0, sampleRate) : null;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;

    for (let i = 0; i < left.length; i++) {
      const mid = 0.5 * (left[i] + right[i]);
      let side = 0.5 * (left[i] - right[i]);
      if (sideHpf) {
        const hp = sideHpf.b0 * side + sideHpf.b1 * x1 + sideHpf.b2 * x2 - sideHpf.a1 * y1 - sideHpf.a2 * y2;
        x2 = x1; x1 = side; y2 = y1; y1 = hp;
        side = hp;
      }
      const scaledSide = side * width;
      outL[i] = mid + scaledSide;
      outR[i] = mid - scaledSide;
    }
    return { left: outL, right: outR };
  }

  function processFxSlotOffline(left, right, slot, sampleRate = 48000) {
    if (!slot || slot.enabled === false) {
      return { left: new Float32Array(left), right: right ? new Float32Array(right) : null };
    }
    const p = slot.params || {};
    let res;
    if (slot.type === "eq") res = processParametricEqOffline(left, right, p, sampleRate);
    else if (slot.type === "filter") res = processFilterOffline(left, right, p, sampleRate);
    else if (slot.type === "compressor") res = processCompressorOffline(left, right, p, sampleRate);
    else if (slot.type === "gate") res = processExpanderGateOffline(left, right, p, sampleRate);
    else if (slot.type === "deesser") res = processDeEsserOffline(left, right, p, sampleRate);
    else if (slot.type === "reverb") res = processReverbOffline(left, right, p, sampleRate);
    else if (slot.type === "delay") res = processDelayOffline(left, right, p, sampleRate);
    else if (slot.type === "saturation") res = processSaturationOffline(left, right, p, sampleRate);
    else if (slot.type === "stereo_width") res = processStereoWidthOffline(left, right, p, sampleRate);
    else if (slot.type === "limiter") res = applyTruePeakLimiterOffline(left, right, Object.assign({ sampleRate }, p));
    else res = { left: new Float32Array(left), right: right ? new Float32Array(right) : null };

    const wetDry = clamp(Number(slot.wetDry ?? 100) / 100, 0, 1);
    if (wetDry >= 0.999) return res;
    const mixL = new Float32Array(left.length);
    const mixR = right && res.right ? new Float32Array(left.length) : null;
    for (let i = 0; i < left.length; i++) {
      mixL[i] = left[i] * (1 - wetDry) + res.left[i] * wetDry;
      if (mixR) mixR[i] = right[i] * (1 - wetDry) + res.right[i] * wetDry;
    }
    return { left: mixL, right: mixR };
  }

  function processFxRackOffline(left, right, fxRack, sampleRate = 48000) {
    let curL = new Float32Array(left);
    let curR = right ? new Float32Array(right) : null;
    const list = Array.isArray(fxRack) ? fxRack : [];
    for (let i = 0; i < list.length; i++) {
      const slot = list[i];
      if (!slot || slot.enabled === false) continue;
      const next = processFxSlotOffline(curL, curR, slot, sampleRate);
      curL = next.left;
      curR = next.right;
    }
    return { left: curL, right: curR };
  }

  /* ===================== 4x True-Peak Measurement & Lookahead Limiter ===================== */

  /**
   * Measures ITU-R BS.1770-4 4x oversampled True Peak across mono or stereo arrays (in dBTP).
   */
  function measureTruePeakDb(left, right) {
    if (!left || !left.length) return -Infinity;
    let maxPeak = 0;

    function scanChannel(arr) {
      const len = arr.length;
      for (let i = 0; i < len; i++) {
        const absDirect = Math.abs(arr[i]);
        if (absDirect > maxPeak) maxPeak = absDirect;
        if (i >= 5 && i + 6 < len) {
          for (let p = 0; p < 4; p++) {
            const k = BS1770_PHASES[p];
            let acc = 0;
            for (let t = 0; t < 12; t++) {
              acc += arr[i - 5 + t] * k[t];
            }
            const a = Math.abs(acc);
            if (a > maxPeak) maxPeak = a;
          }
        }
      }
    }

    scanChannel(left);
    if (right) scanChannel(right);
    return gainToDb(maxPeak);
  }

  /**
   * Stereo-linked Lookahead True-Peak Brickwall Limiter (no harsh sample clipping).
   */
  function applyTruePeakLimiterOffline(left, right, opts = {}) {
    const ceilingDb = clamp(Number(opts.ceilingDb ?? -1.0), -12, 0);
    const thresholdDb = Number(opts.thresholdDb ?? ceilingDb);
    const lookaheadMs = clamp(Number(opts.lookaheadMs ?? 2.5), 0.5, 10);
    const releaseMs = clamp(Number(opts.releaseMs ?? 80), 10, 500);
    const sampleRate = Number(opts.sampleRate) || 48000;

    const ceilLin = dbToGain(ceilingDb);
    const driveGain = thresholdDb < ceilingDb ? dbToGain(ceilingDb - thresholdDb) : 1;
    const lookSamples = Math.max(1, Math.round((sampleRate * lookaheadMs) / 1000));
    const relCoeff = Math.exp(-1 / Math.max(1, (sampleRate * releaseMs) / 1000));

    const len = left.length;
    const outL = new Float32Array(len);
    const outR = right ? new Float32Array(len) : null;
    const envBuf = new Float32Array(len);

    // 1. Estimate local 4x BS.1770-4 true peak + required gain reduction per sample
    const safeCeil = ceilLin * 0.96; // -0.35 dB inter-sample envelope headroom
    for (let i = 0; i < len; i++) {
      let pk = Math.abs(left[i] * driveGain);
      if (right) {
        const r = Math.abs(right[i] * driveGain);
        if (r > pk) pk = r;
      }
      if (i >= 5 && i + 6 < len) {
        for (let p = 0; p < 4; p++) {
          const k = BS1770_PHASES[p];
          let accL = 0;
          let accR = 0;
          for (let t = 0; t < 12; t++) {
            accL += left[i - 5 + t] * k[t];
            if (right) accR += right[i - 5 + t] * k[t];
          }
          const tpL = Math.abs(accL * driveGain);
          if (tpL > pk) pk = tpL;
          if (right) {
            const tpR = Math.abs(accR * driveGain);
            if (tpR > pk) pk = tpR;
          }
        }
      }
      envBuf[i] = pk > safeCeil ? safeCeil / pk : 1;
    }

    // 2. Lookahead pre-attack ramp (pull future gain dips backward cleanly across lookSamples)
    let holdMin = 1;
    for (let i = len - 1; i >= 0; i--) {
      if (envBuf[i] < holdMin) {
        holdMin = envBuf[i];
      } else {
        holdMin += (1 - holdMin) / Math.max(2, lookSamples * 0.55);
      }
      envBuf[i] = Math.min(envBuf[i], holdMin);
    }

    // 3. Smooth release pass & apply gain with zero hard-clip distortion
    let g = 1;
    let minGainApplied = 1;
    let limiterEngaged = false;
    for (let i = 0; i < len; i++) {
      const target = envBuf[i];
      g = target < g ? target : relCoeff * g + (1 - relCoeff) * target;
      if (g < 0.999) limiterEngaged = true;
      if (g < minGainApplied) minGainApplied = g;

      outL[i] = left[i] * driveGain * g;
      if (outR) outR[i] = right[i] * driveGain * g;
    }

    let measuredTp = measureTruePeakDb(outL, outR);
    if (measuredTp > ceilingDb && Number.isFinite(measuredTp)) {
      const trim = dbToGain(ceilingDb - 0.02 - measuredTp);
      for (let i = 0; i < len; i++) {
        outL[i] *= trim;
        if (outR) outR[i] *= trim;
      }
      minGainApplied *= trim;
      limiterEngaged = true;
      measuredTp = measureTruePeakDb(outL, outR);
    }

    return {
      left: outL,
      right: outR,
      limiterEngaged,
      maxGrDb: -gainToDb(minGainApplied),
      truePeakDb: measuredTp
    };
  }

  /* ===================== ITU-R BS.1770-4 Loudness Suite ===================== */

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
    const stage2 = createBiquad(1, -2, 1, a0hp, 2 * (Khp * Khp - 1), 1 - Khp / Qhp + Khp * Khp);
    return { stage1, stage2 };
  }

  function kWeightChannel(samples, biquads) {
    const out = new Float32Array(samples.length);
    out.set(samples);
    applyBiquadInPlace(out, biquads.stage1);
    applyBiquadInPlace(out, biquads.stage2);
    return out;
  }

  function measureIntegratedLufs(left, right, sampleRate) {
    const full = analyzeLoudnessFull(left, right, sampleRate);
    return full.integratedLufs;
  }

  function analyzeLoudnessFull(left, right, sampleRate = 48000) {
    if (!left || !left.length) {
      return {
        integratedLufs: -Infinity,
        shortTermMaxLufs: -Infinity,
        momentaryMaxLufs: -Infinity,
        loudnessRangeLu: 0,
        samplePeakDb: -Infinity,
        truePeakDb: -Infinity,
        rmsDb: -Infinity
      };
    }

    const sr = Number(sampleRate) || 48000;
    const chR = right && right.length === left.length ? right : null;

    let maxPeak = 0;
    let sumSqTotal = 0;
    for (let i = 0; i < left.length; i += 1) {
      const sL = left[i];
      const aL = Math.abs(sL);
      if (aL > maxPeak) maxPeak = aL;
      sumSqTotal += sL * sL;
      if (chR) {
        const sR = chR[i];
        const aR = Math.abs(sR);
        if (aR > maxPeak) maxPeak = aR;
        sumSqTotal += sR * sR;
      }
    }
    if (maxPeak === 0) {
      return {
        integratedLufs: -Infinity,
        shortTermMaxLufs: -Infinity,
        momentaryMaxLufs: -Infinity,
        loudnessRangeLu: 0,
        samplePeakDb: -Infinity,
        truePeakDb: -Infinity,
        rmsDb: -Infinity
      };
    }

    const samplePeakDb = gainToDb(maxPeak);
    const truePeakDb = measureTruePeakDb(left, chR);
    const rmsDb = gainToDb(Math.sqrt(sumSqTotal / (left.length * (chR ? 2 : 1))));

    const biquads = getKWeightingBiquads(sr);
    const kwL = kWeightChannel(left, biquads);
    const kwR = chR ? kWeightChannel(chR, biquads) : kwL;

    const momSamples = Math.max(1, Math.round(sr * 0.4));
    const stepSamples = Math.max(1, Math.round(sr * 0.1));
    const momEnergies = [];

    if (kwL.length < momSamples) {
      let sum = 0;
      for (let i = 0; i < kwL.length; i++) sum += kwL[i] * kwL[i] + kwR[i] * kwR[i];
      momEnergies.push(sum / kwL.length);
    } else {
      for (let start = 0; start + momSamples <= kwL.length; start += stepSamples) {
        let sum = 0;
        const end = start + momSamples;
        for (let i = start; i < end; i++) sum += kwL[i] * kwL[i] + kwR[i] * kwR[i];
        momEnergies.push(sum / momSamples);
      }
    }

    let momentaryMaxLufs = -Infinity;
    const absGateEnergies = [];
    for (let i = 0; i < momEnergies.length; i++) {
      const e = momEnergies[i];
      const lufs = e > 0 ? -0.691 + 10 * Math.log10(e) : -Infinity;
      if (lufs > momentaryMaxLufs) momentaryMaxLufs = lufs;
      if (e > 0 && lufs > -70) absGateEnergies.push(e);
    }

    let integratedLufs = -Infinity;
    if (absGateEnergies.length > 0) {
      let absMean = 0;
      for (let i = 0; i < absGateEnergies.length; i++) absMean += absGateEnergies[i];
      absMean /= absGateEnergies.length;
      const relThreshold = -0.691 + 10 * Math.log10(absMean) - 10;
      const relGateEnergies = absGateEnergies.filter((e) => -0.691 + 10 * Math.log10(e) > relThreshold);
      const finalSet = relGateEnergies.length ? relGateEnergies : absGateEnergies;
      let finalMean = 0;
      for (let i = 0; i < finalSet.length; i++) finalMean += finalSet[i];
      integratedLufs = -0.691 + 10 * Math.log10(finalMean / finalSet.length);
    }

    // Short-Term (3.0s window) & LRA (EBU R128)
    const stSamples = Math.max(1, Math.round(sr * 3.0));
    const stLufsList = [];
    if (kwL.length >= stSamples) {
      for (let start = 0; start + stSamples <= kwL.length; start += stepSamples) {
        let sum = 0;
        const end = start + stSamples;
        for (let i = start; i < end; i++) sum += kwL[i] * kwL[i] + kwR[i] * kwR[i];
        const lufs = sum > 0 ? -0.691 + 10 * Math.log10(sum / stSamples) : -Infinity;
        if (lufs > -70) stLufsList.push(lufs);
      }
    } else if (Number.isFinite(integratedLufs)) {
      stLufsList.push(integratedLufs);
    }

    const shortTermMaxLufs = stLufsList.length ? Math.max(...stLufsList) : momentaryMaxLufs;
    let loudnessRangeLu = 0;
    if (stLufsList.length >= 2) {
      const sorted = stLufsList.filter((v) => v > integratedLufs - 20).sort((a, b) => a - b);
      if (sorted.length >= 2) {
        const lowIdx = Math.floor(0.1 * (sorted.length - 1));
        const highIdx = Math.floor(0.95 * (sorted.length - 1));
        loudnessRangeLu = Math.max(0, sorted[highIdx] - sorted[lowIdx]);
      }
    }

    return {
      integratedLufs,
      shortTermMaxLufs,
      momentaryMaxLufs,
      loudnessRangeLu,
      samplePeakDb,
      truePeakDb,
      rmsDb
    };
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

  const MASTERING_DELIVERY_PROFILES = {
    streaming_14: { id: "streaming_14", label: "-14 LUFS · Streaming (Spotify / YouTube / R2)", targetLufs: -14, ceilingDb: -1.0, maxGrDb: 6.0 },
    podcast_16: { id: "podcast_16", label: "-16 LUFS · Devotional / Apple / Podcast", targetLufs: -16, ceilingDb: -1.0, maxGrDb: 5.0 },
    dynamic_18: { id: "dynamic_18", label: "-18 LUFS · Dynamic Acoustic Satsang", targetLufs: -18, ceilingDb: -1.0, maxGrDb: 4.0 },
    broadcast_23: { id: "broadcast_23", label: "-23 LUFS · EBU R128 Broadcast", targetLufs: -23, ceilingDb: -1.0, maxGrDb: 4.0 },
    custom: { id: "custom", label: "Custom Target LUFS & Ceiling", targetLufs: -14, ceilingDb: -1.0, maxGrDb: 6.0 },
    off: { id: "off", label: "Off (Ceiling Safety Only · Preserve Mix)", targetLufs: null, ceilingDb: -1.0, maxGrDb: 6.0 }
  };

  function evaluateNormalizationSafety(preStats, opts = {}) {
    const targetLufs = opts.targetLufs;
    const ceilingDb = opts.ceilingDb !== undefined ? Number(opts.ceilingDb) : -1.0;
    const maxAllowedGrDb = opts.maxAllowedGrDb !== undefined ? Number(opts.maxAllowedGrDb) : 6.0;
    if (!preStats || !Number.isFinite(preStats.integratedLufs) || targetLufs == null || !Number.isFinite(Number(targetLufs))) {
      return {
        canReachTargetCleanly: true,
        requestedGainDb: 0,
        safeGainDb: 0,
        projectedGrDb: 0,
        gainCapped: false,
        advisory: "Mix level preserved with True-Peak ceiling protection."
      };
    }
    const requestedGainDb = clamp(Number(targetLufs) - preStats.integratedLufs, -24, 24);
    const srcPeak = Number.isFinite(preStats.truePeakDb)
      ? preStats.truePeakDb
      : (Number.isFinite(preStats.samplePeakDb) ? preStats.samplePeakDb : -12);
    const projectedTruePeakDb = srcPeak + requestedGainDb;
    const projectedGrDb = Math.max(0, projectedTruePeakDb - ceilingDb);
    if (projectedGrDb > maxAllowedGrDb) {
      const safeGainDb = clamp((ceilingDb + maxAllowedGrDb) - srcPeak, -24, requestedGainDb);
      return {
        canReachTargetCleanly: false,
        requestedGainDb,
        safeGainDb,
        projectedGrDb,
        gainCapped: true,
        advisory: `Gain capped at ${safeGainDb >= 0 ? "+" : ""}${safeGainDb.toFixed(1)} dB (target ${targetLufs} LUFS would require ${projectedGrDb.toFixed(1)} dB limiting and crush dynamics).`
      };
    }
    return {
      canReachTargetCleanly: true,
      requestedGainDb,
      safeGainDb: requestedGainDb,
      projectedGrDb,
      gainCapped: false,
      advisory: `Target ${targetLufs} LUFS reachable cleanly (est. ${projectedGrDb.toFixed(1)} dB peak limiting).`
    };
  }

  function normalizeToTargetLufs(left, right, opts) {
    const options = opts || {};
    const targetLufs = options.targetLufs !== undefined ? Number(options.targetLufs) : -14;
    const ceilingDb = options.ceilingDb !== undefined ? Number(options.ceilingDb) : -1.0;
    const sampleRate = Number(options.sampleRate) || 48000;

    const preStats = analyzeLoudnessFull(left, right, sampleRate);
    const inputLufs = preStats.integratedLufs;
    if (!Number.isFinite(inputLufs)) {
      return {
        left,
        right,
        inputLufs: -Infinity,
        outputLufs: -Infinity,
        gainDb: 0,
        requestedGainDb: 0,
        gainCapped: false,
        safetyAdvisory: "Silent input; no gain applied.",
        peakDb: -Infinity,
        truePeakDb: -Infinity,
        limiterEngaged: false,
        maxGrDb: 0,
        excessiveLimitingWarning: false,
        preLoudnessReport: preStats,
        loudnessReport: preStats
      };
    }

    const safety = evaluateNormalizationSafety(preStats, {
      targetLufs,
      ceilingDb,
      maxAllowedGrDb: options.maxAllowedGrDb ?? 6.0
    });
    const protectDynamics = options.protectDynamics !== false;
    const gainDb = protectDynamics ? safety.safeGainDb : safety.requestedGainDb;
    const linearGain = dbToGain(gainDb);

    // Pre-gain before Lookahead True-Peak Limiter
    for (let i = 0; i < left.length; i += 1) {
      left[i] *= linearGain;
      if (right) right[i] *= linearGain;
    }

    const limRes = applyTruePeakLimiterOffline(left, right, {
      ceilingDb,
      lookaheadMs: options.lookaheadMs ?? 2.5,
      releaseMs: options.releaseMs ?? 80,
      sampleRate
    });

    left.set(limRes.left);
    if (right && limRes.right) {
      right.set(limRes.right);
    }

    const postStats = analyzeLoudnessFull(left, right, sampleRate);
    return {
      left,
      right,
      inputLufs,
      outputLufs: postStats.integratedLufs,
      gainDb,
      requestedGainDb: safety.requestedGainDb,
      gainCapped: Boolean(protectDynamics && safety.gainCapped),
      safetyAdvisory: safety.advisory,
      peakDb: measurePeakDb(left, right),
      truePeakDb: postStats.truePeakDb,
      limiterEngaged: limRes.limiterEngaged,
      maxGrDb: limRes.maxGrDb,
      excessiveLimitingWarning: limRes.maxGrDb > 6.0,
      preLoudnessReport: preStats,
      loudnessReport: postStats
    };
  }

  function computeRackTailSeconds(tracks = [], masterTrack = null) {
    let tail = 0;
    const scanRack = (rack) => {
      if (!Array.isArray(rack)) return;
      for (let i = 0; i < rack.length; i += 1) {
        const s = rack[i];
        if (!s || s.enabled === false) continue;
        const p = s.params || {};
        if (s.type === "reverb") {
          const d = clamp(Number(p.decay) || 1.5, 0.35, 4.5);
          const pre = clamp(Number(p.preDelayMs) || 0, 0, 200) / 1000;
          tail = Math.max(tail, d + pre + 0.35);
        } else if (s.type === "delay") {
          const maxMs = Math.max(Number(p.timeMs) || 260, Number(p.rightTimeMs) || 260);
          const fb = clamp((Number(p.feedback) || 25) / 100, 0.05, 0.85);
          const rings = Math.min(20, Math.max(1, Math.ceil(Math.log(0.001) / Math.log(fb))));
          tail = Math.max(tail, Math.min(4.5, (maxMs / 1000) * rings));
        }
      }
    };
    (Array.isArray(tracks) ? tracks : []).forEach((tr) => {
      if (tr && !tr.mute) scanRack(tr.fxRack);
    });
    if (masterTrack) scanRack(masterTrack.fxRack);
    return Math.round(clamp(tail, 0, 5.0) * 100) / 100;
  }

  function applyBiquadStateful(arr, coeff, st) {
    const { b0, b1, b2, a1, a2 } = coeff;
    let { x1, x2, y1, y2 } = st;
    for (let i = 0; i < arr.length; i += 1) {
      const x0 = arr[i];
      const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x0; y2 = y1; y1 = y0;
      arr[i] = y0;
    }
    st.x1 = x1; st.x2 = x2; st.y1 = y1; st.y2 = y2;
  }

  /**
   * Stateful chunked offline mastering processor preserving IIR/FIR/dynamics/reverb/delay state
   * across chunk boundaries without discontinuities or unbounded RAM use.
   */
  function createStatefulMasterProcessor({ masterRack = [], inputTrimDb = 0, sampleRate = 48000 } = {}) {
    const sr = Number(sampleRate) || 48000;
    const trimGain = dbToGain(clamp(Number(inputTrimDb) || 0, -24, 24));
    const list = Array.isArray(masterRack) ? masterRack : [];
    const slotStates = list.map((slot) => {
      if (!slot || slot.enabled === false) return null;
      const p = slot.params || {};
      const stateObj = { slot, type: slot.type, p, wetDry: clamp(Number(slot.wetDry ?? 100) / 100, 0, 1) };
      if (slot.type === "eq") {
        if (Number(p.linearPhase) === 1) {
          const kernel = buildLinearPhaseEqKernel(p, sr, 513);
          stateObj.kernel = kernel;
          stateObj.olaL = new Float32Array(kernel.length - 1);
          stateObj.olaR = new Float32Array(kernel.length - 1);
        } else {
          stateObj.stages = buildEqStages(p, sr).map((c) => ({
            c,
            L: { x1: 0, x2: 0, y1: 0, y2: 0 },
            R: { x1: 0, x2: 0, y1: 0, y2: 0 }
          }));
        }
      } else if (slot.type === "filter") {
        const hpfHz = Number(p.hpfHz) || 20;
        const lpfHz = Number(p.lpfHz) || 20000;
        const q = clamp(Number(p.q) || 0.7071, 0.3, 8);
        const coeffs = [];
        if (hpfHz > 22) {
          const cH = computeBiquadCoeffs("highpass", hpfHz, q, 0, sr);
          coeffs.push(cH);
          if (Number(p.slope) === 24) coeffs.push(cH);
        }
        if (lpfHz < 19500) {
          const cL = computeBiquadCoeffs("lowpass", lpfHz, q, 0, sr);
          coeffs.push(cL);
          if (Number(p.slope) === 24) coeffs.push(cL);
        }
        stateObj.stages = coeffs.map((c) => ({
          c,
          L: { x1: 0, x2: 0, y1: 0, y2: 0 },
          R: { x1: 0, x2: 0, y1: 0, y2: 0 }
        }));
      } else if (slot.type === "compressor") {
        stateObj.scCoeff = computeBiquadCoeffs("highpass", Number(p.scHpfHz ?? 60), 0.7071, 0, sr);
        stateObj.scL = { x1: 0, x2: 0, y1: 0, y2: 0 };
        stateObj.scR = { x1: 0, x2: 0, y1: 0, y2: 0 };
        stateObj.envSq = 0;
        stateObj.smoothGrDb = 0;
      } else if (slot.type === "gate") {
        const scHz = Number(p.scHpfHz ?? 80);
        stateObj.scHpf = scHz > 22 ? computeBiquadCoeffs("highpass", scHz, 0.7071, 0, sr) : null;
        stateObj.chL = { x1: 0, x2: 0, y1: 0, y2: 0, env: 0, hold: 0, gain: 1, open: false };
        stateObj.chR = { x1: 0, x2: 0, y1: 0, y2: 0, env: 0, hold: 0, gain: 1, open: false };
      } else if (slot.type === "deesser") {
        const freqHz = clamp(Number(p.freqHz ?? 6500), 2500, 12000);
        const q = clamp(Number(p.q ?? 3.2), 0.8, 8);
        stateObj.bp = computeBiquadCoeffs("bandpass", freqHz, q, 0, sr);
        stateObj.bpL = { x1: 0, x2: 0, y1: 0, y2: 0 };
        stateObj.bpR = { x1: 0, x2: 0, y1: 0, y2: 0 };
        stateObj.env = 0;
        stateObj.smoothGain = 1;
      } else if (slot.type === "saturation") {
        stateObj.lp = computeBiquadCoeffs("lowpass", clamp(Number(p.toneHz ?? 11000), 2500, 20000), 0.7071, 0, sr);
        stateObj.lpL = { x1: 0, x2: 0, y1: 0, y2: 0 };
        stateObj.lpR = { x1: 0, x2: 0, y1: 0, y2: 0 };
        stateObj.sL = { prev: 0, aa: 0, hpPrev: 0, hpOut: 0 };
        stateObj.sR = { prev: 0, aa: 0, hpPrev: 0, hpOut: 0 };
      } else if (slot.type === "stereo_width") {
        const bassMonoHz = clamp(Number(p.bassMonoHz ?? 120), 20, 350);
        stateObj.sideHpf = bassMonoHz > 22 ? computeBiquadCoeffs("highpass", bassMonoHz, 0.7071, 0, sr) : null;
        stateObj.sideSt = { x1: 0, x2: 0, y1: 0, y2: 0 };
      } else if (slot.type === "reverb") {
        let irL, irR;
        if (p.customIrData && Array.isArray(p.customIrData.left) && p.customIrData.left.length > 0) {
          const cap = Math.min(p.customIrData.left.length, sr * 4);
          irL = new Float32Array(p.customIrData.left.slice(0, cap));
          irR = Array.isArray(p.customIrData.right)
            ? new Float32Array(p.customIrData.right.slice(0, cap))
            : irL;
        } else {
          const mockCtx = {
            sampleRate: sr,
            createBuffer(ch, bLen) {
              const arrs = Array.from({ length: ch }, () => new Float32Array(bLen));
              return { numberOfChannels: ch, length: bLen, getChannelData: (idx) => arrs[idx] };
            }
          };
          const irBuf = buildHallImpulseResponse(mockCtx, p);
          irL = irBuf.getChannelData(0);
          irR = irBuf.getChannelData(1);
        }
        const irLen = Math.min(irL.length, sr * 3);
        stateObj.irL = irL.subarray(0, irLen);
        stateObj.irR = irR.subarray(0, irLen);
        stateObj.tailL = new Float32Array(irLen);
        stateObj.tailR = new Float32Array(irLen);
      } else if (slot.type === "delay") {
        const maxDelay = Math.ceil(sr * 2.0) + 16;
        stateObj.bufL = new Float32Array(maxDelay);
        stateObj.bufR = new Float32Array(maxDelay);
        stateObj.maxDelay = maxDelay;
        stateObj.wIdx = 0;
        stateObj.sampleIdx = 0;
        stateObj.hpf = computeBiquadCoeffs("highpass", clamp(Number(p.hpfHz ?? 220), 20, 1500), 0.7071, 0, sr);
        stateObj.lpf = computeBiquadCoeffs("lowpass", clamp(Number(p.toneHz ?? 4500), 500, 18000), 0.7071, 0, sr);
        stateObj.hL = { x1: 0, x2: 0, y1: 0, y2: 0 };
        stateObj.lL = { x1: 0, x2: 0, y1: 0, y2: 0 };
        stateObj.hR = { x1: 0, x2: 0, y1: 0, y2: 0 };
        stateObj.lR = { x1: 0, x2: 0, y1: 0, y2: 0 };
      }
      return stateObj;
    });

    function runSlotStateful(st, inL, inR) {
      const len = inL.length;
      const outL = new Float32Array(inL);
      const outR = inR ? new Float32Array(inR) : null;
      const p = st.p;

      if (st.type === "eq" && st.kernel) {
        const kernel = st.kernel;
        const kLen = kernel.length;
        const convL = new Float32Array(len + kLen - 1);
        convL.set(st.olaL.subarray(0, Math.min(st.olaL.length, convL.length)), 0);
        for (let i = 0; i < len; i += 1) {
          const x = inL[i];
          if (x === 0) continue;
          for (let k = 0; k < kLen; k += 1) convL[i + k] += x * kernel[k];
        }
        outL.set(convL.subarray(0, len));
        st.olaL.fill(0);
        st.olaL.set(convL.subarray(len, Math.min(convL.length, len + kLen - 1)));
        if (outR) {
          const convR = new Float32Array(len + kLen - 1);
          convR.set(st.olaR.subarray(0, Math.min(st.olaR.length, convR.length)), 0);
          for (let i = 0; i < len; i += 1) {
            const x = inR[i];
            if (x === 0) continue;
            for (let k = 0; k < kLen; k += 1) convR[i + k] += x * kernel[k];
          }
          outR.set(convR.subarray(0, len));
          st.olaR.fill(0);
          st.olaR.set(convR.subarray(len, Math.min(convR.length, len + kLen - 1)));
        }
      } else if ((st.type === "eq" || st.type === "filter") && st.stages) {
        for (let s = 0; s < st.stages.length; s += 1) {
          applyBiquadStateful(outL, st.stages[s].c, st.stages[s].L);
          if (outR) applyBiquadStateful(outR, st.stages[s].c, st.stages[s].R);
        }
      } else if (st.type === "compressor") {
        const thr = Number(p.threshold ?? -18);
        const ratio = Math.max(1, Number(p.ratio ?? 3.5));
        const knee = Math.max(0, Number(p.knee ?? 10));
        const attMs = Math.max(0.5, Number(p.attackMs ?? 8));
        const relMs = Math.max(10, Number(p.releaseMs ?? 180));
        const makeup = dbToGain(Number(p.makeupDb ?? 0));
        const peakMode = Boolean(p.peakMode || p.detection === "peak");
        const mix = clamp(Number(p.mix ?? 100) / 100, 0, 1);
        const attCoeff = Math.exp(-1 / Math.max(1, (sr * attMs) / 1000));
        const relCoeff = Math.exp(-1 / Math.max(1, (sr * relMs) / 1000));
        const sc = st.scCoeff;
        for (let i = 0; i < len; i += 1) {
          const rawL = outL[i];
          const rawR = outR ? outR[i] : rawL;
          const scLv = sc.b0 * rawL + sc.b1 * st.scL.x1 + sc.b2 * st.scL.x2 - sc.a1 * st.scL.y1 - sc.a2 * st.scL.y2;
          st.scL.x2 = st.scL.x1; st.scL.x1 = rawL; st.scL.y2 = st.scL.y1; st.scL.y1 = scLv;
          let scRv = scLv;
          if (outR) {
            scRv = sc.b0 * rawR + sc.b1 * st.scR.x1 + sc.b2 * st.scR.x2 - sc.a1 * st.scR.y1 - sc.a2 * st.scR.y2;
            st.scR.x2 = st.scR.x1; st.scR.x1 = rawR; st.scR.y2 = st.scR.y1; st.scR.y1 = scRv;
          }
          if (peakMode) {
            const pkSq = Math.max(scLv * scLv, scRv * scRv);
            st.envSq = pkSq > st.envSq ? pkSq : relCoeff * st.envSq + (1 - relCoeff) * pkSq;
          } else {
            const energy = 0.5 * (scLv * scLv + scRv * scRv);
            const c = energy > st.envSq ? attCoeff : relCoeff;
            st.envSq = c * st.envSq + (1 - c) * energy;
          }
          const envDb = gainToDb(Math.sqrt(Math.max(1e-12, st.envSq)));
          let targetGr = 0;
          if (knee > 0 && Math.abs(envDb - thr) <= knee * 0.5) {
            const d = envDb - thr + knee * 0.5;
            targetGr = ((1 - 1 / ratio) * d * d) / (2 * knee);
          } else if (envDb > thr) {
            targetGr = (envDb - thr) * (1 - 1 / ratio);
          }
          st.smoothGrDb = 0.8 * st.smoothGrDb + 0.2 * targetGr;
          const wg = dbToGain(-st.smoothGrDb) * makeup;
          outL[i] = rawL * (1 - mix) + rawL * wg * mix;
          if (outR) outR[i] = rawR * (1 - mix) + rawR * wg * mix;
        }
      } else if (st.type === "gate") {
        const openLin = dbToGain(Number(p.thresholdDb ?? -48));
        const closeLin = dbToGain(Number(p.thresholdDb ?? -48) - Math.max(0, Number(p.hysteresisDb ?? 4)));
        const holdSamp = Math.max(1, Math.round((sr * (p.holdMs ?? 90)) / 1000));
        const floorG = dbToGain(Math.min(0, Number(p.rangeDb ?? -18)));
        const attStep = 1 / Math.max(1, Math.round((sr * (p.attackMs ?? 4)) / 1000));
        const relStep = (1 - floorG) / Math.max(1, Math.round((sr * (p.releaseMs ?? 220)) / 1000));
        const envCoeff = Math.exp(-1 / Math.max(1, Math.round(sr * 0.008)));
        const runGateCh = (arr, gst) => {
          for (let i = 0; i < len; i += 1) {
            const s = arr[i];
            let det = s;
            if (st.scHpf) {
              const h = st.scHpf;
              det = h.b0 * s + h.b1 * gst.x1 + h.b2 * gst.x2 - h.a1 * gst.y1 - h.a2 * gst.y2;
              gst.x2 = gst.x1; gst.x1 = s; gst.y2 = gst.y1; gst.y1 = det;
            }
            const av = Math.abs(det);
            gst.env = av > gst.env ? av : gst.env * envCoeff + av * (1 - envCoeff);
            if (gst.env >= openLin) { gst.open = true; gst.hold = holdSamp; }
            else if (gst.hold > 0) gst.hold -= 1;
            else if (gst.env < closeLin) gst.open = false;
            gst.gain = gst.open ? Math.min(1, gst.gain + attStep) : Math.max(floorG, gst.gain - relStep);
            arr[i] = s * gst.gain;
          }
        };
        runGateCh(outL, st.chL);
        if (outR) runGateCh(outR, st.chR);
      } else if (st.type === "deesser") {
        const thrDb = Number(p.thresholdDb ?? -26);
        const maxCutDb = clamp(Number(p.cutDb ?? 4), 0, 15);
        const attC = Math.exp(-1 / Math.max(1, (sr * Math.max(0.2, Number(p.attackMs ?? 1.5))) / 1000));
        const relC = Math.exp(-1 / Math.max(1, (sr * Math.max(10, Number(p.releaseMs ?? 65))) / 1000));
        const wideband = Boolean(p.wideband);
        const bp = st.bp;
        for (let i = 0; i < len; i += 1) {
          const sL = outL[i];
          const bpLv = bp.b0 * sL + bp.b1 * st.bpL.x1 + bp.b2 * st.bpL.x2 - bp.a1 * st.bpL.y1 - bp.a2 * st.bpL.y2;
          st.bpL.x2 = st.bpL.x1; st.bpL.x1 = sL; st.bpL.y2 = st.bpL.y1; st.bpL.y1 = bpLv;
          let bpRv = bpLv;
          if (outR) {
            const sR = outR[i];
            bpRv = bp.b0 * sR + bp.b1 * st.bpR.x1 + bp.b2 * st.bpR.x2 - bp.a1 * st.bpR.y1 - bp.a2 * st.bpR.y2;
            st.bpR.x2 = st.bpR.x1; st.bpR.x1 = sR; st.bpR.y2 = st.bpR.y1; st.bpR.y1 = bpRv;
          }
          const sibAbs = Math.max(Math.abs(bpLv), Math.abs(bpRv));
          const c = sibAbs > st.env ? attC : relC;
          st.env = c * st.env + (1 - c) * sibAbs;
          const sibDb = gainToDb(st.env);
          const redDb = sibDb > thrDb ? Math.min(maxCutDb, (sibDb - thrDb) * 0.75) : 0;
          st.smoothGain = 0.85 * st.smoothGain + 0.15 * dbToGain(-redDb);
          if (wideband) {
            outL[i] = sL * st.smoothGain;
            if (outR) outR[i] = outR[i] * st.smoothGain;
          } else {
            outL[i] = (sL - bpLv) + bpLv * st.smoothGain;
            if (outR) outR[i] = (outR[i] - bpRv) + bpRv * st.smoothGain;
          }
        }
      } else if (st.type === "saturation") {
        const mode = Number(p.mode) === 1 || p.mode === "tube" ? 1 : 0;
        const driveNorm = clamp(Number(p.drive ?? 22), 0, 100) / 100;
        const bias = mode === 1 ? clamp(Number(p.bias ?? 10), 0, 60) / 100 * 0.32 : 0;
        const mix = clamp(Number(p.mix ?? 35) / 100, 0, 1);
        const autoGain = p.autoGain !== 0 && p.autoGain !== false;
        const outTrim = dbToGain(clamp(Number(p.outputDb ?? 0), -18, 12));
        const k = driveNorm * 5.0 + 0.05;
        const dcOff = bias > 0 ? Math.tanh(k * bias) : 0;
        const normF = autoGain ? 1 / Math.max(0.05, k * (1 - driveNorm * 0.32)) : 1 / Math.max(0.05, Math.tanh(k));
        const dcAlpha = Math.exp((-2 * Math.PI * 18) / sr);
        const aaAlpha = Math.exp((-2 * Math.PI * (sr * 0.42)) / (sr * 4));
        const shapeCh = (arr, sst, lpSt) => {
          for (let i = 0; i < len; i += 1) {
            const cur = arr[i];
            let acc = 0;
            for (let s = 1; s <= 4; s += 1) {
              const interp = sst.prev + (cur - sst.prev) * (s * 0.25);
              const sat = (Math.tanh(k * (interp + bias)) - dcOff) * normF;
              sst.aa = (1 - aaAlpha) * sat + aaAlpha * sst.aa;
              acc = sst.aa;
            }
            sst.prev = cur;
            sst.hpOut = dcAlpha * (sst.hpOut + acc - sst.hpPrev);
            sst.hpPrev = acc;
            arr[i] = (cur * (1 - mix) + sst.hpOut * mix) * outTrim;
          }
          applyBiquadStateful(arr, st.lp, lpSt);
        };
        shapeCh(outL, st.sL, st.lpL);
        if (outR) shapeCh(outR, st.sR, st.lpR);
      } else if (st.type === "stereo_width" && outR) {
        const width = clamp((Number(p.widthPct ?? 100)) / 100, 0, 1.6);
        const h = st.sideHpf;
        const sst = st.sideSt;
        for (let i = 0; i < len; i += 1) {
          const mid = 0.5 * (outL[i] + outR[i]);
          let side = 0.5 * (outL[i] - outR[i]);
          if (h) {
            const hp = h.b0 * side + h.b1 * sst.x1 + h.b2 * sst.x2 - h.a1 * sst.y1 - h.a2 * sst.y2;
            sst.x2 = sst.x1; sst.x1 = side; sst.y2 = sst.y1; sst.y1 = hp;
            side = hp;
          }
          outL[i] = mid + side * width;
          outR[i] = mid - side * width;
        }
      } else if (st.type === "reverb") {
        const wetPct = clamp(Number(p.wet ?? 16), 0, 100);
        const wetGain = (wetPct / 100) * 0.85;
        const dryGain = 1 - (wetPct / 100) * 0.25;
        const irL = st.irL;
        const irR = st.irR;
        const irLen = irL.length;
        const convL = new Float32Array(len + irLen);
        const convR = new Float32Array(len + irLen);
        convL.set(st.tailL, 0);
        convR.set(st.tailR, 0);
        for (let i = 0; i < len; i += 1) {
          const sL = inL[i];
          const sR = inR ? inR[i] : sL;
          if (sL === 0 && sR === 0) continue;
          for (let k = 0; k < irLen; k += 1) {
            convL[i + k] += sL * irL[k];
            convR[i + k] += sR * irR[k];
          }
        }
        for (let i = 0; i < len; i += 1) {
          outL[i] = inL[i] * dryGain + convL[i] * wetGain;
          if (outR) outR[i] = inR[i] * dryGain + convR[i] * wetGain;
        }
        st.tailL.set(convL.subarray(len, len + irLen));
        st.tailR.set(convR.subarray(len, len + irLen));
      } else if (st.type === "delay") {
        const { leftMs, rightMs } = resolveDelayTimesMs(p);
        const fb = clamp((Number(p.feedback ?? 25)) / 100, 0, 0.85);
        const wetGain = clamp((Number(p.wet ?? 15)) / 100, 0, 0.85);
        const pingPong = Boolean(p.pingPong);
        const widthFactor = clamp((Number(p.stereoWidth ?? 110)) / 100, 0, 1.5);
        const modDepthSamp = clamp(Number(p.modDepthMs ?? 0.6), 0, 3) * (sr / 1000);
        const baseDL = Math.max(1, (leftMs / 1000) * sr);
        const baseDR = Math.max(1, (rightMs / 1000) * sr);
        const md = st.maxDelay;
        const stepBq = (v, c, s) => {
          const y = c.b0 * v + c.b1 * s.x1 + c.b2 * s.x2 - c.a1 * s.y1 - c.a2 * s.y2;
          s.x2 = s.x1; s.x1 = v; s.y2 = s.y1; s.y1 = y;
          return y;
        };
        for (let i = 0; i < len; i += 1) {
          const mod = modDepthSamp > 0 ? Math.sin((2 * Math.PI * 0.65 * st.sampleIdx) / sr) * modDepthSamp : 0;
          st.sampleIdx += 1;
          const dL = clamp(baseDL + mod, 1, md - 4);
          const dR = clamp(baseDR - mod, 1, md - 4);
          const rpL = (st.wIdx - dL + md) % md;
          const iL0 = Math.floor(rpL);
          const tapL = st.bufL[iL0] * (1 - (rpL - iL0)) + st.bufL[(iL0 + 1) % md] * (rpL - iL0);
          const rpR = (st.wIdx - dR + md) % md;
          const iR0 = Math.floor(rpR);
          const tapR = st.bufR[iR0] * (1 - (rpR - iR0)) + st.bufR[(iR0 + 1) % md] * (rpR - iR0);
          const flL = stepBq(stepBq(tapL, st.hpf, st.hL), st.lpf, st.lL);
          const flR = stepBq(stepBq(tapR, st.hpf, st.hR), st.lpf, st.lR);
          const sL = inL[i];
          const sR = inR ? inR[i] : sL;
          if (pingPong) {
            st.bufL[st.wIdx] = 0.5 * (sL + sR) + flR * fb;
            st.bufR[st.wIdx] = flL * fb;
          } else {
            st.bufL[st.wIdx] = sL + flL * fb;
            st.bufR[st.wIdx] = sR + flR * fb;
          }
          st.wIdx = (st.wIdx + 1) % md;
          const midW = 0.5 * (tapL + tapR);
          const sideW = 0.5 * (tapL - tapR) * widthFactor;
          outL[i] = sL + (midW + sideW) * wetGain;
          if (outR) outR[i] = sR + (midW - sideW) * wetGain;
        }
      } else if (st.type === "limiter") {
        const limRes = applyTruePeakLimiterOffline(outL, outR, Object.assign({ sampleRate: sr }, p));
        outL.set(limRes.left);
        if (outR && limRes.right) outR.set(limRes.right);
      }

      if (st.wetDry < 0.999) {
        const wd = st.wetDry;
        for (let i = 0; i < len; i += 1) {
          outL[i] = inL[i] * (1 - wd) + outL[i] * wd;
          if (outR) outR[i] = inR[i] * (1 - wd) + outR[i] * wd;
        }
      }
      return { left: outL, right: outR };
    }

    return {
      processChunk(chunkL, chunkR) {
        let curL = new Float32Array(chunkL.length);
        let curR = chunkR ? new Float32Array(chunkR.length) : null;
        for (let i = 0; i < chunkL.length; i += 1) {
          curL[i] = chunkL[i] * trimGain;
          if (curR) curR[i] = chunkR[i] * trimGain;
        }
        for (let s = 0; s < slotStates.length; s += 1) {
          if (!slotStates[s]) continue;
          const next = runSlotStateful(slotStates[s], curL, curR);
          curL = next.left;
          curR = next.right;
        }
        return { left: curL, right: curR };
      }
    };
  }

  /* ===================== Web Audio Node Graph Builders ===================== */

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
    const def = FX_CATALOG[slot.type] || { defaultParams: {} };
    let params = Object.assign({}, def.defaultParams || {}, slot.params || {});
    let wetDryPct = slot.wetDry != null ? clamp(Number(slot.wetDry), 0, 100) : 100;

    function syncBypass(instant) {
      const mixFrac = enabled ? wetDryPct / 100 : 0;
      setParam(dryBypass.gain, 1 - mixFrac, ctx, instant);
      setParam(wetActive.gain, mixFrac, ctx, instant);
    }

    let updateImpl = function () { };
    let meterReader = null;
    const automationTargets = {
      wetActiveGain: wetActive.gain,
      dryBypassGain: dryBypass.gain
    };

    if (slot.type === "eq") {
      const hpf1 = ctx.createBiquadFilter(); hpf1.type = "highpass"; hpf1.Q.value = 0.707;
      const hpf2 = ctx.createBiquadFilter(); hpf2.type = "highpass"; hpf2.Q.value = 0.707;
      const lpf = ctx.createBiquadFilter(); lpf.type = "lowpass"; lpf.Q.value = 0.707;
      const b80 = ctx.createBiquadFilter(); b80.type = "lowshelf";
      const b250 = ctx.createBiquadFilter(); b250.type = "peaking";
      const b1k = ctx.createBiquadFilter(); b1k.type = "peaking";
      const b3k5 = ctx.createBiquadFilter(); b3k5.type = "peaking";
      const b10k = ctx.createBiquadFilter(); b10k.type = "highshelf";
      Object.assign(automationTargets, {
        eqLowGain: b80.gain,
        eqLowMidGain: b250.gain,
        eqMidGain: b1k.gain,
        eqPresenceGain: b3k5.gain,
        eqHighGain: b10k.gain
      });
      const minPhaseGain = ctx.createGain();
      const linPhaseGain = ctx.createGain();
      const linConv = typeof ctx.createConvolver === "function" ? ctx.createConvolver() : null;
      if (linConv) {
        linConv.normalize = false;
        slotIn.connect(linConv).connect(linPhaseGain).connect(wetActive);
      }
      slotIn.connect(hpf1).connect(hpf2).connect(lpf).connect(b80).connect(b250).connect(b1k).connect(b3k5).connect(b10k).connect(minPhaseGain).connect(wetActive);
      let lastLinSig = "";
      updateImpl = function (p, instant) {
        const useLin = Boolean(linConv && Number(p.linearPhase) === 1);
        setParam(minPhaseGain.gain, useLin ? 0 : 1, ctx, instant);
        setParam(linPhaseGain.gain, useLin ? 1 : 0, ctx, instant);
        if (useLin && linConv) {
          const sig = [
            p.hpfHz, p.hpfSlope, p.lpfHz, p.b80, p.f80, p.q80, p.b250, p.f250, p.q250,
            p.b1k, p.f1k, p.q1k, p.b3k5, p.f3k5, p.q3k5, p.b10k, p.f10k, p.q10k,
            p.on1, p.on2, p.on3, p.on4, p.on5
          ].join("|");
          if (sig !== lastLinSig) {
            linConv.buffer = buildLinearPhaseEqImpulseResponse(ctx, p, 513);
            lastLinSig = sig;
          }
        }
        const hFreq = clamp(Number(p.hpfHz) || 20, 20, 400);
        setParam(hpf1.frequency, hFreq, ctx, instant);
        setParam(hpf2.frequency, Number(p.hpfSlope) === 24 && hFreq > 22 ? hFreq : 10, ctx, instant);
        setParam(lpf.frequency, clamp(Number(p.lpfHz) || 20000, 1500, 22000), ctx, instant);
        setParam(b80.frequency, clamp(Number(p.f80) || 80, 30, 300), ctx, instant);
        setParam(b80.gain, p.on1 === 0 ? 0 : clamp(Number(p.b80) || 0, -18, 18), ctx, instant);
        setParam(b250.frequency, clamp(Number(p.f250) || 250, 80, 900), ctx, instant);
        setParam(b250.Q, clamp(Number(p.q250) || 1.2, 0.3, 8), ctx, instant);
        setParam(b250.gain, p.on2 === 0 ? 0 : clamp(Number(p.b250) || 0, -18, 18), ctx, instant);
        setParam(b1k.frequency, clamp(Number(p.f1k) || 1000, 300, 3500), ctx, instant);
        setParam(b1k.Q, clamp(Number(p.q1k) || 1.0, 0.3, 8), ctx, instant);
        setParam(b1k.gain, p.on3 === 0 ? 0 : clamp(Number(p.b1k) || 0, -18, 18), ctx, instant);
        setParam(b3k5.frequency, clamp(Number(p.f3k5) || 3500, 1200, 8000), ctx, instant);
        setParam(b3k5.Q, clamp(Number(p.q3k5) || 1.2, 0.3, 8), ctx, instant);
        setParam(b3k5.gain, p.on4 === 0 ? 0 : clamp(Number(p.b3k5) || 0, -18, 18), ctx, instant);
        setParam(b10k.frequency, clamp(Number(p.f10k) || 10000, 4500, 18000), ctx, instant);
        setParam(b10k.gain, p.on5 === 0 ? 0 : clamp(Number(p.b10k) || 0, -18, 18), ctx, instant);
      };
    } else if (slot.type === "filter") {
      const hpf1 = ctx.createBiquadFilter(); hpf1.type = "highpass";
      const hpf2 = ctx.createBiquadFilter(); hpf2.type = "highpass";
      const lpf1 = ctx.createBiquadFilter(); lpf1.type = "lowpass";
      const lpf2 = ctx.createBiquadFilter(); lpf2.type = "lowpass";
      slotIn.connect(hpf1).connect(hpf2).connect(lpf1).connect(lpf2).connect(wetActive);
      updateImpl = function (p, instant) {
        const qVal = clamp(Number(p.q) || 0.707, 0.3, 8);
        const hFreq = clamp(Number(p.hpfHz) || 80, 20, 2000);
        const lFreq = clamp(Number(p.lpfHz) || 18000, 500, 22000);
        setParam(hpf1.frequency, hFreq, ctx, instant);
        setParam(hpf1.Q, qVal, ctx, instant);
        setParam(hpf2.frequency, Number(p.slope) === 24 ? hFreq : 10, ctx, instant);
        setParam(hpf2.Q, 0.707, ctx, instant);
        setParam(lpf1.frequency, lFreq, ctx, instant);
        setParam(lpf1.Q, qVal, ctx, instant);
        setParam(lpf2.frequency, Number(p.slope) === 24 ? lFreq : 22000, ctx, instant);
        setParam(lpf2.Q, 0.707, ctx, instant);
      };
    } else if (slot.type === "compressor") {
      const scHpf = ctx.createBiquadFilter(); scHpf.type = "highpass";
      const comp = ctx.createDynamicsCompressor();
      const makeup = ctx.createGain();
      const dryComp = ctx.createGain();
      const wetComp = ctx.createGain();
      Object.assign(automationTargets, {
        compThreshold: comp.threshold,
        compMakeupGain: makeup.gain
      });
      slotIn.connect(dryComp).connect(wetActive);
      slotIn.connect(scHpf).connect(comp).connect(makeup).connect(wetComp).connect(wetActive);
      meterReader = () => Number(comp.reduction) || 0;
      updateImpl = function (p, instant) {
        setParam(scHpf.frequency, clamp(Number(p.scHpfHz ?? 60), 20, 300), ctx, instant);
        setParam(comp.threshold, clamp(Number(p.threshold ?? -18), -60, 0), ctx, instant);
        setParam(comp.ratio, clamp(Number(p.ratio) || 3.5, 1, 20), ctx, instant);
        setParam(comp.knee, clamp(Number(p.knee ?? 10), 0, 40), ctx, instant);
        setParam(comp.attack, clamp((Number(p.attackMs) || 8) / 1000, 0.001, 0.5), ctx, instant);
        setParam(comp.release, clamp((Number(p.releaseMs) || 180) / 1000, 0.01, 1.0), ctx, instant);
        setParam(makeup.gain, dbToGain(clamp(Number(p.makeupDb) || 0, -18, 18)), ctx, instant);
        const m = clamp(Number(p.mix ?? 100) / 100, 0, 1);
        setParam(dryComp.gain, 1 - m, ctx, instant);
        setParam(wetComp.gain, m, ctx, instant);
      };
    } else if (slot.type === "gate") {
      let proNode = null;
      if (!isOffline && typeof AudioWorkletNode === "function") {
        try {
          proNode = new AudioWorkletNode(ctx, "bp-pro-dsp", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
          slotIn.connect(proNode).connect(wetActive);
        } catch (_) {
          proNode = null;
        }
      }
      if (!proNode) slotIn.connect(wetActive);
      updateImpl = function (p) {
        if (proNode && proNode.port) {
          proNode.port.postMessage({
            type: "params",
            params: {
              gateEnabled: true,
              gateThresholdDb: Number(p.thresholdDb ?? -48),
              gateHysteresisDb: Number(p.hysteresisDb ?? 4),
              gateAttackMs: Number(p.attackMs ?? 4),
              gateHoldMs: Number(p.holdMs ?? 90),
              gateReleaseMs: Number(p.releaseMs ?? 220),
              gateRangeDb: Number(p.rangeDb ?? -18),
              gateScHpfHz: Number(p.scHpfHz ?? 80)
            }
          });
        }
      };
    } else if (slot.type === "deesser") {
      let proNode = null;
      if (!isOffline && typeof AudioWorkletNode === "function") {
        try {
          proNode = new AudioWorkletNode(ctx, "bp-pro-dsp", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
          slotIn.connect(proNode).connect(wetActive);
        } catch (_) {
          proNode = null;
        }
      }
      if (!proNode) {
        const bp = ctx.createBiquadFilter(); bp.type = "bandpass";
        const notch = ctx.createBiquadFilter(); notch.type = "notch";
        const sibilanceComp = ctx.createDynamicsCompressor();
        sibilanceComp.attack.value = 0.002;
        sibilanceComp.release.value = 0.065;
        sibilanceComp.knee.value = 4;
        const sibOut = ctx.createGain();
        slotIn.connect(notch).connect(wetActive);
        slotIn.connect(bp).connect(sibilanceComp).connect(sibOut).connect(wetActive);
        meterReader = () => Number(sibilanceComp.reduction) || 0;
        updateImpl = function (p, instant) {
          const f = clamp(Number(p.freqHz) || 6500, 2500, 12000);
          const qVal = clamp(Number(p.q) || 3.2, 0.8, 8);
          setParam(bp.frequency, f, ctx, instant);
          setParam(bp.Q, qVal, ctx, instant);
          setParam(notch.frequency, f, ctx, instant);
          setParam(notch.Q, qVal, ctx, instant);
          setParam(sibilanceComp.threshold, clamp(Number(p.thresholdDb ?? -26), -50, 0), ctx, instant);
          const ratioFromCut = 1 + clamp(Number(p.cutDb ?? 4), 0, 15) * 0.65;
          setParam(sibilanceComp.ratio, ratioFromCut, ctx, instant);
          setParam(sibilanceComp.attack, clamp((Number(p.attackMs ?? 1.5)) / 1000, 0.0005, 0.05), ctx, instant);
          setParam(sibilanceComp.release, clamp((Number(p.releaseMs ?? 65)) / 1000, 0.01, 0.3), ctx, instant);
        };
      } else {
        let lastGr = 0;
        if (proNode.port) {
          proNode.port.onmessage = (ev) => {
            if (ev.data && ev.data.type === "dsp-meters") lastGr = Number(ev.data.deesserGrDb) || 0;
          };
        }
        meterReader = () => lastGr;
        updateImpl = function (p) {
          proNode.port.postMessage({
            type: "params",
            params: {
              deessEnabled: true,
              deessFreqHz: Number(p.freqHz ?? 6500),
              deessQ: Number(p.q ?? 3.2),
              deessThresholdDb: Number(p.thresholdDb ?? -26),
              deessReductionDb: Number(p.cutDb ?? 4),
              deessWideband: Boolean(p.wideband)
            }
          });
        };
      }
    } else if (slot.type === "reverb") {
      const dry = ctx.createGain();
      const send = ctx.createGain();
      const conv = ctx.createConvolver();
      const tone = ctx.createBiquadFilter(); tone.type = "lowpass";
      const ret = ctx.createGain();
      Object.assign(automationTargets, {
        reverbReturnGain: ret.gain,
        reverbDryGain: dry.gain
      });
      slotIn.connect(dry).connect(wetActive);
      slotIn.connect(send).connect(conv).connect(tone).connect(ret).connect(wetActive);
      let lastSig = "";
      updateImpl = function (p, instant) {
        const wetPct = clamp(Number(p.wet) || 0, 0, 100);
        const customKey = p.customIrData && Array.isArray(p.customIrData.left) ? `${p.customIrName || "ir"}:${p.customIrData.left.length}` : "";
        const sig = customKey || [
          p.decay ?? 1.5, p.preDelayMs ?? 22, p.roomSize ?? 65,
          p.toneHz ?? 7800, p.lfDampHz ?? 180, p.earlyLevel ?? 45, p.stereoWidth ?? 110
        ].join("|");
        if (sig !== lastSig) {
          if (slot.customIrBuffer) {
            conv.buffer = slot.customIrBuffer;
          } else if (p.customIrData && Array.isArray(p.customIrData.left) && p.customIrData.left.length > 0) {
            const irSr = Number(p.customIrData.sampleRate) || ctx.sampleRate || 48000;
            const bLen = p.customIrData.left.length;
            const buf = ctx.createBuffer(2, bLen, irSr);
            buf.getChannelData(0).set(Float32Array.from(p.customIrData.left));
            buf.getChannelData(1).set(Float32Array.from(Array.isArray(p.customIrData.right) ? p.customIrData.right : p.customIrData.left));
            conv.buffer = buf;
          } else {
            conv.buffer = buildHallImpulseResponse(ctx, p);
          }
          lastSig = sig;
        }
        setParam(tone.frequency, clamp(Number(p.toneHz) || 7800, 1200, 20000), ctx, instant);
        setParam(dry.gain, 1 - (wetPct / 100) * 0.25, ctx, instant);
        setParam(ret.gain, (wetPct / 100) * 0.85, ctx, instant);
      };
    } else if (slot.type === "delay") {
      const dry = ctx.createGain();
      const splitter = ctx.createChannelSplitter(2);
      const delL = ctx.createDelay(2.0);
      const delR = ctx.createDelay(2.0);
      const fbL = ctx.createGain();
      const fbR = ctx.createGain();
      const hpfL = ctx.createBiquadFilter(); hpfL.type = "highpass";
      const toneL = ctx.createBiquadFilter(); toneL.type = "lowpass";
      const hpfR = ctx.createBiquadFilter(); hpfR.type = "highpass";
      const toneR = ctx.createBiquadFilter(); toneR.type = "lowpass";
      const wetWidthSplitL = ctx.createGain();
      const wetWidthSplitR = ctx.createGain();
      const merger = ctx.createChannelMerger(2);
      const wetG = ctx.createGain();
      Object.assign(automationTargets, { delayWetGain: wetG.gain });
      const inSumL = ctx.createGain();
      const inSumR = ctx.createGain();
      const fbCrossGain = ctx.createGain();
      let lfoOsc = null;
      let lfoDepth = null;
      if (!isOffline && typeof ctx.createOscillator === "function") {
        try {
          lfoOsc = ctx.createOscillator();
          lfoOsc.frequency.value = 0.65;
          lfoDepth = ctx.createGain();
          lfoDepth.gain.value = 0.0005;
          lfoOsc.connect(lfoDepth);
          lfoDepth.connect(delL.delayTime);
          lfoDepth.connect(delR.delayTime);
          lfoOsc.start();
        } catch (_) {
          lfoOsc = null;
        }
      }

      slotIn.connect(dry).connect(wetActive);
      slotIn.connect(splitter);
      splitter.connect(inSumL, 0);
      splitter.connect(inSumR, 1);
      inSumL.connect(delL).connect(hpfL).connect(toneL);
      inSumR.connect(delR).connect(hpfR).connect(toneR);
      toneL.connect(fbL);
      toneR.connect(fbR);
      toneL.connect(wetWidthSplitL).connect(merger, 0, 0);
      toneR.connect(wetWidthSplitR).connect(merger, 0, 1);
      merger.connect(wetG).connect(wetActive);
      void fbCrossGain;

      let isPingPong = null;
      updateImpl = function (p, instant) {
        const times = resolveDelayTimesMs(p);
        setParam(delL.delayTime, clamp(times.leftMs / 1000, 0.01, 1.9), ctx, instant);
        setParam(delR.delayTime, clamp(times.rightMs / 1000, 0.01, 1.9), ctx, instant);
        const fbAmt = clamp((Number(p.feedback) || 0) / 100, 0, 0.85);
        setParam(fbL.gain, fbAmt, ctx, instant);
        setParam(fbR.gain, fbAmt, ctx, instant);
        setParam(hpfL.frequency, clamp(Number(p.hpfHz) || 220, 20, 1200), ctx, instant);
        setParam(hpfR.frequency, clamp(Number(p.hpfHz) || 220, 20, 1200), ctx, instant);
        setParam(toneL.frequency, clamp(Number(p.toneHz) || 4500, 500, 18000), ctx, instant);
        setParam(toneR.frequency, clamp(Number(p.toneHz) || 4500, 500, 18000), ctx, instant);
        setParam(wetG.gain, clamp((Number(p.wet) || 0) / 100, 0, 0.85), ctx, instant);
        if (lfoDepth) {
          setParam(lfoDepth.gain, clamp(Number(p.modDepthMs ?? 0.6), 0, 3) / 1000, ctx, instant);
        }

        const nextPP = Boolean(p.pingPong);
        if (isPingPong !== nextPP) {
          fbL.disconnect();
          fbR.disconnect();
          if (nextPP) {
            fbL.connect(delR);
            fbR.connect(delL);
          } else {
            fbL.connect(delL);
            fbR.connect(delR);
          }
          isPingPong = nextPP;
        }
      };
    } else if (slot.type === "saturation") {
      const dry = ctx.createGain();
      const dcHpf = ctx.createBiquadFilter(); dcHpf.type = "highpass"; dcHpf.frequency.value = 18;
      const shaper = ctx.createWaveShaper();
      shaper.oversample = "4x";
      const tone = ctx.createBiquadFilter(); tone.type = "lowpass";
      const wetG = ctx.createGain();
      const trim = ctx.createGain();
      slotIn.connect(dry).connect(trim).connect(wetActive);
      slotIn.connect(shaper).connect(dcHpf).connect(tone).connect(wetG).connect(trim);
      let lastSig = "";
      updateImpl = function (p, instant) {
        const d = clamp(Number(p.drive) || 0, 0, 100);
        const mode = Number(p.mode) === 1 ? 1 : 0;
        const bias = clamp(Number(p.bias) || 10, 0, 60);
        const autoGain = p.autoGain !== 0 && p.autoGain !== false;
        const sig = `${d}|${mode}|${bias}|${autoGain ? 1 : 0}`;
        if (sig !== lastSig) {
          shaper.curve = buildSaturationCurve(d, mode, bias, autoGain);
          lastSig = sig;
        }
        setParam(tone.frequency, clamp(Number(p.toneHz) || 11000, 2500, 20000), ctx, instant);
        const m = clamp(Number(p.mix) || 0, 0, 100) / 100;
        setParam(dry.gain, 1 - m, ctx, instant);
        setParam(wetG.gain, m, ctx, instant);
        setParam(trim.gain, dbToGain(clamp(Number(p.outputDb) || 0, -18, 12)), ctx, instant);
      };
    } else if (slot.type === "stereo_width") {
      const split = ctx.createChannelSplitter(2);
      const merge = ctx.createChannelMerger(2);
      const midSum = ctx.createGain(); midSum.gain.value = 0.5;
      const sideHpf = ctx.createBiquadFilter(); sideHpf.type = "highpass"; sideHpf.Q.value = 0.707;
      const sideGainL = ctx.createGain();
      const sideGainR = ctx.createGain();
      const sideNeg = ctx.createGain(); sideNeg.gain.value = -1;
      slotIn.connect(split);
      split.connect(midSum, 0);
      split.connect(midSum, 1);
      midSum.connect(merge, 0, 0);
      midSum.connect(merge, 0, 1);
      split.connect(sideHpf, 0);
      split.connect(sideNeg, 1);
      sideNeg.connect(sideHpf);
      sideHpf.connect(sideGainL);
      sideGainL.connect(merge, 0, 0);
      sideGainL.connect(sideGainR);
      sideGainR.connect(merge, 0, 1);
      merge.connect(wetActive);
      updateImpl = function (p, instant) {
        const w = clamp(Number(p.widthPct ?? 100) / 100, 0, 1.6);
        setParam(sideHpf.frequency, clamp(Number(p.bassMonoHz ?? 120), 20, 350), ctx, instant);
        setParam(sideGainL.gain, 0.5 * w, ctx, instant);
        setParam(sideGainR.gain, -1, ctx, instant);
      };
    } else if (slot.type === "limiter") {
      const driveG = ctx.createGain();
      const lim = ctx.createDynamicsCompressor();
      lim.knee.value = 0;
      lim.ratio.value = 20;
      lim.attack.value = 0.001;
      slotIn.connect(driveG).connect(lim).connect(wetActive);
      meterReader = () => Number(lim.reduction) || 0;
      updateImpl = function (p, instant) {
        const ceil = clamp(Number(p.ceilingDb ?? -1.0), -12, 0);
        const thr = clamp(Number(p.thresholdDb ?? ceil), -18, 0);
        const driveDb = Math.max(0, ceil - thr);
        setParam(driveG.gain, dbToGain(driveDb), ctx, instant);
        setParam(lim.threshold, ceil, ctx, instant);
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
      automationTargets,
      getReductionDb() {
        return meterReader ? meterReader() : 0;
      },
      updateParams(nextParams) {
        params = Object.assign({}, params, nextParams || {});
        updateImpl(params, isOffline);
      },
      setWetDry(pct) {
        wetDryPct = clamp(Number(pct ?? 100), 0, 100);
        syncBypass(isOffline);
      },
      setEnabled(nextEnabled) {
        enabled = Boolean(nextEnabled);
        syncBypass(isOffline);
      }
    };
  }

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
      if (slot.id) slotsMap.set(slot.id, built);
    }
    cursor.connect(output);

    return { input, output, slots: slotsMap };
  }

  /**
   * Total deterministic group-delay latency (in samples) for enabled Linear-Phase FIR EQ slots on a rack.
   */
  function getFxRackLatencySamples(fxRack, sampleRate = 48000) {
    void sampleRate;
    const list = Array.isArray(fxRack) ? fxRack : [];
    let total = 0;
    for (let i = 0; i < list.length; i += 1) {
      const slot = list[i];
      if (!slot || slot.enabled === false) continue;
      if (slot.type === "eq" && Number(slot.params && slot.params.linearPhase) === 1) {
        total += 256; // (513 - 1) / 2 symmetric FIR group delay
      }
    }
    return total;
  }

  const HALL_IR_PRESETS = {};
  Object.keys(FX_CATALOG.reverb.presets).forEach((k) => {
    HALL_IR_PRESETS[k] = Object.assign({ label: FX_CATALOG.reverb.presets[k].label }, FX_CATALOG.reverb.presets[k].params);
  });
  HALL_IR_PRESETS.mandir_warm = Object.assign({ label: "Mandir Warm Hall" }, FX_CATALOG.reverb.presets.medium_prayer_hall.params);

  function buildChannelAndMasterDsp(ctx, cfg) {
    const config = cfg || {};
    const isOffline = typeof OfflineAudioContext !== "undefined" && ctx instanceof OfflineAudioContext;

    const instIn = ctx.createGain();
    const vocalIn = ctx.createGain();
    const stereoIn = ctx.createGain();

    // Post-Trim/EQ/Comp -> Fader -> Pre/Post Send -> Pan -> MixBus
    const instTrim = ctx.createGain();
    const instHpf1 = ctx.createBiquadFilter(); instHpf1.type = "highpass"; instHpf1.Q.value = 0.707;
    const instHpf2 = ctx.createBiquadFilter(); instHpf2.type = "highpass"; instHpf2.Q.value = 0.707;
    const instLpf = ctx.createBiquadFilter(); instLpf.type = "lowpass"; instLpf.Q.value = 0.707;
    const instEqLow = ctx.createBiquadFilter(); instEqLow.type = "lowshelf"; instEqLow.frequency.value = 90;
    const instEqMid = ctx.createBiquadFilter(); instEqMid.type = "peaking"; instEqMid.frequency.value = 450; instEqMid.Q.value = 1.0;
    const instEqHigh = ctx.createBiquadFilter(); instEqHigh.type = "highshelf"; instEqHigh.frequency.value = 4500;
    const instComp = ctx.createDynamicsCompressor(); instComp.knee.value = 8; instComp.attack.value = 0.014; instComp.release.value = 0.18;
    const instGain = ctx.createGain();
    const instMute = ctx.createGain();
    const instPreSend = ctx.createGain();
    const instPostSend = ctx.createGain();
    const instPanner = typeof ctx.createStereoPanner === "function" ? ctx.createStereoPanner() : null;

    const vocalTrim = ctx.createGain();
    const vocalHpf1 = ctx.createBiquadFilter(); vocalHpf1.type = "highpass"; vocalHpf1.Q.value = 0.707;
    const vocalHpf2 = ctx.createBiquadFilter(); vocalHpf2.type = "highpass"; vocalHpf2.Q.value = 0.707;
    const vocalLpf = ctx.createBiquadFilter(); vocalLpf.type = "lowpass"; vocalLpf.Q.value = 0.707;
    const vocalEqLow = ctx.createBiquadFilter(); vocalEqLow.type = "lowshelf"; vocalEqLow.frequency.value = 220;
    const vocalEqMid = ctx.createBiquadFilter(); vocalEqMid.type = "peaking"; vocalEqMid.frequency.value = 3200; vocalEqMid.Q.value = 1.1;
    const vocalDeesser = ctx.createBiquadFilter(); vocalDeesser.type = "peaking"; vocalDeesser.frequency.value = 6500; vocalDeesser.Q.value = 3.2;
    const vocalEqHigh = ctx.createBiquadFilter(); vocalEqHigh.type = "highshelf"; vocalEqHigh.frequency.value = 9000;
    const vocalComp = ctx.createDynamicsCompressor(); vocalComp.knee.value = 10; vocalComp.attack.value = 0.008; vocalComp.release.value = 0.16;
    const vocalGain = ctx.createGain();
    const vocalMute = ctx.createGain();
    const vocalPreSend = ctx.createGain();
    const vocalPostSend = ctx.createGain();
    const vocalPanner = typeof ctx.createStereoPanner === "function" ? ctx.createStereoPanner() : null;

    const mixBus = ctx.createGain();
    const reverbSend = ctx.createGain();
    const convolver = ctx.createConvolver();
    const reverbReturn = ctx.createGain();

    const m80 = ctx.createBiquadFilter(); m80.type = "lowshelf"; m80.frequency.value = 80;
    const m250 = ctx.createBiquadFilter(); m250.type = "peaking"; m250.frequency.value = 250; m250.Q.value = 1.0;
    const m1k = ctx.createBiquadFilter(); m1k.type = "peaking"; m1k.frequency.value = 1000; m1k.Q.value = 0.9;
    const m3k5 = ctx.createBiquadFilter(); m3k5.type = "peaking"; m3k5.frequency.value = 3500; m3k5.Q.value = 1.1;
    const m10k = ctx.createBiquadFilter(); m10k.type = "highshelf"; m10k.frequency.value = 10000;

    const glueComp = ctx.createDynamicsCompressor(); glueComp.knee.value = 12; glueComp.attack.value = 0.02; glueComp.release.value = 0.25;
    const limiter = ctx.createDynamicsCompressor(); limiter.knee.value = 0; limiter.attack.value = 0.001; limiter.release.value = 0.08;
    const masterGain = ctx.createGain();

    const instPostDyn = instIn
      .connect(instTrim)
      .connect(instHpf1)
      .connect(instHpf2)
      .connect(instLpf)
      .connect(instEqLow)
      .connect(instEqMid)
      .connect(instEqHigh)
      .connect(instComp);
    instPostDyn.connect(instPreSend).connect(reverbSend);
    const instPostFader = instPostDyn.connect(instGain).connect(instMute);
    instPostFader.connect(instPostSend).connect(reverbSend);
    if (instPanner) {
      instPostFader.connect(instPanner).connect(mixBus);
    } else {
      instPostFader.connect(mixBus);
    }

    const vocalPostDyn = vocalIn
      .connect(vocalTrim)
      .connect(vocalHpf1)
      .connect(vocalHpf2)
      .connect(vocalLpf)
      .connect(vocalEqLow)
      .connect(vocalEqMid)
      .connect(vocalDeesser)
      .connect(vocalEqHigh)
      .connect(vocalComp);
    vocalPostDyn.connect(vocalPreSend).connect(reverbSend);
    const vocalPostFader = vocalPostDyn.connect(vocalGain).connect(vocalMute);
    vocalPostFader.connect(vocalPostSend).connect(reverbSend);
    if (vocalPanner) {
      vocalPostFader.connect(vocalPanner).connect(mixBus);
    } else {
      vocalPostFader.connect(mixBus);
    }

    reverbSend.connect(convolver).connect(reverbReturn).connect(mixBus);
    stereoIn.connect(mixBus);

    mixBus.connect(m80).connect(m250).connect(m1k).connect(m3k5).connect(m10k).connect(glueComp).connect(limiter).connect(masterGain);

    let lastRevSig = null;

    function updateConfig(nextCfg, instant) {
      const c = nextCfg || {};
      const inst = c.inst || {};
      const vocal = c.vocal || {};
      const reverb = c.reverb || {};
      const master = c.master || {};
      const useInstant = Boolean(instant || isOffline);

      const instPol = inst.polarity ? -1 : 1;
      const instTrimVal = dbToGain(clamp(Number(inst.trimDb) || 0, -18, 18));
      const instHpfHz = inst.eqBypass ? 10 : Math.max(20, Number(inst.hpf) || 45);
      setParam(instTrim.gain, instPol * instTrimVal, ctx, useInstant);
      setParam(instHpf1.frequency, instHpfHz, ctx, useInstant);
      setParam(instHpf2.frequency, (!inst.eqBypass && Number(inst.hpfSlope) === 24) ? instHpfHz : 10, ctx, useInstant);
      setParam(instLpf.frequency, inst.eqBypass ? 22000 : clamp(Number(inst.lpf) || 20000, 1500, 22000), ctx, useInstant);
      setParam(instEqLow.frequency, clamp(Number(inst.lowFreq) || 90, 40, 400), ctx, useInstant);
      setParam(instEqLow.gain, inst.eqBypass ? 0 : (Number(inst.low) || 0), ctx, useInstant);
      setParam(instEqMid.frequency, clamp(Number(inst.midFreq) || 450, 150, 6000), ctx, useInstant);
      setParam(instEqMid.Q, clamp(Number(inst.midQ) || 1.0, 0.3, 8), ctx, useInstant);
      setParam(instEqMid.gain, inst.eqBypass ? 0 : (Number(inst.mid) || 0), ctx, useInstant);
      setParam(instEqHigh.frequency, clamp(Number(inst.highFreq) || 4500, 1500, 16000), ctx, useInstant);
      setParam(instEqHigh.gain, inst.eqBypass ? 0 : (Number(inst.high) || 0), ctx, useInstant);
      setParam(instComp.threshold, inst.comp ? clamp(Number(inst.compThreshDb ?? -16), -40, 0) : 0, ctx, useInstant);
      setParam(instComp.ratio, inst.comp ? clamp(Number(inst.compRatio ?? 2.5), 1, 16) : 1, ctx, useInstant);
      setParam(instComp.attack, clamp((Number(inst.compAttackMs ?? 14)) / 1000, 0.001, 0.2), ctx, useInstant);
      setParam(instComp.release, clamp((Number(inst.compReleaseMs ?? 180)) / 1000, 0.02, 0.8), ctx, useInstant);
      const instMakeup = inst.comp ? dbToGain(clamp(Number(inst.compMakeupDb) || 0, -12, 12)) : 1;
      setParam(instGain.gain, (Number(inst.gain ?? 100) / 100) * instMakeup, ctx, useInstant);
      setParam(instMute.gain, inst.mute ? 0 : 1, ctx, useInstant);
      const instRevAmt = clamp(Number(inst.reverbSend ?? 65) / 100, 0, 1.5);
      setParam(instPreSend.gain, inst.preFaderSend && !inst.mute ? instRevAmt : 0, ctx, useInstant);
      setParam(instPostSend.gain, !inst.preFaderSend ? instRevAmt : 0, ctx, useInstant);
      if (instPanner && instPanner.pan) {
        setParam(instPanner.pan, clamp((Number(inst.pan) || 0) / 100, -1, 1), ctx, useInstant);
      }

      const vocalPol = vocal.polarity ? -1 : 1;
      const vocalTrimVal = dbToGain(clamp(Number(vocal.trimDb) || 0, -18, 18));
      const vocalHpfHz = vocal.eqBypass ? 10 : Math.max(20, Number(vocal.hpf) || 85);
      setParam(vocalTrim.gain, vocalPol * vocalTrimVal, ctx, useInstant);
      setParam(vocalHpf1.frequency, vocalHpfHz, ctx, useInstant);
      setParam(vocalHpf2.frequency, (!vocal.eqBypass && Number(vocal.hpfSlope) === 24) ? vocalHpfHz : 10, ctx, useInstant);
      setParam(vocalLpf.frequency, vocal.eqBypass ? 22000 : clamp(Number(vocal.lpf) || 20000, 1500, 22000), ctx, useInstant);
      setParam(vocalEqLow.frequency, clamp(Number(vocal.lowFreq) || 220, 40, 500), ctx, useInstant);
      setParam(vocalEqLow.gain, vocal.eqBypass ? 0 : (Number(vocal.low) || 0), ctx, useInstant);
      setParam(vocalEqMid.frequency, clamp(Number(vocal.midFreq) || 3200, 200, 8000), ctx, useInstant);
      setParam(vocalEqMid.Q, clamp(Number(vocal.midQ) || 1.1, 0.3, 8), ctx, useInstant);
      setParam(vocalEqMid.gain, vocal.eqBypass ? 0 : (Number(vocal.mid) || 0), ctx, useInstant);
      setParam(vocalDeesser.frequency, clamp(Number(vocal.deessFreq) || 6500, 3500, 11000), ctx, useInstant);
      setParam(vocalDeesser.Q, clamp(Number(vocal.deessQ) || 3.2, 0.8, 8), ctx, useInstant);
      setParam(vocalDeesser.gain, -clamp(Number(vocal.deesser) || 0, 0, 12) * 0.35, ctx, useInstant);
      setParam(vocalEqHigh.frequency, clamp(Number(vocal.highFreq) || 9000, 2500, 18000), ctx, useInstant);
      setParam(vocalEqHigh.gain, vocal.eqBypass ? 0 : (Number(vocal.high) || 0), ctx, useInstant);
      const vocalCompOn = vocal.comp !== false;
      setParam(vocalComp.threshold, vocalCompOn ? clamp(Number(vocal.compThreshDb ?? -18), -40, 0) : 0, ctx, useInstant);
      setParam(vocalComp.ratio, vocalCompOn ? clamp(Number(vocal.compRatio ?? 3.5), 1, 16) : 1, ctx, useInstant);
      setParam(vocalComp.attack, clamp((Number(vocal.compAttackMs ?? 8)) / 1000, 0.001, 0.2), ctx, useInstant);
      setParam(vocalComp.release, clamp((Number(vocal.compReleaseMs ?? 160)) / 1000, 0.02, 0.8), ctx, useInstant);
      const vocalMakeup = vocalCompOn ? dbToGain(clamp(Number(vocal.compMakeupDb) || 0, -12, 12)) : 1;
      setParam(vocalGain.gain, (Number(vocal.gain ?? 112) / 100) * vocalMakeup, ctx, useInstant);
      setParam(vocalMute.gain, vocal.mute ? 0 : 1, ctx, useInstant);
      const vocalRevAmt = clamp(Number(vocal.reverbSend ?? 100) / 100, 0, 1.5);
      setParam(vocalPreSend.gain, vocal.preFaderSend && !vocal.mute ? vocalRevAmt : 0, ctx, useInstant);
      setParam(vocalPostSend.gain, !vocal.preFaderSend ? vocalRevAmt : 0, ctx, useInstant);
      if (vocalPanner && vocalPanner.pan) {
        setParam(vocalPanner.pan, clamp((Number(vocal.pan) || 0) / 100, -1, 1), ctx, useInstant);
      }

      const wetPct = clamp(Number(reverb.wet) || 0, 0, 100);
      setParam(reverbSend.gain, wetPct > 0 ? 1 : 0, ctx, useInstant);
      setParam(reverbReturn.gain, (wetPct / 100) * 0.72, ctx, useInstant);

      const revPreset = reverb.preset && HALL_IR_PRESETS[reverb.preset] ? reverb.preset : "medium_prayer_hall";
      const revSig = [
        revPreset,
        reverb.decay ?? 1.4,
        reverb.preDelayMs ?? 20,
        reverb.toneHz ?? 7600,
        reverb.roomSize ?? 62,
        reverb.stereoWidth ?? 110
      ].join("|");
      if (revSig !== lastRevSig) {
        convolver.buffer = buildHallImpulseResponse(ctx, {
          preset: revPreset,
          decay: clamp(Number(reverb.decay) || 1.4, 0.4, 3.5),
          preDelayMs: reverb.preDelayMs ?? 20,
          toneHz: reverb.toneHz ?? 7600,
          roomSize: reverb.roomSize ?? 62,
          stereoWidth: reverb.stereoWidth ?? 110
        });
        lastRevSig = revSig;
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
      setParam(limiter.threshold, limiterOn ? -1.0 : 0, ctx, useInstant);
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
        instTrim, instHpf1, instHpf2, instLpf, instEqLow, instEqMid, instEqHigh, instComp, instGain, instMute, instPreSend, instPostSend, instPanner,
        vocalTrim, vocalHpf1, vocalHpf2, vocalLpf, vocalEqLow, vocalEqMid, vocalDeesser, vocalEqHigh, vocalComp, vocalGain, vocalMute, vocalPreSend, vocalPostSend, vocalPanner,
        reverbSend, convolver, reverbReturn, mixBus,
        m80, m250, m1k, m3k5, m10k, glueComp, limiter, masterGain
      },
      updateConfig
    };
  }

  /**
   * Compute true RBJ biquad frequency response for a single Console channel strip (Vocal or Instrument).
   * Matches the active channel Web Audio filter chain (including 12/24 dB/oct HPF, LPF, shelves, Mid Q, and active De-Esser GR).
   */
  function computeChannelEqCurvePoints(chConfig, opts) {
    const ch = chConfig || {};
    const options = opts || {};
    const isVocal = options.isVocal !== false;
    const list = Array.isArray(options.freqs) && options.freqs.length ? options.freqs : DEFAULT_FREQ_POINTS;
    const sr = Number(options.sampleRate) || 48000;
    if (ch.eqBypass) {
      return list.map((f) => ({ freq: f, db: 0 }));
    }

    const stages = [];
    const hpfHz = Number(ch.hpf) || 20;
    if (hpfHz > 20) {
      const chHpf = computeBiquadCoeffs("highpass", hpfHz, 0.7071, 0, sr);
      stages.push(chHpf);
      if (Number(ch.hpfSlope) === 24) stages.push(chHpf);
    }
    const lpfHz = Number(ch.lpf) || 20000;
    if (lpfHz < 19500) {
      stages.push(computeBiquadCoeffs("lowpass", lpfHz, 0.7071, 0, sr));
    }

    const lowFreq = Number(ch.lowFreq) || (isVocal ? 220 : 90);
    const midFreq = Number(ch.midFreq) || (isVocal ? 3200 : 450);
    const midQ = Number(ch.midQ) || (isVocal ? 1.1 : 1.0);
    const highFreq = Number(ch.highFreq) || (isVocal ? 9000 : 4500);

    const bands = [
      { type: "lowshelf", freq: lowFreq, q: 0.7071, gain: Number(ch.low) || 0 },
      { type: "peaking", freq: midFreq, q: midQ, gain: Number(ch.mid) || 0 },
      { type: "highshelf", freq: highFreq, q: 0.7071, gain: Number(ch.high) || 0 }
    ];
    for (let i = 0; i < bands.length; i++) {
      if (Math.abs(bands[i].gain) >= 0.01) {
        stages.push(computeBiquadCoeffs(bands[i].type, bands[i].freq, bands[i].q, bands[i].gain, sr));
      }
    }

    const dynDeessDb = Number(options.dynamicDeessGrDb || 0);
    if (isVocal && dynDeessDb < -0.05) {
      stages.push(
        computeBiquadCoeffs(
          "peaking",
          Number(ch.deessFreq) || 6500,
          Number(ch.deessQ) || 3.2,
          clamp(dynDeessDb, -15, 0),
          sr
        )
      );
    }

    return list.map((f) => {
      let totalDb = 0;
      for (let i = 0; i < stages.length; i += 1) {
        totalDb += evalBiquadCoeffDb(stages[i], f, sr);
      }
      return { freq: f, db: Math.round(totalDb * 100) / 100 };
    });
  }

  function computeEqCurvePoints(masterConfig, freqs) {
    const m = masterConfig || {};
    const list = Array.isArray(freqs) && freqs.length ? freqs : DEFAULT_FREQ_POINTS;
    if (m.bypass) {
      return list.map((f) => ({ freq: f, db: 0 }));
    }

    const stages = buildEqStages(m, 48000);

    return list.map((f) => {
      let totalDb = 0;
      for (let i = 0; i < stages.length; i += 1) {
        totalDb += evalBiquadCoeffDb(stages[i], f, 48000);
      }
      return { freq: f, db: Math.round(totalDb * 100) / 100 };
    });
  }

  return {
    DEFAULT_FREQ_POINTS,
    FX_CATALOG,
    HALL_IR_PRESETS,
    DAW_CHAIN_PRESETS,
    createDefaultFxSlot,
    computeBiquadCoeffs,
    evalBiquadCoeffDb,
    buildLinearPhaseEqKernel,
    buildLinearPhaseEqImpulseResponse,
    buildSaturationCurve,
    processParametricEqOffline,
    processLinearPhaseEqOffline,
    processFilterOffline,
    processCompressorOffline,
    processExpanderGateOffline,
    processDeEsserOffline,
    processSaturationOffline,
    processReverbOffline,
    processDelayOffline,
    processStereoWidthOffline,
    processFxSlotOffline,
    processFxRackOffline,
    measureTruePeakDb,
    applyTruePeakLimiterOffline,
    analyzeLoudnessFull,
    MASTERING_DELIVERY_PROFILES,
    evaluateNormalizationSafety,
    computeRackTailSeconds,
    createStatefulMasterProcessor,
    buildModularFxChain,
    getFxRackLatencySamples,
    buildHallImpulseResponse,
    buildChannelAndMasterDsp,
    applyNoiseGateOffline,
    measureIntegratedLufs,
    normalizeToTargetLufs,
    computeEqCurvePoints,
    computeChannelEqCurvePoints
  };
});
