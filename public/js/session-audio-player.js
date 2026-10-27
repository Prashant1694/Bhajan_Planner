/**
 * Bhajan Planner - Universal Session Audio Player
 * Handles streaming session audio, scrubbing, speed control,
 * and jumping to specific bhajan timestamps.
 */
(function (window) {
  'use strict';

  var audioElement = null;
  var currentSessionData = null;
  var currentTimestamps = [];
  var speeds = [1.0, 1.25, 1.5, 0.75];
  var speedIndex = 0;
  var isDraggingScrubber = false;

  function formatTime(sec) {
    if (sec == null || isNaN(sec)) return '00:00';
    var total = Math.max(0, Math.floor(sec));
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    var mm = (m < 10 ? '0' : '') + m;
    var ss = (s < 10 ? '0' : '') + s;
    if (h > 0) {
      var hh = (h < 10 ? '0' : '') + h;
      return hh + ':' + mm + ':' + ss;
    }
    return mm + ':' + ss;
  }

  function getOrCreateAudio() {
    if (!audioElement) {
      audioElement = new Audio();
      audioElement.preload = 'metadata';

      audioElement.addEventListener('timeupdate', onTimeUpdate);
      audioElement.addEventListener('play', function () { updatePlayPauseIcon(true); });
      audioElement.addEventListener('pause', function () { updatePlayPauseIcon(false); });
      audioElement.addEventListener('ended', function () { updatePlayPauseIcon(false); });
      audioElement.addEventListener('loadedmetadata', function () {
        var durEl = document.getElementById('stickyAudioDuration');
        if (durEl) durEl.textContent = formatTime(audioElement.duration);
        var slider = document.getElementById('stickyAudioSlider');
        if (slider) slider.max = Math.floor(audioElement.duration);
      });
    }
    return audioElement;
  }

  function ensurePlayerBarDom() {
    if (document.getElementById('stickySessionAudioBar')) return;

    var bar = document.createElement('div');
    bar.id = 'stickySessionAudioBar';
    bar.className = 'sticky-audio-bar';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Session Audio Player');

    bar.innerHTML = [
      '<!-- Scrubber Row -->',
      '<div class="audio-scrubber-wrap">',
      '  <span class="audio-time-label" id="stickyAudioCurrent">00:00</span>',
      '  <input type="range" class="audio-progress-slider" id="stickyAudioSlider" min="0" max="100" value="0" aria-label="Audio scrubber">',
      '  <span class="audio-time-label" id="stickyAudioDuration">00:00</span>',
      '</div>',
      '<!-- Controls Row -->',
      '<div class="audio-controls-row">',
      '  <!-- Left: Now Playing Info -->',
      '  <div class="audio-now-playing">',
      '    <div class="audio-track-icon">',
      '      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
      '    </div>',
      '    <div class="audio-track-details">',
      '      <h4 class="audio-track-title" id="stickyAudioTitle">Session Recording</h4>',
      '      <p class="audio-track-meta" id="stickyAudioMeta">Full Devotional Session</p>',
      '    </div>',
      '  </div>',
      '  <!-- Center: Playback Buttons -->',
      '  <div class="audio-center-buttons">',
      '    <button type="button" class="audio-ctrl-btn" onclick="window.SessionAudioPlayer.skip(-10)" title="Rewind 10 seconds" aria-label="Rewind 10 seconds">',
      '      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>',
      '    </button>',
      '    <button type="button" class="audio-play-pause-btn" id="stickyAudioPlayBtn" onclick="window.SessionAudioPlayer.togglePlay()" title="Play / Pause" aria-label="Play or pause recording">',
      '      <span id="stickyPlayIcon">',
      '        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
      '      </span>',
      '      <span id="stickyPauseIcon" style="display:none;">',
      '        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>',
      '      </span>',
      '    </button>',
      '    <button type="button" class="audio-ctrl-btn" onclick="window.SessionAudioPlayer.skip(10)" title="Forward 10 seconds" aria-label="Forward 10 seconds">',
      '      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
      '    </button>',
      '  </div>',
      '  <!-- Right: Speed, Marker jumper, Close -->',
      '  <div class="audio-secondary-actions">',
      '    <button type="button" class="audio-markers-btn" id="stickyMarkersBtn" onclick="window.SessionAudioPlayer.openMarkersMenu()" title="Jump to bhajan" aria-label="Jump to bhajan" aria-haspopup="dialog">',
      '      <svg class="marker-btn-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M4 6h16M4 12h16M4 18h7"/></svg>',
      '      <span id="stickyMarkersBtnText" class="marker-btn-text">Jump to Bhajan...</span>',
      '      <svg class="marker-btn-chevron" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>',
      '    </button>',
      '    <select class="audio-markers-select" id="stickyMarkersSelect" onchange="window.SessionAudioPlayer.onMarkerSelect(this.value)" style="display:none;" aria-hidden="true">',
      '      <option value="0">Jump to Bhajan...</option>',
      '    </select>',
      '    <button type="button" class="audio-speed-btn" id="stickySpeedBtn" onclick="window.SessionAudioPlayer.cycleSpeed()" title="Playback speed">1x</button>',
      '    <button type="button" class="audio-close-bar-btn" onclick="window.SessionAudioPlayer.close()" title="Dismiss player" aria-label="Close player">&times;</button>',
      '  </div>',
      '</div>'
    ].join('\n');

    document.body.appendChild(bar);
    ensureMarkersModalDom();

    // Bind scrubber events
    var slider = document.getElementById('stickyAudioSlider');
    if (slider) {
      slider.addEventListener('input', function () {
        isDraggingScrubber = true;
        var curEl = document.getElementById('stickyAudioCurrent');
        if (curEl) curEl.textContent = formatTime(slider.value);
      });
      slider.addEventListener('change', function () {
        isDraggingScrubber = false;
        if (audioElement) {
          audioElement.currentTime = parseFloat(slider.value);
        }
      });
    }
  }

  function onTimeUpdate() {
    if (!audioElement || isDraggingScrubber) return;
    var cur = audioElement.currentTime;
    var dur = audioElement.duration || 0;

    var curEl = document.getElementById('stickyAudioCurrent');
    if (curEl) curEl.textContent = formatTime(cur);

    var slider = document.getElementById('stickyAudioSlider');
    if (slider && dur > 0) {
      slider.value = Math.floor(cur);
    }

    // Determine current active bhajan marker
    if (currentTimestamps && currentTimestamps.length > 0) {
      var activeMarker = null;
      for (var i = 0; i < currentTimestamps.length; i++) {
        if (cur >= currentTimestamps[i].start_seconds) {
          activeMarker = currentTimestamps[i];
        } else {
          break;
        }
      }

      if (activeMarker) {
        var titleEl = document.getElementById('stickyAudioTitle');
        var metaEl = document.getElementById('stickyAudioMeta');
        if (titleEl && titleEl.textContent !== activeMarker.bhajan_title) {
          titleEl.textContent = activeMarker.bhajan_title;
        }
        var metaText = activeMarker.singer_name + (activeMarker.deity ? ' (' + activeMarker.deity + ')' : '');
        if (metaEl && metaEl.textContent !== metaText) {
          metaEl.textContent = metaText;
        }

        var selectEl = document.getElementById('stickyMarkersSelect');
        if (selectEl && selectEl.value !== String(activeMarker.start_seconds)) {
          selectEl.value = String(activeMarker.start_seconds);
        }
        var btnText = document.getElementById('stickyMarkersBtnText');
        if (btnText) {
          btnText.textContent = formatTime(activeMarker.start_seconds) + ' - ' + activeMarker.bhajan_title;
        }
        // Highlight active item in modal list
        var allItems = document.querySelectorAll('.marker-item');
        for (var mi = 0; mi < allItems.length; mi++) {
          if (allItems[mi].getAttribute('data-seconds') === String(activeMarker.start_seconds)) {
            allItems[mi].classList.add('is-active');
          } else {
            allItems[mi].classList.remove('is-active');
          }
        }
      }
    }
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function ensureMarkersModalDom() {
    if (document.getElementById('audioMarkersModal')) return;

    var modal = document.createElement('div');
    modal.id = 'audioMarkersModal';
    modal.className = 'audio-markers-modal';
    modal.setAttribute('aria-hidden', 'true');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'audioMarkersTitle');

    modal.innerHTML = [
      '<div class="audio-markers-backdrop" onclick="window.SessionAudioPlayer.closeMarkersMenu()"></div>',
      '<div class="audio-markers-sheet">',
      '  <div class="audio-markers-drag-handle" onclick="window.SessionAudioPlayer.closeMarkersMenu()" aria-label="Close sheet"></div>',
      '  <div class="audio-markers-header">',
      '    <div class="audio-markers-title-wrap">',
      '      <div class="audio-markers-icon-pill">',
      '        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
      '      </div>',
      '      <div>',
      '        <h3 id="audioMarkersTitle" class="audio-markers-heading">Jump to Bhajan</h3>',
      '        <p class="audio-markers-subheading">Tap any recorded bhajan in the sequence</p>',
      '      </div>',
      '    </div>',
      '    <button type="button" class="audio-markers-close-btn" onclick="window.SessionAudioPlayer.closeMarkersMenu()" aria-label="Close menu">&times;</button>',
      '  </div>',
      '  <div class="audio-markers-search-wrap">',
      '    <svg class="markers-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>',
      '    <input type="text" id="audioMarkersSearchInput" class="audio-markers-search-input" placeholder="Search bhajan or singer..." oninput="window.SessionAudioPlayer.filterMarkers(this.value)" autocomplete="off">',
      '  </div>',
      '  <div class="audio-markers-list" id="audioMarkersList">',
      '    <div class="markers-empty-state">No recorded timestamps available.</div>',
      '  </div>',
      '</div>'
    ].join('\n');

    document.body.appendChild(modal);

    // Keyboard ESC to close
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        var m = document.getElementById('audioMarkersModal');
        if (m && m.classList.contains('is-open')) {
          PlayerController.closeMarkersMenu();
        }
      }
    });
  }

  function updatePlayPauseIcon(isPlaying) {
    var playIcon = document.getElementById('stickyPlayIcon');
    var pauseIcon = document.getElementById('stickyPauseIcon');
    if (playIcon) playIcon.style.display = isPlaying ? 'none' : 'inline-block';
    if (pauseIcon) pauseIcon.style.display = isPlaying ? 'inline-block' : 'none';
  }

  function populateMarkersDropdown(timestamps) {
    ensureMarkersModalDom();
    var selectEl = document.getElementById('stickyMarkersSelect');
    var listEl = document.getElementById('audioMarkersList');
    var btnEl = document.getElementById('stickyMarkersBtn');

    if (selectEl) {
      selectEl.innerHTML = '<option value="0">Jump to Bhajan...</option>';
    }

    if (!timestamps || timestamps.length === 0) {
      if (btnEl) btnEl.style.display = 'none';
      if (selectEl) selectEl.style.display = 'none';
      if (listEl) {
        listEl.innerHTML = '<div class="markers-empty-state">No recorded bhajan markers for this session.</div>';
      }
      return;
    }

    if (btnEl) btnEl.style.display = 'inline-flex';

    var listHtml = [];
    timestamps.forEach(function (t, idx) {
      if (selectEl) {
        var opt = document.createElement('option');
        opt.value = t.start_seconds;
        opt.textContent = formatTime(t.start_seconds) + ' - ' + t.bhajan_title + ' (' + t.singer_name + ')';
        selectEl.appendChild(opt);
      }

      var isAarti = (t.deity || '').toLowerCase() === 'aarti' || (t.deity || '').toLowerCase() === 'aarthi' || (t.bhajan_title || '').toLowerCase().includes('aarti') || (t.bhajan_title || '').toLowerCase().includes('aarthi');
      var indexChipText = isAarti ? 'Aarthi' : ('#' + (idx + 1));

      listHtml.push(
        '<div class="marker-item' + (isAarti ? ' marker-item-aarti' : '') + '" id="markerItem_' + t.start_seconds + '" data-seconds="' + t.start_seconds + '" data-search="' + escapeHtml((t.bhajan_title + ' ' + t.singer_name + ' ' + (t.deity || '')).toLowerCase()) + '" onclick="window.SessionAudioPlayer.onMarkerClick(' + t.start_seconds + ', \'' + escapeHtml(t.bhajan_title).replace(/'/g, "\\'") + '\', \'' + escapeHtml(t.singer_name).replace(/'/g, "\\'") + '\')">' +
        '  <span class="marker-index-chip" style="' + (isAarti ? 'background:#fef3c7; color:#92400e; font-weight:700;' : '') + '">' + indexChipText + '</span>' +
        '  <span class="marker-time-badge">' + formatTime(t.start_seconds) + '</span>' +
        '  <div class="marker-info">' +
        '    <div class="marker-title">' + escapeHtml(t.bhajan_title) + '</div>' +
        '    <div class="marker-sub">' +
        '      <span class="marker-singer">' + escapeHtml(t.singer_name) + '</span>' +
        (t.deity ? '      <span class="marker-deity-pill" style="' + (isAarti ? 'background:#fef3c7; color:#92400e; border-color:#f59e0b;' : '') + '">' + escapeHtml(t.deity) + '</span>' : '') +
        '    </div>' +
        '  </div>' +
        '  <div class="marker-action-wrap">' +
        '    <svg class="marker-play-chevron" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>' +
        '    <div class="marker-equalizer-bars">' +
        '      <span></span><span></span><span></span>' +
        '    </div>' +
        '  </div>' +
        '</div>'
      );
    });

    if (listEl) {
      listEl.innerHTML = listHtml.join('\n');
    }
  }

  // Public Player Controller API
  var PlayerController = {
    /**
     * Initializes player with session data (alias for loadSession)
     */
    init: function (data) {
      return this.loadSession(data);
    },

    /**
     * Loads a session audio record and timestamps into player
     */
    loadSession: function (data) {
      if (!data || !data.audio_url) return;
      ensurePlayerBarDom();
      currentSessionData = data;
      currentTimestamps = (data.timestamps || []).sort(function (a, b) {
        return a.start_seconds - b.start_seconds;
      });

      var audio = getOrCreateAudio();
      if (audio.src !== data.audio_url) {
        audio.src = data.audio_url;
        try { audio.load(); } catch(e) {}
      }

      var titleEl = document.getElementById('stickyAudioTitle');
      var metaEl = document.getElementById('stickyAudioMeta');
      if (titleEl) titleEl.textContent = data.title || 'Session Recording';
      if (metaEl) metaEl.textContent = data.session_date ? 'Satsang – ' + data.session_date : 'Devotional Session';

      populateMarkersDropdown(currentTimestamps);
    },

    /**
     * Jumps to a specific timestamp and starts playback immediately
     */
    playAt: function (seconds, optTitle, optSinger, optAudioUrl) {
      ensurePlayerBarDom();
      var audio = getOrCreateAudio();

      if (optAudioUrl) {
        var resolvedUrl = optAudioUrl;
        try {
          resolvedUrl = new URL(optAudioUrl, window.location.href).href;
        } catch (_) {}
        if (audio.src !== resolvedUrl) {
          audio.src = resolvedUrl;
          try { audio.load(); } catch(e) {}
        }
      } else if (!audio.src && currentSessionData && currentSessionData.audio_url) {
        audio.src = currentSessionData.audio_url;
        try { audio.load(); } catch(e) {}
      }

      var bar = document.getElementById('stickySessionAudioBar');
      if (bar) bar.classList.add('is-visible');

      var targetSec = Math.max(0, parseInt(seconds, 10) || 0);

      if (optTitle) {
        var titleEl = document.getElementById('stickyAudioTitle');
        if (titleEl) titleEl.textContent = optTitle;
      }
      if (optSinger) {
        var metaEl = document.getElementById('stickyAudioMeta');
        if (metaEl) metaEl.textContent = optSinger;
      }

      function doPlay() {
        try {
          audio.currentTime = targetSec;
        } catch(e) {}
        var playPromise = audio.play();
        if (playPromise && playPromise.catch) {
          playPromise.catch(function (e) {
            console.warn('Audio play notice:', e.message);
          });
        }
      }

      if (audio.readyState >= 1) {
        doPlay();
      } else {
        var onLoaded = function () {
          audio.removeEventListener('loadedmetadata', onLoaded);
          audio.removeEventListener('canplay', onLoaded);
          audio.removeEventListener('loadeddata', onLoaded);
          doPlay();
        };
        audio.addEventListener('loadedmetadata', onLoaded);
        audio.addEventListener('canplay', onLoaded);
        audio.addEventListener('loadeddata', onLoaded);
        try { audio.load(); } catch(e) {}
      }
    },

    togglePlay: function () {
      var audio = getOrCreateAudio();
      if (!audio.src && currentSessionData && currentSessionData.audio_url) {
        audio.src = currentSessionData.audio_url;
        try { audio.load(); } catch(e) {}
      }
      if (audio.paused) {
        var p = audio.play();
        if (p && p.catch) {
          p.catch(function (e) { console.warn('Audio play error:', e.message); });
        }
      } else {
        audio.pause();
      }
    },

    skip: function (deltaSec) {
      var audio = getOrCreateAudio();
      audio.currentTime = Math.max(0, Math.min(audio.duration || 999999, audio.currentTime + deltaSec));
    },

    cycleSpeed: function () {
      speedIndex = (speedIndex + 1) % speeds.length;
      var newSpeed = speeds[speedIndex];
      var audio = getOrCreateAudio();
      audio.playbackRate = newSpeed;

      var btn = document.getElementById('stickySpeedBtn');
      if (btn) btn.textContent = newSpeed + 'x';
    },

    onMarkerSelect: function (secStr) {
      var sec = parseInt(secStr, 10) || 0;
      this.playAt(sec);
    },

    openMarkersMenu: function () {
      ensureMarkersModalDom();
      var m = document.getElementById('audioMarkersModal');
      if (m) {
        m.classList.add('is-open');
        m.setAttribute('aria-hidden', 'false');
        var input = document.getElementById('audioMarkersSearchInput');
        if (input) {
          input.value = '';
          this.filterMarkers('');
          setTimeout(function () {
            try { input.focus(); } catch(_) {}
          }, 150);
        }
        var activeEl = document.querySelector('.marker-item.is-active');
        if (activeEl) {
          try {
            activeEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          } catch(_) {}
        }
      }
    },

    closeMarkersMenu: function () {
      var m = document.getElementById('audioMarkersModal');
      if (m) {
        m.classList.remove('is-open');
        m.setAttribute('aria-hidden', 'true');
      }
    },

    toggleMarkersSheet: function () {
      var m = document.getElementById('audioMarkersModal');
      if (m && m.classList.contains('is-open')) {
        this.closeMarkersMenu();
      } else {
        this.openMarkersMenu();
      }
    },

    onMarkerClick: function (sec, title, singer) {
      this.playAt(sec, title, singer);
      var btnText = document.getElementById('stickyMarkersBtnText');
      if (btnText && title) {
        btnText.textContent = formatTime(sec) + ' - ' + title;
      }
      this.closeMarkersMenu();
    },

    filterMarkers: function (query) {
      var q = (query || '').trim().toLowerCase();
      var items = document.querySelectorAll('#audioMarkersList .marker-item');
      var visibleCount = 0;
      for (var i = 0; i < items.length; i++) {
        var text = items[i].getAttribute('data-search') || '';
        if (!q || text.indexOf(q) !== -1) {
          items[i].style.display = 'flex';
          visibleCount++;
        } else {
          items[i].style.display = 'none';
        }
      }
      var listEl = document.getElementById('audioMarkersList');
      var noMatchEl = document.getElementById('audioMarkersNoMatch');
      if (visibleCount === 0 && items.length > 0) {
        if (!noMatchEl && listEl) {
          var el = document.createElement('div');
          el.id = 'audioMarkersNoMatch';
          el.className = 'markers-empty-state';
          el.textContent = 'No bhajans matching search query';
          listEl.appendChild(el);
        } else if (noMatchEl) {
          noMatchEl.style.display = 'block';
        }
      } else if (noMatchEl) {
        noMatchEl.style.display = 'none';
      }
    },

    close: function () {
      var bar = document.getElementById('stickySessionAudioBar');
      if (bar) bar.classList.remove('is-visible');
      this.closeMarkersMenu();
      if (audioElement) {
        audioElement.pause();
      }
    }
  };

  // Expose global controller
  window.SessionAudioPlayer = PlayerController;

  // Global helper for row buttons
  window.playSessionAudioAt = function (seconds, title, singer, audioUrl) {
    PlayerController.playAt(seconds, title, singer, audioUrl);
  };

  // Universal helper for data-* attribute buttons
  window.playSessionAudioBtn = function (btn) {
    if (!btn) return;
    var start = parseFloat(btn.getAttribute('data-start') || '0');
    var title = btn.getAttribute('data-title') || '';
    var singer = btn.getAttribute('data-singer') || '';
    var url = btn.getAttribute('data-url') || '';
    PlayerController.playAt(start, title, singer, url);
  };

})(window);
