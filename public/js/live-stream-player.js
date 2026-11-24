/**
 * Bhajan Planner - Persistent Devotee Live Audio Player
 * Lives at top-level App Shell so live bhajan audio continues uninterrupted
 * while devotees switch tabs, read lyrics, or lock their phone screen.
 */
(function (window, document) {
  "use strict";

  let liveAudio = null;
  let currentState = {
    isLive: false,
    title: "Live Bhajan Session",
    bitrateKbps: 320,
    accessMode: "public",
    canListen: true,
    nowSinging: null,
    listenerCount: 0
  };
  let userDismissedBar = false;
  let isPlaying = false;
  let reconnectTimer = null;
  let sse = null;

  function ensureLiveBarDom() {
    if (document.getElementById("stickyLiveStreamBar")) return;

    const bar = document.createElement("div");
    bar.id = "stickyLiveStreamBar";
    bar.className = "sticky-live-bar";
    bar.setAttribute("role", "region");
    bar.setAttribute("aria-label", "Live Bhajan Stream Player");

    bar.innerHTML = [
      '<div class="live-bar-row">',
      '  <div class="live-bar-info">',
      '    <span class="live-bar-badge"><span class="shell-live-dot"></span> LIVE <span id="liveBarBitrate">320k</span></span>',
      '    <div class="live-bar-text">',
      '      <h4 class="live-bar-title" id="liveBarTitle">Live Bhajan Session</h4>',
      '      <p class="live-bar-sub" id="liveBarSub">Tap play to listen live</p>',
      "    </div>",
      "  </div>",
      '  <div class="live-bar-actions">',
      '    <button type="button" class="live-lyrics-btn" id="liveBarLyricsBtn" style="display:none;">Read Lyrics</button>',
      '    <div class="live-vol-wrap">',
      '      <input type="range" class="live-vol-range" id="liveBarVol" min="0" max="100" value="95" aria-label="Live stream volume">',
      "    </div>",
      '    <button type="button" class="live-play-btn" id="liveBarPlayBtn" aria-label="Play or stop live stream" title="Play / Stop">',
      '      <span id="livePlayIcon"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg></span>',
      '      <span id="liveStopIcon" style="display:none;"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"/></svg></span>',
      "    </button>",
      '    <button type="button" class="live-close-btn" id="liveBarCloseBtn" aria-label="Dismiss live bar" title="Hide bar">&times;</button>',
      "  </div>",
      "</div>"
    ].join("\n");

    document.body.appendChild(bar);

    const playBtn = document.getElementById("liveBarPlayBtn");
    if (playBtn) playBtn.onclick = togglePlay;

    const closeBtn = document.getElementById("liveBarCloseBtn");
    if (closeBtn) {
      closeBtn.onclick = function () {
        stopPlayback();
        userDismissedBar = true;
        hideBarDom();
      };
    }

    const volEl = document.getElementById("liveBarVol");
    if (volEl) {
      volEl.oninput = function () {
        if (liveAudio) liveAudio.volume = Math.max(0, Math.min(1, Number(this.value) / 100));
      };
    }

    const lyricsBtn = document.getElementById("liveBarLyricsBtn");
    if (lyricsBtn) lyricsBtn.onclick = openNowSingingLyrics;
  }

  function showBarDom() {
    ensureLiveBarDom();
    const bar = document.getElementById("stickyLiveStreamBar");
    if (bar) {
      bar.classList.add("is-visible");
      bar.setAttribute("aria-hidden", "false");
    }
  }

  function hideBarDom() {
    const bar = document.getElementById("stickyLiveStreamBar");
    if (bar) {
      bar.classList.remove("is-visible");
      bar.setAttribute("aria-hidden", "true");
    }
  }

  function updatePlayButtonUi() {
    const pIcon = document.getElementById("livePlayIcon");
    const sIcon = document.getElementById("liveStopIcon");
    if (pIcon) pIcon.style.display = isPlaying ? "none" : "inline-flex";
    if (sIcon) sIcon.style.display = isPlaying ? "inline-flex" : "none";

    const pill = document.getElementById("shellLivePill");
    if (pill) {
      pill.classList.toggle("is-playing", isPlaying);
    }
  }

  function updateMediaSession() {
    if (!("mediaSession" in navigator)) return;
    try {
      const ns = currentState.nowSinging;
      const title = ns && ns.title ? ns.title : currentState.title || "Live Bhajan Session";
      const artist =
        ns && ns.singerName ? `Singing: ${ns.singerName}` : "Sri Sathya Sai Seva Organisation";
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title,
        artist,
        album: "Bhajan Planner Live Stream",
        artwork: [{ src: "/images/icons/icon-192x192.png", sizes: "192x192", type: "image/png" }]
      });
      navigator.mediaSession.setActionHandler("play", startPlayback);
      navigator.mediaSession.setActionHandler("pause", stopPlayback);
      navigator.mediaSession.setActionHandler("stop", stopPlayback);
    } catch (_) {}
  }

  function renderStateUi() {
    const pill = document.getElementById("shellLivePill");
    if (pill) {
      pill.style.display = currentState.isLive ? "inline-flex" : "none";
      const pillLabel = document.getElementById("shellLivePillLabel");
      if (pillLabel) {
        pillLabel.textContent = isPlaying ? "LIVE · Playing" : "LIVE";
      }
    }

    if (!currentState.isLive) {
      if (isPlaying) stopPlayback();
      hideBarDom();
      return;
    }

    if (document.getElementById("stickyLiveStreamBar") || !userDismissedBar) {
      ensureLiveBarDom();
    }

    const bitrateEl = document.getElementById("liveBarBitrate");
    if (bitrateEl) bitrateEl.textContent = `${currentState.bitrateKbps || 320}k`;

    const titleEl = document.getElementById("liveBarTitle");
    const subEl = document.getElementById("liveBarSub");
    const lyricsBtn = document.getElementById("liveBarLyricsBtn");

    const ns = currentState.nowSinging;
    if (titleEl) {
      titleEl.textContent = ns && ns.title ? ns.title : currentState.title || "Live Bhajan Session";
    }
    if (subEl) {
      if (currentState.canListen === false) {
        subEl.textContent = "Sign in via Singer Hub to listen to this private stream";
      } else if (ns && ns.singerName) {
        subEl.textContent = `${ns.singerName} · ${currentState.listenerCount || 0} listening`;
      } else {
        subEl.textContent = `${currentState.title || "Live Satsang"} · ${currentState.listenerCount || 0} listening`;
      }
    }
    if (lyricsBtn) {
      if (ns && ns.masterId) {
        lyricsBtn.style.display = "inline-flex";
        lyricsBtn.setAttribute("data-master-id", String(ns.masterId));
      } else {
        lyricsBtn.style.display = "none";
      }
    }

    updatePlayButtonUi();
    if (isPlaying) updateMediaSession();
  }

  function startPlayback() {
    if (!currentState.isLive) return;
    if (currentState.canListen === false) {
      if (window.AppShell && typeof window.AppShell.navigate === "function") {
        window.AppShell.navigate("/singer/login");
      } else {
        window.location.href = "/singer/login";
      }
      return;
    }

    if (window.SessionAudioPlayer && typeof window.SessionAudioPlayer.close === "function") {
      try {
        window.SessionAudioPlayer.close();
      } catch (_) {}
    }

    showBarDom();
    if (!liveAudio) {
      liveAudio = new Audio();
      liveAudio.preload = "none";
      liveAudio.addEventListener("playing", function () {
        isPlaying = true;
        updatePlayButtonUi();
        renderStateUi();
      });
      liveAudio.addEventListener("pause", function () {
        isPlaying = false;
        updatePlayButtonUi();
      });
      liveAudio.addEventListener("error", function () {
        if (isPlaying && currentState.isLive) {
          clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => {
            if (currentState.isLive && isPlaying) startPlayback();
          }, 2200);
        }
      });
    }

    const volEl = document.getElementById("liveBarVol");
    if (volEl) liveAudio.volume = Math.max(0, Math.min(1, Number(volEl.value) / 100));

    liveAudio.src = `/api/live-stream/audio?t=${Date.now()}`;
    const playPromise = liveAudio.play();
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch(() => {
        isPlaying = false;
        updatePlayButtonUi();
      });
    }
    isPlaying = true;
    updateMediaSession();
    renderStateUi();
  }

  function stopPlayback() {
    clearTimeout(reconnectTimer);
    isPlaying = false;
    if (liveAudio) {
      try {
        liveAudio.pause();
        liveAudio.removeAttribute("src");
        liveAudio.load();
      } catch (_) {}
    }
    updatePlayButtonUi();
    renderStateUi();
  }

  function togglePlay() {
    if (isPlaying) {
      stopPlayback();
    } else {
      startPlayback();
    }
  }

  function openNowSingingLyrics() {
    const ns = currentState.nowSinging;
    if (!ns || !ns.masterId) return;
    const url = `/bhajan/${ns.masterId}`;
    if (window.AppShell && typeof window.AppShell.navigate === "function") {
      window.AppShell.navigate(url);
    } else {
      window.location.href = url;
    }
  }

  function handleIncomingState(nextState, autoOpenIfRequested) {
    if (!nextState) return;
    currentState = Object.assign({}, currentState, nextState);
    if (currentState.isLive && (autoOpenIfRequested || !userDismissedBar)) {
      showBarDom();
    }
    renderStateUi();
    if (autoOpenIfRequested && currentState.isLive && !isPlaying) {
      startPlayback();
    }
  }

  async function initLivePlayer() {
    const params = new URLSearchParams(window.location.search || "");
    const wantsAutoLive = params.get("live") === "1";

    try {
      const res = await fetch("/api/live-stream/status", { credentials: "same-origin" });
      if (res.ok) {
        const data = await res.json();
        handleIncomingState(data, wantsAutoLive);
      }
    } catch (_) {}

    if (typeof EventSource === "function") {
      sse = new EventSource("/api/live-stream/events");
      sse.addEventListener("status", function (ev) {
        try {
          const parsed = JSON.parse(ev.data);
          // Preserve canListen accurately via quick status fetch on transition
          const becameLive = !currentState.isLive && parsed.isLive;
          currentState = Object.assign({}, currentState, parsed);
          if (becameLive) {
            userDismissedBar = false;
            showBarDom();
          }
          renderStateUi();
        } catch (_) {}
      });
    }

    const pill = document.getElementById("shellLivePill");
    if (pill) {
      pill.onclick = function () {
        userDismissedBar = false;
        showBarDom();
        togglePlay();
      };
    }
  }

  window.LiveStreamPlayer = {
    openBar: function () {
      userDismissedBar = false;
      showBarDom();
      renderStateUi();
    },
    togglePlay,
    play: startPlayback,
    stop: stopPlayback,
    openLyrics: openNowSingingLyrics,
    getState: function () {
      return Object.assign({}, currentState, { isPlaying });
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initLivePlayer);
  } else {
    initLivePlayer();
  }
})(window, document);
