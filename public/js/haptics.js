/**
 * Premium Haptic Feedback Engine — Bhajan Planner Native App Experience
 * Single top-window AudioContext with zero scroll-gesture overhead.
 */
(function (window) {
  "use strict";

  var VIBE_PROFILES = {
    selection: [3],
    tick: [3],
    light: [5],
    medium: [8],
    heavy: [14],
    rigid: [10],
    toggle: [4, 16, 6],
    success: [4, 30, 8],
    warning: [7, 35, 7],
    error: [8, 25, 8, 25, 12],
    pop: [3, 16, 6]
  };

  var AUDIO_PROFILES = {
    selection: { freq: 140, endFreq: 45, duration: 0.007, gain: 0.12, type: "sine" },
    tick: { freq: 140, endFreq: 45, duration: 0.007, gain: 0.12, type: "sine" },
    light: { freq: 125, endFreq: 40, duration: 0.01, gain: 0.18, type: "sine" },
    medium: { freq: 100, endFreq: 30, duration: 0.014, gain: 0.25, type: "sine" },
    heavy: { freq: 85, endFreq: 25, duration: 0.018, gain: 0.32, type: "triangle" },
    rigid: { freq: 110, endFreq: 35, duration: 0.012, gain: 0.22, type: "square" },
    toggle: { freq: 130, endFreq: 50, duration: 0.011, gain: 0.2, type: "sine" },
    success: { freq: 160, endFreq: 220, duration: 0.024, gain: 0.22, type: "sine", double: true },
    warning: { freq: 95, endFreq: 80, duration: 0.016, gain: 0.24, type: "triangle" },
    error: { freq: 75, endFreq: 30, duration: 0.022, gain: 0.28, type: "sawtooth" },
    pop: { freq: 175, endFreq: 90, duration: 0.012, gain: 0.22, type: "sine" }
  };

  var hasVibration = typeof navigator !== "undefined" && "vibrate" in navigator;
  var isEnabled = true;
  var isSoundEnabled = true;
  var lastHapticTime = 0;
  var audioCtx = null;
  var isChildFrame = false;

  try {
    isChildFrame = !!(window.parent && window.parent !== window);
  } catch (_) {
    isChildFrame = false;
  }

  try {
    var storedVibe = localStorage.getItem("bp_haptics_enabled");
    if (storedVibe !== null) isEnabled = storedVibe === "true";
    var storedSound = localStorage.getItem("bp_haptics_sound");
    if (storedSound !== null) isSoundEnabled = storedSound === "true";
  } catch (_) {}

  function getAudioContext() {
    if (isChildFrame) return null;
    if (!audioCtx && typeof window !== "undefined") {
      try {
        var AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (AudioContextClass) {
          audioCtx = new AudioContextClass();
        }
      } catch (_) {}
    }
    if (audioCtx && audioCtx.state === "suspended") {
      audioCtx.resume().catch(function () {});
    }
    return audioCtx;
  }

  function playTactileTransient(profileName) {
    if (!isSoundEnabled || isChildFrame) return;
    var ctx = getAudioContext();
    if (!ctx) return;

    var profile = AUDIO_PROFILES[profileName] || AUDIO_PROFILES.light;
    var now = ctx.currentTime;

    try {
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();

      osc.type = profile.type || "sine";
      osc.frequency.setValueAtTime(profile.freq, now);
      osc.frequency.exponentialRampToValueAtTime(
        Math.max(10, profile.endFreq),
        now + profile.duration
      );

      gain.gain.setValueAtTime(profile.gain, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + profile.duration);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + profile.duration);

      if (profile.double) {
        setTimeout(function () {
          if (!audioCtx) return;
          var t = audioCtx.currentTime;
          var osc2 = audioCtx.createOscillator();
          var gain2 = audioCtx.createGain();
          osc2.type = "sine";
          osc2.frequency.setValueAtTime(260, t);
          osc2.frequency.exponentialRampToValueAtTime(140, t + 0.016);
          gain2.gain.setValueAtTime(profile.gain * 0.9, t);
          gain2.gain.exponentialRampToValueAtTime(0.0001, t + 0.016);
          osc2.connect(gain2);
          gain2.connect(audioCtx.destination);
          osc2.start(t);
          osc2.stop(t + 0.016);
        }, 32);
      }
    } catch (_) {}
  }

  function triggerHaptic(type) {
    if (!isEnabled) return;

    var now = Date.now();
    if (now - lastHapticTime < 24) return;
    lastHapticTime = now;

    var profileKey = type || "light";

    if (isChildFrame) {
      try {
        window.parent.postMessage(
          { type: "BP_HAPTIC", profile: profileKey },
          window.location.origin
        );
      } catch (_) {}
      return;
    }

    var pattern = VIBE_PROFILES[profileKey] || VIBE_PROFILES.light;
    if (hasVibration) {
      try {
        navigator.vibrate(pattern);
      } catch (_) {}
    }

    playTactileTransient(profileKey);
  }

  if (typeof window !== "undefined" && !isChildFrame && !window.__bpHapticMsgBound) {
    window.__bpHapticMsgBound = true;
    window.addEventListener(
      "message",
      function (e) {
        if (e.origin && e.origin !== window.location.origin) return;
        if (e.data && e.data.type === "BP_HAPTIC" && typeof e.data.profile === "string") {
          triggerHaptic(e.data.profile);
        }
      },
      { passive: true }
    );
  }

  function setHapticsEnabled(enabled) {
    isEnabled = !!enabled;
    try {
      localStorage.setItem("bp_haptics_enabled", isEnabled ? "true" : "false");
    } catch (_) {}
  }

  function setSoundEnabled(enabled) {
    isSoundEnabled = !!enabled;
    try {
      localStorage.setItem("bp_haptics_sound", isSoundEnabled ? "true" : "false");
    } catch (_) {}
  }

  function isHapticsEnabled() {
    return isEnabled;
  }

  function isTactileSoundEnabled() {
    return isSoundEnabled;
  }

  function initAutoHaptics() {
    if (window.__bpAutoHapticsBound) return;
    window.__bpAutoHapticsBound = true;

    var touchStartX = 0;
    var touchStartY = 0;
    var activeTarget = null;
    var pointerId = null;

    document.addEventListener(
      "pointerdown",
      function (e) {
        if (!e.target || typeof e.target.closest !== "function") return;
        var target = e.target.closest(
          '[data-haptic], .nav-tab, .native-action-btn, .button, .btn, .btn-live, .deity-card, .filter-chip, .tab-btn, .hub-tab-btn, .sheet-link-pill, .bulletin-view-all-pill, .app-bulletin-card, button, input[type="submit"]'
        );
        if (!target) return;

        if (isSoundEnabled && !isChildFrame) {
          getAudioContext();
        }

        activeTarget = target;
        pointerId = e.pointerId;
        touchStartX = e.clientX || 0;
        touchStartY = e.clientY || 0;

        var isDirectTabOrChip =
          target.classList.contains("nav-tab") ||
          target.classList.contains("hub-tab-btn") ||
          target.classList.contains("tab-btn") ||
          target.classList.contains("filter-chip") ||
          target.classList.contains("native-action-btn") ||
          target.hasAttribute("data-instant-haptic");

        if (isDirectTabOrChip) {
          dispatchTargetHaptic(target);
          activeTarget = null;
        }
      },
      { passive: true }
    );

    document.addEventListener(
      "pointermove",
      function (e) {
        if (!activeTarget || e.pointerId !== pointerId) return;
        var dx = Math.abs((e.clientX || 0) - touchStartX);
        var dy = Math.abs((e.clientY || 0) - touchStartY);
        if (dx > 8 || dy > 8) {
          activeTarget = null;
        }
      },
      { passive: true }
    );

    document.addEventListener(
      "pointerup",
      function (e) {
        if (!activeTarget || e.pointerId !== pointerId) {
          activeTarget = null;
          return;
        }
        dispatchTargetHaptic(activeTarget);
        activeTarget = null;
      },
      { passive: true }
    );

    document.addEventListener(
      "pointercancel",
      function () {
        activeTarget = null;
      },
      { passive: true }
    );
  }

  function dispatchTargetHaptic(target) {
    if (!target) return;
    var custom = target.getAttribute("data-haptic");
    if (custom) {
      triggerHaptic(custom);
      return;
    }

    if (target.classList.contains("nav-tab") || target.classList.contains("hub-tab-btn")) {
      triggerHaptic("selection");
    } else if (
      target.classList.contains("native-action-btn") ||
      target.classList.contains("shell-theme-btn")
    ) {
      triggerHaptic("light");
    } else if (
      target.classList.contains("primary") ||
      target.classList.contains("primary-live-btn") ||
      target.classList.contains("singer-hub-hero-cta")
    ) {
      triggerHaptic("medium");
    } else if (
      target.classList.contains("secondary") ||
      target.classList.contains("secondary-live-btn")
    ) {
      triggerHaptic("light");
    } else if (
      target.classList.contains("filter-chip") ||
      target.classList.contains("deity-card")
    ) {
      triggerHaptic("selection");
    } else {
      triggerHaptic("light");
    }
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", initAutoHaptics);
    } else {
      initAutoHaptics();
    }
  }

  var api = {
    trigger: triggerHaptic,
    selection: function () {
      triggerHaptic("selection");
    },
    tick: function () {
      triggerHaptic("selection");
    },
    light: function () {
      triggerHaptic("light");
    },
    medium: function () {
      triggerHaptic("medium");
    },
    heavy: function () {
      triggerHaptic("heavy");
    },
    rigid: function () {
      triggerHaptic("rigid");
    },
    toggle: function () {
      triggerHaptic("toggle");
    },
    success: function () {
      triggerHaptic("success");
    },
    warning: function () {
      triggerHaptic("warning");
    },
    error: function () {
      triggerHaptic("error");
    },
    pop: function () {
      triggerHaptic("pop");
    },
    setEnabled: setHapticsEnabled,
    setSoundEnabled: setSoundEnabled,
    isEnabled: isHapticsEnabled,
    isSoundEnabled: isTactileSoundEnabled,
    PROFILES: VIBE_PROFILES
  };

  window.BPHaptics = api;
  window.haptics = api;
  window.triggerHaptic = triggerHaptic;
})(typeof window !== "undefined" ? window : this);
