/**
 * Non-Destructive Multitrack DAW Timeline, Tracks, Sample-Accurate Automation & Project Engine
 * Manages dynamic tracks, per-track/master modular FX racks, clips, splits, trims, slips,
 * nudges, snapping, clipboard copy/paste/duplicate, normalize, loop regions, automation lanes,
 * undo/redo history, synchronized bhajan markers, and complete project manifest serialization.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./live-stream-dsp"));
  } else {
    root.LiveStreamDawEngine = factory(root.LiveStreamDsp);
  }
})(typeof globalThis !== "undefined" ? globalThis : self, function (Dsp) {
  "use strict";

  const MAX_UNDO = 60;
  const TRACK_COLORS = ["#9333ea", "#2563eb", "#16a34a", "#d97706", "#0891b2", "#db2777", "#65a30d"];
  let nextClipCounter = 1;
  let nextMarkerCounter = 1;
  let nextTrackCounter = 3;
  let nextFxCounter = 1;
  let nextAutoCounter = 1;

  function genClipId() {
    return `clip-${Date.now().toString(36)}-${nextClipCounter++}`;
  }

  function genMarkerId() {
    return `mrk-${Date.now().toString(36)}-${nextMarkerCounter++}`;
  }

  function genTrackId() {
    return `track-${nextTrackCounter++}-${Date.now().toString(36)}`;
  }

  function genAutoId() {
    return `auto-${Date.now().toString(36)}-${nextAutoCounter++}`;
  }

  function cloneData(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function createFxSlotData(type, overrides) {
    if (Dsp && typeof Dsp.createDefaultFxSlot === "function") {
      return Dsp.createDefaultFxSlot(type, overrides);
    }
    return {
      id: `fx-${Date.now().toString(36)}-${nextFxCounter++}`,
      type,
      name: type,
      enabled: overrides?.enabled !== false,
      wetDry: overrides?.wetDry != null ? Number(overrides.wetDry) : 100,
      params: Object.assign({}, overrides?.params || overrides || {})
    };
  }

  const AUTOMATION_LANES = {
    gain: { key: "gain", label: "Track Volume (%)", min: 0, max: 180, defaultVal: 100, unit: "%" },
    pan: { key: "pan", label: "Stereo Pan", min: -100, max: 100, defaultVal: 0, unit: "" },
    clipGain: { key: "clipGain", label: "Clip Gain (dB)", min: -18, max: 12, defaultVal: 0, unit: " dB" },
    eqPresenceDb: { key: "eqPresenceDb", label: "EQ Presence 3.5k (dB)", min: -12, max: 12, defaultVal: 0, unit: " dB" },
    compThreshold: { key: "compThreshold", label: "Comp Threshold (dB)", min: -48, max: 0, defaultVal: -18, unit: " dB" },
    reverbSend: { key: "reverbSend", label: "Reverb Wet/Send (%)", min: 0, max: 100, defaultVal: 16, unit: "%" },
    fxWetDry: { key: "fxWetDry", label: "Plugin Rack Mix (%)", min: 0, max: 100, defaultVal: 100, unit: "%" }
  };

  function createDefaultAutomation() {
    const out = {};
    Object.keys(AUTOMATION_LANES).forEach((k) => { out[k] = []; });
    return out;
  }

  function quantizeToSample(sec, state) {
    const sr = Math.max(8000, Number(state && state.timelineConfig && state.timelineConfig.sampleRate) || 48000);
    return Math.round(Math.max(0, Number(sec) || 0) * sr) / sr;
  }

  function createDefaultTracks() {
    return [
      {
        id: "track-1",
        name: "Track 1 · Vocals",
        color: "#9333ea",
        role: "ch1",
        inputChannel: 1,
        gain: 100,
        pan: 0,
        mute: false,
        solo: false,
        frozen: false,
        groupId: null,
        fxRack: [],
        automation: createDefaultAutomation()
      },
      {
        id: "track-2",
        name: "Track 2 · Instruments",
        color: "#2563eb",
        role: "ch2",
        inputChannel: 2,
        gain: 100,
        pan: 0,
        mute: false,
        solo: false,
        frozen: false,
        groupId: null,
        fxRack: [],
        automation: createDefaultAutomation()
      }
    ];
  }

  function createDefaultMasterTrack() {
    return {
      id: "master",
      name: "Master Bus",
      color: "#dc2626",
      role: "master",
      gain: 100,
      inputTrimDb: 0,
      pan: 0,
      mute: false,
      solo: false,
      groupId: null,
      fxRack: [
        createFxSlotData("eq", { id: "fx-master-eq", name: "Corrective EQ", enabled: true, hpfHz: 28, hpfSlope: 24 }),
        createFxSlotData("compressor", {
          id: "fx-master-glue",
          name: "Bus Glue Compressor",
          threshold: -14,
          ratio: 2.0,
          knee: 14,
          attackMs: 22,
          releaseMs: 260,
          enabled: true
        }),
        createFxSlotData("eq", { id: "fx-master-tonal-eq", name: "Tonal Mastering EQ", enabled: false, linearPhase: 1 }),
        createFxSlotData("saturation", { id: "fx-master-sat", name: "Mastering Warmth", enabled: false, drive: 15, mix: 25, autoGain: 1 }),
        createFxSlotData("stereo_width", { id: "fx-master-width", name: "Stereo M/S Imager", enabled: false, widthPct: 108, bassMonoHz: 120 }),
        createFxSlotData("limiter", { id: "fx-master-lim", name: "True-Peak Brickwall Limiter", enabled: true, ceilingDb: -1.0, releaseMs: 80 })
      ],
      automation: createDefaultAutomation()
    };
  }

  function createDefaultTimelineConfig() {
    return { rulerMode: "time", bpm: 96, beatsPerBar: 4, sampleRate: 48000 };
  }

  function createInitialState() {
    return {
      sources: {},
      clips: [],
      markers: [],
      tracks: createDefaultTracks(),
      masterTrack: createDefaultMasterTrack(),
      selectedTrackId: "track-1",
      clipboard: [],
      loopRegion: { enabled: false, startSec: 0, endSec: 0 },
      snap: { gridEnabled: false, gridSec: 1.0, markersEnabled: true, toleranceSec: 0.35 },
      timelineConfig: createDefaultTimelineConfig(),
      undoStack: [],
      redoStack: []
    };
  }

  function ensureTrackState(state) {
    if (!Array.isArray(state.tracks) || state.tracks.length === 0) {
      state.tracks = createDefaultTracks();
    }
    state.tracks.forEach((tr) => {
      if (!tr.automation) tr.automation = createDefaultAutomation();
      Object.keys(AUTOMATION_LANES).forEach((k) => {
        if (!Array.isArray(tr.automation[k])) tr.automation[k] = [];
      });
      if (!Array.isArray(tr.fxRack)) tr.fxRack = [];
      if (tr.groupId === undefined) tr.groupId = null;
    });
    if (!state.masterTrack) {
      state.masterTrack = createDefaultMasterTrack();
    }
    if (state.masterTrack.inputTrimDb === undefined) {
      state.masterTrack.inputTrimDb = 0;
    }
    if (!state.masterTrack.automation) state.masterTrack.automation = createDefaultAutomation();
    Object.keys(AUTOMATION_LANES).forEach((k) => {
      if (!Array.isArray(state.masterTrack.automation[k])) state.masterTrack.automation[k] = [];
    });
    if (!state.selectedTrackId) {
      state.selectedTrackId = state.tracks[0].id;
    }
    if (!state.loopRegion) {
      state.loopRegion = { enabled: false, startSec: 0, endSec: 0 };
    }
    if (!state.snap) {
      state.snap = { gridEnabled: false, gridSec: 1.0, markersEnabled: true, toleranceSec: 0.35 };
    }
    if (!state.timelineConfig) {
      state.timelineConfig = createDefaultTimelineConfig();
    }
    if (!Array.isArray(state.clipboard)) {
      state.clipboard = [];
    }
  }

  function pushUndo(state, label = "Edit") {
    ensureTrackState(state);
    state.undoStack.push({
      label: String(label || "Edit"),
      timestamp: Date.now(),
      clips: cloneData(state.clips),
      markers: cloneData(state.markers),
      tracks: cloneData(state.tracks),
      masterTrack: cloneData(state.masterTrack),
      selectedTrackId: state.selectedTrackId,
      loopRegion: cloneData(state.loopRegion)
    });
    if (state.undoStack.length > MAX_UNDO) {
      state.undoStack.shift();
    }
    state.redoStack = [];
  }

  function setTimelineConfig(state, patch = {}) {
    ensureTrackState(state);
    const cfg = state.timelineConfig;
    if (patch.rulerMode && ["time", "bars", "samples"].includes(patch.rulerMode)) {
      cfg.rulerMode = patch.rulerMode;
    }
    if (patch.bpm != null && Number.isFinite(Number(patch.bpm))) {
      cfg.bpm = Math.max(30, Math.min(240, Number(patch.bpm)));
    }
    if (patch.beatsPerBar != null && Number.isFinite(Number(patch.beatsPerBar))) {
      cfg.beatsPerBar = Math.max(2, Math.min(12, Math.round(Number(patch.beatsPerBar))));
    }
    if (patch.sampleRate != null && Number.isFinite(Number(patch.sampleRate))) {
      cfg.sampleRate = Math.max(44100, Math.min(96000, Math.round(Number(patch.sampleRate))));
    }
    return cfg;
  }

  function computeTimelineLayout(clips) {
    const items = [];
    let spineCursor = 0;
    let spineIndex = 0;
    const trackCursors = {};
    let maxEnd = 0;

    for (let i = 0; i < clips.length; i++) {
      const c = clips[i];
      const duration = Math.max(0.05, Number(c.sourceEnd || 0) - Number(c.sourceStart || 0));

      if (!c.trackId) {
        let effectiveCrossfade = 0;
        if (spineIndex > 0 && Number(c.crossfadePrevSec || 0) > 0) {
          const prevSpine = items.slice().reverse().find((it) => !it.clip.trackId);
          const prevDur = prevSpine ? prevSpine.duration : duration;
          effectiveCrossfade = Math.min(
            Number(c.crossfadePrevSec),
            prevDur * 0.45,
            duration * 0.45
          );
        }
        const timelineStart = Math.max(0, spineCursor - effectiveCrossfade);
        const timelineEnd = timelineStart + duration;
        spineCursor = timelineEnd;
        spineIndex += 1;
        if (timelineEnd > maxEnd) maxEnd = timelineEnd;

        items.push({
          clip: c,
          index: i,
          trackId: null,
          duration,
          effectiveCrossfade,
          timelineStart,
          timelineEnd
        });
      } else {
        const tid = c.trackId;
        const defaultStart = trackCursors[tid] || 0;
        const timelineStart = c.timelineOffsetSec != null
          ? Math.max(0, Number(c.timelineOffsetSec) || 0)
          : defaultStart;
        const timelineEnd = timelineStart + duration;
        trackCursors[tid] = Math.max(defaultStart, timelineEnd);
        if (timelineEnd > maxEnd) maxEnd = timelineEnd;

        items.push({
          clip: c,
          index: i,
          trackId: tid,
          duration,
          effectiveCrossfade: 0,
          timelineStart,
          timelineEnd
        });
      }
    }

    return {
      items,
      totalDuration: maxEnd
    };
  }

  function snapTime(state, rawSec, overrideOpts = {}) {
    const t = Math.max(0, Number(rawSec) || 0);
    ensureTrackState(state);
    const snap = Object.assign({}, state.snap, overrideOpts);
    const tol = Number(snap.toleranceSec) || 0.35;

    if (snap.markersEnabled && Array.isArray(state.markers)) {
      let bestMarker = null;
      let bestDist = tol;
      for (let i = 0; i < state.markers.length; i++) {
        const ms = Number(state.markers[i].start_seconds || 0);
        const dist = Math.abs(ms - t);
        if (dist <= bestDist) {
          bestDist = dist;
          bestMarker = ms;
        }
      }
      if (bestMarker !== null) return quantizeToSample(bestMarker, state);
    }

    if (snap.gridEnabled) {
      let g = overrideOpts.gridSec != null ? Number(overrideOpts.gridSec) : null;
      if (!(g > 0)) {
        if (state.timelineConfig && state.timelineConfig.rulerMode === "bars") {
          g = 60 / Math.max(30, Number(state.timelineConfig.bpm) || 96);
        } else {
          g = Number(snap.gridSec) || 1.0;
        }
      }
      if (g > 0) {
        return quantizeToSample(Math.round(t / g) * g, state);
      }
    }
    return quantizeToSample(t, state);
  }

  function addSource(state, { id, name, duration, sampleRate = 48000, hasTwoTracks = false }) {
    const srcId = id || `src-${Date.now().toString(36)}-${Object.keys(state.sources).length + 1}`;
    state.sources[srcId] = {
      id: srcId,
      name: String(name || "Audio Source"),
      duration: Math.max(0.1, Number(duration) || 0.1),
      sampleRate: Number(sampleRate) || 48000,
      hasTwoTracks: Boolean(hasTwoTracks)
    };
    return srcId;
  }

  function appendClip(state, { sourceId, label, duration, crossfadePrevSec = 0.25, trackId = null, timelineOffsetSec = null } = {}) {
    const src = state.sources[sourceId];
    const clipDur = src ? src.duration : Math.max(0.1, Number(duration) || 0.1);
    pushUndo(state, "Append Clip");

    const existingSpineCount = state.clips.filter((x) => !x.trackId).length;
    const clip = {
      id: genClipId(),
      sourceId,
      trackId: trackId || null,
      timelineOffsetSec: timelineOffsetSec != null ? Math.max(0, Number(timelineOffsetSec) || 0) : null,
      label: String(label || (src ? src.name : "Audio Clip")),
      sourceStart: 0,
      sourceEnd: clipDur,
      gainDb: 0,
      fadeInSec: 0,
      fadeOutSec: 0,
      crossfadePrevSec: !trackId && existingSpineCount > 0 ? Math.max(0, Number(crossfadePrevSec) || 0) : 0
    };
    state.clips.push(clip);
    return clip;
  }

  function splitAt(state, timeSec, targetTrackId) {
    const t = quantizeToSample(Number(timeSec), state);
    if (!Number.isFinite(t)) return false;

    const { items } = computeTimelineLayout(state.clips);
    let target = null;
    if (targetTrackId) {
      target = items.find(
        (it) => it.clip.trackId === targetTrackId && t > it.timelineStart + 0.08 && t < it.timelineEnd - 0.08
      );
    }
    if (!target) {
      target = items.find(
        (it) => !it.clip.trackId && t > it.timelineStart + 0.08 && t < it.timelineEnd - 0.08
      ) || items.find(
        (it) => t > it.timelineStart + 0.08 && t < it.timelineEnd - 0.08
      );
    }
    if (!target) return false;

    pushUndo(state, "Split Clip");
    const orig = target.clip;
    const offsetInClip = t - target.timelineStart;
    const splitSourceTime = quantizeToSample(orig.sourceStart + offsetInClip, state);

    const firstClip = {
      ...cloneData(orig),
      sourceEnd: splitSourceTime,
      fadeOutSec: 0
    };
    const secondClip = {
      ...cloneData(orig),
      id: genClipId(),
      sourceStart: splitSourceTime,
      timelineOffsetSec: orig.trackId ? t : orig.timelineOffsetSec,
      fadeInSec: 0,
      crossfadePrevSec: 0
    };

    state.clips.splice(target.index, 1, firstClip, secondClip);
    return true;
  }

  function trimClip(state, clipId, { newSourceStart, newSourceEnd } = {}) {
    const { items } = computeTimelineLayout(state.clips);
    const target = items.find((it) => it.clip.id === clipId);
    if (!target) return false;

    const clip = target.clip;
    const src = state.sources[clip.sourceId];
    const maxEnd = src ? src.duration : Math.max(clip.sourceEnd, Number(newSourceEnd) || clip.sourceEnd);

    const nextStart =
      newSourceStart != null
        ? Math.max(0, Math.min(Number(newSourceStart), clip.sourceEnd - 0.1))
        : clip.sourceStart;
    const nextEnd =
      newSourceEnd != null
        ? Math.min(maxEnd, Math.max(nextStart + 0.1, Number(newSourceEnd)))
        : clip.sourceEnd;

    const dFront = nextStart - clip.sourceStart;
    const dBack = clip.sourceEnd - nextEnd;
    if (Math.abs(dFront) < 0.001 && Math.abs(dBack) < 0.001) return false;

    pushUndo(state, "Trim Clip");
    const oldStart = target.timelineStart;
    const oldEnd = target.timelineEnd;

    state.clips[target.index].sourceStart = nextStart;
    state.clips[target.index].sourceEnd = nextEnd;

    if (!clip.trackId) {
      const newLayout = computeTimelineLayout(state.clips);
      const newItem = newLayout.items[target.index];
      const totalDelta = newItem.duration - target.duration;

      state.markers = state.markers
        .map((m) => {
          const s = Number(m.start_seconds || 0);
          if (s < oldStart) return m;
          if (s < oldEnd) {
            const shifted = Math.max(oldStart, s - dFront);
            return { ...m, start_seconds: Math.round(shifted * 100) / 100 };
          }
          const shiftedDown = Math.max(0, s + totalDelta);
          return { ...m, start_seconds: Math.round(shiftedDown * 100) / 100 };
        })
        .sort((a, b) => a.start_seconds - b.start_seconds);
    }

    return true;
  }

  /**
   * Non-destructive slip edit: slides underlying audio content inside a clip window without changing clip duration.
   */
  function slipClip(state, clipId, deltaSourceSec) {
    const idx = state.clips.findIndex((c) => c.id === clipId);
    if (idx === -1) return false;
    const clip = state.clips[idx];
    const src = state.sources[clip.sourceId];
    const srcDur = src ? src.duration : clip.sourceEnd;
    const clipLen = clip.sourceEnd - clip.sourceStart;
    const minDelta = -clip.sourceStart;
    const maxDelta = srcDur - clip.sourceEnd;
    const clampedDelta = Math.max(minDelta, Math.min(maxDelta, Number(deltaSourceSec) || 0));
    if (Math.abs(clampedDelta) < 0.001) return false;

    pushUndo(state, "Slip Clip");
    clip.sourceStart += clampedDelta;
    clip.sourceEnd = clip.sourceStart + clipLen;
    return true;
  }

  /**
   * Nudge a track clip left or right along the timeline (promotes spine clip offset if needed or adjusts timelineOffsetSec).
   */
  function nudgeClip(state, clipId, deltaSec, snapOpts = null) {
    const { items } = computeTimelineLayout(state.clips);
    const target = items.find((it) => it.clip.id === clipId);
    if (!target) return false;

    const delta = Number(deltaSec) || 0;
    if (Math.abs(delta) < 0.001) return false;

    pushUndo(state, "Nudge Clip");
    const c = state.clips[target.index];
    const baseStart = c.trackId ? target.timelineStart : target.timelineStart;
    let nextStart = Math.max(0, baseStart + delta);
    if (snapOpts) {
      nextStart = snapTime(state, nextStart, snapOpts);
    }
    if (!c.trackId) {
      c.trackId = state.selectedTrackId && state.selectedTrackId !== "master"
        ? state.selectedTrackId
        : (state.tracks[0] && state.tracks[0].id) || "track-1";
    }
    c.timelineOffsetSec = quantizeToSample(nextStart, state);
    c.crossfadePrevSec = 0;
    return true;
  }

  function duplicateClip(state, clipId) {
    const { items } = computeTimelineLayout(state.clips);
    const target = items.find((it) => it.clip.id === clipId);
    if (!target) return null;

    pushUndo(state, "Duplicate Clip");
    const copy = cloneData(target.clip);
    copy.id = genClipId();
    copy.label = `${copy.label} Copy`;
    if (copy.trackId) {
      copy.timelineOffsetSec = target.timelineEnd;
    } else {
      copy.crossfadePrevSec = 0;
    }
    state.clips.push(copy);
    return copy;
  }

  function copyClips(state, clipIds) {
    ensureTrackState(state);
    const ids = new Set(Array.isArray(clipIds) ? clipIds : [clipIds]);
    const matched = state.clips.filter((c) => ids.has(c.id)).map((c) => cloneData(c));
    state.clipboard = matched;
    return matched.length;
  }

  function pasteClips(state, atTimeSec = 0, targetTrackId = null) {
    ensureTrackState(state);
    if (!state.clipboard.length) return [];
    pushUndo(state, "Paste Clips");
    const created = [];
    let cursor = Math.max(0, Number(atTimeSec) || 0);
    state.clipboard.forEach((srcClip) => {
      const c = cloneData(srcClip);
      c.id = genClipId();
      if (targetTrackId && targetTrackId !== "master") {
        c.trackId = targetTrackId;
        c.timelineOffsetSec = cursor;
      } else if (c.trackId) {
        c.timelineOffsetSec = cursor;
      }
      cursor += Math.max(0.05, Number(c.sourceEnd) - Number(c.sourceStart));
      state.clips.push(c);
      created.push(c);
    });
    return created;
  }

  function cutClips(state, clipIds) {
    ensureTrackState(state);
    const ids = new Set(Array.isArray(clipIds) ? clipIds : [clipIds]);
    const matched = state.clips.filter((c) => ids.has(c.id)).map((c) => cloneData(c));
    if (matched.length === 0) return 0;
    state.clipboard = matched;
    pushUndo(state, "Cut Clips");
    state.clips = state.clips.filter((c) => !ids.has(c.id));
    const firstSpine = state.clips.find((c) => !c.trackId);
    if (firstSpine) firstSpine.crossfadePrevSec = 0;
    return matched.length;
  }

  function joinClips(state, clipIds = []) {
    ensureTrackState(state);
    const { items } = computeTimelineLayout(state.clips);
    let group = [];
    const reqIds = Array.isArray(clipIds) ? clipIds.filter(Boolean) : [clipIds].filter(Boolean);
    if (reqIds.length >= 2) {
      const idSet = new Set(reqIds);
      group = items.filter((it) => idSet.has(it.clip.id));
    } else if (reqIds.length === 1) {
      const firstIdx = items.findIndex((it) => it.clip.id === reqIds[0]);
      if (firstIdx !== -1) {
        const first = items[firstIdx];
        const nextSame = items.slice(firstIdx + 1).find((it) => (it.clip.trackId || null) === (first.clip.trackId || null));
        if (nextSame) group = [first, nextSame];
      }
    }
    if (group.length < 2) return null;
    const refSrc = group[0].clip.sourceId;
    const refTrack = group[0].clip.trackId || null;
    if (!group.every((it) => it.clip.sourceId === refSrc && (it.clip.trackId || null) === refTrack)) {
      return null;
    }
    const sorted = group.slice().sort((a, b) => a.clip.sourceStart - b.clip.sourceStart);
    const firstClip = sorted[0].clip;
    const lastClip = sorted[sorted.length - 1].clip;
    const minStart = Math.min(...sorted.map((it) => it.clip.sourceStart));
    const maxEnd = Math.max(...sorted.map((it) => it.clip.sourceEnd));
    const removeIds = new Set(sorted.slice(1).map((it) => it.clip.id));

    pushUndo(state, "Join Clips");
    const target = state.clips.find((c) => c.id === firstClip.id);
    if (!target) return null;
    target.sourceStart = minStart;
    target.sourceEnd = maxEnd;
    target.fadeOutSec = lastClip.fadeOutSec || 0;
    state.clips = state.clips.filter((c) => !removeIds.has(c.id));
    return target;
  }

  function applyRangeGain(state, rangeStartSec, rangeEndSec, deltaGainDb, targetTrackId = null) {
    ensureTrackState(state);
    const rStart = Math.max(0, Math.min(Number(rangeStartSec), Number(rangeEndSec)));
    const rEnd = Math.max(rStart, Math.max(Number(rangeStartSec), Number(rangeEndSec)));
    const dGain = Number(deltaGainDb);
    if (!Number.isFinite(rStart) || !Number.isFinite(rEnd) || rEnd - rStart < 0.05 || !Number.isFinite(dGain)) {
      return 0;
    }
    const { items } = computeTimelineLayout(state.clips);
    const overlaps = (it) =>
      it.timelineEnd > rStart + 0.005 &&
      it.timelineStart < rEnd - 0.005 &&
      (!targetTrackId || targetTrackId === "master" || it.clip.trackId === targetTrackId || !it.clip.trackId);
    if (!items.some(overlaps)) return 0;

    pushUndo(state, "Range Gain");
    const nextClips = [];
    let modified = 0;

    for (let i = 0; i < items.length; i += 1) {
      const it = items[i];
      const c = it.clip;
      if (!overlaps(it)) {
        nextClips.push(cloneData(c));
        continue;
      }

      const cutStart = Math.max(it.timelineStart, rStart);
      const cutEnd = Math.min(it.timelineEnd, rEnd);
      const srcInCutStart = c.sourceStart + (cutStart - it.timelineStart);
      const srcInCutEnd = c.sourceStart + (cutEnd - it.timelineStart);

      if (cutStart - it.timelineStart > 0.05) {
        const leftPart = cloneData(c);
        leftPart.sourceEnd = quantizeToSample(srcInCutStart, state);
        leftPart.fadeOutSec = 0;
        nextClips.push(leftPart);
      }

      const midPart = cloneData(c);
      if (cutStart - it.timelineStart > 0.05) midPart.id = genClipId();
      midPart.sourceStart = quantizeToSample(srcInCutStart, state);
      midPart.sourceEnd = quantizeToSample(srcInCutEnd, state);
      midPart.gainDb = Math.max(-24, Math.min(18, Math.round(((Number(c.gainDb) || 0) + dGain) * 10) / 10));
      if (cutStart - it.timelineStart > 0.05) {
        midPart.fadeInSec = 0;
        midPart.crossfadePrevSec = 0;
      }
      if (it.timelineEnd - cutEnd > 0.05) {
        midPart.fadeOutSec = 0;
      }
      if (c.trackId) midPart.timelineOffsetSec = quantizeToSample(cutStart, state);
      nextClips.push(midPart);
      modified += 1;

      if (it.timelineEnd - cutEnd > 0.05) {
        const rightPart = cloneData(c);
        rightPart.id = genClipId();
        rightPart.sourceStart = quantizeToSample(srcInCutEnd, state);
        rightPart.fadeInSec = 0;
        rightPart.crossfadePrevSec = 0;
        if (c.trackId) rightPart.timelineOffsetSec = quantizeToSample(cutEnd, state);
        nextClips.push(rightPart);
      }
    }

    state.clips = nextClips;
    return modified;
  }

  function normalizeClip(state, clipId, targetPeakDb = -1.0, measuredPeakDb = -6.0) {
    const idx = state.clips.findIndex((c) => c.id === clipId);
    if (idx === -1) return false;
    if (!Number.isFinite(measuredPeakDb) || measuredPeakDb < -80) return false;
    const neededGain = Math.max(-24, Math.min(18, Number(targetPeakDb) - Number(measuredPeakDb)));
    pushUndo(state, "Normalize Clip");
    state.clips[idx].gainDb = Math.round(neededGain * 10) / 10;
    return true;
  }

  function rippleDeleteClip(state, clipId, { joinCrossfadeSec = 0.25 } = {}) {
    const { items } = computeTimelineLayout(state.clips);
    const idx = items.findIndex((it) => it.clip.id === clipId);
    if (idx === -1) return false;

    pushUndo(state, "Ripple Delete Clip");
    const target = items[idx];
    const isSpine = !target.clip.trackId;
    const delStart = target.timelineStart;
    const delEnd = target.timelineEnd;
    const oldNextStart = idx + 1 < items.length ? items[idx + 1].timelineStart : delEnd;

    state.clips.splice(idx, 1);

    if (isSpine) {
      if (idx > 0 && idx < state.clips.length && !state.clips[idx].trackId) {
        state.clips[idx].crossfadePrevSec = Math.max(0, Number(joinCrossfadeSec) || 0);
      } else if (state.clips.length > 0 && idx === 0 && !state.clips[0].trackId) {
        state.clips[0].crossfadePrevSec = 0;
      }

      const afterLayout = computeTimelineLayout(state.clips);
      const newNextStart =
        idx < afterLayout.items.length ? afterLayout.items[idx].timelineStart : delStart;
      const downstreamShift = newNextStart - oldNextStart;

      state.markers = state.markers
        .filter((m) => {
          const s = Number(m.start_seconds || 0);
          return s < delStart || s >= delEnd;
        })
        .map((m) => {
          const s = Number(m.start_seconds || 0);
          if (s >= delEnd) {
            return {
              ...m,
              start_seconds: Math.max(0, Math.round((s + downstreamShift) * 100) / 100)
            };
          }
          return m;
        })
        .sort((a, b) => a.start_seconds - b.start_seconds);
    }

    return true;
  }

  function rippleDeleteRange(state, rangeStartSec, rangeEndSec, { joinCrossfadeSec = 0.25 } = {}) {
    const rStart = Math.max(0, Math.min(Number(rangeStartSec), Number(rangeEndSec)));
    const rEnd = Math.max(rStart, Math.max(Number(rangeStartSec), Number(rangeEndSec)));
    if (!Number.isFinite(rStart) || !Number.isFinite(rEnd) || rEnd - rStart < 0.05) {
      return false;
    }

    const { items } = computeTimelineLayout(state.clips);
    const touchesAny = items.some((it) => it.timelineEnd > rStart && it.timelineStart < rEnd);
    if (!touchesAny) return false;

    pushUndo(state, "Ripple Cut Range");

    const newClips = [];
    let firstAfterSpineIdx = -1;
    let oldFirstAfterSpineStart = rEnd;
    let hasSpineBeforeCut = false;

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const c = it.clip;

      if (it.timelineEnd <= rStart + 0.001) {
        if (!c.trackId) hasSpineBeforeCut = true;
        newClips.push(cloneData(c));
        continue;
      }

      if (it.timelineStart >= rEnd - 0.001) {
        if (!c.trackId && firstAfterSpineIdx === -1) {
          firstAfterSpineIdx = newClips.length;
          oldFirstAfterSpineStart = it.timelineStart;
        }
        const shiftedClip = cloneData(c);
        if (c.trackId) {
          shiftedClip.timelineOffsetSec = Math.max(0, it.timelineStart - (rEnd - rStart));
        }
        newClips.push(shiftedClip);
        continue;
      }

      if (it.timelineStart < rStart - 0.05) {
        if (!c.trackId) hasSpineBeforeCut = true;
        const leftPart = cloneData(c);
        leftPart.sourceEnd = c.sourceStart + (rStart - it.timelineStart);
        leftPart.fadeOutSec = 0;
        newClips.push(leftPart);
      }

      if (it.timelineEnd > rEnd + 0.05) {
        if (!c.trackId && firstAfterSpineIdx === -1) {
          firstAfterSpineIdx = newClips.length;
          oldFirstAfterSpineStart = rEnd;
        }
        const rightPart = cloneData(c);
        rightPart.id = genClipId();
        rightPart.sourceStart = c.sourceStart + (rEnd - it.timelineStart);
        rightPart.fadeInSec = 0;
        rightPart.crossfadePrevSec = 0;
        if (c.trackId) {
          rightPart.timelineOffsetSec = Math.max(0, rStart);
        }
        newClips.push(rightPart);
      }
    }

    if (firstAfterSpineIdx !== -1 && hasSpineBeforeCut) {
      newClips[firstAfterSpineIdx].crossfadePrevSec = Math.max(0, Number(joinCrossfadeSec) || 0);
    } else if (newClips.length > 0 && !newClips[0].trackId) {
      newClips[0].crossfadePrevSec = 0;
    }

    state.clips = newClips;
    const afterLayout = computeTimelineLayout(state.clips);
    const newAfterStart =
      firstAfterSpineIdx !== -1 && afterLayout.items[firstAfterSpineIdx]
        ? afterLayout.items[firstAfterSpineIdx].timelineStart
        : rStart;
    const downstreamShift = newAfterStart - oldFirstAfterSpineStart;

    state.markers = state.markers
      .filter((m) => {
        const s = Number(m.start_seconds || 0);
        return s < rStart || s >= rEnd;
      })
      .map((m) => {
        const s = Number(m.start_seconds || 0);
        if (s >= rEnd) {
          return {
            ...m,
            start_seconds: Math.max(0, Math.round((s + downstreamShift) * 100) / 100)
          };
        }
        return m;
      })
      .sort((a, b) => a.start_seconds - b.start_seconds);

    return true;
  }

  function updateClipProps(state, clipId, props = {}) {
    const idx = state.clips.findIndex((c) => c.id === clipId);
    if (idx === -1) return false;
    pushUndo(state);
    const c = state.clips[idx];
    if (props.label != null) c.label = String(props.label).trim() || c.label;
    if (props.gainDb != null) c.gainDb = Math.max(-24, Math.min(18, Number(props.gainDb) || 0));
    if (props.fadeInSec != null) c.fadeInSec = Math.max(0, Math.min(15, Number(props.fadeInSec) || 0));
    if (props.fadeOutSec != null) c.fadeOutSec = Math.max(0, Math.min(15, Number(props.fadeOutSec) || 0));
    if (props.crossfadePrevSec != null && idx > 0 && !c.trackId) {
      c.crossfadePrevSec = Math.max(0, Math.min(4, Number(props.crossfadePrevSec) || 0));
    }
    return true;
  }

  /* ======================== Dynamic Track Management ======================== */

  function getTrackById(state, trackId) {
    ensureTrackState(state);
    if (trackId === "master") return state.masterTrack;
    return state.tracks.find((t) => t.id === trackId) || null;
  }

  function addTrack(state, { name, color, role = "audio", groupId = null } = {}) {
    ensureTrackState(state);
    pushUndo(state, "Add Track");
    const idx = state.tracks.length;
    const track = {
      id: genTrackId(),
      name: String(name || `Track ${idx + 1} · Audio`).trim().slice(0, 48),
      color: color || TRACK_COLORS[idx % TRACK_COLORS.length],
      role,
      gain: 100,
      pan: 0,
      mute: false,
      solo: false,
      frozen: false,
      groupId: groupId || null,
      fxRack: [],
      automation: createDefaultAutomation()
    };
    state.tracks.push(track);
    state.selectedTrackId = track.id;
    return track;
  }

  function deleteTrack(state, trackId) {
    ensureTrackState(state);
    if (!trackId || trackId === "master" || state.tracks.length <= 1) return false;
    const idx = state.tracks.findIndex((t) => t.id === trackId);
    if (idx === -1) return false;

    pushUndo(state, "Delete Track");
    state.tracks.splice(idx, 1);
    state.clips = state.clips.filter((c) => c.trackId !== trackId);
    if (state.selectedTrackId === trackId) {
      state.selectedTrackId = state.tracks[Math.min(idx, state.tracks.length - 1)].id;
    }
    return true;
  }

  function selectTrack(state, trackId) {
    ensureTrackState(state);
    if (!getTrackById(state, trackId)) return false;
    state.selectedTrackId = trackId;
    return true;
  }

  function renameTrack(state, trackId, name) {
    const tr = getTrackById(state, trackId);
    if (!tr || !String(name || "").trim()) return false;
    pushUndo(state, "Rename Track");
    tr.name = String(name).trim().slice(0, 48);
    return true;
  }

  function setTrackGroup(state, trackId, groupId) {
    const tr = getTrackById(state, trackId);
    if (!tr || trackId === "master") return false;
    tr.groupId = groupId || null;
    return true;
  }

  function updateTrackProps(state, trackId, props = {}, opts = {}) {
    const tr = getTrackById(state, trackId);
    if (!tr) return false;
    if (opts.recordUndo) pushUndo(state, "Track Mix");
    const nextGain = props.gain != null ? Math.max(0, Math.min(200, Number(props.gain) || 0)) : null;
    const nextPan = props.pan != null ? Math.max(-100, Math.min(100, Number(props.pan) || 0)) : null;
    const dGain = nextGain != null ? nextGain - (tr.gain ?? 100) : 0;
    const dPan = nextPan != null ? nextPan - (tr.pan ?? 0) : 0;

    if (nextGain != null) tr.gain = nextGain;
    if (props.inputTrimDb != null) tr.inputTrimDb = Math.max(-24, Math.min(18, Number(props.inputTrimDb) || 0));
    if (nextPan != null) tr.pan = nextPan;
    if (props.mute != null) tr.mute = Boolean(props.mute);
    if (props.solo != null) tr.solo = Boolean(props.solo);
    if (props.frozen != null) tr.frozen = Boolean(props.frozen);
    if (props.groupId !== undefined && trackId !== "master") tr.groupId = props.groupId || null;

    if (tr.groupId && trackId !== "master" && !opts.skipGroup) {
      state.tracks.forEach((peer) => {
        if (peer.id === tr.id || peer.groupId !== tr.groupId) return;
        if (nextGain != null && dGain !== 0) peer.gain = Math.max(0, Math.min(200, (peer.gain ?? 100) + dGain));
        if (nextPan != null && dPan !== 0) peer.pan = Math.max(-100, Math.min(100, (peer.pan ?? 0) + dPan));
        if (props.mute != null) peer.mute = Boolean(props.mute);
        if (props.solo != null) peer.solo = Boolean(props.solo);
      });
    }
    return true;
  }

  /* ====================== Modular Per-Track FX Rack ====================== */

  function addTrackFx(state, trackId, fxType, overrides) {
    const tr = getTrackById(state, trackId);
    if (!tr) return null;
    pushUndo(state, `Add FX: ${fxType}`);
    const slot = createFxSlotData(fxType, overrides);
    if (!Array.isArray(tr.fxRack)) tr.fxRack = [];
    tr.fxRack.push(slot);
    return slot;
  }

  function duplicateTrackFx(state, trackId, slotId) {
    const tr = getTrackById(state, trackId);
    if (!tr || !Array.isArray(tr.fxRack)) return null;
    const idx = tr.fxRack.findIndex((s) => s.id === slotId);
    if (idx === -1) return null;
    pushUndo(state, "Duplicate FX");
    const copy = cloneData(tr.fxRack[idx]);
    copy.id = `fx-${Date.now().toString(36)}-${nextFxCounter++}`;
    tr.fxRack.splice(idx + 1, 0, copy);
    return copy;
  }

  function removeTrackFx(state, trackId, slotId) {
    const tr = getTrackById(state, trackId);
    if (!tr || !Array.isArray(tr.fxRack)) return false;
    const idx = tr.fxRack.findIndex((s) => s.id === slotId);
    if (idx === -1) return false;
    pushUndo(state, "Remove FX");
    tr.fxRack.splice(idx, 1);
    return true;
  }

  function toggleTrackFx(state, trackId, slotId) {
    const tr = getTrackById(state, trackId);
    if (!tr || !Array.isArray(tr.fxRack)) return false;
    const slot = tr.fxRack.find((s) => s.id === slotId);
    if (!slot) return false;
    pushUndo(state, "Toggle FX");
    slot.enabled = !slot.enabled;
    return true;
  }

  function moveTrackFx(state, trackId, slotId, delta) {
    const tr = getTrackById(state, trackId);
    if (!tr || !Array.isArray(tr.fxRack)) return false;
    const idx = tr.fxRack.findIndex((s) => s.id === slotId);
    if (idx === -1) return false;
    const nextIdx = idx + (delta < 0 ? -1 : 1);
    if (nextIdx < 0 || nextIdx >= tr.fxRack.length) return false;
    pushUndo(state, "Reorder FX");
    const [removed] = tr.fxRack.splice(idx, 1);
    tr.fxRack.splice(nextIdx, 0, removed);
    return true;
  }

  function updateTrackFxParams(state, trackId, slotId, nextParams, opts = {}) {
    const tr = getTrackById(state, trackId);
    if (!tr || !Array.isArray(tr.fxRack)) return false;
    const slot = tr.fxRack.find((s) => s.id === slotId);
    if (!slot) return false;
    if (opts.recordUndo) pushUndo(state);
    if (nextParams && nextParams.wetDry != null) {
      slot.wetDry = Math.max(0, Math.min(100, Number(nextParams.wetDry)));
    }
    slot.params = Object.assign({}, slot.params || {}, nextParams || {});
    return true;
  }

  /* ==================== Sample-Accurate Automation Lanes ==================== */

  function addAutomationPoint(state, trackId, laneName, timeSec, value) {
    const tr = getTrackById(state, trackId);
    if (!tr) return null;
    if (!tr.automation) tr.automation = createDefaultAutomation();
    if (!Array.isArray(tr.automation[laneName])) tr.automation[laneName] = [];
    pushUndo(state, `Add Automation: ${laneName}`);
    const pt = {
      id: genAutoId(),
      timeSec: quantizeToSample(timeSec, state),
      value: Number(value) || 0
    };
    tr.automation[laneName].push(pt);
    tr.automation[laneName].sort((a, b) => a.timeSec - b.timeSec);
    return pt;
  }

  function updateAutomationPoint(state, trackId, laneName, ptId, { timeSec, value } = {}) {
    const tr = getTrackById(state, trackId);
    const list = tr && tr.automation && tr.automation[laneName];
    if (!Array.isArray(list)) return false;
    const pt = list.find((p) => p.id === ptId);
    if (!pt) return false;
    if (timeSec != null) pt.timeSec = quantizeToSample(timeSec, state);
    if (value != null) pt.value = Number(value) || 0;
    list.sort((a, b) => a.timeSec - b.timeSec);
    return true;
  }

  function removeAutomationPoint(state, trackId, laneName, ptId) {
    const tr = getTrackById(state, trackId);
    const list = tr && tr.automation && tr.automation[laneName];
    if (!Array.isArray(list)) return false;
    const idx = list.findIndex((p) => p.id === ptId);
    if (idx === -1) return false;
    pushUndo(state, `Remove Automation: ${laneName}`);
    list.splice(idx, 1);
    return true;
  }

  function clearAutomationLane(state, trackId, laneName) {
    const tr = getTrackById(state, trackId);
    if (!tr) return false;
    if (!tr.automation) tr.automation = createDefaultAutomation();
    if (!Array.isArray(tr.automation[laneName]) || tr.automation[laneName].length === 0) return false;
    pushUndo(state, `Clear Automation: ${laneName}`);
    tr.automation[laneName] = [];
    return true;
  }

  function evaluateAutomation(points, timeSec, fallbackValue = 0) {
    if (!Array.isArray(points) || points.length === 0) return Number(fallbackValue) || 0;
    const t = Math.max(0, Number(timeSec) || 0);
    if (t <= points[0].timeSec) return Number(points[0].value);
    const last = points[points.length - 1];
    if (t >= last.timeSec) return Number(last.value);

    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      if (t >= a.timeSec && t <= b.timeSec) {
        const span = Math.max(1e-6, b.timeSec - a.timeSec);
        const frac = (t - a.timeSec) / span;
        return a.value + (b.value - a.value) * frac;
      }
    }
    return Number(fallbackValue) || 0;
  }

  function sampleAutomationEnvelope(points, startSec, numSamples, sampleRate, fallbackValue = 0) {
    const out = new Float32Array(numSamples);
    if (!Array.isArray(points) || points.length === 0) {
      out.fill(Number(fallbackValue) || 0);
      return out;
    }
    const sr = Math.max(8000, Number(sampleRate) || 48000);
    const t0 = Math.max(0, Number(startSec) || 0);
    for (let i = 0; i < numSamples; i++) {
      out[i] = evaluateAutomation(points, t0 + i / sr, fallbackValue);
    }
    return out;
  }

  function setLoopRegion(state, { enabled, startSec, endSec } = {}) {
    ensureTrackState(state);
    const s = Math.max(0, Number(startSec ?? state.loopRegion.startSec) || 0);
    const e = Math.max(s, Number(endSec ?? state.loopRegion.endSec) || 0);
    state.loopRegion = {
      enabled: enabled != null ? Boolean(enabled) : state.loopRegion.enabled,
      startSec: s,
      endSec: e
    };
    return state.loopRegion;
  }

  /* ==================== Markers, Undo & Project Persistence ==================== */

  function setMarkers(state, markersList) {
    state.markers = (Array.isArray(markersList) ? markersList : [])
      .map((m) => ({
        id: m.id || genMarkerId(),
        submission_id: m.submission_id || null,
        bhajan_title: String(m.bhajan_title || "Untitled Bhajan"),
        singer_name: String(m.singer_name || "Samiti Singer"),
        deity: String(m.deity || ""),
        start_seconds: Math.max(0, Math.round((Number(m.start_seconds) || 0) * 100) / 100)
      }))
      .sort((a, b) => a.start_seconds - b.start_seconds);
    return state.markers;
  }

  function addMarker(state, { submission_id = null, bhajan_title, singer_name = "Samiti Singer", deity = "", start_seconds = 0 }) {
    pushUndo(state, "Add Marker");
    const marker = {
      id: genMarkerId(),
      submission_id,
      bhajan_title: String(bhajan_title || "Untitled Bhajan"),
      singer_name: String(singer_name || "Samiti Singer"),
      deity: String(deity || ""),
      start_seconds: Math.max(0, Math.round((Number(start_seconds) || 0) * 100) / 100)
    };
    state.markers.push(marker);
    state.markers.sort((a, b) => a.start_seconds - b.start_seconds);
    return marker;
  }

  function nudgeMarker(state, markerId, deltaSec) {
    const idx = state.markers.findIndex((m) => m.id === markerId);
    if (idx === -1) return false;
    pushUndo(state, "Nudge Marker");
    state.markers[idx].start_seconds = Math.max(
      0,
      Math.round((state.markers[idx].start_seconds + Number(deltaSec || 0)) * 100) / 100
    );
    state.markers.sort((a, b) => a.start_seconds - b.start_seconds);
    return true;
  }

  function removeMarker(state, markerId) {
    const idx = state.markers.findIndex((m) => m.id === markerId);
    if (idx === -1) return false;
    pushUndo(state, "Remove Marker");
    state.markers.splice(idx, 1);
    return true;
  }

  function undo(state) {
    if (state.undoStack.length === 0) return false;
    ensureTrackState(state);
    const prev = state.undoStack.pop();
    state.redoStack.push({
      label: prev.label || "Edit",
      timestamp: prev.timestamp || Date.now(),
      clips: cloneData(state.clips),
      markers: cloneData(state.markers),
      tracks: cloneData(state.tracks),
      masterTrack: cloneData(state.masterTrack),
      selectedTrackId: state.selectedTrackId,
      loopRegion: cloneData(state.loopRegion)
    });
    state.clips = prev.clips;
    state.markers = prev.markers;
    if (prev.tracks) state.tracks = prev.tracks;
    if (prev.masterTrack) state.masterTrack = prev.masterTrack;
    if (prev.selectedTrackId) state.selectedTrackId = prev.selectedTrackId;
    if (prev.loopRegion) state.loopRegion = prev.loopRegion;
    return true;
  }

  function redo(state) {
    if (state.redoStack.length === 0) return false;
    ensureTrackState(state);
    const next = state.redoStack.pop();
    state.undoStack.push({
      label: next.label || "Edit",
      timestamp: next.timestamp || Date.now(),
      clips: cloneData(state.clips),
      markers: cloneData(state.markers),
      tracks: cloneData(state.tracks),
      masterTrack: cloneData(state.masterTrack),
      selectedTrackId: state.selectedTrackId,
      loopRegion: cloneData(state.loopRegion)
    });
    state.clips = next.clips;
    state.markers = next.markers;
    if (next.tracks) state.tracks = next.tracks;
    if (next.masterTrack) state.masterTrack = next.masterTrack;
    if (next.selectedTrackId) state.selectedTrackId = next.selectedTrackId;
    if (next.loopRegion) state.loopRegion = next.loopRegion;
    return true;
  }

  function getHistoryList(state) {
    ensureTrackState(state);
    return {
      undoItems: state.undoStack.map((u, index) => ({
        index,
        label: u.label || "Edit",
        timestamp: u.timestamp || 0
      })),
      redoItems: state.redoStack.slice().reverse().map((r, index) => ({
        index,
        label: r.label || "Edit",
        timestamp: r.timestamp || 0
      }))
    };
  }

  function jumpToHistoryStep(state, direction, count = 1) {
    const steps = Math.max(0, Math.round(Number(count) || 0));
    let applied = 0;
    for (let i = 0; i < steps; i += 1) {
      const ok = direction === "redo" ? redo(state) : undo(state);
      if (!ok) break;
      applied += 1;
    }
    return applied;
  }

  function exportProjectManifest(state, meta = {}) {
    ensureTrackState(state);
    const layout = computeTimelineLayout(state.clips);
    return {
      schemaVersion: "2.0",
      projectUid: meta.projectUid || `proj-${meta.sessionDate || "session"}-${Date.now().toString(36)}`,
      sessionDate: meta.sessionDate || null,
      title: meta.title || "Bhajan Session Project",
      sampleRate: Number(meta.sampleRate) || 48000,
      bitDepth: Number(meta.bitDepth) || 24,
      channelConfig: meta.channelConfig || "dual_mono_split",
      durationSeconds: Math.round(layout.totalDuration * 1000) / 1000,
      localFiles: meta.localFiles || {},
      r2Keys: meta.r2Keys || {},
      exportSettings: meta.exportSettings || {},
      publicationStatus: meta.publicationStatus || "draft",
      sources: cloneData(state.sources),
      clips: cloneData(state.clips),
      markers: cloneData(state.markers),
      tracks: cloneData(state.tracks),
      masterTrack: cloneData(state.masterTrack),
      selectedTrackId: state.selectedTrackId,
      loopRegion: cloneData(state.loopRegion),
      snap: cloneData(state.snap),
      timelineConfig: cloneData(state.timelineConfig),
      savedAt: new Date().toISOString()
    };
  }

  function importProjectManifest(state, manifest) {
    if (!state || !manifest || typeof manifest !== "object") return false;
    state.sources = cloneData(manifest.sources || {});
    state.clips = cloneData(manifest.clips || []);
    state.markers = cloneData(manifest.markers || []);
    state.tracks = cloneData(manifest.tracks && manifest.tracks.length ? manifest.tracks : createDefaultTracks());
    state.masterTrack = cloneData(manifest.masterTrack || createDefaultMasterTrack());
    state.selectedTrackId = manifest.selectedTrackId || state.tracks[0].id;
    state.loopRegion = cloneData(manifest.loopRegion || { enabled: false, startSec: 0, endSec: 0 });
    state.snap = cloneData(manifest.snap || { gridEnabled: false, gridSec: 1.0, markersEnabled: true, toleranceSec: 0.35 });
    state.timelineConfig = cloneData(manifest.timelineConfig || createDefaultTimelineConfig());
    state.undoStack = [];
    state.redoStack = [];
    ensureTrackState(state);
    return true;
  }

  return {
    AUTOMATION_LANES,
    createInitialState,
    computeTimelineLayout,
    snapTime,
    setTimelineConfig,
    addSource,
    appendClip,
    splitAt,
    trimClip,
    slipClip,
    nudgeClip,
    duplicateClip,
    copyClips,
    pasteClips,
    cutClips,
    joinClips,
    applyRangeGain,
    normalizeClip,
    rippleDeleteClip,
    rippleDeleteRange,
    updateClipProps,
    getTrackById,
    addTrack,
    deleteTrack,
    selectTrack,
    renameTrack,
    setTrackGroup,
    updateTrackProps,
    addTrackFx,
    duplicateTrackFx,
    removeTrackFx,
    toggleTrackFx,
    moveTrackFx,
    updateTrackFxParams,
    addAutomationPoint,
    updateAutomationPoint,
    removeAutomationPoint,
    clearAutomationLane,
    evaluateAutomation,
    sampleAutomationEnvelope,
    setLoopRegion,
    setMarkers,
    addMarker,
    nudgeMarker,
    removeMarker,
    undo,
    redo,
    getHistoryList,
    jumpToHistoryStep,
    exportProjectManifest,
    importProjectManifest
  };
});
