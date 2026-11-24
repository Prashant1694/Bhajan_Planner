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
  let selectedClipId = null;
  let selectedFxSlotId = null;
  let pendingLoadTrackId = null;
  let selectionStart = null;
  let selectionEnd = null;

  let lastRenderedMp3Url = null;
  let lastRenderedFile = null;
  let isRendering = false;
  let isDraggingSelection = false;
  let dragAnchorSec = 0;

  function $(id) {
    return document.getElementById(id);
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

  function setStatusNotice(text, isError) {
    const el = $("lsDawStatusText");
    if (!el) return;
    el.textContent = text || "";
    el.style.color = isError ? "#dc2626" : "var(--muted, #78716c)";
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

      sourceBuffers[srcId] = {
        hasTwoTracks: true,
        ch1: buf1,
        ch2: buf2,
        stereo: null,
        duration: dur,
        sampleRate: primary.sampleRate,
        peaks1: extractPeaks(buf1 ? buf1.getChannelData(0) : new Float32Array(0)),
        peaks2: extractPeaks(buf2 ? buf2.getChannelData(0) : new Float32Array(0))
      };

      const clip = Engine.appendClip(state, {
        sourceId: srcId,
        label: label || "Recorded Session",
        duration: dur
      });
      selectedClipId = clip.id;
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

      sourceBuffers[srcId] = {
        hasTwoTracks: false,
        ch1: null,
        ch2: null,
        stereo: audioBuf,
        duration: audioBuf.duration,
        sampleRate: audioBuf.sampleRate,
        peaks1: extractPeaks(leftData),
        peaks2: extractPeaks(rightData)
      };

      const clip = Engine.appendClip(state, {
        sourceId: srcId,
        trackId: targetTrackId || null,
        timelineOffsetSec: targetTrackId ? 0 : null,
        label: file.name.replace(/\.[^.]+$/, ""),
        duration: audioBuf.duration,
        crossfadePrevSec: appendMode && !targetTrackId ? 0.3 : 0
      });
      selectedClipId = clip.id;
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
      } catch (_) {}
    });
    activePreviewNodes = [];
    activePreviewGraph = null;
    const playBtn = $("lsDawPlayBtn");
    if (playBtn) playBtn.textContent = "Play";
    drawCanvas();
  }

  /**
   * Build the complete multi-track Web Audio routing graph with per-track Gain, Pan,
   * custom modular FX chains, optional Live Studio FX bus, and Master Bus FX rack.
   * Works seamlessly in both AudioContext (live preview) and OfflineAudioContext (MP3 render).
   */
  function buildDawAudioGraph(ctx) {
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

    const masterOut = ctx.createGain();
    masterOut.gain.value = Math.max(0, Number(state.masterTrack?.gain ?? 100) / 100);

    if (studioDsp && masterChain) {
      studioDsp.output.connect(masterChain.input);
      masterChain.output.connect(masterOut).connect(ctx.destination);
    } else if (studioDsp) {
      studioDsp.output.connect(masterOut).connect(ctx.destination);
    } else if (masterChain) {
      masterChain.output.connect(masterOut).connect(ctx.destination);
    } else {
      masterOut.connect(ctx.destination);
    }

    const trackBuses = new Map();
    const roleTrackMap = {};

    state.tracks.forEach((tr) => {
      const inNode = ctx.createGain();
      const gainNode = ctx.createGain();
      gainNode.gain.value = getTrackGainValue(tr, anySolo);

      const pannerNode = typeof ctx.createStereoPanner === "function" ? ctx.createStereoPanner() : null;
      if (pannerNode) {
        pannerNode.pan.value = Math.max(-1, Math.min(1, Number(tr.pan || 0) / 100));
      }

      const fxChain = Dsp ? Dsp.buildModularFxChain(ctx, tr.fxRack || []) : null;

      let destTarget;
      if (studioDsp) {
        if (tr.role === "ch1") destTarget = studioDsp.instIn;
        else if (tr.role === "ch2") destTarget = studioDsp.vocalIn;
        else destTarget = studioDsp.stereoIn;
      } else if (masterChain) {
        destTarget = masterChain.input;
      } else {
        destTarget = masterOut;
      }

      let cursor = inNode.connect(gainNode);
      if (pannerNode) cursor = cursor.connect(pannerNode);
      if (fxChain) {
        cursor.connect(fxChain.input);
        fxChain.output.connect(destTarget);
      } else {
        cursor.connect(destTarget);
      }

      const bus = { id: tr.id, inNode, gainNode, pannerNode, fxChain };
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
      masterOut
    };
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

      gainNode.connect(targetNode);
      return gainNode;
    }

    if (c.trackId) {
      const targetBus = graph.trackBuses.get(c.trackId) || graph.ch1Bus;
      if (!targetBus) return created;
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
      if (srcBufObj.ch1 && graph.ch1Bus) {
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
      if (srcBufObj.ch2 && graph.ch2Bus) {
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
    } else if (srcBufObj.stereo && graph.ch1Bus) {
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
    if (playheadSec >= layout.totalDuration - 0.05) {
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
    if (playBtn) playBtn.textContent = "Pause";

    const tick = () => {
      if (!isPlaying || !previewCtx) return;
      const elapsed = Math.max(0, previewCtx.currentTime - playStartCtxTime);
      playheadSec = Math.min(layout.totalDuration, playStartTimelineSec + elapsed);
      updateTransportReadout(layout.totalDuration);
      drawCanvas();
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

  function renderTrackHeaders() {
    const container = $("lsDawTrackHeaders");
    if (!container || !state) return;
    container.innerHTML = "";

    state.tracks.forEach((tr, idx) => {
      const box = document.createElement("div");
      box.className = `ls-daw-track-box${state.selectedTrackId === tr.id ? " is-selected" : ""}`;
      box.style.borderLeftColor = tr.color || "#d97706";
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

      const gainInput = document.createElement("input");
      gainInput.type = "range";
      gainInput.className = "ls-range";
      if (idx === 0) gainInput.id = "lsDawTrack1Gain";
      else if (idx === 1) gainInput.id = "lsDawTrack2Gain";
      gainInput.min = "0";
      gainInput.max = "180";
      gainInput.value = String(tr.gain ?? 100);
      gainInput.title = `${tr.name} Volume (${tr.gain ?? 100}%)`;
      gainInput.oninput = function () {
        Engine.updateTrackProps(state, tr.id, { gain: Number(this.value) });
        this.title = `${tr.name} Volume (${tr.gain}%)`;
        syncLivePreviewTracks();
      };

      const panInput = document.createElement("input");
      panInput.type = "range";
      panInput.className = "ls-range";
      panInput.min = "-100";
      panInput.max = "100";
      panInput.value = String(tr.pan ?? 0);
      panInput.title = `Pan: ${tr.pan === 0 ? "Center" : tr.pan > 0 ? `${tr.pan}% R` : `${Math.abs(tr.pan)}% L`}`;
      panInput.oninput = function () {
        Engine.updateTrackProps(state, tr.id, { pan: Number(this.value) });
        this.title = `Pan: ${tr.pan === 0 ? "Center" : tr.pan > 0 ? `${tr.pan}% R` : `${Math.abs(tr.pan)}% L`}`;
        syncLivePreviewTracks();
      };

      sliders.appendChild(gainInput);
      sliders.appendChild(panInput);
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
        muteBtn.classList.toggle("is-muted-active", tr.mute);
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
        soloBtn.classList.toggle("is-solo-active", tr.solo);
        syncLivePreviewTracks();
      };

      const loadBtn = document.createElement("button");
      loadBtn.type = "button";
      loadBtn.className = "ls-btn-mini";
      loadBtn.textContent = "+ Audio";
      loadBtn.title = `Load an audio clip onto ${tr.name}`;
      loadBtn.onclick = (ev) => {
        ev.stopPropagation();
        pendingLoadTrackId = tr.id;
        $("lsDawTrackFileInput")?.click();
      };

      leftBtns.appendChild(muteBtn);
      leftBtns.appendChild(soloBtn);
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
    const ctx = canvas.getContext("2d");
    const w = canvas.width || 520;
    const h = canvas.height || 124;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#171411";
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    [0.2, 0.5, 0.8].forEach((r) => {
      const y = Math.round(h * r) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    });

    const minF = 20;
    const maxF = 18000;
    const logRange = Math.log10(maxF / minF);
    const freqToX = (f) => (Math.log10(Math.max(minF, Math.min(maxF, f)) / minF) / logRange) * w;

    ctx.fillStyle = "rgba(214,211,209,0.5)";
    ctx.font = "600 9.5px Inter, system-ui, sans-serif";
    [80, 250, 1000, 3500, 10000].forEach((f) => {
      const x = Math.round(freqToX(f)) + 0.5;
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x + 3, h - 4);
    });

    const pts = Dsp.computeEqCurvePoints({
      b80: params.b80 || 0,
      b250: params.b250 || 0,
      b1k: params.b1k || 0,
      b3k5: params.b3k5 || 0,
      b10k: params.b10k || 0,
      bypass: Boolean(isDisabled)
    });

    // Translucent amber area fill + EQ spline curve
    const xy = pts.map((pt) => ({
      x: freqToX(pt.freq),
      y: h * 0.5 - (Math.max(-15, Math.min(15, pt.db)) / 15) * (h * 0.38)
    }));
    if (xy.length > 0 && !isDisabled) {
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, "rgba(251, 191, 36, 0.24)");
      grad.addColorStop(0.5, "rgba(245, 158, 11, 0.08)");
      grad.addColorStop(1, "rgba(245, 158, 11, 0.01)");
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
      ctx.strokeStyle = "#78716c";
    } else {
      ctx.strokeStyle = "#fbbf24";
    }
    ctx.lineWidth = 2.2;
    ctx.stroke();
    ctx.restore();

    // Draw band nodes at 80, 250, 1k, 3.5k, 10k
    [
      { freq: 80, val: Number(params.b80) || 0 },
      { freq: 250, val: Number(params.b250) || 0 },
      { freq: 1000, val: Number(params.b1k) || 0 },
      { freq: 3500, val: Number(params.b3k5) || 0 },
      { freq: 10000, val: Number(params.b10k) || 0 }
    ].forEach((b) => {
      const x = freqToX(b.freq);
      const y = h * 0.5 - (Math.max(-15, Math.min(15, b.val)) / 15) * (h * 0.38);
      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = isDisabled ? "#78716c" : "#f59e0b";
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.2;
      ctx.stroke();
    });
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
    handle.updateParams(slot.params);
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
    const head = document.createElement("div");
    head.className = "ls-channel-head";
    head.innerHTML = `
      <div>
        <div class="ls-channel-name">${def.name} · ${track.name}</div>
        <div class="ls-channel-tag">${slot.enabled !== false ? "Active in track chain" : "Bypassed"}</div>
      </div>
    `;

    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "ls-btn-mini";
    resetBtn.textContent = "Reset Default";
    resetBtn.onclick = () => {
      Engine.updateTrackFxParams(state, track.id, slot.id, def.defaultParams, { recordUndo: true });
      pushLiveFxUpdate(track.id, slot);
      renderFxEditor(track, slot);
    };
    head.appendChild(resetBtn);
    pane.appendChild(head);

    if (slot.type === "eq") {
      const wrap = document.createElement("div");
      wrap.className = "ls-fx-eq-canvas-wrap";
      const eqCanvas = document.createElement("canvas");
      eqCanvas.id = "lsDawTrackEqCanvas";
      eqCanvas.width = 520;
      eqCanvas.height = 124;
      wrap.appendChild(eqCanvas);
      pane.appendChild(wrap);

      if (def.presets) {
        const pRow = document.createElement("div");
        pRow.className = "ls-fx-preset-row";
        Object.keys(def.presets).forEach((pk) => {
          const p = def.presets[pk];
          const pBtn = document.createElement("button");
          pBtn.type = "button";
          pBtn.className = "ls-btn-mini";
          pBtn.textContent = p.label;
          pBtn.onclick = () => {
            Engine.updateTrackFxParams(state, track.id, slot.id, p.params, { recordUndo: true });
            pushLiveFxUpdate(track.id, slot);
            renderFxEditor(track, slot);
          };
          pRow.appendChild(pBtn);
        });
        pane.appendChild(pRow);
      }
    }

    def.controls.forEach((ctrl) => {
      const row = document.createElement("div");
      row.className = "ls-slider-row";
      row.style.gridTemplateColumns = "140px 1fr 64px";

      const lbl = document.createElement("span");
      lbl.className = "ls-slider-label";
      lbl.textContent = ctrl.label;

      const curVal = slot.params && slot.params[ctrl.key] !== undefined
        ? slot.params[ctrl.key]
        : def.defaultParams[ctrl.key];

      const inp = document.createElement("input");
      inp.type = "range";
      inp.className = "ls-range";
      inp.min = String(ctrl.min);
      inp.max = String(ctrl.max);
      inp.step = String(ctrl.step);
      inp.value = String(curVal);

      const valEl = document.createElement("span");
      valEl.className = "ls-slider-val";
      valEl.textContent = `${curVal}${ctrl.unit}`;

      inp.oninput = function () {
        const nextNum = Number(this.value);
        valEl.textContent = `${nextNum}${ctrl.unit}`;
        Engine.updateTrackFxParams(state, track.id, slot.id, { [ctrl.key]: nextNum });
        pushLiveFxUpdate(track.id, slot);
        if (slot.type === "eq") {
          drawTrackEqCurve(slot.params, slot.enabled === false);
        }
      };

      row.appendChild(lbl);
      row.appendChild(inp);
      row.appendChild(valEl);
      pane.appendChild(row);
    });

    if (slot.type === "eq") {
      drawTrackEqCurve(slot.params, slot.enabled === false);
    }
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

      const nameEl = document.createElement("div");
      nameEl.className = "ls-fx-slot-name";
      nameEl.textContent = `${idx + 1}. ${slot.name}`;

      const btns = document.createElement("div");
      btns.className = "ls-btn-row";
      btns.style.gap = "3px";

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

  function drawWaveformChannel(ctx, peaks, clip, srcDuration, clipX, clipY, clipW, clipH, color) {
    if (!peaks || !peaks.max || peaks.max.length === 0 || clipW <= 1) return;
    const totalBuckets = peaks.max.length;
    const startBucket = Math.max(0, Math.floor((clip.sourceStart / srcDuration) * totalBuckets));
    const endBucket = Math.min(totalBuckets, Math.ceil((clip.sourceEnd / srcDuration) * totalBuckets));
    const bucketSpan = Math.max(1, endBucket - startBucket);
    const gainScale = Math.pow(10, (Number(clip.gainDb) || 0) / 20);
    const midY = clipY + clipH / 2;
    const halfH = clipH * 0.44;

    ctx.fillStyle = color;
    const pxStep = 2;
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
      ctx.fillRect(clipX + px, midY - ampTop, pxStep - 0.3, barH);
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

    const layout = Engine.computeTimelineLayout(state.clips);
    const totalDur = Math.max(10, layout.totalDuration);
    const wrapW = Math.max(600, wrap.clientWidth - 2);
    const canvasW = Math.floor(wrapW * zoomLevel);
    const rulerH = 28;
    const laneH = 96;
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

    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    ctx.fillStyle = isDark ? "#171411" : "#f8f5f0";
    ctx.fillRect(0, 0, canvasW, canvasH);

    const pxPerSec = canvasW / totalDur;

    // Ruler
    ctx.fillStyle = isDark ? "#231e19" : "#eee8de";
    ctx.fillRect(0, 0, canvasW, rulerH);
    ctx.strokeStyle = isDark ? "#3f3830" : "#d6cfc2";
    ctx.beginPath();
    ctx.moveTo(0, rulerH);
    ctx.lineTo(canvasW, rulerH);
    ctx.stroke();

    // Time ticks
    let tickStep = 5;
    if (pxPerSec < 2) tickStep = 120;
    else if (pxPerSec < 5) tickStep = 60;
    else if (pxPerSec < 12) tickStep = 30;
    else if (pxPerSec < 25) tickStep = 10;

    ctx.fillStyle = isDark ? "#a8a29e" : "#57534e";
    ctx.font = "600 10.5px Inter, system-ui, sans-serif";
    for (let t = 0; t <= totalDur; t += tickStep) {
      const x = Math.round(t * pxPerSec) + 0.5;
      ctx.strokeStyle = isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.08)";
      ctx.beginPath();
      ctx.moveTo(x, rulerH);
      ctx.lineTo(x, canvasH);
      ctx.stroke();
      ctx.fillText(formatTimecode(t, false), x + 4, 18);
    }

    // Track Lane backgrounds
    const laneYById = {};
    tracks.forEach((tr, idx) => {
      const y = rulerH + idx * (laneH + laneGap) + 2;
      laneYById[tr.id] = y;
      const isSelectedLane = state.selectedTrackId === tr.id;
      ctx.fillStyle = isSelectedLane
        ? (isDark ? "#241f1a" : "#fffcf7")
        : (isDark ? "#1e1a16" : "#ffffff");
      ctx.fillRect(0, y, canvasW, laneH);
    });

    function drawClipBlockInLane(it, laneY, peaks, colorHex) {
      const c = it.clip;
      const src = sourceBuffers[c.sourceId];
      const x = it.timelineStart * pxPerSec;
      const w = Math.max(4, it.duration * pxPerSec);
      const isSel = c.id === selectedClipId;

      ctx.fillStyle = hexToRgba(colorHex, isDark ? 0.16 : 0.09);
      ctx.fillRect(x, laneY, w, laneH);
      ctx.fillStyle = hexToRgba(colorHex, isSel ? 0.95 : 0.72);
      ctx.fillRect(x, laneY, w, 3);
      ctx.strokeStyle = isSel ? "#ef4444" : (isDark ? "#3f3830" : "#cbd5e1");
      ctx.lineWidth = isSel ? 1.8 : 1;
      ctx.strokeRect(x + 0.5, laneY + 0.5, w - 1, laneH - 1);

      if (src && peaks) {
        drawWaveformChannel(ctx, peaks, c, src.duration, x, laneY, w, laneH, colorHex);
      }

      const fiPx = (Number(c.fadeInSec) || 0) * pxPerSec;
      if (fiPx > 2) {
        ctx.fillStyle = "rgba(0,0,0,0.14)";
        ctx.beginPath();
        ctx.moveTo(x, laneY);
        ctx.lineTo(x + fiPx, laneY);
        ctx.lineTo(x, laneY + laneH);
        ctx.closePath();
        ctx.fill();
      }
      const foPx = (Number(c.fadeOutSec) || 0) * pxPerSec;
      if (foPx > 2) {
        ctx.fillStyle = "rgba(0,0,0,0.14)";
        ctx.beginPath();
        ctx.moveTo(x + w - foPx, laneY);
        ctx.lineTo(x + w, laneY);
        ctx.lineTo(x + w, laneY + laneH);
        ctx.closePath();
        ctx.fill();
      }

      ctx.fillStyle = isDark ? "#f5f5f4" : "#1c1917";
      ctx.font = "700 11px Inter, system-ui, sans-serif";
      const tag = c.gainDb ? `${c.label} (${c.gainDb > 0 ? "+" : ""}${c.gainDb}dB)` : c.label;
      ctx.fillText(tag.slice(0, 32), x + 6, laneY + 14);
    }

    layout.items.forEach((it) => {
      const c = it.clip;
      const src = sourceBuffers[c.sourceId];
      if (!c.trackId) {
        const t1 = tracks.find((t) => t.role === "ch1") || tracks[0];
        const t2 = tracks.find((t) => t.role === "ch2") || tracks[1];
        if (t1 && laneYById[t1.id] != null) {
          drawClipBlockInLane(it, laneYById[t1.id], src && src.peaks1, t1.color || "#d97706");
        }
        if (t2 && laneYById[t2.id] != null && (!src || src.hasTwoTracks || src.peaks2)) {
          drawClipBlockInLane(it, laneYById[t2.id], src && (src.peaks2 || src.peaks1), t2.color || "#2563eb");
        }
      } else {
        const targetTrack = tracks.find((t) => t.id === c.trackId);
        if (targetTrack && laneYById[targetTrack.id] != null) {
          drawClipBlockInLane(it, laneYById[targetTrack.id], src && src.peaks1, targetTrack.color || "#16a34a");
        }
      }
    });

    // Selection overlay
    if (selectionStart != null && selectionEnd != null && Math.abs(selectionEnd - selectionStart) > 0.05) {
      const s0 = Math.min(selectionStart, selectionEnd) * pxPerSec;
      const sw = Math.abs(selectionEnd - selectionStart) * pxPerSec;
      ctx.fillStyle = "rgba(217, 119, 6, 0.22)";
      ctx.fillRect(s0, rulerH, sw, canvasH - rulerH);
      ctx.strokeStyle = "#d97706";
      ctx.lineWidth = 1.2;
      ctx.strokeRect(s0, rulerH, sw, canvasH - rulerH);
    }

    // Markers on ruler
    state.markers.forEach((m) => {
      const mx = m.start_seconds * pxPerSec;
      ctx.strokeStyle = "#16a34a";
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(mx, 0);
      ctx.lineTo(mx, canvasH);
      ctx.stroke();

      ctx.fillStyle = "#16a34a";
      ctx.fillRect(mx, 2, Math.min(110, Math.max(36, m.bhajan_title.length * 6.5)), 15);
      ctx.fillStyle = "#ffffff";
      ctx.font = "700 10px Inter, system-ui, sans-serif";
      ctx.fillText(m.bhajan_title.slice(0, 16), mx + 4, 13);
    });

    // Playhead
    const pxPlay = playheadSec * pxPerSec;
    ctx.strokeStyle = "#dc2626";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(pxPlay, 0);
    ctx.lineTo(pxPlay, canvasH);
    ctx.stroke();

    ctx.fillStyle = "#dc2626";
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
        selLabel.textContent = "Drag on waveform to select range to cut";
      }
    }

    if ($("lsDawDeleteTrackBtn")) {
      $("lsDawDeleteTrackBtn").disabled = !state.tracks || state.tracks.length <= 1 || state.selectedTrackId === "master";
    }
    if ($("lsDawUndoBtn")) $("lsDawUndoBtn").disabled = state.undoStack.length === 0;
    if ($("lsDawRedoBtn")) $("lsDawRedoBtn").disabled = state.redoStack.length === 0;
    if ($("lsDawRenderBtn")) $("lsDawRenderBtn").disabled = state.clips.length === 0 || isRendering;
    if ($("lsDawRenderPublishBtn")) {
      $("lsDawRenderPublishBtn").disabled = state.clips.length === 0 || isRendering;
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
    setStatusNotice("Rendering multitrack timeline & modular FX racks offline...", false);

    try {
      const sampleRate = 48000;
      const totalFrames = Math.ceil(layout.totalDuration * sampleRate);
      const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      const offline = new OfflineCtx(2, totalFrames, sampleRate);

      const graph = buildDawAudioGraph(offline);

      for (let i = 0; i < layout.items.length; i++) {
        const item = layout.items[i];
        const prevItem = i > 0 && !item.clip.trackId ? layout.items[i - 1] : null;
        const nextItem = i + 1 < layout.items.length && !item.clip.trackId ? layout.items[i + 1] : null;
        scheduleClipIntoContext(offline, graph, item, prevItem, nextItem, 0, 0);
      }

      if (progFill) progFill.style.width = "30%";
      const renderedBuffer = await offline.startRendering();
      const chL = renderedBuffer.getChannelData(0);
      const chR = renderedBuffer.numberOfChannels > 1 ? renderedBuffer.getChannelData(1) : chL;

      if ($("lsDawNoiseGateCheck")?.checked && Dsp) {
        Dsp.applyNoiseGateOffline(chL, sampleRate, -48);
        if (chR !== chL) {
          Dsp.applyNoiseGateOffline(chR, sampleRate, -48);
        }
      }

      const lufsChoice = $("lsDawLufsSelect")?.value || "-14";
      const reportEl = $("lsDawLoudnessReport");
      if (Dsp) {
        if (lufsChoice !== "off") {
          const norm = Dsp.normalizeToTargetLufs(
            chL,
            chR === chL ? null : chR,
            { targetLufs: Number(lufsChoice) || -14, ceilingDb: -1.0, sampleRate }
          );
          if (reportEl && Number.isFinite(norm.outputLufs)) {
            reportEl.textContent = `Mastered: ${norm.outputLufs.toFixed(1)} LUFS | Peak ${norm.peakDb.toFixed(1)} dBTP (${norm.gainDb >= 0 ? "+" : ""}${norm.gainDb.toFixed(1)} dB)`;
            reportEl.style.display = "inline-flex";
          }
        } else {
          const lufs = Dsp.measureIntegratedLufs(
            chL,
            chR === chL ? null : chR,
            sampleRate
          );
          if (reportEl && Number.isFinite(lufs)) {
            reportEl.textContent = `Unnormalized: ${lufs.toFixed(1)} LUFS`;
            reportEl.style.display = "inline-flex";
          }
        }
      }

      const kbps = Number($("lsPublishBitrateSelect")?.value || 112);
      setStatusNotice(`Encoding ${kbps} kbps stereo MP3 (${formatTimecode(layout.totalDuration)})...`, false);

      const mp3Chunks = [];
      const worker = new Worker("/js/live-stream-encoder-worker.js?v=1.0");
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
        worker.postMessage({ type: "init", channels: 2, sampleRate, kbps });

        (async () => {
          const blockSize = 11520;
          for (let offset = 0; offset < chL.length; offset += blockSize) {
            const len = Math.min(blockSize, chL.length - offset);
            const left = new Int16Array(len);
            const right = new Int16Array(len);
            for (let j = 0; j < len; j++) {
              let l = chL[offset + j];
              let r = chR[offset + j];
              if (l > 1) l = 1;
              else if (l < -1) l = -1;
              if (r > 1) r = 1;
              else if (r < -1) r = -1;
              left[j] = l < 0 ? (l * 32768) | 0 : (l * 32767) | 0;
              right[j] = r < 0 ? (r * 32768) | 0 : (r * 32767) | 0;
            }
            worker.postMessage({ type: "encode", left, right }, [left.buffer, right.buffer]);
            const pct = 35 + Math.round((offset / chL.length) * 60);
            if (progFill) progFill.style.width = `${pct}%`;
            await new Promise((r) => setTimeout(r, 0));
          }
          worker.postMessage({ type: "flush" });
        })();
      });
      worker.terminate();

      if (progFill) progFill.style.width = "100%";
      const sDate =
        (window.LiveStudioBridge && window.LiveStudioBridge.getSessionDate()) ||
        new Date().toISOString().slice(0, 10);
      lastRenderedFile = new File(mp3Chunks, `${sDate}_Edited_${kbps}k.mp3`, {
        type: "audio/mpeg"
      });

      if (lastRenderedMp3Url) URL.revokeObjectURL(lastRenderedMp3Url);
      lastRenderedMp3Url = URL.createObjectURL(lastRenderedFile);
      const dlEl = $("lsDawDownloadRenderedBtn");
      if (dlEl) {
        dlEl.href = lastRenderedMp3Url;
        dlEl.download = lastRenderedFile.name;
        dlEl.style.display = "inline-flex";
      }

      pushMarkersToStudioBridge();
      if (window.LiveStudioBridge) {
        window.LiveStudioBridge.setReadyPublishFile(
          lastRenderedFile,
          Math.round(layout.totalDuration)
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

    const t1 = state.tracks[0];
    const t2 = state.tracks[1];
    if (t1) {
      t1.fxRack = [
        Engine.addTrackFx(state, t1.id, "filter", { hpfHz: cfg.inst?.hpf || 45, lpfHz: 18000 }),
        Engine.addTrackFx(state, t1.id, "eq", {
          b80: cfg.inst?.low || 0,
          b250: 0,
          b1k: cfg.inst?.mid || 0,
          b3k5: 0,
          b10k: cfg.inst?.high || 0
        })
      ].filter(Boolean);
    }
    if (t2) {
      t2.fxRack = [
        Engine.addTrackFx(state, t2.id, "filter", { hpfHz: cfg.vocal?.hpf || 85, lpfHz: 18000 }),
        Engine.addTrackFx(state, t2.id, "eq", {
          b80: cfg.vocal?.low || 0,
          b250: 0,
          b1k: 0,
          b3k5: cfg.vocal?.mid || 0,
          b10k: cfg.vocal?.high || 0
        }),
        Engine.addTrackFx(state, t2.id, "deesser", { cutDb: cfg.vocal?.deesser ?? 2.5 }),
        Engine.addTrackFx(state, t2.id, "compressor", {
          enabled: cfg.vocal?.comp !== false,
          threshold: -18,
          ratio: 3.5
        }),
        Engine.addTrackFx(state, t2.id, "reverb", {
          wet: cfg.reverb?.wet ?? 14,
          decay: cfg.reverb?.decay ?? 1.4
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
          ceilingDb: -1.5
        })
      ].filter(Boolean);
    }

    selectedFxSlotId = null;
    updateAllDawUi();
    if (isPlaying) startPreviewPlayback();
    setStatusNotice("Imported Tab 1 Live Mixer EQ, De-Esser, Reverb & Limiter chains into Track 1, Track 2 & Master Bus!", false);
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
        const idx = Math.floor((y - 28) / 100);
        if (idx >= 0 && idx < state.tracks.length) {
          return state.tracks[idx].id;
        }
        return null;
      }

      canvas.addEventListener("mousedown", (ev) => {
        const clickedTrack = clientYToTrackId(ev.clientY);
        if (clickedTrack && clickedTrack !== state.selectedTrackId) {
          Engine.selectTrack(state, clickedTrack);
          renderTrackHeaders();
          renderFxRack();
        }
        isDraggingSelection = true;
        dragAnchorSec = clientXToSec(ev.clientX);
        selectionStart = dragAnchorSec;
        selectionEnd = dragAnchorSec;
      });

      window.addEventListener("mousemove", (ev) => {
        if (!isDraggingSelection) return;
        selectionEnd = clientXToSec(ev.clientX);
        drawCanvas();
      });

      window.addEventListener("mouseup", (ev) => {
        if (!isDraggingSelection) return;
        isDraggingSelection = false;
        const upSec = clientXToSec(ev.clientX);
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
          if (hit) selectedClipId = hit.clip.id;
          if (isPlaying) startPreviewPlayback();
        } else {
          selectionStart = Math.min(dragAnchorSec, upSec);
          selectionEnd = Math.max(dragAnchorSec, upSec);
          playheadSec = selectionStart;
        }
        updateAllDawUi();
      });
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
      } else if (!hasCtrl && ev.code === "Space") {
        ev.preventDefault();
        $("lsDawPlayBtn")?.click();
      } else if (!hasCtrl && key === "s") {
        ev.preventDefault();
        $("lsDawSplitBtn")?.click();
      } else if (!hasCtrl && key === "i") {
        ev.preventDefault();
        $("lsDawSetInBtn")?.click();
      } else if (!hasCtrl && key === "o") {
        ev.preventDefault();
        $("lsDawSetOutBtn")?.click();
      } else if (!hasCtrl && key === "m") {
        ev.preventDefault();
        $("lsDawTrack1Mute")?.click();
        $("lsDawTrack2Mute")?.click();
      }
    });

    updateAllDawUi();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wireDawEvents);
  } else {
    wireDawEvents();
  }
})(window, document);
