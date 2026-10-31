/**
 * Bhajan Planner - Native Experience UI Engine (public/js/native-ui.js)
 * 
 * Provides:
 * - Haptics on primary actions (navigator.vibrate fallback)
 * - BPSheet (open, close, create, confirm with promise, drag-to-dismiss, focus trap)
 * - Snap sizes for Quick Lyrics (expanded/collapsed)
 * - Keyboard-aware navigation (visualViewport listener)
 * - Admin table enhancer to mobile record cards (data-mobile-cards)
 */

(function (window, document) {
  "use strict";

  // ── 1. Haptics Engine ──────────────────────────────────────────────────────
  var BPHaptics = {
    tap: function (ms) {
      try {
        if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
          navigator.vibrate(ms || 8);
        }
      } catch (_) {}
    }
  };
  window.BPHaptics = BPHaptics;

  // Global delegation for tap feedback & haptics on primary actions
  document.addEventListener("click", function (e) {
    var target = e.target;
    if (!target || !target.closest) return;
    var primaryAction = target.closest(
      ".btn-primary, .card-action-btn-primary, .action-tool-btn-primary, " +
      ".capsule-nav-item, .nav-tab, .tab-btn, [data-bp-haptic]"
    );
    if (primaryAction) {
      BPHaptics.tap(8);
    }
  }, { passive: true });


  // ── 2. Bottom Sheet & Confirmation System (BPSheet) ────────────────────────
  var activeSheets = [];
  var backdropEl = null;

  function getOrCreateBackdrop() {
    if (!backdropEl) {
      backdropEl = document.getElementById("bpSheetBackdrop");
      if (!backdropEl) {
        backdropEl = document.createElement("div");
        backdropEl.id = "bpSheetBackdrop";
        backdropEl.className = "bp-sheet-backdrop";
        backdropEl.setAttribute("aria-hidden", "true");
        document.body.appendChild(backdropEl);
      }
      backdropEl.addEventListener("click", function () {
        if (activeSheets.length > 0) {
          var top = activeSheets[activeSheets.length - 1];
          BPSheet.close(top);
        }
      });
    }
    return backdropEl;
  }

  function updateScrollLock() {
    if (activeSheets.length > 0) {
      document.documentElement.classList.add("bp-sheet-lock");
      var bd = getOrCreateBackdrop();
      bd.classList.add("show");
    } else {
      document.documentElement.classList.remove("bp-sheet-lock");
      if (backdropEl) backdropEl.classList.remove("show");
    }
  }

  var BPSheet = {
    open: function (sheetEl, options) {
      if (!sheetEl) return;
      options = options || {};
      getOrCreateBackdrop();

      sheetEl._bpPrevFocus = document.activeElement;
      sheetEl.style.setProperty("--bp-y", "0px");
      sheetEl.classList.add("show");
      sheetEl.setAttribute("aria-hidden", "false");

      if (activeSheets.indexOf(sheetEl) === -1) {
        activeSheets.push(sheetEl);
      }
      updateScrollLock();

      // Attach gesture listeners if not already attached
      attachDragGesture(sheetEl);

      // Focus trap
      setTimeout(function () {
        var focusable = sheetEl.querySelectorAll(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (focusable.length > 0) {
          focusable[0].focus();
        } else {
          sheetEl.focus();
        }
      }, 50);

      if (typeof options.onOpen === "function") options.onOpen(sheetEl);
    },

    close: function (sheetEl) {
      if (!sheetEl && activeSheets.length > 0) {
        sheetEl = activeSheets[activeSheets.length - 1];
      }
      if (!sheetEl) return;

      sheetEl.classList.remove("show");
      sheetEl.setAttribute("aria-hidden", "true");
      sheetEl.style.removeProperty("--bp-y");

      var idx = activeSheets.indexOf(sheetEl);
      if (idx !== -1) {
        activeSheets.splice(idx, 1);
      }
      updateScrollLock();

      if (sheetEl._bpPrevFocus && typeof sheetEl._bpPrevFocus.focus === "function") {
        try { sheetEl._bpPrevFocus.focus(); } catch (_) {}
      }

      if (sheetEl._bpOnClose && typeof sheetEl._bpOnClose === "function") {
        sheetEl._bpOnClose();
        sheetEl._bpOnClose = null;
      }

      if (sheetEl.classList.contains("bp-confirm-sheet")) {
        setTimeout(function () {
          if (sheetEl.parentNode) sheetEl.parentNode.removeChild(sheetEl);
        }, 320);
      }
    },

    create: function (htmlContent, options) {
      var container = document.createElement("div");
      container.className = "bp-sheet-container " + ((options && options.className) || "");
      container.setAttribute("role", "dialog");
      container.setAttribute("aria-modal", "true");
      container.innerHTML =
        '<div class="bp-sheet-handle" aria-label="Drag handle"></div>' +
        '<div class="bp-sheet-content">' + (htmlContent || "") + '</div>';
      document.body.appendChild(container);
      return container;
    },

    confirm: function (messageOrOptions, legacyOptions) {
      return new Promise(function (resolve) {
        var opts = {};
        if (typeof messageOrOptions === "string") {
          opts = legacyOptions || {};
          opts.message = messageOrOptions;
        } else if (typeof messageOrOptions === "object" && messageOrOptions !== null) {
          opts = messageOrOptions;
        }

        var title = opts.title || (opts.isDestructive ? "Confirm Action" : "Confirmation");
        var message = opts.message || "Are you sure you want to proceed?";
        var confirmText = opts.confirmText || (opts.isDestructive ? "Confirm Delete" : "Confirm");
        var cancelText = opts.cancelText || "Cancel";
        var isDestructive = !!opts.isDestructive;

        var sheet = document.createElement("div");
        sheet.className = "bp-sheet-container bp-confirm-sheet";
        sheet.setAttribute("role", "alertdialog");
        sheet.setAttribute("aria-modal", "true");

        sheet.innerHTML =
          '<div class="bp-sheet-handle" aria-label="Drag handle"></div>' +
          '<div style="padding: 18px 22px 10px 22px; text-align: left;">' +
            '<h3 style="margin: 0 0 8px 0; font-size: 18px; font-weight: 700; color: var(--ink, #1e293b);">' +
              escapeHtml(title) +
            '</h3>' +
            '<p style="margin: 0; font-size: 14.5px; line-height: 1.55; color: var(--muted, #64748b);">' +
              escapeHtml(message) +
            '</p>' +
          '</div>' +
          '<div class="bp-sticky-actions" style="display: flex; gap: 12px; justify-content: flex-end; padding: 14px 22px 18px 22px; border-top: 1px solid var(--border-soft, #f1f5f9);">' +
            '<button type="button" class="btn btn-secondary bp-confirm-btn-cancel" style="min-width: 90px; padding: 10px 16px; border-radius: 10px; font-weight: 600;">' +
              escapeHtml(cancelText) +
            '</button>' +
            '<button type="button" class="btn ' + (isDestructive ? "btn-danger bp-btn-danger" : "btn-primary") + ' bp-confirm-btn-ok" style="min-width: 100px; padding: 10px 18px; border-radius: 10px; font-weight: 600;' + (isDestructive ? ' background: #dc2626 !important; border-color: #dc2626 !important; color: #fff !important;' : '') + '">' +
              escapeHtml(confirmText) +
            '</button>' +
          '</div>';

        document.body.appendChild(sheet);

        var settled = false;
        function finish(res) {
          if (settled) return;
          settled = true;
          BPSheet.close(sheet);
          resolve(res);
        }

        var okBtn = sheet.querySelector(".bp-confirm-btn-ok");
        var cancelBtn = sheet.querySelector(".bp-confirm-btn-cancel");

        if (okBtn) okBtn.addEventListener("click", function () { finish(true); });
        if (cancelBtn) cancelBtn.addEventListener("click", function () { finish(false); });

        sheet._bpOnClose = function () {
          finish(false);
        };

        BPSheet.open(sheet);
      });
    }
  };
  window.BPSheet = BPSheet;

  function escapeHtml(str) {
    if (!str) return "";
    var d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  // Keyboard trap & Escape to close
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" || e.keyCode === 27) {
      if (typeof window.closeQuickLyrics === "function") {
        var qm = document.getElementById("quickLyricsModal");
        if (qm && qm.classList.contains("show")) {
          e.preventDefault();
          window.closeQuickLyrics();
          return;
        }
      }
      var openModals = document.querySelectorAll(".modal.show");
      if (openModals.length > 0) {
        e.preventDefault();
        var lastModal = openModals[openModals.length - 1];
        var closeBtn = lastModal.querySelector(".close-btn, .close, [aria-label='Close']");
        if (closeBtn && typeof closeBtn.click === "function") {
          closeBtn.click();
        } else {
          lastModal.classList.remove("show");
        }
        var hasAny = document.querySelectorAll(".modal.show, .bp-sheet-container.show").length > 0;
        document.documentElement.classList.toggle("bp-sheet-lock", hasAny);
        document.body.classList.toggle("modal-open", hasAny);
        return;
      }
      if (activeSheets.length > 0) {
        e.preventDefault();
        BPSheet.close(activeSheets[activeSheets.length - 1]);
        return;
      }
    }

    if (e.key === "Tab" || e.keyCode === 9) {
      if (activeSheets.length === 0) return;
      var topSheet = activeSheets[activeSheets.length - 1];
      var focusable = topSheet.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      var first = focusable[0];
      var last = focusable[focusable.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === first || document.activeElement === topSheet) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
  });

  // Backdrop click dismissal & touch scroll freeze
  document.addEventListener("click", function (e) {
    var target = e.target;
    if (target && target.classList && target.classList.contains("modal") && target.classList.contains("show")) {
      e.preventDefault();
      if (target.id === "quickLyricsModal" && typeof window.closeQuickLyrics === "function") {
        window.closeQuickLyrics();
      } else {
        var closeBtn = target.querySelector(".close-btn, .close, [aria-label='Close']");
        if (closeBtn && typeof closeBtn.click === "function") {
          closeBtn.click();
        } else {
          target.classList.remove("show");
        }
        var hasAny = document.querySelectorAll(".modal.show, .bp-sheet-container.show").length > 0;
        document.documentElement.classList.toggle("bp-sheet-lock", hasAny);
        document.body.classList.toggle("modal-open", hasAny);
      }
    }
  }, false);

  // Prevent background touch scrolling through modal backdrop
  document.addEventListener("touchmove", function (e) {
    if (e.target && e.target.classList && e.target.classList.contains("modal")) {
      e.preventDefault();
    }
  }, { passive: false });

  document.addEventListener("wheel", function (e) {
    if (e.target && e.target.classList && e.target.classList.contains("modal")) {
      e.preventDefault();
    }
  }, { passive: false });

  // Observer that teleports modals to body, enforces scroll-lock & attaches drag gesture
  var modalLockObserver = typeof MutationObserver !== "undefined"
    ? new MutationObserver(function () {
        var openModals = document.querySelectorAll(".modal.show");
        openModals.forEach(function (m) {
          if (m.parentElement !== document.body) {
            document.body.appendChild(m);
          }
          var content = m.querySelector(".modal-content");
          if (content && !content._bpDragAttached) {
            attachDragGesture(content);
          }
        });
        var hasAny = openModals.length > 0 || document.querySelectorAll(".bp-sheet-container.show").length > 0;
        document.documentElement.classList.toggle("bp-sheet-lock", hasAny);
        document.body.classList.toggle("modal-open", hasAny);
      })
    : null;

  if (modalLockObserver) {
    modalLockObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class"]
    });
  }


  // ── 3. Drag-to-Dismiss Gesture with Pointer Events ──────────────────────────
  function attachDragGesture(sheet) {
    if (sheet._bpDragAttached) return;
    sheet._bpDragAttached = true;

    var handle = sheet.querySelector(".bp-sheet-handle, .sheet-drag-handle, .modal-header") || sheet;
    var startY = 0;
    var startTime = 0;
    var isDragging = false;
    var currentY = 0;
    var suppressClick = false;

    // Suppress clicks triggered by touch drag release
    window.addEventListener("click", function (e) {
      if (suppressClick) {
        e.stopPropagation();
        e.preventDefault();
        suppressClick = false;
      }
    }, true);

    handle.addEventListener("pointerdown", function (e) {
      if (e.button !== 0) return;
      // If scrollable content is scrolled down, allow scrolling up first
      if (sheet.scrollTop > 0) return;

      startY = e.clientY;
      currentY = startY;
      startTime = performance.now();
      isDragging = false;
      sheet.style.transition = "none";
    });

    window.addEventListener("pointermove", function (e) {
      if (startY === 0) return;
      var dy = e.clientY - startY;

      // Threshold 8px
      if (!isDragging && dy > 8) {
        isDragging = true;
      }

      if (isDragging) {
        currentY = e.clientY;
        if (dy > 0) {
          sheet.style.setProperty("--bp-y", dy + "px");
        } else {
          sheet.style.setProperty("--bp-y", "0px");
        }
      }
    });

    window.addEventListener("pointerup", function (e) {
      if (startY === 0) return;
      var dy = currentY - startY;
      var dt = Math.max(1, performance.now() - startTime);
      var velocity = dy / dt; // px/ms
      var height = sheet.getBoundingClientRect().height || 300;
      var thresholdDist = Math.min(140, height * 0.28);

      startY = 0;

      if (isDragging) {
        suppressClick = true;
        setTimeout(function () { suppressClick = false; }, 120);

        if (velocity > 0.55 || dy > thresholdDist) {
          // Dismiss
          sheet.style.transition = "transform 220ms cubic-bezier(0.32, 0.72, 0, 1)";
          sheet.style.setProperty("--bp-y", "100%");
          setTimeout(function () {
            if (sheet.classList.contains("quick-lyrics-sheet") || sheet.id === "quickLyricsModal") {
              if (typeof window.closeQuickLyrics === "function") {
                window.closeQuickLyrics();
              } else {
                var qm = document.getElementById("quickLyricsModal");
                if (qm) qm.classList.remove("show");
              }
            } else if (sheet.closest && sheet.closest(".modal")) {
              var parentModal = sheet.closest(".modal");
              var closeBtn = parentModal.querySelector(".close-btn, .close, [aria-label='Close']");
              if (closeBtn && typeof closeBtn.click === "function") {
                closeBtn.click();
              } else {
                parentModal.classList.remove("show");
              }
            } else {
              BPSheet.close(sheet);
            }
            sheet.style.removeProperty("--bp-y");
            sheet.style.transition = "";
          }, 220);
        } else {
          // Snap back
          sheet.style.transition = "transform 200ms cubic-bezier(0.32, 0.72, 0, 1)";
          sheet.style.setProperty("--bp-y", "0px");
          setTimeout(function () {
            sheet.style.transition = "";
          }, 200);
        }
      }
      isDragging = false;
    });

    window.addEventListener("pointercancel", function () {
      if (startY !== 0 && isDragging) {
        sheet.style.transition = "transform 200ms cubic-bezier(0.32, 0.72, 0, 1)";
        sheet.style.setProperty("--bp-y", "0px");
        setTimeout(function () {
          sheet.style.transition = "";
        }, 200);
      }
      startY = 0;
      isDragging = false;
    });
  }


  // ── 4. Quick Lyrics Snap Sizes ──────────────────────────────────────────────
  window.toggleQuickLyricsExpand = function () {
    var modal = document.getElementById("quickLyricsModal");
    var sheet = modal ? modal.querySelector(".modal-content") : document.getElementById("quickLyricsSheet");
    if (!sheet) return;

    var isExp = sheet.classList.toggle("sheet-expanded");
    var expandBtn = document.getElementById("quickLyricsExpandBtn");
    if (expandBtn) {
      expandBtn.setAttribute("aria-expanded", isExp ? "true" : "false");
      expandBtn.title = isExp ? "Collapse Lyrics Sheet" : "Expand Lyrics Sheet";
    }
    BPHaptics.tap(6);
  };


  // ── 5. Form & Button [data-confirm] Interceptor ────────────────────────────
  document.addEventListener("submit", function (e) {
    var form = e.target;
    if (!form || !form.getAttribute) return;
    var confirmMsg = form.getAttribute("data-confirm");
    if (confirmMsg && !form._bpConfirmed) {
      e.preventDefault();
      e.stopImmediatePropagation();
      var isDestructive = /delete|remove|purge|reset|discard|archive/i.test(confirmMsg);
      BPSheet.confirm({
        message: confirmMsg,
        isDestructive: isDestructive
      }).then(function (ok) {
        if (ok) {
          form._bpConfirmed = true;
          form.submit();
        }
      });
    }
  }, true);


  // ── 6. Keyboard-Aware Navigation & Viewport Management ─────────────────────
  if (typeof window !== "undefined" && window.visualViewport) {
    var checkKeyboard = function () {
      var isKb = (window.innerHeight - window.visualViewport.height) > 150;
      document.documentElement.classList.toggle("bp-kb-open", isKb);
    };
    window.visualViewport.addEventListener("resize", checkKeyboard);
    window.visualViewport.addEventListener("scroll", checkKeyboard);
  }

  // Smooth pane transition trigger
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      document.documentElement.classList.add("bp-ready");
    });
  } else {
    document.documentElement.classList.add("bp-ready");
  }


  // ── 7. Admin Tables to Mobile Record Cards ─────────────────────────────────
  function enhanceMobileCards(root) {
    var scope = root || document;
    var tables = scope.querySelectorAll("table[data-mobile-cards]");

    tables.forEach(function (table) {
      var thead = table.querySelector("thead");
      if (!thead) return;

      var ths = Array.from(thead.querySelectorAll("th"));
      var headers = ths.map(function (th) {
        return th.textContent.replace(/\s+/g, " ").trim();
      });

      function processRows() {
        var rows = table.querySelectorAll("tbody tr");
        rows.forEach(function (row) {
          if (row.dataset.bpEnhanced === "1") return;
          row.dataset.bpEnhanced = "1";

          var cells = Array.from(row.querySelectorAll("td"));
          cells.forEach(function (td, idx) {
            var label = headers[idx] || "";
            if (label && !td.getAttribute("data-label")) {
              td.setAttribute("data-label", label);
            }

            var labelLower = label.toLowerCase();
            if (idx === 0 && (/^#|id|no\.|sl/i.test(labelLower) || /^\d+$/.test(td.textContent.trim()))) {
              td.setAttribute("data-bp", "index");
            } else if (/actions?|manage|controls?/i.test(labelLower) || td.querySelector("button, a.btn, .action-btn, form")) {
              td.setAttribute("data-bp", "actions");
            } else if (/title|name|bhajan|user|singer/i.test(labelLower) && !row.querySelector('[data-bp="primary"]')) {
              td.setAttribute("data-bp", "primary");
            } else if (/description|details|notes|logs|message|body/i.test(labelLower) || td.colSpan > 1) {
              td.setAttribute("data-bp", "wide");
            }
          });
        });
      }

      processRows();

      var tbody = table.querySelector("tbody");
      if (tbody && !tbody._bpObserver) {
        tbody._bpObserver = new MutationObserver(processRows);
        tbody._bpObserver.observe(tbody, { childList: true, subtree: false });
      }
    });
  }
  window.enhanceMobileCards = enhanceMobileCards;

  // Auto-enhance mobile cards on load and fragment swap
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      enhanceMobileCards();
    });
  } else {
    enhanceMobileCards();
  }

})(typeof window !== "undefined" ? window : this, typeof document !== "undefined" ? document : {});

