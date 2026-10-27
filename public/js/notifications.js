// ============================================================
// Notification Center Client — Bhajan Planner
// Handles notification bell, panel, push subscription,
// one-time first-visit permission prompt, and device identity
// ============================================================

(function () {
  "use strict";

  // ── Safe UUID generator (supports non-secure HTTP / LAN IP contexts) ──
  function generateUUID() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  // ── Device ID management ─────────────────────────────────
  function getDeviceId() {
    let id = localStorage.getItem("bp_device_id");
    if (!id) {
      id = "dev_" + generateUUID();
      localStorage.setItem("bp_device_id", id);
    }
    return id;
  }

  const deviceId = getDeviceId();
  window.BP_DEVICE_ID = deviceId;

  // ── DOM elements ─────────────────────────────────────────
  const bellBtn = document.getElementById("notifBellBtn");
  const badge = document.getElementById("notifBadge");
  const panel = document.getElementById("notifPanel");
  const panelBody = document.getElementById("notifPanelBody");
  const overlay = document.getElementById("notifOverlay");
  const closeBtn = document.getElementById("notifCloseBtn");
  const markAllBtn = document.getElementById("notifMarkAllRead");

  if (!bellBtn) return; // Admin pages don't have the floating bell

  // ── Unread count polling ─────────────────────────────────
  function updateUnreadCount() {
    fetch(`/api/notifications/unread-count?device_id=${encodeURIComponent(deviceId)}`)
      .then((r) => r.json())
      .then((data) => {
        const count = data.count || 0;
        if (count > 0) {
          badge.textContent = count > 99 ? "99+" : count;
          badge.classList.add("has-unread");
          badge.style.display = "flex";
        } else {
          badge.textContent = "";
          badge.classList.remove("has-unread");
          badge.style.display = "none";
        }
      })
      .catch(() => {});
  }

  // Initial count check + periodic refresh
  updateUnreadCount();
  setInterval(updateUnreadCount, 60000); // every 60 seconds

  // ── Time formatting ──────────────────────────────────────
  function timeAgo(dateStr) {
    const now = new Date();
    const date = new Date(dateStr);
    const diffMs = now - date;
    const diffMin = Math.floor(diffMs / 60000);
    const diffHr = Math.floor(diffMs / 3600000);
    const diffDay = Math.floor(diffMs / 86400000);

    if (diffMin < 1) return "Just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHr < 24) return `${diffHr}h ago`;
    if (diffDay < 7) return `${diffDay}d ago`;
    return date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  }

  // ── Type icons ───────────────────────────────────────────
  function getTypeIcon(type) {
    switch (type) {
      case "deadline_reminder":
        return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
      case "schedule_published":
        return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>';
      case "session_audio_published":
        return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
      case "partner_bhajan":
        return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>';
      case "bulletin_published":
      case "custom":
        return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
      case "test":
      default:
        return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';
    }
  }

  // ── Mark all as read silently ────────────────────────────
  function markAllAsReadSilently() {
    if (badge) {
      badge.textContent = "";
      badge.classList.remove("has-unread");
      badge.style.display = "none";
    }

    const csrf = window.csrfToken || (document.querySelector('meta[name="csrf-token"]') ? document.querySelector('meta[name="csrf-token"]').getAttribute('content') : '');
    fetch("/api/notifications/mark-all-read", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf
      },
      body: JSON.stringify({ device_id: deviceId })
    })
      .then(() => {
        updateUnreadCount();
      })
      .catch(() => {});
  }

  // ── Load notifications ───────────────────────────────────
  function loadNotifications() {
    panelBody.innerHTML = '<div class="notif-loading">Loading...</div>';

    fetch(`/api/notifications?device_id=${encodeURIComponent(deviceId)}`)
      .then((r) => r.json())
      .then((data) => {
        const notifications = data.notifications || [];

        if (notifications.length === 0) {
          panelBody.innerHTML = `
            <div class="notif-empty">
              <div class="notif-empty-icon" style="display:flex; justify-content:center; margin-bottom:8px;">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
              </div>
              <div class="notif-empty-text">No notifications yet.<br>You're all caught up!</div>
            </div>
          `;
          return;
        }

        panelBody.innerHTML = notifications
          .map(
            (n) => `
          <a class="notif-item" 
             href="${n.link || "#"}"
             data-id="${n.id}">
            <div class="notif-item-icon">${getTypeIcon(n.type)}</div>
            <div class="notif-item-content">
              <div class="notif-item-title">${escapeHtml(n.title)}</div>
              <div class="notif-item-body">${escapeHtml(n.body)}</div>
              <div class="notif-item-time">${timeAgo(n.createdAt)}</div>
            </div>
          </a>
        `
          )
          .join("");
      })
      .catch(() => {
        panelBody.innerHTML = '<div class="notif-loading">Failed to load notifications</div>';
      });
  }

  // ── Escape HTML for safe rendering ───────────────────────
  function escapeHtml(str) {
    if (!str) return "";
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // ── Mark notification as read ────────────────────────────
  window._notifMarkRead = function (notificationId) {
    const csrf = window.csrfToken || (document.querySelector('meta[name="csrf-token"]') ? document.querySelector('meta[name="csrf-token"]').getAttribute('content') : '');
    fetch("/api/notifications/mark-read", {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf
      },
      body: JSON.stringify({ notification_id: notificationId, device_id: deviceId })
    })
      .then(() => {
        const item = document.querySelector(`.notif-item[data-id="${notificationId}"]`);
        if (item) {
          item.classList.remove("unread");
          const dot = item.querySelector(".notif-unread-dot");
          if (dot) dot.remove();
        }
        updateUnreadCount();
      })
      .catch(() => {});
  };

  // ── Panel open/close ─────────────────────────────────────
  function openPanel() {
    panel.classList.add("open");
    overlay.classList.add("show");
    // Automatically mark all notifications as read upon opening
    markAllAsReadSilently();
    loadNotifications();
  }

  function closePanel() {
    panel.classList.remove("open");
    overlay.classList.remove("show");
    markAllAsReadSilently();
  }

  function handleBellToggle(e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (panel.classList.contains("open")) {
      closePanel();
    } else {
      openPanel();
    }
  }

  bellBtn.addEventListener("click", handleBellToggle);

  if (closeBtn) closeBtn.addEventListener("click", closePanel);
  if (overlay) overlay.addEventListener("click", closePanel);

  // ── Mark all read button (hidden by default as read is automatic) ──
  if (markAllBtn) {
    markAllBtn.style.display = "none";
    markAllBtn.addEventListener("click", () => {
      markAllAsReadSilently();
      document.querySelectorAll(".notif-item.unread").forEach((el) => {
        el.classList.remove("unread");
        const dot = el.querySelector(".notif-unread-dot");
        if (dot) dot.remove();
      });
    });
  }

  // ============================================================
  // ONE-TIME FIRST-VISIT PERMISSION PROMPT
  // ============================================================
  function initFirstVisitPrompt() {
    const PROMPT_KEY = "bp_notif_prompt_shown";
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has("reset_notif")) {
      localStorage.removeItem(PROMPT_KEY);
      localStorage.removeItem("bp_device_id");
    }
    const alreadyHandled = localStorage.getItem(PROMPT_KEY);
    if (alreadyHandled) return; // Do not ask repeatedly

    const promptOverlay = document.getElementById("notifPromptOverlay");
    const singerSelect = document.getElementById("notifPromptSingerSelect");
    const enableBtn = document.getElementById("notifPromptEnableBtn");
    const dismissBtn = document.getElementById("notifPromptDismissBtn");

    const pinSection = document.getElementById("notifPromptPinSection");
    const pinInput = document.getElementById("notifPromptPinInput");
    const pinLabel = document.getElementById("notifPromptPinLabel");
    const pinNotice = document.getElementById("notifPromptPinNotice");
    const pinDesc = document.getElementById("notifPromptPinDesc");
    const pinReminder = document.getElementById("notifPromptPinReminder");
    const pinHelp = document.getElementById("notifPromptPinHelp");
    const pinError = document.getElementById("notifPromptPinError");
    const pinToggleBtn = document.getElementById("notifPromptPinToggleBtn");

    if (!promptOverlay || !singerSelect || !enableBtn || !dismissBtn) return;

    // PIN toggle visibility
    if (pinToggleBtn && pinInput) {
      pinToggleBtn.addEventListener("click", () => {
        pinInput.type = pinInput.type === "password" ? "text" : "password";
      });
    }

    // Check if the device is already subscribed on server
    fetch(`/api/notifications/subscription-status?device_id=${encodeURIComponent(deviceId)}`)
      .then((r) => r.json())
      .then((data) => {
        if (data && data.subscribed) {
          localStorage.setItem(PROMPT_KEY, "enabled");
          return;
        }

        // Fetch singers to populate dropdown
        fetch("/api/singers")
          .then((r) => r.json())
          .then((singers) => {
            const list = Array.isArray(singers) ? singers : singers.singers || [];
            if (list.length === 0) return;

            list.sort((a, b) => a.name.localeCompare(b.name));
            singerSelect.innerHTML = '<option value="">— Select your name —</option>';
            list.forEach((s) => {
              const opt = document.createElement("option");
              opt.value = s.id;
              opt.textContent = s.name;
              singerSelect.appendChild(opt);
            });

            // Show prompt after a slight delay (1.5s) for smooth page load
            setTimeout(() => {
              promptOverlay.style.display = "flex";
              setTimeout(() => promptOverlay.classList.add("show"), 10);
            }, 1500);
          })
          .catch(() => {});
      })
      .catch(() => {});

    // Singer selection queries PIN status and displays the PIN box
    singerSelect.addEventListener("change", async () => {
      const singerId = singerSelect.value;
      if (pinError) {
        pinError.style.display = "none";
        pinError.textContent = "";
      }
      if (pinInput) {
        pinInput.value = "";
        pinInput.classList.remove("is-invalid");
      }

      if (!singerId) {
        if (pinSection) pinSection.style.display = "none";
        enableBtn.disabled = true;
        return;
      }

      try {
        const res = await fetch(
          `/api/notifications/singer-pin-status?singer_id=${encodeURIComponent(singerId)}`
        );
        const data = await res.json();

        if (pinSection) pinSection.style.display = "block";

        if (data.hasPin) {
          if (pinNotice) pinNotice.classList.add("existing");
          if (pinLabel) pinLabel.textContent = `Enter your 4-Digit PIN for ${data.singer_name}:`;
          if (pinDesc)
            pinDesc.textContent = `Enter the 4-digit security PIN previously created for ${data.singer_name} to connect this device.`;
          if (pinReminder)
            pinReminder.innerHTML = `<strong>Forgot your PIN?</strong> Contact the Samiti coordinator / admin for a quick reset.`;
          if (pinHelp) pinHelp.textContent = "Enter your 4-digit PIN";
        } else {
          if (pinNotice) pinNotice.classList.remove("existing");
          if (pinLabel)
            pinLabel.textContent = `Create a 4-Digit Security PIN for ${data.singer_name}:`;
          if (pinDesc)
            pinDesc.textContent = `This 4-digit PIN secures your profile and prevents anyone else from claiming your name and receiving your partner notifications.`;
          if (pinReminder)
            pinReminder.innerHTML = `<strong>Important:</strong> Please remember this PIN for receiving notifications on other devices (like your laptop or tablet). If you ever forget it, contact the coordinator / admin for a reset.`;
          if (pinHelp) pinHelp.textContent = "Choose any 4 digits you will remember (e.g. 1234)";
        }

        enableBtn.disabled = !pinInput || pinInput.value.length !== 4;
      } catch (err) {
        if (pinSection) pinSection.style.display = "block";
        enableBtn.disabled = true;
      }
    });

    // Validate 4 digits on input
    if (pinInput) {
      pinInput.addEventListener("input", () => {
        pinInput.value = pinInput.value.replace(/\D/g, "").slice(0, 4);
        if (pinError) pinError.style.display = "none";
        pinInput.classList.remove("is-invalid");
        enableBtn.disabled = !singerSelect.value || pinInput.value.length !== 4;
      });
    }

    // Dismiss button: mark as dismissed once and never ask again
    dismissBtn.addEventListener("click", () => {
      localStorage.setItem(PROMPT_KEY, "dismissed");
      promptOverlay.classList.remove("show");
      setTimeout(() => (promptOverlay.style.display = "none"), 300);
    });

    // Enable button: subscribe device with PIN and request notification permission
    enableBtn.addEventListener("click", async () => {
      const singerId = singerSelect.value;
      const pin = pinInput ? pinInput.value.trim() : "";
      if (!singerId || pin.length !== 4) return;

      enableBtn.disabled = true;
      enableBtn.textContent = "Verifying PIN...";

      let subscription = null;
      if ("Notification" in window && "serviceWorker" in navigator && "PushManager" in window) {
        try {
          const keyRes = await fetch("/api/notifications/vapid-key");
          const { publicKey } = await keyRes.json();
          if (publicKey) {
            const perm = await Notification.requestPermission();
            if (perm === "granted") {
              const reg = await navigator.serviceWorker.ready;
              const sub = await reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(publicKey)
              });
              subscription = sub.toJSON();
            }
          }
        } catch (e) {
          console.warn("[Push] Browser push setup note:", e);
        }
      }

      // Associate device with singer + PIN
      try {
        const res = await fetch("/api/notifications/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            singer_id: parseInt(singerId, 10),
            device_id: deviceId,
            pin: pin,
            subscription: subscription
          })
        });

        const data = await res.json();
        if (res.ok && data.success) {
          localStorage.setItem(PROMPT_KEY, "enabled");
          promptOverlay.classList.remove("show");
          setTimeout(() => (promptOverlay.style.display = "none"), 300);
          updateUnreadCount();
        } else {
          enableBtn.disabled = false;
          enableBtn.textContent = "Enable Notifications";
          if (pinError) {
            pinError.textContent = data.error || "Failed to verify PIN.";
            pinError.style.display = "block";
          }
          if (pinInput) pinInput.classList.add("is-invalid");
        }
      } catch (err) {
        enableBtn.disabled = false;
        enableBtn.textContent = "Enable Notifications";
        if (pinError) {
          pinError.textContent = "Network error. Please try again.";
          pinError.style.display = "block";
        }
      }
    });
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; i++) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  // Initialize prompt
  initFirstVisitPrompt();
})();
