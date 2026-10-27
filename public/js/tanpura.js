/**
 * Authentic Acoustic Tanpura & Shrutibox Audio Engine for Bhajan Planner
 * Powered by high-fidelity acoustic studio recordings of genuine Miraj Tanpuras.
 * Features an ultra-smooth seamless looping buffer with equal-power crossfading,
 * single-string drone (Sa / Pa / Ma), string change speed control,
 * and canonical Western base scale mapping (C, C#, D, D#, E, F, F#, G, G#, A, A#, B).
 */
(function() {
  'use strict';

  var WESTERN_NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  var NOTE_TO_SHRUTI = {
    'C': '1', 'C#': '1.5', 'DB': '1.5',
    'D': '2', 'D#': '2.5', 'EB': '2.5',
    'E': '3',
    'F': '4', 'F#': '4.5', 'GB': '4.5',
    'G': '5', 'G#': '5.5', 'AB': '5.5',
    'A': '6', 'A#': '6.5', 'BB': '6.5',
    'B': '7'
  };

  var SHRUTI_TO_NOTE = {
    '1': 'C', '1.5': 'C#',
    '2': 'D', '2.5': 'D#',
    '3': 'E',
    '4': 'F', '4.5': 'F#',
    '5': 'G', '5.5': 'G#',
    '6': 'A', '6.5': 'A#',
    '7': 'B'
  };

  var NOTE_TO_FILE = {
    'C': 'c', 'C#': 'cs',
    'D': 'd', 'D#': 'ds',
    'E': 'e',
    'F': 'f', 'F#': 'fs',
    'G': 'g', 'G#': 'gs',
    'A': 'a', 'A#': 'as',
    'B': 'b'
  };

  var NOTE_BASE_FREQS = {
    'C': 130.81, 'C#': 138.59,
    'D': 146.83, 'D#': 155.56,
    'E': 164.81,
    'F': 174.61, 'F#': 185.00,
    'G': 196.00, 'G#': 207.65,
    'A': 220.00, 'A#': 233.08,
    'B': 246.94
  };

  var TRANSITION_LEVELS = {
    1: { name: 'Lush & Slow', duration: 2.4 },
    2: { name: 'Gentle', duration: 1.8 },
    3: { name: 'Medium', duration: 1.3 },
    4: { name: 'Quick', duration: 0.9 },
    5: { name: 'Fast', duration: 0.5 }
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
    pitchNote: 'C#',          // 'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'
    pitchNum: '1.5',          // '1', '1.5', '2', etc.
    firstString: 'Pa',        // 'Pa' (Pancham) or 'Ma' (Madhyam)
    transitionSpeedLevel: 3,  // 1 to 5
    transitionSec: 1.3,       // crossfade time in seconds
    volume: 0.70              // 0.0 to 1.0
  };

  function getAudioContext() {
    if (!audioCtx) {
      audioCtx = new AudioContextClass();

      // Master volume gain node
      masterGain = audioCtx.createGain();
      masterGain.gain.setValueAtTime(state.volume, audioCtx.currentTime);

      // Acoustic wood body warm resonance shelf (+2.5dB at 180Hz)
      try {
        acousticWarmthFilter = audioCtx.createBiquadFilter();
        acousticWarmthFilter.type = 'lowshelf';
        acousticWarmthFilter.frequency.setValueAtTime(180, audioCtx.currentTime);
        acousticWarmthFilter.gain.setValueAtTime(2.5, audioCtx.currentTime);
        acousticWarmthFilter.connect(masterGain);
      } catch (e) {
        acousticWarmthFilter = null;
      }

      // Single string acoustic harmonic filter node
      try {
        singleStringFilterNode = audioCtx.createBiquadFilter();
        singleStringFilterNode.type = 'lowpass';
        singleStringFilterNode.frequency.setValueAtTime(16000, audioCtx.currentTime);
        singleStringFilterNode.Q.setValueAtTime(0.7, audioCtx.currentTime);
        var warmInput = acousticWarmthFilter || masterGain;
        singleStringFilterNode.connect(warmInput);
      } catch (e) {
        singleStringFilterNode = null;
      }

      masterGain.connect(audioCtx.destination);
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    return audioCtx;
  }

  function getTargetAudioInput() {
    getAudioContext();
    return singleStringFilterNode || acousticWarmthFilter || masterGain;
  }

  /**
   * Applies acoustic filter shaping based on selected string swara
   */
  function applySingleStringFilter() {
    if (!singleStringFilterNode || !audioCtx) return;
    var baseFreq = (NOTE_BASE_FREQS[state.pitchNote] || 138.59);
    var now = audioCtx.currentTime;
    var rampTime = 0.35; // smooth 350ms glide

    if (state.firstString === 'Ma') {
      singleStringFilterNode.type = 'lowpass';
      singleStringFilterNode.frequency.setTargetAtTime(14000, now, rampTime);
      singleStringFilterNode.Q.setTargetAtTime(0.85, now, rampTime);
    } else {
      // Pancham (Pa): Full rich acoustic harmonic spread
      singleStringFilterNode.type = 'lowpass';
      singleStringFilterNode.frequency.setTargetAtTime(16000, now, rampTime);
      singleStringFilterNode.Q.setTargetAtTime(0.7, now, rampTime);
    }
  }

  function getSampleFilename(pitchNote, swara) {
    var base = NOTE_TO_FILE[pitchNote] || 'cs';
    if (swara === 'Ma') {
      return 'm' + base;
    }
    return base;
  }

  /**
   * Creates an ultra-smooth, continuous looping buffer with equal-power sine/cosine crossfade.
   * Blends the decaying tail into the head to eliminate step discontinuities (clicks/pops)
   * and repeats the seamless cycle so the audio never feels short or breaking.
   */
  function createSeamlessLoopBuffer(ctx, rawBuffer, crossfadeDurationSec, repeatCount) {
    var fadeSec = crossfadeDurationSec || 1.4;
    var repeats = repeatCount || 2;
    var sampleRate = rawBuffer.sampleRate;
    var numChannels = rawBuffer.numberOfChannels;

    var maxFade = Math.min(fadeSec, rawBuffer.duration * 0.28);
    var fadeSamples = Math.round(maxFade * sampleRate);
    var unitLength = rawBuffer.length - fadeSamples;

    if (unitLength <= sampleRate) {
      return rawBuffer;
    }

    var totalLength = unitLength * repeats;
    var seamlessBuffer = ctx.createBuffer(numChannels, totalLength, sampleRate);

    for (var ch = 0; ch < numChannels; ch++) {
      var rawData = rawBuffer.getChannelData(ch);
      var outData = seamlessBuffer.getChannelData(ch);

      // 1. Build one seamless unit block
      var unitBlock = new Float32Array(unitLength);
      for (var i = 0; i < unitLength; i++) {
        unitBlock[i] = rawData[i];
      }

      // Equal-power crossfade tail into head
      for (var j = 0; j < fadeSamples; j++) {
        var headVal = rawData[j];
        var tailVal = rawData[unitLength + j];
        var t = j / fadeSamples;
        var wHead = Math.sin(t * Math.PI * 0.5);
        var wTail = Math.cos(t * Math.PI * 0.5);
        unitBlock[j] = headVal * wHead + tailVal * wTail;
      }

      // 2. Tile the seamless unit block across the output buffer
      for (var rep = 0; rep < repeats; rep++) {
        outData.set(unitBlock, rep * unitLength);
      }
    }

    return seamlessBuffer;
  }

  /**
   * Load, decode, and transform audio into a studio-grade seamless looping buffer
   */
  function loadSample(filename) {
    if (bufferCache.has(filename)) {
      return Promise.resolve(bufferCache.get(filename));
    }
    if (loadingPromises.has(filename)) {
      return loadingPromises.get(filename);
    }

    var ctx = getAudioContext();
    var url = '/audio/tanpura/' + filename + '.wav';

    var p = fetch(url)
      .then(function(res) {
        if (!res.ok) throw new Error('Failed to load tanpura audio: ' + url);
        return res.arrayBuffer();
      })
      .then(function(arrayBuf) {
        return new Promise(function(resolve, reject) {
          ctx.decodeAudioData(arrayBuf, resolve, reject);
        });
      })
      .then(function(decodedBuffer) {
        var seamless = createSeamlessLoopBuffer(ctx, decodedBuffer, 1.4, 2);
        bufferCache.set(filename, seamless);
        loadingPromises.delete(filename);
        return seamless;
      })
      .catch(function(err) {
        loadingPromises.delete(filename);
        console.warn('Acoustic Tanpura load warning:', err.message);
        throw err;
      });

    loadingPromises.set(filename, p);
    return p;
  }

  function preloadKeyPitches() {
    setTimeout(function() {
      loadSample('cs').catch(function() {});
      loadSample('g').catch(function() {});
      loadSample('d').catch(function() {});
      loadSample('mcs').catch(function() {});
    }, 800);
  }

  /**
   * Parses pitch input string into Western note and Indian Shruti number.
   * Accurately converts Indian harmonium shrutis (e.g. 2.5M -> G, 5P -> G) to the Western base scale,
   * without altering string swara selection.
   */
  function parsePitchString(str) {
    if (!str) return { note: 'C#', shruti: '1.5' };
    var clean = String(str).trim();

    // 1. Direct Western note match (e.g. "C", "C#", "Db", "D", "D#", "Eb", "E", "F", "F#", "Gb", "G", "G#", "Ab", "A", "A#", "Bb", "B")
    var westMatch = clean.match(/^([A-Ga-g])(#|b|s)?/i);
    if (westMatch) {
      var letter = westMatch[1].toUpperCase();
      var acc = (westMatch[2] || '').toUpperCase();
      if (acc === 'S') acc = '#';
      var noteKey = letter + acc;
      if (NOTE_TO_SHRUTI[noteKey]) {
        var canonical = SHRUTI_TO_NOTE[NOTE_TO_SHRUTI[noteKey]];
        return { note: canonical, shruti: NOTE_TO_SHRUTI[canonical] };
      }
    }

    // 2. Indian notation parsing (e.g. "2.5M", "5P", "1.5", "4M", etc.)
    var indMatch = clean.match(/^([\d\.]+)\s*([PMpm])?/i);
    if (indMatch) {
      var num = indMatch[1];
      var numMap = {'1':0, '1.5':1, '2':2, '2.5':3, '3':4, '4':5, '4.5':6, '5':7, '5.5':8, '6':9, '6.5':10, '7':11};
      if (numMap[num] !== undefined) {
        var idx = numMap[num];
        // If 'M' suffix, harmonium scale is shifted by 5 semitones (e.g. 2.5M -> G)
        if (indMatch[2] && indMatch[2].toUpperCase() === 'M') {
          // Special handling: 2.5M in Sai bhajans standardizes to G
          if (num === '2.5') {
            idx = 7; // G
          } else {
            idx = (idx + 5) % 12;
          }
        }
        var resolvedNote = WESTERN_NOTES[idx];
        return { note: resolvedNote, shruti: NOTE_TO_SHRUTI[resolvedNote] };
      }
    }

    return { note: 'C#', shruti: '1.5' };
  }

  /**
   * Smooth Overlapping Crossfade for string/pitch transitions
   */
  async function transitionToSample(newFilename) {
    var ctx = getAudioContext();
    if (ctx && ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch (_) {}
    }
    try {
      var buffer = await loadSample(newFilename);
      if (!state.isPlaying) return;

      var now = ctx.currentTime;
      var fadeDuration = state.transitionSec || 1.3;

      // Create new buffer source node
      var newSrc = ctx.createBufferSource();
      newSrc.buffer = buffer;
      newSrc.loop = true;
      newSrc.playbackRate.setValueAtTime(1.0, now);

      // Dedicated crossfade gain node starting silent
      var newGain = ctx.createGain();
      newGain.gain.setValueAtTime(0.0001, now);
      newGain.gain.linearRampToValueAtTime(1.0, now + fadeDuration);
      newSrc._fadeGain = newGain;

      newSrc.connect(newGain);
      newGain.connect(getTargetAudioInput());
      newSrc.start(0);

      // Smoothly fade out previous active source without abrupt cuts
      if (activeSource && activeFadeGain) {
        var oldSrc = activeSource;
        var oldGain = activeFadeGain;
        var curVol = oldGain.gain.value;
        oldGain.gain.setValueAtTime(curVol, now);
        oldGain.gain.linearRampToValueAtTime(0.0001, now + fadeDuration);
        setTimeout(function() {
          try {
            oldSrc.stop(0);
            oldSrc.disconnect();
          } catch (e) {}
        }, Math.round((fadeDuration + 0.15) * 1000));
      }

      activeSource = newSrc;
      activeFadeGain = newGain;

      applySingleStringFilter();
      updateWidgetUiState();
    } catch (err) {
      console.error('Smooth Tanpura transition error:', err);
    }
  }

  /**
   * Stop currently ringing acoustic source smoothly
   */
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
        oldGain.gain.linearRampToValueAtTime(0.0001, now + 0.35); // smooth 350ms release
        setTimeout(function() {
          try {
            oldSrc.stop(0);
            oldSrc.disconnect();
          } catch (e) {}
        }, 400);
      } catch (e) {}
    }
  }

  async function startTanpura() {
    var ctx = getAudioContext();
    if (ctx && ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch (_) {}
    }
    state.isPlaying = true;
    var filename = getSampleFilename(state.pitchNote, state.firstString);
    await transitionToSample(filename);
    updateWidgetUiState();
  }

  function stopTanpura() {
    state.isPlaying = false;
    stopActiveSource();
    updateWidgetUiState();
  }

  function toggleTanpura() {
    if (state.isPlaying) {
      stopTanpura();
    } else {
      startTanpura();
    }
  }

  /**
   * Sets Pitch from Western note (e.g. 'G', 'C#') or Indian Shruti (e.g. '5', '1.5')
   */
  function setPitch(pitchInput, optFirstString) {
    var parsed = parsePitchString(pitchInput);
    var changed = (state.pitchNote !== parsed.note || (optFirstString && state.firstString !== optFirstString));
    state.pitchNote = parsed.note;
    state.pitchNum = parsed.shruti;
    if (optFirstString && (optFirstString === 'Pa' || optFirstString === 'Ma')) {
      state.firstString = optFirstString;
    }

    updateWidgetUiDetails();

    if (state.isPlaying && changed) {
      var filename = getSampleFilename(state.pitchNote, state.firstString);
      transitionToSample(filename);
    }
  }

  /**
   * Configures Single String Swara: Pa or Ma
   */
  function setFirstString(s) {
    if (s !== 'Pa' && s !== 'Ma') return;
    if (state.firstString === s) return;
    state.firstString = s;
    updateWidgetUiDetails();
    if (state.isPlaying) {
      var filename = getSampleFilename(state.pitchNote, state.firstString);
      transitionToSample(filename);
    }
  }

  /**
   * Sets String Change Speed (1: Lush/Slow, 3: Medium, 5: Fast)
   */
  function setTransitionSpeed(lvl) {
    var val = Math.max(1, Math.min(5, lvl || 3));
    state.transitionSpeedLevel = val;
    var cfg = TRANSITION_LEVELS[val] || TRANSITION_LEVELS[3];
    state.transitionSec = cfg.duration;

    var lbl = document.getElementById('tanpuraTransitionSpeedLabel');
    if (lbl) lbl.textContent = cfg.name;
  }

  function updateWidgetUiDetails() {
    var noteLabel = state.pitchNote + ' (' + state.pitchNum + ')';

    var curPitchEl = document.getElementById('tanpuraCurrentPitchDisplay');
    if (curPitchEl) curPitchEl.textContent = noteLabel;

    var curNoteEl = document.getElementById('tanpuraNoteKeyBadge');
    if (curNoteEl) curNoteEl.textContent = state.pitchNote;

    // Pitch buttons (Western base scale)
    document.querySelectorAll('.tanpura-pitch-btn').forEach(function(btn) {
      var p = btn.getAttribute('data-pitch');
      var isActive = (p === state.pitchNote || p === state.pitchNum);
      btn.classList.toggle('active', isActive);
    });

    // Swara chips (Pa / Ma only)
    document.querySelectorAll('.tanpura-first-str-btn').forEach(function(btn) {
      var str = btn.getAttribute('data-string');
      btn.classList.toggle('active', str === state.firstString);
    });

    // Single string identity & badge
    var swaraNames = {
      'Pa': 'Pa (Pancham)',
      'Ma': 'Ma (Madhyam)'
    };
    var swaraBadge = document.getElementById('singleStringSwaraBadge');
    if (swaraBadge) swaraBadge.textContent = swaraNames[state.firstString] || state.firstString;

    var statusBadge = document.getElementById('singleStringStatus');
    if (statusBadge) statusBadge.textContent = state.isPlaying ? 'Resonating' : 'Tuned';

    var card0 = document.getElementById('stringCard0');
    if (card0) card0.classList.toggle('is-resonating', state.isPlaying);
  }

  function updateWidgetUiState() {
    var widget = document.getElementById('tanpuraFloatingWidget');
    if (widget) {
      widget.classList.toggle('is-playing', state.isPlaying);
    }

    var playIcon = document.getElementById('tanpuraPlayIcon');
    var pauseIcon = document.getElementById('tanpuraPauseIcon');
    if (playIcon) playIcon.style.display = state.isPlaying ? 'none' : 'block';
    if (pauseIcon) pauseIcon.style.display = state.isPlaying ? 'block' : 'none';

    var statusEl = document.getElementById('tanpuraStatusText');
    if (statusEl) {
      statusEl.textContent = state.isPlaying ? 'Drone Active' : 'Tanpura';
    }

    var card0 = document.getElementById('stringCard0');
    if (card0) card0.classList.toggle('is-resonating', state.isPlaying);

    var statusBadge = document.getElementById('singleStringStatus');
    if (statusBadge) statusBadge.textContent = state.isPlaying ? 'Resonating' : 'Tuned';
  }

  // Public Global API
  window.BhajanTanpura = {
    start: startTanpura,
    stop: stopTanpura,
    toggle: toggleTanpura,
    setPitch: setPitch,
    setFirstString: setFirstString,
    setTransitionSpeed: setTransitionSpeed,
    getState: function() { return Object.assign({}, state); },
    setVolume: function(v) {
      state.volume = Math.max(0, Math.min(1, v));
      if (masterGain && audioCtx) {
        masterGain.gain.setValueAtTime(state.volume, audioCtx.currentTime);
      }
    }
  };

  /**
   * Convenience trigger used by Card Pitch Capsules, Details, and Submit Form
   */
  window.playTanpuraPitch = function(pitchStr, optFirstString) {
    var parsed = parsePitchString(pitchStr);
    setPitch(parsed.note, optFirstString);

    var widget = document.getElementById('tanpuraFloatingWidget');
    if (widget) {
      widget.classList.add('visible');
    }

    if (!state.isPlaying || !activeSource) {
      startTanpura();
    } else {
      var filename = getSampleFilename(state.pitchNote, state.firstString);
      transitionToSample(filename);
    }
  };

  function initTanpuraEngine() {
    updateWidgetUiDetails();
    updateWidgetUiState();
    setTransitionSpeed(3);
    preloadKeyPitches();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTanpuraEngine);
  } else {
    initTanpuraEngine();
  }

})();
