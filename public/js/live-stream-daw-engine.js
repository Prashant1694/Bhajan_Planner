/**
 * Non-Destructive Multitrack DAW Timeline, Tracks & Modular FX Engine
 * Manages dynamic tracks, per-track/master modular FX racks, clips, splits, trims,
 * ripple deletes, crossfades, undo/redo history, and synchronized bhajan markers.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./live-stream-dsp"));
  } else {
    root.LiveStreamDawEngine = factory(root.LiveStreamDsp);
  }
})(typeof globalThis !== "undefined" ? globalThis : self, function (Dsp) {
  "use strict";

  const MAX_UNDO = 50;
  const TRACK_COLORS = ["#d97706", "#2563eb", "#16a34a", "#9333ea", "#0891b2", "#db2777", "#65a30d"];
  let nextClipCounter = 1;
  let nextMarkerCounter = 1;
  let nextTrackCounter = 3;
  let nextFxCounter = 1;

  function genClipId() {
    return `clip-${Date.now().toString(36)}-${nextClipCounter++}`;
  }

  function genMarkerId() {
    return `mrk-${Date.now().toString(36)}-${nextMarkerCounter++}`;
  }

  function genTrackId() {
    return `track-${nextTrackCounter++}-${Date.now().toString(36)}`;
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
      params: Object.assign({}, overrides?.params || overrides || {})
    };
  }

  function createDefaultTracks() {
    return [
      {
        id: "track-1",
        name: "Track 1 · Instruments",
        color: "#d97706",
        role: "ch1",
        gain: 100,
        pan: 0,
        mute: false,
        solo: false,
        fxRack: []
      },
      {
        id: "track-2",
        name: "Track 2 · Vocals",
        color: "#2563eb",
        role: "ch2",
        gain: 100,
        pan: 0,
        mute: false,
        solo: false,
        fxRack: []
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
      pan: 0,
      mute: false,
      solo: false,
      fxRack: [
        createFxSlotData("eq", { id: "fx-master-eq" }),
        createFxSlotData("limiter", { id: "fx-master-lim", ceilingDb: -1.5, releaseMs: 80 })
      ]
    };
  }

  function createInitialState() {
    return {
      sources: {},
      clips: [],
      markers: [],
      tracks: createDefaultTracks(),
      masterTrack: createDefaultMasterTrack(),
      selectedTrackId: "track-1",
      undoStack: [],
      redoStack: []
    };
  }

  function ensureTrackState(state) {
    if (!Array.isArray(state.tracks) || state.tracks.length === 0) {
      state.tracks = createDefaultTracks();
    }
    if (!state.masterTrack) {
      state.masterTrack = createDefaultMasterTrack();
    }
    if (!state.selectedTrackId) {
      state.selectedTrackId = state.tracks[0].id;
    }
  }

  function pushUndo(state) {
    ensureTrackState(state);
    state.undoStack.push({
      clips: cloneData(state.clips),
      markers: cloneData(state.markers),
      tracks: cloneData(state.tracks),
      masterTrack: cloneData(state.masterTrack),
      selectedTrackId: state.selectedTrackId
    });
    if (state.undoStack.length > MAX_UNDO) {
      state.undoStack.shift();
    }
    state.redoStack = [];
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
        // Master/linked timeline spine (100% compatible with Ch1+Ch2 split stems)
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
        // Independent custom track clip
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
    pushUndo(state);

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
    const t = Number(timeSec);
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

    pushUndo(state);
    const orig = target.clip;
    const offsetInClip = t - target.timelineStart;
    const splitSourceTime = orig.sourceStart + offsetInClip;

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

    pushUndo(state);
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

  function rippleDeleteClip(state, clipId, { joinCrossfadeSec = 0.25 } = {}) {
    const { items } = computeTimelineLayout(state.clips);
    const idx = items.findIndex((it) => it.clip.id === clipId);
    if (idx === -1) return false;

    pushUndo(state);
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

    pushUndo(state);

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

  function addTrack(state, { name, color, role = "audio" } = {}) {
    ensureTrackState(state);
    pushUndo(state);
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
      fxRack: []
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

    pushUndo(state);
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
    pushUndo(state);
    tr.name = String(name).trim().slice(0, 48);
    return true;
  }

  function updateTrackProps(state, trackId, props = {}, opts = {}) {
    const tr = getTrackById(state, trackId);
    if (!tr) return false;
    if (opts.recordUndo) pushUndo(state);
    if (props.gain != null) tr.gain = Math.max(0, Math.min(200, Number(props.gain) || 0));
    if (props.pan != null) tr.pan = Math.max(-100, Math.min(100, Number(props.pan) || 0));
    if (props.mute != null) tr.mute = Boolean(props.mute);
    if (props.solo != null) tr.solo = Boolean(props.solo);
    return true;
  }

  /* ====================== Modular Per-Track FX Rack ====================== */

  function addTrackFx(state, trackId, fxType, overrides) {
    const tr = getTrackById(state, trackId);
    if (!tr) return null;
    pushUndo(state);
    const slot = createFxSlotData(fxType, overrides);
    if (!Array.isArray(tr.fxRack)) tr.fxRack = [];
    tr.fxRack.push(slot);
    return slot;
  }

  function removeTrackFx(state, trackId, slotId) {
    const tr = getTrackById(state, trackId);
    if (!tr || !Array.isArray(tr.fxRack)) return false;
    const idx = tr.fxRack.findIndex((s) => s.id === slotId);
    if (idx === -1) return false;
    pushUndo(state);
    tr.fxRack.splice(idx, 1);
    return true;
  }

  function toggleTrackFx(state, trackId, slotId) {
    const tr = getTrackById(state, trackId);
    if (!tr || !Array.isArray(tr.fxRack)) return false;
    const slot = tr.fxRack.find((s) => s.id === slotId);
    if (!slot) return false;
    pushUndo(state);
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
    pushUndo(state);
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
    slot.params = Object.assign({}, slot.params || {}, nextParams || {});
    return true;
  }

  /* =========================== Markers & Undo =========================== */

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
    pushUndo(state);
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
    pushUndo(state);
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
    pushUndo(state);
    state.markers.splice(idx, 1);
    return true;
  }

  function undo(state) {
    if (state.undoStack.length === 0) return false;
    ensureTrackState(state);
    state.redoStack.push({
      clips: cloneData(state.clips),
      markers: cloneData(state.markers),
      tracks: cloneData(state.tracks),
      masterTrack: cloneData(state.masterTrack),
      selectedTrackId: state.selectedTrackId
    });
    const prev = state.undoStack.pop();
    state.clips = prev.clips;
    state.markers = prev.markers;
    if (prev.tracks) state.tracks = prev.tracks;
    if (prev.masterTrack) state.masterTrack = prev.masterTrack;
    if (prev.selectedTrackId) state.selectedTrackId = prev.selectedTrackId;
    return true;
  }

  function redo(state) {
    if (state.redoStack.length === 0) return false;
    ensureTrackState(state);
    state.undoStack.push({
      clips: cloneData(state.clips),
      markers: cloneData(state.markers),
      tracks: cloneData(state.tracks),
      masterTrack: cloneData(state.masterTrack),
      selectedTrackId: state.selectedTrackId
    });
    const next = state.redoStack.pop();
    state.clips = next.clips;
    state.markers = next.markers;
    if (next.tracks) state.tracks = next.tracks;
    if (next.masterTrack) state.masterTrack = next.masterTrack;
    if (next.selectedTrackId) state.selectedTrackId = next.selectedTrackId;
    return true;
  }

  return {
    createInitialState,
    computeTimelineLayout,
    addSource,
    appendClip,
    splitAt,
    trimClip,
    rippleDeleteClip,
    rippleDeleteRange,
    updateClipProps,
    getTrackById,
    addTrack,
    deleteTrack,
    selectTrack,
    renameTrack,
    updateTrackProps,
    addTrackFx,
    removeTrackFx,
    toggleTrackFx,
    moveTrackFx,
    updateTrackFxParams,
    setMarkers,
    addMarker,
    nudgeMarker,
    removeMarker,
    undo,
    redo
  };
});
