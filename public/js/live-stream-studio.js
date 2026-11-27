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
  let unexportedRecordingGuard = false;
  let refreshGuardOpen = false;
  let bypassUnloadOnce = false;
  let pendingGuardAction = null;
  let historyGuardArmed = false;
  let frozenInertElements = [];

  function triggerStemDownloads(items) {
    if (!Array.isArray(items) || items.length === 0) return false;
    const valid = items.filter((item) => item && item.blob);
    if (valid.length === 0) return false;
    valid.forEach((item, idx) => {
      setTimeout(() => {
        try {
          const url = URL.createObjectURL(item.blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = item.filename || `bhajan-stem-${idx + 1}`;
          a.style.display = "none";
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 15000);
        } catch (_) { }
      }, idx * 180);
    });
    return true;
  }

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

  function normalizeStudioConfig(raw) {
    const src = raw && typeof raw === "object" ? raw : {};
    const inst = src.inst || {};
    const vocal = src.vocal || {};
    const rev = src.reverb || {};
    const mst = src.master || {};
    return {
      mode: src.mode === "stereo" ? "stereo" : "split",
      swapChannels: Boolean(src.swapChannels),
      ch1InputSource: src.ch1InputSource != null ? String(src.ch1InputSource) : (src.swapChannels ? "1" : "0"),
      ch2InputSource: src.ch2InputSource != null ? String(src.ch2InputSource) : (src.swapChannels ? "0" : "1"),
      inst: {
        gain: inst.gain ?? 100,
        trimDb: inst.trimDb ?? 0,
        polarity: Boolean(inst.polarity),
        pan: inst.pan ?? 0,
        mute: Boolean(inst.mute),
        eqBypass: Boolean(inst.eqBypass),
        hpf: inst.hpf ?? 45,
        hpfSlope: Number(inst.hpfSlope) === 24 ? 24 : 12,
        lpf: inst.lpf ?? 20000,
        low: inst.low ?? 1.5,
        mid: inst.mid ?? 0,
        midFreq: inst.midFreq ?? 450,
        midQ: inst.midQ ?? 1.0,
        high: inst.high ?? -1.0,
        comp: Boolean(inst.comp),
        compThreshDb: inst.compThreshDb ?? -16,
        compRatio: inst.compRatio ?? 2.5,
        compAttackMs: inst.compAttackMs ?? 14,
        compReleaseMs: inst.compReleaseMs ?? 180,
        compMakeupDb: inst.compMakeupDb ?? 0.5,
        compPeakMode: Boolean(inst.compPeakMode),
        gate: Boolean(inst.gate),
        gateThreshDb: inst.gateThreshDb ?? -54,
        gateRangeDb: inst.gateRangeDb ?? -12,
        gateHoldMs: inst.gateHoldMs ?? 140,
        reverbSend: inst.reverbSend ?? 65,
        preFaderSend: Boolean(inst.preFaderSend)
      },
      vocal: {
        gain: vocal.gain ?? 112,
        trimDb: vocal.trimDb ?? 0,
        polarity: Boolean(vocal.polarity),
        pan: vocal.pan ?? 0,
        mute: Boolean(vocal.mute),
        eqBypass: Boolean(vocal.eqBypass),
        hpf: vocal.hpf ?? 85,
        hpfSlope: Number(vocal.hpfSlope) === 24 ? 24 : 12,
        lpf: vocal.lpf ?? 20000,
        low: vocal.low ?? 0.5,
        mid: vocal.mid ?? 2.5,
        midFreq: vocal.midFreq ?? 3200,
        midQ: vocal.midQ ?? 1.1,
        high: vocal.high ?? 1.5,
        deesser: vocal.deesser ?? 2.5,
        deessFreq: vocal.deessFreq ?? 6500,
        deessQ: vocal.deessQ ?? 3.2,
        deessThreshDb: vocal.deessThreshDb ?? -26,
        deessWideband: Boolean(vocal.deessWideband),
        comp: vocal.comp !== false,
        compThreshDb: vocal.compThreshDb ?? -18,
        compRatio: vocal.compRatio ?? 3.5,
        compAttackMs: vocal.compAttackMs ?? 8,
        compReleaseMs: vocal.compReleaseMs ?? 160,
        compMakeupDb: vocal.compMakeupDb ?? 1.5,
        compPeakMode: Boolean(vocal.compPeakMode),
        gate: Boolean(vocal.gate),
        gateThreshDb: vocal.gateThreshDb ?? -50,
        gateRangeDb: vocal.gateRangeDb ?? -14,
        gateHoldMs: vocal.gateHoldMs ?? 90,
        reverbSend: vocal.reverbSend ?? 100,
        preFaderSend: Boolean(vocal.preFaderSend)
      },
      reverb: {
        preset: rev.preset || "medium_prayer_hall",
        wet: rev.wet ?? 14,
        decay: rev.decay ?? 1.4,
        preDelayMs: rev.preDelayMs ?? 20,
        toneHz: rev.toneHz ?? 7600,
        roomSize: rev.roomSize ?? 62,
        stereoWidth: rev.stereoWidth ?? 110
      },
      master: {
        b80: mst.b80 ?? 0.5,
        b250: mst.b250 ?? -1.5,
        b1k: mst.b1k ?? 0,
        b3k5: mst.b3k5 ?? 1.5,
        b10k: mst.b10k ?? 1.0,
        glueComp: mst.glueComp !== false,
        limiter: mst.limiter !== false,
        gain: mst.gain ?? 100,
        bypass: Boolean(mst.bypass)
      }
    };
  }

  let activeConfig = normalizeStudioConfig(defaultConfig);
  let soloChannel = null; // null | "inst" | "vocal"
  let broadcastMuted = false;
  let monitorEnabled = false;
  let monitorVolume = 0.8;
  let soundcheckSession = null;
  let activeHardwareCaptureFormat = null;
  let asioSocket = null;
  let bridgeMonitorSocket = null;
  let asioXruns = 0;
  let activeBridgeDevices = [];
  let activeChannelCatalog = [];
  let activeDetectedChannelCount = 0;
  let activeDetectedDeviceName = "";
  let activeDetectedDriverName = "";
  let ch2AutoMutedBySingleCh = false;
  let preferredBridgeDeviceId = "";
  let bridgeStandbyMode = true;
  let lastSentBridgeRouting = "";
  let lastPassiveBridgeProbeAt = 0;
  let lastPinDomRenderAt = 0;
  let inputLearnState = null; // { targetBus: "vocal"|"inst", startedAt: number, streakPin: -1, streakCount: 0, timer: number, callback?: Function }
  const pinNoiseFloorsDb = [];
  const rawMcSubscribers = new Set();
  const livePinLevels = {
    channels: 0,
    peaksDb: [],
    rmsDb: [],
    noiseFloorsDb: [],
    snrDb: [],
    activePins: [],
    corr01: 0,
    duplicatedMono: false,
    standby: true,
    updatedAt: 0
  };
  const pinFloatScratch = new Float32Array(256);

  let customReverbIrBuffer = null;
  let customReverbIrName = "";
  const activeChSubTabs = { vocal: "eq", inst: "eq" };
  let vocalDspMeters = { gateGainDb: 0, deesserGrDb: 0, compGrDb: 0, limiterGrDb: 0 };
  let instDspMeters = { gateGainDb: 0, deesserGrDb: 0, compGrDb: 0, limiterGrDb: 0 };
  let masterDspMeters = { limiterGrDb: 0 };
  const masterTelem = {
    peakL: 0,
    peakR: 0,
    rmsL: 0,
    rmsR: 0,
    truePeak: 0,
    shortTermLufs: -Infinity,
    kwRing: []
  };

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

  // Milestone 1: Multitrack SSD Recording, Auto-Timestamps & Cloudflare R2 Publish
  let capturedTimestamps = [];
  let lastRecordedResult = null;
  let customPublishFile = null;
  let recStatsTimer = null;

  // DSP Nodes
  let nodes = null;
  let monitorAudioEl = null;

  function $(id) {
    return document.getElementById(id);
  }

  let activeProcTab = "vocal";

  function colorWithAlpha(col, alpha) {
    const s = String(col || "").trim();
    if (s.startsWith("#")) {
      const hex = s.slice(1);
      const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
      if (full.length === 6) {
        const r = parseInt(full.slice(0, 2), 16);
        const g = parseInt(full.slice(2, 4), 16);
        const b = parseInt(full.slice(4, 6), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
      }
    }
    const rgbMatch = s.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
    if (rgbMatch) {
      return `rgba(${rgbMatch[1]}, ${rgbMatch[2]}, ${rgbMatch[3]}, ${alpha})`;
    }
    return `rgba(129, 69, 217, ${alpha})`;
  }

  function getStudioPalette() {
    const host = document.querySelector(".ls-studio-wrap") || document.documentElement;
    const cs = window.getComputedStyle(host);
    const v = (name, fb) => (cs.getPropertyValue(name) || "").trim() || fb;
    const rootDark =
      document.documentElement.getAttribute("data-theme") === "dark" ||
      document.documentElement.classList.contains("dark") ||
      Boolean(document.body && (document.body.getAttribute("data-theme") === "dark" || document.body.classList.contains("dark")));
    return {
      isDark: rootDark,
      panel: v("--studio-panel", "#ffffff"),
      border: v("--studio-border", "#dde2ea"),
      canvasBg: v("--studio-canvas-bg", "#0b0d13"),
      grid: v("--studio-grid", "rgba(255, 255, 255, 0.06)"),
      gridZero: v("--studio-grid-zero", "rgba(255, 255, 255, 0.18)"),
      text: v("--studio-text", "#f0f2f7"),
      textSecondary: v("--studio-text-secondary", "#9ba4b8"),
      textMuted: v("--studio-text-muted", "#677185"),
      accent: v("--studio-accent", "#a855f7"),
      accentSecondary: v("--studio-accent-secondary", "#529bff"),
      warn: v("--studio-warn", "#f59e0b"),
      danger: v("--studio-danger", "#f05252"),
      success: v("--studio-success", "#22c55e")
    };
  }

  function prepareHiDpiCanvas(canvas, fallbackW, fallbackH) {
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const cssW = Math.max(120, Math.round(canvas.clientWidth || fallbackW || 420));
    const cssH = Math.max(64, Math.round(canvas.clientHeight || fallbackH || 120));
    const targetW = Math.round(cssW * dpr);
    const targetH = Math.round(cssH * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w: cssW, h: cssH };
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
    box.style.borderColor = isError ? "var(--studio-danger)" : "var(--studio-accent-border)";
    box.style.color = isError ? "var(--studio-danger)" : "var(--studio-text)";
  }

  function dbToLinearGain(db) {
    const n = Number(db) || 0;
    return Math.pow(10, Math.max(-24, Math.min(24, n)) / 20);
  }

  function buildImpulseResponse(ctx, seconds) {
    if (customReverbIrBuffer && customReverbIrBuffer.sampleRate === (ctx && ctx.sampleRate)) {
      return customReverbIrBuffer;
    }
    if (window.LiveStreamDsp && typeof window.LiveStreamDsp.buildHallImpulseResponse === "function") {
      const rev = activeConfig.reverb || {};
      return window.LiveStreamDsp.buildHallImpulseResponse(ctx, {
        decay: seconds,
        preDelayMs: rev.preDelayMs !== undefined ? Number(rev.preDelayMs) : 20,
        preset: rev.preset || "medium_prayer_hall",
        toneHz: rev.toneHz !== undefined ? Number(rev.toneHz) : 7600,
        roomSize: rev.roomSize !== undefined ? Number(rev.roomSize) : 62,
        stereoWidth: rev.stereoWidth !== undefined ? Number(rev.stereoWidth) : 110
      });
    }
    const rate = ctx.sampleRate || 48000;
    const len = Math.max(rate * 0.3, Math.floor(rate * Math.min(3.5, Math.max(0.4, seconds))));
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

  function cleanHardwareDeviceLabel(rawLabel) {
    let txt = String(rawLabel || "").trim();
    if (!txt) return "Audio Input";
    // Strip Chromium USB VID:PID suffix e.g. "(08bb:2902)" before extracting interface name
    txt = txt.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)/ig, "").trim();
    const m = txt.match(/\(([^()]+)\)?\s*$/);
    if (m && m[1]) {
      const inner = m[1].replace(/^\d+\s*-\s*/, "").trim();
      if (inner && !/^\d+$/.test(inner)) return inner;
    }
    return txt.replace(/^\d+\s*-\s*/, "").trim();
  }

  function buildDetectedChannelCatalog(cleanName, detectedChannelCount, pinNames) {
    const total = Math.max(0, Math.floor(Number(detectedChannelCount) || 0));
    if (total <= 0) return [];
    const safeName = cleanHardwareDeviceLabel(cleanName || "Audio Input");
    const pins = Array.isArray(pinNames) ? pinNames : [];
    const catalog = [];
    for (let ch = 0; ch < total; ch++) {
      const code = `${String(ch + 1).padStart(2, "0")}M`;
      const rawPin = pins[ch] ? String(pins[ch]).trim() : "";
      const usablePin = rawPin && !/not connected/i.test(rawPin)
        ? (/\b\d+\s*$/.test(rawPin) ? rawPin : `${rawPin} ${ch + 1}`)
        : `${safeName} ${ch + 1}`;
      catalog.push({ id: String(ch), index: ch, code, label: `[${code}] ${usablePin}`, group: "Mono" });
    }
    const pairs = Math.floor(total / 2);
    for (let p = 0; p < pairs; p++) {
      const c1 = p * 2;
      const c2 = c1 + 1;
      const code = `${String(p + 1).padStart(2, "0")}S`;
      const id = p === 0 ? "stereo" : `stereo:${c1}:${c2}`;
      catalog.push({ id, indices: [c1, c2], code, label: `[${code}] ${safeName} ${c1 + 1}/${c2 + 1}`, group: "Stereo" });
    }
    return catalog;
  }

  function getActiveChannelCatalog() {
    return Array.isArray(activeChannelCatalog) ? activeChannelCatalog : [];
  }

  function emitHardwareCatalogChanged() {
    try {
      window.dispatchEvent(
        new CustomEvent("ls-hardware-catalog-changed", {
          detail: {
            catalog: getActiveChannelCatalog(),
            channelCount: activeDetectedChannelCount,
            deviceName: activeDetectedDeviceName,
            driverName: activeDetectedDriverName
          }
        })
      );
    } catch (_) { }
  }

  function reconcileRoutingWithCatalog(catalog) {
    const list = Array.isArray(catalog) ? catalog : [];
    const monos = list.filter((c) => c.group === "Mono");
    const validIds = new Set(list.map((c) => String(c.id)));
    validIds.add("none");
    if (list.length === 0) return;

    if (!validIds.has(String(activeConfig.ch1InputSource))) {
      activeConfig.ch1InputSource = monos[0] ? String(monos[0].id) : "none";
    }
    if (monos.length === 1) {
      if (String(activeConfig.ch1InputSource) === "1" || String(activeConfig.ch1InputSource).startsWith("stereo")) {
        activeConfig.ch1InputSource = String(monos[0].id);
      }
      if (String(activeConfig.ch2InputSource) !== "0" && String(activeConfig.ch2InputSource) !== "none") {
        activeConfig.ch2InputSource = "none";
        ch2AutoMutedBySingleCh = true;
      }
    } else if (monos.length >= 2) {
      if (ch2AutoMutedBySingleCh && String(activeConfig.ch2InputSource) === "none") {
        activeConfig.ch2InputSource = String(monos[1].id);
        ch2AutoMutedBySingleCh = false;
      } else if (!validIds.has(String(activeConfig.ch2InputSource))) {
        activeConfig.ch2InputSource = String(monos[1].id);
      }
    }
    activeConfig.swapChannels = activeConfig.ch1InputSource === "1" && activeConfig.ch2InputSource === "0";
  }

  function resolvePinIndicesForRoute(spec) {
    const s = String(spec == null ? "none" : spec).trim().toLowerCase();
    if (s === "none" || s === "off" || s === "-1" || !s) return [];
    if (s === "stereo") return [0, 1];
    if (s.startsWith("stereo:")) {
      const parts = s.split(":").slice(1);
      const a = Number(parts[0]);
      const b = Number(parts[1]);
      return [Number.isFinite(a) ? a : 0, Number.isFinite(b) ? b : 1];
    }
    const idx = Number(s);
    return Number.isInteger(idx) && idx >= 0 ? [idx] : [];
  }

  function gainArrayForRoute(spec, totalPins) {
    const n = Math.max(1, Number(totalPins) || 1);
    const gains = new Array(n).fill(0);
    const pins = resolvePinIndicesForRoute(spec).filter((p) => p >= 0 && p < n);
    if (pins.length === 0) return gains;
    const weight = pins.length > 1 ? 1 / pins.length : 1;
    pins.forEach((p) => {
      gains[p] = weight;
    });
    return gains;
  }

  function dispatchBpmcBinaryPacket(buf) {
    if (!(buf instanceof ArrayBuffer) || buf.byteLength < 8) return false;
    const view = new DataView(buf);
    if (
      view.getUint8(0) !== 0x42 ||
      view.getUint8(1) !== 0x50 ||
      view.getUint8(2) !== 0x4d ||
      view.getUint8(3) !== 0x43
    ) {
      return false;
    }
    const numCh = view.getUint16(4, true);
    const nf = view.getUint16(6, true);
    if (numCh <= 0 || nf <= 0 || buf.byteLength < 8 + numCh * nf * 4) return true;
    const channels = new Array(numCh);
    for (let c = 0; c < numCh; c++) {
      channels[c] = new Float32Array(buf, 8 + c * nf * 4, nf);
    }
    rawMcSubscribers.forEach((fn) => {
      try {
        fn({
          channels,
          frames: nf,
          sampleRate: audioCtx ? audioCtx.sampleRate : 48000,
          catalog: getActiveChannelCatalog()
        });
      } catch (_) { }
    });
    return true;
  }

  function syncBridgeMultichannelTap() {
    const enabled = rawMcSubscribers.size > 0;
    const msg = JSON.stringify({ type: "set-multichannel-tap", enabled });
    if (asioSocket && asioSocket.readyState === 1) {
      try { asioSocket.send(msg); } catch (_) { }
    }
    if (bridgeMonitorSocket && bridgeMonitorSocket.readyState === 1) {
      try { bridgeMonitorSocket.send(msg); } catch (_) { }
    } else if (enabled) {
      connectPassiveBridgeMonitor();
    }
  }

  function updateSelectorLiveOptionLabels(sel, forceUpdate) {
    if (!sel) return;
    if (!forceUpdate && document.activeElement === sel) return;
    const peaks = Array.isArray(livePinLevels.peaksDb) ? livePinLevels.peaksDb : [];
    const activeSet = new Set(Array.isArray(livePinLevels.activePins) ? livePinLevels.activePins : []);
    const hasFreshLevels = (Date.now() - livePinLevels.updatedAt) < 2500 && peaks.length > 0;
    Array.from(sel.options).forEach((opt) => {
      const base = opt.dataset.baseLabel || opt.textContent;
      if (!opt.dataset.baseLabel) opt.dataset.baseLabel = base;
      if (!hasFreshLevels || opt.value === "none") {
        if (opt.textContent !== base) opt.textContent = base;
        return;
      }
      const idxs = resolvePinIndicesForRoute(opt.value);
      let maxDb = -96;
      let anyActive = false;
      idxs.forEach((i) => {
        if (i >= 0 && i < peaks.length && peaks[i] > maxDb) maxDb = peaks[i];
        if (activeSet.has(i)) anyActive = true;
      });
      const nextText = anyActive
        ? `${base}  ● LIVE (${maxDb.toFixed(0)} dB)`
        : base;
      if (opt.textContent !== nextText) opt.textContent = nextText;
    });
  }

  function populateSingleInputSelector(sel, catalog, selectedVal) {
    if (!sel) return;
    const valStr = selectedVal != null ? String(selectedVal) : "none";
    const sig = catalog.map((c) => `${c.group}:${c.id}:${c.label}`).join("|");
    if (sel.dataset.catalogSig === sig) {
      if (Array.from(sel.options).some((o) => o.value === valStr) && sel.value !== valStr) {
        sel.value = valStr;
      }
      updateSelectorLiveOptionLabels(sel, false);
      return;
    }

    sel.dataset.catalogSig = sig;
    sel.innerHTML = "";
    const noneOpt = document.createElement("option");
    noneOpt.value = "none";
    noneOpt.textContent = catalog.length === 0 ? "None (Not detected — click Detect)" : "None";
    noneOpt.dataset.baseLabel = noneOpt.textContent;
    sel.appendChild(noneOpt);

    const monos = catalog.filter((item) => item.group === "Mono");
    const stereos = catalog.filter((item) => item.group === "Stereo");
    if (monos.length > 0) {
      const grpM = document.createElement("optgroup");
      grpM.label = `Mono (${monos.length} Detected)`;
      monos.forEach((item) => {
        const opt = document.createElement("option");
        opt.value = item.id;
        opt.textContent = item.label;
        opt.dataset.baseLabel = item.label;
        grpM.appendChild(opt);
      });
      sel.appendChild(grpM);
    }
    if (stereos.length > 0) {
      const grpS = document.createElement("optgroup");
      grpS.label = "Stereo";
      stereos.forEach((item) => {
        const opt = document.createElement("option");
        opt.value = item.id;
        opt.textContent = item.label;
        opt.dataset.baseLabel = item.label;
        grpS.appendChild(opt);
      });
      sel.appendChild(grpS);
    }
    if (Array.from(sel.options).some((o) => o.value === valStr)) {
      sel.value = valStr;
    } else if (sel.options.length > 1) {
      sel.selectedIndex = 1;
    } else {
      sel.value = "none";
    }
    updateSelectorLiveOptionLabels(sel, true);
  }

  function renderInputChannelSelectors() {
    const catalog = getActiveChannelCatalog();
    populateSingleInputSelector($("lsVocalInputChannelSelect"), catalog, activeConfig.ch1InputSource);
    populateSingleInputSelector($("lsInstInputChannelSelect"), catalog, activeConfig.ch2InputSource);
  }

  function formatStripCodeLabel(spec, fallbackTag) {
    const s = String(spec == null ? "none" : spec).trim().toLowerCase();
    if (activeDetectedChannelCount <= 0) return fallbackTag;
    if (s === "none" || !s) return "NONE";
    if (s === "stereo") return "01S";
    if (s.startsWith("stereo:")) {
      const p = s.split(":");
      return `${Number(p[1] || 0) + 1}/${Number(p[2] || 1) + 1}S`;
    }
    const idx = Number(s);
    return Number.isInteger(idx) && idx >= 0 ? `${String(idx + 1).padStart(2, "0")}M` : fallbackTag;
  }

  function updateStripLiveRouteBadge(badgeEl, routeSpec) {
    if (!badgeEl) return;
    if (bridgeStandbyMode || activeDetectedChannelCount <= 0) {
      badgeEl.textContent = bridgeStandbyMode ? "○ Standby" : "○ Not probed";
      badgeEl.classList.remove("is-live-signal", "is-unassigned");
      return;
    }
    const idxs = resolvePinIndicesForRoute(routeSpec);
    if (idxs.length === 0) {
      badgeEl.textContent = "× Unassigned";
      badgeEl.classList.remove("is-live-signal");
      badgeEl.classList.add("is-unassigned");
      return;
    }
    const peaks = Array.isArray(livePinLevels.peaksDb) ? livePinLevels.peaksDb : [];
    const activeSet = new Set(Array.isArray(livePinLevels.activePins) ? livePinLevels.activePins : []);
    const fresh = (Date.now() - livePinLevels.updatedAt) < 2500 && peaks.length > 0;
    if (!fresh) {
      const pinTxt = idxs.map((i) => `In ${i + 1}`).join("+");
      badgeEl.textContent = `○ ${pinTxt} Ready`;
      badgeEl.classList.remove("is-live-signal", "is-unassigned");
      return;
    }
    let bestDb = -96;
    let isActive = false;
    idxs.forEach((i) => {
      if (i >= 0 && i < peaks.length && peaks[i] > bestDb) bestDb = peaks[i];
      if (activeSet.has(i)) isActive = true;
    });
    const pinLbl = idxs.map((i) => `In ${i + 1}`).join("+");
    if (isActive) {
      badgeEl.textContent = `● ${pinLbl} ${bestDb.toFixed(1)} dB`;
      badgeEl.classList.add("is-live-signal");
      badgeEl.classList.remove("is-unassigned");
    } else {
      badgeEl.textContent = `○ ${pinLbl} Idle`;
      badgeEl.classList.remove("is-live-signal", "is-unassigned");
    }
  }

  function renderLivePinDetectionUi(forceNow) {
    const now = Date.now();
    if (!forceNow && now - lastPinDomRenderAt < 90) return;
    lastPinDomRenderAt = now;

    if ($("lsVocalStripPinTag")) {
      $("lsVocalStripPinTag").textContent = activeDetectedChannelCount > 0
        ? `${formatStripCodeLabel(activeConfig.ch1InputSource, "01M")} · CH 1`
        : "CH 1 · STANDBY";
    }
    if ($("lsInstStripPinTag")) {
      $("lsInstStripPinTag").textContent = activeDetectedChannelCount > 0
        ? `${formatStripCodeLabel(activeConfig.ch2InputSource, "02M")} · CH 2`
        : "CH 2 · STANDBY";
    }
    updateStripLiveRouteBadge($("lsVocalRouteLiveBadge"), activeConfig.ch1InputSource);
    updateStripLiveRouteBadge($("lsInstRouteLiveBadge"), activeConfig.ch2InputSource);

    if ($("lsVocalDetectInputBtn")) {
      const learningV = Boolean(inputLearnState && inputLearnState.targetBus === "vocal");
      $("lsVocalDetectInputBtn").classList.toggle("is-learning", learningV);
      $("lsVocalDetectInputBtn").textContent = learningV ? "Speak..." : "Detect";
    }
    if ($("lsInstDetectInputBtn")) {
      const learningI = Boolean(inputLearnState && inputLearnState.targetBus === "inst");
      $("lsInstDetectInputBtn").classList.toggle("is-learning", learningI);
      $("lsInstDetectInputBtn").textContent = learningI ? "Play..." : "Detect";
    }

    updateSelectorLiveOptionLabels($("lsVocalInputChannelSelect"), false);
    updateSelectorLiveOptionLabels($("lsInstInputChannelSelect"), false);

    const bar = $("lsLiveDetectedPinsBar");
    if (!bar) return;
    const monos = getActiveChannelCatalog().filter((c) => c.group === "Mono");
    if (monos.length === 0) {
      bar.innerHTML = "";
      const empty = document.createElement("span");
      empty.className = "ls-live-pins-empty";
      empty.textContent = bridgeStandbyMode
        ? "Audio Bridge Standby — connect an external USB/ASIO interface or choose a Built-in input manually"
        : "Live Hardware Inputs: Not probed yet — click Start Audio Soundcheck, Refresh, or Detect";
      bar.appendChild(empty);
      return;
    }

    const peaks = Array.isArray(livePinLevels.peaksDb) ? livePinLevels.peaksDb : [];
    const floors = Array.isArray(livePinLevels.noiseFloorsDb) ? livePinLevels.noiseFloorsDb : [];
    const activeSet = new Set(Array.isArray(livePinLevels.activePins) ? livePinLevels.activePins : []);
    const fresh = (now - livePinLevels.updatedAt) < 2500 && peaks.length > 0;
    const ch1Pins = new Set(resolvePinIndicesForRoute(activeConfig.ch1InputSource));
    const ch2Pins = new Set(resolvePinIndicesForRoute(activeConfig.ch2InputSource));

    bar.innerHTML = "";
    monos.forEach((m) => {
      const pinIdx = Number(m.index);
      const db = pinIdx < peaks.length ? Number(peaks[pinIdx]) : -96;
      const floorDb = pinIdx < floors.length ? Number(floors[pinIdx]) : null;
      const isLivePin = fresh && activeSet.has(pinIdx);
      const feedsVocals = ch1Pins.has(pinIdx);
      const feedsInst = ch2Pins.has(pinIdx);
      const isShared = feedsVocals && feedsInst;
      const isDupMono = Boolean(livePinLevels.duplicatedMono) && pinIdx < 2;

      const chip = document.createElement("div");
      chip.className = "ls-live-pin-chip"
        + (isLivePin ? " is-active-pin" : "")
        + (isShared ? " is-shared-route" : "")
        + (isDupMono ? " is-duplicated-mono" : "");
      if (isDupMono) {
        chip.title = "Correlated Dual-Mono (corr > 0.97): both pins carry the same signal";
      }

      const codeSpan = document.createElement("span");
      codeSpan.className = "ls-live-pin-code";
      codeSpan.textContent = `[${m.code}]`;

      const nameSpan = document.createElement("span");
      nameSpan.className = "ls-live-pin-name";
      nameSpan.textContent = m.label.replace(/^\[[^\]]+\]\s*/, "");
      nameSpan.title = m.label;

      const meter = document.createElement("div");
      meter.className = "ls-live-pin-meter";
      const fill = document.createElement("div");
      fill.className = "ls-live-pin-meter-fill";
      const pct = fresh ? Math.max(0, Math.min(100, ((db + 60) / 60) * 100)) : 0;
      fill.style.width = `${pct.toFixed(0)}%`;
      meter.appendChild(fill);

      const dbSpan = document.createElement("span");
      dbSpan.className = "ls-live-pin-db";
      dbSpan.textContent = !fresh
        ? "○ Probe"
        : (isLivePin ? `● ${db.toFixed(1)} dB` : (floorDb != null ? `○ Idle (${floorDb.toFixed(0)} dB)` : "○ Idle"));

      const destSpan = document.createElement("span");
      destSpan.className = "ls-live-pin-dest";
      if (feedsVocals && feedsInst) destSpan.textContent = "→ Vocals + Inst";
      else if (feedsVocals) destSpan.textContent = "→ CH 1 Vocals";
      else if (feedsInst) destSpan.textContent = "→ CH 2 Inst";
      else destSpan.textContent = "→ Unrouted";

      chip.appendChild(codeSpan);
      chip.appendChild(nameSpan);
      chip.appendChild(meter);
      chip.appendChild(dbSpan);
      chip.appendChild(destSpan);
      bar.appendChild(chip);
    });

    if (monos.length === 1) {
      const note = document.createElement("span");
      note.className = "ls-live-pins-empty";
      note.textContent = activeSourceMode === "asio"
        ? "1 physical input reported by driver."
        : "Browser WASAPI only exposes 1 ch — run Audio Bridge (17940) for discrete Ch 1 & Ch 2.";
      bar.appendChild(note);
    } else if (livePinLevels.duplicatedMono) {
      const warnNote = document.createElement("span");
      warnNote.className = "ls-live-pins-empty";
      warnNote.textContent = "⚠ Correlated Mono: Ch 1 & Ch 2 are identical — set USB/OS device to 2-Channel Split.";
      bar.appendChild(warnNote);
    }
  }

  function stopInputAutoDetect(silent) {
    if (!inputLearnState) return;
    if (inputLearnState.timer) clearTimeout(inputLearnState.timer);
    inputLearnState = null;
    renderLivePinDetectionUi(true);
    try {
      window.dispatchEvent(new CustomEvent("ls-input-detect-ended", { detail: { silent: Boolean(silent) } }));
    } catch (_) { }
    if (!silent) showStudioMessage("Auto-Detect cancelled.", false);
  }

  function evaluateInputLearnSample() {
    if (!inputLearnState) return;
    const peaks = Array.isArray(livePinLevels.peaksDb) ? livePinLevels.peaksDb : [];
    const activeSet = new Set(Array.isArray(livePinLevels.activePins) ? livePinLevels.activePins : []);
    if (peaks.length === 0) return;

    let bestPin = -1;
    let bestDb = -96;
    let secondDb = -96;
    for (let i = 0; i < peaks.length; i++) {
      const v = Number(peaks[i]);
      if (v > bestDb) {
        secondDb = bestDb;
        bestDb = v;
        bestPin = i;
      } else if (v > secondDb) {
        secondDb = v;
      }
    }

    const dominantMarginOk = peaks.length < 2 || (bestDb - secondDb) >= 4.0;
    const isSignalActive = bestPin >= 0 && bestDb > -45.0 && (activeSet.has(bestPin) || bestDb >= -24.0);
    if (isSignalActive && dominantMarginOk) {
      if (inputLearnState.streakPin === bestPin) {
        inputLearnState.streakCount += 1;
      } else {
        inputLearnState.streakPin = bestPin;
        inputLearnState.streakCount = 1;
      }
      if (inputLearnState.streakCount >= 2) {
        const targetBus = inputLearnState.targetBus;
        const onDetected = inputLearnState.onDetected;
        stopInputAutoDetect(true);
        const valStr = String(bestPin);
        const item = getActiveChannelCatalog().find((c) => String(c.id) === valStr);
        const label = item ? item.label : `In ${bestPin + 1}`;
        if (typeof onDetected === "function") {
          onDetected(valStr, label, bestDb);
          return;
        }
        if (targetBus === "vocal") {
          activeConfig.ch1InputSource = valStr;
        } else {
          ch2AutoMutedBySingleCh = false;
          activeConfig.ch2InputSource = valStr;
        }
        activeConfig.swapChannels = activeConfig.ch1InputSource === "1" && activeConfig.ch2InputSource === "0";
        syncUiFromConfig();
        showStudioMessage(
          `Auto-detected ${label} (${bestDb.toFixed(1)} dB) → ${targetBus === "vocal" ? "CH 1 Vocals" : "CH 2 Instruments"}`,
          false
        );
      }
    } else {
      inputLearnState.streakCount = 0;
    }
  }

  function handleLivePinLevelsMessage(msg) {
    if (!msg || msg.type !== "input-levels") return;
    if (typeof msg.standby === "boolean") bridgeStandbyMode = msg.standby;
    const peaks = Array.isArray(msg.peaksDb) ? msg.peaksDb.map(Number) : [];
    const rms = Array.isArray(msg.rmsDb) ? msg.rmsDb.map(Number) : [];
    const nCh = Number(msg.channels) || peaks.length;
    livePinLevels.channels = nCh;
    livePinLevels.peaksDb = peaks;
    livePinLevels.rmsDb = rms;
    livePinLevels.noiseFloorsDb = Array.isArray(msg.noiseFloorsDb) ? msg.noiseFloorsDb.map(Number) : [];
    livePinLevels.snrDb = Array.isArray(msg.snrDb) ? msg.snrDb.map(Number) : [];
    livePinLevels.activePins = Array.isArray(msg.activePins) ? msg.activePins : [];
    livePinLevels.corr01 = Number(msg.corr01) || 0;
    livePinLevels.duplicatedMono = Boolean(msg.duplicatedMono);
    livePinLevels.standby = Boolean(msg.standby);
    livePinLevels.updatedAt = Date.now();
    if (nCh > 0 && activeDetectedChannelCount !== nCh && msg.cleanName) {
      activeDetectedChannelCount = nCh;
      activeDetectedDeviceName = cleanHardwareDeviceLabel(msg.cleanName);
      activeDetectedDriverName = msg.hostApi || activeDetectedDriverName;
      activeChannelCatalog = buildDetectedChannelCatalog(activeDetectedDeviceName, nCh);
      reconcileRoutingWithCatalog(activeChannelCatalog);
      renderInputChannelSelectors();
      emitHardwareCatalogChanged();
    }
    evaluateInputLearnSample();
    renderLivePinDetectionUi(false);
  }

  function populateBridgeDevicesDropdown(devices, activeDeviceId) {
    const inSel = $("lsAudioInputSelect");
    if (!inSel || !Array.isArray(devices)) return;
    const prevVal = inSel.value;
    inSel.innerHTML = "";

    const standbyOpt = document.createElement("option");
    standbyOpt.value = "none";
    standbyOpt.textContent = "None — Standby (External Interface Only)";
    inSel.appendChild(standbyOpt);

    const extDevs = devices.filter((d) => d.deviceCategory === "external_interface");
    const sysDevs = devices.filter((d) => d.deviceCategory !== "external_interface");

    function appendDeviceOption(parent, d) {
      const opt = document.createElement("option");
      opt.value = String(d.id || d.name || "");
      const srK = d.defaultSampleRate ? `${Math.round(d.defaultSampleRate / 1000)}k` : "48k";
      opt.textContent = `[${d.hostApi}] ${d.name} (${d.maxInputChannels} ch @ ${srK})`;
      parent.appendChild(opt);
    }

    if (extDevs.length > 0) {
      const grp = document.createElement("optgroup");
      grp.label = "External Audio Interfaces (USB / ASIO)";
      extDevs.forEach((d) => appendDeviceOption(grp, d));
      inSel.appendChild(grp);
    }
    if (sysDevs.length > 0) {
      const grp = document.createElement("optgroup");
      grp.label = "Built-in / System Inputs (Manual Only)";
      sysDevs.forEach((d) => appendDeviceOption(grp, d));
      inSel.appendChild(grp);
    }

    if (activeDeviceId && devices.some((d) => String(d.id) === String(activeDeviceId))) {
      inSel.value = String(activeDeviceId);
    } else if (!activeDeviceId) {
      inSel.value = "none";
    } else if (prevVal && (prevVal === "none" || devices.some((d) => String(d.id) === prevVal))) {
      inSel.value = prevVal;
    } else {
      inSel.value = "none";
    }
  }

  function handleBridgeInfoMeta(meta) {
    if (!meta || meta.type !== "bridge-info") return;
    if (Array.isArray(meta.devices)) {
      activeBridgeDevices = meta.devices;
    }
    const isStandby = Boolean(meta.standby) || Number(meta.channels) === 0;
    bridgeStandbyMode = isStandby;
    const chCount = isStandby ? 0 : Math.max(0, Number(meta.channels) || 0);
    const clean = isStandby
      ? "No External Interface (Standby)"
      : cleanHardwareDeviceLabel(meta.cleanName || meta.deviceName || "Audio Bridge");
    activeDetectedChannelCount = chCount;
    activeDetectedDeviceName = clean;
    activeDetectedDriverName = meta.hostApi || "Audio Bridge";
    if (isStandby) {
      activeChannelCatalog = [];
      livePinLevels.channels = 0;
      livePinLevels.peaksDb = [];
      livePinLevels.rmsDb = [];
      livePinLevels.noiseFloorsDb = [];
      livePinLevels.activePins = [];
      livePinLevels.standby = true;
    } else if (Array.isArray(meta.inputChannels) && meta.inputChannels.length > 0) {
      activeChannelCatalog = meta.inputChannels;
    } else if (meta.deviceName && chCount > 0) {
      activeChannelCatalog = buildDetectedChannelCatalog(clean, chCount);
    } else {
      activeChannelCatalog = [];
    }
    reconcileRoutingWithCatalog(activeChannelCatalog);
    const backendSel = $("lsCaptureBackendSelect");
    if (backendSel && backendSel.value === "asio") {
      populateBridgeDevicesDropdown(activeBridgeDevices, isStandby ? "" : meta.deviceId);
    }
    const asioPanelBtn = $("lsOpenAsioPanelBtn");
    if (asioPanelBtn) {
      asioPanelBtn.classList.toggle("ls-is-hidden", isStandby || !meta.isAsio);
    }
    renderInputChannelSelectors();
    emitHardwareCatalogChanged();
    renderLivePinDetectionUi(true);
    if (meta.warning) {
      showStudioMessage(meta.warning, true);
    }
  }

  function applyConfigToGraph() {
    if (!nodes || !audioCtx) return;
    const c = activeConfig;
    const isSplit = c.mode !== "stereo";

    // Channel routing matrix: supports arbitrary N-pin hardware mono/stereo pairs or None per bus
    // Dry capture ALWAYS taps ch1PinGains/ch2PinGains strictly upstream of Trim, EQ, Dynamics & Faders
    const ch1List = Array.isArray(nodes.ch1PinGains)
      ? nodes.ch1PinGains
      : [nodes.ch1FromL, nodes.ch1FromR].filter(Boolean);
    const ch2List = Array.isArray(nodes.ch2PinGains)
      ? nodes.ch2PinGains
      : [nodes.ch2FromL, nodes.ch2FromR].filter(Boolean);

    if (activeSourceMode === "asio" && asioSocket && asioSocket.readyState === 1) {
      const routeSig = `${c.ch1InputSource}|${c.ch2InputSource}`;
      if (lastSentBridgeRouting !== routeSig) {
        lastSentBridgeRouting = routeSig;
        try {
          asioSocket.send(JSON.stringify({ type: "set-routing", ch1: c.ch1InputSource, ch2: c.ch2InputSource }));
        } catch (_) { }
      }
      ch1List.forEach((g, idx) => rampParam(g.gain, idx === 0 && c.ch1InputSource !== "none" ? 1 : 0));
      ch2List.forEach((g, idx) => rampParam(g.gain, idx === 1 && c.ch2InputSource !== "none" ? 1 : 0));
    } else {
      const g1 = gainArrayForRoute(c.ch1InputSource, ch1List.length);
      const g2 = gainArrayForRoute(c.ch2InputSource, ch2List.length);
      ch1List.forEach((g, idx) => rampParam(g.gain, g1[idx] || 0));
      ch2List.forEach((g, idx) => rampParam(g.gain, g2[idx] || 0));
    }
    if (isSplit) {
      rampParam(nodes.splitMasterGate.gain, 1);
      rampParam(nodes.stereoPassGain.gain, 0);
    } else {
      rampParam(nodes.splitMasterGate.gain, 0);
      rampParam(nodes.stereoPassGain.gain, 1);
    }

    // Channel 2 (Instruments): Trim -> HPF1/HPF2 -> LPF -> 3-Band EQ -> ProDSP -> Fader -> Mute -> Sends -> Pan
    const inst = c.inst;
    if (nodes.instTrimGain) {
      const instSign = inst.polarity ? -1 : 1;
      rampParam(nodes.instTrimGain.gain, instSign * dbToLinearGain(inst.trimDb || 0));
    }
    const instHpfHz = inst.eqBypass ? 10 : Math.max(20, Number(inst.hpf) || 45);
    rampParam(nodes.instHpf.frequency, instHpfHz);
    if (nodes.instHpf2) {
      rampParam(nodes.instHpf2.frequency, !inst.eqBypass && Number(inst.hpfSlope) === 24 ? instHpfHz : 10);
    }
    if (nodes.instLpf) {
      rampParam(nodes.instLpf.frequency, inst.eqBypass ? 22000 : Math.max(1500, Number(inst.lpf) || 20000));
    }
    rampParam(nodes.instEqLow.gain, inst.eqBypass ? 0 : (inst.low || 0));
    rampParam(nodes.instEqMid.frequency, Math.max(150, Math.min(6000, Number(inst.midFreq) || 450)));
    rampParam(nodes.instEqMid.Q, Math.max(0.3, Math.min(8, Number(inst.midQ) || 1.0)));
    rampParam(nodes.instEqMid.gain, inst.eqBypass ? 0 : (inst.mid || 0));
    rampParam(nodes.instEqHigh.gain, inst.eqBypass ? 0 : (inst.high || 0));

    if (nodes.instProDspNode && nodes.instProDspNode.port) {
      nodes.instProDspNode.port.postMessage({
        type: "params",
        params: {
          polarityInvert: false,
          trimDb: 0,
          gateEnabled: Boolean(inst.gate),
          gateThresholdDb: Number(inst.gateThreshDb ?? -54),
          gateRangeDb: Number(inst.gateRangeDb ?? -12),
          gateHoldMs: Number(inst.gateHoldMs ?? 140),
          gateScHpfHz: 50,
          deessEnabled: false,
          compEnabled: Boolean(inst.comp),
          compThresholdDb: Number(inst.compThreshDb ?? -16),
          compRatio: Number(inst.compRatio ?? 2.5),
          compAttackMs: Number(inst.compAttackMs ?? 14),
          compReleaseMs: Number(inst.compReleaseMs ?? 180),
          compMakeupDb: Number(inst.compMakeupDb ?? 0.5),
          compPeakMode: Boolean(inst.compPeakMode),
          compScHpfHz: 45,
          limEnabled: false
        }
      });
    }
    if (nodes.instComp) {
      if (!nodes.instProDspNode && inst.comp) {
        rampParam(nodes.instComp.threshold, Number(inst.compThreshDb ?? -16));
        rampParam(nodes.instComp.ratio, Number(inst.compRatio ?? 2.5));
      } else {
        rampParam(nodes.instComp.threshold, 0);
        rampParam(nodes.instComp.ratio, 1);
      }
    }
    rampParam(nodes.instGain.gain, (inst.gain ?? 100) / 100);
    rampParam(nodes.instMuteGain.gain, inst.mute ? 0 : 1);
    const instRevLvl = Math.max(0, Math.min(1.5, Number(inst.reverbSend ?? 65) / 100));
    if (nodes.instPreRevSendGain) {
      rampParam(nodes.instPreRevSendGain.gain, isSplit && inst.preFaderSend && !inst.mute ? instRevLvl : 0);
    }
    if (nodes.instPostRevSendGain) {
      rampParam(nodes.instPostRevSendGain.gain, isSplit && !inst.preFaderSend ? instRevLvl : 0);
    }
    if (nodes.instPanner && nodes.instPanner.pan) {
      rampParam(nodes.instPanner.pan, Math.max(-1, Math.min(1, (inst.pan || 0) / 100)));
    }

    // Channel 1 (Vocals): Trim -> HPF1/HPF2 -> LPF -> 3-Band EQ -> ProDSP -> Fader -> Mute -> Sends -> Pan
    const vocal = c.vocal;
    if (nodes.vocalTrimGain) {
      const vocalSign = vocal.polarity ? -1 : 1;
      rampParam(nodes.vocalTrimGain.gain, vocalSign * dbToLinearGain(vocal.trimDb || 0));
    }
    const vocalHpfHz = vocal.eqBypass ? 10 : Math.max(20, Number(vocal.hpf) || 85);
    rampParam(nodes.vocalHpf.frequency, vocalHpfHz);
    if (nodes.vocalHpf2) {
      rampParam(nodes.vocalHpf2.frequency, !vocal.eqBypass && Number(vocal.hpfSlope) === 24 ? vocalHpfHz : 10);
    }
    if (nodes.vocalLpf) {
      rampParam(nodes.vocalLpf.frequency, vocal.eqBypass ? 22000 : Math.max(1500, Number(vocal.lpf) || 20000));
    }
    rampParam(nodes.vocalEqLow.gain, vocal.eqBypass ? 0 : (vocal.low || 0));
    rampParam(nodes.vocalEqMid.frequency, Math.max(200, Math.min(8000, Number(vocal.midFreq) || 3200)));
    rampParam(nodes.vocalEqMid.Q, Math.max(0.3, Math.min(8, Number(vocal.midQ) || 1.1)));
    rampParam(nodes.vocalEqMid.gain, vocal.eqBypass ? 0 : (vocal.mid || 0));
    const deessAmount = Math.max(0, Number(vocal.deesser) || 0);
    if (nodes.vocalDeesser) {
      rampParam(nodes.vocalDeesser.frequency, Math.max(3500, Math.min(11000, Number(vocal.deessFreq) || 6500)));
      rampParam(nodes.vocalDeesser.Q, Number(vocal.deessQ) || 3.2);
      rampParam(nodes.vocalDeesser.gain, nodes.vocalProDspNode ? 0 : -deessAmount * 0.4);
    }
    if (nodes.vocalProDspNode && nodes.vocalProDspNode.port) {
      nodes.vocalProDspNode.port.postMessage({
        type: "params",
        params: {
          polarityInvert: false,
          trimDb: 0,
          gateEnabled: Boolean(vocal.gate),
          gateThresholdDb: Number(vocal.gateThreshDb ?? -50),
          gateRangeDb: Number(vocal.gateRangeDb ?? -14),
          gateHoldMs: Number(vocal.gateHoldMs ?? 90),
          gateScHpfHz: 80,
          deessEnabled: deessAmount > 0.05,
          deessFreqHz: Number(vocal.deessFreq) || 6500,
          deessQ: Number(vocal.deessQ) || 3.2,
          deessThresholdDb: Number(vocal.deessThreshDb ?? -26),
          deessReductionDb: deessAmount,
          deessWideband: Boolean(vocal.deessWideband),
          compEnabled: vocal.comp !== false,
          compThresholdDb: Number(vocal.compThreshDb ?? -18),
          compRatio: Number(vocal.compRatio ?? 3.5),
          compAttackMs: Number(vocal.compAttackMs ?? 8),
          compReleaseMs: Number(vocal.compReleaseMs ?? 160),
          compMakeupDb: Number(vocal.compMakeupDb ?? 1.5),
          compPeakMode: Boolean(vocal.compPeakMode),
          compScHpfHz: 80,
          limEnabled: false
        }
      });
    }
    rampParam(nodes.vocalEqHigh.gain, vocal.eqBypass ? 0 : (vocal.high || 0));

    if (!nodes.vocalProDspNode && vocal.comp !== false) {
      rampParam(nodes.vocalComp.threshold, Number(vocal.compThreshDb ?? -18));
      rampParam(nodes.vocalComp.ratio, Number(vocal.compRatio ?? 3.5));
    } else {
      rampParam(nodes.vocalComp.threshold, 0);
      rampParam(nodes.vocalComp.ratio, 1);
    }
    rampParam(nodes.vocalGain.gain, (vocal.gain ?? 112) / 100);
    rampParam(nodes.vocalMuteGain.gain, vocal.mute ? 0 : 1);
    const vocalRevLvl = Math.max(0, Math.min(1.5, Number(vocal.reverbSend ?? 100) / 100));
    if (nodes.vocalPreRevSendGain) {
      rampParam(nodes.vocalPreRevSendGain.gain, isSplit && vocal.preFaderSend && !vocal.mute ? vocalRevLvl : 0);
    }
    if (nodes.vocalPostRevSendGain) {
      rampParam(nodes.vocalPostRevSendGain.gain, isSplit && !vocal.preFaderSend ? vocalRevLvl : 0);
    }
    if (nodes.vocalPanner && nodes.vocalPanner.pan) {
      rampParam(nodes.vocalPanner.pan, Math.max(-1, Math.min(1, (vocal.pan || 0) / 100)));
    }

    // Reverb send & return
    rampParam(nodes.reverbSendGain.gain, isSplit ? 0 : 0.65);
    const revReturnAmt = Math.max(0, Math.min(1, (Number(c.reverb.wet) || 0) / 100));
    if (nodes.reverbReturnGain) {
      rampParam(nodes.reverbReturnGain.gain, revReturnAmt);
    }

    // 5-Band Master EQ
    const bypass = Boolean(c.master.bypass);
    rampParam(nodes.m80.gain, bypass ? 0 : c.master.b80 || 0);
    rampParam(nodes.m250.gain, bypass ? 0 : c.master.b250 || 0);
    rampParam(nodes.m1k.gain, bypass ? 0 : c.master.b1k || 0);
    rampParam(nodes.m3k5.gain, bypass ? 0 : c.master.b3k5 || 0);
    rampParam(nodes.m10k.gain, bypass ? 0 : c.master.b10k || 0);

    // Master Bus Glue Compressor
    if (nodes.glueComp) {
      if (c.master.glueComp !== false) {
        rampParam(nodes.glueComp.threshold, -14);
        rampParam(nodes.glueComp.ratio, 2.2);
      } else {
        rampParam(nodes.glueComp.threshold, 0);
        rampParam(nodes.glueComp.ratio, 1);
      }
    }

    // Master Lookahead True-Peak Limiter (-1.0 dBTP default)
    const limOn = c.master.limiter !== false;
    if (nodes.masterProDspNode && nodes.masterProDspNode.port) {
      nodes.masterProDspNode.port.postMessage({
        type: "params",
        params: {
          gateEnabled: false,
          deessEnabled: false,
          compEnabled: false,
          limEnabled: limOn,
          limCeilingDb: -1.0,
          limLookaheadMs: 1.5,
          limReleaseMs: 80
        }
      });
      rampParam(nodes.limiter.threshold, 0);
      rampParam(nodes.limiter.ratio, 1);
    } else if (limOn) {
      rampParam(nodes.limiter.threshold, -1.0);
      rampParam(nodes.limiter.ratio, 20);
    } else {
      rampParam(nodes.limiter.threshold, 0);
      rampParam(nodes.limiter.ratio, 1);
    }

    rampParam(nodes.masterOutGain.gain, (c.master.gain ?? 100) / 100);
    rampParam(nodes.broadcastMuteGain.gain, broadcastMuted ? 0 : 1);

    // Earphone Monitor & True Pre-Fader Listen (PFL) Solo routing
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

  function bindVal(sliderId, labelId, suffix, getter, setter, formatFn) {
    const el = $(sliderId);
    const lbl = $(labelId);
    if (!el) return;
    const fmt = formatFn || ((v) => `${v}${suffix}`);
    el.value = String(getter());
    if (lbl) lbl.textContent = fmt(getter());
    el.oninput = function () {
      const val = Number(el.value);
      setter(val);
      if (lbl) lbl.textContent = fmt(val);
      applyConfigToGraph();
      drawEqAndSpectrum();
      drawChannelProcCanvas();
    };
  }

  function formatPanLabel(v) {
    const n = Math.round(Number(v) || 0);
    if (n === 0) return "C";
    return n < 0 ? `L${Math.abs(n)}` : `R${n}`;
  }

  function formatTrimLabel(v) {
    const n = Number(v) || 0;
    return `${n >= 0 ? "+" : ""}${n.toFixed(1)} dB`;
  }

  function formatFaderDbLabel(pct) {
    const g = Number(pct) / 100;
    if (!(g > 0.001)) return "-∞ dB";
    const db = 20 * Math.log10(g);
    const rounded = Math.abs(db) < 0.05 ? 0 : db;
    return `${rounded > 0 ? "+" : ""}${rounded.toFixed(1)} dB`;
  }

  function formatHzShort(hz) {
    const f = Number(hz) || 0;
    return f >= 1000 ? `${(f / 1000).toFixed(f % 1000 === 0 ? 0 : 1)}k Hz` : `${Math.round(f)} Hz`;
  }

  function rebuildHallConvolverBuffer() {
    if (nodes && audioCtx && nodes.convolver) {
      nodes.convolver.buffer = buildImpulseResponse(audioCtx, activeConfig.reverb.decay || 1.4);
    }
  }

  function syncUiFromConfig() {
    activeConfig = normalizeStudioConfig(activeConfig);
    const c = activeConfig;
    const modeSelect = $("lsInputMode");
    if (modeSelect) modeSelect.value = c.mode === "stereo" ? "stereo" : "split";

    const swapBtn = $("lsSwapBtn");
    if (swapBtn) swapBtn.classList.toggle("is-toggled", Boolean(c.swapChannels));

    const compBtn = $("lsVocalCompBtn");
    if (compBtn) {
      compBtn.classList.toggle("is-toggled", Boolean(c.vocal.comp));
      compBtn.textContent = c.vocal.comp ? "Comp: ON" : "Comp: OFF";
    }

    const instCompBtn = $("lsInstCompBtn");
    if (instCompBtn) {
      instCompBtn.classList.toggle("is-toggled", Boolean(c.inst.comp));
      instCompBtn.textContent = c.inst.comp ? "Comp: ON" : "Comp: OFF";
    }

    if ($("lsVocalGateBtn")) $("lsVocalGateBtn").classList.toggle("is-toggled", Boolean(c.vocal.gate));
    if ($("lsInstGateBtn")) $("lsInstGateBtn").classList.toggle("is-toggled", Boolean(c.inst.gate));
    if ($("lsVocalPolarityBtn")) $("lsVocalPolarityBtn").classList.toggle("is-toggled", Boolean(c.vocal.polarity));
    if ($("lsInstPolarityBtn")) $("lsInstPolarityBtn").classList.toggle("is-toggled", Boolean(c.inst.polarity));

    if ($("lsVocalEqBypassBtn")) {
      $("lsVocalEqBypassBtn").classList.toggle("is-toggled", Boolean(c.vocal.eqBypass));
      $("lsVocalEqBypassBtn").textContent = c.vocal.eqBypass ? "EQ Bypassed" : "EQ Active";
    }
    if ($("lsInstEqBypassBtn")) {
      $("lsInstEqBypassBtn").classList.toggle("is-toggled", Boolean(c.inst.eqBypass));
      $("lsInstEqBypassBtn").textContent = c.inst.eqBypass ? "EQ Bypassed" : "EQ Active";
    }

    const eqBypassBtn = $("lsMasterBypassBtn");
    if (eqBypassBtn) {
      eqBypassBtn.classList.toggle("is-toggled", Boolean(c.master.bypass));
      eqBypassBtn.textContent = c.master.bypass ? "EQ Bypassed" : "EQ Active";
    }

    const glueBtn = $("lsGlueCompBtn");
    if (glueBtn) {
      const glueOn = c.master.glueComp !== false;
      glueBtn.classList.toggle("is-toggled", glueOn);
      glueBtn.textContent = glueOn ? "Glue Comp: ON" : "Glue Comp: OFF";
    }

    const limBtn = $("lsLimiterBtn");
    if (limBtn) {
      const limOn = c.master.limiter !== false;
      limBtn.classList.toggle("is-toggled", limOn);
      limBtn.textContent = limOn ? "Limiter: ON (-1.0 dBTP)" : "Limiter: OFF";
    }

    const instMuteBtn = $("lsInstMuteBtn");
    if (instMuteBtn) instMuteBtn.classList.toggle("is-muted-active", Boolean(c.inst.mute));
    const vocalMuteBtn = $("lsVocalMuteBtn");
    if (vocalMuteBtn) vocalMuteBtn.classList.toggle("is-muted-active", Boolean(c.vocal.mute));

    // Instruments Channel Bindings
    bindVal("lsInstGain", "lsInstGainVal", "", () => c.inst.gain, (v) => (c.inst.gain = v), formatFaderDbLabel);
    bindVal("lsInstTrim", "lsInstTrimVal", " dB", () => c.inst.trimDb, (v) => (c.inst.trimDb = v), formatTrimLabel);
    bindVal("lsInstPan", "lsInstPanVal", "", () => c.inst.pan, (v) => (c.inst.pan = v), formatPanLabel);
    bindVal("lsInstHpf", "lsInstHpfVal", " Hz", () => c.inst.hpf, (v) => (c.inst.hpf = v));
    bindVal("lsInstLpf", "lsInstLpfVal", "", () => c.inst.lpf, (v) => (c.inst.lpf = v), formatHzShort);
    bindVal("lsInstLow", "lsInstLowVal", " dB", () => c.inst.low, (v) => (c.inst.low = v));
    bindVal("lsInstMid", "lsInstMidVal", " dB", () => c.inst.mid, (v) => (c.inst.mid = v));
    bindVal("lsInstHigh", "lsInstHighVal", " dB", () => c.inst.high, (v) => (c.inst.high = v));
    const updateInstMidLbl = () => {
      if ($("lsInstMidFreqVal")) {
        const f = Number(c.inst.midFreq) || 450;
        const fStr = f >= 1000 ? `${(f / 1000).toFixed(1)}k` : `${Math.round(f)}`;
        $("lsInstMidFreqVal").textContent = `${fStr} Q${Number(c.inst.midQ || 1.0).toFixed(1)}`;
      }
    };
    bindVal("lsInstMidFreq", null, "", () => c.inst.midFreq, (v) => { c.inst.midFreq = v; updateInstMidLbl(); });
    bindVal("lsInstMidQ", null, "", () => c.inst.midQ, (v) => { c.inst.midQ = v; updateInstMidLbl(); });
    updateInstMidLbl();
    if ($("lsInstHpfSlope")) {
      $("lsInstHpfSlope").value = String(c.inst.hpfSlope === 24 ? 24 : 12);
    }
    bindVal("lsInstCompThresh", "lsInstCompThreshVal", " dB", () => c.inst.compThreshDb, (v) => (c.inst.compThreshDb = v));
    bindVal("lsInstCompRatio", "lsInstCompRatioVal", ":1", () => c.inst.compRatio, (v) => (c.inst.compRatio = v));
    const updateInstCompTimesLbl = () => {
      if ($("lsInstCompTimesVal")) $("lsInstCompTimesVal").textContent = `${Math.round(c.inst.compAttackMs)} / ${Math.round(c.inst.compReleaseMs)}`;
    };
    bindVal("lsInstCompAttack", null, "", () => c.inst.compAttackMs, (v) => { c.inst.compAttackMs = v; updateInstCompTimesLbl(); });
    bindVal("lsInstCompRelease", null, "", () => c.inst.compReleaseMs, (v) => { c.inst.compReleaseMs = v; updateInstCompTimesLbl(); });
    updateInstCompTimesLbl();
    bindVal("lsInstCompMakeup", "lsInstCompMakeupVal", " dB", () => c.inst.compMakeupDb, (v) => (c.inst.compMakeupDb = v), formatTrimLabel);
    if ($("lsInstCompMode")) $("lsInstCompMode").value = c.inst.compPeakMode ? "peak" : "rms";
    bindVal("lsInstGateThresh", "lsInstGateThreshVal", " dB", () => c.inst.gateThreshDb, (v) => (c.inst.gateThreshDb = v));
    bindVal("lsInstGateRange", null, "", () => c.inst.gateRangeDb, (v) => (c.inst.gateRangeDb = v));
    bindVal("lsInstGateHold", null, "", () => c.inst.gateHoldMs, (v) => (c.inst.gateHoldMs = v));
    bindVal("lsInstRevSend", "lsInstRevSendVal", "%", () => c.inst.reverbSend, (v) => (c.inst.reverbSend = v));
    if ($("lsInstSendMode")) $("lsInstSendMode").value = c.inst.preFaderSend ? "pre" : "post";
    if ($("lsInstSendModeVal")) $("lsInstSendModeVal").textContent = c.inst.preFaderSend ? "PRE" : "POST";

    // Vocals Channel Bindings
    bindVal("lsVocalGain", "lsVocalGainVal", "", () => c.vocal.gain, (v) => (c.vocal.gain = v), formatFaderDbLabel);
    bindVal("lsVocalTrim", "lsVocalTrimVal", " dB", () => c.vocal.trimDb, (v) => (c.vocal.trimDb = v), formatTrimLabel);
    bindVal("lsVocalPan", "lsVocalPanVal", "", () => c.vocal.pan, (v) => (c.vocal.pan = v), formatPanLabel);
    bindVal("lsVocalHpf", "lsVocalHpfVal", " Hz", () => c.vocal.hpf, (v) => (c.vocal.hpf = v));
    bindVal("lsVocalLpf", "lsVocalLpfVal", "", () => c.vocal.lpf, (v) => (c.vocal.lpf = v), formatHzShort);
    bindVal("lsVocalLow", "lsVocalLowVal", " dB", () => c.vocal.low, (v) => (c.vocal.low = v));
    bindVal("lsVocalMid", "lsVocalMidVal", " dB", () => c.vocal.mid, (v) => (c.vocal.mid = v));
    bindVal("lsVocalHigh", "lsVocalHighVal", " dB", () => c.vocal.high, (v) => (c.vocal.high = v));
    const updateVocalMidLbl = () => {
      if ($("lsVocalMidFreqVal")) {
        const f = Number(c.vocal.midFreq) || 3200;
        const fStr = f >= 1000 ? `${(f / 1000).toFixed(1)}k` : `${Math.round(f)}`;
        $("lsVocalMidFreqVal").textContent = `${fStr} Q${Number(c.vocal.midQ || 1.1).toFixed(1)}`;
      }
    };
    bindVal("lsVocalMidFreq", null, "", () => c.vocal.midFreq, (v) => { c.vocal.midFreq = v; updateVocalMidLbl(); });
    bindVal("lsVocalMidQ", null, "", () => c.vocal.midQ, (v) => { c.vocal.midQ = v; updateVocalMidLbl(); });
    updateVocalMidLbl();
    if ($("lsVocalHpfSlope")) {
      $("lsVocalHpfSlope").value = String(c.vocal.hpfSlope === 24 ? 24 : 12);
    }
    bindVal(
      "lsVocalDeesser",
      "lsVocalDeesserVal",
      " dB",
      () => c.vocal.deesser,
      (v) => (c.vocal.deesser = v),
      (v) => (Number(v) > 0 ? `-${Number(v)} dB` : "0 dB")
    );
    bindVal("lsVocalDeessFreq", "lsVocalDeessFreqVal", "", () => c.vocal.deessFreq, (v) => (c.vocal.deessFreq = v), formatHzShort);
    bindVal("lsVocalDeessThresh", "lsVocalDeessThreshVal", " dB", () => c.vocal.deessThreshDb, (v) => (c.vocal.deessThreshDb = v));
    if ($("lsVocalDeessMode")) $("lsVocalDeessMode").value = c.vocal.deessWideband ? "wide" : "split";
    bindVal("lsVocalCompThresh", "lsVocalCompThreshVal", " dB", () => c.vocal.compThreshDb, (v) => (c.vocal.compThreshDb = v));
    bindVal("lsVocalCompRatio", "lsVocalCompRatioVal", ":1", () => c.vocal.compRatio, (v) => (c.vocal.compRatio = v));
    const updateVocalCompTimesLbl = () => {
      if ($("lsVocalCompTimesVal")) $("lsVocalCompTimesVal").textContent = `${Math.round(c.vocal.compAttackMs)} / ${Math.round(c.vocal.compReleaseMs)}`;
    };
    bindVal("lsVocalCompAttack", null, "", () => c.vocal.compAttackMs, (v) => { c.vocal.compAttackMs = v; updateVocalCompTimesLbl(); });
    bindVal("lsVocalCompRelease", null, "", () => c.vocal.compReleaseMs, (v) => { c.vocal.compReleaseMs = v; updateVocalCompTimesLbl(); });
    updateVocalCompTimesLbl();
    bindVal("lsVocalCompMakeup", "lsVocalCompMakeupVal", " dB", () => c.vocal.compMakeupDb, (v) => (c.vocal.compMakeupDb = v), formatTrimLabel);
    if ($("lsVocalCompMode")) $("lsVocalCompMode").value = c.vocal.compPeakMode ? "peak" : "rms";
    bindVal("lsVocalGateThresh", "lsVocalGateThreshVal", " dB", () => c.vocal.gateThreshDb, (v) => (c.vocal.gateThreshDb = v));
    bindVal("lsVocalGateRange", null, "", () => c.vocal.gateRangeDb, (v) => (c.vocal.gateRangeDb = v));
    bindVal("lsVocalGateHold", null, "", () => c.vocal.gateHoldMs, (v) => (c.vocal.gateHoldMs = v));
    bindVal("lsVocalRevSend", "lsVocalRevSendVal", "%", () => c.vocal.reverbSend, (v) => (c.vocal.reverbSend = v));
    if ($("lsVocalSendMode")) $("lsVocalSendMode").value = c.vocal.preFaderSend ? "pre" : "post";
    if ($("lsVocalSendModeVal")) $("lsVocalSendModeVal").textContent = c.vocal.preFaderSend ? "PRE" : "POST";

    // Hall Reverb Bindings
    const revPresetSel = $("lsReverbPresetSelect");
    if (revPresetSel) revPresetSel.value = c.reverb.preset || "medium_prayer_hall";
    bindVal("lsReverbWet", "lsReverbWetVal", "%", () => c.reverb.wet, (v) => (c.reverb.wet = v));
    bindVal(
      "lsReverbPreDelay",
      "lsReverbPreDelayVal",
      " ms",
      () => c.reverb.preDelayMs,
      (v) => { c.reverb.preDelayMs = v; rebuildHallConvolverBuffer(); }
    );
    bindVal(
      "lsReverbDecay",
      "lsReverbDecayVal",
      "s",
      () => c.reverb.decay,
      (v) => { c.reverb.decay = v; rebuildHallConvolverBuffer(); }
    );
    bindVal(
      "lsReverbTone",
      "lsReverbToneVal",
      "",
      () => c.reverb.toneHz,
      (v) => { c.reverb.toneHz = v; rebuildHallConvolverBuffer(); },
      formatHzShort
    );
    bindVal(
      "lsReverbRoomSize",
      "lsReverbRoomSizeVal",
      "%",
      () => c.reverb.roomSize,
      (v) => { c.reverb.roomSize = v; rebuildHallConvolverBuffer(); }
    );
    bindVal(
      "lsReverbWidth",
      "lsReverbWidthVal",
      "%",
      () => c.reverb.stereoWidth,
      (v) => { c.reverb.stereoWidth = v; rebuildHallConvolverBuffer(); }
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
    const ioTag = $("lsIoSummaryTag");
    if (ioTag) {
      const baseMode = c.mode === "stereo" ? "Mode B · Stereo Pass" : "Mode A · 2-Ch Split";
      if (activeDetectedChannelCount <= 0) {
        ioTag.textContent = `${baseMode} · Unprobed`;
      } else {
        ioTag.textContent = c.mode === "stereo"
          ? `${baseMode} · ${activeDetectedChannelCount}-Ch`
          : `${baseMode} · ${activeDetectedChannelCount}-Ch (${formatStripCodeLabel(c.ch1InputSource, "None")} / ${formatStripCodeLabel(c.ch2InputSource, "None")})`;
      }
    }
    renderInputChannelSelectors();
    renderLivePinDetectionUi(true);
    if (typeof syncRotaryVisuals === "function") syncRotaryVisuals();
    applyConfigToGraph();
    drawEqAndSpectrum();
    drawChannelProcCanvas();
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

  async function probeBrowserDeviceChannels(deviceId, labelHint) {
    if (audioCtx && activeSourceMode === "device" && activeHardwareCaptureFormat) {
      const nCh = Math.max(1, Number(activeHardwareCaptureFormat.channelCount) || 1);
      const clean = cleanHardwareDeviceLabel(activeHardwareCaptureFormat.deviceName || labelHint);
      activeDetectedChannelCount = nCh;
      activeDetectedDeviceName = clean;
      activeDetectedDriverName = activeHardwareCaptureFormat.driver || "Browser WASAPI (Shared)";
      activeChannelCatalog = buildDetectedChannelCatalog(clean, nCh);
      reconcileRoutingWithCatalog(activeChannelCatalog);
      renderInputChannelSelectors();
      emitHardwareCatalogChanged();
      renderLivePinDetectionUi(true);
      return nCh;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return 0;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          channelCount: { ideal: 8 },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      });
      const trk = stream.getAudioTracks()[0];
      const settings = trk && typeof trk.getSettings === "function" ? trk.getSettings() : {};
      const chCount = Math.max(1, Number(settings.channelCount) || 1);
      const realLabel = (trk && trk.label) || labelHint || "Audio Input";
      stream.getTracks().forEach((t) => t.stop());

      const clean = cleanHardwareDeviceLabel(realLabel);
      activeDetectedChannelCount = chCount;
      activeDetectedDeviceName = clean;
      activeDetectedDriverName = "Browser WASAPI (Shared)";
      activeChannelCatalog = buildDetectedChannelCatalog(clean, chCount);
      reconcileRoutingWithCatalog(activeChannelCatalog);
      renderInputChannelSelectors();
      emitHardwareCatalogChanged();
      renderLivePinDetectionUi(true);
      return chCount;
    } catch (_) {
      return 0;
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

      const backendSel = $("lsCaptureBackendSelect");
      if (inSel && (!backendSel || backendSel.value !== "asio" || activeBridgeDevices.length === 0)) {
        inSel.innerHTML = "";
        const inputs = list.filter((d) => d.kind === "audioinput");
        const needsPermission =
          inputs.length > 0 && inputs.every((d) => !d.label && !d.deviceId);
        if (inputs.length === 0 || needsPermission) {
          const opt = document.createElement("option");
          opt.value = "";
          opt.textContent = needsPermission
            ? "Click 'Refresh' to allow audio access & probe channels"
            : "No audio inputs detected (plug in interface and click Refresh)";
          inSel.appendChild(opt);
          activeDetectedChannelCount = 0;
          activeChannelCatalog = [];
          renderInputChannelSelectors();
          emitHardwareCatalogChanged();
          renderLivePinDetectionUi(true);
        } else {
          inputs.forEach((d, idx) => {
            const opt = document.createElement("option");
            opt.value = d.deviceId;
            opt.textContent = d.label || `Audio Input ${idx + 1}`;
            inSel.appendChild(opt);
          });
          if (prevIn && inputs.some((d) => d.deviceId === prevIn)) {
            inSel.value = prevIn;
          }
          const selTxt = inSel.options[inSel.selectedIndex] ? inSel.options[inSel.selectedIndex].textContent : "";
          const hasLabelAccess = inputs.some((d) => Boolean(d.deviceId && d.label));
          if (hasLabelAccess) {
            await probeBrowserDeviceChannels(inSel.value, selTxt);
          } else {
            activeDetectedChannelCount = 0;
            activeChannelCatalog = [];
            renderInputChannelSelectors();
            emitHardwareCatalogChanged();
            renderLivePinDetectionUi(true);
          }
        }
      } else if (inSel && backendSel && backendSel.value === "asio" && activeBridgeDevices.length > 0) {
        populateBridgeDevicesDropdown(activeBridgeDevices, preferredBridgeDeviceId || undefined);
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

  function updateGrBar(compNode, barId, valId) {
    const bar = $(barId);
    const val = $(valId);
    if (!compNode || !bar || !val) return;
    const grDb = Math.min(0, Number(compNode.reduction) || 0);
    const pct = Math.max(0, Math.min(100, (Math.abs(grDb) / 18) * 100));
    bar.style.width = `${pct.toFixed(1)}%`;
    val.textContent = `${grDb.toFixed(1)} dB`;
  }

  function drawEqAndSpectrum() {
    const canvas = $("lsEqSpectrumCanvas");
    if (!canvas) return;
    const pal = getStudioPalette();
    const { ctx, w, h } = prepareHiDpiCanvas(canvas, 720, 164);

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = pal.canvasBg;
    ctx.fillRect(0, 0, w, h);

    const minF = 20;
    const maxF = 18000;
    const logRange = Math.log10(maxF / minF);
    const freqToX = (f) => (Math.log10(Math.max(minF, Math.min(maxF, f)) / minF) / logRange) * w;

    // Horizontal dB gridlines (+12, +6, 0, -6, -12 dB)
    ctx.font = "600 9.5px ui-monospace, SFMono-Regular, Menlo, monospace";
    [
      { db: 12, label: "+12" },
      { db: 6, label: "+6" },
      { db: 0, label: "0 dB" },
      { db: -6, label: "-6" },
      { db: -12, label: "-12" }
    ].forEach((row) => {
      const y = Math.round(h * 0.5 - (row.db / 15) * (h * 0.38)) + 0.5;
      ctx.strokeStyle = row.db === 0 ? pal.gridZero : pal.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      ctx.fillStyle = row.db === 0 ? pal.textSecondary : pal.textMuted;
      ctx.fillText(row.label, 5, y - 3);
    });

    // Frequency octave gridlines & labels
    [50, 100, 250, 500, 1000, 2000, 5000, 10000].forEach((f) => {
      const x = Math.round(freqToX(f)) + 0.5;
      ctx.strokeStyle = pal.grid;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.fillStyle = pal.textMuted;
      ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x + 3, h - 5);
    });

    // Live FFT spectrum from masterAnalyser when engine is running
    if (nodes && nodes.masterAnalyser && audioCtx) {
      const analyser = nodes.masterAnalyser;
      const binCount = analyser.frequencyBinCount;
      const freqBins = new Uint8Array(binCount);
      analyser.getByteFrequencyData(freqBins);
      const nyquist = (audioCtx.sampleRate || 48000) / 2;

      const rtaGrad = ctx.createLinearGradient(0, h, 0, 12);
      rtaGrad.addColorStop(0, colorWithAlpha(pal.accentSecondary, 0.16));
      rtaGrad.addColorStop(0.65, colorWithAlpha(pal.accentSecondary, 0.32));
      rtaGrad.addColorStop(1, colorWithAlpha(pal.accent, 0.48));
      ctx.fillStyle = rtaGrad;
      const bars = 72;
      for (let b = 0; b < bars; b += 1) {
        const f0 = minF * Math.pow(maxF / minF, b / bars);
        const f1 = minF * Math.pow(maxF / minF, (b + 1) / bars);
        const idx0 = Math.max(0, Math.floor((f0 / nyquist) * binCount));
        const idx1 = Math.min(binCount - 1, Math.max(idx0, Math.floor((f1 / nyquist) * binCount)));
        let maxVal = 0;
        for (let k = idx0; k <= idx1; k += 1) {
          if (freqBins[k] > maxVal) maxVal = freqBins[k];
        }
        const barH = (maxVal / 255) * (h - 18);
        const x0 = (b / bars) * w;
        const bw = Math.max(2, w / bars - 2);
        ctx.fillRect(x0, h - barH, bw, barH);
      }
    }

    // Parametric 5-Band EQ Curve + Band Nodes
    if (window.LiveStreamDsp && typeof window.LiveStreamDsp.computeEqCurvePoints === "function") {
      const pts = window.LiveStreamDsp.computeEqCurvePoints(activeConfig.master);
      const isBypassed = Boolean(activeConfig.master && activeConfig.master.bypass);
      const xy = pts.map((pt) => {
        const x = freqToX(pt.freq);
        const clampedDb = Math.max(-15, Math.min(15, pt.db));
        const y = h * 0.5 - (clampedDb / 15) * (h * 0.38);
        return { x, y };
      });

      if (xy.length > 0 && !isBypassed) {
        const grad = ctx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, colorWithAlpha(pal.accent, 0.3));
        grad.addColorStop(0.55, colorWithAlpha(pal.accent, 0.1));
        grad.addColorStop(1, colorWithAlpha(pal.accent, 0.01));
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(xy[0].x, h * 0.5);
        xy.forEach((p) => ctx.lineTo(p.x, p.y));
        ctx.lineTo(xy[xy.length - 1].x, h * 0.5);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.restore();
      }

      ctx.save();
      ctx.beginPath();
      xy.forEach((p, idx) => {
        if (idx === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      if (isBypassed) {
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = pal.textMuted;
      } else {
        ctx.strokeStyle = pal.accent;
        ctx.shadowColor = colorWithAlpha(pal.accent, 0.38);
        ctx.shadowBlur = 7;
      }
      ctx.lineWidth = 2.2;
      ctx.stroke();
      ctx.restore();

      const m = activeConfig.master || {};
      [
        { freq: 80, val: isBypassed ? 0 : Number(m.b80) || 0 },
        { freq: 250, val: isBypassed ? 0 : Number(m.b250) || 0 },
        { freq: 1000, val: isBypassed ? 0 : Number(m.b1k) || 0 },
        { freq: 3500, val: isBypassed ? 0 : Number(m.b3k5) || 0 },
        { freq: 10000, val: isBypassed ? 0 : Number(m.b10k) || 0 }
      ].forEach((b) => {
        const x = freqToX(b.freq);
        const y = h * 0.5 - (Math.max(-15, Math.min(15, b.val)) / 15) * (h * 0.38);
        ctx.beginPath();
        ctx.arc(x, y, 4.2, 0, Math.PI * 2);
        ctx.fillStyle = isBypassed ? pal.textMuted : pal.accent;
        ctx.fill();
        ctx.strokeStyle = pal.canvasBg;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      });
    }
  }

  function drawChannelProcCanvas() {
    const canvas = $("lsChannelProcCanvas");
    if (!canvas) return;
    const pal = getStudioPalette();
    const { ctx, w, h } = prepareHiDpiCanvas(canvas, 420, 116);

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = pal.canvasBg;
    ctx.fillRect(0, 0, w, h);

    if (activeProcTab === "reverb") {
      const rev = activeConfig.reverb || { wet: 14, decay: 1.4 };
      const wetNorm = Math.max(0, Math.min(1, Number(rev.wet || 0) / 100));
      const decay = Math.max(0.4, Math.min(3.5, Number(rev.decay || 1.4)));
      const preDelaySec = Math.max(0, Number(rev.preDelayMs || 0)) / 1000;
      const maxSec = 3.2;

      ctx.font = "600 9px ui-monospace, SFMono-Regular, Menlo, monospace";
      [0.5, 1.0, 1.5, 2.0, 2.5, 3.0].forEach((sec) => {
        const x = Math.round((sec / maxSec) * w) + 0.5;
        ctx.strokeStyle = pal.grid;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
        ctx.fillStyle = pal.textMuted;
        ctx.fillText(`${sec}s`, x + 3, h - 5);
      });

      ctx.strokeStyle = pal.gridZero;
      ctx.beginPath();
      ctx.moveTo(0, h - 18.5);
      ctx.lineTo(w, h - 18.5);
      ctx.stroke();

      const steps = 72;
      const baseLine = h - 18;
      const peakH = (h - 32) * Math.max(0.22, wetNorm * 1.55);

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(0, baseLine);
      for (let i = 0; i <= steps; i++) {
        const t = (i / steps) * maxSec;
        const env = t < preDelaySec ? 0.08 : Math.exp(-3.6 * ((t - preDelaySec) / decay));
        const y = baseLine - Math.min(h - 26, env * peakH);
        ctx.lineTo((i / steps) * w, y);
      }
      ctx.lineTo(w, baseLine);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, 12, 0, baseLine);
      grad.addColorStop(0, colorWithAlpha(pal.accent, 0.34));
      grad.addColorStop(1, colorWithAlpha(pal.accent, 0.02));
      ctx.fillStyle = grad;
      ctx.fill();

      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const t = (i / steps) * maxSec;
        const env = t < preDelaySec ? 0.08 : Math.exp(-3.6 * ((t - preDelaySec) / decay));
        const y = baseLine - Math.min(h - 26, env * peakH);
        if (i === 0) ctx.moveTo(0, y);
        else ctx.lineTo((i / steps) * w, y);
      }
      ctx.strokeStyle = pal.accent;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();

      const irTag = customReverbIrBuffer ? `CUSTOM IR: ${customReverbIrName}` : `RT60 ${decay.toFixed(1)}s · DAMP ${Math.round(Number(rev.toneHz || 7600) / 100) / 10}k · W ${rev.stereoWidth || 110}%`;
      ctx.fillStyle = pal.textSecondary;
      ctx.fillText(irTag, 8, 14);
      return;
    }

    const isVocal = activeProcTab === "vocal";
    const chCfg = isVocal ? activeConfig.vocal || {} : activeConfig.inst || {};
    const chDspM = isVocal ? vocalDspMeters : instDspMeters;
    const strokeAccent = isVocal ? pal.accentSecondary : pal.accent;
    const subTab = activeChSubTabs[isVocal ? "vocal" : "inst"] || "eq";

    // Draw true Dynamics Transfer Curve when inspecting Dynamics tab
    if (subTab === "dyn") {
      const thr = Number(chCfg.compThreshDb ?? (isVocal ? -18 : -16));
      const ratio = chCfg.comp ? Math.max(1, Number(chCfg.compRatio ?? (isVocal ? 3.5 : 2.5))) : 1;
      const gThr = Number(chCfg.gateThreshDb ?? (isVocal ? -50 : -54));
      const gFloor = Number(chCfg.gateRangeDb ?? (isVocal ? -14 : -12));
      const padL = 26;
      const padB = 16;
      const pw = w - padL - 12;
      const ph = h - padB - 14;
      const dbToX = (db) => padL + ((db + 60) / 60) * pw;
      const dbToY = (db) => 8 + (1 - (db + 60) / 60) * ph;

      ctx.font = "600 9px ui-monospace, SFMono-Regular, Menlo, monospace";
      [-48, -36, -24, -12, 0].forEach((db) => {
        const x = Math.round(dbToX(db)) + 0.5;
        const y = Math.round(dbToY(db)) + 0.5;
        ctx.strokeStyle = pal.grid;
        ctx.beginPath(); ctx.moveTo(x, 6); ctx.lineTo(x, h - padB); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - 8, y); ctx.stroke();
        ctx.fillStyle = pal.textMuted;
        ctx.fillText(String(db), 3, y + 3);
        ctx.fillText(String(db), x - 8, h - 4);
      });

      // Unity 1:1 line
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = pal.gridZero;
      ctx.beginPath();
      ctx.moveTo(dbToX(-60), dbToY(-60));
      ctx.lineTo(dbToX(0), dbToY(0));
      ctx.stroke();
      ctx.restore();

      // Transfer curve including Gate & Comp
      ctx.save();
      ctx.beginPath();
      for (let inDb = -60; inDb <= 0; inDb += 1) {
        let outDb = inDb;
        if (chCfg.gate && inDb < gThr) {
          outDb = Math.max(-60, inDb + gFloor);
        }
        if (chCfg.comp && outDb > thr) {
          outDb = thr + (outDb - thr) / ratio;
        }
        const x = dbToX(inDb);
        const y = dbToY(outDb);
        if (inDb === -60) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = strokeAccent;
      ctx.lineWidth = 2.2;
      ctx.stroke();
      ctx.restore();

      ctx.fillStyle = pal.textSecondary;
      const dsTag = isVocal ? ` · DE-ESS ${chDspM.deesserGrDb < -0.05 ? chDspM.deesserGrDb.toFixed(1) : "0.0"} dB` : "";
      ctx.fillText(
        `COMP ${chCfg.comp ? `${thr}dB ${ratio.toFixed(1)}:1` : "OFF"} (GR ${chDspM.compGrDb.toFixed(1)}dB)${dsTag}`,
        padL + 6,
        14
      );
      return;
    }

    const minF = 20;
    const maxF = 18000;
    const logRange = Math.log10(maxF / minF);
    const freqToX = (f) => (Math.log10(Math.max(minF, Math.min(maxF, f)) / minF) / logRange) * w;

    ctx.font = "600 9px ui-monospace, SFMono-Regular, Menlo, monospace";
    [12, 0, -12].forEach((db) => {
      const y = Math.round(h * 0.5 - (db / 16) * (h * 0.38)) + 0.5;
      ctx.strokeStyle = db === 0 ? pal.gridZero : pal.grid;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    });
    [60, 250, 1000, 4000, 10000].forEach((f) => {
      const x = Math.round(freqToX(f)) + 0.5;
      ctx.strokeStyle = pal.grid;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.fillStyle = pal.textMuted;
      ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x + 3, h - 4);
    });

    const freqs = [];
    for (let i = 0; i <= 72; i++) {
      freqs.push(minF * Math.pow(maxF / minF, i / 72));
    }
    const curvePts =
      window.LiveStreamDsp && typeof window.LiveStreamDsp.computeChannelEqCurvePoints === "function"
        ? window.LiveStreamDsp.computeChannelEqCurvePoints(chCfg, {
          isVocal,
          freqs,
          dynamicDeessGrDb: isVocal ? chDspM.deesserGrDb : 0
        })
        : freqs.map((f) => ({ freq: f, db: 0 }));

    const pts = curvePts.map((pt) => {
      const clampedDb = Math.max(-16, Math.min(14, pt.db));
      return {
        freq: pt.freq,
        x: freqToX(pt.freq),
        y: h * 0.5 - (clampedDb / 16) * (h * 0.38)
      };
    });

    const isEqBypass = Boolean(chCfg.eqBypass);
    if (!isEqBypass) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(pts[0].x, h * 0.5);
      pts.forEach((p) => ctx.lineTo(p.x, p.y));
      ctx.lineTo(pts[pts.length - 1].x, h * 0.5);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, colorWithAlpha(strokeAccent, 0.28));
      grad.addColorStop(1, colorWithAlpha(strokeAccent, 0.02));
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.restore();
    }

    ctx.save();
    ctx.beginPath();
    pts.forEach((p, idx) => (idx === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    if (isEqBypass) {
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = pal.textMuted;
    } else {
      ctx.strokeStyle = strokeAccent;
    }
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();

    const lowFreq = Number(chCfg.lowFreq) || (isVocal ? 220 : 90);
    const midFreq = Number(chCfg.midFreq) || (isVocal ? 3200 : 450);
    const highFreq = Number(chCfg.highFreq) || (isVocal ? 9000 : 4500);
    [lowFreq, midFreq, highFreq].forEach((bf) => {
      const nearest = pts.reduce((best, p) => (Math.abs(p.freq - bf) < Math.abs(best.freq - bf) ? p : best), pts[0]);
      ctx.beginPath();
      ctx.arc(freqToX(bf), nearest.y, 3.6, 0, Math.PI * 2);
      ctx.fillStyle = isEqBypass ? pal.textMuted : strokeAccent;
      ctx.fill();
      ctx.strokeStyle = pal.canvasBg;
      ctx.lineWidth = 1.2;
      ctx.stroke();
    });

    ctx.fillStyle = pal.textSecondary;
    ctx.fillText(
      isEqBypass
        ? "CHANNEL EQ BYPASSED"
        : isVocal
          ? `HPF ${chCfg.hpf}Hz (${chCfg.hpfSlope || 12}dB) · MID ${Math.round(midFreq)}Hz · DE-ESS ${chDspM.deesserGrDb < -0.05 ? chDspM.deesserGrDb.toFixed(1) : "0.0"}dB`
          : `HPF ${chCfg.hpf}Hz (${chCfg.hpfSlope || 12}dB) · MID ${Math.round(midFreq)}Hz · SEND ${chCfg.reverbSend ?? 65}%`,
      6,
      13
    );
  }

  function updateMetersLoop() {
    if (!nodes || !audioCtx) return;

    function measurePeakRms(analyser, fillEl, clipEl, peakTextEl, rmsTextEl) {
      if (!analyser) return;
      const arr = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(arr);
      let peak = 0;
      let sumSq = 0;
      for (let i = 0; i < arr.length; i++) {
        const s = arr[i];
        const a = Math.abs(s);
        if (a > peak) peak = a;
        sumSq += s * s;
      }
      const rms = Math.sqrt(sumSq / arr.length);
      const db = peak > 0.00001 ? 20 * Math.log10(peak) : -60;
      const rmsDb = rms > 0.00001 ? 20 * Math.log10(rms) : -60;
      const pct = Math.max(0, Math.min(100, ((db + 54) / 54) * 100));
      if (fillEl) {
        if (fillEl.dataset && fillEl.dataset.meterOrient === "vertical") {
          fillEl.style.height = `${pct.toFixed(1)}%`;
        } else {
          fillEl.style.width = `${pct.toFixed(1)}%`;
        }
      }
      if (peakTextEl) {
        peakTextEl.textContent = db <= -59.5 ? "-∞ dB" : `${db.toFixed(1)} dB`;
      }
      if (rmsTextEl) {
        rmsTextEl.textContent = rmsDb <= -59.5 ? "-∞ dB" : `${rmsDb.toFixed(1)} dB`;
      }
      if (clipEl) {
        clipEl.classList.toggle("is-clipping", peak >= 0.96);
      }
    }

    function applyGrReadout(grDb, barId, valId) {
      const bar = $(barId);
      const val = $(valId);
      const clamped = Math.min(0, Number(grDb) || 0);
      if (bar) bar.style.width = `${Math.max(0, Math.min(100, (Math.abs(clamped) / 18) * 100)).toFixed(1)}%`;
      if (val) val.textContent = `${clamped.toFixed(1)} dB`;
    }

    measurePeakRms(nodes.instAnalyser, $("lsInstMeterFill"), $("lsInstClip"), $("lsInstPeakVal"), $("lsInstRmsVal"));
    measurePeakRms(nodes.vocalAnalyser, $("lsVocalMeterFill"), $("lsVocalClip"), $("lsVocalPeakVal"), $("lsVocalRmsVal"));
    if (nodes.reverbAnalyser) {
      measurePeakRms(nodes.reverbAnalyser, $("lsReverbMeterFill"), null, null, null);
    }

    // Pre-routing physical hardware input pin telemetry (when engine captures directly from device or file)
    if (Array.isArray(nodes.rawPinAnalysers) && nodes.rawPinAnalysers.length > 0 && activeSourceMode !== "asio") {
      const peaks = [];
      const rmsList = [];
      const floors = [];
      const snrs = [];
      const activePins = [];
      let dot01 = 0;
      let e0 = 0;
      let e1 = 0;
      const ch0Samples = nodes.rawPinAnalysers.length >= 2 ? new Float32Array(pinFloatScratch.length) : null;
      for (let p = 0; p < nodes.rawPinAnalysers.length; p++) {
        const an = nodes.rawPinAnalysers[p];
        an.getFloatTimeDomainData(pinFloatScratch);
        if (p === 0 && ch0Samples) ch0Samples.set(pinFloatScratch);
        let pk = 0;
        let sq = 0;
        for (let i = 0; i < pinFloatScratch.length; i++) {
          const s = pinFloatScratch[i];
          const a = s < 0 ? -s : s;
          if (a > pk) pk = a;
          sq += s * s;
          if (p === 1 && ch0Samples) {
            const s0 = ch0Samples[i];
            dot01 += s0 * s;
            e0 += s0 * s0;
            e1 += s * s;
          }
        }
        const rms = Math.sqrt(sq / pinFloatScratch.length);
        const pDb = pk > 1e-5 ? Number((20 * Math.log10(pk)).toFixed(1)) : -96;
        const rDb = rms > 1e-5 ? Number((20 * Math.log10(rms)).toFixed(1)) : -96;
        let curFl = pinNoiseFloorsDb[p];
        if (curFl == null) curFl = Math.max(-90, Math.min(-28, rDb > -92 ? rDb : -72));
        else if (rDb < curFl) curFl = curFl + 0.35 * (Math.max(-90, rDb) - curFl);
        else if ((pDb - rDb) < 6.5 && rDb < -28) curFl = curFl + 0.04 * (rDb - curFl);
        curFl = Math.max(-90, Math.min(-28, curFl));
        pinNoiseFloorsDb[p] = curFl;
        const floorVal = Number(curFl.toFixed(1));
        const snr = Number((pDb - floorVal).toFixed(1));
        peaks.push(pDb);
        rmsList.push(rDb);
        floors.push(floorVal);
        snrs.push(snr);
        if (pDb > -45 && (snr >= 9 || pDb >= -24)) activePins.push(p);
      }
      const corr01 = (e0 > 1e-9 && e1 > 1e-9) ? Number((dot01 / Math.sqrt(e0 * e1)).toFixed(3)) : 0;
      const duplicatedMono = peaks.length >= 2 && corr01 > 0.97 && Math.abs(peaks[0] - peaks[1]) < 1.2 && peaks[0] > -55;
      livePinLevels.channels = peaks.length;
      livePinLevels.peaksDb = peaks;
      livePinLevels.rmsDb = rmsList;
      livePinLevels.noiseFloorsDb = floors;
      livePinLevels.snrDb = snrs;
      livePinLevels.activePins = activePins;
      livePinLevels.corr01 = corr01;
      livePinLevels.duplicatedMono = duplicatedMono;
      livePinLevels.standby = false;
      livePinLevels.updatedAt = Date.now();
      evaluateInputLearnSample();
      renderLivePinDetectionUi(false);
    }

    // Master Stereo L/R + BS.1770-4 True-Peak & Short-Term LUFS from bp-pcm-capture
    if (masterTelem.kwRing.length > 0) {
      const dbL = masterTelem.peakL > 0.00001 ? 20 * Math.log10(masterTelem.peakL) : -60;
      const dbR = masterTelem.peakR > 0.00001 ? 20 * Math.log10(masterTelem.peakR) : -60;
      const pctL = Math.max(0, Math.min(100, ((dbL + 54) / 54) * 100));
      const pctR = Math.max(0, Math.min(100, ((dbR + 54) / 54) * 100));
      if ($("lsMasterMeterFill")) $("lsMasterMeterFill").style.height = `${pctL.toFixed(1)}%`;
      if ($("lsMasterMeterFillR")) $("lsMasterMeterFillR").style.height = `${pctR.toFixed(1)}%`;

      const tpDb = masterTelem.truePeak > 0.00001 ? 20 * Math.log10(masterTelem.truePeak) : -60;
      if ($("lsMasterPeakVal")) {
        $("lsMasterPeakVal").textContent = tpDb <= -59.5 ? "-∞ dBTP" : `${tpDb.toFixed(1)} dBTP`;
      }
      const rmsSt = Math.sqrt(0.5 * (masterTelem.rmsL * masterTelem.rmsL + masterTelem.rmsR * masterTelem.rmsR));
      const rmsDb = rmsSt > 0.00001 ? 20 * Math.log10(rmsSt) : -60;
      if ($("lsMasterRmsVal")) {
        $("lsMasterRmsVal").textContent = rmsDb <= -59.5 ? "-∞ dB" : `${rmsDb.toFixed(1)} dB`;
      }
      if ($("lsMasterLufsVal")) {
        $("lsMasterLufsVal").textContent = Number.isFinite(masterTelem.shortTermLufs) && masterTelem.shortTermLufs > -70
          ? `${masterTelem.shortTermLufs.toFixed(1)} LUFS`
          : "-∞ LUFS";
      }
      if ($("lsMasterClip")) {
        $("lsMasterClip").classList.toggle("is-clipping", tpDb >= -0.2);
      }
    } else {
      measurePeakRms(
        nodes.masterAnalyser,
        $("lsMasterMeterFill"),
        $("lsMasterClip"),
        $("lsMasterPeakVal"),
        $("lsMasterRmsVal")
      );
      if ($("lsMasterMeterFillR") && $("lsMasterMeterFill")) {
        $("lsMasterMeterFillR").style.height = $("lsMasterMeterFill").style.height;
      }
    }

    if (nodes.vocalProDspNode) {
      applyGrReadout(vocalDspMeters.compGrDb, "lsVocalGrBar", "lsVocalGrVal");
      applyGrReadout(vocalDspMeters.deesserGrDb, "lsVocalDeessGrBar", "lsVocalDeessGrVal");
      if ($("lsVocalGateGrVal")) {
        $("lsVocalGateGrVal").textContent = `${Math.min(0, vocalDspMeters.gateGainDb || 0).toFixed(1)} dB`;
      }
    } else {
      updateGrBar(nodes.vocalComp, "lsVocalGrBar", "lsVocalGrVal");
    }

    if (nodes.instProDspNode) {
      applyGrReadout(instDspMeters.compGrDb, "lsInstGrBar", "lsInstGrVal");
      if ($("lsInstGateGrVal")) {
        $("lsInstGateGrVal").textContent = `${Math.min(0, instDspMeters.gateGainDb || 0).toFixed(1)} dB`;
      }
    } else if (nodes.instComp) {
      updateGrBar(nodes.instComp, "lsInstGrBar", "lsInstGrVal");
    }

    if (nodes.masterProDspNode) {
      applyGrReadout(masterDspMeters.limiterGrDb, "lsLimiterGrBar", "lsLimiterGrVal");
    } else {
      updateGrBar(nodes.limiter, "lsLimiterGrBar", "lsLimiterGrVal");
    }

    if ($("lsMasterGrVal") && $("lsLimiterGrVal")) {
      $("lsMasterGrVal").textContent = $("lsLimiterGrVal").textContent;
    }
    drawEqAndSpectrum();
    if (activeProcTab === "vocal" && activeChSubTabs.vocal === "dyn") drawChannelProcCanvas();
    if (activeProcTab === "inst" && activeChSubTabs.inst === "dyn") drawChannelProcCanvas();

    meterRaf = window.requestAnimationFrame(updateMetersLoop);
  }

  function refreshSoundcheckUi() {
    if (!soundcheckSession || !window.LiveStreamSoundcheck) return;
    soundcheckSession.swapChannels = Boolean(activeConfig.swapChannels);
    soundcheckSession.singleChannelAllowed = Boolean($("lsScSingleOkCheck")?.checked);
    const ready = window.LiveStreamSoundcheck.evaluateReadiness(soundcheckSession, {
      requireDualInput: activeConfig.mode !== "stereo"
    });
    if ($("lsScDeviceName")) $("lsScDeviceName").textContent = soundcheckSession.deviceName || "Audio Input";
    if ($("lsScFormat")) {
      const drv = activeHardwareCaptureFormat && activeHardwareCaptureFormat.driver
        ? activeHardwareCaptureFormat.driver
        : String(soundcheckSession.sourceType || "wasapi").toUpperCase();
      const bitTag = activeHardwareCaptureFormat && activeHardwareCaptureFormat.sampleSizeBits
        ? `${activeHardwareCaptureFormat.sampleSizeBits}-bit in`
        : "Float32 DSP";
      $("lsScFormat").textContent = `${drv} · ${soundcheckSession.sampleRate} Hz · ${soundcheckSession.channelCount} ch (${bitTag})`;
    }
    if ($("lsScConnBadge")) {
      $("lsScConnBadge").textContent = soundcheckSession.connected
        ? "Connected & Streaming"
        : (soundcheckSession.disconnectedReason || "Disconnected");
      $("lsScConnBadge").style.color = soundcheckSession.connected
        ? "var(--studio-success, #22c55e)"
        : "var(--studio-danger, #dc4148)";
    }
    const latest = soundcheckSession.latest || {};
    if ($("lsScCh1Stats")) {
      const p1 = Number.isFinite(latest.vocalPeakDb) && latest.vocalPeakDb > -95 ? `${latest.vocalPeakDb.toFixed(1)}` : "-inf";
      const r1 = Number.isFinite(latest.vocalRmsDb) && latest.vocalRmsDb > -95 ? `${latest.vocalRmsDb.toFixed(1)}` : "-inf";
      const nf1 = Number.isFinite(latest.noiseFloorVocalDb) && latest.noiseFloorVocalDb > -95 ? `${latest.noiseFloorVocalDb.toFixed(1)}` : "--";
      $("lsScCh1Stats").textContent = `In 1 Vocals: Peak ${p1} | RMS ${r1} | Floor ${nf1} dB | Clips ${soundcheckSession.clipCountVocal || 0}`;
    }
    if ($("lsScCh2Stats")) {
      const p2 = Number.isFinite(latest.instPeakDb) && latest.instPeakDb > -95 ? `${latest.instPeakDb.toFixed(1)}` : "-inf";
      const r2 = Number.isFinite(latest.instRmsDb) && latest.instRmsDb > -95 ? `${latest.instRmsDb.toFixed(1)}` : "-inf";
      const nf2 = Number.isFinite(latest.noiseFloorInstDb) && latest.noiseFloorInstDb > -95 ? `${latest.noiseFloorInstDb.toFixed(1)}` : "--";
      $("lsScCh2Stats").textContent = `In 2 Inst: Peak ${p2} | RMS ${r2} | Floor ${nf2} dB | Clips ${soundcheckSession.clipCountInst || 0}`;
    }
    if ($("lsScStage1Btn")) $("lsScStage1Btn").classList.toggle("is-toggled", Boolean(soundcheckSession.stage1Pass));
    if ($("lsScStage2Btn")) $("lsScStage2Btn").classList.toggle("is-toggled", Boolean(soundcheckSession.stage2Pass));
    if ($("lsScStage3Btn")) $("lsScStage3Btn").classList.toggle("is-toggled", Boolean(soundcheckSession.stage3Pass));

    const corr = latest.corr12;
    if ($("lsScCorrBadge")) {
      if (corr === null || corr === undefined) {
        $("lsScCorrBadge").textContent = "Corr: --";
      } else {
        const sep = Math.abs((latest.vocalPeakDb || -96) - (latest.instPeakDb || -96));
        $("lsScCorrBadge").textContent = `Corr: ${corr.toFixed(2)} · Sep ${sep.toFixed(1)} dB`;
      }
    }
    if ($("lsScNoiseBadge")) {
      const nf = latest.noiseFloorVocalDb;
      $("lsScNoiseBadge").textContent = nf > -95 ? `Floor: ${nf.toFixed(1)} dB` : "Floor: -- dB";
    }
    if ($("lsScStatusText")) {
      $("lsScStatusText").textContent = ready.message;
    }
    if ($("lsScSummaryBadge")) {
      const ok = Boolean(ready.ready && ready.severity === "ok");
      $("lsScSummaryBadge").textContent = ok ? "Soundcheck Verified" : (ready.canRecordDualStems ? "Ready (Verify Stages)" : "Soundcheck Alert");
      $("lsScSummaryBadge").classList.toggle("is-verified", ok);
    }
    if ($("lsMonoWarning")) {
      const monoAlert = Boolean(
        soundcheckSession.monoDuplicationDetected &&
        !soundcheckSession.singleChannelAllowed &&
        activeConfig.mode !== "stereo"
      );
      $("lsMonoWarning").style.display = monoAlert ? "block" : "none";
      if (monoAlert) $("lsMonoWarning").textContent = ready.message;
    }
  }

  async function initAudioEngine(requestedMode) {
    const backendSel = $("lsCaptureBackendSelect");
    const defaultBackendMode = backendSel && backendSel.value === "asio" ? "asio" : "device";
    const mode = requestedMode || activeSourceMode || defaultBackendMode;
    const requestedRate = Number($("lsHwSampleRateSelect")?.value || 48000);
    const requestedLatencyHint = ($("lsHwBufferSelect")?.value || "interactive");
    if (
      audioCtx &&
      activeSourceMode === mode &&
      ((mode === "device" && mediaStream) ||
        (mode === "asio" && asioSocket && asioSocket.readyState === 1) ||
        (mode === "file" && testFileAudioEl))
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

    if (mode === "asio" && bridgeMonitorSocket) {
      try {
        bridgeMonitorSocket.onclose = null;
        bridgeMonitorSocket.close();
      } catch (_) { }
      bridgeMonitorSocket = null;
    }

    activeSourceMode = mode;
    let hwChannels = 1;
    let hwRate = requestedRate;
    let hwSampleSize = null;
    let deviceLabel = "Audio Interface";
    let driverLabel = "Browser WASAPI (Shared)";

    if (mode === "file") {
      if (!testFileUrl) {
        throw new Error("Please select an audio file (MP3/WAV) first.");
      }
      testFileAudioEl = document.createElement("audio");
      testFileAudioEl.src = testFileUrl;
      testFileAudioEl.loop = Boolean($("lsTestFileLoopCheck")?.checked);
      testFileAudioEl.preload = "auto";
      hwChannels = 2;
      deviceLabel = testFileObj ? testFileObj.name : "Test File";
      driverLabel = "Local File Playback";
      activeDetectedChannelCount = 2;
      activeDetectedDeviceName = deviceLabel;
      activeDetectedDriverName = driverLabel;
      activeChannelCatalog = buildDetectedChannelCatalog(deviceLabel, 2);
      reconcileRoutingWithCatalog(activeChannelCatalog);
      emitHardwareCatalogChanged();
    } else if (mode === "asio") {
      driverLabel = "Local Bridge (ws://127.0.0.1:17940)";
      deviceLabel = "Windows Audio Bridge";
      const wsInfo = await new Promise((resolve, reject) => {
        let settled = false;
        let helloWaitTimer = null;
        const sock = new WebSocket("ws://127.0.0.1:17940");
        sock.binaryType = "arraybuffer";
        const connTimer = setTimeout(() => {
          if (!settled) {
            settled = true;
            try { sock.close(); } catch (_) { }
            reject(
              new Error(
                "Local Audio Bridge not running on ws://127.0.0.1:17940. Run `python scripts/local_asio_bridge.py` on your laptop first."
              )
            );
          }
        }, 3500);
        sock.onopen = () => {
          asioSocket = sock;
          clearTimeout(connTimer);
          if (preferredBridgeDeviceId && preferredBridgeDeviceId !== "none") {
            try {
              sock.send(JSON.stringify({ type: "select-device", deviceId: preferredBridgeDeviceId }));
            } catch (_) { }
          }
          if (rawMcSubscribers.size > 0) {
            try {
              sock.send(JSON.stringify({ type: "set-multichannel-tap", enabled: true }));
            } catch (_) { }
          }
          try {
            lastSentBridgeRouting = `${activeConfig.ch1InputSource}|${activeConfig.ch2InputSource}`;
            sock.send(
              JSON.stringify({
                type: "set-routing",
                ch1: activeConfig.ch1InputSource,
                ch2: activeConfig.ch2InputSource
              })
            );
          } catch (_) { }
          helloWaitTimer = setTimeout(() => {
            if (!settled) {
              settled = true;
              resolve({ sampleRate: requestedRate, channels: 2 });
            }
          }, 700);
        };
        sock.onmessage = (ev) => {
          if (typeof ev.data === "string") {
            try {
              const meta = JSON.parse(ev.data);
              if (meta && meta.type === "bridge-info") {
                if (!settled) {
                  settled = true;
                  clearTimeout(helloWaitTimer);
                  if (meta.standby || Number(meta.channels) === 0) {
                    handleBridgeInfoMeta(meta);
                    try { sock.close(); } catch (_) { }
                    if (asioSocket === sock) asioSocket = null;
                    reject(
                      new Error(
                        "Audio Bridge is in Standby (no external USB/ASIO interface detected). Plug in your interface or pick a Built-in Input from the dropdown."
                      )
                    );
                    return;
                  }
                  resolve({
                    sampleRate: Number(meta.sampleRate) || requestedRate,
                    channels: Number(meta.channels) || 2,
                    meta
                  });
                }
              }
            } catch (_) { }
          }
        };
        sock.onerror = () => {
          if (!settled) {
            settled = true;
            clearTimeout(connTimer);
            clearTimeout(helloWaitTimer);
            reject(
              new Error(
                "Could not connect to Local Audio Bridge (ws://127.0.0.1:17940). Start `python scripts/local_asio_bridge.py` or switch to Browser WASAPI."
              )
            );
          }
        };
      });
      hwChannels = wsInfo.channels || 2;
      hwRate = wsInfo.sampleRate || requestedRate;
      if (wsInfo.meta) {
        deviceLabel = wsInfo.meta.deviceName || deviceLabel;
        driverLabel = wsInfo.meta.hostApi || driverLabel;
        handleBridgeInfoMeta(wsInfo.meta);
      }
    } else {
      const inSel = $("lsAudioInputSelect");
      const deviceId = inSel && inSel.value ? inSel.value : undefined;
      deviceLabel = inSel && inSel.options[inSel.selectedIndex] ? inSel.options[inSel.selectedIndex].textContent : "Default Input";

      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId ? { ideal: deviceId } : undefined,
          channelCount: { ideal: 2 },
          sampleRate: { ideal: requestedRate },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      });

      await refreshAudioDevices(false);

      const track = mediaStream.getAudioTracks()[0];
      if (track && track.label) deviceLabel = track.label;
      if (track && typeof track.addEventListener === "function") {
        track.addEventListener("ended", () => {
          if (soundcheckSession && window.LiveStreamSoundcheck) {
            window.LiveStreamSoundcheck.markDisconnected(soundcheckSession, "USB audio interface disconnected");
            refreshSoundcheckUi();
          }
          showStudioMessage("Audio interface disconnected! Reconnect USB cable and re-run Soundcheck.", true);
        });
      }
      const settings = track && typeof track.getSettings === "function" ? track.getSettings() : {};
      hwChannels = Math.max(1, settings.channelCount || 1);
      hwRate = settings.sampleRate || requestedRate;
      hwSampleSize = Number.isFinite(Number(settings.sampleSize)) ? Number(settings.sampleSize) : null;

      const cleanDev = cleanHardwareDeviceLabel(deviceLabel);
      activeDetectedChannelCount = hwChannels;
      activeDetectedDeviceName = cleanDev;
      activeDetectedDriverName = driverLabel;
      activeChannelCatalog = buildDetectedChannelCatalog(cleanDev, hwChannels);
      reconcileRoutingWithCatalog(activeChannelCatalog);
      renderInputChannelSelectors();
      emitHardwareCatalogChanged();
      renderLivePinDetectionUi(true);
    }

    activeHardwareCaptureFormat = {
      driver: driverLabel,
      deviceName: deviceLabel,
      sampleRate: hwRate,
      channelCount: hwChannels,
      sampleSizeBits: hwSampleSize,
      exportBitDepth: Number($("lsDryBitDepthSelect")?.value || 24)
    };

    const hwPill = $("lsHwInfoPill");
    if (hwPill) {
      hwPill.textContent =
        mode === "file"
          ? `Test File (${testFileObj ? testFileObj.name : "Audio"}) · ${hwRate} Hz · 2 ch`
          : `${driverLabel} · ${hwRate} Hz · ${hwChannels} ch`;
    }

    const monoWarn = $("lsMonoWarning");
    if (monoWarn) {
      monoWarn.style.display =
        mode === "device" && hwChannels < 2 && activeConfig.mode === "split" ? "block" : "none";
    }

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioCtx({
      sampleRate: hwRate,
      latencyHint: requestedLatencyHint
    });
    if (audioCtx.state === "suspended") {
      await audioCtx.resume();
    }

    await audioCtx.audioWorklet.addModule("/js/live-stream-worklet.js?v=2.0");

    let source;
    if (mode === "file") {
      source = audioCtx.createMediaElementSource(testFileAudioEl);
    } else if (mode === "asio" && asioSocket) {
      const asioNode = new AudioWorkletNode(audioCtx, "bp-asio-ingest", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2]
      });
      asioSocket.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          try {
            const meta = JSON.parse(ev.data);
            if (meta.type === "bridge-info") {
              if (meta.deviceName) deviceLabel = meta.deviceName;
              if (meta.hostApi) driverLabel = meta.hostApi;
              if (soundcheckSession) {
                soundcheckSession.deviceName = meta.deviceName || soundcheckSession.deviceName;
                soundcheckSession.channelCount = Number(meta.channels) || soundcheckSession.channelCount;
                soundcheckSession.sourceType = meta.isAsio ? "asio" : (meta.isExclusive ? "asio" : "wasapi");
              }
              if (activeHardwareCaptureFormat) {
                activeHardwareCaptureFormat.driver = meta.hostApi || driverLabel;
                activeHardwareCaptureFormat.deviceName = meta.deviceName || deviceLabel;
                activeHardwareCaptureFormat.channelCount = Number(meta.channels) || hwChannels;
              }
              handleBridgeInfoMeta(meta);
            } else if (meta.type === "input-levels") {
              handleLivePinLevelsMessage(meta);
              return;
            } else if (meta.type === "asio-panel-status") {
              showStudioMessage(meta.message || "ASIO panel request handled.", !meta.opened);
            } else if (meta.deviceName && soundcheckSession) {
              soundcheckSession.deviceName = meta.deviceName;
            }
            if (meta.xruns !== undefined) asioXruns = Number(meta.xruns) || 0;
            refreshSoundcheckUi();
          } catch (_) { }
          return;
        }
        if (ev.data instanceof ArrayBuffer && ev.data.byteLength >= 8) {
          const view = new DataView(ev.data);
          if (
            view.getUint8(0) === 0x42 &&
            view.getUint8(1) === 0x50 &&
            view.getUint8(2) === 0x41 &&
            view.getUint8(3) === 0x53
          ) {
            const count = view.getUint32(4, true);
            const ch1 = new Float32Array(ev.data, 8, count);
            const ch2 = new Float32Array(ev.data, 8 + count * 4, count);
            const c1Copy = new Float32Array(ch1);
            const c2Copy = new Float32Array(ch2);
            asioNode.port.postMessage({ type: "asio-pcm", ch1: c1Copy, ch2: c2Copy, channels: hwChannels }, [
              c1Copy.buffer,
              c2Copy.buffer
            ]);
          } else {
            dispatchBpmcBinaryPacket(ev.data);
          }
        }
      };
      asioSocket.onclose = () => {
        if (soundcheckSession && window.LiveStreamSoundcheck) {
          window.LiveStreamSoundcheck.markDisconnected(soundcheckSession, "ASIO bridge disconnected");
          refreshSoundcheckUi();
        }
      };
      source = asioNode;
    } else {
      source = audioCtx.createMediaStreamSource(mediaStream);
    }

    try {
      source.channelInterpretation = "discrete";
    } catch (_) { }
    const splitterCount = mode === "asio" ? 2 : Math.max(1, hwChannels, source.channelCount || 1);
    const splitter = audioCtx.createChannelSplitter(splitterCount);
    try {
      splitter.channelCount = splitterCount;
      splitter.channelCountMode = "explicit";
      splitter.channelInterpretation = "discrete";
    } catch (_) { }
    source.connect(splitter);

    if (mode === "file" && testFileAudioEl) {
      await testFileAudioEl.play();
    }

    // Channel routing matrix: supports arbitrary N-pin hardware inputs -> CH 1 (Vocals) & CH 2 (Instruments)
    const rawPinAnalysers = [];
    const ch1PinGains = [];
    const ch2PinGains = [];
    for (let pin = 0; pin < splitterCount; pin++) {
      const g1 = audioCtx.createGain();
      const g2 = audioCtx.createGain();
      splitter.connect(g1, pin);
      splitter.connect(g2, pin);
      ch1PinGains.push(g1);
      ch2PinGains.push(g2);
      if (mode !== "asio" && pin < hwChannels) {
        const pinAn = audioCtx.createAnalyser();
        pinAn.fftSize = 256;
        pinAn.smoothingTimeConstant = 0.25;
        splitter.connect(pinAn, pin);
        rawPinAnalysers.push(pinAn);
      }
    }
    const ch1FromL = ch1PinGains[0];
    const ch1FromR = ch1PinGains[1] || null;
    const ch2FromL = ch2PinGains[0];
    const ch2FromR = ch2PinGains[1] || null;

    // Ch1 Vocals: Trim -> HPF1/HPF2 -> LPF -> 3-Band EQ -> ProDSP -> (Pre-Fader PFL & Send) -> Fader -> Mute -> Post-Fader Send -> Pan -> Analyser -> Mix
    const vocalTrimGain = audioCtx.createGain();
    const vocalHpf = audioCtx.createBiquadFilter();
    vocalHpf.type = "highpass";
    vocalHpf.Q.value = 0.707;
    const vocalHpf2 = audioCtx.createBiquadFilter();
    vocalHpf2.type = "highpass";
    vocalHpf2.Q.value = 0.707;
    vocalHpf2.frequency.value = 10;
    const vocalLpf = audioCtx.createBiquadFilter();
    vocalLpf.type = "lowpass";
    vocalLpf.Q.value = 0.707;
    vocalLpf.frequency.value = 20000;
    const vocalEqLow = audioCtx.createBiquadFilter();
    vocalEqLow.type = "lowshelf";
    vocalEqLow.frequency.value = 220;
    const vocalEqMid = audioCtx.createBiquadFilter();
    vocalEqMid.type = "peaking";
    vocalEqMid.frequency.value = 3200;
    vocalEqMid.Q.value = 1.1;
    let vocalProDspNode = null;
    try {
      vocalProDspNode = new AudioWorkletNode(audioCtx, "bp-pro-dsp", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1]
      });
      vocalProDspNode.port.onmessage = (ev) => {
        if (ev.data && ev.data.type === "dsp-meters") {
          vocalDspMeters = ev.data;
        }
      };
    } catch (_) {
      vocalProDspNode = null;
    }
    const vocalDeesser = audioCtx.createBiquadFilter();
    vocalDeesser.type = "peaking";
    vocalDeesser.frequency.value = 6500;
    vocalDeesser.Q.value = 3.2;
    const vocalEqHigh = audioCtx.createBiquadFilter();
    vocalEqHigh.type = "highshelf";
    vocalEqHigh.frequency.value = 9000;
    const vocalComp = audioCtx.createDynamicsCompressor();
    vocalComp.knee.value = 10;
    vocalComp.attack.value = 0.006;
    vocalComp.release.value = 0.16;
    const vocalGain = audioCtx.createGain();
    const vocalMuteGain = audioCtx.createGain();
    const vocalAnalyser = audioCtx.createAnalyser();
    vocalAnalyser.fftSize = 1024;
    const vocalPreRevSendGain = audioCtx.createGain();
    const vocalPostRevSendGain = audioCtx.createGain();
    const vocalPanner = typeof audioCtx.createStereoPanner === "function" ? audioCtx.createStereoPanner() : null;

    ch1PinGains.forEach((g) => g.connect(vocalTrimGain));
    let vocalPreFader = vocalTrimGain
      .connect(vocalHpf)
      .connect(vocalHpf2)
      .connect(vocalLpf)
      .connect(vocalEqLow)
      .connect(vocalEqMid);
    if (vocalProDspNode) {
      vocalPreFader = vocalPreFader.connect(vocalProDspNode);
    }
    vocalPreFader = vocalPreFader
      .connect(vocalDeesser)
      .connect(vocalEqHigh)
      .connect(vocalComp);

    const vocalPostFader = vocalPreFader
      .connect(vocalGain)
      .connect(vocalMuteGain);
    vocalPostFader.connect(vocalAnalyser);
    let vocalOut = vocalPostFader;
    if (vocalPanner) {
      vocalOut = vocalPostFader.connect(vocalPanner);
    }

    // Ch2 Instruments: Trim -> HPF1/HPF2 -> LPF -> 3-Band EQ -> ProDSP -> (Pre-Fader PFL & Send) -> Fader -> Mute -> Post-Fader Send -> Pan -> Analyser -> Mix
    const instTrimGain = audioCtx.createGain();
    const instHpf = audioCtx.createBiquadFilter();
    instHpf.type = "highpass";
    instHpf.Q.value = 0.707;
    const instHpf2 = audioCtx.createBiquadFilter();
    instHpf2.type = "highpass";
    instHpf2.Q.value = 0.707;
    instHpf2.frequency.value = 10;
    const instLpf = audioCtx.createBiquadFilter();
    instLpf.type = "lowpass";
    instLpf.Q.value = 0.707;
    instLpf.frequency.value = 20000;
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
    let instProDspNode = null;
    try {
      instProDspNode = new AudioWorkletNode(audioCtx, "bp-pro-dsp", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1]
      });
      instProDspNode.port.onmessage = (ev) => {
        if (ev.data && ev.data.type === "dsp-meters") {
          instDspMeters = ev.data;
        }
      };
    } catch (_) {
      instProDspNode = null;
    }
    const instComp = audioCtx.createDynamicsCompressor();
    instComp.knee.value = 8;
    instComp.attack.value = 0.014;
    instComp.release.value = 0.18;
    const instGain = audioCtx.createGain();
    const instMuteGain = audioCtx.createGain();
    const instAnalyser = audioCtx.createAnalyser();
    instAnalyser.fftSize = 1024;
    const instPreRevSendGain = audioCtx.createGain();
    const instPostRevSendGain = audioCtx.createGain();
    const instPanner = typeof audioCtx.createStereoPanner === "function" ? audioCtx.createStereoPanner() : null;

    ch2PinGains.forEach((g) => g.connect(instTrimGain));
    let instPreFader = instTrimGain
      .connect(instHpf)
      .connect(instHpf2)
      .connect(instLpf)
      .connect(instEqLow)
      .connect(instEqMid)
      .connect(instEqHigh);
    if (instProDspNode) {
      instPreFader = instPreFader.connect(instProDspNode);
    }
    instPreFader = instPreFader.connect(instComp);

    const instPostFader = instPreFader
      .connect(instGain)
      .connect(instMuteGain);
    instPostFader.connect(instAnalyser);
    let instOut = instPostFader;
    if (instPanner) {
      instOut = instPostFader.connect(instPanner);
    }

    // Stereo Pan Sum + Independent Per-Channel Pre/Post Reverb Bus
    const mixCenterMerger = audioCtx.createGain();
    instOut.connect(mixCenterMerger);
    vocalOut.connect(mixCenterMerger);

    const splitMasterGate = audioCtx.createGain();
    const stereoPassGain = audioCtx.createGain();
    mixCenterMerger.connect(splitMasterGate);
    source.connect(stereoPassGain);

    const reverbSendGain = audioCtx.createGain();
    const convolver = audioCtx.createConvolver();
    convolver.buffer = buildImpulseResponse(audioCtx, activeConfig.reverb.decay || 1.4);
    const reverbReturnGain = audioCtx.createGain();
    const reverbAnalyser = audioCtx.createAnalyser();
    reverbAnalyser.fftSize = 512;

    vocalPreFader.connect(vocalPreRevSendGain).connect(convolver);
    vocalPostFader.connect(vocalPostRevSendGain).connect(convolver);
    instPreFader.connect(instPreRevSendGain).connect(convolver);
    instPostFader.connect(instPostRevSendGain).connect(convolver);
    stereoPassGain.connect(reverbSendGain).connect(convolver);
    convolver.connect(reverbReturnGain).connect(reverbAnalyser);

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

    const glueComp = audioCtx.createDynamicsCompressor();
    glueComp.knee.value = 12;
    glueComp.attack.value = 0.02;
    glueComp.release.value = 0.25;

    let masterProDspNode = null;
    try {
      masterProDspNode = new AudioWorkletNode(audioCtx, "bp-pro-dsp", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2]
      });
      masterProDspNode.port.onmessage = (ev) => {
        if (ev.data && ev.data.type === "dsp-meters") {
          masterDspMeters = ev.data;
        }
      };
    } catch (_) {
      masterProDspNode = null;
    }

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
    reverbAnalyser.connect(m80);

    let masterLimChain = m80.connect(m250).connect(m1k).connect(m3k5).connect(m10k).connect(glueComp);
    if (masterProDspNode) {
      masterLimChain = masterLimChain.connect(masterProDspNode);
    }
    masterLimChain.connect(limiter).connect(masterOutGain);
    masterOutGain.connect(broadcastMuteGain).connect(masterAnalyser);

    let dryWorkletNode = null;
    try {
      dryWorkletNode = new AudioWorkletNode(audioCtx, "bp-dry-capture", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: "explicit",
        channelInterpretation: "discrete"
      });
    } catch (_) {
      dryWorkletNode = null;
    }

    workletNode = new AudioWorkletNode(audioCtx, "bp-pcm-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2]
    });
    const silentSink = audioCtx.createGain();
    silentSink.gain.value = 0;
    masterAnalyser.connect(workletNode).connect(silentSink).connect(audioCtx.destination);

    let dryFallbackNode = null;
    const dryPreMerger = audioCtx.createChannelMerger(2);
    try {
      dryPreMerger.channelCountMode = "explicit";
      dryPreMerger.channelInterpretation = "discrete";
    } catch (_) { }
    ch1PinGains.forEach((g) => g.connect(dryPreMerger, 0, 0));
    ch2PinGains.forEach((g) => g.connect(dryPreMerger, 0, 1));

    if (dryWorkletNode) {
      dryPreMerger.connect(dryWorkletNode).connect(silentSink);
    } else if (typeof audioCtx.createScriptProcessor === "function") {
      try {
        dryFallbackNode = audioCtx.createScriptProcessor(2048, 2, 2);
        dryPreMerger.connect(dryFallbackNode).connect(silentSink);
        dryFallbackNode.onaudioprocess = function (ev) {
          if (window.LiveStudioRecorder && window.LiveStudioRecorder.isRecording()) {
            const c1 = new Float32Array(ev.inputBuffer.getChannelData(0));
            const c2 = new Float32Array(
              ev.inputBuffer.numberOfChannels > 1 ? ev.inputBuffer.getChannelData(1) : c1
            );
            window.LiveStudioRecorder.pushDryPcm(c1, c2);
          }
        };
      } catch (_) {
        dryFallbackNode = null;
      }
    }

    // Earphone monitor routing (True Pre-Fader PFL Solo + Post Master Listen & setSinkId)
    const monitorDest = audioCtx.createMediaStreamDestination();
    const monMasterGain = audioCtx.createGain();
    const monInstPflGain = audioCtx.createGain();
    const monVocalPflGain = audioCtx.createGain();
    const monStereoMerger = audioCtx.createChannelMerger(2);

    masterOutGain.connect(monMasterGain).connect(monitorDest);
    instPreFader.connect(monStereoMerger, 0, 0);
    instPreFader.connect(monStereoMerger, 0, 1);
    const vocalPflMerger = audioCtx.createChannelMerger(2);
    vocalPreFader.connect(vocalPflMerger, 0, 0);
    vocalPreFader.connect(vocalPflMerger, 0, 1);

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
      } catch (_) { }
    }

    nodes = {
      source,
      splitter,
      rawPinAnalysers,
      ch1PinGains,
      ch2PinGains,
      ch1FromL,
      ch1FromR,
      ch2FromL,
      ch2FromR,
      instTrimGain,
      instGain,
      instHpf,
      instHpf2,
      instLpf,
      instEqLow,
      instEqMid,
      instEqHigh,
      instProDspNode,
      instComp,
      instAnalyser,
      instMuteGain,
      instPreRevSendGain,
      instPostRevSendGain,
      instPanner,
      vocalTrimGain,
      vocalGain,
      vocalHpf,
      vocalHpf2,
      vocalLpf,
      vocalEqLow,
      vocalEqMid,
      vocalProDspNode,
      vocalDeesser,
      vocalEqHigh,
      vocalComp,
      vocalAnalyser,
      vocalMuteGain,
      vocalPreRevSendGain,
      vocalPostRevSendGain,
      vocalPanner,
      splitMasterGate,
      stereoPassGain,
      reverbSendGain,
      convolver,
      reverbReturnGain,
      reverbAnalyser,
      m80,
      m250,
      m1k,
      m3k5,
      m10k,
      glueComp,
      masterProDspNode,
      limiter,
      masterOutGain,
      broadcastMuteGain,
      masterAnalyser,
      monitorDest,
      monMasterGain,
      monInstPflGain,
      monVocalPflGain,
      dryWorkletNode,
      dryFallbackNode
    };

    if (window.LiveStreamSoundcheck) {
      soundcheckSession = window.LiveStreamSoundcheck.createSoundcheckSession({
        deviceName: deviceLabel,
        sourceType: mode === "asio" ? "asio" : mode === "file" ? "file" : "wasapi",
        sampleRate: audioCtx.sampleRate || hwRate,
        channelCount: hwChannels,
        swapChannels: Boolean(activeConfig.swapChannels),
        singleChannelAllowed: Boolean($("lsScSingleOkCheck")?.checked)
      });
      refreshSoundcheckUi();
    }

    if (dryWorkletNode) {
      dryWorkletNode.port.onmessage = function (ev) {
        const msg = ev.data;
        if (!msg) return;
        if (msg.type === "input-telemetry" && soundcheckSession && window.LiveStreamSoundcheck) {
          window.LiveStreamSoundcheck.ingestTelemetryFrame(soundcheckSession, msg);
          refreshSoundcheckUi();
          return;
        }
        if (
          msg.type === "dry-pcm" &&
          window.LiveStudioRecorder &&
          window.LiveStudioRecorder.isRecording()
        ) {
          window.LiveStudioRecorder.pushDryPcm(msg.ch1, msg.ch2, msg.totalFrames);
        }
      };
    }

    workletNode.port.onmessage = function (ev) {
      const msg = ev.data;
      if (!msg) return;
      if (msg.type === "master-telemetry") {
        masterTelem.peakL = msg.peakL || 0;
        masterTelem.peakR = msg.peakR || 0;
        masterTelem.rmsL = msg.rmsL || 0;
        masterTelem.rmsR = msg.rmsR || 0;
        masterTelem.truePeak = msg.truePeak || 0;
        masterTelem.kwRing.push(msg.kwMeanSq || 0);
        if (masterTelem.kwRing.length > 31) masterTelem.kwRing.shift(); // ~3.0s Short-Term window
        let kwAvg = 0;
        for (let k = 0; k < masterTelem.kwRing.length; k++) kwAvg += masterTelem.kwRing[k];
        kwAvg /= Math.max(1, masterTelem.kwRing.length);
        masterTelem.shortTermLufs = kwAvg > 1e-12 ? -0.691 + 10 * Math.log10(kwAvg) : -Infinity;
        return;
      }
      if (msg.type === "pcm") {
        if (
          window.LiveStudioRecorder &&
          window.LiveStudioRecorder.isRecording()
        ) {
          window.LiveStudioRecorder.pushMasterPcm(msg.left, msg.right);
        }
        if (encoderWorker && isLive) {
          encoderWorker.postMessage(
            { type: "encode", left: msg.left, right: msg.right },
            [msg.left.buffer, msg.right.buffer]
          );
        }
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
    if (asioSocket) {
      try {
        asioSocket.onclose = null;
        asioSocket.close();
      } catch (_) { }
      asioSocket = null;
    }
    if (monitorAudioEl) {
      try {
        monitorAudioEl.pause();
        monitorAudioEl.srcObject = null;
      } catch (_) { }
    }
    if (nodes && nodes.dryWorkletNode) {
      try {
        nodes.dryWorkletNode.port.onmessage = null;
        nodes.dryWorkletNode.disconnect();
      } catch (_) { }
    }
    if (nodes && nodes.vocalProDspNode) {
      try {
        nodes.vocalProDspNode.port.onmessage = null;
        nodes.vocalProDspNode.disconnect();
      } catch (_) { }
    }
    if (nodes && nodes.instProDspNode) {
      try {
        nodes.instProDspNode.port.onmessage = null;
        nodes.instProDspNode.disconnect();
      } catch (_) { }
    }
    if (nodes && nodes.masterProDspNode) {
      try {
        nodes.masterProDspNode.port.onmessage = null;
        nodes.masterProDspNode.disconnect();
      } catch (_) { }
    }
    vocalDspMeters = { gateGainDb: 0, deesserGrDb: 0, compGrDb: 0, limiterGrDb: 0 };
    instDspMeters = { gateGainDb: 0, deesserGrDb: 0, compGrDb: 0, limiterGrDb: 0 };
    masterDspMeters = { limiterGrDb: 0 };
    masterTelem.kwRing = [];
    masterTelem.shortTermLufs = -Infinity;
    if (nodes && nodes.dryFallbackNode) {
      try {
        nodes.dryFallbackNode.onaudioprocess = null;
        nodes.dryFallbackNode.disconnect();
      } catch (_) { }
    }
    if (workletNode) {
      try {
        workletNode.port.onmessage = null;
        workletNode.disconnect();
      } catch (_) { }
      workletNode = null;
    }
    if (audioCtx) {
      try {
        await audioCtx.close();
      } catch (_) { }
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
      } catch (_) { }
      testFileAudioEl = null;
    }
    if ($("lsTestFilePauseBtn")) {
      $("lsTestFilePauseBtn").style.display = "none";
      $("lsTestFilePauseBtn").textContent = "Pause File";
    }
    nodes = null;
    livePinLevels.peaksDb = [];
    livePinLevels.rmsDb = [];
    livePinLevels.activePins = [];
    livePinLevels.updatedAt = 0;
    updateHeroStatusUi();
    renderLivePinDetectionUi(true);
    if ($("lsCaptureBackendSelect")?.value === "asio") {
      connectPassiveBridgeMonitor();
    }
  }

  function startEncoderWorker(sampleRate, kbps) {
    if (encoderWorker) {
      try {
        encoderWorker.terminate();
      } catch (_) { }
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
      } catch (_) { }
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
      } catch (_) { }
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
    const listenerChip = $("lsListenerChip");
    if (listenerChip) {
      listenerChip.classList.toggle("live-active", Boolean(isLive));
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
        } catch (_) { }
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
        } catch (_) { }
        ws = null;
      }
      if (encoderWorker) {
        try {
          encoderWorker.terminate();
        } catch (_) { }
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
      } catch (_) { }

      if (window.LiveStudioRecorder && window.LiveStudioRecorder.isRecording()) {
        await stopRecordingWorkflow();
      }

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

  function getTsStorageKey() {
    const d = ($("lsSessionDateInput")?.value || boot.sessionDate || "latest").trim();
    return `bp_studio_timestamps_${d}`;
  }

  function saveTimestampsToLocal() {
    try {
      window.localStorage.setItem(getTsStorageKey(), JSON.stringify(capturedTimestamps));
    } catch (_) { }
  }

  function loadTimestampsFromLocal() {
    try {
      const raw = window.localStorage.getItem(getTsStorageKey());
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        capturedTimestamps = parsed;
      }
    } catch (_) { }
  }

  function formatTsMmSs(sec) {
    if (window.LiveStreamWavUtils && typeof window.LiveStreamWavUtils.formatSecondsMMSS === "function") {
      return window.LiveStreamWavUtils.formatSecondsMMSS(sec);
    }
    const total = Math.max(0, Math.floor(Number(sec) || 0));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  function parseTsInputToSeconds(str) {
    const clean = String(str || "").trim();
    if (/^\d+$/.test(clean)) return Math.max(0, parseInt(clean, 10));
    const parts = clean.split(":").map((p) => parseInt(p, 10) || 0);
    if (parts.length === 3) return Math.max(0, parts[0] * 3600 + parts[1] * 60 + parts[2]);
    if (parts.length === 2) return Math.max(0, parts[0] * 60 + parts[1]);
    return 0;
  }

  function renderTimestampsEditor() {
    const listEl = $("lsTimestampsList");
    const countEl = $("lsTsCount");
    if (countEl) countEl.textContent = String(capturedTimestamps.length);
    if (!listEl) return;
    listEl.innerHTML = "";

    if (capturedTimestamps.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ls-hero-sub";
      empty.textContent = 'Click "Set Live" during recording (or "+ Add Timestamp") to capture bhajan markers.';
      listEl.appendChild(empty);
      return;
    }

    capturedTimestamps.forEach((item, idx) => {
      const row = document.createElement("div");
      row.className = "ls-ts-row";

      const timeInput = document.createElement("input");
      timeInput.type = "text";
      timeInput.className = "ls-ts-time-input";
      timeInput.value = formatTsMmSs(item.start_seconds);
      timeInput.onchange = function () {
        item.start_seconds = parseTsInputToSeconds(this.value);
        this.value = formatTsMmSs(item.start_seconds);
        saveTimestampsToLocal();
      };

      const info = document.createElement("div");
      info.className = "ls-bhajan-meta";
      const tDiv = document.createElement("div");
      tDiv.className = "ls-bhajan-title";
      tDiv.textContent = item.bhajan_title;
      const sDiv = document.createElement("div");
      sDiv.className = "ls-bhajan-singer";
      sDiv.textContent = item.singer_name || "Samiti Singer";
      info.appendChild(tDiv);
      info.appendChild(sDiv);

      const nudgeGroup = document.createElement("div");
      nudgeGroup.className = "ls-ts-nudge-group";
      [-5, -1, 1, 5].forEach((delta) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "ls-btn-mini";
        b.textContent = delta > 0 ? `+${delta}s` : `${delta}s`;
        b.onclick = () => {
          item.start_seconds = Math.max(0, Number(item.start_seconds || 0) + delta);
          timeInput.value = formatTsMmSs(item.start_seconds);
          saveTimestampsToLocal();
        };
        nudgeGroup.appendChild(b);
      });

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "ls-btn-mini";
      delBtn.textContent = "×";
      delBtn.title = "Remove timestamp";
      delBtn.onclick = () => {
        capturedTimestamps.splice(idx, 1);
        saveTimestampsToLocal();
        renderTimestampsEditor();
      };
      nudgeGroup.appendChild(delBtn);

      row.appendChild(timeInput);
      row.appendChild(info);
      row.appendChild(nudgeGroup);
      listEl.appendChild(row);
    });
  }

  async function setNowSingingItem(bhajan) {
    const isRec = Boolean(window.LiveStudioRecorder && window.LiveStudioRecorder.isRecording());
    if (!isLive && !isRec) {
      showStudioMessage("Start Recording or Go Live first before marking Now Singing.", true);
      return;
    }

    if (bhajan && isRec) {
      const stats = window.LiveStudioRecorder.getStats();
      const sampleRate = Number(stats.sampleRate) || 48000;
      const sampleTimeSec = Number.isFinite(stats.elapsedSampleSeconds) && stats.elapsedSampleSeconds > 0
        ? stats.elapsedSampleSeconds
        : (stats.elapsedSeconds || 0);
      const preRolledSec = Math.max(0, Math.round(sampleTimeSec - 2));
      const preRolledSampleSec = Math.max(0, Number((sampleTimeSec - 2).toFixed(3)));
      const sampleFrame = Math.max(0, Math.round(preRolledSampleSec * sampleRate));
      const last = capturedTimestamps[capturedTimestamps.length - 1];
      const alreadyJustMarked =
        last &&
        Number(last.submission_id) === Number(bhajan.id) &&
        Math.abs(last.start_seconds - preRolledSec) <= 3;

      if (!alreadyJustMarked) {
        capturedTimestamps.push({
          submission_id: bhajan.id,
          bhajan_title: bhajan.title,
          singer_name: bhajan.singer_name || "Samiti Singer",
          deity: bhajan.deity || "",
          start_seconds: preRolledSec,
          sample_seconds: preRolledSampleSec,
          sample_frame: sampleFrame,
          sample_rate: sampleRate
        });
        saveTimestampsToLocal();
        renderTimestampsEditor();
      }
    }

    if (!isLive) {
      renderBhajanPickerList(bhajan ? bhajan.id : null);
      const curLabel = $("lsNowSingingCurrent");
      if (curLabel) {
        curLabel.textContent = bhajan
          ? `${bhajan.title} — ${bhajan.singer_name || ""} (Timestamp saved)`
          : "None selected";
      }
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

  function connectPassiveBridgeMonitor() {
    if (asioSocket && asioSocket.readyState === 1) return;
    if (bridgeMonitorSocket && (bridgeMonitorSocket.readyState === 0 || bridgeMonitorSocket.readyState === 1)) return;
    if (typeof WebSocket !== "function") return;
    try {
      const sock = new WebSocket("ws://127.0.0.1:17940/?mode=monitor");
      sock.binaryType = "arraybuffer";
      bridgeMonitorSocket = sock;
      sock.onopen = () => {
        try {
          sock.send(JSON.stringify({ type: "set-client-mode", mode: "monitor" }));
          if (rawMcSubscribers.size > 0) {
            sock.send(JSON.stringify({ type: "set-multichannel-tap", enabled: true }));
          }
        } catch (_) { }
      };
      sock.onmessage = (ev) => {
        if (ev.data instanceof ArrayBuffer) {
          dispatchBpmcBinaryPacket(ev.data);
          return;
        }
        if (typeof ev.data !== "string") return;
        try {
          const msg = JSON.parse(ev.data);
          if (msg && msg.type === "bridge-info") {
            if ($("lsCaptureBackendSelect")) $("lsCaptureBackendSelect").value = "asio";
            handleBridgeInfoMeta(msg);
          } else if (msg && msg.type === "input-levels") {
            handleLivePinLevelsMessage(msg);
          }
        } catch (_) { }
      };
      sock.onerror = () => {
        if (bridgeMonitorSocket === sock) bridgeMonitorSocket = null;
      };
      sock.onclose = () => {
        if (bridgeMonitorSocket === sock) bridgeMonitorSocket = null;
      };
    } catch (_) { }
  }

  async function probeLocalAudioBridge(switchBackendIfFound = true) {
    lastPassiveBridgeProbeAt = Date.now();
    if (asioSocket && asioSocket.readyState === 1) return { active: true };
    if (bridgeMonitorSocket && bridgeMonitorSocket.readyState === 1) {
      if (switchBackendIfFound && $("lsCaptureBackendSelect")) $("lsCaptureBackendSelect").value = "asio";
      return activeDetectedChannelCount > 0
        ? { cleanName: activeDetectedDeviceName, hostApi: activeDetectedDriverName, channels: activeDetectedChannelCount }
        : { active: true };
    }
    if (typeof WebSocket !== "function") return null;
    return await new Promise((resolve) => {
      let settled = false;
      let sock;
      const done = (val) => {
        if (settled) return;
        settled = true;
        try {
          if (sock) sock.close();
        } catch (_) { }
        if (val) connectPassiveBridgeMonitor();
        resolve(val);
      };
      const timer = setTimeout(() => done(null), 650);
      try {
        sock = new WebSocket("ws://127.0.0.1:17940/?mode=monitor");
        sock.onmessage = (ev) => {
          if (typeof ev.data !== "string") return;
          try {
            const meta = JSON.parse(ev.data);
            if (meta && meta.type === "bridge-info") {
              clearTimeout(timer);
              if (switchBackendIfFound && $("lsCaptureBackendSelect")) {
                $("lsCaptureBackendSelect").value = "asio";
              }
              handleBridgeInfoMeta(meta);
              done(meta);
            }
          } catch (_) { }
        };
        sock.onerror = () => {
          clearTimeout(timer);
          done(null);
        };
      } catch (_) {
        clearTimeout(timer);
        done(null);
      }
    });
  }

  async function toggleInputChannelAutoDetect(targetBus) {
    if (inputLearnState && inputLearnState.targetBus === targetBus) {
      stopInputAutoDetect(false);
      return;
    }
    stopInputAutoDetect(true);

    const isBridgeMonitoring = Boolean(bridgeMonitorSocket && bridgeMonitorSocket.readyState === 1);
    if (!audioCtx && !isBridgeMonitoring) {
      const bridgeMeta = await probeLocalAudioBridge(true);
      const targetMode = bridgeMeta || $("lsCaptureBackendSelect")?.value === "asio" ? "asio" : "device";
      if (!bridgeMeta) {
        try {
          await initAudioEngine(targetMode);
        } catch (err) {
          showStudioMessage("Start Audio Input first to auto-detect channel: " + err.message, true);
          return;
        }
      }
    }

    inputLearnState = {
      targetBus,
      startedAt: Date.now(),
      streakPin: -1,
      streakCount: 0,
      timer: setTimeout(() => {
        if (inputLearnState && inputLearnState.targetBus === targetBus) {
          stopInputAutoDetect(true);
          showStudioMessage(
            `No live signal detected on any pin for ${targetBus === "vocal" ? "Vocals" : "Instruments"} within 7s. Speak/play louder and try Detect again.`,
            true
          );
        }
      }, 7000)
    };
    renderLivePinDetectionUi(true);
    showStudioMessage(
      targetBus === "vocal"
        ? "Listening... speak into your microphone now to auto-assign CH 1 Vocals!"
        : "Listening... play harmonium/tabla now to auto-assign CH 2 Instruments!",
      false
    );
  }

  function wireStudioEvents() {
    renderPresetOptions(presets[0] ? presets[0].id : null);
    syncUiFromConfig();
    renderBhajanPickerList(streamState.nowSinging ? streamState.nowSinging.submissionId : null);
    updateHeroStatusUi();
    refreshAudioDevices(false).then(() => probeLocalAudioBridge(true));

    window.addEventListener("focus", () => {
      if (isLive || (audioCtx && activeSourceMode === "asio")) return;
      if (Date.now() - lastPassiveBridgeProbeAt > 2500) {
        probeLocalAudioBridge(true);
      }
    });

    if (navigator.mediaDevices && typeof navigator.mediaDevices.addEventListener === "function") {
      navigator.mediaDevices.addEventListener("devicechange", () => refreshAudioDevices(false));
    }

    if ($("lsRefreshDevicesBtn")) {
      $("lsRefreshDevicesBtn").onclick = async () => {
        const activeBridgeSock = asioSocket && asioSocket.readyState === 1
          ? asioSocket
          : (bridgeMonitorSocket && bridgeMonitorSocket.readyState === 1 ? bridgeMonitorSocket : null);
        if (activeBridgeSock) {
          try {
            activeBridgeSock.send(JSON.stringify({ type: "refresh-devices" }));
            showStudioMessage("Scanning Windows audio devices & USB interfaces on bridge...", false);
            return;
          } catch (_) { }
        }
        const probe = await probeLocalAudioBridge(true);
        if (probe) {
          showStudioMessage(
            `Detected Audio Bridge: ${probe.cleanName || probe.deviceName || "Audio Interface"} (${probe.hostApi || "Bridge"}, ${probe.channels || activeDetectedChannelCount} ch)`,
            false
          );
          return;
        }
        await refreshAudioDevices(true);
      };
    }
    if ($("lsOpenAsioPanelBtn")) {
      $("lsOpenAsioPanelBtn").onclick = () => {
        if (asioSocket && asioSocket.readyState === 1) {
          asioSocket.send(JSON.stringify({ type: "open-asio-panel" }));
        } else {
          showStudioMessage("Engage Soundcheck via ASIO driver first to open its driver panel.", true);
        }
      };
    }
    if ($("lsAudioInputSelect")) {
      $("lsAudioInputSelect").onchange = async function () {
        if ($("lsCaptureBackendSelect")?.value === "asio") {
          preferredBridgeDeviceId = this.value;
          if (this.value === "none") {
            bridgeStandbyMode = true;
            activeDetectedChannelCount = 0;
            activeDetectedDeviceName = "No External Interface (Standby)";
            activeDetectedDriverName = "Standby";
            activeChannelCatalog = [];
            reconcileRoutingWithCatalog(activeChannelCatalog);
            renderInputChannelSelectors();
            emitHardwareCatalogChanged();
            renderLivePinDetectionUi(true);
          } else {
            const chosen = activeBridgeDevices.find((d) => String(d.id) === String(this.value));
            if (chosen) {
              bridgeStandbyMode = false;
              const chCnt = Number(chosen.maxInputChannels) || 0;
              activeDetectedChannelCount = chCnt;
              activeDetectedDeviceName = cleanHardwareDeviceLabel(chosen.cleanName || chosen.name);
              activeDetectedDriverName = chosen.hostApi || "Audio Bridge";
              activeChannelCatalog = Array.isArray(chosen.channelsCatalog)
                ? chosen.channelsCatalog
                : buildDetectedChannelCatalog(activeDetectedDeviceName, chCnt, chosen.pinNames);
              reconcileRoutingWithCatalog(activeChannelCatalog);
              renderInputChannelSelectors();
              emitHardwareCatalogChanged();
              renderLivePinDetectionUi(true);
            }
          }
          const activeSock = asioSocket && asioSocket.readyState === 1
            ? asioSocket
            : (bridgeMonitorSocket && bridgeMonitorSocket.readyState === 1 ? bridgeMonitorSocket : null);
          if (activeSock) {
            try {
              activeSock.send(JSON.stringify({ type: "select-device", deviceId: this.value }));
            } catch (_) { }
          }
        } else {
          const lbl = this.options[this.selectedIndex] ? this.options[this.selectedIndex].textContent : "";
          await probeBrowserDeviceChannels(this.value, lbl);
        }
      };
    }
    if ($("lsCaptureBackendSelect")) {
      $("lsCaptureBackendSelect").onchange = async function () {
        const nextMode = this.value === "asio" ? "asio" : "device";
        activeSourceMode = nextMode;
        if (nextMode === "asio") {
          await probeLocalAudioBridge(false);
        } else {
          if (bridgeMonitorSocket) {
            try { bridgeMonitorSocket.close(); } catch (_) { }
            bridgeMonitorSocket = null;
          }
          const asioBtn = $("lsOpenAsioPanelBtn");
          if (asioBtn) asioBtn.classList.add("ls-is-hidden");
          await refreshAudioDevices(false);
        }
        if (audioCtx) {
          try {
            await releaseAudioEngine();
            await initAudioEngine(nextMode);
            showStudioMessage(
              nextMode === "asio"
                ? "Connected via Local Audio Bridge (ws://127.0.0.1:17940)."
                : "Switched to Browser WASAPI raw capture.",
              false
            );
          } catch (err) {
            showStudioMessage("Capture backend error: " + err.message, true);
          }
        }
      };
    }

    if ($("lsSoundcheckBtn")) {
      $("lsSoundcheckBtn").onclick = async () => {
        const drawer = $("lsSoundcheckDrawer");
        if (drawer) {
          drawer.classList.remove("ls-is-hidden");
          drawer.style.display = "block";
          drawer.open = true;
        }
        try {
          if ($("lsCaptureBackendSelect")?.value !== "asio") {
            await probeLocalAudioBridge(true);
          }
          const targetMode =
            $("lsCaptureBackendSelect") && $("lsCaptureBackendSelect").value === "asio"
              ? "asio"
              : "device";
          activeSourceMode = targetMode;
          await releaseAudioEngine();
          await initAudioEngine(targetMode);
          if (soundcheckSession && window.LiveStreamSoundcheck) {
            window.LiveStreamSoundcheck.setSoundcheckStage(
              soundcheckSession,
              window.LiveStreamSoundcheck.STAGE_VOCAL
            );
            refreshSoundcheckUi();
          }
          showStudioMessage("Audio interface connected for 3-stage soundcheck!", false);
        } catch (err) {
          showStudioMessage("Audio input error: " + err.message, true);
        }
      };
    }

    const reinitOnHwParamChange = async () => {
      if (!audioCtx) return;
      try {
        await releaseAudioEngine();
        await initAudioEngine(activeSourceMode);
        showStudioMessage("Reconfigured audio interface sample rate / buffer settings.", false);
      } catch (err) {
        showStudioMessage("Hardware reconfig failed: " + err.message, true);
      }
    };
    if ($("lsHwSampleRateSelect")) $("lsHwSampleRateSelect").onchange = reinitOnHwParamChange;
    if ($("lsHwBufferSelect")) $("lsHwBufferSelect").onchange = reinitOnHwParamChange;

    if ($("lsScStage1Btn")) {
      $("lsScStage1Btn").onclick = () => {
        if (!soundcheckSession || !window.LiveStreamSoundcheck) return;
        window.LiveStreamSoundcheck.setSoundcheckStage(
          soundcheckSession,
          window.LiveStreamSoundcheck.STAGE_VOCAL
        );
        refreshSoundcheckUi();
      };
    }
    if ($("lsScStage2Btn")) {
      $("lsScStage2Btn").onclick = () => {
        if (!soundcheckSession || !window.LiveStreamSoundcheck) return;
        window.LiveStreamSoundcheck.setSoundcheckStage(
          soundcheckSession,
          window.LiveStreamSoundcheck.STAGE_INST
        );
        refreshSoundcheckUi();
      };
    }
    if ($("lsScStage3Btn")) {
      $("lsScStage3Btn").onclick = () => {
        if (!soundcheckSession || !window.LiveStreamSoundcheck) return;
        window.LiveStreamSoundcheck.setSoundcheckStage(
          soundcheckSession,
          window.LiveStreamSoundcheck.STAGE_BOTH
        );
        refreshSoundcheckUi();
      };
    }
    if ($("lsScSingleOkCheck")) {
      $("lsScSingleOkCheck").onchange = () => refreshSoundcheckUi();
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
            await monitorAudioEl.play().catch(() => { });
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
          await testFileAudioEl.play().catch(() => { });
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
        const prevCh1 = activeConfig.ch1InputSource;
        activeConfig.ch1InputSource = activeConfig.ch2InputSource;
        activeConfig.ch2InputSource = prevCh1;
        activeConfig.swapChannels = activeConfig.ch1InputSource === "1" && activeConfig.ch2InputSource === "0"
          ? true
          : !activeConfig.swapChannels;
        syncUiFromConfig();
      };
    }

    if ($("lsVocalInputChannelSelect")) {
      const vocalSel = $("lsVocalInputChannelSelect");
      vocalSel.addEventListener("pointerdown", () => updateSelectorLiveOptionLabels(vocalSel, true));
      vocalSel.addEventListener("focus", () => updateSelectorLiveOptionLabels(vocalSel, true));
      vocalSel.onchange = function () {
        activeConfig.ch1InputSource = this.value;
        activeConfig.swapChannels = activeConfig.ch1InputSource === "1" && activeConfig.ch2InputSource === "0";
        syncUiFromConfig();
      };
    }

    if ($("lsInstInputChannelSelect")) {
      const instSel = $("lsInstInputChannelSelect");
      instSel.addEventListener("pointerdown", () => updateSelectorLiveOptionLabels(instSel, true));
      instSel.addEventListener("focus", () => updateSelectorLiveOptionLabels(instSel, true));
      instSel.onchange = function () {
        ch2AutoMutedBySingleCh = false;
        activeConfig.ch2InputSource = this.value;
        activeConfig.swapChannels = activeConfig.ch1InputSource === "1" && activeConfig.ch2InputSource === "0";
        syncUiFromConfig();
      };
    }

    if ($("lsVocalDetectInputBtn")) {
      $("lsVocalDetectInputBtn").onclick = () => toggleInputChannelAutoDetect("vocal");
    }
    if ($("lsInstDetectInputBtn")) {
      $("lsInstDetectInputBtn").onclick = () => toggleInputChannelAutoDetect("inst");
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

    if ($("lsInstCompBtn")) {
      $("lsInstCompBtn").onclick = function () {
        activeConfig.inst.comp = !activeConfig.inst.comp;
        syncUiFromConfig();
      };
    }

    if ($("lsVocalPolarityBtn")) {
      $("lsVocalPolarityBtn").onclick = function () {
        activeConfig.vocal.polarity = !activeConfig.vocal.polarity;
        syncUiFromConfig();
      };
    }

    if ($("lsInstPolarityBtn")) {
      $("lsInstPolarityBtn").onclick = function () {
        activeConfig.inst.polarity = !activeConfig.inst.polarity;
        syncUiFromConfig();
      };
    }

    if ($("lsVocalGateBtn")) {
      $("lsVocalGateBtn").onclick = function () {
        activeConfig.vocal.gate = !activeConfig.vocal.gate;
        syncUiFromConfig();
      };
    }

    if ($("lsInstGateBtn")) {
      $("lsInstGateBtn").onclick = function () {
        activeConfig.inst.gate = !activeConfig.inst.gate;
        syncUiFromConfig();
      };
    }

    if ($("lsVocalEqBypassBtn")) {
      $("lsVocalEqBypassBtn").onclick = function () {
        activeConfig.vocal.eqBypass = !activeConfig.vocal.eqBypass;
        syncUiFromConfig();
      };
    }

    if ($("lsInstEqBypassBtn")) {
      $("lsInstEqBypassBtn").onclick = function () {
        activeConfig.inst.eqBypass = !activeConfig.inst.eqBypass;
        syncUiFromConfig();
      };
    }

    if ($("lsVocalHpfSlope")) {
      $("lsVocalHpfSlope").onchange = function () {
        activeConfig.vocal.hpfSlope = Number(this.value) === 24 ? 24 : 12;
        syncUiFromConfig();
      };
    }

    if ($("lsInstHpfSlope")) {
      $("lsInstHpfSlope").onchange = function () {
        activeConfig.inst.hpfSlope = Number(this.value) === 24 ? 24 : 12;
        syncUiFromConfig();
      };
    }

    if ($("lsVocalDeessMode")) {
      $("lsVocalDeessMode").onchange = function () {
        activeConfig.vocal.deessWideband = this.value === "wide";
        syncUiFromConfig();
      };
    }

    if ($("lsVocalCompMode")) {
      $("lsVocalCompMode").onchange = function () {
        activeConfig.vocal.compPeakMode = this.value === "peak";
        syncUiFromConfig();
      };
    }

    if ($("lsInstCompMode")) {
      $("lsInstCompMode").onchange = function () {
        activeConfig.inst.compPeakMode = this.value === "peak";
        syncUiFromConfig();
      };
    }

    if ($("lsVocalSendMode")) {
      $("lsVocalSendMode").onchange = function () {
        activeConfig.vocal.preFaderSend = this.value === "pre";
        syncUiFromConfig();
      };
    }

    if ($("lsInstSendMode")) {
      $("lsInstSendMode").onchange = function () {
        activeConfig.inst.preFaderSend = this.value === "pre";
        syncUiFromConfig();
      };
    }

    if ($("lsReverbPresetSelect")) {
      $("lsReverbPresetSelect").onchange = function () {
        const key = this.value || "medium_prayer_hall";
        activeConfig.reverb.preset = key;
        const catalogPreset =
          window.LiveStreamDsp &&
          window.LiveStreamDsp.FX_CATALOG &&
          window.LiveStreamDsp.FX_CATALOG.reverb &&
          window.LiveStreamDsp.FX_CATALOG.reverb.presets &&
          window.LiveStreamDsp.FX_CATALOG.reverb.presets[key] &&
          window.LiveStreamDsp.FX_CATALOG.reverb.presets[key].params;
        const hallPreset =
          catalogPreset ||
          (window.LiveStreamDsp && window.LiveStreamDsp.HALL_IR_PRESETS && window.LiveStreamDsp.HALL_IR_PRESETS[key]);
        if (hallPreset) {
          activeConfig.reverb.decay = hallPreset.decay;
          activeConfig.reverb.preDelayMs = hallPreset.preDelayMs;
          if (hallPreset.toneHz !== undefined) activeConfig.reverb.toneHz = hallPreset.toneHz;
          if (hallPreset.roomSize !== undefined) activeConfig.reverb.roomSize = hallPreset.roomSize;
          if (hallPreset.stereoWidth !== undefined) activeConfig.reverb.stereoWidth = hallPreset.stereoWidth;
        }
        customReverbIrBuffer = null;
        customReverbIrName = "";
        if ($("lsReverbIrStatus")) $("lsReverbIrStatus").textContent = "Synth IR";
        syncUiFromConfig();
        rebuildHallConvolverBuffer();
      };
    }

    if ($("lsReverbCustomIrInput")) {
      $("lsReverbCustomIrInput").onchange = async function () {
        const file = this.files && this.files[0] ? this.files[0] : null;
        if (!file) return;
        try {
          if (!audioCtx) await initAudioEngine();
          const buf = await file.arrayBuffer();
          customReverbIrBuffer = await audioCtx.decodeAudioData(buf);
          customReverbIrName = file.name;
          if ($("lsReverbIrStatus")) $("lsReverbIrStatus").textContent = file.name.slice(0, 16);
          rebuildHallConvolverBuffer();
          drawChannelProcCanvas();
          showStudioMessage(`Loaded custom Mandir Hall IR "${file.name}".`, false);
        } catch (err) {
          showStudioMessage("Could not load custom IR (.wav): " + err.message, true);
        } finally {
          this.value = "";
        }
      };
    }

    if ($("lsReverbIrResetBtn")) {
      $("lsReverbIrResetBtn").onclick = function () {
        customReverbIrBuffer = null;
        customReverbIrName = "";
        if ($("lsReverbIrStatus")) $("lsReverbIrStatus").textContent = "Synth IR";
        rebuildHallConvolverBuffer();
        drawChannelProcCanvas();
      };
    }

    if ($("lsMasterBypassBtn")) {
      $("lsMasterBypassBtn").onclick = function () {
        activeConfig.master.bypass = !activeConfig.master.bypass;
        syncUiFromConfig();
      };
    }

    if ($("lsGlueCompBtn")) {
      $("lsGlueCompBtn").onclick = function () {
        activeConfig.master.glueComp = activeConfig.master.glueComp === false;
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
            await monitorAudioEl.play().catch(() => { });
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

    if ($("lsExportPresetBtn")) {
      $("lsExportPresetBtn").onclick = () => {
        const selId = $("lsPresetSelect")?.value || "preset";
        const payload = {
          version: 2,
          exportedAt: new Date().toISOString(),
          name: ($("lsPresetSelect")?.options[$("lsPresetSelect").selectedIndex]?.textContent || "Bhajan Studio Preset").trim(),
          config: activeConfig
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${selId.replace(/[^a-z0-9_-]/gi, "_")}.preset.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      };
    }

    if ($("lsImportPresetFileInput")) {
      $("lsImportPresetFileInput").onchange = async function () {
        const file = this.files && this.files[0] ? this.files[0] : null;
        if (!file) return;
        try {
          const parsed = JSON.parse(await file.text());
          const cfg = parsed.config || parsed;
          if (!cfg || !cfg.vocal || !cfg.inst || !cfg.master) {
            throw new Error("Invalid preset JSON structure");
          }
          activeConfig = cfg;
          syncUiFromConfig();
          if (nodes && audioCtx && nodes.convolver) {
            nodes.convolver.buffer = buildImpulseResponse(audioCtx, activeConfig.reverb.decay || 1.4);
          }
          showStudioMessage(`Loaded preset JSON "${parsed.name || file.name}".`, false);
        } catch (err) {
          showStudioMessage("Preset import failed: " + err.message, true);
        } finally {
          this.value = "";
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
        if ($("lsR2KeyInput") && d) {
          $("lsR2KeyInput").value = `recordings/${d}-session.mp3`;
        }
        if ($("lsR2TitleInput") && d) {
          $("lsR2TitleInput").value = `Bhajan Session – ${d}`;
        }
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

    function updateRecorderUi() {
      const rec = window.LiveStudioRecorder;
      const recording = Boolean(rec && rec.isRecording());
      const pill = $("lsRecStatusPill");
      const statsEl = $("lsRecStatsText");
      if (pill) pill.style.display = recording ? "inline-flex" : "none";
      if (recording && statsEl) {
        const st = rec.getStats();
        const mb = (st.totalBytes / (1024 * 1024)).toFixed(1);
        statsEl.textContent = `REC ${formatTsMmSs(st.elapsedSeconds)} · ${mb} MB`;
      }
      if ($("lsStartRecOnlyBtn")) $("lsStartRecOnlyBtn").disabled = recording;
      if ($("lsRecordAndLiveBtn")) $("lsRecordAndLiveBtn").disabled = recording || isLive;
      if ($("lsStopRecBtn")) $("lsStopRecBtn").disabled = !recording;
    }

    async function startRecordingWorkflow(alsoGoLive) {
      if (!window.LiveStudioRecorder) {
        showStudioMessage("Recorder module failed to load. Please hard refresh.", true);
        return;
      }
      try {
        if (!audioCtx && $("lsCaptureBackendSelect")?.value !== "asio") {
          await probeLocalAudioBridge(true);
        }
        await initAudioEngine();
        if (soundcheckSession && window.LiveStreamSoundcheck && activeConfig.mode === "split") {
          soundcheckSession.swapChannels = Boolean(activeConfig.swapChannels);
          soundcheckSession.singleChannelAllowed = Boolean($("lsScSingleOkCheck")?.checked);
          const readiness = window.LiveStreamSoundcheck.evaluateReadiness(soundcheckSession, {
            requireDualInput: true
          });
          if (!readiness.canRecordDualStems) {
            refreshSoundcheckUi();
            const drawer = $("lsSoundcheckDrawer");
            if (drawer) drawer.open = true;
            showStudioMessage(
              "Dual-input check blocked startRecording: " +
                (readiness.message || "2 independent channels required. Check USB driver / ASIO Bridge or enable 'Allow 1-Ch Mode'."),
              true
            );
            updateRecorderUi();
            return;
          }
          if (readiness.severity === "warn") {
            refreshSoundcheckUi();
          }
        }
        if (nodes && nodes.dryWorkletNode && nodes.dryWorkletNode.port) {
          try {
            nodes.dryWorkletNode.port.postMessage({ type: "reset-clock" });
          } catch (_) { }
        }
        const dlList = $("lsFallbackDownloadsList");
        if (dlList) dlList.innerHTML = "";
        const d = ($("lsSessionDateInput")?.value || boot.sessionDate || "").trim();
        await window.LiveStudioRecorder.startRecording({
          sessionDate: d,
          bitDepth: Number($("lsDryBitDepthSelect")?.value || 24),
          publishBitrateKbps: Number($("lsPublishBitrateSelect")?.value || 112),
          sampleRate: (audioCtx && audioCtx.sampleRate) || 48000,
          hardwareCaptureFormat: activeHardwareCaptureFormat,
          recordDryCh1: Boolean($("lsRecDryCh1Check")?.checked),
          recordDryCh2: Boolean($("lsRecDryCh2Check")?.checked),
          recordMasterMp3: Boolean($("lsRecMasterCheck")?.checked)
        });
        unexportedRecordingGuard = true;
        if (typeof window.armStudioHistoryGuard === "function") {
          window.armStudioHistoryGuard();
        }
        clearInterval(recStatsTimer);
        recStatsTimer = setInterval(updateRecorderUi, 500);
        updateRecorderUi();

        if (alsoGoLive) {
          await goLive();
        } else {
          const recState = window.LiveStudioRecorder.getState();
          const where = recState.storageBackend === "user_folder"
            ? `SSD folder "${recState.folderName}"`
            : (recState.storageBackend === "opfs_vault"
              ? "Default SSD Vault (BhajanPlanner/Recordings)"
              : "browser recording buffer");
          showStudioMessage(`Lossless multitrack capture started -> ${where}.`, false);
        }
      } catch (err) {
        updateRecorderUi();
        showStudioMessage("Failed to start recording: " + err.message, true);
      }
    }

    let publishArtifactRole = "final_master";
    let publishProjectManifest = null;

    function resolveStructuredR2Key(artifactName) {
      const sDate = ($("lsSessionDateInput")?.value || boot.sessionDate || "").trim();
      const sUid =
        (lastRecordedResult && lastRecordedResult.projectUid) ||
        (window.LiveStudioRecorder && typeof window.LiveStudioRecorder.getState === "function"
          ? window.LiveStudioRecorder.getState().projectUid
          : null) ||
        `session-${sDate || new Date().toISOString().slice(0, 10)}`;
      if (window.LiveStudioRecorder && typeof window.LiveStudioRecorder.buildStructuredR2Key === "function") {
        return window.LiveStudioRecorder.buildStructuredR2Key(sDate, sUid, artifactName);
      }
      return `recordings/${sDate || "session"}/${sUid}/${artifactName}`;
    }

    async function syncInitialStudioProject(res) {
      try {
        const sDate = ($("lsSessionDateInput")?.value || boot.sessionDate || "").trim();
        const title = ($("lsR2TitleInput")?.value || $("lsTitleInput")?.value || `Bhajan Session – ${sDate}`).trim();
        const manifest = {
          version: 1,
          projectUid: res.projectUid,
          sessionDate: sDate,
          title,
          sampleRate: res.sampleRate || 48000,
          bitDepth: 24,
          channelConfig: res.channelConfig || "dual_mono_split",
          durationSeconds: res.durationSeconds || 0,
          localFiles: {
            ch1DryWav: res.dryCh1File ? res.dryCh1File.name : null,
            ch2DryWav: res.dryCh2File ? res.dryCh2File.name : null,
            liveRefMp3: res.masterFile ? res.masterFile.name : null
          },
          timestamps: capturedTimestamps.slice(),
          activeFxConfig: activeConfig ? JSON.parse(JSON.stringify(activeConfig)) : null,
          publicationStatus: "draft"
        };
        publishProjectManifest = manifest;
        await fetch("/api/admin/live-stream/projects", {
          method: "POST",
          credentials: "same-origin",
          headers: apiHeaders(),
          body: JSON.stringify({
            project_uid: res.projectUid,
            session_date: sDate,
            title,
            sample_rate: manifest.sampleRate,
            bit_depth: 24,
            channel_config: manifest.channelConfig,
            duration_seconds: manifest.durationSeconds,
            local_files: manifest.localFiles,
            publication_status: "draft",
            manifest
          })
        });
      } catch (_) {}
    }

    async function stopRecordingWorkflow() {
      if (!window.LiveStudioRecorder || !window.LiveStudioRecorder.isRecording()) return;
      try {
        clearInterval(recStatsTimer);
        if (nodes && nodes.dryWorkletNode && nodes.dryWorkletNode.port) {
          try {
            nodes.dryWorkletNode.port.postMessage({ type: "flush" });
          } catch (_) { }
          await new Promise((r) => setTimeout(r, 60));
        }
        const res = await window.LiveStudioRecorder.stopRecording(capturedTimestamps);
        updateRecorderUi();
        if (!res) return;

        lastRecordedResult = res;
        publishArtifactRole = "live_ref";
        if ($("lsBackupDryStemsR2Btn")) {
          $("lsBackupDryStemsR2Btn").disabled = !(res.dryCh1File || res.dryCh2File);
        }
        if (res.masterFile) {
          customPublishFile = null;
          if ($("lsR2SourceLabel")) {
            $("lsR2SourceLabel").textContent = `Ready to publish (Live Ref): ${res.masterFile.name} (${(res.masterFile.size / (1024 * 1024)).toFixed(2)} MB)`;
          }
          if ($("lsR2KeyInput") && /^recordings\/\d{4}-\d{2}-\d{2}-session\.mp3$/.test($("lsR2KeyInput").value.trim())) {
            $("lsR2KeyInput").value = resolveStructuredR2Key("live-ref.mp3");
          }
          if ($("lsPublishR2Btn")) $("lsPublishR2Btn").disabled = false;
        }
        if ($("lsDawAutoLoadRecBtn")) {
          $("lsDawAutoLoadRecBtn").disabled = !(res.dryCh1File || res.dryCh2File || res.masterFile);
        }

        const integrityIssues = [];
        if (res.droppedFrames > 0 || res.writeErrorCount > 0) {
          integrityIssues.push(`${res.droppedFrames || 0} dropped frames / ${res.writeErrorCount || 0} write errors`);
        }
        if (res.dryCh1File && res.dryCh1File.size < 44) integrityIssues.push("Ch1 WAV empty");
        if (res.dryCh2File && res.dryCh2File.size < 44) integrityIssues.push("Ch2 WAV empty");

        syncInitialStudioProject(res);

        const dlList = $("lsFallbackDownloadsList");
        if (dlList) {
          dlList.innerHTML = "";
          if (res.dryCh1File || res.dryCh2File || res.masterFile) {
            const openDawBtn = document.createElement("button");
            openDawBtn.type = "button";
            openDawBtn.className = "ls-btn ls-btn-primary";
            openDawBtn.textContent = "Edit in Post-Production DAW →";
            openDawBtn.onclick = () => {
              if (window.LiveStudioDaw) window.LiveStudioDaw.openFromRecording(res);
            };
            dlList.appendChild(openDawBtn);
          }
          if (Array.isArray(res.fallbackDownloads)) {
            res.fallbackDownloads.forEach((item) => {
              const a = document.createElement("a");
              a.className = "ls-btn ls-btn-mini";
              a.href = URL.createObjectURL(item.blob);
              a.download = item.filename;
              a.style.textDecoration = "none";
              a.textContent = `Download ${item.label}`;
              a.onclick = () => {
                unexportedRecordingGuard = false;
              };
              dlList.appendChild(a);
            });
          }
        }

        if (res.savedToFolder) {
          unexportedRecordingGuard = false;
        } else {
          unexportedRecordingGuard = true;
          if (res.savedToDefaultVault && typeof window.refreshVaultRecoveryBanner === "function") {
            window.refreshVaultRecoveryBanner();
          }
          if ($("lsAutoExportDownloadsCheck")?.checked && Array.isArray(res.fallbackDownloads) && res.fallbackDownloads.length > 0) {
            triggerStemDownloads(res.fallbackDownloads);
          }
        }

        if (integrityIssues.length > 0) {
          showStudioMessage(`Recording stopped with integrity warning (${integrityIssues.join(", ")}). Please inspect stems in DAW before publishing.`, true);
        } else {
          showStudioMessage(
            res.savedToFolder
              ? `Saved verified stems + project.json directly to folder "${res.savedToFolder}". Ready for DAW mastering & Cloudflare R2!`
              : (res.savedToDefaultVault
                ? `Saved verified stems to Default SSD Vault ("${res.vaultPath}") & started Downloads backup. Ready for DAW or Cloudflare R2!`
                : "Recording finalized & verified! Save stems to Downloads, edit in the DAW, or upload to Cloudflare R2 below."),
            false
          );
        }

        if ($("lsAutoUploadRefCheck")?.checked && res.masterFile) {
          try {
            const refKey = resolveStructuredR2Key("live-ref.mp3");
            const sDate = ($("lsSessionDateInput")?.value || boot.sessionDate || "").trim();
            const title = ($("lsR2TitleInput")?.value || "Bhajan Session").trim();
            await window.LiveStudioRecorder.uploadFileToR2AndPublish({
              file: res.masterFile,
              sessionDate: sDate,
              sessionUid: res.projectUid,
              title,
              storageKey: refKey,
              durationSeconds: res.durationSeconds || 0,
              timestamps: capturedTimestamps,
              isPublished: true,
              notifyDevotees: false,
              artifactRole: "live_ref",
              projectManifest: publishProjectManifest,
              csrfToken,
              onProgress: (info) => {
                if ($("lsR2ProgressWrap")) $("lsR2ProgressWrap").style.display = "block";
                if ($("lsR2ProgressFill")) $("lsR2ProgressFill").style.width = `${info.pct || 0}%`;
                if ($("lsR2StatusText")) $("lsR2StatusText").textContent = info.message || "";
              }
            });
            showStudioMessage("Live reference MP3 automatically synced to Cloudflare R2!", false);
          } catch (upErr) {
            showStudioMessage("Live reference auto-upload queued: " + upErr.message, true);
          }
        }

        if ($("lsAutoOpenDawCheck")?.checked && window.LiveStudioDaw && (res.dryCh1File || res.dryCh2File || res.masterFile)) {
          window.LiveStudioDaw.openFromRecording(res);
        }
        updateResourceStrip();
      } catch (err) {
        updateRecorderUi();
        showStudioMessage("Error stopping recording: " + err.message, true);
      }
    }

    if ($("lsPickSsdFolderBtn")) {
      $("lsPickSsdFolderBtn").onclick = async () => {
        if (!window.LiveStudioRecorder) return;
        try {
          const picked = await window.LiveStudioRecorder.pickDirectory();
          if (picked.fallbackOnly) {
            showStudioMessage(
              "Folder streaming requires Chrome/Edge on desktop. Fallback downloads remain active.",
              true
            );
            return;
          }
          if ($("lsRecFolderLabel")) {
            $("lsRecFolderLabel").textContent = `SSD Folder Ready: ${picked.name}`;
          }
          syncFolderStatusUi();
          updateResourceStrip();
          showStudioMessage(`Selected SSD folder "${picked.name}" for lossless WAV + MP3 capture.`, false);
        } catch (err) {
          if (err && err.name !== "AbortError") {
            showStudioMessage("Could not open folder: " + err.message, true);
          }
        }
      };
    }

    if ($("lsStartRecOnlyBtn")) {
      $("lsStartRecOnlyBtn").onclick = () => startRecordingWorkflow(false);
    }
    if ($("lsRecordAndLiveBtn")) {
      $("lsRecordAndLiveBtn").onclick = () => startRecordingWorkflow(true);
    }
    if ($("lsStopRecBtn")) {
      $("lsStopRecBtn").onclick = stopRecordingWorkflow;
    }

    if ($("lsR2CustomFileInput")) {
      $("lsR2CustomFileInput").onchange = function () {
        const file = this.files && this.files[0] ? this.files[0] : null;
        customPublishFile = file;
        if (file) {
          publishArtifactRole = "final_master";
          const artifactName = file.name.toLowerCase().endsWith(".wav") ? "final-master.wav" : "final-master.mp3";
          if ($("lsR2SourceLabel")) {
            $("lsR2SourceLabel").textContent = `Selected Master: ${file.name} (${(file.size / (1024 * 1024)).toFixed(2)} MB)`;
          }
          if ($("lsR2KeyInput")) {
            $("lsR2KeyInput").value = resolveStructuredR2Key(artifactName);
          }
          if ($("lsPublishR2Btn")) $("lsPublishR2Btn").disabled = false;
        }
      };
    }

    if ($("lsAddManualTsBtn")) {
      $("lsAddManualTsBtn").onclick = () => {
        const title = window.prompt("Bhajan Title for timestamp marker:", "");
        if (!title || !title.trim()) return;
        const singer = window.prompt("Singer Name:", "Samiti Singer") || "Samiti Singer";
        const defaultSec =
          window.LiveStudioRecorder && window.LiveStudioRecorder.isRecording()
            ? window.LiveStudioRecorder.getStats().elapsedSeconds
            : 0;
        const timeStr = window.prompt("Start Timestamp (MM:SS):", formatTsMmSs(defaultSec));
        if (timeStr === null) return;
        capturedTimestamps.push({
          submission_id: null,
          bhajan_title: title.trim(),
          singer_name: singer.trim(),
          deity: "",
          start_seconds: parseTsInputToSeconds(timeStr)
        });
        saveTimestampsToLocal();
        renderTimestampsEditor();
      };
    }

    if ($("lsExportAuditionCsvBtn")) {
      $("lsExportAuditionCsvBtn").onclick = () => {
        if (!window.LiveStreamWavUtils) return;
        const csv = window.LiveStreamWavUtils.formatAuditionMarkersCsv(capturedTimestamps);
        const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${$("lsSessionDateInput")?.value || "session"}_Audition_Markers.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      };
    }

    if ($("lsPublishR2Btn")) {
      $("lsPublishR2Btn").onclick = async function () {
        const fileToUpload = customPublishFile || (lastRecordedResult && lastRecordedResult.masterFile);
        if (!fileToUpload) {
          showStudioMessage("Record a session or select an MP3/WAV file to upload first.", true);
          return;
        }

        const btn = this;
        btn.disabled = true;
        const progressWrap = $("lsR2ProgressWrap");
        const progressFill = $("lsR2ProgressFill");
        const statusText = $("lsR2StatusText");
        if (progressWrap) progressWrap.style.display = "block";
        if (progressFill) progressFill.style.width = "2%";

        let durationSec =
          !customPublishFile && lastRecordedResult ? lastRecordedResult.durationSeconds : 0;
        if (!durationSec) {
          durationSec = await new Promise((resolve) => {
            const tempAudio = document.createElement("audio");
            const objUrl = URL.createObjectURL(fileToUpload);
            tempAudio.preload = "metadata";
            tempAudio.onloadedmetadata = () => {
              const dur = Math.round(tempAudio.duration || 0);
              URL.revokeObjectURL(objUrl);
              resolve(dur);
            };
            tempAudio.onerror = () => {
              URL.revokeObjectURL(objUrl);
              resolve(0);
            };
            tempAudio.src = objUrl;
          });
        }

        const recState = window.LiveStudioRecorder && typeof window.LiveStudioRecorder.getState === "function"
          ? window.LiveStudioRecorder.getState()
          : {};
        const sUid = (lastRecordedResult && lastRecordedResult.projectUid) || recState.projectUid || null;

        try {
          const pubResult = await window.LiveStudioRecorder.uploadFileToR2AndPublish({
            file: fileToUpload,
            sessionDate: ($("lsSessionDateInput")?.value || boot.sessionDate || "").trim(),
            sessionUid: sUid,
            title: ($("lsR2TitleInput")?.value || "Bhajan Session").trim(),
            storageKey: ($("lsR2KeyInput")?.value || "").trim(),
            durationSeconds: durationSec,
            timestamps: capturedTimestamps,
            isPublished: true,
            notifyDevotees: Boolean($("lsR2NotifyDevoteesCheck")?.checked),
            artifactRole: customPublishFile ? publishArtifactRole : "live_ref",
            projectManifest: publishProjectManifest,
            csrfToken,
            onProgress: (info) => {
              if (progressFill) progressFill.style.width = `${info.pct || 0}%`;
              if (statusText) statusText.textContent = info.message || "";
            }
          });
          showStudioMessage(
            `Published "${pubResult.audio.title}" to Cloudflare R2 with ${pubResult.timestampCount} bhajan timestamps!`,
            false
          );
          unexportedRecordingGuard = false;
          if (window.LiveStudioDaw && typeof window.LiveStudioDaw.markExportedClean === "function") {
            window.LiveStudioDaw.markExportedClean();
          }
        } catch (err) {
          if (statusText) statusText.textContent = err.message;
          showStudioMessage("Cloudflare R2 Publish failed: " + err.message, true);
        } finally {
          btn.disabled = false;
          updateResourceStrip();
        }
      };
    }

    if ($("lsBackupDryStemsR2Btn")) {
      $("lsBackupDryStemsR2Btn").onclick = async function () {
        if (!lastRecordedResult || (!lastRecordedResult.dryCh1File && !lastRecordedResult.dryCh2File)) {
          showStudioMessage("No dry Ch1/Ch2 WAV stems available from current session.", true);
          return;
        }
        const btn = this;
        btn.disabled = true;
        const files = [lastRecordedResult.dryCh1File, lastRecordedResult.dryCh2File].filter(Boolean);
        try {
          const sDate = ($("lsSessionDateInput")?.value || boot.sessionDate || "").trim();
          const uploaded = await window.LiveStudioRecorder.backupDryStemsToR2({
            files,
            sessionDate: sDate,
            sessionUid: lastRecordedResult.projectUid,
            csrfToken,
            onProgress: (info) => {
              if ($("lsR2ProgressWrap")) $("lsR2ProgressWrap").style.display = "block";
              if ($("lsR2ProgressFill")) $("lsR2ProgressFill").style.width = `${info.pct || 0}%`;
              if ($("lsR2StatusText")) $("lsR2StatusText").textContent = info.message || "";
            }
          });
          showStudioMessage(`Backed up ${uploaded.length} dry WAV stem(s) privately to Cloudflare R2!`, false);
        } catch (err) {
          showStudioMessage("Dry stem backup failed: " + err.message, true);
        } finally {
          btn.disabled = false;
        }
      };
    }

    if ($("lsRetryQueuedUploadsBtn")) {
      $("lsRetryQueuedUploadsBtn").onclick = async function () {
        if (!window.LiveStudioRecorder || typeof window.LiveStudioRecorder.retryPendingUploads !== "function") return;
        const btn = this;
        btn.disabled = true;
        try {
          const results = await window.LiveStudioRecorder.retryPendingUploads({
            csrfToken,
            onProgress: (info) => {
              if ($("lsR2ProgressWrap")) $("lsR2ProgressWrap").style.display = "block";
              if ($("lsR2ProgressFill")) $("lsR2ProgressFill").style.width = `${info.pct || 0}%`;
              if ($("lsR2StatusText")) $("lsR2StatusText").textContent = info.message || "";
            }
          });
          const okCount = results.filter((r) => r.success).length;
          showStudioMessage(
            okCount > 0
              ? `Retried & published ${okCount} queued upload(s) to Cloudflare R2!`
              : "No queued uploads completed (check connection or re-select file).",
            okCount === 0
          );
        } catch (err) {
          showStudioMessage("Retry queued uploads failed: " + err.message, true);
        } finally {
          updateResourceStrip();
        }
      };
    }

    window.addEventListener("online", () => {
      updateResourceStrip();
      const pending = window.LiveStudioRecorder ? window.LiveStudioRecorder.getPendingUploads() : [];
      if (pending.length > 0 && $("lsR2StatusText")) {
        $("lsR2StatusText").textContent = `Connection restored — ${pending.length} queued upload(s) ready. Click Retry Queued.`;
      }
    });

    window.LiveStudioBridge = {
      getTimestamps: () => capturedTimestamps.slice(),
      setTimestamps: (nextList) => {
        capturedTimestamps = Array.isArray(nextList) ? nextList.slice() : [];
        saveTimestampsToLocal();
        renderTimestampsEditor();
      },
      setReadyPublishFile: (file, durationSec, meta = {}) => {
        customPublishFile = file;
        publishArtifactRole = meta.artifactRole || "final_master";
        if (meta.projectManifest) publishProjectManifest = meta.projectManifest;
        if (!lastRecordedResult) lastRecordedResult = {};
        if (durationSec) lastRecordedResult.durationSeconds = durationSec;
        if (file) {
          const artifactName = file.name.toLowerCase().endsWith(".wav") ? "final-master.wav" : "final-master.mp3";
          if ($("lsR2SourceLabel")) {
            $("lsR2SourceLabel").textContent = `Edited Master Ready: ${file.name} (${(file.size / (1024 * 1024)).toFixed(2)} MB)`;
          }
          if ($("lsR2KeyInput")) {
            $("lsR2KeyInput").value = resolveStructuredR2Key(artifactName);
          }
          if ($("lsPublishR2Btn")) $("lsPublishR2Btn").disabled = false;
        }
      },
      getActiveFxConfig: () => JSON.parse(JSON.stringify(activeConfig)),
      getSessionDate: () => ($("lsSessionDateInput")?.value || boot.sessionDate || "").trim(),
      getSessionMeta: () => ({
        sessionDate: ($("lsSessionDateInput")?.value || boot.sessionDate || "").trim(),
        title: ($("lsR2TitleInput")?.value || $("lsTitleInput")?.value || "Bhajan Session").trim(),
        r2Key: ($("lsR2KeyInput")?.value || "").trim(),
        projectUid:
          (lastRecordedResult && lastRecordedResult.projectUid) ||
          (window.LiveStudioRecorder && typeof window.LiveStudioRecorder.getState === "function"
            ? window.LiveStudioRecorder.getState().projectUid
            : null)
      }),
      getSelectedDirHandleName: () =>
        window.LiveStudioRecorder && typeof window.LiveStudioRecorder.getState === "function"
          ? window.LiveStudioRecorder.getState().folderName
          : null,
      getInputChannelCatalog: () => getActiveChannelCatalog(),
      getInputRouting: () => ({
        ch1: activeConfig.ch1InputSource,
        ch2: activeConfig.ch2InputSource
      }),
      isBridgeStandby: () => bridgeStandbyMode,
      getLivePinLevels: () => ({ ...livePinLevels }),
      subscribeRawMultiChannel: (fn) => {
        if (typeof fn !== "function") return;
        rawMcSubscribers.add(fn);
        syncBridgeMultichannelTap();
      },
      unsubscribeRawMultiChannel: (fn) => {
        rawMcSubscribers.delete(fn);
        syncBridgeMultichannelTap();
      },
      setMultichannelTapEnabled: (enabled) => {
        if (!enabled) rawMcSubscribers.clear();
        syncBridgeMultichannelTap();
      },
      startTrackAutoDetect: async (onDetected, targetLabel) => {
        stopInputAutoDetect(true);
        const isBridgeMonitoring = Boolean(
          (asioSocket && asioSocket.readyState === 1) ||
          (bridgeMonitorSocket && bridgeMonitorSocket.readyState === 1)
        );
        if (!audioCtx && !isBridgeMonitoring) {
          await probeLocalAudioBridge(true);
        }
        inputLearnState = {
          targetBus: "daw-track",
          startedAt: Date.now(),
          streakPin: -1,
          streakCount: 0,
          onDetected,
          timer: setTimeout(() => {
            if (inputLearnState && inputLearnState.targetBus === "daw-track") {
              stopInputAutoDetect(true);
              showStudioMessage(
                `No live signal detected for ${targetLabel || "DAW Track"} within 7s.`,
                true
              );
            }
          }, 7000)
        };
        renderLivePinDetectionUi(true);
      },
      stopTrackAutoDetect: () => stopInputAutoDetect(true),
      cleanHardwareDeviceLabel,
      buildDetectedChannelCatalog,
      getBhajans: () => bhajansList.slice()
    };

    async function updateResourceStrip() {
      const recState =
        window.LiveStudioRecorder && typeof window.LiveStudioRecorder.getState === "function"
          ? window.LiveStudioRecorder.getState()
          : {};
      if ($("lsResEngineLoad")) {
        const backendLbl = activeSourceMode === "asio" ? "ASIO/Bridge" : activeSourceMode === "file" ? "Test File" : "WASAPI";
        const srTxt = audioCtx ? `${Math.round(audioCtx.sampleRate / 100) / 10}k` : "48k";
        const latMs = audioCtx && Number.isFinite(audioCtx.baseLatency) ? ` ${(audioCtx.baseLatency * 1000).toFixed(1)}ms` : "";
        $("lsResEngineLoad").textContent = audioCtx ? `${backendLbl} (${srTxt}${latMs})` : "Idle";
      }
      if ($("lsResXruns")) {
        const drops = (recState.droppedFrames || 0) + (asioXruns || 0) + (recState.writeErrorCount || 0);
        $("lsResXruns").textContent = String(drops);
      }
      if ($("lsResDiskFree")) {
        if (window.LiveStudioRecorder && typeof window.LiveStudioRecorder.getDiskEstimate === "function") {
          try {
            const disk = await window.LiveStudioRecorder.getDiskEstimate();
            if (disk && disk.supported && Number.isFinite(disk.availableBytes)) {
              const gb = (disk.availableBytes / (1024 * 1024 * 1024)).toFixed(1);
              $("lsResDiskFree").textContent = recState.folderName ? `${gb} GB (${recState.folderName})` : `${gb} GB free`;
            } else {
              $("lsResDiskFree").textContent = recState.folderName || "Fallback";
            }
          } catch (_) {
            $("lsResDiskFree").textContent = recState.folderName || "Fallback";
          }
        } else {
          $("lsResDiskFree").textContent = recState.folderName || "Fallback";
        }
      }
      const persistedPending = window.LiveStudioRecorder && typeof window.LiveStudioRecorder.getPendingUploads === "function"
        ? window.LiveStudioRecorder.getPendingUploads().length
        : 0;
      const qCount = Math.max(Number(recState.offlineQueueCount || 0), persistedPending);
      if ($("lsResPendingUploads")) {
        $("lsResPendingUploads").textContent = qCount > 0 ? `${qCount} queued` : (isLive ? "Live Streaming" : "0 queued");
      }
      if ($("lsQueuedCountBadge")) $("lsQueuedCountBadge").textContent = String(qCount);
      if ($("lsRetryQueuedUploadsBtn")) $("lsRetryQueuedUploadsBtn").disabled = qCount === 0;
      if ($("lsResHeap") && window.performance && window.performance.memory) {
        const mb = Math.round(window.performance.memory.usedJSHeapSize / (1024 * 1024));
        $("lsResHeap").textContent = `${mb} MB`;
      }
    }

    setInterval(updateResourceStrip, 2500);
    updateResourceStrip();

    if ($("lsDawAutoLoadRecBtn")) {
      $("lsDawAutoLoadRecBtn").onclick = () => {
        if (lastRecordedResult && window.LiveStudioDaw) {
          window.LiveStudioDaw.openFromRecording(lastRecordedResult);
        }
      };
    }

    function setProcTab(tabName) {
      activeProcTab = tabName || "vocal";
      document.querySelectorAll("[data-proc-tab-btn]").forEach((btn) => {
        btn.classList.toggle("is-active", btn.dataset.procTabBtn === activeProcTab);
      });
      document.querySelectorAll(".ls-vstrip[data-proc-tab]").forEach((strip) => {
        strip.classList.toggle("is-active-strip", strip.dataset.procTab === activeProcTab);
      });
      document.querySelectorAll("[data-proc-pane]").forEach((pane) => {
        pane.classList.toggle("ls-is-hidden", pane.dataset.procPane !== activeProcTab);
      });
      drawChannelProcCanvas();
    }

    document.querySelectorAll("[data-proc-tab-btn]").forEach((btn) => {
      btn.addEventListener("click", () => setProcTab(btn.dataset.procTabBtn));
    });
    document.querySelectorAll(".ls-vstrip[data-proc-tab]").forEach((strip) => {
      strip.addEventListener("click", () => setProcTab(strip.dataset.procTab));
    });

    function setChSubTab(pair) {
      const parts = String(pair || "").split(":");
      if (parts.length !== 2) return;
      const ch = parts[0];
      const tab = parts[1];
      activeChSubTabs[ch] = tab;
      document.querySelectorAll(`[data-ch-subtab^="${ch}:"]`).forEach((btn) => {
        btn.classList.toggle("is-active", btn.dataset.chSubtab === pair);
      });
      document.querySelectorAll(`[data-ch-subpane^="${ch}:"]`).forEach((pane) => {
        pane.classList.toggle("ls-is-hidden", pane.dataset.chSubpane !== pair);
      });
      drawChannelProcCanvas();
    }

    document.querySelectorAll("[data-ch-subtab]").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        setChSubTab(btn.dataset.chSubtab);
      });
    });

    function wireEqCanvasInteraction() {
      const canvas = $("lsEqSpectrumCanvas");
      if (!canvas) return;
      const bands = [
        { key: "b80", freq: 80, sliderId: "lsMaster80", valId: "lsMaster80Val", def: 0.5 },
        { key: "b250", freq: 250, sliderId: "lsMaster250", valId: "lsMaster250Val", def: -1.5 },
        { key: "b1k", freq: 1000, sliderId: "lsMaster1k", valId: "lsMaster1kVal", def: 0 },
        { key: "b3k5", freq: 3500, sliderId: "lsMaster3k5", valId: "lsMaster3k5Val", def: 1.5 },
        { key: "b10k", freq: 10000, sliderId: "lsMaster10k", valId: "lsMaster10kVal", def: 1.0 }
      ];
      let draggingBand = null;

      function getCoords(ev) {
        const rect = canvas.getBoundingClientRect();
        const w = canvas.width || 720;
        const h = canvas.height || 164;
        return {
          x: ((ev.clientX - rect.left) / Math.max(1, rect.width)) * w,
          y: ((ev.clientY - rect.top) / Math.max(1, rect.height)) * h,
          w,
          h
        };
      }

      canvas.addEventListener("pointerdown", (ev) => {
        const pos = getCoords(ev);
        const logRange = Math.log10(18000 / 20);
        let closest = null;
        let closestDist = 26;
        bands.forEach((b) => {
          const bx = (Math.log10(b.freq / 20) / logRange) * pos.w;
          const curDb = activeConfig.master.bypass ? 0 : Number(activeConfig.master[b.key] || 0);
          const by = pos.h * 0.5 - (curDb / 15) * (pos.h * 0.38);
          const dist = Math.hypot(pos.x - bx, pos.y - by);
          if (dist < closestDist) {
            closestDist = dist;
            closest = b;
          }
        });
        if (closest) {
          draggingBand = closest;
          if (typeof canvas.setPointerCapture === "function") {
            try { canvas.setPointerCapture(ev.pointerId); } catch (_) { }
          }
        }
      });

      canvas.addEventListener("pointermove", (ev) => {
        if (!draggingBand) return;
        const pos = getCoords(ev);
        const rawDb = ((pos.h * 0.5 - pos.y) / (pos.h * 0.38)) * 15;
        const snappedDb = Math.max(-12, Math.min(12, Math.round(rawDb * 2) / 2));
        activeConfig.master[draggingBand.key] = snappedDb;
        activeConfig.master.bypass = false;
        const slider = $(draggingBand.sliderId);
        const lbl = $(draggingBand.valId);
        if (slider) slider.value = String(snappedDb);
        if (lbl) lbl.textContent = `${snappedDb} dB`;
        applyConfigToGraph();
        drawEqAndSpectrum();
      });

      const endDrag = () => { draggingBand = null; };
      canvas.addEventListener("pointerup", endDrag);
      canvas.addEventListener("pointercancel", endDrag);

      canvas.addEventListener("dblclick", (ev) => {
        const pos = getCoords(ev);
        const logRange = Math.log10(18000 / 20);
        let closest = bands[0];
        let best = Infinity;
        bands.forEach((b) => {
          const bx = (Math.log10(b.freq / 20) / logRange) * pos.w;
          const d = Math.abs(pos.x - bx);
          if (d < best) { best = d; closest = b; }
        });
        if (best < 40) {
          activeConfig.master[closest.key] = 0;
          syncUiFromConfig();
        }
      });
    }
    wireEqCanvasInteraction();

    function setRecTab(tabName) {
      const target = tabName || "ssd";
      document.querySelectorAll("[data-rec-tab-btn]").forEach((btn) => {
        btn.classList.toggle("is-active", btn.dataset.recTabBtn === target);
      });
      document.querySelectorAll("[data-rec-pane]").forEach((pane) => {
        pane.classList.toggle("ls-is-hidden", pane.dataset.recPane !== target);
      });
    }

    document.querySelectorAll("[data-rec-tab-btn]").forEach((btn) => {
      btn.addEventListener("click", () => setRecTab(btn.dataset.recTabBtn));
    });

    function polarToCartesian(cx, cy, r, deg) {
      const rad = ((deg - 90) * Math.PI) / 180;
      return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
    }

    function describeArc(cx, cy, r, startDeg, endDeg) {
      if (Math.abs(endDeg - startDeg) < 0.5) return "";
      const lo = Math.min(startDeg, endDeg);
      const hi = Math.max(startDeg, endDeg);
      const start = polarToCartesian(cx, cy, r, lo);
      const end = polarToCartesian(cx, cy, r, hi);
      const largeArc = hi - lo > 180 ? 1 : 0;
      return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
    }

    function syncRotaryVisuals() {
      document.querySelectorAll("svg.ls-rotary-svg[data-rotary-for]").forEach((svg) => {
        const input = $(svg.dataset.rotaryFor);
        if (!input) return;
        const min = Number(input.min ?? 0);
        const max = Number(input.max ?? 100);
        const val = Number(input.value ?? min);
        const norm = Math.max(0, Math.min(1, (val - min) / Math.max(1e-6, max - min)));
        const angle = -135 + norm * 270;

        const needle = svg.querySelector(".ls-rotary-needle");
        if (needle) {
          const tip = polarToCartesian(20, 20, 11.5, angle);
          needle.setAttribute("x1", "20");
          needle.setAttribute("y1", "20");
          needle.setAttribute("x2", tip.x.toFixed(2));
          needle.setAttribute("y2", tip.y.toFixed(2));
        }
        const arc = svg.querySelector(".ls-rotary-arc");
        if (arc) {
          const startAngle = min < 0 && max > 0 ? 0 : -135;
          arc.setAttribute("d", describeArc(20, 20, 15, startAngle, angle));
        }
      });
      if ($("lsReverbDecayChip") && $("lsReverbDecay")) {
        $("lsReverbDecayChip").textContent = `Decay ${Number($("lsReverbDecay").value || 1.4).toFixed(1)}s`;
      }
    }

    function wireRotaryKnobs() {
      document.querySelectorAll("svg.ls-rotary-svg[data-rotary-for]").forEach((svg) => {
        const input = $(svg.dataset.rotaryFor);
        if (!input) return;
        input.addEventListener("input", syncRotaryVisuals);

        let dragging = false;
        let startY = 0;
        let startVal = 0;

        svg.addEventListener("mousedown", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          dragging = true;
          startY = ev.clientY;
          startVal = Number(input.value ?? 0);
          svg.classList.add("is-dragging");
        });
        window.addEventListener("mousemove", (ev) => {
          if (!dragging) return;
          const min = Number(input.min ?? 0);
          const max = Number(input.max ?? 100);
          const step = Number(input.step) || 1;
          const span = max - min;
          const raw = startVal + ((startY - ev.clientY) / 110) * span;
          const snapped = Math.round(raw / step) * step;
          const clamped = Math.max(min, Math.min(max, Number(snapped.toFixed(3))));
          if (Number(input.value) !== clamped) {
            input.value = String(clamped);
            input.dispatchEvent(new Event("input", { bubbles: true }));
          }
        });
        window.addEventListener("mouseup", () => {
          if (!dragging) return;
          dragging = false;
          svg.classList.remove("is-dragging");
        });
        svg.addEventListener("dblclick", (ev) => {
          ev.stopPropagation();
          const defVal = input.id === "lsReverbDecay" ? 1.4 : 0;
          input.value = String(defVal);
          input.dispatchEvent(new Event("input", { bubbles: true }));
        });
      });
      syncRotaryVisuals();
    }
    wireRotaryKnobs();

    const redrawOnThemeChange = () => {
      window.requestAnimationFrame(() => {
        drawEqAndSpectrum();
        drawChannelProcCanvas();
      });
    };
    window.addEventListener("themechange", redrawOnThemeChange);
    window.addEventListener("resize", redrawOnThemeChange);
    if (typeof MutationObserver === "function") {
      const themeObs = new MutationObserver(redrawOnThemeChange);
      themeObs.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme", "class"]
      });
      if (document.body) {
        themeObs.observe(document.body, {
          attributes: true,
          attributeFilter: ["data-theme", "class"]
        });
      }
    }

    function syncFolderStatusUi() {
      const lbl = $("lsRecFolderLabel");
      if (!lbl || !window.LiveStudioRecorder) return;
      const summary = window.LiveStudioRecorder.getStorageSummary
        ? window.LiveStudioRecorder.getStorageSummary()
        : { mode: window.LiveStudioRecorder.getDirectoryName() ? "user_folder" : "memory", folderName: window.LiveStudioRecorder.getDirectoryName() };
      if (summary.folderName) {
        lbl.textContent = `SSD Folder Ready: ${summary.folderName}`;
      } else if (summary.savedPendingName) {
        lbl.textContent = `Previous folder "${summary.savedPendingName}" (click Choose Folder to re-grant) — Default SSD Vault active`;
      } else if (summary.mode === "opfs_vault") {
        lbl.textContent = `Default SSD Vault active (${summary.vaultPath || "BhajanPlanner/Recordings"}) — or Choose Folder`;
      } else {
        lbl.textContent = "Browser RAM capture (auto-downloads on stop) — Choose Folder for direct SSD";
      }
    }

    async function refreshVaultRecoveryBanner() {
      const banner = $("lsVaultRecoveryBanner");
      const txtEl = $("lsVaultRecoveryText");
      if (!banner || !window.LiveStudioRecorder || typeof window.LiveStudioRecorder.listVaultSessions !== "function") {
        return;
      }
      try {
        const sessions = await window.LiveStudioRecorder.listVaultSessions();
        if (!sessions || sessions.length === 0) {
          banner.classList.add("ls-is-hidden");
          return;
        }
        const curDate = ($("lsSessionDateInput")?.value || boot.sessionDate || "").trim();
        const latest = sessions.find((s) => s.sessionDate === curDate) || sessions[0];
        const mb = (latest.totalBytes / (1024 * 1024)).toFixed(1);
        const parts = [];
        if (latest.hasCh1) parts.push("Ch1 WAV");
        if (latest.hasCh2) parts.push("Ch2 WAV");
        if (latest.hasMaster) parts.push("MP3");
        if (txtEl) {
          txtEl.textContent = `${latest.sessionDate} · ${formatTsMmSs(latest.durationSeconds)} · ${mb} MB (${parts.join(" + ")})`;
        }
        banner.classList.remove("ls-is-hidden");

        const openBtn = $("lsVaultRecoverDawBtn");
        const dlBtn = $("lsVaultDownloadBtn");
        const delBtn = $("lsVaultDeleteBtn");

        if (openBtn) {
          openBtn.onclick = async () => {
            openBtn.disabled = true;
            try {
              const loaded = await window.LiveStudioRecorder.loadVaultSession(latest.dirNameDate, latest.dirNameUid);
              lastRecordedResult = loaded;
              if (loaded.timestamps && loaded.timestamps.length > 0 && capturedTimestamps.length === 0) {
                capturedTimestamps = loaded.timestamps.slice();
                saveTimestampsToLocal();
                renderTimestampsEditor();
              }
              if ($("lsBackupDryStemsR2Btn")) {
                $("lsBackupDryStemsR2Btn").disabled = !(loaded.dryCh1File || loaded.dryCh2File);
              }
              if ($("lsDawAutoLoadRecBtn")) {
                $("lsDawAutoLoadRecBtn").disabled = !(loaded.dryCh1File || loaded.dryCh2File || loaded.masterFile);
              }
              if (loaded.masterFile && $("lsR2SourceLabel")) {
                $("lsR2SourceLabel").textContent = `Recovered from SSD Vault: ${loaded.masterFile.name} (${(loaded.masterFile.size / (1024 * 1024)).toFixed(2)} MB)`;
                if ($("lsPublishR2Btn")) $("lsPublishR2Btn").disabled = false;
              }
              if (window.LiveStudioDaw && typeof window.LiveStudioDaw.openFromRecording === "function") {
                await window.LiveStudioDaw.openFromRecording(loaded);
              }
              showStudioMessage(`Recovered recording "${latest.sessionUid}" from Default SSD Vault into DAW!`, false);
            } catch (err) {
              showStudioMessage("Failed to recover vault session: " + err.message, true);
            } finally {
              openBtn.disabled = false;
            }
          };
        }

        if (dlBtn) {
          dlBtn.onclick = async () => {
            dlBtn.disabled = true;
            try {
              const loaded = await window.LiveStudioRecorder.loadVaultSession(latest.dirNameDate, latest.dirNameUid);
              triggerStemDownloads(loaded.fallbackDownloads || []);
              unexportedRecordingGuard = false;
              showStudioMessage(`Saving ${loaded.fallbackDownloads.length} recovered file(s) from SSD Vault to Downloads...`, false);
            } catch (err) {
              showStudioMessage("Failed to export vault stems: " + err.message, true);
            } finally {
              dlBtn.disabled = false;
            }
          };
        }

        if (delBtn) {
          delBtn.onclick = async () => {
            delBtn.disabled = true;
            try {
              await window.LiveStudioRecorder.deleteVaultSession(latest.dirNameDate, latest.dirNameUid);
              await refreshVaultRecoveryBanner();
              showStudioMessage(`Cleared SSD Vault recording (${latest.sessionUid}).`, false);
            } catch (err) {
              showStudioMessage("Could not clear SSD Vault entry: " + err.message, true);
            } finally {
              delBtn.disabled = false;
            }
          };
        }
      } catch (_) { }
    }
    window.refreshVaultRecoveryBanner = refreshVaultRecoveryBanner;

    if (window.LiveStudioRecorder && typeof window.LiveStudioRecorder.restoreSavedDirectory === "function") {
      window.LiveStudioRecorder.restoreSavedDirectory().then(() => {
        syncFolderStatusUi();
        updateResourceStrip();
      });
    } else {
      syncFolderStatusUi();
    }
    refreshVaultRecoveryBanner();

    function getStudioProtectionStatus() {
      const recActive = Boolean(window.LiveStudioRecorder && window.LiveStudioRecorder.isRecording());
      const dawDirty = Boolean(
        window.LiveStudioDaw &&
        typeof window.LiveStudioDaw.hasUnsavedChanges === "function" &&
        window.LiveStudioDaw.hasUnsavedChanges()
      );
      const reasons = [];
      if (isLive) reasons.push("Live broadcast is currently ON AIR");
      if (recActive) reasons.push("Multitrack recording is actively writing stems");
      if (!recActive && unexportedRecordingGuard) reasons.push("Recorded session stems have not been published or saved");
      if (dawDirty) reasons.push("DAW project has unexported edits");

      const recState = window.LiveStudioRecorder && typeof window.LiveStudioRecorder.getState === "function"
        ? window.LiveStudioRecorder.getState()
        : {};
      const canSaveStems = Boolean(
        !recActive &&
        lastRecordedResult &&
        Array.isArray(lastRecordedResult.fallbackDownloads) &&
        lastRecordedResult.fallbackDownloads.length > 0
      );
      return {
        protected: reasons.length > 0,
        reasons,
        recActive,
        canSaveStems,
        vaultBacked: recState.storageBackend === "opfs_vault" || Boolean(lastRecordedResult && lastRecordedResult.savedToDefaultVault)
      };
    }

    function armStudioHistoryGuard() {
      if (historyGuardArmed || !window.history || typeof window.history.pushState !== "function") return;
      try {
        window.history.pushState({ bpStudioGuard: true }, "", window.location.href);
        historyGuardArmed = true;
      } catch (_) { }
    }
    window.armStudioHistoryGuard = armStudioHistoryGuard;

    function triggerGuardPulse() {
      const dialog = $("lsRefreshGuardDialog");
      if (!dialog) return;
      dialog.classList.remove("is-locked-pulse");
      void dialog.offsetWidth;
      dialog.classList.add("is-locked-pulse");
    }

    function applyScreenFreeze(freeze) {
      const htmlEl = document.documentElement;
      const bodyEl = document.body;
      if (freeze) {
        if (htmlEl) htmlEl.classList.add("ls-screen-frozen");
        if (bodyEl) bodyEl.classList.add("ls-screen-frozen");
        frozenInertElements = [];
        const candidates = document.querySelectorAll(
          ".sidebar, .topbar, .ls-console-topbar, #lsResourceStrip, #lsIoRibbonDetails, #lsTabLivePane, #lsTabDawPane"
        );
        candidates.forEach((el) => {
          if (!el || el.closest("#lsRefreshGuardDialog")) return;
          frozenInertElements.push({
            el,
            prevInert: Boolean(el.inert),
            prevAriaHidden: el.getAttribute("aria-hidden")
          });
          el.inert = true;
          el.setAttribute("aria-hidden", "true");
        });
      } else {
        if (htmlEl) htmlEl.classList.remove("ls-screen-frozen");
        if (bodyEl) bodyEl.classList.remove("ls-screen-frozen");
        frozenInertElements.forEach((entry) => {
          try {
            entry.el.inert = entry.prevInert;
            if (entry.prevAriaHidden === null) {
              entry.el.removeAttribute("aria-hidden");
            } else {
              entry.el.setAttribute("aria-hidden", entry.prevAriaHidden);
            }
          } catch (_) { }
        });
        frozenInertElements = [];
      }
    }

    function trapGuardWheelTouch(ev) {
      if (!refreshGuardOpen) return;
      ev.preventDefault();
      ev.stopPropagation();
    }

    function trapGuardKeydown(ev) {
      if (!refreshGuardOpen) return;
      const dialog = $("lsRefreshGuardDialog");
      const actionsBox = $("lsRefreshGuardActions");
      const key = String(ev.key || "");

      if (key === "Tab" && actionsBox) {
        const focusables = Array.from(actionsBox.querySelectorAll("button:not(:disabled)")).filter(
          (b) => b.style.display !== "none"
        );
        if (focusables.length > 0) {
          const idx = focusables.indexOf(document.activeElement);
          let nextIdx;
          if (ev.shiftKey) {
            nextIdx = idx <= 0 ? focusables.length - 1 : idx - 1;
          } else {
            nextIdx = idx === -1 || idx >= focusables.length - 1 ? 0 : idx + 1;
          }
          ev.preventDefault();
          ev.stopPropagation();
          focusables[nextIdx].focus();
          return;
        }
      }

      if ((key === "Enter" || ev.code === "Space") && dialog && document.activeElement && dialog.contains(document.activeElement)) {
        return;
      }

      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
      triggerGuardPulse();
    }

    function closeRefreshGuardModal() {
      const dialog = $("lsRefreshGuardDialog");
      refreshGuardOpen = false;
      pendingGuardAction = null;
      applyScreenFreeze(false);
      window.removeEventListener("wheel", trapGuardWheelTouch, true);
      window.removeEventListener("touchmove", trapGuardWheelTouch, true);
      window.removeEventListener("keydown", trapGuardKeydown, true);
      if (dialog) {
        try {
          if (typeof dialog.close === "function" && dialog.open) dialog.close();
        } catch (_) { }
        dialog.removeAttribute("open");
      }
    }

    function openRefreshGuardModal(actionInfo) {
      const status = getStudioProtectionStatus();
      if (!status.protected) return false;

      const dialog = $("lsRefreshGuardDialog");
      if (!dialog) return false;

      pendingGuardAction = actionInfo || { actionType: "reload" };
      const titleEl = $("lsRefreshGuardTitle");
      const descEl = $("lsRefreshGuardDesc");
      const metaEl = $("lsRefreshGuardMeta");
      const saveBtn = $("lsGuardSaveStemsBtn");
      const leaveBtn = $("lsGuardConfirmLeaveBtn");

      const isLeave = pendingGuardAction.actionType === "navigate" || pendingGuardAction.actionType === "back";
      if (titleEl) {
        titleEl.textContent = status.recActive
          ? "Recording In Progress — Screen Locked"
          : (isLive ? "Live Broadcast ON AIR — Screen Locked" : "Unsaved Session Work — Confirm Refresh");
      }
      if (descEl) {
        descEl.textContent = status.recActive
          ? "You attempted to refresh or leave while recording. Stems are streaming to Default SSD Vault, but refreshing now will stop capture. Screen interaction is frozen until you choose an option:"
          : "You attempted to refresh or leave before publishing or closing this session. Screen interaction is frozen until you choose an option:";
      }
      if (metaEl) {
        const recStats = window.LiveStudioRecorder && window.LiveStudioRecorder.getStats ? window.LiveStudioRecorder.getStats() : null;
        const statsLine = status.recActive && recStats
          ? `Captured so far: ${formatTsMmSs(recStats.elapsedSeconds)} (${(recStats.totalBytes / (1024 * 1024)).toFixed(2)} MB)\n`
          : (status.vaultBacked ? "Safe copy stored in Default SSD Vault (BhajanPlanner/Recordings).\n" : "");
        metaEl.textContent = statsLine + status.reasons.join(" · ");
      }
      if (saveBtn) {
        saveBtn.style.display = status.canSaveStems ? "inline-flex" : "none";
      }
      if (leaveBtn) {
        leaveBtn.textContent = isLeave ? "Discard & Leave Page" : "Discard & Refresh Anyway";
      }

      refreshGuardOpen = true;
      applyScreenFreeze(true);
      window.addEventListener("wheel", trapGuardWheelTouch, { passive: false, capture: true });
      window.addEventListener("touchmove", trapGuardWheelTouch, { passive: false, capture: true });
      window.addEventListener("keydown", trapGuardKeydown, true);

      try {
        if (typeof dialog.showModal === "function") {
          if (!dialog.open) dialog.showModal();
        } else {
          dialog.setAttribute("open", "open");
        }
      } catch (_) {
        dialog.setAttribute("open", "open");
      }
      $("lsGuardStayBtn")?.focus();
      return true;
    }

    const guardDialog = $("lsRefreshGuardDialog");
    if (guardDialog) {
      guardDialog.addEventListener("cancel", (ev) => {
        ev.preventDefault();
        triggerGuardPulse();
      });
      guardDialog.addEventListener("click", (ev) => {
        if (ev.target === guardDialog) {
          ev.preventDefault();
          triggerGuardPulse();
        }
      });
    }

    if ($("lsGuardStayBtn")) {
      $("lsGuardStayBtn").onclick = () => {
        closeRefreshGuardModal();
        showStudioMessage("Stayed in Studio — recording and session state preserved.", false);
      };
    }

    if ($("lsGuardSaveStemsBtn")) {
      $("lsGuardSaveStemsBtn").onclick = () => {
        if (lastRecordedResult && Array.isArray(lastRecordedResult.fallbackDownloads) && lastRecordedResult.fallbackDownloads.length > 0) {
          triggerStemDownloads(lastRecordedResult.fallbackDownloads);
          unexportedRecordingGuard = false;
          closeRefreshGuardModal();
          showStudioMessage(`Triggered Download of ${lastRecordedResult.fallbackDownloads.length} session file(s). Stayed safely in Studio!`, false);
        } else {
          closeRefreshGuardModal();
        }
      };
    }

    if ($("lsGuardConfirmLeaveBtn")) {
      $("lsGuardConfirmLeaveBtn").onclick = async () => {
        const action = pendingGuardAction || { actionType: "reload" };
        bypassUnloadOnce = true;
        unexportedRecordingGuard = false;
        if (window.LiveStudioRecorder && window.LiveStudioRecorder.isRecording()) {
          try {
            await window.LiveStudioRecorder.stopRecording(capturedTimestamps);
          } catch (_) { }
        }
        closeRefreshGuardModal();
        if (action.actionType === "navigate" && action.targetUrl) {
          window.location.href = action.targetUrl;
        } else if (action.actionType === "back") {
          window.history.back();
        } else {
          window.location.reload();
        }
      };
    }

    const interceptRefreshKey = (ev) => {
      if (refreshGuardOpen) return;
      const key = String(ev.key || "").toLowerCase();
      const isReloadKey = key === "f5" || ((ev.ctrlKey || ev.metaKey) && key === "r");
      if (!isReloadKey) return;
      if (getStudioProtectionStatus().protected) {
        ev.preventDefault();
        ev.stopPropagation();
        ev.stopImmediatePropagation();
        openRefreshGuardModal({ actionType: "reload" });
      }
    };

    const interceptLinkNav = (ev) => {
      if (refreshGuardOpen) return;
      const anchor = ev.target && ev.target.closest ? ev.target.closest("a[href]") : null;
      if (!anchor || anchor.hasAttribute("download")) return;
      if (anchor.closest("#lsRefreshGuardDialog")) return;
      const href = anchor.getAttribute("href") || "";
      if (!href || href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("blob:") || anchor.target === "_blank") {
        return;
      }
      if (getStudioProtectionStatus().protected) {
        ev.preventDefault();
        ev.stopPropagation();
        ev.stopImmediatePropagation();
        openRefreshGuardModal({ actionType: "navigate", targetUrl: anchor.href });
      }
    };

    window.addEventListener("keydown", interceptRefreshKey, true);
    document.addEventListener("click", interceptLinkNav, true);
    try {
      if (window.parent && window.parent !== window && window.parent.location.origin === window.location.origin) {
        window.parent.addEventListener("keydown", interceptRefreshKey, true);
        window.parent.document.addEventListener("click", interceptLinkNav, true);
      }
    } catch (_) { }

    window.addEventListener("popstate", () => {
      if (bypassUnloadOnce) return;
      if (getStudioProtectionStatus().protected) {
        armStudioHistoryGuard();
        openRefreshGuardModal({ actionType: "back" });
      }
    });

    window.addEventListener("beforeunload", (ev) => {
      if (bypassUnloadOnce) return;
      const status = getStudioProtectionStatus();
      if (status.protected) {
        ev.preventDefault();
        ev.returnValue = "";
        openRefreshGuardModal({ actionType: "reload" });
      }
    });

    drawEqAndSpectrum();
    setProcTab("vocal");
    setRecTab("ssd");
    loadTimestampsFromLocal();
    renderTimestampsEditor();
    updateRecorderUi();

    // Subscribe to server SSE so listener count stays live even before WS ping
    if (typeof EventSource === "function") {
      eventSource = new EventSource("/api/live-stream/events");
      eventSource.addEventListener("status", (ev) => {
        try {
          const data = JSON.parse(ev.data);
          streamState = data;
          const cnt = $("lsListenerCount");
          if (cnt) cnt.textContent = String(data.listenerCount || 0);
        } catch (_) { }
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wireStudioEvents);
  } else {
    wireStudioEvents();
  }
})(window, document);
