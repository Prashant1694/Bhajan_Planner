/**
 * Multitrack Post-Production DAW UI, Dynamic Tracks, Modular Per-Track FX Rack,
 * Live Preview & Offline MP3 Mastering Renderer
 */
(function (window, document) {
  "use strict";

  const Engine = window.LiveStreamDawEngine;
  const Dsp = window.LiveStreamDsp;

  const state = Engine ? Engine.createInitialState() : null;
  const sourceBuffers = {}; // sourceId -> { ch1, ch2, stereo, peaks1, peaks2, duration, sampleRate, hasTwoTracks }

  let decodeCtx = null;
  let previewCtx = null;
  let activePreviewNodes = [];
  let activePreviewGraph = null;
  let isPlaying = false;
  let playStartTimelineSec = 0;
  let playStartCtxTime = 0;
  let playheadSec = 0;
  let previewRaf = null;

  let zoomLevel = 1;
  let laneHeightPx = 96;
  let waveScale = 1;
  let selectedClipId = null;
  const selectedClipIds = new Set();
  let selectedFxSlotId = null;
  let pendingLoadTrackId = null;
  let selectionStart = null;
  let selectionEnd = null;
  let showAutomation = false;
  let activeAutoLane = "gain";
  let snapEnabled = false;
  let clipboardClips = [];
  let historyMenuOpen = false;
  const waveformMemoryCache = new Map();
  const frozenTrackBuffers = {}; // trackId -> { audioBuf, pyramid }

  let lastRenderedMp3Url = null;
  let lastRenderedFile = null;
  let isRendering = false;
  let isDraggingSelection = false;
  let isScrubbingPlayhead = false;
  let isSlipDragging = false;
  let draggingAutoPoint = null;
  let dragAnchorSec = 0;
  let slipAccumSec = 0;

  function syncClipSelection(primaryId, additive = false) {
    if (!additive) selectedClipIds.clear();
    if (primaryId) {
      if (additive && selectedClipIds.has(primaryId) && selectedClipIds.size > 1) {
        selectedClipIds.delete(primaryId);
        selectedClipId = Array.from(selectedClipIds)[0] || null;
      } else {
        selectedClipIds.add(primaryId);
        selectedClipId = primaryId;
      }
    } else if (!additive) {
      selectedClipId = null;
    }
  }

  function $(id) {
    return document.getElementById(id);
  }

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
      canvasBg: v("--studio-canvas-bg", "#0b0d13"),
      rulerBg: v("--studio-ruler-bg", "#141824"),
      laneA: v("--studio-lane-a", "#0f131c"),
      laneB: v("--studio-lane-b", "#121622"),
      laneSelected: v("--studio-lane-selected", "#191c2e"),
      border: v("--studio-border", "#2c3244"),
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

  function getDecodeContext() {
    if (!decodeCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      decodeCtx = new Ctx({ sampleRate: 48000 });
    }
    return decodeCtx;
  }

  function formatTimecode(sec, includeTenths) {
    const s = Math.max(0, Number(sec) || 0);
    const cfg = state && state.timelineConfig ? state.timelineConfig : null;
    if (cfg && cfg.rulerMode === "bars") {
      const bpm = Math.max(30, Number(cfg.bpm) || 96);
      const bpb = Math.max(2, Number(cfg.beatsPerBar) || 4);
      const totalBeats = (s * bpm) / 60;
      const bar = Math.floor(totalBeats / bpb) + 1;
      const beat = Math.floor(totalBeats % bpb) + 1;
      const sub = Math.floor((totalBeats - Math.floor(totalBeats)) * 4) + 1;
      return includeTenths ? `${bar}.${beat}.${sub}` : `${bar}:${beat}`;
    }
    if (cfg && cfg.rulerMode === "samples") {
      const sr = Math.max(8000, Number(cfg.sampleRate) || 48000);
      return `${Math.round(s * sr).toLocaleString()} smp`;
    }
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const rem = Math.floor(s % 60);
    const tenths = Math.floor((s - Math.floor(s)) * 10);
    const base =
      h > 0
        ? `${h}:${String(m).padStart(2, "0")}:${String(rem).padStart(2, "0")}`
        : `${String(m).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
    return includeTenths ? `${base}.${tenths}` : base;
  }

  /**
   * Pure-JS RIFF/WAV fallback decoder for 16-bit PCM, 24-bit PCM, and 32-bit IEEE Float WAVs.
   */
  function decodeWavFallback(arrayBuf, ctx) {
    if (!arrayBuf || arrayBuf.byteLength < 44) return null;
    const view = new DataView(arrayBuf);
    const riff = String.fromCharCode(
      view.getUint8(0),
      view.getUint8(1),
      view.getUint8(2),
      view.getUint8(3)
    );
    const wave = String.fromCharCode(
      view.getUint8(8),
      view.getUint8(9),
      view.getUint8(10),
      view.getUint8(11)
    );
    if (riff !== "RIFF" || wave !== "WAVE") return null;

    let offset = 12;
    let audioFormat = 1;
    let numChannels = 1;
    let sampleRate = 48000;
    let bitsPerSample = 24;
    let dataOffset = -1;
    let dataSize = 0;

    while (offset + 8 <= arrayBuf.byteLength) {
      const id = String.fromCharCode(
        view.getUint8(offset),
        view.getUint8(offset + 1),
        view.getUint8(offset + 2),
        view.getUint8(offset + 3)
      );
      const chunkSize = view.getUint32(offset + 4, true);
      if (id === "fmt ") {
        audioFormat = view.getUint16(offset + 8, true);
        numChannels = view.getUint16(offset + 10, true);
        sampleRate = view.getUint32(offset + 12, true);
        bitsPerSample = view.getUint16(offset + 22, true);
      } else if (id === "data") {
        dataOffset = offset + 8;
        dataSize = Math.min(chunkSize || arrayBuf.byteLength - dataOffset, arrayBuf.byteLength - dataOffset);
        break;
      }
      offset += 8 + chunkSize + (chunkSize % 2);
    }

    if (dataOffset < 0 || dataSize <= 0) return null;
    const bytesPerSample = bitsPerSample / 8;
    const frameCount = Math.floor(dataSize / (bytesPerSample * numChannels));
    if (frameCount <= 0) return null;

    const audioBuf = ctx.createBuffer(numChannels, frameCount, sampleRate);
    let pos = dataOffset;
    const channels = Array.from({ length: numChannels }, (_, c) => audioBuf.getChannelData(c));
    for (let i = 0; i < frameCount; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        let sample = 0;
        if (audioFormat === 3 && bitsPerSample === 32) {
          sample = view.getFloat32(pos, true);
        } else if (bitsPerSample === 24) {
          const b0 = view.getUint8(pos);
          const b1 = view.getUint8(pos + 1);
          const b2 = view.getUint8(pos + 2);
          let raw = b0 | (b1 << 8) | (b2 << 16);
          if (raw & 0x800000) raw |= ~0xffffff;
          sample = raw / 8388608;
        } else if (bitsPerSample === 16) {
          sample = view.getInt16(pos, true) / 32768;
        }
        channels[ch][i] = sample;
        pos += bytesPerSample;
      }
    }
    return audioBuf;
  }

  async function decodeAudioFile(file) {
    const ctx = getDecodeContext();
    const buf = await file.arrayBuffer();
    if (buf.byteLength <= 44) {
      throw new Error(`"${file.name}" has no audio samples (${buf.byteLength} bytes).`);
    }
    try {
      const cloned = buf.slice(0);
      return await ctx.decodeAudioData(cloned);
    } catch (err) {
      const fallback = decodeWavFallback(buf, ctx);
      if (fallback) return fallback;
      throw err;
    }
  }

  function extractPeaks(floatArray, buckets = 4800) {
    const len = floatArray ? floatArray.length : 0;
    const actualBuckets = Math.min(buckets, Math.max(200, len));
    const minArr = new Float32Array(actualBuckets);
    const maxArr = new Float32Array(actualBuckets);
    if (len === 0) return { min: minArr, max: maxArr };

    const blockSize = len / actualBuckets;
    for (let b = 0; b < actualBuckets; b++) {
      const start = Math.floor(b * blockSize);
      const end = Math.min(len, Math.floor((b + 1) * blockSize));
      let minV = 1;
      let maxV = -1;
      const step = Math.max(1, Math.floor((end - start) / 64));
      for (let i = start; i < end; i += step) {
        const v = floatArray[i];
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
      }
      if (minV > maxV) {
        minV = 0;
        maxV = 0;
      }
      minArr[b] = minV;
      maxArr[b] = maxV;
    }
    return { min: minArr, max: maxArr };
  }

  function buildWaveformPyramid(floatArray) {
    const len = floatArray ? floatArray.length : 0;
    if (len === 0) {
      const empty = { min: new Float32Array(0), max: new Float32Array(0) };
      return { coarse: empty, medium: empty, fine: empty };
    }
    return {
      coarse: extractPeaks(floatArray, 1200),
      medium: extractPeaks(floatArray, 4800),
      fine: extractPeaks(floatArray, 24000)
    };
  }

  function pickPyramidTier(pyramid, fallbackPeaks, pxWidth) {
    if (!pyramid) return fallbackPeaks;
    if (zoomLevel >= 4 || pxWidth > 2200) return pyramid.fine || pyramid.medium || fallbackPeaks;
    if (zoomLevel >= 1.8 || pxWidth > 1000) return pyramid.medium || pyramid.coarse || fallbackPeaks;
    return pyramid.coarse || pyramid.medium || fallbackPeaks;
  }

  async function persistWaveformPyramid(stemKey, pyramid) {
    if (!window.LiveStudioRecorder || typeof window.LiveStudioRecorder.saveWaveformCache !== "function" || !pyramid) {
      return;
    }
    try {
      await window.LiveStudioRecorder.saveWaveformCache(stemKey, {
        coarse: { min: Array.from(pyramid.coarse.min), max: Array.from(pyramid.coarse.max) },
        medium: { min: Array.from(pyramid.medium.min), max: Array.from(pyramid.medium.max) }
      });
    } catch (_) { }
  }

  async function getOrBuildPyramid(floatArray, cacheKey) {
    if (cacheKey && waveformMemoryCache.has(cacheKey)) {
      return waveformMemoryCache.get(cacheKey);
    }
    if (cacheKey && window.LiveStudioRecorder && typeof window.LiveStudioRecorder.loadWaveformCache === "function") {
      try {
        const cached = await window.LiveStudioRecorder.loadWaveformCache(cacheKey);
        if (cached && cached.coarse && cached.medium && Array.isArray(cached.coarse.max)) {
          const pyr = {
            coarse: { min: Float32Array.from(cached.coarse.min), max: Float32Array.from(cached.coarse.max) },
            medium: { min: Float32Array.from(cached.medium.min), max: Float32Array.from(cached.medium.max) },
            fine: floatArray && floatArray.length ? extractPeaks(floatArray, 24000) : { min: Float32Array.from(cached.medium.min), max: Float32Array.from(cached.medium.max) }
          };
          waveformMemoryCache.set(cacheKey, pyr);
          return pyr;
        }
      } catch (_) { }
    }
    const pyr = buildWaveformPyramid(floatArray);
    if (cacheKey) {
      waveformMemoryCache.set(cacheKey, pyr);
      persistWaveformPyramid(cacheKey, pyr);
    }
    return pyr;
  }

  function setStatusNotice(text, isError) {
    const el = $("lsDawStatusText");
    if (!el) return;
    el.textContent = text || "";
    el.style.color = isError ? "var(--studio-danger, #dc4148)" : "var(--studio-text-secondary, #5c677a)";
  }

  function pushMarkersToStudioBridge() {
    if (!state || !window.LiveStudioBridge) return;
    window.LiveStudioBridge.setTimestamps(
      state.markers.map((m) => ({
        submission_id: m.submission_id || null,
        bhajan_title: m.bhajan_title,
        singer_name: m.singer_name || "Samiti Singer",
        deity: m.deity || "",
        start_seconds: Math.round(Number(m.start_seconds) || 0)
      }))
    );
  }

  function pullMarkersFromStudioBridge() {
    if (!state || !window.LiveStudioBridge) return;
    const current = window.LiveStudioBridge.getTimestamps();
    Engine.setMarkers(state, current);
  }

  async function loadDualStemFiles(ch1File, ch2File, label) {
    if (!state || !Engine) return;
    if (!ch1File && !ch2File) return;

    setStatusNotice("Decoding multitrack audio for waveform editor...", false);
    try {
      const [buf1, buf2] = await Promise.all([
        ch1File ? decodeAudioFile(ch1File) : Promise.resolve(null),
        ch2File ? decodeAudioFile(ch2File) : Promise.resolve(null)
      ]);

      const primary = buf1 || buf2;
      const dur = Math.max(buf1 ? buf1.duration : 0, buf2 ? buf2.duration : 0);
      const srcId = Engine.addSource(state, {
        name: label || (ch1File ? ch1File.name : ch2File.name),
        duration: dur,
        sampleRate: primary.sampleRate,
        hasTwoTracks: true
      });

      const ck1 = ch1File ? `${ch1File.name}_${ch1File.size}_${ch1File.lastModified || 0}_ch1` : `${srcId}_ch1`;
      const ck2 = ch2File ? `${ch2File.name}_${ch2File.size}_${ch2File.lastModified || 0}_ch2` : `${srcId}_ch2`;
      const [pyr1, pyr2] = await Promise.all([
        getOrBuildPyramid(buf1 ? buf1.getChannelData(0) : new Float32Array(0), ck1),
        getOrBuildPyramid(buf2 ? buf2.getChannelData(0) : new Float32Array(0), ck2)
      ]);

      sourceBuffers[srcId] = {
        hasTwoTracks: true,
        ch1: buf1,
        ch2: buf2,
        stereo: null,
        duration: dur,
        sampleRate: primary.sampleRate,
        peaks1: pyr1.medium,
        peaks2: pyr2.medium,
        pyramid1: pyr1,
        pyramid2: pyr2
      };

      const clip = Engine.appendClip(state, {
        sourceId: srcId,
        label: label || "Recorded Session",
        duration: dur
      });
      syncClipSelection(clip.id);
      playheadSec = 0;
      updateAllDawUi();
      setStatusNotice(
        `Loaded 2-track session (${formatTimecode(dur)}). Drag to select dead air, S to split, Delete to ripple-cut.`,
        false
      );
    } catch (err) {
      setStatusNotice("Could not decode WAV/audio stems: " + err.message, true);
    }
  }

  async function loadSingleAudioFile(file, appendMode, targetTrackId) {
    if (!state || !Engine || !file) return;
    setStatusNotice(`Decoding "${file.name}"...`, false);
    try {
      const audioBuf = await decodeAudioFile(file);
      if (!appendMode && !targetTrackId) {
        state.clips = [];
      }
      const srcId = Engine.addSource(state, {
        name: file.name,
        duration: audioBuf.duration,
        sampleRate: audioBuf.sampleRate,
        hasTwoTracks: false
      });

      const leftData = audioBuf.getChannelData(0);
      const rightData = audioBuf.numberOfChannels > 1 ? audioBuf.getChannelData(1) : leftData;
      const ckBase = `${file.name}_${file.size}_${file.lastModified || 0}`;
      const [pyr1, pyr2] = await Promise.all([
        getOrBuildPyramid(leftData, `${ckBase}_L`),
        getOrBuildPyramid(rightData, `${ckBase}_R`)
      ]);

      sourceBuffers[srcId] = {
        hasTwoTracks: false,
        ch1: null,
        ch2: null,
        stereo: audioBuf,
        duration: audioBuf.duration,
        sampleRate: audioBuf.sampleRate,
        peaks1: pyr1.medium,
        peaks2: pyr2.medium,
        pyramid1: pyr1,
        pyramid2: pyr2
      };

      const clip = Engine.appendClip(state, {
        sourceId: srcId,
        trackId: targetTrackId || null,
        timelineOffsetSec: targetTrackId ? 0 : null,
        label: file.name.replace(/\.[^.]+$/, ""),
        duration: audioBuf.duration,
        crossfadePrevSec: appendMode && !targetTrackId ? 0.3 : 0
      });
      syncClipSelection(clip.id);
      if (targetTrackId) Engine.selectTrack(state, targetTrackId);
      updateAllDawUi();
      setStatusNotice(
        `${targetTrackId ? "Loaded onto track" : (appendMode ? "Joined" : "Loaded")} "${file.name}" (${formatTimecode(audioBuf.duration)}).`,
        false
      );
    } catch (err) {
      setStatusNotice("Failed to decode file: " + err.message, true);
    }
  }

  function getTrackGainValue(track, anySolo) {
    if (!track) return 1;
    if (track.mute || (anySolo && !track.solo)) return 0;
    return Math.max(0, Number(track.gain ?? 100) / 100);
  }

  function syncLivePreviewTracks() {
    if (!activePreviewGraph || !state) return;
    const anySolo = state.tracks.some((t) => Boolean(t.solo));
    if (activePreviewGraph.masterInTrim && state.masterTrack) {
      const mTrim = Math.pow(10, (Number(state.masterTrack.inputTrimDb) || 0) / 20);
      activePreviewGraph.masterInTrim.gain.setTargetAtTime(mTrim, activePreviewGraph.ctx.currentTime, 0.015);
    }
    state.tracks.forEach((tr) => {
      const bus = activePreviewGraph.trackBuses.get(tr.id);
      if (!bus) return;
      const g = getTrackGainValue(tr, anySolo);
      const pan = Math.max(-1, Math.min(1, Number(tr.pan || 0) / 100));
      bus.gainNode.gain.setTargetAtTime(g, activePreviewGraph.ctx.currentTime, 0.015);
      if (bus.pannerNode && bus.pannerNode.pan) {
        bus.pannerNode.pan.setTargetAtTime(pan, activePreviewGraph.ctx.currentTime, 0.015);
      }
    });
  }

  function stopPreviewPlayback() {
    isPlaying = false;
    window.cancelAnimationFrame(previewRaf);
    activePreviewNodes.forEach((n) => {
      try {
        n.stop();
        n.disconnect();
      } catch (_) { }
    });
    activePreviewNodes = [];
    activePreviewGraph = null;
    const playBtn = $("lsDawPlayBtn");
    if (playBtn) {
      const lbl = playBtn.querySelector(".ls-play-label");
      if (lbl) lbl.textContent = "Play";
      else playBtn.textContent = "Play";
      playBtn.classList.remove("is-toggled");
    }
    drawCanvas();
  }

  /**
   * Pre-render a single track offline (its clips + clipGain automation + full JS FX rack including gate & Linear-Phase FIR).
   */
  async function renderSingleTrackBufferOffline(track, totalDuration, sampleRate = 48000) {
    const dur = Math.max(0.25, Number(totalDuration) || 0.25);
    const totalFrames = Math.ceil(dur * sampleRate);
    const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const offline = new OfflineCtx(2, totalFrames, sampleRate);
    const trackIn = offline.createGain();
    trackIn.connect(offline.destination);

    const layout = Engine.computeTimelineLayout(state.clips);
    const clipAutoPts = (track.automation && track.automation.clipGain) || [];
    for (let i = 0; i < layout.items.length; i += 1) {
      const it = layout.items[i];
      const c = it.clip;
      const srcBufObj = sourceBuffers[c.sourceId];
      if (!srcBufObj) continue;

      let buf = null;
      if (c.trackId) {
        if (c.trackId !== track.id) continue;
        buf = srcBufObj.stereo || srcBufObj.ch1 || srcBufObj.ch2;
      } else if (srcBufObj.hasTwoTracks) {
        if (track.role === "ch1") buf = srcBufObj.ch1;
        else if (track.role === "ch2") buf = srcBufObj.ch2;
      } else if (track.role === "ch1" || state.tracks[0]?.id === track.id) {
        buf = srcBufObj.stereo;
      }
      if (!buf) continue;

      const s = offline.createBufferSource();
      s.buffer = buf;
      const clipGainLin = Math.pow(10, (Number(c.gainDb) || 0) / 20);
      const envGain = offline.createGain();
      const prevIt = i > 0 && !c.trackId ? layout.items[i - 1] : null;
      const nextIt = i + 1 < layout.items.length && !c.trackId ? layout.items[i + 1] : null;
      const fi = Math.max(Number(c.fadeInSec) || 0, it.effectiveCrossfade || 0);
      const fo = Math.max(Number(c.fadeOutSec) || 0, nextIt && nextIt.effectiveCrossfade ? nextIt.effectiveCrossfade : 0);
      void prevIt;

      if (fi > 0.01) {
        envGain.gain.setValueAtTime(0.0001, it.timelineStart);
        envGain.gain.linearRampToValueAtTime(clipGainLin, it.timelineStart + fi);
      } else {
        envGain.gain.setValueAtTime(clipGainLin, it.timelineStart);
      }
      if (fo > 0.01) {
        const foStart = Math.max(it.timelineStart + fi, it.timelineEnd - fo);
        envGain.gain.setValueAtTime(clipGainLin, foStart);
        envGain.gain.linearRampToValueAtTime(0.0001, it.timelineEnd);
      }

      if (clipAutoPts.length > 0 && typeof Engine.evaluateAutomation === "function") {
        const autoGainNode = offline.createGain();
        const cnt = 128;
        const curve = new Float32Array(cnt);
        for (let k = 0; k < cnt; k += 1) {
          const t = it.timelineStart + (k / (cnt - 1)) * it.duration;
          curve[k] = Math.pow(10, Engine.evaluateAutomation(clipAutoPts, t, 0) / 20);
        }
        try {
          autoGainNode.gain.setValueCurveAtTime(curve, it.timelineStart, Math.max(0.05, it.duration));
        } catch (_) {
          autoGainNode.gain.setValueAtTime(curve[0], it.timelineStart);
        }
        s.connect(envGain).connect(autoGainNode).connect(trackIn);
      } else {
        s.connect(envGain).connect(trackIn);
      }
      s.start(it.timelineStart, c.sourceStart, it.duration);
    }

    const dryBuf = await offline.startRendering();
    const rawL = new Float32Array(dryBuf.getChannelData(0));
    const rawR = dryBuf.numberOfChannels > 1 ? new Float32Array(dryBuf.getChannelData(1)) : new Float32Array(rawL);

    let outL = rawL;
    let outR = rawR;
    if (Dsp && typeof Dsp.processFxRackOffline === "function" && Array.isArray(track.fxRack) && track.fxRack.length > 0) {
      const fxRes = Dsp.processFxRackOffline(rawL, rawR, track.fxRack, sampleRate);
      outL = fxRes.left;
      outR = fxRes.right || fxRes.left;
    }

    const fxMixPts = (track.automation && track.automation.fxWetDry) || [];
    if (fxMixPts.length > 0 && typeof Engine.evaluateAutomation === "function") {
      for (let i = 0; i < outL.length; i += 1) {
        const wet = Math.max(0, Math.min(1, Engine.evaluateAutomation(fxMixPts, i / sampleRate, 100) / 100));
        outL[i] = rawL[i] * (1 - wet) + outL[i] * wet;
        outR[i] = rawR[i] * (1 - wet) + outR[i] * wet;
      }
    }

    const ctx = getDecodeContext();
    const finalBuf = ctx.createBuffer(2, outL.length, sampleRate);
    finalBuf.getChannelData(0).set(outL);
    finalBuf.getChannelData(1).set(outR);
    return { audioBuf: finalBuf, left: outL, right: outR };
  }

  async function freezeOrUnfreezeTrack(track) {
    if (!track || !state || !Engine) return;
    if (track.frozen) {
      delete frozenTrackBuffers[track.id];
      Engine.updateTrackProps(state, track.id, { frozen: false });
      updateAllDawUi();
      if (isPlaying) startPreviewPlayback();
      setStatusNotice(`Unfroze "${track.name}" — live FX rack re-enabled.`, false);
      return;
    }
    const layout = Engine.computeTimelineLayout(state.clips);
    if (layout.totalDuration <= 0.1) {
      setStatusNotice("Load audio before freezing a track.", true);
      return;
    }
    setStatusNotice(`Freezing "${track.name}" offline...`, false);
    try {
      const res = await renderSingleTrackBufferOffline(track, layout.totalDuration + 1.5, 48000);
      frozenTrackBuffers[track.id] = { audioBuf: res.audioBuf, pyramid: buildWaveformPyramid(res.left) };
      Engine.updateTrackProps(state, track.id, { frozen: true });
      updateAllDawUi();
      if (isPlaying) startPreviewPlayback();
      setStatusNotice(`Froze "${track.name}" (${(track.fxRack || []).length} FX rendered to RAM stem).`, false);
    } catch (err) {
      setStatusNotice("Freeze failed: " + err.message, true);
    }
  }

  async function bounceTrackToNewStem(track) {
    if (!track || !state || !Engine) return;
    const layout = Engine.computeTimelineLayout(state.clips);
    if (layout.totalDuration <= 0.1) {
      setStatusNotice("Load audio before bouncing a track.", true);
      return;
    }
    setStatusNotice(`Bouncing "${track.name}" to new stem track...`, false);
    try {
      const res = await renderSingleTrackBufferOffline(track, layout.totalDuration + 1.5, 48000);
      const srcId = Engine.addSource(state, {
        name: `${track.name} (Bounce)`,
        duration: res.audioBuf.duration,
        sampleRate: 48000,
        hasTwoTracks: false
      });
      const pyrL = buildWaveformPyramid(res.left);
      const pyrR = buildWaveformPyramid(res.right);
      sourceBuffers[srcId] = {
        hasTwoTracks: false,
        ch1: null,
        ch2: null,
        stereo: res.audioBuf,
        duration: res.audioBuf.duration,
        sampleRate: 48000,
        peaks1: pyrL.medium,
        peaks2: pyrR.medium,
        pyramid1: pyrL,
        pyramid2: pyrR
      };
      const newTrack = Engine.addTrack(state, { name: `${track.name} Bounce` });
      const clip = Engine.appendClip(state, {
        sourceId: srcId,
        trackId: newTrack.id,
        timelineOffsetSec: 0,
        label: `${track.name} Stem`,
        duration: res.audioBuf.duration
      });
      syncClipSelection(clip.id);
      updateAllDawUi();
      setStatusNotice(`Bounced "${track.name}" onto "${newTrack.name}".`, false);
    } catch (err) {
      setStatusNotice("Bounce failed: " + err.message, true);
    }
  }

  /**
   * Build the complete multi-track Web Audio routing graph with per-track Gain, Pan,
   * custom modular FX chains, insert latency compensation, optional Live Studio FX bus, and Master Bus FX rack.
   * Works seamlessly in both AudioContext (live preview) and OfflineAudioContext (MP3/WAV render).
   */
  function buildDawAudioGraph(ctx, overridePreRenderedTracks = null) {
    const anySolo = state.tracks.some((t) => Boolean(t.solo));
    const useStudioFx = Boolean(
      $("lsDawApplyFxCheck")?.checked &&
      Dsp &&
      window.LiveStudioBridge &&
      typeof window.LiveStudioBridge.getActiveFxConfig === "function"
    );

    const masterChain = Dsp
      ? Dsp.buildModularFxChain(ctx, state.masterTrack ? state.masterTrack.fxRack : [])
      : null;

    const studioDsp = useStudioFx
      ? Dsp.buildChannelAndMasterDsp(ctx, window.LiveStudioBridge.getActiveFxConfig())
      : null;

    const masterInTrim = ctx.createGain();
    masterInTrim.gain.value = Math.pow(10, (Number(state.masterTrack?.inputTrimDb) || 0) / 20);

    const masterOut = ctx.createGain();
    masterOut.gain.value = Math.max(0, Number(state.masterTrack?.gain ?? 100) / 100);

    if (studioDsp && masterChain) {
      studioDsp.output.connect(masterInTrim);
      masterInTrim.connect(masterChain.input);
      masterChain.output.connect(masterOut).connect(ctx.destination);
    } else if (studioDsp) {
      studioDsp.output.connect(masterInTrim).connect(masterOut).connect(ctx.destination);
    } else if (masterChain) {
      masterInTrim.connect(masterChain.input);
      masterChain.output.connect(masterOut).connect(ctx.destination);
    } else {
      masterInTrim.connect(masterOut).connect(ctx.destination);
    }

    const trackLatencies = new Map();
    let maxLatencySamples = 0;
    state.tracks.forEach((tr) => {
      const preRendered = Boolean(
        (tr.frozen && frozenTrackBuffers[tr.id]) ||
        (overridePreRenderedTracks && overridePreRenderedTracks[tr.id])
      );
      const lat = !preRendered && Dsp && typeof Dsp.getFxRackLatencySamples === "function"
        ? Dsp.getFxRackLatencySamples(tr.fxRack || [], ctx.sampleRate || 48000)
        : 0;
      trackLatencies.set(tr.id, { preRendered, lat });
      if (lat > maxLatencySamples) maxLatencySamples = lat;
    });

    const trackBuses = new Map();
    const roleTrackMap = {};

    state.tracks.forEach((tr) => {
      const meta = trackLatencies.get(tr.id) || { preRendered: false, lat: 0 };
      const inNode = ctx.createGain();
      const gainNode = ctx.createGain();
      gainNode.gain.value = getTrackGainValue(tr, anySolo);

      const pannerNode = typeof ctx.createStereoPanner === "function" ? ctx.createStereoPanner() : null;
      if (pannerNode) {
        pannerNode.pan.value = Math.max(-1, Math.min(1, Number(tr.pan || 0) / 100));
      }

      const fxChain = !meta.preRendered && Dsp ? Dsp.buildModularFxChain(ctx, tr.fxRack || []) : null;

      let destTarget;
      if (studioDsp) {
        if (tr.role === "ch1") destTarget = studioDsp.vocalIn;
        else if (tr.role === "ch2") destTarget = studioDsp.instIn;
        else destTarget = studioDsp.stereoIn;
      } else if (masterChain || masterInTrim) {
        destTarget = masterInTrim;
      } else {
        destTarget = masterOut;
      }

      let latencyCompNode = null;
      if (maxLatencySamples > meta.lat && typeof ctx.createDelay === "function") {
        latencyCompNode = ctx.createDelay(1.0);
        latencyCompNode.delayTime.value = (maxLatencySamples - meta.lat) / (ctx.sampleRate || 48000);
      }

      let cursor = inNode.connect(gainNode);
      if (pannerNode) cursor = cursor.connect(pannerNode);
      if (fxChain) {
        cursor.connect(fxChain.input);
        cursor = fxChain.output;
      }
      if (latencyCompNode) {
        cursor.connect(latencyCompNode).connect(destTarget);
      } else {
        cursor.connect(destTarget);
      }

      const bus = { id: tr.id, inNode, gainNode, pannerNode, fxChain, preRendered: meta.preRendered };
      trackBuses.set(tr.id, bus);
      if (tr.role && !roleTrackMap[tr.role]) {
        roleTrackMap[tr.role] = bus;
      }
    });

    const firstBus = trackBuses.values().next().value;
    return {
      ctx,
      trackBuses,
      ch1Bus: roleTrackMap.ch1 || firstBus,
      ch2Bus: roleTrackMap.ch2 || firstBus,
      masterChain,
      studioDsp,
      masterInTrim,
      masterOut
    };
  }

  function scheduleTrackAutomation(ctx, graph, startTimelineSec, endTimelineSec, ctxStartTime) {
    if (!Engine || !state || typeof Engine.evaluateAutomation !== "function") return;
    const anySolo = state.tracks.some((t) => Boolean(t.solo));
    const span = Math.max(0.05, endTimelineSec - startTimelineSec);
    const sampleCount = Math.min(4096, Math.max(256, Math.ceil(span * 100)));

    function buildCurve(points, fallbackVal, transformFn) {
      const out = new Float32Array(sampleCount);
      for (let i = 0; i < sampleCount; i++) {
        const t = startTimelineSec + (i / (sampleCount - 1)) * span;
        const raw = Engine.evaluateAutomation(points, t, fallbackVal);
        out[i] = transformFn ? transformFn(raw) : raw;
      }
      return out;
    }

    function applyParamCurve(param, curve) {
      if (!param) return;
      try {
        param.setValueCurveAtTime(curve, ctxStartTime, span);
      } catch (_) {
        param.setValueAtTime(curve[0], ctxStartTime);
      }
    }

    state.tracks.forEach((tr) => {
      const bus = graph.trackBuses.get(tr.id);
      if (!bus || !tr.automation) return;
      const gainPts = tr.automation.gain || [];
      if (gainPts.length > 0 && bus.gainNode && bus.gainNode.gain) {
        const baseScale = tr.mute || (anySolo && !tr.solo) ? 0 : 1;
        applyParamCurve(bus.gainNode.gain, buildCurve(gainPts, tr.gain ?? 100, (v) => Math.max(0, (v / 100) * baseScale)));
      }
      const panPts = tr.automation.pan || [];
      if (panPts.length > 0 && bus.pannerNode && bus.pannerNode.pan) {
        applyParamCurve(bus.pannerNode.pan, buildCurve(panPts, tr.pan ?? 0, (v) => Math.max(-1, Math.min(1, v / 100))));
      }
      if (!bus.fxChain || !bus.fxChain.slots) return;
      const slotList = tr.fxRack || [];

      const eqPts = tr.automation.eqPresenceDb || [];
      if (eqPts.length > 0) {
        const eqSlot = slotList.find((s) => s.enabled !== false && s.type === "eq");
        const h = eqSlot && bus.fxChain.slots.get(eqSlot.id);
        if (h && h.automationTargets && h.automationTargets.eqPresenceGain) {
          applyParamCurve(h.automationTargets.eqPresenceGain, buildCurve(eqPts, eqSlot.params?.b3k5 ?? 0, (v) => Math.max(-18, Math.min(18, v))));
        }
      }

      const compPts = tr.automation.compThreshold || [];
      if (compPts.length > 0) {
        const compSlot = slotList.find((s) => s.enabled !== false && s.type === "compressor");
        const h = compSlot && bus.fxChain.slots.get(compSlot.id);
        if (h && h.automationTargets && h.automationTargets.compThreshold) {
          applyParamCurve(h.automationTargets.compThreshold, buildCurve(compPts, compSlot.params?.threshold ?? -18, (v) => Math.max(-60, Math.min(0, v))));
        }
      }

      const revPts = tr.automation.reverbSend || [];
      if (revPts.length > 0) {
        const revSlot = slotList.find((s) => s.enabled !== false && s.type === "reverb");
        const h = revSlot && bus.fxChain.slots.get(revSlot.id);
        if (h && h.automationTargets && h.automationTargets.reverbReturnGain) {
          applyParamCurve(h.automationTargets.reverbReturnGain, buildCurve(revPts, revSlot.params?.wet ?? 16, (v) => (Math.max(0, Math.min(100, v)) / 100) * 0.85));
        }
      }

      const wetPts = tr.automation.fxWetDry || [];
      if (wetPts.length > 0) {
        slotList.forEach((slot) => {
          if (!slot || slot.enabled === false) return;
          const h = bus.fxChain.slots.get(slot.id);
          if (h && h.automationTargets) {
            applyParamCurve(h.automationTargets.wetActiveGain, buildCurve(wetPts, slot.wetDry ?? 100, (v) => Math.max(0, Math.min(1, v / 100))));
            applyParamCurve(h.automationTargets.dryBypassGain, buildCurve(wetPts, slot.wetDry ?? 100, (v) => 1 - Math.max(0, Math.min(1, v / 100))));
          }
        });
      }
    });
  }

  function schedulePreRenderedTrackBuffer(ctx, bus, audioBuf, startAtTimelineSec, ctxStartTime) {
    if (!ctx || !bus || !audioBuf) return [];
    if (audioBuf.duration <= startAtTimelineSec + 0.01) return [];
    const s = ctx.createBufferSource();
    s.buffer = audioBuf;
    s.connect(bus.inNode);
    s.start(ctxStartTime, Math.max(0, startAtTimelineSec), audioBuf.duration - Math.max(0, startAtTimelineSec));
    return [s];
  }

  function scheduleClipIntoContext(ctx, graph, item, prevItem, nextItem, startAtTimelineSec, ctxStartTime) {
    const c = item.clip;
    const srcBufObj = sourceBuffers[c.sourceId];
    if (!srcBufObj) return [];

    const created = [];
    const clipStart = item.timelineStart;
    const clipEnd = item.timelineEnd;
    if (clipEnd <= startAtTimelineSec) return created;

    const overlapStart = Math.max(clipStart, startAtTimelineSec);
    const when = ctxStartTime + (overlapStart - startAtTimelineSec);
    const clipSkipOffset = overlapStart - clipStart;
    const srcOffset = c.sourceStart + clipSkipOffset;
    const playDur = clipEnd - overlapStart;
    if (playDur <= 0.01) return created;

    const clipLinearGain = Math.pow(10, (Number(c.gainDb) || 0) / 20);
    const fadeIn = Math.max(Number(c.fadeInSec) || 0, item.effectiveCrossfade || 0);
    const fadeOut = Math.max(
      Number(c.fadeOutSec) || 0,
      nextItem && nextItem.effectiveCrossfade ? nextItem.effectiveCrossfade : 0
    );

    const absClipStart = ctxStartTime + (clipStart - startAtTimelineSec);
    const absClipEnd = ctxStartTime + (clipEnd - startAtTimelineSec);

    function createEnvelopeGain(targetNode) {
      const gainNode = ctx.createGain();
      if (fadeIn > 0.01) {
        gainNode.gain.setValueAtTime(0.0001, Math.max(ctxStartTime, absClipStart));
        gainNode.gain.linearRampToValueAtTime(clipLinearGain, absClipStart + fadeIn);
      } else {
        gainNode.gain.setValueAtTime(clipLinearGain, Math.max(ctxStartTime, when));
      }

      if (fadeOut > 0.01) {
        const fadeOutStart = Math.max(absClipStart + fadeIn, absClipEnd - fadeOut);
        gainNode.gain.setValueAtTime(clipLinearGain, Math.max(ctxStartTime, fadeOutStart));
        gainNode.gain.linearRampToValueAtTime(0.0001, absClipEnd);
      }

      const trackForAuto = c.trackId ? Engine.getTrackById(state, c.trackId) : state.tracks[0];
      const clipAutoPts = trackForAuto && trackForAuto.automation && trackForAuto.automation.clipGain;
      if (Array.isArray(clipAutoPts) && clipAutoPts.length > 0 && typeof Engine.evaluateAutomation === "function") {
        const autoNode = ctx.createGain();
        const cnt = 128;
        const curve = new Float32Array(cnt);
        for (let i = 0; i < cnt; i += 1) {
          const t = overlapStart + (i / (cnt - 1)) * playDur;
          curve[i] = Math.pow(10, Engine.evaluateAutomation(clipAutoPts, t, 0) / 20);
        }
        try {
          autoNode.gain.setValueCurveAtTime(curve, when, Math.max(0.05, playDur));
        } catch (_) {
          autoNode.gain.setValueAtTime(curve[0], when);
        }
        gainNode.connect(autoNode).connect(targetNode);
      } else {
        gainNode.connect(targetNode);
      }
      return gainNode;
    }

    if (c.trackId) {
      const targetBus = graph.trackBuses.get(c.trackId) || graph.ch1Bus;
      if (!targetBus || targetBus.preRendered) return created;
      const buf = srcBufObj.stereo || srcBufObj.ch1 || srcBufObj.ch2;
      if (!buf) return created;
      const s = ctx.createBufferSource();
      s.buffer = buf;
      const env = createEnvelopeGain(targetBus.inNode);
      s.connect(env);
      s.start(when, srcOffset, playDur);
      created.push(s);
      return created;
    }

    if (srcBufObj.hasTwoTracks) {
      if (srcBufObj.ch1 && graph.ch1Bus && !graph.ch1Bus.preRendered) {
        const s1 = ctx.createBufferSource();
        s1.buffer = srcBufObj.ch1;
        const merger1 = ctx.createChannelMerger(2);
        const env1 = createEnvelopeGain(graph.ch1Bus.inNode);
        s1.connect(merger1, 0, 0);
        s1.connect(merger1, 0, 1);
        merger1.connect(env1);
        s1.start(when, srcOffset, playDur);
        created.push(s1);
      }
      if (srcBufObj.ch2 && graph.ch2Bus && !graph.ch2Bus.preRendered) {
        const s2 = ctx.createBufferSource();
        s2.buffer = srcBufObj.ch2;
        const merger2 = ctx.createChannelMerger(2);
        const env2 = createEnvelopeGain(graph.ch2Bus.inNode);
        s2.connect(merger2, 0, 0);
        s2.connect(merger2, 0, 1);
        merger2.connect(env2);
        s2.start(when, srcOffset, playDur);
        created.push(s2);
      }
    } else if (srcBufObj.stereo && graph.ch1Bus && !graph.ch1Bus.preRendered) {
      const s = ctx.createBufferSource();
      s.buffer = srcBufObj.stereo;
      const env = createEnvelopeGain(graph.ch1Bus.inNode);
      s.connect(env);
      s.start(when, srcOffset, playDur);
      created.push(s);
    }

    return created;
  }

  async function startPreviewPlayback() {
    if (!state || state.clips.length === 0) return;
    stopPreviewPlayback();

    const layout = Engine.computeTimelineLayout(state.clips);
    if (layout.totalDuration <= 0.05) return;
    const loopReg = state.loopRegion || {};
    const loopActive = Boolean(loopReg.enabled && loopReg.endSec > loopReg.startSec + 0.1);
    if (loopActive && (playheadSec < loopReg.startSec || playheadSec >= loopReg.endSec - 0.05)) {
      playheadSec = loopReg.startSec;
    } else if (playheadSec >= layout.totalDuration - 0.05) {
      playheadSec = 0;
    }

    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!previewCtx) {
      previewCtx = new Ctx({ sampleRate: 48000 });
    }
    if (previewCtx.state === "suspended") {
      await previewCtx.resume();
    }

    const graph = buildDawAudioGraph(previewCtx);
    activePreviewGraph = graph;

    playStartTimelineSec = playheadSec;
    playStartCtxTime = previewCtx.currentTime + 0.04;

    scheduleTrackAutomation(previewCtx, graph, playStartTimelineSec, layout.totalDuration, playStartCtxTime);

    state.tracks.forEach((tr) => {
      if (tr.frozen && frozenTrackBuffers[tr.id] && frozenTrackBuffers[tr.id].audioBuf) {
        const bus = graph.trackBuses.get(tr.id);
        activePreviewNodes.push(...schedulePreRenderedTrackBuffer(previewCtx, bus, frozenTrackBuffers[tr.id].audioBuf, playStartTimelineSec, playStartCtxTime));
      }
    });

    for (let i = 0; i < layout.items.length; i++) {
      const item = layout.items[i];
      const prevItem = i > 0 && !item.clip.trackId ? layout.items[i - 1] : null;
      const nextItem = i + 1 < layout.items.length && !item.clip.trackId ? layout.items[i + 1] : null;
      const nodesCreated = scheduleClipIntoContext(
        previewCtx,
        graph,
        item,
        prevItem,
        nextItem,
        playStartTimelineSec,
        playStartCtxTime
      );
      activePreviewNodes.push(...nodesCreated);
    }

    isPlaying = true;
    const playBtn = $("lsDawPlayBtn");
    if (playBtn) {
      const lbl = playBtn.querySelector(".ls-play-label");
      if (lbl) lbl.textContent = "Pause";
      else playBtn.textContent = "Pause";
      playBtn.classList.add("is-toggled");
    }

    const tick = () => {
      if (!isPlaying || !previewCtx) return;
      const elapsed = Math.max(0, previewCtx.currentTime - playStartCtxTime);
      playheadSec = Math.min(layout.totalDuration, playStartTimelineSec + elapsed);
      updateTransportReadout(layout.totalDuration);
      drawCanvas();
      const wrap = $("lsDawCanvasWrap");
      if (wrap && zoomLevel > 1) {
        const pxPlay = (playheadSec / Math.max(10, layout.totalDuration)) * wrap.scrollWidth;
        if (pxPlay > wrap.scrollLeft + wrap.clientWidth * 0.85 || pxPlay < wrap.scrollLeft) {
          wrap.scrollLeft = Math.max(0, pxPlay - wrap.clientWidth * 0.25);
        }
      }
      if (loopActive && playheadSec >= Math.min(layout.totalDuration, loopReg.endSec)) {
        playheadSec = loopReg.startSec;
        startPreviewPlayback();
        return;
      }
      if (activePreviewGraph) {
        const track = Engine.getTrackById(state, state.selectedTrackId);
        const chain = state.selectedTrackId === "master"
          ? activePreviewGraph.masterChain
          : (activePreviewGraph.trackBuses.get(state.selectedTrackId) || {}).fxChain;
        const slot = track && (track.fxRack || []).find((s) => s.id === selectedFxSlotId);
        const h = slot && chain && chain.slots ? chain.slots.get(slot.id) : null;
        if (h && typeof h.getReductionDb === "function") {
          const gr = Math.min(0, h.getReductionDb() || 0);
          const barEl = $("lsDawCompGrBar") || $("lsDawLimiterGrBar");
          const valEl = $("lsDawCompGrVal") || $("lsDawLimiterGrVal");
          if (barEl) barEl.style.width = `${Math.max(0, Math.min(100, (Math.abs(gr) / 18) * 100)).toFixed(1)}%`;
          if (valEl) valEl.textContent = `${gr.toFixed(1)} dB`;
        }
      }
      if (playheadSec >= layout.totalDuration) {
        stopPreviewPlayback();
        return;
      }
      previewRaf = window.requestAnimationFrame(tick);
    };
    previewRaf = window.requestAnimationFrame(tick);
  }

  function updateTransportReadout(totalDur) {
    const el = $("lsDawTimecode");
    if (el) {
      el.textContent = `${formatTimecode(playheadSec, true)} / ${formatTimecode(totalDur || 0, false)}`;
    }
  }

  /* ================= Dynamic Track Headers UI ================= */

  function resolveProTrackColor(tr, idx) {
    const pal = getStudioPalette();
    if (!tr || !tr.color || tr.color === "#d97706") return pal.accent;
    if (tr.color === "#2563eb") return pal.accentSecondary;
    if (idx === 0 && tr.role === "ch1") return pal.accent;
    if (idx === 1 && tr.role === "ch2") return pal.accentSecondary;
    return tr.color;
  }

  function renderTrackHeaders() {
    const container = $("lsDawTrackHeaders");
    if (!container || !state) return;
    container.innerHTML = "";

    const corner = document.createElement("div");
    corner.className = "ls-daw-tracks-corner";
    corner.innerHTML = `<span>TRACKS · MIX</span><span>${state.tracks.length} TRK</span>`;
    container.appendChild(corner);

    state.tracks.forEach((tr, idx) => {
      const proColor = resolveProTrackColor(tr, idx);
      const box = document.createElement("div");
      box.className = `ls-daw-track-box${state.selectedTrackId === tr.id ? " is-selected" : ""}${tr.frozen ? " is-frozen" : ""}`;
      box.style.height = `${laneHeightPx}px`;
      box.style.borderLeftColor = proColor;
      box.onclick = (ev) => {
        if (ev.target.closest("button") || ev.target.closest("input")) return;
        Engine.selectTrack(state, tr.id);
        selectedFxSlotId = null;
        renderTrackHeaders();
        renderFxRack();
        drawCanvas();
      };

      const top = document.createElement("div");
      top.className = "ls-daw-track-top";

      const titleEl = document.createElement("div");
      titleEl.className = "ls-daw-track-title";
      titleEl.textContent = tr.name;
      titleEl.title = "Double-click to rename track";
      titleEl.ondblclick = (ev) => {
        ev.stopPropagation();
        const nextName = window.prompt("Rename Track:", tr.name);
        if (nextName && nextName.trim()) {
          Engine.renameTrack(state, tr.id, nextName.trim());
          updateAllDawUi();
        }
      };

      const fxBadge = document.createElement("span");
      fxBadge.className = "ls-daw-fx-pill";
      const activeCount = (tr.fxRack || []).filter((f) => f.enabled !== false).length;
      fxBadge.textContent = activeCount > 0 ? `FX ${activeCount}` : "FX";
      fxBadge.title = "Open FX Rack for this track";
      fxBadge.onclick = (ev) => {
        ev.stopPropagation();
        Engine.selectTrack(state, tr.id);
        renderTrackHeaders();
        renderFxRack();
        $("lsDawFxRackPanel")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      };

      top.appendChild(titleEl);
      top.appendChild(fxBadge);
      box.appendChild(top);

      const sliders = document.createElement("div");
      sliders.className = "ls-daw-track-sliders";

      const gainValEl = document.createElement("span");
      gainValEl.className = "ls-daw-track-val";
      gainValEl.textContent = `${tr.gain ?? 100}%`;

      const gainInput = document.createElement("input");
      gainInput.type = "range";
      gainInput.className = "ls-range";
      if (idx === 0) gainInput.id = "lsDawTrack1Gain";
      else if (idx === 1) gainInput.id = "lsDawTrack2Gain";
      gainInput.min = "0";
      gainInput.max = "180";
      gainInput.value = String(tr.gain ?? 100);
      gainInput.title = `${tr.name} Volume (${tr.gain ?? 100}%)`;
      gainInput.dataset.trackGainId = tr.id;
      gainInput.oninput = function () {
        Engine.updateTrackProps(state, tr.id, { gain: Number(this.value) });
        this.title = `${tr.name} Volume (${tr.gain}%)`;
        gainValEl.textContent = `${tr.gain}%`;
        if (tr.groupId) {
          state.tracks.forEach((peer) => {
            if (peer.id !== tr.id && peer.groupId === tr.groupId) {
              const pInp = container.querySelector(`input[data-track-gain-id="${peer.id}"]`);
              if (pInp) {
                pInp.value = String(peer.gain ?? 100);
                if (pInp.nextSibling) pInp.nextSibling.textContent = `${peer.gain ?? 100}%`;
              }
            }
          });
        }
        syncLivePreviewTracks();
      };

      const fmtPan = (p) => (p === 0 ? "C" : p > 0 ? `${p}R` : `${Math.abs(p)}L`);
      const panValEl = document.createElement("span");
      panValEl.className = "ls-daw-track-val";
      panValEl.textContent = fmtPan(Number(tr.pan || 0));

      const panInput = document.createElement("input");
      panInput.type = "range";
      panInput.className = "ls-range";
      panInput.min = "-100";
      panInput.max = "100";
      panInput.value = String(tr.pan ?? 0);
      panInput.title = `Pan: ${tr.pan === 0 ? "Center" : tr.pan > 0 ? `${tr.pan}% R` : `${Math.abs(tr.pan)}% L`}`;
      panInput.dataset.trackPanId = tr.id;
      panInput.oninput = function () {
        Engine.updateTrackProps(state, tr.id, { pan: Number(this.value) });
        this.title = `Pan: ${tr.pan === 0 ? "Center" : tr.pan > 0 ? `${tr.pan}% R` : `${Math.abs(tr.pan)}% L`}`;
        panValEl.textContent = fmtPan(tr.pan);
        if (tr.groupId) {
          state.tracks.forEach((peer) => {
            if (peer.id !== tr.id && peer.groupId === tr.groupId) {
              const pInp = container.querySelector(`input[data-track-pan-id="${peer.id}"]`);
              if (pInp) {
                pInp.value = String(peer.pan ?? 0);
                if (pInp.nextSibling) pInp.nextSibling.textContent = fmtPan(peer.pan ?? 0);
              }
            }
          });
        }
        syncLivePreviewTracks();
      };

      sliders.appendChild(gainInput);
      sliders.appendChild(gainValEl);
      sliders.appendChild(panInput);
      sliders.appendChild(panValEl);
      box.appendChild(sliders);

      const ctrls = document.createElement("div");
      ctrls.className = "ls-daw-track-controls";

      const leftBtns = document.createElement("div");
      leftBtns.className = "ls-btn-row";
      leftBtns.style.gap = "4px";

      const muteBtn = document.createElement("button");
      muteBtn.type = "button";
      muteBtn.className = `ls-btn-mini${tr.mute ? " is-muted-active" : ""}`;
      if (idx === 0) muteBtn.id = "lsDawTrack1Mute";
      else if (idx === 1) muteBtn.id = "lsDawTrack2Mute";
      muteBtn.textContent = "M";
      muteBtn.title = "Mute Track";
      muteBtn.onclick = (ev) => {
        ev.stopPropagation();
        Engine.updateTrackProps(state, tr.id, { mute: !tr.mute });
        if (tr.groupId) renderTrackHeaders();
        else muteBtn.classList.toggle("is-muted-active", tr.mute);
        syncLivePreviewTracks();
      };

      const soloBtn = document.createElement("button");
      soloBtn.type = "button";
      soloBtn.className = `ls-btn-mini${tr.solo ? " is-solo-active" : ""}`;
      if (idx === 0) soloBtn.id = "lsDawTrack1Solo";
      else if (idx === 1) soloBtn.id = "lsDawTrack2Solo";
      soloBtn.textContent = "S";
      soloBtn.title = "Solo Track";
      soloBtn.onclick = (ev) => {
        ev.stopPropagation();
        Engine.updateTrackProps(state, tr.id, { solo: !tr.solo });
        if (tr.groupId) renderTrackHeaders();
        else soloBtn.classList.toggle("is-solo-active", tr.solo);
        syncLivePreviewTracks();
      };

      const frzBtn = document.createElement("button");
      frzBtn.type = "button";
      frzBtn.className = `ls-btn-mini ls-daw-freeze-btn${tr.frozen ? " is-toggled" : ""}`;
      frzBtn.textContent = "Frz";
      frzBtn.title = tr.frozen ? "Unfreeze track (restore live FX editing)" : "Freeze track FX to RAM buffer";
      frzBtn.onclick = (ev) => {
        ev.stopPropagation();
        freezeOrUnfreezeTrack(tr);
      };

      const bncBtn = document.createElement("button");
      bncBtn.type = "button";
      bncBtn.className = "ls-btn-mini";
      bncBtn.textContent = "Bnc";
      bncBtn.title = "Bounce track + FX to a new stem track";
      bncBtn.onclick = (ev) => {
        ev.stopPropagation();
        bounceTrackToNewStem(tr);
      };

      const grpBtn = document.createElement("button");
      grpBtn.type = "button";
      grpBtn.className = `ls-btn-mini ls-daw-group-pill${tr.groupId ? " is-toggled" : ""}`;
      grpBtn.textContent = tr.groupId || "Grp";
      grpBtn.title = "Cycle Track Link Group (None / A / B)";
      grpBtn.onclick = (ev) => {
        ev.stopPropagation();
        const nextGrp = tr.groupId === "A" ? "B" : (tr.groupId === "B" ? null : "A");
        if (typeof Engine.setTrackGroup === "function") Engine.setTrackGroup(state, tr.id, nextGrp);
        renderTrackHeaders();
      };

      const loadBtn = document.createElement("button");
      loadBtn.type = "button";
      loadBtn.className = "ls-btn-mini";
      loadBtn.textContent = "+Audio";
      loadBtn.title = `Load an audio clip onto ${tr.name}`;
      loadBtn.onclick = (ev) => {
        ev.stopPropagation();
        pendingLoadTrackId = tr.id;
        $("lsDawTrackFileInput")?.click();
      };

      leftBtns.appendChild(muteBtn);
      leftBtns.appendChild(soloBtn);
      leftBtns.appendChild(frzBtn);
      leftBtns.appendChild(bncBtn);
      leftBtns.appendChild(grpBtn);
      leftBtns.appendChild(loadBtn);

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "ls-btn-mini";
      delBtn.textContent = "×";
      delBtn.title = state.tracks.length <= 1 ? "Cannot delete last track" : `Delete ${tr.name}`;
      delBtn.disabled = state.tracks.length <= 1;
      delBtn.onclick = (ev) => {
        ev.stopPropagation();
        if (Engine.deleteTrack(state, tr.id)) {
          selectedFxSlotId = null;
          updateAllDawUi();
        }
      };

      ctrls.appendChild(leftBtns);
      ctrls.appendChild(delBtn);
      box.appendChild(ctrls);

      container.appendChild(box);
    });
  }

  /* ================= Modular Per-Track FX Rack UI ================= */

  function drawTrackEqCurve(params, isDisabled) {
    const canvas = $("lsDawTrackEqCanvas");
    if (!canvas || !Dsp || typeof Dsp.computeEqCurvePoints !== "function") return;
    const pal = getStudioPalette();
    const { ctx, w, h } = prepareHiDpiCanvas(canvas, 520, 132);

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = pal.canvasBg;
    ctx.fillRect(0, 0, w, h);

    ctx.font = "600 9px ui-monospace, SFMono-Regular, Menlo, monospace";
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
      ctx.fillText(row.label, 4, y - 3);
    });

    const minF = 20;
    const maxF = 18000;
    const logRange = Math.log10(maxF / minF);
    const freqToX = (f) => (Math.log10(Math.max(minF, Math.min(maxF, f)) / minF) / logRange) * w;

    [50, 100, 250, 500, 1000, 3500, 10000].forEach((f) => {
      const x = Math.round(freqToX(f)) + 0.5;
      ctx.strokeStyle = pal.grid;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.fillStyle = pal.textMuted;
      ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x + 3, h - 4);
    });

    const pts = Dsp.computeEqCurvePoints(
      Object.assign({}, params, { bypass: Boolean(isDisabled) })
    );

    const xy = pts.map((pt) => ({
      x: freqToX(pt.freq),
      y: h * 0.5 - (Math.max(-15, Math.min(15, pt.db)) / 15) * (h * 0.38)
    }));
    if (xy.length > 0 && !isDisabled) {
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, colorWithAlpha(pal.accent, 0.28));
      grad.addColorStop(0.55, colorWithAlpha(pal.accent, 0.08));
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
    if (isDisabled) {
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = pal.textMuted;
    } else {
      ctx.strokeStyle = pal.accent;
      ctx.shadowColor = colorWithAlpha(pal.accent, 0.38);
      ctx.shadowBlur = 6;
    }
    ctx.lineWidth = 2.2;
    ctx.stroke();
    ctx.restore();

    [
      { freq: Number(params.f80) || 80, val: Number(params.b80) || 0, on: params.on1 !== 0 },
      { freq: Number(params.f250) || 250, val: Number(params.b250) || 0, on: params.on2 !== 0 },
      { freq: Number(params.f1k) || 1000, val: Number(params.b1k) || 0, on: params.on3 !== 0 },
      { freq: Number(params.f3k5) || 3500, val: Number(params.b3k5) || 0, on: params.on4 !== 0 },
      { freq: Number(params.f10k) || 10000, val: Number(params.b10k) || 0, on: params.on5 !== 0 }
    ].forEach((b) => {
      const x = freqToX(b.freq);
      const y = h * 0.5 - (Math.max(-15, Math.min(15, b.on ? b.val : 0)) / 15) * (h * 0.38);
      ctx.beginPath();
      ctx.arc(x, y, 4.6, 0, Math.PI * 2);
      ctx.fillStyle = isDisabled || !b.on ? pal.textMuted : pal.accent;
      ctx.fill();
      ctx.strokeStyle = pal.canvasBg;
      ctx.lineWidth = 1.4;
      ctx.stroke();
    });

    if (params.linearPhase) {
      ctx.fillStyle = pal.accentSecondary;
      ctx.font = "700 9.5px ui-monospace, monospace";
      ctx.fillText("LINEAR-PHASE FIR (513 TAP · 256 SMP COMP)", w - 260, 12);
    }
  }

  function drawCompressorCurve(params, isDisabled) {
    const canvas = $("lsDawCompCurveCanvas");
    if (!canvas) return;
    const pal = getStudioPalette();
    const { ctx, w, h } = prepareHiDpiCanvas(canvas, 196, 156);
    const padL = 22;
    const padB = 18;
    const padT = 8;
    const padR = 8;
    const pw = w - padL - padR;
    const ph = h - padT - padB;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = pal.canvasBg;
    ctx.fillRect(0, 0, w, h);

    const minDb = -60;
    const maxDb = 0;
    const dbToX = (db) => padL + ((db - minDb) / (maxDb - minDb)) * pw;
    const dbToY = (db) => padT + ph - ((db - minDb) / (maxDb - minDb)) * ph;

    ctx.font = "600 8.5px ui-monospace, SFMono-Regular, Menlo, monospace";
    [-48, -36, -24, -12].forEach((db) => {
      const x = Math.round(dbToX(db)) + 0.5;
      const y = Math.round(dbToY(db)) + 0.5;
      ctx.strokeStyle = pal.grid;
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + ph);
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + pw, y);
      ctx.stroke();
      ctx.fillStyle = pal.textMuted;
      ctx.fillText(String(db), 2, y + 3);
    });

    // Unity 1:1 reference diagonal
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = pal.gridZero;
    ctx.beginPath();
    ctx.moveTo(dbToX(minDb), dbToY(minDb));
    ctx.lineTo(dbToX(maxDb), dbToY(maxDb));
    ctx.stroke();
    ctx.restore();

    const thr = Number(params.threshold ?? -18);
    const ratio = Math.max(1, Number(params.ratio ?? 3.5));
    const knee = Math.max(0, Number(params.knee ?? 10));
    const makeup = Number(params.makeupDb ?? 0);

    function evalComp(inDb) {
      let outDb = inDb;
      if (knee > 0 && Math.abs(inDb - thr) <= knee / 2) {
        const delta = inDb - thr + knee / 2;
        outDb = inDb + ((1 / ratio - 1) * delta * delta) / (2 * knee);
      } else if (inDb > thr) {
        outDb = thr + (inDb - thr) / ratio;
      }
      return Math.max(minDb, Math.min(maxDb, outDb + (isDisabled ? 0 : makeup)));
    }

    const curvePts = [];
    for (let db = minDb; db <= maxDb; db += 1) {
      curvePts.push({ x: dbToX(db), y: dbToY(isDisabled ? db : evalComp(db)) });
    }

    if (!isDisabled && curvePts.length > 0) {
      const grad = ctx.createLinearGradient(0, padT, 0, padT + ph);
      grad.addColorStop(0, colorWithAlpha(pal.accent, 0.34));
      grad.addColorStop(1, colorWithAlpha(pal.accent, 0.02));
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(curvePts[0].x, dbToY(minDb));
      curvePts.forEach((p) => ctx.lineTo(p.x, p.y));
      ctx.lineTo(curvePts[curvePts.length - 1].x, dbToY(minDb));
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.restore();
    }

    ctx.save();
    ctx.beginPath();
    curvePts.forEach((p, idx) => (idx === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.strokeStyle = isDisabled ? pal.textMuted : pal.accent;
    if (isDisabled) ctx.setLineDash([4, 4]);
    ctx.lineWidth = 2.2;
    ctx.stroke();
    ctx.restore();

    const kneeX = dbToX(thr);
    const kneeY = dbToY(isDisabled ? thr : evalComp(thr));
    ctx.beginPath();
    ctx.arc(kneeX, kneeY, 4.2, 0, Math.PI * 2);
    ctx.fillStyle = isDisabled ? pal.textMuted : pal.accent;
    ctx.fill();
    ctx.strokeStyle = pal.canvasBg;
    ctx.lineWidth = 1.4;
    ctx.stroke();

    ctx.fillStyle = pal.textSecondary;
    ctx.fillText(`THR ${thr}dB · ${ratio}:1`, padL + 4, padT + 10);
  }

  function pushLiveFxUpdate(trackId, slot) {
    if (!activePreviewGraph || !slot) return;
    let chain = null;
    if (trackId === "master") {
      chain = activePreviewGraph.masterChain;
    } else {
      const bus = activePreviewGraph.trackBuses.get(trackId);
      chain = bus ? bus.fxChain : null;
    }
    const handle = chain && chain.slots ? chain.slots.get(slot.id) : null;
    if (!handle) return;
    handle.setEnabled(slot.enabled !== false);
    handle.setWetDry(slot.wetDry ?? 100);
    handle.updateParams(slot.params);
  }

  function drawPluginVisualCanvas(slot, isDisabled) {
    const canvas = $("lsDawPluginVisualCanvas");
    if (!canvas || !slot) return;
    const pal = getStudioPalette();
    const { ctx, w, h } = prepareHiDpiCanvas(canvas, 520, 98);
    const params = slot.params || {};
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = pal.canvasBg;
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = pal.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h * 0.5);
    ctx.lineTo(w, h * 0.5);
    ctx.stroke();

    ctx.strokeStyle = isDisabled ? pal.textMuted : pal.accentSecondary;
    ctx.lineWidth = 2;
    ctx.beginPath();

    if (slot.type === "reverb") {
      const decay = Math.max(0.2, Number(params.decay) || 1.4);
      const preDelay = Math.max(0, Number(params.preDelayMs) || 18);
      const preX = Math.min(w * 0.25, (preDelay / 120) * (w * 0.25));
      for (let x = 0; x < w; x++) {
        if (x < preX) {
          ctx.lineTo(x, h - 8);
        } else {
          const t = (x - preX) / Math.max(1, w - preX);
          const env = Math.exp(-3.2 * t * (1.5 / Math.max(0.4, decay)));
          const ripple = 0.8 + 0.2 * Math.sin(x * 0.6);
          const y = h - 8 - env * ripple * (h - 20);
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
      ctx.fillStyle = pal.textSecondary;
      ctx.font = "600 10px ui-monospace, monospace";
      const irTxt = params.customIrName ? `Custom IR: ${params.customIrName}` : `RT60 ${decay.toFixed(1)}s · Pre ${preDelay}ms · Wet ${params.wet ?? 16}% · Width ${params.stereoWidth ?? 110}%`;
      ctx.fillText(irTxt, 8, 14);
    } else if (slot.type === "delay") {
      const bpm = Number(params.bpm) || 0;
      const subdivNames = ["1/4", "1/8", "1/8D", "1/4T"];
      const subLbl = bpm >= 30 ? `${bpm} BPM (${subdivNames[Number(params.syncSubdiv) || 0]})` : `${Number(params.timeMs) || 260}ms / ${Number(params.rightTimeMs) || 390}ms`;
      const fb = Math.max(0, Math.min(0.85, (Number(params.feedback ?? 25)) / 100));
      const isPp = Boolean(params.pingPong);
      for (let tap = 1; tap <= 8; tap++) {
        const amp = Math.pow(fb, tap - 1);
        const x = 18 + tap * ((w - 36) / 9);
        const barH = Math.max(3, amp * (h - 30));
        ctx.fillStyle = isDisabled ? pal.textMuted : (isPp && tap % 2 === 0 ? pal.accentSecondary : pal.accent);
        ctx.fillRect(x, h - 10 - barH, 10, barH);
      }
      ctx.fillStyle = pal.textSecondary;
      ctx.font = "600 10px ui-monospace, monospace";
      ctx.fillText(`${subLbl} · ${isPp ? "Ping-Pong" : "Stereo"} · FB ${Math.round(fb * 100)}%`, 8, 14);
    } else if (slot.type === "saturation") {
      const isTube = Number(params.mode) === 1 || params.mode === "tube";
      const drive = Number(params.drive ?? 22);
      const bias = Number(params.bias ?? 10);
      const curve = Dsp && typeof Dsp.buildSaturationCurve === "function"
        ? Dsp.buildSaturationCurve(drive, isTube ? 1 : 0, bias, params.autoGain !== 0)
        : null;
      for (let x = 0; x < w; x++) {
        const val = curve ? curve[Math.min(curve.length - 1, Math.floor((x / Math.max(1, w - 1)) * curve.length))] : ((x / w) * 2 - 1);
        const y = h * 0.5 - (val / 1.35) * (h * 0.42);
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.fillStyle = pal.textSecondary;
      ctx.font = "600 10px ui-monospace, monospace";
      ctx.fillText(`4x Oversampled ${isTube ? "TUBE" : "TAPE"} · Drive ${drive}%${params.autoGain !== 0 ? " · Level-Matched" : ""}`, 8, 14);
    } else if (slot.type === "filter") {
      const sr = 48000;
      const q = Math.max(0.3, Math.min(8, Number(params.q) || 0.707));
      const hHz = Number(params.hpfHz) || 80;
      const lHz = Number(params.lpfHz) || 18000;
      const cH = Dsp.computeBiquadCoeffs("highpass", hHz, q, 0, sr);
      const cL = Dsp.computeBiquadCoeffs("lowpass", lHz, q, 0, sr);
      const stages = Number(params.slope) === 24 ? [cH, cH, cL, cL] : [cH, cL];
      for (let x = 0; x < w; x++) {
        const f = 20 * Math.pow(18000 / 20, x / Math.max(1, w - 1));
        let db = 0;
        for (let s = 0; s < stages.length; s++) db += Dsp.evalBiquadCoeffDb(stages[s], f, sr);
        const y = h * 0.42 - (Math.max(-24, Math.min(12, db)) / 26) * (h * 0.48);
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.fillStyle = pal.textSecondary;
      ctx.font = "600 10px ui-monospace, monospace";
      ctx.fillText(`HPF ${hHz} Hz · LPF ${lHz >= 1000 ? (lHz / 1000).toFixed(1) + "k" : lHz} Hz · ${params.slope || 12} dB/oct`, 8, 14);
    } else if (slot.type === "gate") {
      const thr = Number(params.thresholdDb ?? -48);
      const hyst = Math.max(0, Number(params.hysteresisDb ?? 4));
      const range = Number(params.rangeDb ?? -18);
      for (let x = 0; x < w; x++) {
        const inDb = -72 + (x / Math.max(1, w - 1)) * 72;
        const outDb = inDb >= thr ? inDb : Math.max(-72, inDb + range);
        const y = h - 8 - ((outDb + 72) / 72) * (h - 18);
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.fillStyle = pal.textSecondary;
      ctx.font = "600 10px ui-monospace, monospace";
      ctx.fillText(`Open ${thr} dB / Close ${thr - hyst} dB · Hold ${params.holdMs ?? 90}ms · Key HPF ${params.scHpfHz ?? 80}Hz`, 8, 14);
    } else if (slot.type === "deesser") {
      const freq = Number(params.freqHz ?? 6500);
      const q = Number(params.q ?? 3.2);
      const cut = Math.max(0, Number(params.cutDb ?? 4));
      const bpC = Dsp.computeBiquadCoeffs("bandpass", freq, q, 0, 48000);
      for (let x = 0; x < w; x++) {
        const f = 1000 + (x / Math.max(1, w - 1)) * 13000;
        const bpDb = Dsp.evalBiquadCoeffDb(bpC, f, 48000);
        const bandGain = Math.min(1, Math.pow(10, bpDb / 20));
        const atten = -cut * bandGain;
        const y = h * 0.34 - (atten / 14) * (h * 0.45);
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.fillStyle = pal.textSecondary;
      ctx.font = "600 10px ui-monospace, monospace";
      ctx.fillText(`${params.wideband ? "Wideband" : "Split-Band"} @ ${freq} Hz · Max -${cut.toFixed(1)} dB · Thresh ${params.thresholdDb ?? -26} dB`, 8, 14);
    } else if (slot.type === "stereo_width") {
      const wp = Number(params.widthPct ?? 100);
      const normW = Math.max(0, Math.min(1.6, wp / 100));
      const cx = w * 0.5;
      const cy = h - 14;
      const r = Math.min(w * 0.35, h - 24);
      const spread = (Math.PI * 0.42) * normW;
      ctx.fillStyle = colorWithAlpha(pal.accentSecondary, 0.22);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, -Math.PI * 0.5 - spread, -Math.PI * 0.5 + spread);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = pal.textSecondary;
      ctx.font = "600 10px ui-monospace, monospace";
      ctx.fillText(`Stereo Width ${wp}% · Bass Mono < ${params.bassMonoHz ?? 120} Hz`, 8, 14);
    } else if (slot.type === "limiter") {
      const ceil = Number(params.ceilingDb ?? -1.0);
      const thr = Number(params.thresholdDb ?? -2.0);
      const driveDb = Math.max(0, ceil - thr);
      for (let x = 0; x < w; x++) {
        const inDb = -24 + (x / Math.max(1, w - 1)) * 24;
        const outDb = Math.min(ceil, inDb + driveDb);
        const y = h - 10 - ((outDb + 24) / 24) * (h - 22);
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.fillStyle = pal.textSecondary;
      ctx.font = "600 10px ui-monospace, monospace";
      ctx.fillText(`True-Peak Ceiling ${ceil.toFixed(1)} dBTP · Drive +${driveDb.toFixed(1)} dB · Lookahead ${params.lookaheadMs ?? 2.5}ms`, 8, 14);
    } else {
      for (let x = 0; x < w; x++) {
        const norm = (x / Math.max(1, w - 1)) * 2 - 1;
        const y = h * 0.5 - Math.max(-0.9, Math.min(0.9, norm * 1.15)) * (h * 0.4);
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.fillStyle = pal.textSecondary;
      ctx.font = "600 10px ui-monospace, monospace";
      ctx.fillText(`${slot.name} (${slot.type})`, 8, 14);
    }
  }

  function renderFxEditor(track, slot) {
    const pane = $("lsDawFxEditorPane");
    if (!pane) return;
    pane.innerHTML = "";

    if (!track || !slot || !Dsp || !Dsp.FX_CATALOG[slot.type]) {
      pane.innerHTML = `<div class="ls-hero-sub">No effect selected for <strong>${track ? track.name : "Track"}</strong>. Pick a plugin in <strong>+ Add Effect</strong> to shape this track's sound.</div>`;
      return;
    }

    const def = Dsp.FX_CATALOG[slot.type];
    const isSlotActive = slot.enabled !== false;
    const head = document.createElement("div");
    head.className = "ls-channel-head";
    head.innerHTML = `
      <div>
        <div class="ls-channel-name">${def.name} · ${track.name}</div>
        <div class="ls-channel-tag">${isSlotActive ? "Active in track insert chain" : "Plugin bypassed (A/B compare)"}</div>
      </div>
    `;

    const rightHead = document.createElement("div");
    rightHead.className = "ls-btn-row";

    const abBtn = document.createElement("button");
    abBtn.type = "button";
    abBtn.id = "lsDawPluginBypassBtn";
    abBtn.className = `ls-btn-mini${isSlotActive ? " is-toggled" : ""}`;
    abBtn.textContent = isSlotActive ? "ACTIVE (A/B)" : "BYPASSED";
    abBtn.onclick = () => {
      Engine.toggleTrackFx(state, track.id, slot.id);
      pushLiveFxUpdate(track.id, slot);
      renderFxRack();
    };
    rightHead.appendChild(abBtn);

    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "ls-btn-mini";
    resetBtn.textContent = "Reset Default";
    resetBtn.onclick = () => {
      Engine.updateTrackFxParams(state, track.id, slot.id, Object.assign({}, def.defaultParams, { customIrData: null, customIrName: null }), { recordUndo: true });
      pushLiveFxUpdate(track.id, slot);
      renderFxEditor(track, slot);
    };
    rightHead.appendChild(resetBtn);
    head.appendChild(rightHead);
    pane.appendChild(head);

    if (track.frozen) {
      const frzNotice = document.createElement("div");
      frzNotice.className = "ls-eq-filter-bar";
      frzNotice.innerHTML = `<span class="ls-badge-pill ls-badge-blue">Track Frozen — Playing Rendered Stem</span>`;
      const unfrzBtn = document.createElement("button");
      unfrzBtn.type = "button";
      unfrzBtn.className = "ls-btn-mini is-toggled";
      unfrzBtn.textContent = "Unfreeze Track";
      unfrzBtn.onclick = () => freezeOrUnfreezeTrack(track);
      frzNotice.appendChild(unfrzBtn);
      pane.appendChild(frzNotice);
    }

    function renderPresetBarForPlugin() {
      if (!def.presets) return;
      const pRow = document.createElement("div");
      pRow.className = "ls-fx-preset-row";
      Object.keys(def.presets).forEach((pk) => {
        const p = def.presets[pk];
        const pBtn = document.createElement("button");
        pBtn.type = "button";
        pBtn.className = "ls-btn-mini";
        pBtn.textContent = p.label;
        pBtn.onclick = () => {
          Engine.updateTrackFxParams(state, track.id, slot.id, Object.assign({}, p.params, { customIrData: null, customIrName: null }), { recordUndo: true });
          pushLiveFxUpdate(track.id, slot);
          renderFxEditor(track, slot);
        };
        pRow.appendChild(pBtn);
      });
      pane.appendChild(pRow);
    }

    function createSliderRow(ctrl, targetHost, compact) {
      const row = document.createElement("div");
      row.className = "ls-slider-row";
      row.style.gridTemplateColumns = compact ? "92px 1fr 54px" : "126px 1fr 62px";
      const lbl = document.createElement("span");
      lbl.className = "ls-slider-label";
      lbl.textContent = ctrl.label;

      const curVal = ctrl.key === "wetDry"
        ? (slot.wetDry ?? 100)
        : (slot.params && slot.params[ctrl.key] !== undefined ? slot.params[ctrl.key] : def.defaultParams[ctrl.key]);

      const inp = document.createElement("input");
      inp.type = "range";
      inp.className = "ls-range";
      inp.dataset.fxKey = ctrl.key;
      inp.min = String(ctrl.min);
      inp.max = String(ctrl.max);
      inp.step = String(ctrl.step);
      inp.value = String(curVal);

      const valEl = document.createElement("span");
      valEl.className = "ls-slider-val";
      valEl.dataset.fxValFor = ctrl.key;
      valEl.textContent = `${curVal}${ctrl.unit}`;

      inp.oninput = function () {
        const nextNum = Number(this.value);
        valEl.textContent = `${nextNum}${ctrl.unit}`;
        if (ctrl.key === "wetDry") {
          slot.wetDry = nextNum;
        } else {
          Engine.updateTrackFxParams(state, track.id, slot.id, { [ctrl.key]: nextNum });
        }
        pushLiveFxUpdate(track.id, slot);
        if (slot.type === "eq") drawTrackEqCurve(slot.params, slot.enabled === false);
        else if (slot.type === "compressor") drawCompressorCurve(slot.params, slot.enabled === false);
        else drawPluginVisualCanvas(slot, slot.enabled === false);
      };

      row.appendChild(lbl);
      row.appendChild(inp);
      row.appendChild(valEl);
      targetHost.appendChild(row);
    }

    function createSegSwitch(key, options, redrawFn) {
      const wrap = document.createElement("div");
      wrap.className = "ls-seg-switch";
      const cur = Number(slot.params?.[key] ?? def.defaultParams[key] ?? 0);
      options.forEach((opt) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `ls-seg-btn${cur === opt.value ? " is-active" : ""}`;
        btn.textContent = opt.label;
        btn.onclick = () => {
          Engine.updateTrackFxParams(state, track.id, slot.id, { [key]: opt.value }, { recordUndo: true });
          pushLiveFxUpdate(track.id, slot);
          if (redrawFn) redrawFn();
          renderFxEditor(track, slot);
        };
        wrap.appendChild(btn);
      });
      return wrap;
    }

    if (slot.type === "eq") {
      const wrap = document.createElement("div");
      wrap.className = "ls-fx-eq-canvas-wrap";
      const eqCanvas = document.createElement("canvas");
      eqCanvas.id = "lsDawTrackEqCanvas";
      eqCanvas.width = 520;
      eqCanvas.height = 132;
      eqCanvas.style.cursor = "grab";
      eqCanvas.title = "Drag any EQ band node horizontally (Freq) & vertically (Gain); double-click to reset band";
      wrap.appendChild(eqCanvas);
      pane.appendChild(wrap);

      const bandSpecs = [
        { key: "b80", freqKey: "f80", qKey: "q80", onKey: "on1", title: "Low Shelf", defFreq: 80, minF: 30, maxF: 300, hasQ: false },
        { key: "b250", freqKey: "f250", qKey: "q250", onKey: "on2", title: "Low-Mid", defFreq: 250, minF: 80, maxF: 900, hasQ: true },
        { key: "b1k", freqKey: "f1k", qKey: "q1k", onKey: "on3", title: "Mid Bell", defFreq: 1000, minF: 300, maxF: 3500, hasQ: true },
        { key: "b3k5", freqKey: "f3k5", qKey: "q3k5", onKey: "on4", title: "Presence", defFreq: 3500, minF: 1200, maxF: 8000, hasQ: true },
        { key: "b10k", freqKey: "f10k", qKey: "q10k", onKey: "on5", title: "Air Shelf", defFreq: 10000, minF: 4500, maxF: 18000, hasQ: false }
      ];

      let draggingSpec = null;
      eqCanvas.onmousedown = (ev) => {
        const rect = eqCanvas.getBoundingClientRect();
        const xNorm = Math.max(0, Math.min(1, (ev.clientX - rect.left) / Math.max(1, rect.width)));
        const freqAtCursor = 20 * Math.pow(18000 / 20, xNorm);
        let best = bandSpecs[0];
        let bestDist = Infinity;
        bandSpecs.forEach((b) => {
          const bf = Number(slot.params[b.freqKey]) || b.defFreq;
          const d = Math.abs(Math.log10(freqAtCursor / bf));
          if (d < bestDist) { bestDist = d; best = b; }
        });
        draggingSpec = best;
        eqCanvas.style.cursor = "grabbing";
      };
      window.addEventListener("mousemove", (ev) => {
        if (!draggingSpec || !document.body.contains(eqCanvas)) return;
        const rect = eqCanvas.getBoundingClientRect();
        const xNorm = Math.max(0, Math.min(1, (ev.clientX - rect.left) / Math.max(1, rect.width)));
        const yNorm = Math.max(0, Math.min(1, (ev.clientY - rect.top) / Math.max(1, rect.height)));
        const dbVal = Math.max(-12, Math.min(12, Math.round(((0.5 - yNorm) / 0.38) * 15 * 2) / 2));
        const rawFreq = 20 * Math.pow(18000 / 20, xNorm);
        const clampedFreq = Math.round(Math.max(draggingSpec.minF, Math.min(draggingSpec.maxF, rawFreq)));
        Engine.updateTrackFxParams(state, track.id, slot.id, {
          [draggingSpec.key]: dbVal,
          [draggingSpec.freqKey]: clampedFreq,
          [draggingSpec.onKey]: 1
        });
        pushLiveFxUpdate(track.id, slot);
        drawTrackEqCurve(slot.params, slot.enabled === false);
        const rGain = pane.querySelector(`input[data-fx-key="${draggingSpec.key}"]`);
        const lGain = pane.querySelector(`span[data-fx-val-for="${draggingSpec.key}"]`);
        if (rGain) rGain.value = String(dbVal);
        if (lGain) lGain.textContent = `${dbVal} dB`;
        const rFreq = pane.querySelector(`input[data-fx-key="${draggingSpec.freqKey}"]`);
        const lFreq = pane.querySelector(`span[data-fx-val-for="${draggingSpec.freqKey}"]`);
        if (rFreq) rFreq.value = String(clampedFreq);
        if (lFreq) lFreq.textContent = `${clampedFreq >= 1000 ? (clampedFreq / 1000).toFixed(1) + "k" : clampedFreq}`;
      });
      window.addEventListener("mouseup", () => {
        draggingSpec = null;
        if (eqCanvas) eqCanvas.style.cursor = "grab";
      });
      eqCanvas.ondblclick = (ev) => {
        const rect = eqCanvas.getBoundingClientRect();
        const xNorm = Math.max(0, Math.min(1, (ev.clientX - rect.left) / Math.max(1, rect.width)));
        const freqAtCursor = 20 * Math.pow(18000 / 20, xNorm);
        let best = bandSpecs[0];
        let bestDist = Infinity;
        bandSpecs.forEach((b) => {
          const bf = Number(slot.params[b.freqKey]) || b.defFreq;
          const d = Math.abs(Math.log10(freqAtCursor / bf));
          if (d < bestDist) { bestDist = d; best = b; }
        });
        Engine.updateTrackFxParams(state, track.id, slot.id, { [best.key]: 0 }, { recordUndo: true });
        pushLiveFxUpdate(track.id, slot);
        renderFxEditor(track, slot);
      };

      renderPresetBarForPlugin();

      // HPF / LPF / Phase Topology Bar
      const fBar = document.createElement("div");
      fBar.className = "ls-eq-filter-bar";
      fBar.appendChild(createSegSwitch("linearPhase", [
        { label: "Min-Phase (0ms)", value: 0 },
        { label: "Linear-Phase FIR (5.3ms)", value: 1 }
      ]));
      fBar.appendChild(createSegSwitch("hpfSlope", [
        { label: "12 dB/oct", value: 12 },
        { label: "24 dB/oct", value: 24 }
      ]));
      pane.appendChild(fBar);

      const filterGrid = document.createElement("div");
      filterGrid.className = "ls-plugin-param-grid";
      filterGrid.style.marginBottom = "8px";
      createSliderRow({ key: "hpfHz", label: "Low Cut HPF", min: 20, max: 300, step: 5, unit: " Hz" }, filterGrid, true);
      createSliderRow({ key: "lpfHz", label: "High Cut LPF", min: 2000, max: 20000, step: 250, unit: " Hz" }, filterGrid, true);
      pane.appendChild(filterGrid);

      // 5-Column Parametric Band Strip Cards
      const stripGrid = document.createElement("div");
      stripGrid.className = "ls-eq-band-strip-grid";
      bandSpecs.forEach((b) => {
        const isOn = slot.params[b.onKey] !== 0;
        const card = document.createElement("div");
        card.className = `ls-eq-band-card${isOn ? "" : " is-band-off"}`;

        const cHead = document.createElement("div");
        cHead.className = "ls-eq-band-card-head";
        const cTitle = document.createElement("span");
        cTitle.textContent = b.title;
        const cBtn = document.createElement("button");
        cBtn.type = "button";
        cBtn.className = `ls-btn-mini${isOn ? " is-toggled" : ""}`;
        cBtn.textContent = isOn ? "ON" : "OFF";
        cBtn.onclick = () => {
          Engine.updateTrackFxParams(state, track.id, slot.id, { [b.onKey]: isOn ? 0 : 1 }, { recordUndo: true });
          pushLiveFxUpdate(track.id, slot);
          renderFxEditor(track, slot);
        };
        cHead.appendChild(cTitle);
        cHead.appendChild(cBtn);
        card.appendChild(cHead);

        function addMiniRow(label, key, min, max, step, fmtFn) {
          const r = document.createElement("div");
          r.className = "ls-eq-band-mini-row";
          const l = document.createElement("span");
          l.textContent = label;
          const inp = document.createElement("input");
          inp.type = "range";
          inp.className = "ls-range";
          inp.dataset.fxKey = key;
          inp.min = String(min);
          inp.max = String(max);
          inp.step = String(step);
          const cur = slot.params[key] !== undefined ? Number(slot.params[key]) : (def.defaultParams[key] ?? b.defFreq);
          inp.value = String(cur);
          const v = document.createElement("span");
          v.className = "ls-eq-band-mini-val";
          v.dataset.fxValFor = key;
          v.textContent = fmtFn(cur);
          inp.oninput = function () {
            const num = Number(this.value);
            v.textContent = fmtFn(num);
            Engine.updateTrackFxParams(state, track.id, slot.id, { [key]: num });
            pushLiveFxUpdate(track.id, slot);
            drawTrackEqCurve(slot.params, slot.enabled === false);
          };
          r.appendChild(l);
          r.appendChild(inp);
          r.appendChild(v);
          card.appendChild(r);
        }

        addMiniRow("Gain", b.key, -12, 12, 0.5, (n) => `${n} dB`);
        addMiniRow("Freq", b.freqKey, b.minF, b.maxF, b.maxF > 2000 ? 50 : 10, (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`));
        if (b.hasQ) {
          addMiniRow("Q", b.qKey, 0.4, 6.0, 0.1, (n) => `${n.toFixed(1)}`);
        }
        stripGrid.appendChild(card);
      });
      pane.appendChild(stripGrid);
      const wetRowWrap = document.createElement("div");
      wetRowWrap.className = "ls-plugin-param-grid";
      createSliderRow({ key: "wetDry", label: "Plugin Mix", min: 0, max: 100, step: 1, unit: "%" }, wetRowWrap, true);
      pane.appendChild(wetRowWrap);
      drawTrackEqCurve(slot.params, slot.enabled === false);
      return;
    }

    if (slot.type === "compressor") {
      renderPresetBarForPlugin();
      const modeBar = document.createElement("div");
      modeBar.className = "ls-eq-filter-bar";
      modeBar.appendChild(createSegSwitch("peakMode", [
        { label: "RMS Opto/Smooth", value: 0 },
        { label: "Peak Transient", value: 1 }
      ]));
      const grWrap = document.createElement("div");
      grWrap.className = "ls-gr-row";
      grWrap.style.marginTop = "0";
      grWrap.style.flex = "1";
      grWrap.innerHTML = `<span>Gain Red</span><div class="ls-gr-track"><div class="ls-gr-fill" id="lsDawCompGrBar"></div></div><span class="ls-gr-val" id="lsDawCompGrVal">0.0 dB</span>`;
      modeBar.appendChild(grWrap);
      pane.appendChild(modeBar);

      const split = document.createElement("div");
      split.className = "ls-comp-editor-split";
      const curveWrap = document.createElement("div");
      curveWrap.className = "ls-fx-eq-canvas-wrap";
      const compCanvas = document.createElement("canvas");
      compCanvas.id = "lsDawCompCurveCanvas";
      compCanvas.width = 196;
      compCanvas.height = 156;
      curveWrap.appendChild(compCanvas);

      const ctrlStack = document.createElement("div");
      ctrlStack.className = "ls-stack-sm";
      def.controls.filter((c) => c.key !== "peakMode").forEach((c) => createSliderRow(c, ctrlStack, true));
      createSliderRow({ key: "wetDry", label: "Plugin Mix", min: 0, max: 100, step: 1, unit: "%" }, ctrlStack, true);

      split.appendChild(curveWrap);
      split.appendChild(ctrlStack);
      pane.appendChild(split);
      drawCompressorCurve(slot.params, slot.enabled === false);
      return;
    }

    // All other plugins (filter, gate, deesser, reverb, delay, saturation, stereo_width, limiter)
    const visWrap = document.createElement("div");
    visWrap.className = "ls-fx-eq-canvas-wrap";
    const visCanvas = document.createElement("canvas");
    visCanvas.id = "lsDawPluginVisualCanvas";
    visCanvas.width = 520;
    visCanvas.height = 98;
    visWrap.appendChild(visCanvas);
    pane.appendChild(visWrap);

    if (slot.type === "reverb") {
      const irRow = document.createElement("div");
      irRow.className = "ls-fx-preset-row";
      if (Dsp.HALL_IR_PRESETS) {
        Object.keys(Dsp.HALL_IR_PRESETS).forEach((pk) => {
          const pr = Dsp.HALL_IR_PRESETS[pk];
          const b = document.createElement("button");
          b.type = "button";
          b.className = "ls-btn-mini";
          b.textContent = pr.label || pk;
          b.onclick = () => {
            Engine.updateTrackFxParams(state, track.id, slot.id, Object.assign({ preset: pk, customIrName: null, customIrData: null }, pr), { recordUndo: true });
            pushLiveFxUpdate(track.id, slot);
            renderFxEditor(track, slot);
          };
          irRow.appendChild(b);
        });
      }
      const customIrLbl = document.createElement("label");
      customIrLbl.className = "ls-btn-mini ls-btn-upload";
      customIrLbl.textContent = "Load Custom IR (.wav)";
      const customIrInp = document.createElement("input");
      customIrInp.type = "file";
      customIrInp.accept = ".wav,audio/*";
      customIrInp.style.display = "none";
      customIrInp.onchange = async function () {
        const f = this.files && this.files[0];
        if (!f) return;
        try {
          const irBuf = await decodeAudioFile(f);
          const irL = irBuf.getChannelData(0);
          const irR = irBuf.numberOfChannels > 1 ? irBuf.getChannelData(1) : irL;
          Engine.updateTrackFxParams(state, track.id, slot.id, {
            customIrName: f.name,
            customIrData: {
              sampleRate: irBuf.sampleRate,
              left: Array.from(irL.slice(0, Math.min(irL.length, irBuf.sampleRate * 4))),
              right: Array.from(irR.slice(0, Math.min(irR.length, irBuf.sampleRate * 4)))
            }
          });
          pushLiveFxUpdate(track.id, slot);
          renderFxEditor(track, slot);
          setStatusNotice(`Loaded custom convolution IR "${f.name}" onto ${track.name}.`, false);
        } catch (err) {
          setStatusNotice("Could not decode custom IR WAV: " + err.message, true);
        } finally {
          this.value = "";
        }
      };
      customIrLbl.appendChild(customIrInp);
      irRow.appendChild(customIrLbl);
      if (slot.params.customIrName) {
        const clrBtn = document.createElement("button");
        clrBtn.type = "button";
        clrBtn.className = "ls-btn-mini";
        clrBtn.textContent = "Use Synth IR";
        clrBtn.onclick = () => {
          Engine.updateTrackFxParams(state, track.id, slot.id, { customIrName: null, customIrData: null });
          pushLiveFxUpdate(track.id, slot);
          renderFxEditor(track, slot);
        };
        irRow.appendChild(clrBtn);
      }
      pane.appendChild(irRow);
    } else {
      renderPresetBarForPlugin();
    }

    // Distinct mode bars per plugin type
    const hiddenKeys = new Set();
    if (slot.type === "filter") {
      const bar = document.createElement("div");
      bar.className = "ls-eq-filter-bar";
      bar.appendChild(createSegSwitch("slope", [
        { label: "12 dB/oct", value: 12 },
        { label: "24 dB/oct", value: 24 }
      ]));
      pane.appendChild(bar);
      hiddenKeys.add("slope");
    } else if (slot.type === "deesser") {
      const bar = document.createElement("div");
      bar.className = "ls-eq-filter-bar";
      bar.appendChild(createSegSwitch("wideband", [
        { label: "Split-Band Sibilance", value: 0 },
        { label: "Wideband Dynamic", value: 1 }
      ]));
      pane.appendChild(bar);
      hiddenKeys.add("wideband");
    } else if (slot.type === "saturation") {
      const bar = document.createElement("div");
      bar.className = "ls-eq-filter-bar";
      bar.appendChild(createSegSwitch("mode", [
        { label: "Tape Warmth", value: 0 },
        { label: "Tube Triode", value: 1 }
      ]));
      bar.appendChild(createSegSwitch("autoGain", [
        { label: "Auto Level-Match: OFF", value: 0 },
        { label: "Auto Level-Match: ON", value: 1 }
      ]));
      pane.appendChild(bar);
      hiddenKeys.add("mode");
      hiddenKeys.add("autoGain");
    } else if (slot.type === "delay") {
      const bar = document.createElement("div");
      bar.className = "ls-eq-filter-bar";
      bar.appendChild(createSegSwitch("pingPong", [
        { label: "Dual Stereo", value: 0 },
        { label: "Ping-Pong L↔R", value: 1 }
      ]));
      bar.appendChild(createSegSwitch("syncSubdiv", [
        { label: "1/4", value: 0 },
        { label: "1/8", value: 1 },
        { label: "1/8D", value: 2 },
        { label: "1/4T", value: 3 }
      ]));
      pane.appendChild(bar);
      hiddenKeys.add("pingPong");
      hiddenKeys.add("syncSubdiv");
    } else if (slot.type === "limiter") {
      const bar = document.createElement("div");
      bar.className = "ls-eq-filter-bar";
      bar.innerHTML = `<span class="ls-badge-pill ls-badge-blue">4× Oversampled True-Peak</span><div class="ls-gr-row" style="margin-top:0;flex:1;"><span>Limiter GR</span><div class="ls-gr-track"><div class="ls-gr-fill" id="lsDawLimiterGrBar"></div></div><span class="ls-gr-val" id="lsDawLimiterGrVal">0.0 dB</span></div>`;
      pane.appendChild(bar);
    }

    const paramGrid = document.createElement("div");
    paramGrid.className = "ls-plugin-param-grid";
    def.controls
      .filter((c) => !hiddenKeys.has(c.key))
      .forEach((c) => createSliderRow(c, paramGrid, true));
    createSliderRow({ key: "wetDry", label: "Plugin Mix", min: 0, max: 100, step: 1, unit: "%" }, paramGrid, true);
    pane.appendChild(paramGrid);

    drawPluginVisualCanvas(slot, slot.enabled === false);
  }

  function renderFxRack() {
    if (!state || !Engine) return;
    const track = Engine.getTrackById(state, state.selectedTrackId) || state.tracks[0];
    if (!track) return;

    const lbl = $("lsDawFxActiveTrackLabel");
    if (lbl) lbl.textContent = track.name;

    const sel = $("lsDawFxTrackSelect");
    if (sel) {
      sel.innerHTML = "";
      state.tracks.forEach((tr) => {
        const opt = document.createElement("option");
        opt.value = tr.id;
        opt.textContent = `${tr.name} (${(tr.fxRack || []).length} FX)`;
        sel.appendChild(opt);
      });
      if (state.masterTrack) {
        const mOpt = document.createElement("option");
        mOpt.value = "master";
        mOpt.textContent = `Master Bus (${(state.masterTrack.fxRack || []).length} FX)`;
        sel.appendChild(mOpt);
      }
      sel.value = track.id;
    }

    const listEl = $("lsDawFxSlotList");
    if (!listEl) return;
    listEl.innerHTML = "";

    const rack = Array.isArray(track.fxRack) ? track.fxRack : [];
    if (!rack.some((s) => s.id === selectedFxSlotId)) {
      selectedFxSlotId = rack[0] ? rack[0].id : null;
    }

    if (rack.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ls-hero-sub";
      empty.style.padding = "14px";
      empty.textContent = `No effects loaded on ${track.name} yet. Click "+ Add Effect" above.`;
      listEl.appendChild(empty);
      renderFxEditor(track, null);
      return;
    }

    rack.forEach((slot, idx) => {
      const row = document.createElement("div");
      const isSel = slot.id === selectedFxSlotId;
      const isOff = slot.enabled === false;
      row.className = `ls-fx-slot${isSel ? " is-selected" : ""}${isOff ? " is-bypassed" : ""}`;
      row.onclick = (ev) => {
        if (ev.target.closest("button")) return;
        selectedFxSlotId = slot.id;
        renderFxRack();
      };

      const led = document.createElement("button");
      led.type = "button";
      led.className = `ls-fx-led${isOff ? "" : " is-on"}`;
      led.title = isOff ? "Enable effect" : "Bypass effect";
      led.onclick = (ev) => {
        ev.stopPropagation();
        Engine.toggleTrackFx(state, track.id, slot.id);
        pushLiveFxUpdate(track.id, slot);
        renderFxRack();
      };

      const catTags = {
        eq: "EQ",
        filter: "FLT",
        compressor: "DYN",
        gate: "GATE",
        deesser: "DS",
        reverb: "REV",
        delay: "DLY",
        saturation: "SAT",
        stereo_width: "M/S",
        limiter: "LIM"
      };
      const nameEl = document.createElement("div");
      nameEl.className = "ls-fx-slot-name";
      const tagEl = document.createElement("span");
      tagEl.className = "ls-fx-cat-tag";
      tagEl.textContent = catTags[slot.type] || "FX";
      const lblSpan = document.createElement("span");
      lblSpan.textContent = `${idx + 1}. ${slot.name}`;
      nameEl.appendChild(tagEl);
      nameEl.appendChild(lblSpan);

      const btns = document.createElement("div");
      btns.className = "ls-btn-row";
      btns.style.gap = "3px";

      const dupBtn = document.createElement("button");
      dupBtn.type = "button";
      dupBtn.className = "ls-btn-mini";
      dupBtn.textContent = "Dup";
      dupBtn.title = "Duplicate effect slot";
      dupBtn.onclick = (ev) => {
        ev.stopPropagation();
        const cloned = typeof Engine.duplicateTrackFx === "function"
          ? Engine.duplicateTrackFx(state, track.id, slot.id)
          : null;
        if (cloned) {
          selectedFxSlotId = cloned.id;
          if (isPlaying) startPreviewPlayback();
          renderTrackHeaders();
          renderFxRack();
        }
      };

      const upBtn = document.createElement("button");
      upBtn.type = "button";
      upBtn.className = "ls-btn-mini";
      upBtn.textContent = "↑";
      upBtn.disabled = idx === 0;
      upBtn.onclick = (ev) => {
        ev.stopPropagation();
        if (Engine.moveTrackFx(state, track.id, slot.id, -1)) {
          if (isPlaying) startPreviewPlayback();
          renderFxRack();
        }
      };

      const dnBtn = document.createElement("button");
      dnBtn.type = "button";
      dnBtn.className = "ls-btn-mini";
      dnBtn.textContent = "↓";
      dnBtn.disabled = idx === rack.length - 1;
      dnBtn.onclick = (ev) => {
        ev.stopPropagation();
        if (Engine.moveTrackFx(state, track.id, slot.id, 1)) {
          if (isPlaying) startPreviewPlayback();
          renderFxRack();
        }
      };

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "ls-btn-mini";
      delBtn.textContent = "×";
      delBtn.title = "Remove effect";
      delBtn.onclick = (ev) => {
        ev.stopPropagation();
        if (Engine.removeTrackFx(state, track.id, slot.id)) {
          if (isPlaying) startPreviewPlayback();
          renderTrackHeaders();
          renderFxRack();
        }
      };

      btns.appendChild(dupBtn);
      btns.appendChild(upBtn);
      btns.appendChild(dnBtn);
      btns.appendChild(delBtn);

      row.appendChild(led);
      row.appendChild(nameEl);
      row.appendChild(btns);
      listEl.appendChild(row);
    });

    const activeSlot = rack.find((s) => s.id === selectedFxSlotId) || rack[0];
    renderFxEditor(track, activeSlot);
  }

  /* ================= Clip Inspector & Canvas Renderer ================= */

  function renderClipInspector() {
    const box = $("lsDawInspectorBox");
    if (!box || !state) return;
    const clip = state.clips.find((c) => c.id === selectedClipId);
    if (!clip) {
      box.style.opacity = "0.55";
      return;
    }
    box.style.opacity = "1";
    const gainEl = $("lsDawClipGain");
    const gainVal = $("lsDawClipGainVal");
    const fiEl = $("lsDawClipFadeIn");
    const fiVal = $("lsDawClipFadeInVal");
    const foEl = $("lsDawClipFadeOut");
    const foVal = $("lsDawClipFadeOutVal");
    const xfEl = $("lsDawClipCrossfade");
    const xfVal = $("lsDawClipCrossfadeVal");
    const lblEl = $("lsDawSelectedClipLabel");
    const trimStartEl = $("lsDawTrimStart");
    const trimEndEl = $("lsDawTrimEnd");

    if (lblEl) lblEl.textContent = clip.label;
    if (gainEl) gainEl.value = String(clip.gainDb || 0);
    if (gainVal) gainVal.textContent = `${clip.gainDb || 0} dB`;
    if (fiEl) fiEl.value = String(clip.fadeInSec || 0);
    if (fiVal) fiVal.textContent = `${clip.fadeInSec || 0}s`;
    if (foEl) foEl.value = String(clip.fadeOutSec || 0);
    if (foVal) foVal.textContent = `${clip.fadeOutSec || 0}s`;
    if (xfEl) xfEl.value = String(clip.crossfadePrevSec || 0);
    if (xfVal) xfVal.textContent = `${clip.crossfadePrevSec || 0}s`;
    if (trimStartEl) trimStartEl.value = clip.sourceStart.toFixed(1);
    if (trimEndEl) trimEndEl.value = clip.sourceEnd.toFixed(1);
  }

  function getAutoLaneMeta(laneName, tr) {
    const table = Engine && Engine.AUTOMATION_LANES ? Engine.AUTOMATION_LANES : null;
    const def = table && table[laneName]
      ? table[laneName]
      : { key: laneName, label: laneName, min: 0, max: 180, defaultVal: 100, unit: "" };
    let fallbackVal = def.defaultVal;
    if (tr) {
      if (laneName === "gain") fallbackVal = tr.gain ?? 100;
      else if (laneName === "pan") fallbackVal = tr.pan ?? 0;
    }
    return Object.assign({}, def, { fallbackVal });
  }

  function renderHistoryMenu() {
    const menu = $("lsDawHistoryMenu");
    if (!menu || !Engine || typeof Engine.getHistoryList !== "function") return;
    menu.classList.toggle("ls-is-hidden", !historyMenuOpen);
    if (!historyMenuOpen) return;
    menu.innerHTML = "";
    const hist = Engine.getHistoryList(state);
    if (hist.undoItems.length === 0 && hist.redoItems.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ls-hero-sub";
      empty.style.padding = "6px 8px";
      empty.textContent = "No edit history steps yet.";
      menu.appendChild(empty);
      return;
    }
    hist.redoItems.forEach((item, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ls-daw-history-item is-redo";
      btn.innerHTML = `<span>↷ Redo: ${item.label}</span><span>#${idx + 1}</span>`;
      btn.onclick = () => {
        Engine.jumpToHistoryStep(state, "redo", idx + 1);
        historyMenuOpen = false;
        pushMarkersToStudioBridge();
        if (isPlaying) startPreviewPlayback();
        updateAllDawUi();
      };
      menu.appendChild(btn);
    });
    const revUndo = hist.undoItems.slice().reverse();
    revUndo.forEach((item, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ls-daw-history-item";
      btn.innerHTML = `<span>↶ Undo: ${item.label}</span><span>-${idx + 1}</span>`;
      btn.onclick = () => {
        Engine.jumpToHistoryStep(state, "undo", idx + 1);
        historyMenuOpen = false;
        pushMarkersToStudioBridge();
        if (isPlaying) startPreviewPlayback();
        updateAllDawUi();
      };
      menu.appendChild(btn);
    });
  }

  function drawWaveformChannel(ctx, peaks, clip, srcDuration, clipX, clipY, clipW, clipH, color) {
    if (!peaks || !peaks.max || peaks.max.length === 0 || clipW <= 1) return;
    const totalBuckets = peaks.max.length;
    const startBucket = Math.max(0, Math.floor((clip.sourceStart / srcDuration) * totalBuckets));
    const endBucket = Math.min(totalBuckets, Math.ceil((clip.sourceEnd / srcDuration) * totalBuckets));
    const bucketSpan = Math.max(1, endBucket - startBucket);
    const gainScale = Math.pow(10, (Number(clip.gainDb) || 0) / 20) * waveScale;
    const midY = clipY + clipH / 2;
    const halfH = clipH * 0.43;

    const pxStep = 2;
    const outerColor = colorWithAlpha(color, 0.46);
    const coreColor = colorWithAlpha(color, 0.94);

    for (let px = 0; px < clipW; px += pxStep) {
      const b0 = startBucket + Math.floor((px / clipW) * bucketSpan);
      const b1 = Math.min(endBucket, startBucket + Math.ceil(((px + pxStep) / clipW) * bucketSpan));
      let minV = 0;
      let maxV = 0;
      for (let b = b0; b < b1; b++) {
        if (peaks.max[b] > maxV) maxV = peaks.max[b];
        if (peaks.min[b] < minV) minV = peaks.min[b];
      }
      const ampTop = Math.min(1, maxV * gainScale) * halfH;
      const ampBot = Math.min(1, Math.abs(minV) * gainScale) * halfH;
      const barH = Math.max(1.5, ampTop + ampBot);
      ctx.fillStyle = outerColor;
      ctx.fillRect(clipX + px, midY - ampTop, pxStep - 0.35, barH);
      const coreTop = ampTop * 0.62;
      const coreH = Math.max(1, barH * 0.62);
      ctx.fillStyle = coreColor;
      ctx.fillRect(clipX + px, midY - coreTop, pxStep - 0.35, coreH);
    }
  }

  function hexToRgba(hex, alpha) {
    const clean = String(hex || "#d97706").replace("#", "");
    if (clean.length !== 6) return `rgba(217,119,6,${alpha})`;
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function drawCanvas() {
    const canvas = $("lsDawCanvas");
    const wrap = $("lsDawCanvasWrap");
    if (!canvas || !wrap || !state || !Engine) return;

    const pal = getStudioPalette();
    const layout = Engine.computeTimelineLayout(state.clips);
    const totalDur = Math.max(10, layout.totalDuration);
    const wrapW = Math.max(600, wrap.clientWidth - 2);
    const canvasW = Math.floor(wrapW * zoomLevel);
    const rulerH = 28;
    const laneH = laneHeightPx;
    const laneGap = 4;
    const tracks = state.tracks || [];
    const canvasH = Math.max(226, rulerH + tracks.length * (laneH + laneGap) + 6);

    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = `${canvasW}px`;
    canvas.style.height = `${canvasH}px`;
    if (canvas.width !== canvasW * dpr || canvas.height !== canvasH * dpr) {
      canvas.width = canvasW * dpr;
      canvas.height = canvasH * dpr;
    }

    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Dual-theme studio arrangement ground
    ctx.fillStyle = pal.canvasBg;
    ctx.fillRect(0, 0, canvasW, canvasH);

    const pxPerSec = canvasW / totalDur;

    // Horizontal Time Ruler
    ctx.fillStyle = pal.rulerBg;
    ctx.fillRect(0, 0, canvasW, rulerH);
    ctx.strokeStyle = pal.border;
    ctx.beginPath();
    ctx.moveTo(0, rulerH + 0.5);
    ctx.lineTo(canvasW, rulerH + 0.5);
    ctx.stroke();

    // Time / Bar-Beat / Sample ticks + grid
    const cfg = state.timelineConfig || { rulerMode: "time", bpm: 96, beatsPerBar: 4, sampleRate: 48000 };
    let tickStep = 5;
    if (cfg.rulerMode === "bars") {
      const barSec = (60 / Math.max(30, Number(cfg.bpm) || 96)) * Math.max(2, Number(cfg.beatsPerBar) || 4);
      tickStep = barSec;
      while (tickStep * pxPerSec < 48) tickStep *= 2;
    } else {
      if (pxPerSec < 2) tickStep = 120;
      else if (pxPerSec < 5) tickStep = 60;
      else if (pxPerSec < 12) tickStep = 30;
      else if (pxPerSec < 25) tickStep = 10;
    }

    ctx.fillStyle = pal.textSecondary;
    ctx.font = "600 10px ui-monospace, SFMono-Regular, Menlo, monospace";
    for (let t = 0; t <= totalDur; t += tickStep) {
      const x = Math.round(t * pxPerSec) + 0.5;
      ctx.strokeStyle = pal.grid;
      ctx.beginPath();
      ctx.moveTo(x, rulerH);
      ctx.lineTo(x, canvasH);
      ctx.stroke();

      ctx.strokeStyle = pal.border;
      ctx.beginPath();
      ctx.moveTo(x, rulerH - 9);
      ctx.lineTo(x, rulerH);
      ctx.stroke();
      ctx.fillText(formatTimecode(t, false), x + 4, 17);

      // Minor ruler sub-ticks
      for (let sub = 1; sub <= 3; sub++) {
        const subSec = t + (tickStep * sub) / 4;
        if (subSec >= totalDur) break;
        const sx = Math.round(subSec * pxPerSec) + 0.5;
        ctx.strokeStyle = pal.gridZero;
        ctx.beginPath();
        ctx.moveTo(sx, rulerH - 4);
        ctx.lineTo(sx, rulerH);
        ctx.stroke();
      }
    }

    // Track Lanes
    const laneYById = {};
    tracks.forEach((tr, idx) => {
      const y = rulerH + idx * (laneH + laneGap) + 2;
      laneYById[tr.id] = y;
      const isSelectedLane = state.selectedTrackId === tr.id;
      ctx.fillStyle = isSelectedLane ? pal.laneSelected : (idx % 2 === 0 ? pal.laneA : pal.laneB);
      ctx.fillRect(0, y, canvasW, laneH);

      // Subtle center zero-line & lane boundary
      ctx.strokeStyle = pal.grid;
      ctx.beginPath();
      ctx.moveTo(0, Math.round(y + laneH * 0.5) + 0.5);
      ctx.lineTo(canvasW, Math.round(y + laneH * 0.5) + 0.5);
      ctx.stroke();

      ctx.strokeStyle = pal.border;
      ctx.beginPath();
      ctx.moveTo(0, y + laneH + 0.5);
      ctx.lineTo(canvasW, y + laneH + 0.5);
      ctx.stroke();
    });

    if (layout.items.length === 0) {
      const boxW = Math.min(canvasW - 36, 460);
      const boxX = Math.max(18, Math.round((canvasW - boxW) * 0.38));
      const boxY = rulerH + 34;
      ctx.fillStyle = colorWithAlpha(pal.panel, pal.isDark ? 0.85 : 0.92);
      ctx.fillRect(boxX, boxY, boxW, 56);
      ctx.strokeStyle = pal.border;
      ctx.strokeRect(boxX + 0.5, boxY + 0.5, boxW - 1, 55);
      ctx.fillStyle = pal.text;
      ctx.font = "700 12px Inter, system-ui, sans-serif";
      ctx.fillText("Multitrack Arrangement Ready", boxX + 14, boxY + 23);
      ctx.fillStyle = pal.textSecondary;
      ctx.font = "500 11px Inter, system-ui, sans-serif";
      ctx.fillText("Use Load Recording, Open File, or + Audio on any track header.", boxX + 14, boxY + 41);
    }

    function drawClipBlockInLane(it, laneY, peaks, colorHex) {
      const c = it.clip;
      const src = sourceBuffers[c.sourceId];
      const x = it.timelineStart * pxPerSec;
      const w = Math.max(4, it.duration * pxPerSec);
      const isSel = c.id === selectedClipId || selectedClipIds.has(c.id);

      ctx.fillStyle = colorWithAlpha(colorHex, isSel ? 0.2 : 0.11);
      ctx.fillRect(x, laneY, w, laneH);
      ctx.fillStyle = colorWithAlpha(colorHex, isSel ? 1 : 0.88);
      ctx.fillRect(x, laneY, w, 3);
      ctx.strokeStyle = isSel ? pal.accent : pal.border;
      ctx.lineWidth = isSel ? 1.8 : 1;
      ctx.strokeRect(x + 0.5, laneY + 0.5, w - 1, laneH - 1);

      if (src && peaks) {
        drawWaveformChannel(ctx, peaks, c, src.duration, x, laneY, w, laneH, colorHex);
      }

      const fadeOverlay = colorWithAlpha(pal.canvasBg, 0.52);
      const fiPx = (Number(c.fadeInSec) || 0) * pxPerSec;
      if (fiPx > 2) {
        ctx.fillStyle = fadeOverlay;
        ctx.beginPath();
        ctx.moveTo(x, laneY);
        ctx.lineTo(x + fiPx, laneY);
        ctx.lineTo(x, laneY + laneH);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = pal.textSecondary;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x, laneY + laneH);
        ctx.lineTo(x + fiPx, laneY);
        ctx.stroke();
      }
      const foPx = (Number(c.fadeOutSec) || 0) * pxPerSec;
      if (foPx > 2) {
        ctx.fillStyle = fadeOverlay;
        ctx.beginPath();
        ctx.moveTo(x + w - foPx, laneY);
        ctx.lineTo(x + w, laneY);
        ctx.lineTo(x + w, laneY + laneH);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = pal.textSecondary;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x + w - foPx, laneY);
        ctx.lineTo(x + w, laneY + laneH);
        ctx.stroke();
      }

      // Clip edge trim handles when wide enough
      if (w >= 16) {
        ctx.fillStyle = isSel ? pal.accent : pal.textMuted;
        ctx.fillRect(x + 1, laneY + laneH - 13, 3, 11);
        ctx.fillRect(x + w - 4, laneY + laneH - 13, 3, 11);
      }

      ctx.fillStyle = pal.text;
      ctx.font = "600 11px Inter, system-ui, sans-serif";
      const tag = c.gainDb ? `${c.label} (${c.gainDb > 0 ? "+" : ""}${c.gainDb}dB)` : c.label;
      ctx.fillText(tag.slice(0, 34), x + 7, laneY + 15);
    }

    layout.items.forEach((it) => {
      const c = it.clip;
      const src = sourceBuffers[c.sourceId];
      const estW = Math.max(4, it.duration * pxPerSec);
      const p1 = src ? pickPyramidTier(src.pyramid1, src.peaks1, estW) : null;
      const p2 = src ? pickPyramidTier(src.pyramid2, src.peaks2 || src.peaks1, estW) : null;
      if (!c.trackId) {
        const t1 = tracks.find((t) => t.role === "ch1") || tracks[0];
        const t2 = tracks.find((t) => t.role === "ch2") || tracks[1];
        if (t1 && laneYById[t1.id] != null) {
          drawClipBlockInLane(it, laneYById[t1.id], p1, resolveProTrackColor(t1, 0));
        }
        if (t2 && laneYById[t2.id] != null && (!src || src.hasTwoTracks || p2)) {
          drawClipBlockInLane(it, laneYById[t2.id], p2 || p1, resolveProTrackColor(t2, 1));
        }
      } else {
        const targetIdx = tracks.findIndex((t) => t.id === c.trackId);
        const targetTrack = targetIdx >= 0 ? tracks[targetIdx] : null;
        if (targetTrack && laneYById[targetTrack.id] != null) {
          drawClipBlockInLane(it, laneYById[targetTrack.id], p1, resolveProTrackColor(targetTrack, targetIdx));
        }
      }
    });

    // Automation Envelopes Overlay
    if (showAutomation && typeof Engine.evaluateAutomation === "function") {
      tracks.forEach((tr) => {
        const laneY = laneYById[tr.id];
        if (laneY == null) return;
        const pts = (tr.automation && tr.automation[activeAutoLane]) || [];
        const meta = getAutoLaneMeta(activeAutoLane, tr);
        const span = Math.max(1e-6, meta.max - meta.min);
        const valToY = (val) => {
          const norm = (Number(val) - meta.min) / span;
          return laneY + laneH - 8 - Math.max(0, Math.min(1, norm)) * (laneH - 16);
        };
        const segCount = 120;
        ctx.save();
        ctx.strokeStyle = pal.accent;
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let i = 0; i <= segCount; i++) {
          const t = (i / segCount) * totalDur;
          const v = Engine.evaluateAutomation(pts, t, meta.fallbackVal);
          const sx = t * pxPerSec;
          const sy = valToY(v);
          if (i === 0) ctx.moveTo(sx, sy);
          else ctx.lineTo(sx, sy);
        }
        ctx.stroke();
        ctx.restore();
        pts.forEach((pt) => {
          const px = (pt.timeSec ?? 0) * pxPerSec;
          const py = valToY(pt.value);
          ctx.beginPath();
          ctx.arc(px, py, 4.5, 0, Math.PI * 2);
          ctx.fillStyle = pal.accent;
          ctx.fill();
          ctx.strokeStyle = pal.canvasBg;
          ctx.lineWidth = 1.4;
          ctx.stroke();
        });
      });
    }

    // Loop Region Bracket
    const loopReg = state.loopRegion || {};
    if (loopReg.enabled && loopReg.endSec > loopReg.startSec + 0.05) {
      const lx0 = loopReg.startSec * pxPerSec;
      const lw = Math.max(4, (loopReg.endSec - loopReg.startSec) * pxPerSec);
      ctx.fillStyle = colorWithAlpha(pal.success, 0.28);
      ctx.fillRect(lx0, 0, lw, 8);
      ctx.strokeStyle = pal.success;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(lx0, 0.5, lw, 7);
    }

    // Selection overlay
    if (selectionStart != null && selectionEnd != null && Math.abs(selectionEnd - selectionStart) > 0.05) {
      const s0 = Math.min(selectionStart, selectionEnd) * pxPerSec;
      const sw = Math.abs(selectionEnd - selectionStart) * pxPerSec;
      ctx.fillStyle = colorWithAlpha(pal.accent, 0.2);
      ctx.fillRect(s0, rulerH, sw, canvasH - rulerH);
      ctx.strokeStyle = pal.accent;
      ctx.lineWidth = 1.2;
      ctx.strokeRect(s0, rulerH, sw, canvasH - rulerH);
    }

    // Markers on ruler
    state.markers.forEach((m) => {
      const mx = m.start_seconds * pxPerSec;
      ctx.strokeStyle = pal.success;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(mx, 0);
      ctx.lineTo(mx, canvasH);
      ctx.stroke();

      ctx.fillStyle = pal.success;
      ctx.fillRect(mx, 2, Math.min(114, Math.max(36, m.bhajan_title.length * 6.5)), 15);
      ctx.fillStyle = "#ffffff";
      ctx.font = "700 10px Inter, system-ui, sans-serif";
      ctx.fillText(m.bhajan_title.slice(0, 16), mx + 4, 13);
    });

    // Playhead
    const pxPlay = playheadSec * pxPerSec;
    ctx.strokeStyle = pal.danger;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(pxPlay, 0);
    ctx.lineTo(pxPlay, canvasH);
    ctx.stroke();

    ctx.fillStyle = pal.danger;
    ctx.beginPath();
    ctx.moveTo(pxPlay - 6, 0);
    ctx.lineTo(pxPlay + 6, 0);
    ctx.lineTo(pxPlay, 10);
    ctx.closePath();
    ctx.fill();
  }

  function updateAllDawUi() {
    if (!state || !Engine) return;
    const layout = Engine.computeTimelineLayout(state.clips);
    playheadSec = Math.min(playheadSec, layout.totalDuration || 0);
    updateTransportReadout(layout.totalDuration);
    renderTrackHeaders();
    renderFxRack();
    renderClipInspector();
    drawCanvas();

    const selLabel = $("lsDawSelectionLabel");
    if (selLabel) {
      if (selectionStart != null && selectionEnd != null && Math.abs(selectionEnd - selectionStart) >= 0.1) {
        const a = Math.min(selectionStart, selectionEnd);
        const b = Math.max(selectionStart, selectionEnd);
        selLabel.textContent = `Selected: ${formatTimecode(a, false)} – ${formatTimecode(b, false)} (${(b - a).toFixed(1)}s)`;
      } else {
        selLabel.textContent = showAutomation
          ? `Automation Lane: ${activeAutoLane.toUpperCase()} (Click track lane to add point, Alt+Click to remove)`
          : "Drag on waveform to select range to cut";
      }
    }

    if ($("lsDawLoopBtn")) {
      $("lsDawLoopBtn").classList.toggle("is-toggled", Boolean(state.loopRegion && state.loopRegion.enabled));
    }
    if ($("lsDawSnapBtn")) {
      $("lsDawSnapBtn").classList.toggle("is-toggled", snapEnabled);
    }
    if ($("lsDawAutoToggleBtn")) {
      $("lsDawAutoToggleBtn").classList.toggle("is-toggled", showAutomation);
    }
    if ($("lsDawAutoLaneSelect")) {
      $("lsDawAutoLaneSelect").style.display = showAutomation ? "inline-block" : "none";
      $("lsDawAutoLaneSelect").value = activeAutoLane;
    }
    if ($("lsDawAutoClearBtn")) {
      $("lsDawAutoClearBtn").style.display = showAutomation ? "inline-flex" : "none";
    }
    if ($("lsDawRulerModeSelect") && state.timelineConfig) {
      $("lsDawRulerModeSelect").value = state.timelineConfig.rulerMode || "time";
    }
    if ($("lsDawBpmInput") && state.timelineConfig) {
      $("lsDawBpmInput").value = String(state.timelineConfig.bpm || 96);
    }
    if ($("lsDawWaveScaleBtn")) {
      $("lsDawWaveScaleBtn").textContent = `Wave ×${waveScale}`;
    }
    if (historyMenuOpen) renderHistoryMenu();
    if ($("lsDawDeleteTrackBtn")) {
      $("lsDawDeleteTrackBtn").disabled = !state.tracks || state.tracks.length <= 1 || state.selectedTrackId === "master";
    }
    if ($("lsDawUndoBtn")) $("lsDawUndoBtn").disabled = state.undoStack.length === 0;
    if ($("lsDawRedoBtn")) $("lsDawRedoBtn").disabled = state.redoStack.length === 0;
    if ($("lsDawMasterTrimInput") && state.masterTrack) {
      const mTrim = Number(state.masterTrack.inputTrimDb) || 0;
      $("lsDawMasterTrimInput").value = String(mTrim);
      if ($("lsDawMasterTrimVal")) $("lsDawMasterTrimVal").textContent = `${mTrim > 0 ? "+" : ""}${mTrim} dB`;
    }
    if ($("lsDawAnalyzeMixBtn")) $("lsDawAnalyzeMixBtn").disabled = state.clips.length === 0 || isRendering;
    if ($("lsDawRenderBtn")) $("lsDawRenderBtn").disabled = state.clips.length === 0 || isRendering;
    if ($("lsDawRenderPublishBtn")) {
      $("lsDawRenderPublishBtn").disabled = state.clips.length === 0 || isRendering;
    }
  }

  function resolveMasterDeliveryTargets() {
    const sel = $("lsDawLufsSelect")?.value || "-14";
    if (sel === "off") {
      return { targetLufs: null, ceilingDb: -1.0, modeLabel: "Off (Ceiling Safety)" };
    }
    if (sel === "custom") {
      const t = Number($("lsDawCustomLufsInput")?.value ?? -14);
      const c = Number($("lsDawCustomCeilingInput")?.value ?? -1.0);
      return {
        targetLufs: Number.isFinite(t) ? Math.max(-28, Math.min(-6, t)) : -14,
        ceilingDb: Number.isFinite(c) ? Math.max(-4, Math.min(-0.1, c)) : -1.0,
        modeLabel: `Custom (${t} LUFS)`
      };
    }
    const num = Number(sel);
    return {
      targetLufs: Number.isFinite(num) ? num : -14,
      ceilingDb: -1.0,
      modeLabel: `${num} LUFS`
    };
  }

  function renderLoudnessReportCard(stats, extras = {}) {
    const card = $("lsDawLoudnessReportCard");
    const pill = $("lsDawLoudnessReport");
    const fmtDb = (v, unit) => (Number.isFinite(v) ? `${v.toFixed(1)} ${unit}` : `−∞ ${unit}`);
    if (pill && stats && Number.isFinite(stats.integratedLufs)) {
      const prefix = extras.isPreAnalysis ? "Measured" : (extras.targetLufs == null ? "Ceiling Safe" : "Mastered");
      const gainStr = extras.appliedGainDb ? ` (${extras.appliedGainDb >= 0 ? "+" : ""}${extras.appliedGainDb.toFixed(1)} dB)` : "";
      pill.textContent = `${prefix}: ${stats.integratedLufs.toFixed(1)} LUFS · LRA ${(stats.loudnessRangeLu || 0).toFixed(1)} LU · TP ${stats.truePeakDb.toFixed(1)} dBTP${gainStr}`;
      pill.style.display = "inline-flex";
    }
    if (!card || !stats) return;
    const cells = [
      { lbl: "Integrated", val: fmtDb(stats.integratedLufs, "LUFS") },
      { lbl: "Short-Term Max", val: fmtDb(stats.shortTermMaxLufs, "LUFS") },
      { lbl: "Momentary Max", val: fmtDb(stats.momentaryMaxLufs, "LUFS") },
      { lbl: "Loudness Range", val: `${(stats.loudnessRangeLu || 0).toFixed(1)} LU` },
      { lbl: "Sample Peak", val: fmtDb(stats.samplePeakDb, "dBFS") },
      { lbl: "True Peak (4×)", val: fmtDb(stats.truePeakDb, "dBTP") },
      { lbl: "RMS Level", val: fmtDb(stats.rmsDb, "dBFS") }
    ];
    const gridHtml = cells.map((c) => (
      `<div class="ls-loudness-metric-cell"><div class="ls-loudness-metric-lbl">${c.lbl}</div><div class="ls-loudness-metric-val">${c.val}</div></div>`
    )).join("");
    const advisoryText = extras.advisory || "";
    const isWarn = Boolean(extras.gainCapped || extras.excessiveLimitingWarning);
    card.innerHTML = `<div class="ls-loudness-metrics-grid">${gridHtml}</div>${advisoryText ? `<div class="ls-loudness-advisory${isWarn ? " is-warn" : ""}">${advisoryText}</div>` : ""}`;
    card.style.display = "block";
  }

  /**
   * Dedicated chunked overlap-save offline timeline renderer preserving plugin tails, automation,
   * fades, channel alignment, and bounded RAM across long sessions.
   */
  async function renderTimelineInChunksOffline(layout, totalRenderDur, sampleRate, onProgress) {
    const totalFrames = Math.ceil(totalRenderDur * sampleRate);
    const outL = new Float32Array(totalFrames);
    const outR = new Float32Array(totalFrames);

    // Pre-render frozen tracks OR unfrozen tracks containing gate/linear-phase EQ for full offline DSP parity
    const preRenderedMap = {};
    for (let tIdx = 0; tIdx < state.tracks.length; tIdx += 1) {
      const tr = state.tracks[tIdx];
      if (tr.frozen && frozenTrackBuffers[tr.id]?.audioBuf) {
        preRenderedMap[tr.id] = frozenTrackBuffers[tr.id].audioBuf;
      } else if ((tr.fxRack || []).some((s) => s.enabled !== false && (s.type === "gate" || (s.type === "eq" && Number(s.params?.linearPhase) === 1)))) {
        const trRes = await renderSingleTrackBufferOffline(tr, totalRenderDur, sampleRate);
        preRenderedMap[tr.id] = trRes.audioBuf;
      }
    }

    const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const CHUNK_SEC = 90;
    const PRE_ROLL_SEC = 1.5;
    const XFADE_FRAMES = 64;
    const numChunks = Math.max(1, Math.ceil(totalRenderDur / CHUNK_SEC));

    for (let cIdx = 0; cIdx < numChunks; cIdx += 1) {
      const winStart = cIdx * CHUNK_SEC;
      const winEnd = Math.min(totalRenderDur, winStart + CHUNK_SEC);
      const actualStart = cIdx === 0 ? 0 : Math.max(0, winStart - PRE_ROLL_SEC);
      const renderSpan = Math.max(0.05, winEnd - actualStart);
      const renderFrames = Math.ceil(renderSpan * sampleRate);

      const offline = new OfflineCtx(2, renderFrames, sampleRate);
      const graph = buildDawAudioGraph(offline, preRenderedMap);
      scheduleTrackAutomation(offline, graph, actualStart, winEnd, 0);

      Object.keys(preRenderedMap).forEach((tid) => {
        const bus = graph.trackBuses.get(tid);
        schedulePreRenderedTrackBuffer(offline, bus, preRenderedMap[tid], actualStart, 0);
      });

      for (let i = 0; i < layout.items.length; i += 1) {
        const item = layout.items[i];
        if (item.timelineStart >= winEnd || item.timelineEnd <= actualStart) continue;
        const prevItem = i > 0 && !item.clip.trackId ? layout.items[i - 1] : null;
        const nextItem = i + 1 < layout.items.length && !item.clip.trackId ? layout.items[i + 1] : null;
        scheduleClipIntoContext(offline, graph, item, prevItem, nextItem, actualStart, 0);
      }

      const renderedBuf = await offline.startRendering();
      const bL = renderedBuf.getChannelData(0);
      const bR = renderedBuf.numberOfChannels > 1 ? renderedBuf.getChannelData(1) : bL;
      const skip = Math.round((winStart - actualStart) * sampleRate);
      const dstStart = Math.round(winStart * sampleRate);
      const copyCount = Math.min(totalFrames - dstStart, Math.max(0, bL.length - skip));

      if (cIdx > 0 && dstStart >= XFADE_FRAMES && skip >= XFADE_FRAMES) {
        for (let k = 0; k < XFADE_FRAMES; k += 1) {
          const alpha = k / XFADE_FRAMES;
          const oIdx = dstStart - XFADE_FRAMES + k;
          const bIdx = skip - XFADE_FRAMES + k;
          outL[oIdx] = outL[oIdx] * (1 - alpha) + bL[bIdx] * alpha;
          outR[oIdx] = outR[oIdx] * (1 - alpha) + bR[bIdx] * alpha;
        }
      }

      outL.set(bL.subarray(skip, skip + copyCount), dstStart);
      outR.set(bR.subarray(skip, skip + copyCount), dstStart);

      if (typeof onProgress === "function") {
        onProgress((cIdx + 1) / numChunks);
      }
      if (numChunks > 1) {
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    return { left: outL, right: outR };
  }

  function applyMasterPostPasses(chL, chR, sampleRate) {
    if (Dsp && typeof Dsp.processFxSlotOffline === "function" && state.masterTrack) {
      const mGates = (state.masterTrack.fxRack || []).filter((s) => s.enabled !== false && s.type === "gate");
      for (let g = 0; g < mGates.length; g += 1) {
        const gRes = Dsp.processFxSlotOffline(chL, chR === chL ? null : chR, mGates[g], sampleRate);
        chL.set(gRes.left);
        if (chR !== chL && gRes.right) chR.set(gRes.right);
      }
    }
    if ($("lsDawNoiseGateCheck")?.checked && Dsp) {
      Dsp.applyNoiseGateOffline(chL, sampleRate, -48);
      if (chR !== chL) Dsp.applyNoiseGateOffline(chR, sampleRate, -48);
    }
  }

  async function analyzeMixOffline() {
    if (!state || state.clips.length === 0 || isRendering) return;
    const layout = Engine.computeTimelineLayout(state.clips);
    if (layout.totalDuration <= 0.1) return;

    isRendering = true;
    updateAllDawUi();
    stopPreviewPlayback();

    const progWrap = $("lsDawRenderProgressWrap");
    const progFill = $("lsDawRenderProgressFill");
    if (progWrap) progWrap.style.display = "block";
    if (progFill) progFill.style.width = "10%";
    setStatusNotice("Analyzing multitrack ITU-R BS.1770-4 loudness & True-Peak headroom...", false);

    try {
      const sampleRate = 48000;
      const tailSec = Dsp && typeof Dsp.computeRackTailSeconds === "function"
        ? Dsp.computeRackTailSeconds(state.tracks, state.masterTrack)
        : 1.5;
      const { left: chL, right: chR } = await renderTimelineInChunksOffline(
        layout,
        layout.totalDuration + tailSec,
        sampleRate,
        (frac) => { if (progFill) progFill.style.width = `${10 + Math.round(frac * 85)}%`; }
      );
      applyMasterPostPasses(chL, chR, sampleRate);

      const { targetLufs, ceilingDb } = resolveMasterDeliveryTargets();
      const preStats = Dsp.analyzeLoudnessFull(chL, chR, sampleRate);
      const safety = typeof Dsp.evaluateNormalizationSafety === "function"
        ? Dsp.evaluateNormalizationSafety(preStats, { targetLufs, ceilingDb, maxAllowedGrDb: 6.0 })
        : { advisory: "", gainCapped: false };

      renderLoudnessReportCard(preStats, {
        isPreAnalysis: true,
        targetLufs,
        advisory: safety.advisory,
        gainCapped: safety.gainCapped
      });
      if (progFill) progFill.style.width = "100%";
      setStatusNotice("Loudness analysis complete — review headroom & delivery advisory below.", false);
    } catch (err) {
      setStatusNotice("Loudness analysis failed: " + err.message, true);
    } finally {
      isRendering = false;
      updateAllDawUi();
    }
  }

  async function renderEditedMixToMp3(autoUploadAfter) {
    if (!state || state.clips.length === 0 || isRendering) return;
    const layout = Engine.computeTimelineLayout(state.clips);
    if (layout.totalDuration <= 0.1) return;

    isRendering = true;
    updateAllDawUi();
    stopPreviewPlayback();

    const progWrap = $("lsDawRenderProgressWrap");
    const progFill = $("lsDawRenderProgressFill");
    if (progWrap) progWrap.style.display = "block";
    if (progFill) progFill.style.width = "5%";

    const formatVal = $("lsDawExportFormatSelect")?.value || "";
    const kbps = (formatVal.startsWith("mp3_") || formatVal.startsWith("mp3-"))
      ? Number(formatVal.replace("mp3_", "").replace("mp3-", "")) || 192
      : Number($("lsPublishBitrateSelect")?.value || 192);
    const isWav24 = formatVal === "wav_24" || formatVal === "wav-24";
    const isWav16 = formatVal === "wav_16" || formatVal === "wav-16-dither";
    const exportSr = Number($("lsDawExportSampleRateSelect")?.value) || 48000;
    setStatusNotice("Rendering multitrack timeline, automation & mastering rack offline...", false);

    try {
      const internalSr = 48000;
      const tailSec = Dsp && typeof Dsp.computeRackTailSeconds === "function"
        ? Dsp.computeRackTailSeconds(state.tracks, state.masterTrack)
        : 1.5;
      const totalRenderDur = layout.totalDuration + tailSec;

      let { left: chL, right: chR } = await renderTimelineInChunksOffline(
        layout,
        totalRenderDur,
        internalSr,
        (frac) => { if (progFill) progFill.style.width = `${5 + Math.round(frac * 35)}%`; }
      );
      applyMasterPostPasses(chL, chR, internalSr);

      const { targetLufs, ceilingDb, modeLabel } = resolveMasterDeliveryTargets();
      const protectDynamics = Boolean($("lsDawProtectDynamicsCheck")?.checked);
      let appliedGainDb = 0;
      let normMeta = { gainCapped: false, excessiveLimitingWarning: false, safetyAdvisory: "" };
      let finalMetrics = null;

      if (Dsp) {
        if (targetLufs != null) {
          const norm = Dsp.normalizeToTargetLufs(chL, chR, {
            targetLufs,
            ceilingDb,
            sampleRate: internalSr,
            protectDynamics
          });
          appliedGainDb = norm.gainDb || 0;
          normMeta = norm;
        } else {
          const lim = Dsp.applyTruePeakLimiterOffline(chL, chR, {
            ceilingDb,
            lookaheadMs: 2.5,
            releaseMs: 80,
            sampleRate: internalSr
          });
          chL.set(lim.left);
          if (lim.right) chR.set(lim.right);
          normMeta.safetyAdvisory = `Preserved original mix dynamics (True-Peak capped at ${ceilingDb.toFixed(1)} dBTP).`;
        }
      }

      // High-quality 32-tap Sinc SRC if 44.1 kHz export was chosen
      let outSampleRate = internalSr;
      if (exportSr !== internalSr && window.LiveStreamWavUtils && typeof window.LiveStreamWavUtils.resampleStereoSinc === "function") {
        setStatusNotice(`Resampling master (${internalSr} Hz -> ${exportSr} Hz Blackman Sinc SRC)...`, false);
        const resampled = window.LiveStreamWavUtils.resampleStereoSinc(chL, chR, internalSr, exportSr);
        chL = resampled.left;
        chR = resampled.right || resampled.left;
        outSampleRate = resampled.sampleRate;
        if (Dsp) {
          const reLim = Dsp.applyTruePeakLimiterOffline(chL, chR, { ceilingDb, lookaheadMs: 2.5, releaseMs: 80, sampleRate: outSampleRate });
          chL.set(reLim.left);
          if (reLim.right) chR.set(reLim.right);
        }
      }

      if (Dsp && typeof Dsp.analyzeLoudnessFull === "function") {
        finalMetrics = Dsp.analyzeLoudnessFull(chL, chR, outSampleRate);
        renderLoudnessReportCard(finalMetrics, {
          isPreAnalysis: false,
          targetLufs,
          appliedGainDb,
          gainCapped: normMeta.gainCapped,
          excessiveLimitingWarning: normMeta.excessiveLimitingWarning,
          advisory: normMeta.safetyAdvisory || `${modeLabel} · Exported @ ${outSampleRate / 1000} kHz`
        });
      }

      const sDate =
        (window.LiveStudioBridge && window.LiveStudioBridge.getSessionDate()) ||
        new Date().toISOString().slice(0, 10);

      let outFile;
      if ((isWav24 || isWav16) && window.LiveStreamWavUtils && typeof window.LiveStreamWavUtils.encodeStereoWavBuffer === "function") {
        const bitDepth = isWav24 ? 24 : 16;
        setStatusNotice(`Encoding ${bitDepth}-bit / ${outSampleRate / 1000} kHz${isWav16 ? " TPDF Dithered" : ""} Mastering WAV...`, false);
        const wavAb = window.LiveStreamWavUtils.encodeStereoWavBuffer({
          left: chL,
          right: chR,
          sampleRate: outSampleRate,
          bitDepth,
          dither: isWav16
        });
        if (typeof window.LiveStreamWavUtils.verifyWavHeaderAndSize === "function") {
          const wavChk = window.LiveStreamWavUtils.verifyWavHeaderAndSize(wavAb);
          if (!wavChk.valid) throw new Error(wavChk.error || "WAV verification failed");
        }
        outFile = new File([wavAb], `${sDate}_Master_${bitDepth}bit.wav`, { type: "audio/wav" });
        if (progFill) progFill.style.width = "100%";
      } else {
        setStatusNotice(`Encoding ${kbps} kbps / ${outSampleRate / 1000} kHz stereo MP3 (${formatTimecode(layout.totalDuration)})...`, false);
        const mp3Chunks = [];
        const worker = new Worker("/js/live-stream-encoder-worker.js?v=1.0");
        const useTpdfInt16 = Boolean(window.LiveStreamWavUtils && typeof window.LiveStreamWavUtils.floatToInt16Dithered === "function");
        await new Promise((resolve, reject) => {
          worker.onerror = reject;
          worker.onmessage = (ev) => {
            const msg = ev.data;
            if (!msg) return;
            if (msg.type === "chunk" && msg.buffer) {
              mp3Chunks.push(new Uint8Array(msg.buffer));
            } else if (msg.type === "flushed") {
              resolve();
            }
          };
          worker.postMessage({ type: "init", channels: 2, sampleRate: outSampleRate, kbps });

          (async () => {
            const blockSize = 11520;
            for (let offset = 0; offset < chL.length; offset += blockSize) {
              const end = Math.min(chL.length, offset + blockSize);
              const sliceL = chL.subarray(offset, end);
              const sliceR = chR.subarray(offset, end);
              let left, right;
              if (useTpdfInt16) {
                left = window.LiveStreamWavUtils.floatToInt16Dithered(sliceL, { dither: true });
                right = window.LiveStreamWavUtils.floatToInt16Dithered(sliceR, { dither: true });
              } else {
                const len = end - offset;
                left = new Int16Array(len);
                right = new Int16Array(len);
                for (let j = 0; j < len; j++) {
                  const l = Math.max(-1, Math.min(1, sliceL[j]));
                  const r = Math.max(-1, Math.min(1, sliceR[j]));
                  left[j] = l < 0 ? (l * 32768) | 0 : (l * 32767) | 0;
                  right[j] = r < 0 ? (r * 32768) | 0 : (r * 32767) | 0;
                }
              }
              worker.postMessage({ type: "encode", left, right }, [left.buffer, right.buffer]);
              const pct = 42 + Math.round((offset / chL.length) * 53);
              if (progFill) progFill.style.width = `${pct}%`;
              await new Promise((r) => setTimeout(r, 0));
            }
            worker.postMessage({ type: "flush" });
          })();
        });
        worker.terminate();
        if (progFill) progFill.style.width = "100%";
        outFile = new File(mp3Chunks, `${sDate}_Edited_${kbps}k.mp3`, { type: "audio/mpeg" });
      }

      lastRenderedFile = outFile;
      if (lastRenderedMp3Url) URL.revokeObjectURL(lastRenderedMp3Url);
      lastRenderedMp3Url = URL.createObjectURL(lastRenderedFile);
      const dlEl = $("lsDawDownloadRenderedBtn");
      if (dlEl) {
        dlEl.href = lastRenderedMp3Url;
        dlEl.download = lastRenderedFile.name;
        dlEl.style.display = "inline-flex";
      }

      // Persist canonical final master + exportSettings metadata to SSD directory if selected
      const canonicalName = (isWav24 || isWav16) ? "final-master.wav" : "final-master.mp3";
      let exportManifest = null;
      if (typeof Engine.exportProjectManifest === "function") {
        exportManifest = Engine.exportProjectManifest(state, {
          sessionDate: sDate,
          localFiles: { finalMaster: canonicalName, exportedFile: lastRenderedFile.name },
          exportSettings: { format: formatVal, sampleRate: outSampleRate, targetLufs, ceilingDb, protectDynamics, loudnessReport: finalMetrics }
        });
      }
      if (window.LiveStudioRecorder && typeof window.LiveStudioRecorder.saveArtifactFile === "function") {
        await window.LiveStudioRecorder.saveArtifactFile(lastRenderedFile.name, lastRenderedFile).catch(() => { });
        await window.LiveStudioRecorder.saveArtifactFile(canonicalName, lastRenderedFile).catch(() => { });
        if (exportManifest) {
          await window.LiveStudioRecorder.saveArtifactFile("project.json", JSON.stringify(exportManifest, null, 2)).catch(() => { });
        }
      }

      pushMarkersToStudioBridge();
      if (window.LiveStudioBridge) {
        window.LiveStudioBridge.setReadyPublishFile(
          lastRenderedFile,
          Math.round(layout.totalDuration),
          { artifactRole: "final_master", projectManifest: exportManifest }
        );
      }

      setStatusNotice(
        `Rendered "${lastRenderedFile.name}" (${(lastRenderedFile.size / (1024 * 1024)).toFixed(2)} MB). Ready in Cloudflare R2 Publish!`,
        false
      );

      if (autoUploadAfter && $("lsPublishR2Btn") && !$("lsPublishR2Btn").disabled) {
        $("lsPublishR2Btn").click();
      }
    } catch (err) {
      setStatusNotice("Render failed: " + err.message, true);
    } finally {
      isRendering = false;
      updateAllDawUi();
    }
  }

  function importLiveMixerSettingsIntoTracks() {
    if (!state || !Engine || !window.LiveStudioBridge || typeof window.LiveStudioBridge.getActiveFxConfig !== "function") {
      return;
    }
    const cfg = window.LiveStudioBridge.getActiveFxConfig();
    if (!cfg) return;

    const t1 = state.tracks.find((t) => t.role === "ch1") || state.tracks[0];
    const t2 = state.tracks.find((t) => t.role === "ch2") || state.tracks[1];
    if (t1) {
      t1.fxRack = [
        Engine.addTrackFx(state, t1.id, "filter", { hpfHz: cfg.vocal?.hpf || 85, lpfHz: 18000 }),
        Engine.addTrackFx(state, t1.id, "eq", {
          b80: cfg.vocal?.low || 0,
          b250: 0,
          b1k: 0,
          b3k5: cfg.vocal?.mid || 0,
          b10k: cfg.vocal?.high || 0
        }),
        Engine.addTrackFx(state, t1.id, "deesser", { cutDb: cfg.vocal?.deesser ?? 2.5 }),
        Engine.addTrackFx(state, t1.id, "compressor", {
          enabled: cfg.vocal?.comp !== false,
          threshold: -18,
          ratio: 3.5
        }),
        Engine.addTrackFx(state, t1.id, "reverb", {
          wet: cfg.reverb?.wet ?? 14,
          decay: cfg.reverb?.decay ?? 1.4,
          preDelayMs: cfg.reverb?.preDelayMs ?? 18
        })
      ].filter(Boolean);
    }
    if (t2) {
      t2.fxRack = [
        Engine.addTrackFx(state, t2.id, "filter", { hpfHz: cfg.inst?.hpf || 45, lpfHz: 18000 }),
        Engine.addTrackFx(state, t2.id, "eq", {
          b80: cfg.inst?.low || 0,
          b250: 0,
          b1k: cfg.inst?.mid || 0,
          b3k5: 0,
          b10k: cfg.inst?.high || 0
        }),
        Engine.addTrackFx(state, t2.id, "compressor", {
          enabled: Boolean(cfg.inst?.comp),
          threshold: -16,
          ratio: 2.5
        })
      ].filter(Boolean);
    }
    if (state.masterTrack) {
      state.masterTrack.fxRack = [
        Engine.addTrackFx(state, "master", "eq", {
          enabled: !cfg.master?.bypass,
          b80: cfg.master?.b80 || 0,
          b250: cfg.master?.b250 || 0,
          b1k: cfg.master?.b1k || 0,
          b3k5: cfg.master?.b3k5 || 0,
          b10k: cfg.master?.b10k || 0
        }),
        Engine.addTrackFx(state, "master", "compressor", {
          enabled: cfg.master?.glueComp !== false,
          threshold: -14,
          ratio: 2.2,
          knee: 12
        }),
        Engine.addTrackFx(state, "master", "limiter", {
          enabled: cfg.master?.limiter !== false,
          ceilingDb: -1.0
        })
      ].filter(Boolean);
    }

    selectedFxSlotId = null;
    updateAllDawUi();
    if (isPlaying) startPreviewPlayback();
    setStatusNotice("Imported Live Mixer EQ, De-Esser, Reverb & Limiter chains into Track 1 (Vocals), Track 2 (Inst) & Master Bus!", false);
  }

  function wireDawEvents() {
    if (!state || !Engine) return;

    const tabLiveBtn = $("lsTabLiveBtn");
    const tabDawBtn = $("lsTabDawBtn");
    const livePane = $("lsTabLivePane");
    const dawPane = $("lsTabDawPane");

    function switchStudioTab(which) {
      const isDaw = which === "daw";
      if (tabLiveBtn) tabLiveBtn.classList.toggle("is-active", !isDaw);
      if (tabDawBtn) tabDawBtn.classList.toggle("is-active", isDaw);
      if (livePane) livePane.style.display = isDaw ? "none" : "block";
      if (dawPane) dawPane.style.display = isDaw ? "block" : "none";
      if (isDaw) {
        pullMarkersFromStudioBridge();
        updateAllDawUi();
      }
    }

    if (tabLiveBtn) tabLiveBtn.onclick = () => switchStudioTab("live");
    if (tabDawBtn) tabDawBtn.onclick = () => switchStudioTab("daw");

    // File loaders
    if ($("lsDawLoadStemsBtn")) {
      $("lsDawLoadStemsBtn").onclick = () => {
        const f1 = $("lsDawFileCh1Input")?.files?.[0] || null;
        const f2 = $("lsDawFileCh2Input")?.files?.[0] || null;
        if (!f1 && !f2) {
          setStatusNotice("Select Ch 1 WAV and/or Ch 2 WAV first.", true);
          return;
        }
        state.clips = [];
        loadDualStemFiles(f1, f2, "2-Track Stems");
      };
    }

    if ($("lsDawSingleFileInput")) {
      $("lsDawSingleFileInput").onchange = function () {
        const f = this.files && this.files[0];
        if (f) loadSingleAudioFile(f, false, null);
        this.value = "";
      };
    }

    if ($("lsDawAppendFileInput")) {
      $("lsDawAppendFileInput").onchange = function () {
        const f = this.files && this.files[0];
        if (f) loadSingleAudioFile(f, true, null);
        this.value = "";
      };
    }

    if ($("lsDawTrackFileInput")) {
      $("lsDawTrackFileInput").onchange = function () {
        const f = this.files && this.files[0];
        const tid = pendingLoadTrackId || state.selectedTrackId;
        pendingLoadTrackId = null;
        if (f && tid && tid !== "master") {
          loadSingleAudioFile(f, true, tid);
        }
        this.value = "";
      };
    }

    // Track management & FX Rack events
    if ($("lsDawAddTrackBtn")) {
      $("lsDawAddTrackBtn").onclick = () => {
        const tr = Engine.addTrack(state);
        selectedFxSlotId = null;
        updateAllDawUi();
        setStatusNotice(`Added "${tr.name}". Click "+ Audio" to load a stem or "+ Add Effect" below.`, false);
      };
    }

    if ($("lsDawDeleteTrackBtn")) {
      $("lsDawDeleteTrackBtn").onclick = () => {
        if (Engine.deleteTrack(state, state.selectedTrackId)) {
          selectedFxSlotId = null;
          if (isPlaying) startPreviewPlayback();
          updateAllDawUi();
        }
      };
    }

    if ($("lsDawSelectMasterBtn")) {
      $("lsDawSelectMasterBtn").onclick = () => {
        Engine.selectTrack(state, "master");
        selectedFxSlotId = null;
        updateAllDawUi();
        $("lsDawFxRackPanel")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      };
    }

    if ($("lsDawFxTrackSelect")) {
      $("lsDawFxTrackSelect").onchange = function () {
        Engine.selectTrack(state, this.value);
        selectedFxSlotId = null;
        updateAllDawUi();
      };
    }

    if ($("lsDawAddFxBtn")) {
      $("lsDawAddFxBtn").onclick = () => {
        const fxType = $("lsDawAddFxSelect")?.value || "eq";
        const slot = Engine.addTrackFx(state, state.selectedTrackId, fxType);
        if (slot) {
          selectedFxSlotId = slot.id;
          if (isPlaying) startPreviewPlayback();
          updateAllDawUi();
        }
      };
    }

    if ($("lsDawImportLiveFxBtn")) {
      $("lsDawImportLiveFxBtn").onclick = importLiveMixerSettingsIntoTracks;
    }

    const CUSTOM_CHAIN_STORAGE_KEY = "bp_daw_custom_chain_presets_v1";
    function loadCustomChainPresets() {
      try {
        const raw = window.localStorage.getItem(CUSTOM_CHAIN_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
      } catch (_) {
        return [];
      }
    }
    function saveCustomChainPresets(list) {
      try {
        window.localStorage.setItem(CUSTOM_CHAIN_STORAGE_KEY, JSON.stringify(list));
      } catch (_) { }
    }
    function renderChainPresetOptions(selectedId) {
      const sel = $("lsDawChainPresetSelect");
      if (!sel) return;
      sel.innerHTML = "";
      const builtIns = Dsp && Dsp.DAW_CHAIN_PRESETS ? Object.values(Dsp.DAW_CHAIN_PRESETS) : [];
      builtIns.forEach((p) => {
        const opt = document.createElement("option");
        opt.value = `builtin:${p.id}`;
        opt.textContent = p.label;
        sel.appendChild(opt);
      });
      loadCustomChainPresets().forEach((cp) => {
        const opt = document.createElement("option");
        opt.value = `custom:${cp.id}`;
        opt.textContent = `${cp.label} (Saved)`;
        sel.appendChild(opt);
      });
      if (selectedId) sel.value = selectedId;
    }
    renderChainPresetOptions();

    if ($("lsDawApplyChainPresetBtn")) {
      $("lsDawApplyChainPresetBtn").onclick = () => {
        const val = $("lsDawChainPresetSelect")?.value || "";
        let preset = null;
        if (val.startsWith("builtin:") && Dsp && Dsp.DAW_CHAIN_PRESETS) {
          preset = Dsp.DAW_CHAIN_PRESETS[val.slice(8)];
        } else if (val.startsWith("custom:")) {
          preset = loadCustomChainPresets().find((x) => `custom:${x.id}` === val);
        }
        if (!preset || !Array.isArray(preset.slots)) return;
        const targetTrack = Engine.getTrackById(state, state.selectedTrackId) || state.tracks[0];
        if (!targetTrack) return;
        targetTrack.fxRack = preset.slots
          .map((s) => Dsp.createDefaultFxSlot(s.type, s.params ? { params: s.params, wetDry: s.wetDry } : s))
          .filter(Boolean);
        selectedFxSlotId = targetTrack.fxRack[0] ? targetTrack.fxRack[0].id : null;
        updateAllDawUi();
        if (isPlaying) startPreviewPlayback();
        setStatusNotice(`Applied "${preset.label}" FX chain to ${targetTrack.name}.`, false);
      };
    }
    if ($("lsDawSaveChainPresetBtn")) {
      $("lsDawSaveChainPresetBtn").onclick = () => {
        const targetTrack = Engine.getTrackById(state, state.selectedTrackId);
        if (!targetTrack || !Array.isArray(targetTrack.fxRack) || targetTrack.fxRack.length === 0) {
          setStatusNotice("Add at least 1 effect to this track before saving a chain preset.", true);
          return;
        }
        const name = window.prompt("Name this custom FX chain preset:", `${targetTrack.name} Chain`);
        if (!name || !name.trim()) return;
        const list = loadCustomChainPresets();
        const id = `c-${Date.now().toString(36)}`;
        list.push({
          id,
          label: name.trim(),
          slots: targetTrack.fxRack.map((s) => ({ type: s.type, enabled: s.enabled, wetDry: s.wetDry, params: s.params }))
        });
        saveCustomChainPresets(list);
        renderChainPresetOptions(`custom:${id}`);
        setStatusNotice(`Saved custom FX preset "${name.trim()}".`, false);
      };
    }
    if ($("lsDawExportChainBtn")) {
      $("lsDawExportChainBtn").onclick = () => {
        const targetTrack = Engine.getTrackById(state, state.selectedTrackId);
        if (!targetTrack) return;
        const payload = {
          version: 1,
          label: `${targetTrack.name} FX Rack`,
          slots: (targetTrack.fxRack || []).map((s) => ({ type: s.type, enabled: s.enabled, wetDry: s.wetDry, params: s.params }))
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${targetTrack.name.replace(/[^a-z0-9_-]/gi, "_")}.fxrack.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      };
    }
    if ($("lsDawImportChainInput")) {
      $("lsDawImportChainInput").onchange = async function () {
        const file = this.files && this.files[0];
        if (!file) return;
        try {
          const parsed = JSON.parse(await file.text());
          const slots = Array.isArray(parsed.slots) ? parsed.slots : (Array.isArray(parsed) ? parsed : null);
          if (!slots) throw new Error("Invalid FX rack JSON");
          const targetTrack = Engine.getTrackById(state, state.selectedTrackId) || state.tracks[0];
          if (!targetTrack) return;
          targetTrack.fxRack = slots
            .filter((s) => Dsp && Dsp.FX_CATALOG && Dsp.FX_CATALOG[s.type])
            .map((s) => Dsp.createDefaultFxSlot(s.type, { enabled: s.enabled, wetDry: s.wetDry, params: s.params }));
          selectedFxSlotId = targetTrack.fxRack[0] ? targetTrack.fxRack[0].id : null;
          updateAllDawUi();
          if (isPlaying) startPreviewPlayback();
          setStatusNotice(`Imported FX rack onto ${targetTrack.name}.`, false);
        } catch (err) {
          setStatusNotice("FX rack import failed: " + err.message, true);
        } finally {
          this.value = "";
        }
      };
    }

    // Canvas mouse interactions
    const canvas = $("lsDawCanvas");
    if (canvas) {
      function clientXToSec(clientX) {
        const rect = canvas.getBoundingClientRect();
        const layout = Engine.computeTimelineLayout(state.clips);
        const totalDur = Math.max(10, layout.totalDuration);
        const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
        return ratio * totalDur;
      }

      function clientYToTrackId(clientY) {
        const rect = canvas.getBoundingClientRect();
        const y = clientY - rect.top;
        const step = laneHeightPx + 4;
        const idx = Math.floor((y - 28) / step);
        if (idx >= 0 && idx < state.tracks.length) {
          return state.tracks[idx].id;
        }
        return null;
      }

      function maybeSnap(sec) {
        if (!snapEnabled || typeof Engine.snapTime !== "function") return sec;
        return Engine.snapTime(state, sec, { gridEnabled: true, markersEnabled: true, toleranceSec: 0.3 });
      }

      canvas.addEventListener("mousedown", (ev) => {
        const rect = canvas.getBoundingClientRect();
        const y = ev.clientY - rect.top;
        const clickSec = maybeSnap(clientXToSec(ev.clientX));

        // Top Ruler Scrubbing & Marker Click/Alt-Delete
        if (y <= 28) {
          const layout = Engine.computeTimelineLayout(state.clips);
          const pxPerSec = canvas.clientWidth / Math.max(10, layout.totalDuration);
          const hitMarker = (state.markers || []).find((m) => Math.abs(m.start_seconds * pxPerSec - (ev.clientX - rect.left)) < 18);
          if (hitMarker) {
            if (ev.altKey && typeof Engine.removeMarker === "function") {
              Engine.removeMarker(state, hitMarker.id);
              pushMarkersToStudioBridge();
              updateAllDawUi();
              return;
            }
            playheadSec = hitMarker.start_seconds;
            updateAllDawUi();
            if (isPlaying) startPreviewPlayback();
            return;
          }
          isScrubbingPlayhead = true;
          playheadSec = clickSec;
          updateTransportReadout(layout.totalDuration);
          drawCanvas();
          return;
        }

        const clickedTrack = clientYToTrackId(ev.clientY);
        if (clickedTrack && clickedTrack !== state.selectedTrackId) {
          Engine.selectTrack(state, clickedTrack);
          renderTrackHeaders();
          renderFxRack();
        }

        if (showAutomation && clickedTrack && typeof Engine.addAutomationPoint === "function") {
          const trIdx = state.tracks.findIndex((t) => t.id === clickedTrack);
          const laneTop = 28 + Math.max(0, trIdx) * (laneHeightPx + 4) + 2;
          const tr = Engine.getTrackById(state, clickedTrack);
          const meta = getAutoLaneMeta(activeAutoLane, tr);
          const relY = Math.max(0, Math.min(1, 1 - (y - laneTop - 8) / Math.max(16, laneHeightPx - 16)));
          const val = Math.round((meta.min + relY * (meta.max - meta.min)) * 10) / 10;
          const pts = (tr && tr.automation && tr.automation[activeAutoLane]) || [];
          const layout = Engine.computeTimelineLayout(state.clips);
          const tolSec = (10 / Math.max(1, rect.width)) * Math.max(10, layout.totalDuration);
          const near = pts.find((p) => Math.abs((p.timeSec ?? 0) - clickSec) < tolSec);
          if (ev.altKey) {
            if (near) Engine.removeAutomationPoint(state, clickedTrack, activeAutoLane, near.id);
          } else if (near) {
            draggingAutoPoint = { trackId: clickedTrack, ptId: near.id, laneTop };
            return;
          } else {
            Engine.addAutomationPoint(state, clickedTrack, activeAutoLane, clickSec, val);
          }
          updateAllDawUi();
          return;
        }

        // Alt + Shift + Drag slips audio inside selected clip
        if (ev.altKey && ev.shiftKey && selectedClipId) {
          isSlipDragging = true;
          dragAnchorSec = clientXToSec(ev.clientX);
          slipAccumSec = 0;
          return;
        }

        isDraggingSelection = true;
        dragAnchorSec = clickSec;
        selectionStart = dragAnchorSec;
        selectionEnd = dragAnchorSec;
      });

      window.addEventListener("mousemove", (ev) => {
        if (isScrubbingPlayhead) {
          playheadSec = maybeSnap(clientXToSec(ev.clientX));
          const layout = Engine.computeTimelineLayout(state.clips);
          updateTransportReadout(layout.totalDuration);
          drawCanvas();
          return;
        }
        if (draggingAutoPoint && typeof Engine.updateAutomationPoint === "function") {
          const rect = canvas.getBoundingClientRect();
          const y = ev.clientY - rect.top;
          const tr = Engine.getTrackById(state, draggingAutoPoint.trackId);
          const meta = getAutoLaneMeta(activeAutoLane, tr);
          const relY = Math.max(0, Math.min(1, 1 - (y - draggingAutoPoint.laneTop - 8) / Math.max(16, laneHeightPx - 16)));
          const val = Math.round((meta.min + relY * (meta.max - meta.min)) * 10) / 10;
          Engine.updateAutomationPoint(state, draggingAutoPoint.trackId, activeAutoLane, draggingAutoPoint.ptId, {
            timeSec: maybeSnap(clientXToSec(ev.clientX)),
            value: val
          });
          drawCanvas();
          return;
        }
        if (isSlipDragging && selectedClipId) {
          const curSec = clientXToSec(ev.clientX);
          const delta = curSec - dragAnchorSec - slipAccumSec;
          if (Math.abs(delta) >= 0.02 && Engine.slipClip(state, selectedClipId, -delta)) {
            slipAccumSec += delta;
            renderClipInspector();
            drawCanvas();
          }
          return;
        }
        if (!isDraggingSelection) return;
        selectionEnd = maybeSnap(clientXToSec(ev.clientX));
        drawCanvas();
      });

      window.addEventListener("mouseup", (ev) => {
        if (isScrubbingPlayhead) {
          isScrubbingPlayhead = false;
          if (isPlaying) startPreviewPlayback();
          return;
        }
        if (draggingAutoPoint) {
          draggingAutoPoint = null;
          updateAllDawUi();
          return;
        }
        if (isSlipDragging) {
          isSlipDragging = false;
          updateAllDawUi();
          return;
        }
        if (!isDraggingSelection) return;
        isDraggingSelection = false;
        const upSec = maybeSnap(clientXToSec(ev.clientX));
        if (Math.abs(upSec - dragAnchorSec) < 0.15) {
          selectionStart = null;
          selectionEnd = null;
          playheadSec = upSec;
          const layout = Engine.computeTimelineLayout(state.clips);
          const hit =
            layout.items.find(
              (it) => it.clip.trackId === state.selectedTrackId && upSec >= it.timelineStart && upSec <= it.timelineEnd
            ) ||
            layout.items.find(
              (it) => upSec >= it.timelineStart && upSec <= it.timelineEnd
            );
          if (hit) syncClipSelection(hit.clip.id, ev.shiftKey);
          if (isPlaying) startPreviewPlayback();
        } else {
          selectionStart = Math.min(dragAnchorSec, upSec);
          selectionEnd = Math.max(dragAnchorSec, upSec);
          playheadSec = selectionStart;
        }
        updateAllDawUi();
      });

      const wrapEl = $("lsDawCanvasWrap");
      if (wrapEl) {
        wrapEl.addEventListener("wheel", (ev) => {
          if (!ev.ctrlKey && !ev.metaKey) return;
          ev.preventDefault();
          const factor = ev.deltaY < 0 ? 1.25 : 0.8;
          zoomLevel = Math.max(1, Math.min(20, Math.round(zoomLevel * factor * 10) / 10));
          drawCanvas();
        }, { passive: false });
      }
    }

    // Toolbar buttons
    if ($("lsDawPlayBtn")) {
      $("lsDawPlayBtn").onclick = () => {
        if (isPlaying) stopPreviewPlayback();
        else startPreviewPlayback();
      };
    }
    if ($("lsDawStopBtn")) {
      $("lsDawStopBtn").onclick = () => {
        stopPreviewPlayback();
        playheadSec = 0;
        updateAllDawUi();
      };
    }
    if ($("lsDawLoopBtn")) {
      $("lsDawLoopBtn").onclick = () => {
        if (typeof Engine.setLoopRegion !== "function") return;
        const curReg = state.loopRegion || {};
        const curEnabled = Boolean(curReg.enabled);
        const startSec = selectionStart != null && selectionEnd != null && Math.abs(selectionEnd - selectionStart) >= 0.2
          ? Math.min(selectionStart, selectionEnd)
          : (curReg.startSec || 0);
        const layout = Engine.computeTimelineLayout(state.clips);
        const endSec = selectionStart != null && selectionEnd != null && Math.abs(selectionEnd - selectionStart) >= 0.2
          ? Math.max(selectionStart, selectionEnd)
          : (curReg.endSec > startSec + 0.2 ? curReg.endSec : Math.max(startSec + 2, layout.totalDuration || 10));
        Engine.setLoopRegion(state, { enabled: !curEnabled, startSec, endSec });
        updateAllDawUi();
        if (isPlaying) startPreviewPlayback();
      };
    }
    if ($("lsDawSnapBtn")) {
      $("lsDawSnapBtn").onclick = () => {
        snapEnabled = !snapEnabled;
        updateAllDawUi();
        setStatusNotice(`Timeline Snap to Grid/Markers: ${snapEnabled ? "ON" : "OFF"}`, false);
      };
    }
    if ($("lsDawDupClipBtn")) {
      $("lsDawDupClipBtn").onclick = () => {
        if (!selectedClipId || typeof Engine.duplicateClip !== "function") return;
        const copy = Engine.duplicateClip(state, selectedClipId);
        if (copy) {
          syncClipSelection(copy.id);
          updateAllDawUi();
          setStatusNotice(`Duplicated clip "${copy.label}".`, false);
        }
      };
    }
    if ($("lsDawJoinClipsBtn")) {
      $("lsDawJoinClipsBtn").onclick = () => {
        if (typeof Engine.joinClips !== "function") return;
        const ids = selectedClipIds.size >= 2 ? Array.from(selectedClipIds) : [selectedClipId].filter(Boolean);
        const merged = Engine.joinClips(state, ids);
        if (merged) {
          syncClipSelection(merged.id);
          updateAllDawUi();
          setStatusNotice(`Joined clips into "${merged.label}".`, false);
        } else {
          setStatusNotice("Select 2+ clips from the same stem/track (or select the first of two adjacent clips) to join.", true);
        }
      };
    }
    if ($("lsDawCutClipBtn")) {
      $("lsDawCutClipBtn").onclick = () => {
        const ids = selectedClipIds.size > 0 ? Array.from(selectedClipIds) : [selectedClipId].filter(Boolean);
        if (!ids.length || typeof Engine.cutClips !== "function") return;
        const n = Engine.cutClips(state, ids);
        if (n > 0) {
          syncClipSelection(state.clips[0] ? state.clips[0].id : null);
          updateAllDawUi();
          setStatusNotice(`Cut ${n} clip(s) to clipboard.`, false);
        }
      };
    }
    if ($("lsDawCopyClipBtn")) {
      $("lsDawCopyClipBtn").onclick = () => {
        const ids = selectedClipIds.size > 0 ? Array.from(selectedClipIds) : [selectedClipId].filter(Boolean);
        if (!ids.length || typeof Engine.copyClips !== "function") return;
        const n = Engine.copyClips(state, ids);
        clipboardClips = ids;
        setStatusNotice(`Copied ${n} clip(s) to clipboard.`, false);
      };
    }
    if ($("lsDawPasteClipBtn")) {
      $("lsDawPasteClipBtn").onclick = () => {
        if (typeof Engine.pasteClips !== "function") return;
        const pasted = Engine.pasteClips(state, playheadSec, state.selectedTrackId);
        if (pasted.length > 0) {
          syncClipSelection(pasted[0].id);
          updateAllDawUi();
          setStatusNotice(`Pasted ${pasted.length} clip(s) at ${formatTimecode(playheadSec, true)}.`, false);
        }
      };
    }
    if ($("lsDawRangeNormBtn")) {
      $("lsDawRangeNormBtn").onclick = () => {
        if (selectionStart == null || selectionEnd == null || Math.abs(selectionEnd - selectionStart) < 0.08) {
          setStatusNotice("Drag a selection range (or set In/Out) first to normalize a range.", true);
          return;
        }
        const a = Math.min(selectionStart, selectionEnd);
        const b = Math.max(selectionStart, selectionEnd);
        const layout = Engine.computeTimelineLayout(state.clips);
        let maxPeakDb = -80;
        layout.items.forEach((it) => {
          if (it.timelineEnd <= a || it.timelineStart >= b) return;
          const src = sourceBuffers[it.clip.sourceId];
          const buf = src && (src.stereo || src.ch1 || src.ch2);
          if (!buf) return;
          const data = buf.getChannelData(0);
          const clipRel0 = Math.max(0, a - it.timelineStart);
          const clipRel1 = Math.min(it.duration, b - it.timelineStart);
          const s0 = Math.max(0, Math.floor((it.clip.sourceStart + clipRel0) * buf.sampleRate));
          const s1 = Math.min(data.length, Math.ceil((it.clip.sourceStart + clipRel1) * buf.sampleRate));
          if (s1 <= s0) return;
          const pkDb = Dsp && typeof Dsp.measureTruePeakDb === "function" ? Dsp.measureTruePeakDb(data.subarray(s0, s1)) : -6;
          const effDb = pkDb + (Number(it.clip.gainDb) || 0);
          if (effDb > maxPeakDb) maxPeakDb = effDb;
        });
        const deltaDb = Math.max(-18, Math.min(18, -1.0 - maxPeakDb));
        const mod = typeof Engine.applyRangeGain === "function"
          ? Engine.applyRangeGain(state, a, b, deltaDb, state.selectedTrackId)
          : 0;
        if (mod > 0) {
          updateAllDawUi();
          setStatusNotice(`Normalized range (${deltaDb >= 0 ? "+" : ""}${deltaDb.toFixed(1)} dB across ${mod} segment(s)).`, false);
        }
      };
    }
    if ($("lsDawPrevMarkerBtn")) {
      $("lsDawPrevMarkerBtn").onclick = () => {
        const list = (state.markers || []).filter((m) => m.start_seconds < playheadSec - 0.15);
        if (list.length > 0) {
          playheadSec = list[list.length - 1].start_seconds;
          updateAllDawUi();
          if (isPlaying) startPreviewPlayback();
        }
      };
    }
    if ($("lsDawNextMarkerBtn")) {
      $("lsDawNextMarkerBtn").onclick = () => {
        const nextM = (state.markers || []).find((m) => m.start_seconds > playheadSec + 0.15);
        if (nextM) {
          playheadSec = nextM.start_seconds;
          updateAllDawUi();
          if (isPlaying) startPreviewPlayback();
        }
      };
    }
    if ($("lsDawSlipBackBtn")) {
      $("lsDawSlipBackBtn").onclick = (ev) => {
        if (!selectedClipId || typeof Engine.slipClip !== "function") return;
        const delta = ev.shiftKey ? -0.25 : -0.05;
        if (Engine.slipClip(state, selectedClipId, delta)) updateAllDawUi();
      };
    }
    if ($("lsDawSlipFwdBtn")) {
      $("lsDawSlipFwdBtn").onclick = (ev) => {
        if (!selectedClipId || typeof Engine.slipClip !== "function") return;
        const delta = ev.shiftKey ? 0.25 : 0.05;
        if (Engine.slipClip(state, selectedClipId, delta)) updateAllDawUi();
      };
    }
    if ($("lsDawNudgeBackBtn")) {
      $("lsDawNudgeBackBtn").onclick = (ev) => {
        if (!selectedClipId || typeof Engine.nudgeClip !== "function") return;
        const delta = ev.shiftKey ? -0.25 : -0.025;
        if (Engine.nudgeClip(state, selectedClipId, delta)) {
          updateAllDawUi();
        }
      };
    }
    if ($("lsDawNudgeFwdBtn")) {
      $("lsDawNudgeFwdBtn").onclick = (ev) => {
        if (!selectedClipId || typeof Engine.nudgeClip !== "function") return;
        const delta = ev.shiftKey ? 0.25 : 0.025;
        if (Engine.nudgeClip(state, selectedClipId, delta)) {
          updateAllDawUi();
        }
      };
    }
    if ($("lsDawNormClipBtn")) {
      $("lsDawNormClipBtn").onclick = () => {
        if (!selectedClipId || typeof Engine.normalizeClip !== "function") return;
        const clip = state.clips.find((c) => c.id === selectedClipId);
        const src = clip ? sourceBuffers[clip.sourceId] : null;
        if (!clip || !src) return;
        const buf = src.stereo || src.ch1 || src.ch2;
        if (!buf) return;
        const data = buf.getChannelData(0);
        const s0 = Math.max(0, Math.floor(clip.sourceStart * buf.sampleRate));
        const s1 = Math.min(data.length, Math.ceil(clip.sourceEnd * buf.sampleRate));
        const slice = data.subarray(s0, s1);
        const peakDb = Dsp && typeof Dsp.measureTruePeakDb === "function"
          ? Dsp.measureTruePeakDb(slice)
          : -6;
        if (Engine.normalizeClip(state, clip.id, -1.0, peakDb)) {
          updateAllDawUi();
          setStatusNotice(`Normalized "${clip.label}" to -1.0 dBTP (${clip.gainDb > 0 ? "+" : ""}${clip.gainDb.toFixed(1)} dB).`, false);
        }
      };
    }
    if ($("lsDawAutoToggleBtn")) {
      $("lsDawAutoToggleBtn").onclick = () => {
        showAutomation = !showAutomation;
        updateAllDawUi();
      };
    }
    if ($("lsDawAutoLaneSelect")) {
      $("lsDawAutoLaneSelect").onchange = function () {
        activeAutoLane = this.value || "gain";
        if (!showAutomation) showAutomation = true;
        updateAllDawUi();
      };
    }
    if ($("lsDawAutoClearBtn")) {
      $("lsDawAutoClearBtn").onclick = () => {
        if (typeof Engine.clearAutomationLane === "function" && Engine.clearAutomationLane(state, state.selectedTrackId, activeAutoLane)) {
          updateAllDawUi();
          setStatusNotice(`Cleared ${activeAutoLane} automation points on selected track.`, false);
        }
      };
    }
    if ($("lsDawHistoryBtn")) {
      $("lsDawHistoryBtn").onclick = (ev) => {
        ev.stopPropagation();
        historyMenuOpen = !historyMenuOpen;
        renderHistoryMenu();
      };
      document.addEventListener("click", (ev) => {
        if (historyMenuOpen && !ev.target.closest(".ls-daw-history-wrap")) {
          historyMenuOpen = false;
          renderHistoryMenu();
        }
      });
    }
    if ($("lsDawRulerModeSelect")) {
      $("lsDawRulerModeSelect").onchange = function () {
        if (typeof Engine.setTimelineConfig === "function") {
          Engine.setTimelineConfig(state, { rulerMode: this.value });
          updateAllDawUi();
        }
      };
    }
    if ($("lsDawBpmInput")) {
      $("lsDawBpmInput").onchange = function () {
        if (typeof Engine.setTimelineConfig === "function") {
          Engine.setTimelineConfig(state, { bpm: Number(this.value) || 96 });
          updateAllDawUi();
        }
      };
    }
    if ($("lsDawTrackHeightBtn")) {
      $("lsDawTrackHeightBtn").onclick = () => {
        laneHeightPx = laneHeightPx === 96 ? 132 : (laneHeightPx === 132 ? 74 : 96);
        updateAllDawUi();
      };
    }
    if ($("lsDawWaveScaleBtn")) {
      $("lsDawWaveScaleBtn").onclick = () => {
        waveScale = waveScale === 1 ? 2 : (waveScale === 2 ? 4 : 1);
        updateAllDawUi();
      };
    }
    if ($("lsDawSaveProjectBtn")) {
      $("lsDawSaveProjectBtn").onclick = async () => {
        if (typeof Engine.exportProjectManifest !== "function") return;
        const meta =
          window.LiveStudioBridge && typeof window.LiveStudioBridge.getSessionMeta === "function"
            ? window.LiveStudioBridge.getSessionMeta()
            : {};
        const sDate = meta.sessionDate || new Date().toISOString().slice(0, 10);
        const manifest = Engine.exportProjectManifest(state, meta);
        const projectUid = meta.projectUid || `proj_${sDate}_${Date.now()}`;
        manifest.projectUid = projectUid;
        try {
          window.localStorage.setItem(`bp_daw_project_${sDate}`, JSON.stringify(manifest));
        } catch (_) { }
        let savedLocal = false;
        if (window.LiveStudioRecorder && typeof window.LiveStudioRecorder.saveArtifactFile === "function") {
          savedLocal = await window.LiveStudioRecorder.saveArtifactFile("project.json", JSON.stringify(manifest, null, 2)).catch(() => false);
        }
        if (typeof navigator !== "undefined" && navigator.onLine === false) {
          setStatusNotice(`Saved Studio Project locally (${savedLocal ? "SSD + browser cache" : "browser cache"}; offline mode).`, false);
          return;
        }
        try {
          const csrfMeta = document.querySelector('meta[name="csrf-token"]');
          const headers = { "Content-Type": "application/json" };
          if (csrfMeta) headers["X-CSRF-Token"] = csrfMeta.content;
          const res = await fetch("/api/admin/live-stream/projects", {
            method: "POST",
            credentials: "same-origin",
            headers,
            body: JSON.stringify({
              projectUid,
              sessionDate: sDate,
              title: meta.title || `Studio Project ${sDate}`,
              manifest
            })
          });
          const data = await res.json();
          if (!res.ok || !data.success) throw new Error(data.error || "Save project failed");
          setStatusNotice(`Saved Studio Project "${manifest.projectUid}" to DB & local folder.`, false);
        } catch (err) {
          setStatusNotice(`Saved locally; DB sync pending (${err.message}).`, false);
        }
      };
    }
    async function hydrateAndApplyManifest(manifest, sDate, originLabel) {
      if (!manifest || typeof Engine.importProjectManifest !== "function") return false;
      Engine.importProjectManifest(state, manifest);
      if (Object.keys(sourceBuffers).length === 0 && window.LiveStudioRecorder && typeof window.LiveStudioRecorder.readFileFromSessionDir === "function") {
        const ch1Name = manifest.localFiles?.ch1Dry || "Ch1_Vocals_DRY.wav";
        const ch2Name = manifest.localFiles?.ch2Dry || "Ch2_Instruments_DRY.wav";
        const [f1, f2] = await Promise.all([
          window.LiveStudioRecorder.readFileFromSessionDir(ch1Name),
          window.LiveStudioRecorder.readFileFromSessionDir(ch2Name)
        ]);
        if (f1 || f2) {
          const oldClips = state.clips;
          await loadDualStemFiles(f1, f2, `${sDate} Recording`);
          if (oldClips.length > 0) state.clips = oldClips;
        }
      }
      updateAllDawUi();
      setStatusNotice(`Loaded Studio Project (${originLabel}) for ${sDate}.`, false);
      return true;
    }

    if ($("lsDawLoadProjectBtn")) {
      $("lsDawLoadProjectBtn").onclick = async () => {
        const sDate =
          (window.LiveStudioBridge && window.LiveStudioBridge.getSessionDate()) ||
          new Date().toISOString().slice(0, 10);
        try {
          let manifest = null;
          let originLabel = "DB";
          if (typeof navigator === "undefined" || navigator.onLine !== false) {
            try {
              const res = await fetch(`/api/admin/live-stream/projects/${encodeURIComponent(sDate)}`, { credentials: "same-origin" });
              const data = await res.json();
              if (res.ok && data.success && data.project) {
                manifest = typeof data.project.manifestJson === "string"
                  ? JSON.parse(data.project.manifestJson)
                  : data.project.manifest;
              }
            } catch (_) { }
          }
          if (!manifest && window.LiveStudioRecorder && typeof window.LiveStudioRecorder.readFileFromSessionDir === "function") {
            const pjFile = await window.LiveStudioRecorder.readFileFromSessionDir("project.json");
            if (pjFile) {
              manifest = JSON.parse(await pjFile.text());
              originLabel = "Local SSD";
            }
          }
          if (!manifest) {
            const cachedRaw = window.localStorage.getItem(`bp_daw_project_${sDate}`);
            if (cachedRaw) {
              manifest = JSON.parse(cachedRaw);
              originLabel = "Local Cache";
            }
          }
          if (!manifest) throw new Error(`No saved studio project found for ${sDate}`);
          await hydrateAndApplyManifest(manifest, sDate, originLabel);
        } catch (err) {
          setStatusNotice("Load project: " + err.message, true);
        }
      };
    }

    if ($("lsDawImportProjectInput")) {
      $("lsDawImportProjectInput").onchange = async function () {
        const file = this.files && this.files[0];
        if (!file) return;
        try {
          const manifest = JSON.parse(await file.text());
          await hydrateAndApplyManifest(manifest, manifest.sessionDate || "Local File", file.name);
        } catch (err) {
          setStatusNotice("Open project.json failed: " + err.message, true);
        } finally {
          this.value = "";
        }
      };
    }
    if ($("lsDawSplitBtn")) {
      $("lsDawSplitBtn").onclick = () => {
        if (Engine.splitAt(state, playheadSec, state.selectedTrackId)) {
          updateAllDawUi();
        } else {
          setStatusNotice("Move the playhead inside a clip away from edges to split.", true);
        }
      };
    }
    if ($("lsDawSetInBtn")) {
      $("lsDawSetInBtn").onclick = () => {
        selectionStart = playheadSec;
        if (selectionEnd == null || selectionEnd < selectionStart) {
          selectionEnd = selectionStart;
        }
        updateAllDawUi();
      };
    }
    if ($("lsDawSetOutBtn")) {
      $("lsDawSetOutBtn").onclick = () => {
        selectionEnd = playheadSec;
        if (selectionStart == null) selectionStart = 0;
        updateAllDawUi();
      };
    }
    if ($("lsDawRippleCutBtn")) {
      $("lsDawRippleCutBtn").onclick = () => {
        if (selectionStart == null || selectionEnd == null || Math.abs(selectionEnd - selectionStart) < 0.1) {
          setStatusNotice("Select a range on the waveform (drag or Set In/Out) to Ripple Cut.", true);
          return;
        }
        const a = Math.min(selectionStart, selectionEnd);
        const b = Math.max(selectionStart, selectionEnd);
        if (Engine.rippleDeleteRange(state, a, b, { joinCrossfadeSec: 0.25 })) {
          playheadSec = a;
          selectionStart = null;
          selectionEnd = null;
          pushMarkersToStudioBridge();
          updateAllDawUi();
          setStatusNotice(`Cut ${(b - a).toFixed(1)}s cleanly with 0.25s crossfade & updated timestamps.`, false);
        }
      };
    }
    if ($("lsDawDeleteClipBtn")) {
      $("lsDawDeleteClipBtn").onclick = () => {
        if (!selectedClipId) return;
        if (Engine.rippleDeleteClip(state, selectedClipId, { joinCrossfadeSec: 0.25 })) {
          selectedClipId = state.clips[0] ? state.clips[0].id : null;
          pushMarkersToStudioBridge();
          updateAllDawUi();
        }
      };
    }
    if ($("lsDawAddMarkerBtn")) {
      $("lsDawAddMarkerBtn").onclick = () => {
        const title = window.prompt("Bhajan Title at current playhead:", "");
        if (!title || !title.trim()) return;
        const singer = window.prompt("Singer Name:", "Samiti Singer") || "Samiti Singer";
        Engine.addMarker(state, {
          bhajan_title: title.trim(),
          singer_name: singer.trim(),
          start_seconds: playheadSec
        });
        pushMarkersToStudioBridge();
        updateAllDawUi();
      };
    }
    if ($("lsDawUndoBtn")) {
      $("lsDawUndoBtn").onclick = () => {
        if (Engine.undo(state)) {
          pushMarkersToStudioBridge();
          if (isPlaying) startPreviewPlayback();
          updateAllDawUi();
        }
      };
    }
    if ($("lsDawRedoBtn")) {
      $("lsDawRedoBtn").onclick = () => {
        if (Engine.redo(state)) {
          pushMarkersToStudioBridge();
          if (isPlaying) startPreviewPlayback();
          updateAllDawUi();
        }
      };
    }
    if ($("lsDawZoomInBtn")) {
      $("lsDawZoomInBtn").onclick = () => {
        zoomLevel = Math.min(20, Math.round(zoomLevel * 1.6 * 10) / 10);
        drawCanvas();
      };
    }
    if ($("lsDawZoomOutBtn")) {
      $("lsDawZoomOutBtn").onclick = () => {
        zoomLevel = Math.max(1, Math.round((zoomLevel / 1.6) * 10) / 10);
        drawCanvas();
      };
    }
    if ($("lsDawZoomFitBtn")) {
      $("lsDawZoomFitBtn").onclick = () => {
        zoomLevel = 1;
        drawCanvas();
      };
    }

    // Clip inspector inputs
    function bindInspectorSlider(elId, valId, suffix, prop) {
      const el = $(elId);
      const val = $(valId);
      if (!el) return;
      el.oninput = function () {
        if (!selectedClipId) return;
        const v = Number(this.value);
        if (val) val.textContent = `${v}${suffix}`;
        Engine.updateClipProps(state, selectedClipId, { [prop]: v });
        drawCanvas();
      };
    }
    bindInspectorSlider("lsDawClipGain", "lsDawClipGainVal", " dB", "gainDb");
    bindInspectorSlider("lsDawClipFadeIn", "lsDawClipFadeInVal", "s", "fadeInSec");
    bindInspectorSlider("lsDawClipFadeOut", "lsDawClipFadeOutVal", "s", "fadeOutSec");
    bindInspectorSlider("lsDawClipCrossfade", "lsDawClipCrossfadeVal", "s", "crossfadePrevSec");

    if ($("lsDawApplyTrimBtn")) {
      $("lsDawApplyTrimBtn").onclick = () => {
        if (!selectedClipId) return;
        const ns = Number($("lsDawTrimStart")?.value);
        const ne = Number($("lsDawTrimEnd")?.value);
        if (Engine.trimClip(state, selectedClipId, { newSourceStart: ns, newSourceEnd: ne })) {
          pushMarkersToStudioBridge();
          updateAllDawUi();
        }
      };
    }

    if ($("lsDawMasterTrimInput")) {
      $("lsDawMasterTrimInput").oninput = function () {
        const trimVal = Number(this.value) || 0;
        if (state.masterTrack) {
          Engine.updateTrackProps(state, "master", { inputTrimDb: trimVal });
        }
        if ($("lsDawMasterTrimVal")) {
          $("lsDawMasterTrimVal").textContent = `${trimVal > 0 ? "+" : ""}${trimVal} dB`;
        }
        syncLivePreviewTracks();
      };
    }
    if ($("lsDawLufsSelect")) {
      $("lsDawLufsSelect").onchange = function () {
        if ($("lsDawCustomLufsWrap")) {
          $("lsDawCustomLufsWrap").style.display = this.value === "custom" ? "inline-flex" : "none";
        }
      };
    }
    if ($("lsDawAnalyzeMixBtn")) {
      $("lsDawAnalyzeMixBtn").onclick = () => analyzeMixOffline();
    }
    if ($("lsDawRenderBtn")) {
      $("lsDawRenderBtn").onclick = () => renderEditedMixToMp3(false);
    }
    if ($("lsDawRenderPublishBtn")) {
      $("lsDawRenderPublishBtn").onclick = () => renderEditedMixToMp3(true);
    }

    window.LiveStudioDaw = {
      openFromRecording: async function (recResult) {
        switchStudioTab("daw");
        pullMarkersFromStudioBridge();
        state.clips = [];
        if (recResult && (recResult.dryCh1File || recResult.dryCh2File)) {
          await loadDualStemFiles(
            recResult.dryCh1File,
            recResult.dryCh2File,
            `${recResult.sessionDate} Recording`
          );
        } else if (recResult && recResult.masterFile) {
          await loadSingleAudioFile(recResult.masterFile, false, null);
        }
      },
      syncMarkersFromBridge: function () {
        pullMarkersFromStudioBridge();
        drawCanvas();
      },
      switchTab: switchStudioTab
    };

    document.addEventListener("keydown", (ev) => {
      const pane = $("lsTabDawPane");
      if (!pane || pane.style.display === "none") return;
      const tag = ev.target && ev.target.tagName ? ev.target.tagName.toUpperCase() : "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || ev.target?.isContentEditable) {
        return;
      }

      const key = String(ev.key || "").toLowerCase();
      const hasCtrl = Boolean(ev.ctrlKey || ev.metaKey);

      if (hasCtrl && !ev.shiftKey && key === "z") {
        ev.preventDefault();
        $("lsDawUndoBtn")?.click();
      } else if ((hasCtrl && key === "y") || (hasCtrl && ev.shiftKey && key === "z")) {
        ev.preventDefault();
        $("lsDawRedoBtn")?.click();
      } else if (hasCtrl && key === "d") {
        ev.preventDefault();
        $("lsDawDupClipBtn")?.click();
      } else if (hasCtrl && key === "a") {
        ev.preventDefault();
        selectedClipIds.clear();
        state.clips.forEach((c) => selectedClipIds.add(c.id));
        if (state.clips[0]) selectedClipId = state.clips[0].id;
        drawCanvas();
      } else if (hasCtrl && key === "x") {
        ev.preventDefault();
        $("lsDawCutClipBtn")?.click();
      } else if (hasCtrl && key === "c" && selectedClipId && typeof Engine.copyClips === "function") {
        ev.preventDefault();
        $("lsDawCopyClipBtn")?.click();
      } else if (hasCtrl && key === "v" && (clipboardClips.length > 0 || (state.clipboard && state.clipboard.length > 0)) && typeof Engine.pasteClips === "function") {
        ev.preventDefault();
        $("lsDawPasteClipBtn")?.click();
      } else if (hasCtrl && key === "s") {
        ev.preventDefault();
        $("lsDawSaveProjectBtn")?.click();
      } else if (!hasCtrl && ev.code === "Space") {
        ev.preventDefault();
        $("lsDawPlayBtn")?.click();
      } else if (!hasCtrl && key === "s") {
        ev.preventDefault();
        $("lsDawSplitBtn")?.click();
      } else if (!hasCtrl && key === "j") {
        ev.preventDefault();
        $("lsDawJoinClipsBtn")?.click();
      } else if (!hasCtrl && key === "l") {
        ev.preventDefault();
        $("lsDawLoopBtn")?.click();
      } else if (!hasCtrl && key === "i") {
        ev.preventDefault();
        $("lsDawSetInBtn")?.click();
      } else if (!hasCtrl && key === "o") {
        ev.preventDefault();
        $("lsDawSetOutBtn")?.click();
      } else if (!hasCtrl && ev.key === "[") {
        ev.preventDefault();
        $("lsDawPrevMarkerBtn")?.click();
      } else if (!hasCtrl && ev.key === "]") {
        ev.preventDefault();
        $("lsDawNextMarkerBtn")?.click();
      } else if (!hasCtrl && (ev.key === "Delete" || ev.key === "Backspace")) {
        ev.preventDefault();
        if (selectionStart != null && selectionEnd != null && Math.abs(selectionEnd - selectionStart) >= 0.1) {
          $("lsDawRippleCutBtn")?.click();
        } else {
          $("lsDawDeleteClipBtn")?.click();
        }
      } else if (!hasCtrl && key === "m") {
        ev.preventDefault();
        $("lsDawTrack1Mute")?.click();
        $("lsDawTrack2Mute")?.click();
      }
    });

    const viewBtns = document.querySelectorAll("#lsDawWorkspaceViewBar [data-daw-view-btn]");
    viewBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        const view = btn.dataset.dawViewBtn || "all";
        viewBtns.forEach((b) => b.classList.toggle("is-active", b === btn));
        const fxPanel = $("lsDawFxRackPanel");
        const bottomDock = document.querySelector(".ls-daw-bottom-dock");
        if (fxPanel) fxPanel.classList.toggle("ls-is-hidden", view === "master");
        if (bottomDock) bottomDock.classList.toggle("ls-is-hidden", view === "fx");
        if (view !== "master") renderFxRack();
      });
    });

    const refreshDawTheme = () => {
      window.requestAnimationFrame(() => {
        renderTrackHeaders();
        renderFxRack();
        drawCanvas();
      });
    };
    window.addEventListener("themechange", refreshDawTheme);
    window.addEventListener("resize", refreshDawTheme);
    if (typeof MutationObserver === "function") {
      const themeObs = new MutationObserver(refreshDawTheme);
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

    updateAllDawUi();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wireDawEvents);
  } else {
    wireDawEvents();
  }
})(window, document);
