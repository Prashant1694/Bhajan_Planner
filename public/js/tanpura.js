/**
 * Authentic Acoustic Tanpura & Shrutibox Audio Engine for Bhajan Planner
 * Powered by studio recordings of genuine Miraj Tanpuras.
 * Lazy-initializes WebAudio strictly on user interaction (zero page-load overhead),
 * with single-cycle equal-power seamless looping and smooth string/pitch crossfading.
 */
(function () {
  "use strict";

  var WESTERN_NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

  var NOTE_TO_SHRUTI = {
    C: "1",
    "C#": "1.5",
    DB: "1.5",
    D: "2",
    "D#": "2.5",
    EB: "2.5",
    E: "3",
    F: "4",
    "F#": "4.5",
    GB: "4.5",
    G: "5",
    "G#": "5.5",
    AB: "5.5",
    A: "6",
    "A#": "6.5",
    BB: "6.5",
    B: "7"
  };

  var SHRUTI_TO_NOTE = {
    "1": "C",
    "1.5": "C#",
    "2": "D",
    "2.5": "D#",
    "3": "E",
    "4": "F",
    "4.5": "F#",
    "5": "G",
    "5.5": "G#",
    "6": "A",
    "6.5": "A#",
    "7": "B"
  };

  var NOTE_TO_FILE = {
    C: "c",
    "C#": "cs",
    D: "d",
    "D#": "ds",
    E: "e",
    F: "f",
    "F#": "fs",
    G: "g",
    "G#": "gs",
    A: "a",
    "A#": "as",
    B: "b"
  };

  var TRANSITION_LEVELS = {
    1: { name: "Lush & Slow", duration: 2.4 },
    2: { name: "Gentle", duration: 1.8 },
    3: { name: "Medium", duration: 1.3 },
    4: { name: "Quick", duration: 0.9 },
    5: { name: "Fast", duration: 0.5 }
  };

  var AudioContextClass = window.AudioContext || window.webkitAudioContext;
  var audioCtx = null;
  var masterGain = null;
  var acousticWarmthFilter = null;
  var singleStringFilterNode = null;
  var activeSource = null;
  var activeFadeGain = null;

  var bufferCache = new Map();
  var loadingPromises = new Map();

  var state = {
    isPlaying: false,
    pitchNote: "C#",
    pitchNum: "1.5",
    firstString: "Pa",
    transitionSpeedLevel: 3,
    transitionSec: 1.3,
    volume: 0.7
  };

  function getAudioContext() {
    if (!audioCtx && AudioContextClass) {
      audioCtx = new AudioContextClass();

      masterGain = audioCtx.createGain();
      masterGain.gain.setValueAtTime(state.volume, audioCtx.currentTime);

      var nyquistSafe = Math.max(8000, Math.floor((audioCtx.sampleRate || 44100) * 0.45));

      try {
        acousticWarmthFilter = audioCtx.createBiquadFilter();
        acousticWarmthFilter.type = "lowshelf";
        acousticWarmthFilter.frequency.setValueAtTime(180, audioCtx.currentTime);
        acousticWarmthFilter.gain.setValueAtTime(2.5, audioCtx.currentTime);
        acousticWarmthFilter.connect(masterGain);
      } catch (_) {
        acousticWarmthFilter = null;
      }

      try {
        singleStringFilterNode = audioCtx.createBiquadFilter();
        singleStringFilterNode.type = "lowpass";
        singleStringFilterNode.frequency.setValueAtTime(
          Math.min(16000, nyquistSafe),
          audioCtx.currentTime
        );
        singleStringFilterNode.Q.setValueAtTime(0.7, audioCtx.currentTime);
        singleStringFilterNode.connect(acousticWarmthFilter || masterGain);
      } catch (_) {
        singleStringFilterNode = null;
      }

      masterGain.connect(audioCtx.destination);
    }
    if (audioCtx && audioCtx.state === "suspended") {
      audioCtx.resume().catch(function () {});
    }
    return audioCtx;
  }

  function getTargetAudioInput() {
    getAudioContext();
    return singleStringFilterNode || acousticWarmthFilter || masterGain;
  }

  function applySingleStringFilter() {
    if (!singleStringFilterNode || !audioCtx) return;
    var now = audioCtx.currentTime;
    var rampTime = 0.35;
    var nyquistSafe = Math.max(8000, Math.floor((audioCtx.sampleRate || 44100) * 0.45));

    singleStringFilterNode.type = "lowpass";
    if (state.firstString === "Ma") {
      singleStringFilterNode.frequency.setTargetAtTime(
        Math.min(14000, nyquistSafe),
        now,
        rampTime
      );
      singleStringFilterNode.Q.setTargetAtTime(0.85, now, rampTime);
    } else {
      singleStringFilterNode.frequency.setTargetAtTime(
        Math.min(16000, nyquistSafe),
        now,
        rampTime
      );
      singleStringFilterNode.Q.setTargetAtTime(0.7, now, rampTime);
    }
  }

  function getSampleFilename(pitchNote, swara) {
    var base = NOTE_TO_FILE[pitchNote] || "cs";
    return swara === "Ma" ? "m" + base : base;
  }

  /**
   * Builds a single-unit equal-power seamless loop buffer (BufferSourceNode.loop = true
   * natively repeats the seamless cycle in WebAudio's C++ audio thread).
   */
  function createSeamlessLoopBuffer(ctx, rawBuffer, crossfadeDurationSec) {
    var fadeSec = crossfadeDurationSec || 1.2;
    var sampleRate = rawBuffer.sampleRate;
    var numChannels = rawBuffer.numberOfChannels;

    var maxFade = Math.min(fadeSec, rawBuffer.duration * 0.28);
    var fadeSamples = Math.round(maxFade * sampleRate);
    var unitLength = rawBuffer.length - fadeSamples;

    if (unitLength <= sampleRate || fadeSamples <= 0) {
      return rawBuffer;
    }

    var seamlessBuffer = ctx.createBuffer(numChannels, unitLength, sampleRate);
    var halfPiOverFade = (Math.PI * 0.5) / fadeSamples;

    for (var ch = 0; ch < numChannels; ch++) {
      var rawData = rawBuffer.getChannelData(ch);
      var outData = seamlessBuffer.getChannelData(ch);

      outData.set(rawData.subarray(0, unitLength), 0);

      for (var j = 0; j < fadeSamples; j++) {
        var angle = j * halfPiOverFade;
        outData[j] =
          rawData[j] * Math.sin(angle) + rawData[unitLength + j] * Math.cos(angle);
      }
    }

    return seamlessBuffer;
  }

  function loadSample(filename) {
    if (bufferCache.has(filename)) {
      return Promise.resolve(bufferCache.get(filename));
    }
    if (loadingPromises.has(filename)) {
      return loadingPromises.get(filename);
    }

    var ctx = getAudioContext();
    if (!ctx) {
      return Promise.reject(new Error("WebAudio unavailable"));
    }

    var url = "/audio/tanpura/" + filename + ".wav";

    var p = fetch(url)
      .then(function (res) {
        if (!res.ok) throw new Error("Failed to load tanpura audio: " + url);
        return res.arrayBuffer();
      })
      .then(function (arrayBuf) {
        return new Promise(function (resolve, reject) {
          ctx.decodeAudioData(arrayBuf, resolve, reject);
        });
      })
      .then(function (decodedBuffer) {
        var seamless = createSeamlessLoopBuffer(ctx, decodedBuffer, 1.2);
        bufferCache.set(filename, seamless);
        loadingPromises.delete(filename);
        return seamless;
      })
      .catch(function (err) {
        loadingPromises.delete(filename);
        console.warn("Acoustic Tanpura load warning:", err.message);
        throw err;
      });

    loadingPromises.set(filename, p);
    return p;
  }

  function parsePitchString(str) {
    if (!str) return { note: "C#", shruti: "1.5" };
    var clean = String(str).trim();

    var westMatch = clean.match(/^([A-Ga-g])(#|b|s)?/i);
    if (westMatch) {
      var letter = westMatch[1].toUpperCase();
      var acc = (westMatch[2] || "").toUpperCase();
      if (acc === "S") acc = "#";
      var noteKey = letter + acc;
      if (NOTE_TO_SHRUTI[noteKey]) {
        var canonical = SHRUTI_TO_NOTE[NOTE_TO_SHRUTI[noteKey]];
        return { note: canonical, shruti: NOTE_TO_SHRUTI[canonical] };
      }
    }

    var indMatch = clean.match(/^([\d.]+)\s*([PMpm])?/i);
    if (indMatch) {
      var num = indMatch[1];
      var numMap = {
        "1": 0,
        "1.5": 1,
        "2": 2,
        "2.5": 3,
        "3": 4,
        "4": 5,
        "4.5": 6,
        "5": 7,
        "5.5": 8,
        "6": 9,
        "6.5": 10,
        "7": 11
      };
      if (numMap[num] !== undefined) {
        var idx = numMap[num];
        if (indMatch[2] && indMatch[2].toUpperCase() === "M") {
          if (num === "2.5") {
            idx = 7;
          } else {
            idx = (idx + 5) % 12;
          }
        }
        var resolvedNote = WESTERN_NOTES[idx];
        return { note: resolvedNote, shruti: NOTE_TO_SHRUTI[resolvedNote] };
      }
    }

    return { note: "C#", shruti: "1.5" };
  }

  async function transitionToSample(newFilename) {
    var ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch (_) {}
    }
    try {
      var buffer = await loadSample(newFilename);
      if (!state.isPlaying) return;

      var now = ctx.currentTime;
      var fadeDuration = state.transitionSec || 1.3;

      var newSrc = ctx.createBufferSource();
      newSrc.buffer = buffer;
      newSrc.loop = true;
      newSrc.playbackRate.setValueAtTime(1.0, now);

      var newGain = ctx.createGain();
      newGain.gain.setValueAtTime(0.0001, now);
      newGain.gain.linearRampToValueAtTime(1.0, now + fadeDuration);
      newSrc._fadeGain = newGain;

      newSrc.connect(newGain);
      newGain.connect(getTargetAudioInput());
      newSrc.start(0);

      if (activeSource && activeFadeGain) {
        var oldSrc = activeSource;
        var oldGain = activeFadeGain;
        var curVol = oldGain.gain.value;
        oldGain.gain.setValueAtTime(curVol, now);
        oldGain.gain.linearRampToValueAtTime(0.0001, now + fadeDuration);
        setTimeout(function () {
          try {
            oldSrc.stop(0);
            oldSrc.disconnect();
          } catch (_) {}
        }, Math.round((fadeDuration + 0.15) * 1000));
      }

      activeSource = newSrc;
      activeFadeGain = newGain;

      applySingleStringFilter();
      updateWidgetUiState();
    } catch (err) {
      console.error("Smooth Tanpura transition error:", err);
    }
  }

  function stopActiveSource() {
    if (activeSource && activeFadeGain && audioCtx) {
      try {
        var oldSrc = activeSource;
        var oldGain = activeFadeGain;
        activeSource = null;
        activeFadeGain = null;

        var now = audioCtx.currentTime;
        var curVol = oldGain.gain.value;
        oldGain.gain.setValueAtTime(curVol, now);
        oldGain.gain.linearRampToValueAtTime(0.0001, now + 0.35);
        setTimeout(function () {
          try {
            oldSrc.stop(0);
            oldSrc.disconnect();
          } catch (_) {}
        }, 400);
      } catch (_) {}
    }
  }

  async function startTanpura() {
    var ctx = getAudioContext();
    if (ctx && ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch (_) {}
    }
    state.isPlaying = true;
    updateWidgetUiState();
    var filename = getSampleFilename(state.pitchNote, state.firstString);
    await transitionToSample(filename);
    updateWidgetUiState();
  }

  function stopTanpura() {
    state.isPlaying = false;
    stopActiveSource();
    updateWidgetUiState();
    if (window.AppShell && typeof window.AppShell.syncContextualWidgets === "function") {
      window.AppShell.syncContextualWidgets();
    }
  }

  function toggleTanpura() {
    if (state.isPlaying) {
      stopTanpura();
    } else {
      startTanpura();
    }
  }

  function setPitch(pitchInput, optFirstString) {
    var parsed = parsePitchString(pitchInput);
    var changed =
      state.pitchNote !== parsed.note ||
      (optFirstString && state.firstString !== optFirstString);
    state.pitchNote = parsed.note;
    state.pitchNum = parsed.shruti;
    if (optFirstString && (optFirstString === "Pa" || optFirstString === "Ma")) {
      state.firstString = optFirstString;
    }

    updateWidgetUiDetails();

    if (state.isPlaying && changed) {
      var filename = getSampleFilename(state.pitchNote, state.firstString);
      transitionToSample(filename);
    }
  }

  function setFirstString(s) {
    if (s !== "Pa" && s !== "Ma") return;
    if (state.firstString === s) return;
    state.firstString = s;
    updateWidgetUiDetails();
    if (state.isPlaying) {
      var filename = getSampleFilename(state.pitchNote, state.firstString);
      transitionToSample(filename);
    }
  }

  function setTransitionSpeed(lvl) {
    var val = Math.max(1, Math.min(5, lvl || 3));
    state.transitionSpeedLevel = val;
    var cfg = TRANSITION_LEVELS[val] || TRANSITION_LEVELS[3];
    state.transitionSec = cfg.duration;

    var lbl = document.getElementById("tanpuraTransitionSpeedLabel");
    if (lbl) lbl.textContent = cfg.name;
  }

  function updateWidgetUiDetails() {
    var noteLabel = state.pitchNote + " (" + state.pitchNum + ")";

    var curPitchEl = document.getElementById("tanpuraCurrentPitchDisplay");
    if (curPitchEl) curPitchEl.textContent = noteLabel;

    var curNoteEl = document.getElementById("tanpuraNoteKeyBadge");
    if (curNoteEl) curNoteEl.textContent = state.pitchNote;

    document.querySelectorAll(".tanpura-pitch-btn").forEach(function (btn) {
      var p = btn.getAttribute("data-pitch");
      var isActive = p === state.pitchNote || p === state.pitchNum;
      btn.classList.toggle("active", isActive);
    });

    document.querySelectorAll(".tanpura-first-str-btn").forEach(function (btn) {
      var str = btn.getAttribute("data-string");
      btn.classList.toggle("active", str === state.firstString);
    });

    var swaraNames = {
      Pa: "Pa (Pancham)",
      Ma: "Ma (Madhyam)"
    };
    var swaraBadge = document.getElementById("singleStringSwaraBadge");
    if (swaraBadge) swaraBadge.textContent = swaraNames[state.firstString] || state.firstString;

    var statusBadge = document.getElementById("singleStringStatus");
    if (statusBadge) statusBadge.textContent = state.isPlaying ? "Resonating" : "Tuned";

    var card0 = document.getElementById("stringCard0");
    if (card0) card0.classList.toggle("is-resonating", state.isPlaying);
  }

  function updateWidgetUiState() {
    var widget = document.getElementById("tanpuraFloatingWidget");
    if (widget) {
      widget.classList.toggle("is-playing", state.isPlaying);
    }

    var playIcon = document.getElementById("tanpuraPlayIcon");
    var pauseIcon = document.getElementById("tanpuraPauseIcon");
    if (playIcon) playIcon.style.display = state.isPlaying ? "none" : "block";
    if (pauseIcon) pauseIcon.style.display = state.isPlaying ? "block" : "none";

    var statusEl = document.getElementById("tanpuraStatusText");
    if (statusEl) {
      statusEl.textContent = state.isPlaying ? "Drone Active" : "Tanpura";
    }

    var card0 = document.getElementById("stringCard0");
    if (card0) card0.classList.toggle("is-resonating", state.isPlaying);

    var statusBadge = document.getElementById("singleStringStatus");
    if (statusBadge) statusBadge.textContent = state.isPlaying ? "Resonating" : "Tuned";
  }

  function syncUi() {
    updateWidgetUiDetails();
    updateWidgetUiState();
    setTransitionSpeed(state.transitionSpeedLevel);
  }

  window.BhajanTanpura = {
    start: startTanpura,
    stop: stopTanpura,
    toggle: toggleTanpura,
    setPitch: setPitch,
    setFirstString: setFirstString,
    setTransitionSpeed: setTransitionSpeed,
    syncUi: syncUi,
    getState: function () {
      return Object.assign({}, state);
    },
    setVolume: function (v) {
      state.volume = Math.max(0, Math.min(1, v));
      if (masterGain && audioCtx) {
        masterGain.gain.setValueAtTime(state.volume, audioCtx.currentTime);
      }
    }
  };

  window.playTanpuraPitch = function (pitchStr, optFirstString) {
    var parsed = parsePitchString(pitchStr);
    setPitch(parsed.note, optFirstString);

    var widget = document.getElementById("tanpuraFloatingWidget");
    if (widget) {
      widget.classList.add("visible");
    }

    if (!state.isPlaying || !activeSource) {
      startTanpura();
    } else {
      var filename = getSampleFilename(state.pitchNote, state.firstString);
      transitionToSample(filename);
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", syncUi);
  } else {
    syncUi();
  }
})();
