(function () {
  "use strict";

  function byId(id) { return document.getElementById(id); }

  function showModal(id) {
    var modal = byId(id);
    if (!modal) return false;
    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
    return true;
  }

  function hideModal(id) {
    var modal = byId(id);
    if (!modal) return;
    modal.classList.remove("show");
    modal.setAttribute("aria-hidden", "true");
    if (!document.querySelector(".session-modal-overlay.show")) {
      document.body.classList.remove("modal-open");
    }
  }

  function csrfToken() {
    return window.csrfToken ||
      (document.querySelector('meta[name="csrf-token"]') || {}).content || "";
  }

  function requestHeaders(json) {
    var headers = { "X-CSRF-Token": csrfToken() };
    if (json) headers["Content-Type"] = "application/json";
    return headers;
  }

  function openAudio() {
    if (!showModal("sessionAudioModal")) return;
    // Existing page controller handles population and the audio-file list when available.
    if (typeof window.loadSessionAudioData === "function") window.loadSessionAudioData();
    if (typeof window.loadCloudflareFiles === "function") window.loadCloudflareFiles(false);
    else {
      var help = byId("r2StatusHelp");
      if (help) help.textContent = "Loading available recordings…";
      fetch("/admin/api/cloudflare/audio-files", { headers: { "Accept": "application/json" } })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          var select = byId("audioR2Select");
          if (!select) return;
          select.innerHTML = '<option value="">-- Choose file from Cloudflare R2 --</option>';
          (data.files || []).forEach(function (file) {
            var option = document.createElement("option");
            option.value = file.key || "";
            option.textContent = file.name || file.filename || file.key || "Audio file";
            option.dataset.url = file.url || file.publicUrl || "";
            select.appendChild(option);
          });
          if (help) help.textContent = data.message || (data.files && data.files.length
            ? "Found " + data.files.length + " recording(s)." : "No R2 recordings found. You can paste a direct audio URL.");
        })
        .catch(function () { if (help) help.textContent = "Could not load recordings. Please retry."; });
    }
  }

  function openShare() {
    showModal("shareModal");
    var box = byId("whatsappShareBox");
    if (box) box.scrollTop = 0;
  }

  function copyShare() {
    var box = byId("whatsappShareBox");
    if (!box) return;
    var value = box.value || "";
    var done = function () {
      var btn = byId("copyShareBtn");
      if (btn) {
        var original = btn.textContent;
        btn.textContent = "Copied!";
        window.setTimeout(function () { btn.textContent = original; }, 1800);
      }
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(value).then(done).catch(function () {
        box.focus(); box.select();
        try { document.execCommand("copy"); done(); } catch (_) {}
      });
    } else {
      box.focus(); box.select();
      try { document.execCommand("copy"); done(); } catch (_) {}
    }
  }

  function bind() {
    var audioButton = byId("openSessionAudioBtn");
    var shareButton = byId("openShareLineupBtn");
    if (audioButton) audioButton.addEventListener("click", function (event) {
      event.preventDefault(); openAudio();
    });
    if (shareButton) shareButton.addEventListener("click", function (event) {
      event.preventDefault(); openShare();
    });

    // Keep legacy inline handlers working, but provide safe fallbacks if the page
    // script did not initialise for any reason.
    if (typeof window.openAudioModal !== "function") window.openAudioModal = openAudio;
    if (typeof window.openShareModal !== "function") window.openShareModal = openShare;
    if (typeof window.closeAudioModal !== "function") window.closeAudioModal = function () {
      hideModal("sessionAudioModal");
      var preview = byId("adminAudioPreview"); if (preview) preview.pause();
    };
    if (typeof window.closeShareModal !== "function") window.closeShareModal = function () { hideModal("shareModal"); };
    if (typeof window.copyShareText !== "function") window.copyShareText = copyShare;

    document.querySelectorAll(".session-modal-overlay").forEach(function (modal) {
      modal.setAttribute("aria-hidden", modal.classList.contains("show") ? "false" : "true");
      modal.addEventListener("click", function (event) {
        if (event.target !== modal) return;
        hideModal(modal.id);
      });
    });
    document.addEventListener("keydown", function (event) {
      if (event.key !== "Escape") return;
      var visible = document.querySelector(".session-modal-overlay.show");
      if (visible) hideModal(visible.id);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
  else bind();

  // Expose a shared CSRF-aware helper for this page's existing AJAX handlers.
  window.adminSessionRequestHeaders = requestHeaders;
})();
