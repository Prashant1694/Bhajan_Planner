// ============================================================
// PWA Install Handler — Bhajan Planner
// Registers the service worker, intercepts the install prompt,
// shows a custom banner with size info, handles iOS separately
// ============================================================

(function () {
  "use strict";

  // ── Service Worker Registration ─────────────────────────────
  function registerServiceWorker() {
    if ("serviceWorker" in navigator) {
      window.addEventListener("load", () => {
        navigator.serviceWorker
          .register("/sw.js", { updateViaCache: "none" })
          .then((reg) => {
            setInterval(() => reg.update(), 60 * 60 * 1000);
          })
          .catch((err) => console.error("[PWA] SW registration failed:", err));
      });
    }
  }

  // ── Guard: don't show install banner if already installed as standalone ──
  if (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true
  ) {
    registerServiceWorker();
    window.BPWirePwaButtons = function () {
      const btn = document.getElementById("footerPwaInstallBtn");
      if (!btn) return;
      btn.innerHTML =
        '<span style="display:inline-flex; align-items:center; gap:5px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Installed on Device</span>';
      btn.classList.add("installed");
      btn.disabled = true;
    };
    return;
  }

  registerServiceWorker();

  // ── Constants ───────────────────────────────────────────────
  const DISMISS_KEY = "pwa-install-dismissed";
  const DISMISS_DAYS = 7;
  const BANNER_DELAY = 2500;

  let deferredPrompt = null;

  // ── Helpers ─────────────────────────────────────────────────
  function wasDismissedRecently() {
    const ts = localStorage.getItem(DISMISS_KEY);
    if (!ts) return false;
    const daysSince = (Date.now() - parseInt(ts, 10)) / (1000 * 60 * 60 * 24);
    return daysSince < DISMISS_DAYS;
  }

  function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  }

  async function getEstimatedSize() {
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const { usage } = await navigator.storage.estimate();
        if (usage > 0) return formatBytes(usage);
      }
    } catch (_) {}
    return "< 2 MB";
  }

  function formatBytes(bytes) {
    const mb = bytes / (1024 * 1024);
    if (mb < 1) return "< 1 MB";
    if (mb < 10) return `~${mb.toFixed(1)} MB`;
    return `~${Math.round(mb)} MB`;
  }

  // ── Banner Show / Hide ──────────────────────────────────────
  function showBanner(customDelay) {
    const overlay = document.getElementById("pwaInstallOverlay");
    if (!overlay) return;

    getEstimatedSize().then((size) => {
      const el = document.getElementById("pwaBannerSize");
      if (el) el.textContent = size;
    });

    if (isIOS()) {
      const iosEl = document.getElementById("pwaIosInstructions");
      const installBtn = document.getElementById("pwaBtnInstall");
      if (iosEl) iosEl.style.display = "block";
      if (installBtn) installBtn.style.display = "none";
    } else if (!deferredPrompt) {
      const manualEl = document.getElementById("pwaManualInstructions");
      const manualText = document.getElementById("pwaManualInstructionsText");
      if (manualEl) {
        manualEl.style.display = "block";
        const isInsecure =
          !window.isSecureContext &&
          location.hostname !== "localhost" &&
          location.hostname !== "127.0.0.1";
        if (isInsecure && manualText) {
          manualText.innerHTML =
            '<strong>Over Wi-Fi IP (HTTP):</strong> Mobile browsers restrict automated install without HTTPS.<br>Tap your browser menu (<strong>⋮</strong>) &rarr; select <strong>"Add to Home screen"</strong> or <strong>"Install app"</strong>.';
        }
      }
    }

    const delay = typeof customDelay === "number" ? customDelay : BANNER_DELAY;
    setTimeout(() => overlay.classList.add("show"), delay);
  }

  function hideBanner() {
    const overlay = document.getElementById("pwaInstallOverlay");
    if (overlay) overlay.classList.remove("show");
  }

  // ── Global trigger for manual install buttons (e.g. footer) ─
  window.triggerPwaInstall = function () {
    const isStandalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      window.navigator.standalone === true;

    if (isStandalone) {
      alert("Bhajan Planner is already installed and running on your device!");
      return;
    }

    if (deferredPrompt) {
      deferredPrompt.prompt();
      deferredPrompt.userChoice.then(() => {
        deferredPrompt = null;
        hideBanner();
      });
    } else {
      showBanner(0);
      const manualEl = document.getElementById("pwaManualInstructions");
      if (manualEl && !isIOS()) {
        manualEl.style.display = "block";
      }
    }
  };

  // ── Wire up footer install button if present (idempotent across dynamic mounts) ──
  function wireFooterInstallBtn() {
    const btn = document.getElementById("footerPwaInstallBtn");
    if (!btn) return;

    const isStandalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      window.navigator.standalone === true;

    if (isStandalone) {
      btn.innerHTML =
        '<span style="display:inline-flex; align-items:center; gap:5px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Installed on Device</span>';
      btn.classList.add("installed");
      btn.disabled = true;
      return;
    }

    if (btn.dataset.pwaBound === "1") return;
    btn.dataset.pwaBound = "1";

    if (isIOS()) {
      btn.innerHTML =
        '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg> Install on iPhone / iPad';
    } else {
      btn.innerHTML =
        '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Install Bhajan Planner App';
    }

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      window.triggerPwaInstall();
    });
  }

  window.BPWirePwaButtons = wireFooterInstallBtn;

  // ── Intercept Chrome / Edge install prompt ──────────────────
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;

    if (!wasDismissedRecently()) {
      showBanner();
    }
  });

  // ── Wire up banner buttons on DOM ready ─────────────────────
  document.addEventListener("DOMContentLoaded", () => {
    const installBtn = document.getElementById("pwaBtnInstall");
    const dismissBtn = document.getElementById("pwaBtnDismiss");
    const closeBtn = document.getElementById("pwaBannerClose");

    wireFooterInstallBtn();

    installBtn?.addEventListener("click", async () => {
      if (!deferredPrompt) {
        showBanner(0);
        const manualEl = document.getElementById("pwaManualInstructions");
        const manualText = document.getElementById("pwaManualInstructionsText");
        if (manualEl) {
          manualEl.style.display = "block";
          const isInsecure =
            !window.isSecureContext &&
            location.hostname !== "localhost" &&
            location.hostname !== "127.0.0.1";
          if (isInsecure && manualText) {
            manualText.innerHTML =
              '<strong>Over Wi-Fi IP (HTTP):</strong> Mobile browsers restrict automated install without HTTPS.<br>Tap your browser menu (<strong>⋮</strong>) &rarr; select <strong>"Add to Home screen"</strong> or <strong>"Install app"</strong>.';
          }
        }
        return;
      }
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      hideBanner();
    });

    function dismiss() {
      localStorage.setItem(DISMISS_KEY, Date.now().toString());
      hideBanner();
    }
    dismissBtn?.addEventListener("click", dismiss);
    closeBtn?.addEventListener("click", dismiss);

    const overlay = document.getElementById("pwaInstallOverlay");
    overlay?.addEventListener("click", (e) => {
      if (e.target === overlay) dismiss();
    });

    if (isIOS() && !wasDismissedRecently()) {
      setTimeout(() => showBanner(), 4000);
    }
  });

  // ── Track successful install ────────────────────────────────
  window.addEventListener("appinstalled", () => {
    hideBanner();
    deferredPrompt = null;
    const btn = document.getElementById("footerPwaInstallBtn");
    if (btn) {
      btn.innerHTML =
        '<span style="display:inline-flex; align-items:center; gap:5px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Installed on Device</span>';
      btn.disabled = true;
    }
  });
})();
