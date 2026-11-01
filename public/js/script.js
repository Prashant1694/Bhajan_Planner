// ============================================================================
// Global Client Utilities & Page Enhancements — Bhajan Planner (v6.0)
// Safe for both Single-DOM App Shell (idempotent initPageEnhancements) and
// Standalone / Admin Portal views.
// ============================================================================

// Track page visibility to pause GPU animations when hidden
document.addEventListener("visibilitychange", function () {
  document.documentElement.classList.toggle("bp-tab-hidden", document.hidden);
});

// Global Safe HTML Escaping Utility
function escapeHTML(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
window.escapeHTML = escapeHTML;

function getGlobalCsrfToken() {
  const meta = document.querySelector('meta[name="csrf-token"]');
  return (meta && meta.getAttribute("content")) || window.csrfToken || "";
}

// Universal CSRF header injection for non-GET fetch requests and form submissions
(function () {
  const originalFetch = window.fetch;
  window.fetch = function (url, options) {
    const opts = Object.assign({}, options || {});
    const method = (opts.method || "GET").toUpperCase();
    if (["POST", "PUT", "PATCH", "DELETE"].indexOf(method) !== -1) {
      const token = getGlobalCsrfToken();
      if (token) {
        if (opts.headers instanceof Headers) {
          if (!opts.headers.has("X-CSRF-Token")) {
            opts.headers.append("X-CSRF-Token", token);
          }
        } else if (Array.isArray(opts.headers)) {
          if (!opts.headers.some((h) => h[0].toLowerCase() === "x-csrf-token")) {
            opts.headers.push(["X-CSRF-Token", token]);
          }
        } else {
          opts.headers = Object.assign({}, opts.headers || {});
          if (!opts.headers["X-CSRF-Token"] && !opts.headers["x-csrf-token"]) {
            opts.headers["X-CSRF-Token"] = token;
          }
        }
      }
    }
    return originalFetch.call(this, url, opts);
  };

  // Bubble-phase submit guard: runs only if validation & shell router did NOT call preventDefault()
  document.addEventListener("submit", function (e) {
    if (e.defaultPrevented) return;
    const form = e.target;
    if (!form || form.tagName !== "FORM") return;
    const method = (form.method || "GET").toUpperCase();
    if (["POST", "PUT", "PATCH", "DELETE"].indexOf(method) !== -1) {
      if (form.dataset.submitting === "true") {
        e.preventDefault();
        return;
      }
      form.dataset.submitting = "true";

      const token = getGlobalCsrfToken();
      if (token && !form.querySelector('input[name="_csrf"]')) {
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = "_csrf";
        input.value = token;
        form.appendChild(input);
      }

      const submitBtn = form.querySelector('button[type="submit"], input[type="submit"]');
      if (submitBtn) {
        setTimeout(() => {
          submitBtn.disabled = true;
          submitBtn.style.opacity = "0.7";
          submitBtn.style.cursor = "wait";
        }, 10);
      }
      setTimeout(() => {
        delete form.dataset.submitting;
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.style.opacity = "";
          submitBtn.style.cursor = "";
        }
      }, 6000);
    }
  });
})();

// Global Dark Mode Controller (for standalone & admin pages; App Shell binds #shellThemeToggle)
(function initGlobalTheme() {
  function applyTheme(isDark) {
    if (isDark) {
      document.documentElement.setAttribute("data-theme", "dark");
      document.documentElement.classList.add("dark");
      if (document.body) {
        document.body.setAttribute("data-theme", "dark");
        document.body.classList.add("dark");
      }
      try {
        localStorage.setItem("bp-theme", "dark");
      } catch (_) {}
    } else {
      document.documentElement.removeAttribute("data-theme");
      document.documentElement.classList.remove("dark");
      if (document.body) {
        document.body.removeAttribute("data-theme");
        document.body.classList.remove("dark");
      }
      try {
        localStorage.setItem("bp-theme", "light");
      } catch (_) {}
    }
    const btns = document.querySelectorAll(
      ".theme-toggle, #themeToggle, #shellThemeToggle, #topbarThemeToggle, #themeToggleBtn, .admin-theme-toggle-btn"
    );
    btns.forEach((btn) => {
      btn.setAttribute("data-tooltip", isDark ? "Switch to Light" : "Switch to Dark");
      btn.setAttribute("title", isDark ? "Switch to Light" : "Switch to Dark");
      btn.setAttribute("aria-pressed", isDark ? "true" : "false");
    });
    const metaThemes = document.querySelectorAll('meta[name="theme-color"]');
    metaThemes.forEach((m) => m.setAttribute("content", isDark ? "#12100E" : "#FAF7F2"));
    if (window.top && window.top !== window) {
      try {
        if (typeof window.top.applyTheme === "function") {
          window.top.applyTheme(isDark);
        }
      } catch (_) {}
    }
    window.dispatchEvent(new CustomEvent("themechange", { detail: { isDark: isDark } }));
  }

  function handleToggleClick(e) {
    if (e) {
      if (e.preventDefault) e.preventDefault();
      if (e.stopPropagation) e.stopPropagation();
    }
    const now = Date.now();
    if (window._lastThemeToggle && (now - window._lastThemeToggle < 250)) {
      return;
    }
    window._lastThemeToggle = now;
    let stored = null;
    try { stored = localStorage.getItem("bp-theme"); } catch (_) {}
    const isDark = stored === "dark" || (stored !== "light" && (document.documentElement.getAttribute("data-theme") === "dark" || document.documentElement.classList.contains("dark")));
    applyTheme(!isDark);
    if (window.haptics && typeof window.haptics.light === "function") {
      window.haptics.light();
    }
    if (typeof triggerToast === "function") {
      triggerToast(!isDark ? "Switched to Dark Sanctum Theme" : "Switched to Ivory Prasanthi Theme");
    }
  }

  window.toggleTheme = handleToggleClick;
  window.applyTheme = applyTheme;

  function bindThemeButtons() {
    let stored = null;
    try { stored = localStorage.getItem("bp-theme"); } catch (_) {}
    const isDark = stored === "dark" || (stored !== "light" && (document.documentElement.getAttribute("data-theme") === "dark" || document.documentElement.classList.contains("dark")));
    applyTheme(isDark);

    const btns = document.querySelectorAll(
      ".theme-toggle, #themeToggle, #topbarThemeToggle, .admin-theme-toggle-btn, #themeToggleBtn"
    );
    btns.forEach((btn) => {
      const onclickAttr = btn.getAttribute("onclick") || "";
      if (onclickAttr.indexOf("toggleTheme") !== -1) return;
      if (!btn._themeAttached) {
        btn._themeAttached = true;
        btn.addEventListener("click", handleToggleClick);
      }
    });
  }

  // Delegated fallback for theme toggle buttons
  document.addEventListener("click", function (e) {
    const btn = e.target && e.target.closest ? e.target.closest("#topbarThemeToggle, #shellThemeToggle, .admin-theme-toggle-btn") : null;
    if (btn) {
      handleToggleClick(e);
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindThemeButtons);
  } else {
    bindThemeButtons();
  }
})();

// Legacy Admin Tab Switcher (only defined when not inside Single-DOM AppShell)
function switchAdminSubTab(tabName, element) {
  document.querySelectorAll(".tab-content").forEach((tab) => tab.classList.remove("active"));
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.remove("active"));
  const target = document.getElementById(tabName);
  if (target) target.classList.add("active");
  if (element) {
    element.classList.add("active");
  }
}
if (!window.AppShell && typeof window.switchTab !== "function") {
  window.switchTab = switchAdminSubTab;
}

// Slot & Confirmation Modal Helpers
function showDetails(deity, singer, bhajan, scale, speed) {
  const mDeity = document.getElementById("modalDeityName");
  if (mDeity) mDeity.textContent = (deity || "Deity") + " Bhajan Slot Details";
  const mSinger = document.getElementById("modalSinger");
  if (mSinger) mSinger.textContent = singer || "---";
  const mBhajan = document.getElementById("modalBhajan");
  if (mBhajan) mBhajan.textContent = bhajan || "---";
  const mScale = document.getElementById("modalScale");
  if (mScale) mScale.textContent = scale || "Not specified";
  const formattedSpeed = speed ? speed.charAt(0).toUpperCase() + speed.slice(1) : "Not specified";
  const mSpeed = document.getElementById("modalSpeed");
  if (mSpeed) mSpeed.textContent = formattedSpeed;
  const modal = document.getElementById("detailsModal");
  if (modal) {
    modal.classList.add("show");
    modal.style.display = "flex";
  }
}
window.showDetails = showDetails;

function closeModal(modalId) {
  if (modalId) {
    const el = document.getElementById(modalId);
    if (el) {
      el.style.display = "none";
      el.classList.remove("show");
      return;
    }
  }
  const modal = document.getElementById("detailsModal");
  if (modal) {
    modal.classList.remove("show");
    modal.style.display = "none";
  }
}
window.closeModal = closeModal;

function closeConfirmModal() {
  const modal = document.getElementById("confirmSubmitModal");
  if (modal) modal.classList.remove("show");
}
window.closeConfirmModal = closeConfirmModal;

function openConfirmModal() {
  const modal = document.getElementById("confirmSubmitModal");
  if (modal) {
    if (modal.parentElement !== document.body) {
      document.body.appendChild(modal);
    }
    modal.classList.add("show");
  }
}
window.openConfirmModal = openConfirmModal;

function closeSelectBhajanModal() {
  const modal = document.getElementById("selectBhajanModal");
  if (modal) modal.classList.remove("show");
  const titleInput = document.getElementById("bhajanTitleInput");
  if (titleInput) titleInput.focus();
}
window.closeSelectBhajanModal = closeSelectBhajanModal;

function openSelectBhajanModal() {
  const modal = document.getElementById("selectBhajanModal");
  if (modal) {
    if (modal.parentElement !== document.body) {
      document.body.appendChild(modal);
    }
    modal.classList.add("show");
  }
}
window.openSelectBhajanModal = openSelectBhajanModal;

// ============================================================================
// IDEMPOTENT SUBMIT FORM & MODAL ENHANCEMENTS (Works on initial load & Shell mount)
// ============================================================================
const globalModalObserver =
  typeof MutationObserver !== "undefined"
    ? new MutationObserver(() => {
        const hasOpenModal = document.querySelector(".modal.show") !== null;
        document.body.classList.toggle("modal-open", hasOpenModal);
      })
    : null;

function initModalEnhancements(root) {
  const scope = root || document;

  scope.querySelectorAll(".modal").forEach((modal) => {
    if (modal.dataset.modalEnhanced === "1") return;
    modal.dataset.modalEnhanced = "1";

    modal.addEventListener("click", function (e) {
      if (e.target === this) {
        this.classList.remove("show");
        if (this.id === "detailsModal") this.style.display = "none";
      }
    });

    if (globalModalObserver) {
      globalModalObserver.observe(modal, { attributes: true, attributeFilter: ["class"] });
    }
  });

  scope.querySelectorAll(".modal-content").forEach((content) => {
    if (content.dataset.dragEnhanced === "1") return;
    content.dataset.dragEnhanced = "1";

    let startY = 0;
    let currentY = 0;
    let isDragging = false;

    content.addEventListener(
      "touchstart",
      function (e) {
        if (content.scrollTop === 0) {
          startY = e.touches[0].clientY;
          currentY = startY;
          isDragging = true;
        }
      },
      { passive: true }
    );

    content.addEventListener(
      "touchmove",
      function (e) {
        if (!isDragging) return;
        currentY = e.touches[0].clientY;
        const deltaY = currentY - startY;
        if (deltaY > 0) {
          content.style.transform = `translateY(${deltaY}px)`;
          content.style.transition = "none";
        }
      },
      { passive: true }
    );

    content.addEventListener("touchend", function () {
      if (!isDragging) return;
      isDragging = false;
      const deltaY = currentY - startY;
      content.style.transition = "transform 0.24s cubic-bezier(0.16, 1, 0.3, 1)";
      if (deltaY > 85) {
        const modal = content.closest(".modal");
        if (modal) {
          modal.classList.remove("show");
          if (modal.id === "detailsModal") modal.style.display = "none";
        }
        setTimeout(() => {
          content.style.transform = "";
        }, 280);
      } else {
        content.style.transform = "";
      }
    });
  });

  const hasOpenModal = document.querySelector(".modal.show") !== null;
  document.body.classList.toggle("modal-open", hasOpenModal);
}

function initSongbookPicker(root) {
  const scope = root || document;
  const openBtn = scope.querySelector("#openSongbookPickerBtn") || document.getElementById("openSongbookPickerBtn");
  const modal = scope.querySelector("#songbookPickerModal") || document.getElementById("songbookPickerModal");
  const closeBtn = scope.querySelector("#closeSongbookPickerBtn") || document.getElementById("closeSongbookPickerBtn");
  const listContainer = scope.querySelector("#songbookPickerList") || document.getElementById("songbookPickerList");

  if (!openBtn || !modal) return;
  if (openBtn.dataset.sbBound === "1") return;
  openBtn.dataset.sbBound = "1";

  function closeSbModal() {
    modal.classList.remove("show");
  }

  closeBtn?.addEventListener("click", closeSbModal);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeSbModal();
  });

  openBtn.addEventListener("click", async function () {
    modal.classList.add("show");
    if (!listContainer) return;
    listContainer.innerHTML =
      '<div style="text-align:center; padding:24px; color:var(--ink-soft);">Loading your repertoire...</div>';

    try {
      const res = await fetch("/api/singer/songbook");
      if (!res.ok) throw new Error("Please verify your Singer PIN in My Hub first.");
      const data = await res.json();
      const bookmarks = data.bookmarks || [];

      if (bookmarks.length === 0) {
        listContainer.innerHTML = `
          <div style="background:var(--surface-subtle, var(--bg)); border:1px dashed var(--border); border-radius:12px; padding:28px 16px; text-align:center;">
            <div style="width:40px; height:40px; margin:0 auto 10px; display:flex; align-items:center; justify-content:center; background:var(--accent-soft, rgba(200,90,23,0.12)); border-radius:10px; color:var(--saffron-pri, var(--accent));">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>
            </div>
            <h4 style="margin:0 0 6px 0; color:var(--ink);">Your Songbook is Empty</h4>
            <p style="font-size:12.5px; color:var(--ink-soft); margin:0 0 14px 0;">Visit the Master Songbook and tap the star on any bhajan to save it here with your custom singing pitch.</p>
            <a href="/master-bank" class="btn btn-primary" style="font-size:12.5px; padding:8px 16px; text-decoration:none;" onclick="document.getElementById('songbookPickerModal')?.classList.remove('show')">Browse Songbook</a>
          </div>
        `;
        return;
      }

      listContainer.innerHTML = "";
      bookmarks.forEach((item) => {
        const b = item.masterBhajan;
        if (!b) return;

        const row = document.createElement("div");
        row.style.cssText =
          "background:var(--surface-card, var(--surface)); border:1px solid var(--border); border-radius:12px; padding:12px 14px; display:flex; justify-content:space-between; align-items:center; gap:12px;";

        const effectiveScale = item.custom_scale || b.shruti || "";

        row.innerHTML = `
          <div style="flex:1; min-width:0;">
            <div style="display:flex; align-items:center; gap:6px; margin-bottom:4px; flex-wrap:wrap;">
              <span class="deity-pill" style="font-size:10.5px; padding:2px 8px;">
                ${escapeHTML(b.deity)}
              </span>
              ${
                effectiveScale
                  ? `<span style="background:var(--accent-soft, rgba(200,90,23,0.12)); color:var(--saffron-pri, var(--accent)); font-size:11px; font-weight:700; padding:2px 8px; border-radius:6px;">
                      Scale: ${escapeHTML(effectiveScale)}
                    </span>`
                  : ""
              }
            </div>
            <div style="font-size:14.5px; font-weight:700; color:var(--ink); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
              ${escapeHTML(b.title)}
            </div>
            ${
              item.notes
                ? `<div style="font-size:11.5px; color:var(--ink-soft); margin-top:3px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                    <em>${escapeHTML(item.notes)}</em>
                  </div>`
                : ""
            }
          </div>
          <div>
            <button type="button" class="btn btn-primary sb-pick-btn" style="padding:7px 14px; font-size:12.5px; font-weight:700; white-space:nowrap;">
              Select
            </button>
          </div>
        `;

        row.querySelector(".sb-pick-btn").addEventListener("click", function () {
          const bDeities = (b.deity || "")
            .split(/[,;&/]+/)
            .map((s) => s.trim())
            .filter(Boolean);
          let matchedCard = null;
          const availableCards = Array.from(document.querySelectorAll(".deity-card.available"));
          for (const d of bDeities) {
            const dLower = d.toLowerCase();
            matchedCard = availableCards.find((c) => {
              const cardDeity = (c.dataset.deity || "").toLowerCase();
              return (
                cardDeity === dLower ||
                (dLower === "mata" && cardDeity === "devi") ||
                (dLower === "devi" && cardDeity === "mata") ||
                (dLower === "hanuman" && cardDeity === "anjaneya") ||
                (dLower === "anjaneya" && cardDeity === "hanuman")
              );
            });
            if (matchedCard) break;
          }

          if (matchedCard) {
            matchedCard.click();
          }

          closeSbModal();

          // Wait slightly for deity bhajans fetch or populate immediately
          setTimeout(() => {
            const titleInput = document.getElementById("bhajanTitleInput");
            const masterIdInput = document.getElementById("selectedMasterBhajanId");
            const scaleInput = document.getElementById("scaleInput");

            if (titleInput) titleInput.value = b.title;
            if (masterIdInput) masterIdInput.value = b.id;
            if (scaleInput && effectiveScale) scaleInput.value = effectiveScale;

            if (titleInput) {
              titleInput.dispatchEvent(new Event("input", { bubbles: true }));
            }

            const bhajanDetails = document.getElementById("bhajanDetails");
            if (bhajanDetails) {
              bhajanDetails.classList.add("show");
              bhajanDetails.scrollIntoView({ behavior: "smooth", block: "nearest" });
            }
          }, 260);
        });

        listContainer.appendChild(row);
      });
    } catch (err) {
      listContainer.innerHTML = `<div style="color:var(--danger, #dc2626); padding:18px; text-align:center; font-size:13.5px;">${escapeHTML(err.message)}</div>`;
    }
  });
}

function initSubmitFormPage(root) {
  const scope = root || document;
  const form = scope.querySelector("#bhajanForm") || document.getElementById("bhajanForm");
  if (!form) return;
  if (form.dataset.submitFormBound === "1") return;
  form.dataset.submitFormBound = "1";

  const adminInput = form.querySelector('input[name="admin"]');
  const isAdmin = Boolean(adminInput && adminInput.value === "true");

  const singerList = document.getElementById("singerList");
  const singerInput = document.getElementById("singerName");
  const singerSuggestions = document.getElementById("singerSuggestions");
  const genderSelect = document.getElementById("gender");
  const lockedGenderInput = document.getElementById("lockedGender");
  const titleInput = document.getElementById("bhajanTitleInput");
  const suggestions = document.getElementById("bhajanSuggestions");

  let singerNames = [];
  let singersByName = new Map();
  let activeSingerIndex = -1;
  let selectedDeity = document.getElementById("selectedDeity")?.value || null;
  let currentMasterBhajans = [];
  let activeSuggestionIndex = -1;
  let searchTimeout = null;

  // Hoisted scale suggestion fetcher so singerInput, genderSelect, and titleInput can all call it safely!
  const fetchScaleSuggestions = () => {
    const title = titleInput ? titleInput.value.trim() : "";
    const singer = singerInput ? singerInput.value.trim() : "";
    const gender = genderSelect ? genderSelect.value.trim() : "";

    const prevBadge = document.getElementById("singerPrevScaleBadge");
    const prevVal = document.getElementById("singerPrevScaleVal");
    const genderBadge = document.getElementById("genderCommonScaleBadge");
    const genderLabel = document.getElementById("genderCommonScaleLabel");
    const genderVal = document.getElementById("genderCommonScaleVal");

    if (!title) {
      if (prevBadge) prevBadge.style.display = "none";
      if (genderBadge) genderBadge.style.display = "none";
      return;
    }

    const params = new URLSearchParams({
      title,
      singer_name: singer,
      gender
    });

    fetch("/api/scale-suggestions?" + params.toString())
      .then((res) => res.json())
      .then((data) => {
        if (data && data.singerPreviousScale && prevBadge && prevVal) {
          prevVal.textContent = data.singerPreviousScale;
          prevBadge.style.display = "block";
        } else if (prevBadge) {
          prevBadge.style.display = "none";
        }

        if (data && data.mostCommonGenderScale && genderBadge && genderLabel && genderVal) {
          genderLabel.textContent = data.mostCommonGenderScale.gender;
          genderVal.textContent = data.mostCommonGenderScale.scale;
          genderBadge.style.display = "block";
        } else if (genderBadge) {
          genderBadge.style.display = "none";
        }
      })
      .catch(() => {
        if (prevBadge) prevBadge.style.display = "none";
        if (genderBadge) genderBadge.style.display = "none";
      });
  };

  const hideSingerSuggestions = () => {
    singerSuggestions?.classList.remove("show");
    singerInput?.setAttribute("aria-expanded", "false");
  };

  const applySingerGender = (name) => {
    const singer = singersByName.get((name || "").trim().toLocaleLowerCase());
    if (singer?.gender && genderSelect) {
      const genderChanged = genderSelect.value !== singer.gender;
      genderSelect.value = singer.gender;
      genderSelect.disabled = true;
      genderSelect.setAttribute("aria-disabled", "true");
      if (lockedGenderInput) lockedGenderInput.value = singer.gender;
      if (genderChanged) genderSelect.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (genderSelect && !singerInput?.hasAttribute("readonly")) {
      genderSelect.disabled = false;
      genderSelect.removeAttribute("aria-disabled");
      if (lockedGenderInput) lockedGenderInput.value = "";
    }
  };

  const renderSingerSuggestions = () => {
    if (!singerInput || !singerSuggestions || singerInput.readOnly) return;
    const search = singerInput.value.trim().toLocaleLowerCase();
    const matches = singerNames
      .filter((name) => name.toLocaleLowerCase().includes(search))
      .slice(0, 12);
    singerSuggestions.innerHTML = "";
    activeSingerIndex = -1;
    matches.forEach((name, index) => {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "bhajan-suggestion";
      option.setAttribute("role", "option");
      option.id = `singer-suggestion-${index}`;
      option.textContent = name;
      option.addEventListener("mousedown", (event) => {
        event.preventDefault();
        singerInput.value = name;
        applySingerGender(name);
        hideSingerSuggestions();
        fetchScaleSuggestions();
      });
      singerSuggestions.appendChild(option);
    });
    const hasMatches = matches.length > 0;
    singerSuggestions.classList.toggle("show", hasMatches);
    singerInput.setAttribute("aria-expanded", String(hasMatches));
  };

  if (singerList) {
    fetch("/api/singers")
      .then((res) => res.json())
      .then((data) => {
        if (!Array.isArray(data)) return;
        singerNames = data.map((s) => s.name);
        singersByName = new Map(data.map((s) => [s.name.toLocaleLowerCase(), s]));
        singerList.innerHTML = "";
        data.forEach((singer) => {
          const option = document.createElement("option");
          option.value = singer.name;
          singerList.appendChild(option);
        });
        if (singerInput?.value) applySingerGender(singerInput.value);
      })
      .catch(() => {});
  }

  singerInput?.addEventListener("input", () => {
    applySingerGender(singerInput.value);
    renderSingerSuggestions();
    fetchScaleSuggestions();
  });
  singerInput?.addEventListener("blur", () => setTimeout(hideSingerSuggestions, 150));
  singerInput?.addEventListener("keydown", (event) => {
    const options = Array.from(singerSuggestions?.querySelectorAll(".bhajan-suggestion") || []);
    if (!options.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      activeSingerIndex =
        event.key === "ArrowDown"
          ? (activeSingerIndex + 1) % options.length
          : (activeSingerIndex - 1 + options.length) % options.length;
      options.forEach((opt, idx) => opt.classList.toggle("active", idx === activeSingerIndex));
      singerInput.setAttribute("aria-activedescendant", options[activeSingerIndex].id);
    } else if (event.key === "Enter" && activeSingerIndex >= 0) {
      event.preventDefault();
      options[activeSingerIndex].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    } else if (event.key === "Escape") {
      hideSingerSuggestions();
    }
  });

  // Restore or lock verified singer identity
  const nameInput = form.querySelector('input[name="singer_name"]');
  if (nameInput) {
    const verifiedName = nameInput.getAttribute("data-verified-singer") || "";
    const verifiedGender = nameInput.getAttribute("data-verified-gender") || "";
    if (verifiedName && verifiedName.trim().length > 0) {
      nameInput.value = verifiedName.trim();
      try {
        localStorage.setItem("bj_singer_name", verifiedName.trim());
        if (verifiedGender) localStorage.setItem("bj_gender", verifiedGender);
      } catch (_) {}
      if (verifiedGender && genderSelect) {
        genderSelect.value = verifiedGender;
      }
    } else if (!isAdmin) {
      try {
        const savedName = localStorage.getItem("bj_singer_name");
        const savedGender = localStorage.getItem("bj_gender");
        if (savedName && !nameInput.value) nameInput.value = savedName;
        if (savedGender && genderSelect && !genderSelect.value) genderSelect.value = savedGender;
      } catch (_) {}
    }
  }

  const normalizeForSearch = (str) =>
    (str || "")
      .toLowerCase()
      .replace(/[''`".,;:!?()[\]{}/\\-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const hideBhajanSuggestions = () => {
    suggestions?.classList.remove("show");
    titleInput?.setAttribute("aria-expanded", "false");
  };

  const renderBhajanSuggestions = () => {
    if (!suggestions || !titleInput || !selectedDeity) return;
    const rawSearch = titleInput.value.trim();
    const search = normalizeForSearch(rawSearch);
    const searchTokens = search.split(" ").filter(Boolean);

    const matches = currentMasterBhajans
      .filter((bhajan) => {
        if (!search) return true;
        const normTitle = normalizeForSearch(bhajan.title);
        if (normTitle.includes(search)) return true;
        if (searchTokens.length > 1 && searchTokens.every((tok) => normTitle.includes(tok))) {
          return true;
        }
        return false;
      })
      .slice(0, 12);

    suggestions.innerHTML = "";
    activeSuggestionIndex = -1;
    matches.forEach((bhajan, index) => {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "bhajan-suggestion";
      option.setAttribute("role", "option");
      option.id = `bhajan-suggestion-${index}`;
      option.textContent = bhajan.title;
      option.addEventListener("mousedown", (event) => {
        event.preventDefault();
        titleInput.value = bhajan.title;
        const masterIdInput = document.getElementById("selectedMasterBhajanId");
        if (masterIdInput) masterIdInput.value = bhajan.id;
        hideBhajanSuggestions();
        titleInput.dispatchEvent(new Event("input", { bubbles: true }));
      });
      suggestions.appendChild(option);
    });

    const hasMatches = matches.length > 0;
    suggestions.classList.toggle("show", hasMatches);
    titleInput.setAttribute("aria-expanded", String(hasMatches));
  };

  const femaleFallbackShruti = (maleShruti) => {
    const match = String(maleShruti || "")
      .trim()
      .match(/^(1|1\.5|2|2\.5|3|4|4\.5|5|5\.5|6|6\.5|7)\s*([pPmM])$/);
    if (!match) return "";
    const values = ["1", "1.5", "2", "2.5", "3", "4", "4.5", "5", "5.5", "6", "6.5", "7"];
    let pitch = values.indexOf(match[1]);
    if (match[2].toUpperCase() === "M") pitch = (pitch + 5) % 12;
    const femalePitch = (pitch - 5 + 12) % 12;
    return `${values[femalePitch]}P`;
  };

  const scaleForGender = (bhajan, gender) => {
    const femaleShruti = String(bhajan.shruti_female || "").trim();
    const rawMaleShruti = String(bhajan.shruti || "").trim();
    const maleShruti = rawMaleShruti === "#N/A" ? "" : rawMaleShruti;
    if (gender === "Female") {
      if (femaleShruti && femaleShruti !== "#N/A") {
        return { scale: femaleShruti, usedFallback: false };
      }
      return { scale: femaleFallbackShruti(maleShruti) || maleShruti, usedFallback: true };
    }
    return { scale: maleShruti, usedFallback: false };
  };

  function handleDeityCardSelect(card, skipFocus) {
    if (!card || !card.classList.contains("available")) return;
    form.querySelectorAll(".deity-card").forEach((c) => c.classList.remove("selected"));
    card.classList.add("selected");
    selectedDeity = card.dataset.deity;

    const selInput = document.getElementById("selectedDeity");
    if (selInput) selInput.value = selectedDeity;
    const disp = document.getElementById("deityDisplay");
    if (disp) disp.textContent = selectedDeity;
    const details = document.getElementById("bhajanDetails");
    if (details) {
      details.classList.add("show");
      details.style.display = "block";
    }

    if (titleInput) {
      titleInput.value = "";
      titleInput.placeholder = `Loading ${selectedDeity} bhajans...`;
      if (!skipFocus) titleInput.focus({ preventScroll: true });
    }
    const masterIdInput = document.getElementById("selectedMasterBhajanId");
    if (masterIdInput) masterIdInput.value = "";
    const badge = document.getElementById("masterDataBadge");
    if (badge) badge.style.display = "none";

    const prefScaleEl = document.getElementById("singerPreferredScale");
    const scaleInputEl = document.getElementById("scaleInput");
    if (prefScaleEl && prefScaleEl.value && scaleInputEl && !scaleInputEl.value) {
      scaleInputEl.value = prefScaleEl.value;
      scaleInputEl.dispatchEvent(new Event("input", { bubbles: true }));
    }

    fetch(`/api/master-bhajans/${encodeURIComponent(selectedDeity)}`)
      .then((response) => response.json())
      .then((data) => {
        currentMasterBhajans = Array.isArray(data) ? data : [];
        if (titleInput) {
          titleInput.placeholder = `Search ${currentMasterBhajans.length} ${selectedDeity} bhajans...`;
          if (titleInput.value) {
            titleInput.dispatchEvent(new Event("input", { bubbles: true }));
          } else {
            renderBhajanSuggestions();
          }
        }
      })
      .catch(() => {
        if (titleInput) titleInput.placeholder = "Type bhajan name here...";
      });

    if (!skipFocus) {
      requestAnimationFrame(() => {
        if (details) details.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    }
  }

  form.querySelectorAll(".deity-card.available").forEach((card) => {
    card.addEventListener("click", function () {
      handleDeityCardSelect(this, false);
    });
  });

  if (titleInput) {
    titleInput.addEventListener("input", function (e) {
      if (e.isTrusted) {
        const masterIdInput = document.getElementById("selectedMasterBhajanId");
        if (masterIdInput) masterIdInput.value = "";
      }
      const enteredTitle = e.target.value.trim().toLocaleLowerCase();
      const exactMatch = currentMasterBhajans.find(
        (bhajan) => bhajan.title.trim().toLocaleLowerCase() === enteredTitle
      );
      if (exactMatch) {
        const masterIdInput = document.getElementById("selectedMasterBhajanId");
        if (masterIdInput && !masterIdInput.value) masterIdInput.value = exactMatch.id;
        hideBhajanSuggestions();
      } else {
        renderBhajanSuggestions();
      }

      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        const selectedTitle = e.target.value;
        const matchedBhajan = currentMasterBhajans.find((b) => b.title === selectedTitle);
        const cleanValue = (val) =>
          val && val !== "#N/A" && String(val).trim() !== "" ? val : "Not specified";
        const warningDiv = document.getElementById("cooldownWarning");

        if (selectedTitle.trim().length > 0) {
          fetch("/api/check-cooldown?title=" + encodeURIComponent(selectedTitle))
            .then((res) => res.json())
            .then((data) => {
              if (data && warningDiv) {
                const safeSinger = escapeHTML(data.singer_name);
                const safeDate = escapeHTML(data.session_date);
                warningDiv.innerHTML = `<strong>Cool-down warning:</strong> This bhajan was last sung by <strong>${safeSinger}</strong> on <strong>${safeDate}</strong>.`;
                warningDiv.style.display = "block";
              } else if (warningDiv) {
                warningDiv.style.display = "none";
              }
            })
            .catch(() => {});
          fetchScaleSuggestions();
        } else {
          if (warningDiv) warningDiv.style.display = "none";
          fetchScaleSuggestions();
        }

        if (matchedBhajan) {
          const gender = genderSelect ? genderSelect.value : "";
          const scaleSelection = scaleForGender(matchedBhajan, gender);
          const scaleInput = document.getElementById("scaleInput");
          if (scaleInput) {
            scaleInput.value = scaleSelection.scale;
            scaleInput.dispatchEvent(new Event("input", { bubbles: true }));
          }
          const speedEl = document.getElementById("speedInput");
          if (speedEl) speedEl.value = cleanValue(matchedBhajan.tempo);
          const ragaEl = document.getElementById("ragaInput");
          if (ragaEl) ragaEl.value = cleanValue(matchedBhajan.raga);
          const levelEl = document.getElementById("hiddenLevel");
          if (levelEl) levelEl.value = matchedBhajan.level || "";
          const langEl = document.getElementById("hiddenLanguage");
          if (langEl) langEl.value = matchedBhajan.language || "";

          const badge = document.getElementById("masterDataBadge");
          let badgeText = "";
          const cleanRaag = cleanValue(matchedBhajan.raga);
          if (cleanRaag !== "Not specified") badgeText += `(Raag: ${cleanRaag})`;
          if (scaleSelection.usedFallback) {
            badgeText += `${badgeText ? " " : ""}(Female shruti: −5 from ${matchedBhajan.shruti})`;
          }
          const badgeDetailsEl = document.getElementById("badgeDetails");
          if (badgeDetailsEl) badgeDetailsEl.textContent = badgeText;

          const sheetLinkSpan = document.getElementById("badgeSheetLink");
          const sheetAnchor = document.getElementById("sheetMusicLink");
          if (sheetLinkSpan && sheetAnchor) {
            if (matchedBhajan.sheet_filename) {
              sheetAnchor.href = `/sheets/${encodeURIComponent(matchedBhajan.sheet_filename)}`;
              sheetLinkSpan.style.display = "inline-block";
            } else {
              sheetLinkSpan.style.display = "none";
            }
          }

          const lyricsLinkSpan = document.getElementById("badgeLyricsLink");
          const lyricsAnchor = document.getElementById("lyricsPageLink");
          if (lyricsLinkSpan && lyricsAnchor && matchedBhajan.id) {
            lyricsAnchor.href = `/bhajan/${matchedBhajan.id}`;
            lyricsLinkSpan.style.display = "inline-block";
          } else if (lyricsLinkSpan) {
            lyricsLinkSpan.style.display = "none";
          }

          if (badge) badge.style.display = "flex";
        } else {
          const badge = document.getElementById("masterDataBadge");
          if (badge) badge.style.display = "none";
          const sheetLinkSpan = document.getElementById("badgeSheetLink");
          if (sheetLinkSpan) sheetLinkSpan.style.display = "none";
          const lyricsLinkSpan = document.getElementById("badgeLyricsLink");
          if (lyricsLinkSpan) lyricsLinkSpan.style.display = "none";
          const speedEl = document.getElementById("speedInput");
          if (speedEl) speedEl.value = "Not specified";
          const ragaEl = document.getElementById("ragaInput");
          if (ragaEl) ragaEl.value = "Not specified";
          const levelEl = document.getElementById("hiddenLevel");
          if (levelEl) levelEl.value = "";
          const langEl = document.getElementById("hiddenLanguage");
          if (langEl) langEl.value = "";
        }
      }, 220);
    });

    titleInput.addEventListener("focus", renderBhajanSuggestions);
    titleInput.addEventListener("blur", () => setTimeout(hideBhajanSuggestions, 150));
    titleInput.addEventListener("keydown", (event) => {
      const options = Array.from(suggestions?.querySelectorAll(".bhajan-suggestion") || []);
      if (!options.length) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        activeSuggestionIndex =
          event.key === "ArrowDown"
            ? (activeSuggestionIndex + 1) % options.length
            : (activeSuggestionIndex - 1 + options.length) % options.length;
        options.forEach((opt, idx) => opt.classList.toggle("active", idx === activeSuggestionIndex));
        titleInput.setAttribute("aria-activedescendant", options[activeSuggestionIndex].id);
      } else if (event.key === "Enter") {
        event.preventDefault();
        if (activeSuggestionIndex >= 0 && options[activeSuggestionIndex]) {
          options[activeSuggestionIndex].dispatchEvent(
            new MouseEvent("mousedown", { bubbles: true })
          );
        } else if (options.length > 0) {
          options[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        }
      } else if (event.key === "Escape") {
        hideBhajanSuggestions();
      }
    });
  }

  genderSelect?.addEventListener("change", function (e) {
    const selectedTitle = titleInput ? titleInput.value : "";
    if (selectedTitle && currentMasterBhajans.length > 0) {
      const matchedBhajan = currentMasterBhajans.find((b) => b.title === selectedTitle);
      if (matchedBhajan) {
        const scaleInput = document.getElementById("scaleInput");
        if (scaleInput) {
          scaleInput.value = scaleForGender(matchedBhajan, e.target.value).scale;
          scaleInput.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }
    }
    fetchScaleSuggestions();
  });

  // Handle Songbook / Master Bank URL prefill query params
  try {
    const params = new URLSearchParams(window.location.search);
    const prefillTitle = params.get("prefill_title");
    const prefillDeity = params.get("prefill_deity");
    const prefillScale = params.get("prefill_scale");
    const prefillSpeed = params.get("prefill_speed");
    const masterId = params.get("master_id");

    if (prefillDeity) {
      const prefillDeities = prefillDeity
        .split(/[,;&/]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      const deityCard = Array.from(form.querySelectorAll(".deity-card.available")).find((c) => {
        const cardDeity = (c.dataset.deity || "").toLowerCase();
        return prefillDeities.some(
          (pd) =>
            pd === cardDeity ||
            (pd === "mata" && cardDeity === "devi") ||
            (pd === "devi" && cardDeity === "mata") ||
            (pd === "hanuman" && cardDeity === "anjaneya") ||
            (pd === "anjaneya" && cardDeity === "hanuman")
        );
      });
      if (deityCard) {
        handleDeityCardSelect(deityCard, true);
        if (prefillTitle) {
          setTimeout(() => {
            if (titleInput) {
              titleInput.value = prefillTitle;
              const masterIdInput = document.getElementById("selectedMasterBhajanId");
              if (masterIdInput && masterId) masterIdInput.value = masterId;
              if (prefillScale) {
                const scaleEl = document.getElementById("scaleInput");
                if (scaleEl) {
                  scaleEl.value = prefillScale;
                  scaleEl.dispatchEvent(new Event("input", { bubbles: true }));
                }
              }
              if (prefillSpeed) {
                const speedEl = document.getElementById("speedInput");
                if (speedEl) speedEl.value = prefillSpeed;
              }
              titleInput.dispatchEvent(new Event("input"));
            }
          }, 350);
        }
      }
    }
  } catch (_) {}

  // Pre-Submit Confirmation Modal & Form Submission
  const preSubmitBtn = document.getElementById("preSubmitBtn");
  const confirmSubmitModal = document.getElementById("confirmSubmitModal");
  const editBtn = document.getElementById("editBtn");
  const confirmBtn = document.getElementById("confirmBtn");
  const closeSelectBhajanBtn = document.getElementById("closeSelectBhajanModalBtn");

  preSubmitBtn?.addEventListener("click", function () {
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    if (!document.getElementById("selectedDeity")?.value) {
      alert("Please select a deity slot first.");
      return;
    }

    const masterIdInput = document.getElementById("selectedMasterBhajanId");
    if (!masterIdInput || !masterIdInput.value) {
      openSelectBhajanModal();
      return;
    }

    const singer = document.getElementById("singerName")?.value || "";
    const partner = document.getElementById("partnerName")?.value || "";
    const modSinger = document.getElementById("modSinger");
    if (modSinger) modSinger.textContent = singer + (partner ? ` (& ${partner})` : "");

    const modDeity = document.getElementById("modDeity");
    if (modDeity) modDeity.textContent = document.getElementById("selectedDeity")?.value || "";

    const modTitle = document.getElementById("modTitle");
    if (modTitle) modTitle.textContent = titleInput?.value || "";

    const modScale = document.getElementById("modScale");
    if (modScale) modScale.textContent = document.getElementById("scaleInput")?.value || "Not specified";

    openConfirmModal();
  });

  editBtn?.addEventListener("click", closeConfirmModal);
  closeSelectBhajanBtn?.addEventListener("click", closeSelectBhajanModal);

  let confirmedReadyToSubmit = false;

  confirmBtn?.addEventListener("click", function () {
    if (!isAdmin) {
      try {
        const name = form.querySelector('input[name="singer_name"]')?.value || "";
        const gender = form.querySelector('select[name="gender"]')?.value || "";
        if (name) localStorage.setItem("bj_singer_name", name);
        if (gender) localStorage.setItem("bj_gender", gender);
      } catch (_) {}
    }

    const token = getGlobalCsrfToken();
    let csrfInput = form.querySelector('input[name="_csrf"]');
    if (!csrfInput && token) {
      csrfInput = document.createElement("input");
      csrfInput.type = "hidden";
      csrfInput.name = "_csrf";
      csrfInput.value = token;
      form.appendChild(csrfInput);
    } else if (csrfInput && !csrfInput.value && token) {
      csrfInput.value = token;
    }

    confirmedReadyToSubmit = true;
    closeConfirmModal();

    if (typeof form.requestSubmit === "function") {
      form.requestSubmit();
    } else {
      form.submit();
    }
  });

  form.addEventListener("submit", function (e) {
    const masterIdInput = document.getElementById("selectedMasterBhajanId");
    if (!masterIdInput || !masterIdInput.value) {
      e.preventDefault();
      openSelectBhajanModal();
      return;
    }
    if (!confirmedReadyToSubmit && confirmSubmitModal && !confirmSubmitModal.classList.contains("show")) {
      e.preventDefault();
      preSubmitBtn?.click();
      return;
    }
    confirmedReadyToSubmit = false;

    const token = getGlobalCsrfToken();
    let csrfInput = form.querySelector('input[name="_csrf"]');
    if (!csrfInput && token) {
      csrfInput = document.createElement("input");
      csrfInput.type = "hidden";
      csrfInput.name = "_csrf";
      csrfInput.value = token;
      form.appendChild(csrfInput);
    } else if (csrfInput && !csrfInput.value && token) {
      csrfInput.value = token;
    }
  });
}

function initPageEnhancements(root) {
  initModalEnhancements(root);
  initSubmitFormPage(root);
  initSongbookPicker(root);
}
window.initPageEnhancements = initPageEnhancements;

// Global Escape key closes any open .modal.show
window.addEventListener("keydown", function (event) {
  if (event.key === "Escape") {
    document.querySelectorAll(".modal.show").forEach((m) => {
      m.classList.remove("show");
      if (m.id === "detailsModal") m.style.display = "none";
    });
  }
});

// ============================================================================
// ADMIN PORTAL & TABLE UTILITIES
// ============================================================================
function bindAdminSidebar() {
  const sidebarToggle = document.getElementById("sidebarToggle");
  const mobileSidebarToggle = document.getElementById("mobileSidebarToggle");
  const sidebarOverlay = document.getElementById("sidebarOverlay");

  if (localStorage.getItem("admin_sidebar_collapsed") === "true" && window.innerWidth > 1024) {
    document.body.classList.add("sidebar-collapsed");
  }

  window.toggleAdminSidebar = function (e) {
    if (e && e.preventDefault) e.preventDefault();
    if (window.innerWidth <= 1024) {
      window.closeMobileSidebar();
      return;
    }
    document.body.classList.toggle("sidebar-collapsed");
    try {
      localStorage.setItem(
        "admin_sidebar_collapsed",
        String(document.body.classList.contains("sidebar-collapsed"))
      );
    } catch (_) {}
  };

  window.toggleMobileSidebar = function (e) {
    if (e) {
      if (e.preventDefault) e.preventDefault();
      if (e.stopPropagation) e.stopPropagation();
    }
    const now = Date.now();
    if (window._lastMobileSidebarToggle && now - window._lastMobileSidebarToggle < 250) {
      return;
    }
    window._lastMobileSidebarToggle = now;
    document.body.classList.toggle("mobile-sidebar-open");
  };

  window.closeMobileSidebar = function (e) {
    if (e && e.preventDefault) e.preventDefault();
    document.body.classList.remove("mobile-sidebar-open");
  };

  if (sidebarToggle && !sidebarToggle._sidebarBound) {
    sidebarToggle._sidebarBound = true;
    sidebarToggle.addEventListener("click", function (e) {
      if (window.innerWidth <= 1024) {
        window.closeMobileSidebar(e);
      } else {
        window.toggleAdminSidebar(e);
      }
    });
  }

  if (mobileSidebarToggle && !mobileSidebarToggle._mobileBound) {
    mobileSidebarToggle._mobileBound = true;
    mobileSidebarToggle.addEventListener("click", window.toggleMobileSidebar);
  }

  if (sidebarOverlay && !sidebarOverlay._overlayBound) {
    sidebarOverlay._overlayBound = true;
    sidebarOverlay.addEventListener("click", window.closeMobileSidebar);
  }

  document.querySelectorAll(".sidebar-nav a, .sidebar-footer a").forEach((link) => {
    if (!link._sidebarCloseBound) {
      link._sidebarCloseBound = true;
      link.addEventListener("click", () => {
        if (window.innerWidth <= 1024) window.closeMobileSidebar();
      });
    }
  });

  if (!window._adminResizeBound) {
    window._adminResizeBound = true;
    window.addEventListener("resize", () => {
      if (window.innerWidth > 1024) window.closeMobileSidebar();
    });
  }
}

function initAdminPortal() {
  try {
    initPageEnhancements(document);
  } catch (err) {
    console.warn("initPageEnhancements error:", err);
  }

  bindAdminSidebar();

  if (
    new URLSearchParams(window.location.search).get("copy") === "true" &&
    typeof openCopySessionModal === "function"
  ) {
    setTimeout(openCopySessionModal, 0);
  }

  // Drag & Drop Sequence Reordering (Admin Date View)
  const sortableBody = document.getElementById("sortable-body");
  if (sortableBody) {
    let draggedRow = null;
    let touchRow = null;

    const updateRowIndexNumbers = () => {
      sortableBody.querySelectorAll("tr[data-id]").forEach((row, index) => {
        const numEl = row.querySelector(".row-num");
        if (numEl) numEl.textContent = index + 1;
      });
    };

    sortableBody.addEventListener("dragstart", (e) => {
      draggedRow = e.target.closest("tr");
      if (!draggedRow) return;
      e.dataTransfer.effectAllowed = "move";
      setTimeout(() => (draggedRow.style.opacity = "0.5"), 0);
    });

    sortableBody.addEventListener("dragover", (e) => {
      e.preventDefault();
      const targetRow = e.target.closest("tr");
      if (targetRow && targetRow !== draggedRow && targetRow.parentNode === sortableBody) {
        const rect = targetRow.getBoundingClientRect();
        const next = (e.clientY - rect.top) / (rect.bottom - rect.top) > 0.5;
        sortableBody.insertBefore(draggedRow, next ? targetRow.nextSibling : targetRow);
        updateRowIndexNumbers();
        const saveBtn = document.getElementById("saveOrderBtn");
        if (saveBtn) saveBtn.style.display = "inline-block";
      }
    });

    sortableBody.addEventListener("dragend", () => {
      if (draggedRow) draggedRow.style.opacity = "1";
      updateRowIndexNumbers();
    });

    sortableBody.addEventListener(
      "touchstart",
      (e) => {
        const handle = e.target.closest(".drag-handle");
        if (!handle) return;
        touchRow = e.target.closest("tr");
        if (!touchRow) return;
        touchRow.style.opacity = "0.6";
        touchRow.style.background = "var(--success-bg)";
      },
      { passive: true }
    );

    sortableBody.addEventListener(
      "touchmove",
      (e) => {
        if (!touchRow) return;
        const currentY = e.touches[0].clientY;
        const elementUnderTouch = document.elementFromPoint(e.touches[0].clientX, currentY);
        if (!elementUnderTouch) return;
        const targetRow = elementUnderTouch.closest("#sortable-body tr[data-id]");
        if (targetRow && targetRow !== touchRow) {
          const rect = targetRow.getBoundingClientRect();
          const next = (currentY - rect.top) / (rect.bottom - rect.top) > 0.5;
          sortableBody.insertBefore(touchRow, next ? targetRow.nextSibling : targetRow);
          updateRowIndexNumbers();
          const saveBtn = document.getElementById("saveOrderBtn");
          if (saveBtn) saveBtn.style.display = "inline-block";
        }
      },
      { passive: true }
    );

    sortableBody.addEventListener("touchend", () => {
      if (touchRow) {
        touchRow.style.opacity = "1";
        touchRow.style.background = "";
        touchRow = null;
        updateRowIndexNumbers();
      }
    });
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initAdminPortal);
} else {
  initAdminPortal();
}

let filterTableTimeout;
function filterTable() {
  clearTimeout(filterTableTimeout);
  filterTableTimeout = setTimeout(() => {
    const inputs = document.querySelectorAll("#dbTable .filter-input");
    const table = document.getElementById("dbTable");
    if (!table) return;
    const tr = table.getElementsByTagName("tr");

    for (let i = 2; i < tr.length; i++) {
      let rowVisible = true;
      for (let j = 0; j < inputs.length; j++) {
        const filter = inputs[j].value.toUpperCase();
        const td = tr[i].getElementsByTagName("td")[j];
        if (td) {
          const txtValue = td.textContent || td.innerText;
          if (txtValue.toUpperCase().indexOf(filter) === -1) {
            rowVisible = false;
            break;
          }
        }
      }
      tr[i].style.display = rowVisible ? "" : "none";
    }
  }, 200);
}
window.filterTable = filterTable;

// Admin Calendar Modal Logic
let currentAdminDate = null;

function openAdminDateModal(date, type, description) {
  currentAdminDate = date;
  document.getElementById("adminModalDate").textContent = "Manage " + date;
  document.getElementById("permDescription").value = description || "";
  document.getElementById("adminDateModal").classList.add("show");
}
window.openAdminDateModal = openAdminDateModal;

function closeAdminModal() {
  document.getElementById("adminDateModal")?.classList.remove("show");
}
window.closeAdminModal = closeAdminModal;

function viewAdminDate() {
  if (currentAdminDate) window.location.href = "/admin/date/" + currentAdminDate;
}
window.viewAdminDate = viewAdminDate;

function updatePermission(type) {
  if (!currentAdminDate) return;
  const description = document.getElementById("permDescription").value.trim();

  if (type !== "clear" && !description) {
    alert("Description is mandatory for Special/Festival sessions.");
    return;
  }

  fetch("/admin/permission", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ date: currentAdminDate, type, description })
  })
    .then((res) => {
      if (res.status === 401) {
        alert("Your admin session has expired. Please log in again.");
        window.location.href = "/admin-login";
        return null;
      }
      return res.json();
    })
    .then((data) => {
      if (!data) return;
      if (data.success) location.reload();
      else alert(data.error || "Error updating permission");
    })
    .catch((err) => alert("Network error updating permission: " + err.message));
}
window.updatePermission = updatePermission;

// Missing Bhajan Catcher Modals
function openMissingBhajanModal(title) {
  document.getElementById("mbTitle").value = title;
  document.getElementById("mbDeity").value = "Sai";
  document.getElementById("mbTempo").value = "Medium";
  document.getElementById("mbRaga").value = "";
  document.getElementById("mbShruti").value = "";
  document.getElementById("mbShrutiFemale").value = "";
  document.getElementById("mbLevel").value = "";
  document.getElementById("missingBhajanModal").classList.add("show");
}
window.openMissingBhajanModal = openMissingBhajanModal;

function closeMissingBhajanModal() {
  document.getElementById("missingBhajanModal")?.classList.remove("show");
}
window.closeMissingBhajanModal = closeMissingBhajanModal;

async function reconcileBhajan(submittedTitle, action, masterBhajanId) {
  if (action === "link") {
    const ok = window.BPSheet
      ? await window.BPSheet.confirm(`Link all historical submissions of "${submittedTitle}" to the master bhajan? This will update all matching session records.`)
      : confirm(
          `Link all historical submissions of:\n\n"${submittedTitle}"\n\n...to the master bhajan? This will update all matching session records.`
        );
    if (!ok) return;
  }

  fetch("/api/admin/reconcile-bhajan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      submitted_title: submittedTitle,
      action,
      master_bhajan_id: masterBhajanId
    })
  })
    .then((res) => res.json())
    .then((data) => {
      if (data.success) {
        if (action === "link") {
          alert(
            `Done! Updated ${data.updatedCount} session record(s) to use master title:\n"${data.masterTitle}"`
          );
          const card = document.getElementById("card-" + encodeURIComponent(submittedTitle));
          if (card) card.remove();
        }
      } else {
        alert("Error: " + (data.error || "Unknown error"));
      }
    })
    .catch((err) => alert("Request failed: " + err.message));
}
window.reconcileBhajan = reconcileBhajan;

function saveMissingBhajan() {
  const data = {
    title: document.getElementById("mbTitle").value,
    deity: document.getElementById("mbDeity").value,
    tempo: document.getElementById("mbTempo").value,
    raga: document.getElementById("mbRaga").value,
    shruti: document.getElementById("mbShruti").value,
    shruti_female: document.getElementById("mbShrutiFemale").value,
    level: document.getElementById("mbLevel").value
  };
  fetch("/api/add-master-bhajan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  })
    .then((res) => res.json())
    .then((result) => {
      if (result.success) {
        alert("Successfully added to Master Database!");
        location.reload();
      } else {
        alert("Error adding to Master DB: " + result.error);
      }
    });
}
window.saveMissingBhajan = saveMissingBhajan;

function saveDeityRules() {
  const table = document.getElementById("rulesTable");
  const date = document.getElementById("ruleDate")?.value;
  if (!table) return;

  const rules = [];
  const trs = table.getElementsByTagName("tbody")[0].getElementsByTagName("tr");

  for (const tr of trs) {
    const deity = tr.querySelector(".rule-deity").value;
    const min = parseInt(tr.querySelector(".rule-min").value, 10);
    const max = parseInt(tr.querySelector(".rule-max").value, 10);
    rules.push({ deity_name: deity, min_required: min, max_allowed: max });
  }

  fetch("/admin/update-rules", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rules, date })
  })
    .then((res) => res.json())
    .then((data) => {
      if (data.success) {
        alert(data.message);
        window.location.href = date === "default" ? "/admin" : "/admin/date/" + date;
      } else {
        alert("Error: " + data.error);
      }
    });
}
window.saveDeityRules = saveDeityRules;

function getWesternScale(indianScale) {
  if (!indianScale || indianScale === "-" || indianScale === "Not specified") return "-";
  const match = indianScale
    .toString()
    .trim()
    .match(/^([\d.]+)\s*([PMpm])?.*$/);
  if (!match) return "-";
  const numMap = {
    1: 0,
    1.5: 1,
    2: 2,
    2.5: 3,
    3: 4,
    4: 5,
    4.5: 6,
    5: 7,
    5.5: 8,
    6: 9,
    6.5: 10,
    7: 11
  };
  if (numMap[match[1]] === undefined) return "-";
  let index = numMap[match[1]];
  if ((match[2] || "").toUpperCase() === "M") index = (index + 5) % 12;
  return ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"][index];
}
window.getWesternScale = getWesternScale;

function editMasterRow(id) {
  if (typeof window.openAdminEditBhajanModal === "function") {
    return window.openAdminEditBhajanModal(id);
  }
  const row = document.getElementById(`row-${id}`);
  if (!row) return;
  const cells = row.querySelectorAll(".edit-cell");

  cells.forEach((cell) => {
    const rawVal = cell.textContent || "";
    const currentValue = rawVal.trim() === "-" ? "" : rawVal.trim();
    const fieldName = cell.getAttribute("data-field");
    const safeValue = currentValue.replace(/"/g, "&quot;");
    cell.innerHTML = `<input type="text" id="input-${id}-${fieldName}" value="${safeValue}" class="filter-input" style="width: 100%; padding: 6px 8px; border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 13px;">`;
  });

  const actionCell = row.querySelector(".action-cell");
  if (actionCell) {
    actionCell.innerHTML = `<button class="button" style="padding:6px 12px; font-size:12px; background:#28a745; border:none;" onclick="saveMasterRow(${id})">Save</button>`;
  }
}
window.editMasterRow = editMasterRow;

function saveMasterRow(id) {
  const updatedData = {
    title: document.getElementById(`input-${id}-title`)?.value.trim() || "",
    deity: document.getElementById(`input-${id}-deity`)?.value.trim() || "",
    tempo: document.getElementById(`input-${id}-tempo`)?.value.trim() || "",
    raga: document.getElementById(`input-${id}-raga`)?.value.trim() || "",
    shruti: document.getElementById(`input-${id}-shruti`)?.value.trim() || "",
    shruti_female: document.getElementById(`input-${id}-shruti_female`)?.value.trim() || "",
    level: document.getElementById(`input-${id}-level`)?.value.trim() || ""
  };

  fetch(`/api/admin/update-master-bhajan/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updatedData)
  })
    .then((res) => res.json())
    .then((response) => {
      if (response.success) {
        const row = document.getElementById(`row-${id}`);
        if (row) {
          row.setAttribute("data-deity", (updatedData.deity || "").toLowerCase());
          row.querySelectorAll(".edit-cell").forEach((cell) => {
            const fieldName = cell.getAttribute("data-field");
            const val = updatedData[fieldName] || "-";
            if (fieldName === "deity") {
              cell.innerHTML = `<span class="deity-pill">${escapeHTML(val)}</span>`;
            } else {
              cell.textContent = val;
            }
          });
          const actionCell = row.querySelector(".action-cell");
          if (actionCell) {
            actionCell.innerHTML = `<button class="button" style="padding:6px 12px; font-size:12px; background:#4dabf7; border:none; margin-right:4px;" onclick="editMasterRow(${id})">Edit</button><button class="button" style="padding:6px 12px; font-size:12px; background:#e03131; border:none;" onclick="deleteMasterRow(${id})">Del</button>`;
          }
        }
        const westM = document.getElementById(`west-m-${id}`);
        const westF = document.getElementById(`west-f-${id}`);
        if (westM) westM.textContent = getWesternScale(updatedData.shruti);
        if (westF) westF.textContent = getWesternScale(updatedData.shruti_female);
      } else {
        alert("Error: " + response.error);
      }
    })
    .catch(() => alert("Failed to save changes."));
}
window.saveMasterRow = saveMasterRow;

async function deleteMasterRow(id) {
  const ok = window.BPSheet
    ? await window.BPSheet.confirm("Are you sure you want to permanently delete this bhajan from the Master Database?", { isDestructive: true })
    : confirm("Are you sure you want to permanently delete this bhajan from the Master Database?");
  if (!ok) {
    return;
  }
  fetch(`/api/admin/delete-master-bhajan/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" }
  })
    .then((res) => res.json())
    .then((response) => {
      if (response.success) {
        document.getElementById(`row-${id}`)?.remove();
        document.getElementById(`card-${id}`)?.remove();
      } else {
        alert("Error: " + response.error);
      }
    })
    .catch(() => alert("Failed to delete."));
}
window.deleteMasterRow = deleteMasterRow;

function sortTable(n, tableId) {
  const table = document.getElementById(tableId);
  if (!table) return;
  const tbody = table.getElementsByTagName("TBODY")[0] || table;
  let switching = true;
  let dir = "asc";
  let switchcount = 0;

  while (switching) {
    switching = false;
    const rows = tbody.getElementsByTagName("TR");
    let shouldSwitch = false;
    let i = 0;

    for (i = 0; i < rows.length - 1; i++) {
      shouldSwitch = false;
      const x = rows[i].getElementsByTagName("TD")[n];
      const y = rows[i + 1].getElementsByTagName("TD")[n];
      if (!x || !y) continue;

      const valX = (
        x.getAttribute("data-sort") || x.innerHTML.replace(/(<([^>]+)>)/gi, "").trim()
      ).toLowerCase();
      const valY = (
        y.getAttribute("data-sort") || y.innerHTML.replace(/(<([^>]+)>)/gi, "").trim()
      ).toLowerCase();

      if ((dir === "asc" && valX > valY) || (dir === "desc" && valX < valY)) {
        shouldSwitch = true;
        break;
      }
    }
    if (shouldSwitch) {
      rows[i].parentNode.insertBefore(rows[i + 1], rows[i]);
      switching = true;
      switchcount++;
    } else if (switchcount === 0 && dir === "asc") {
      dir = "desc";
      switching = true;
    }
  }
}
window.sortTable = sortTable;

function saveReorderSequence() {
  const rows = document.querySelectorAll("#sortable-body tr[data-id]");
  const orderData = Array.from(rows).map((row, index) => ({
    id: parseInt(row.getAttribute("data-id"), 10),
    order: index + 1
  }));

  fetch("/api/admin/reorder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderData })
  })
    .then((res) => res.json())
    .then((data) => {
      if (data.success) location.reload();
      else alert("Error saving sequence");
    });
}
window.saveReorderSequence = saveReorderSequence;

function toggleSessionLock(date, isLocked) {
  fetch("/api/admin/toggle-lock", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ date, is_locked: isLocked })
  })
    .then((res) => res.json())
    .then((data) => {
      if (data.success) location.reload();
    });
}
window.toggleSessionLock = toggleSessionLock;

function editSinger(id, currentName) {
  const newName = prompt("Edit Singer Name:", currentName);
  if (newName === null || newName.trim() === "") return;
  document.getElementById("edit-input-" + id).value = newName.trim();

  const currentGender = document.getElementById("edit-gender-" + id)?.value || "";
  const newGender = prompt("Set gender (Male, Female, or Other):", currentGender);
  if (newGender === null) return;
  if (!["Male", "Female", "Other"].includes(newGender.trim())) {
    alert("Please enter Male, Female, or Other.");
    return;
  }
  document.getElementById("edit-gender-" + id).value = newGender.trim();
  document.getElementById("edit-form-" + id).submit();
}
window.editSinger = editSinger;

function openCopySessionModal() {
  document.getElementById("copySessionModal")?.classList.add("show");
}
window.openCopySessionModal = openCopySessionModal;

function closeCopySessionModal() {
  document.getElementById("copySessionModal")?.classList.remove("show");
}
window.closeCopySessionModal = closeCopySessionModal;

function submitCopySession() {
  const source_date = document.getElementById("copySourceDate")?.value;
  const target_date = document.getElementById("copyTargetDate")?.value;
  if (!source_date || !target_date) {
    alert("Please choose both dates.");
    return;
  }
  const form = document.createElement("form");
  form.method = "POST";
  form.action = "/admin/copy-session";
  [
    ["source_date", source_date],
    ["target_date", target_date]
  ].forEach(([name, value]) => {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.appendChild(input);
  });
  document.body.appendChild(form);
  form.submit();
}
window.submitCopySession = submitCopySession;

// Real-time Activity & Presence Heartbeat (skips when tab is hidden)
(function () {
  let pageStartTime = Date.now();
  function sendHeartbeat() {
    if (document.hidden) return;
    const elapsedSeconds = Math.round((Date.now() - pageStartTime) / 1000);
    pageStartTime = Date.now();
    fetch("/api/activity/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        page: window.location.pathname + window.location.search,
        duration: elapsedSeconds
      })
    }).catch(() => {});
  }

  function sendOfflineBeacon() {
    if (navigator.sendBeacon) {
      navigator.sendBeacon("/api/activity/offline");
    } else {
      fetch("/api/activity/offline", { method: "POST", keepalive: true }).catch(() => {});
    }
  }

  setInterval(sendHeartbeat, 60000);
  window.addEventListener("pagehide", sendOfflineBeacon);
})();

// Searchable Dropdowns for Master Bhajan Bank Filters
function positionDropdown(menu, btn) {
  const rect = btn.getBoundingClientRect();
  const menuW = parseInt(menu.style.width, 10) || 220;
  const viewportW = window.innerWidth;

  let left = rect.left;
  if (left + menuW > viewportW - 8) left = rect.right - menuW;
  if (left < 8) left = 8;

  menu.style.position = "fixed";
  menu.style.top = rect.bottom + 6 + "px";
  menu.style.left = left + "px";
  menu.style.width = Math.min(menuW, viewportW - 16) + "px";
}

function toggleSearchDropdown(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const menu = container.querySelector(".dd-menu");
  const btn = container.querySelector(".dd-toggle");
  const isOpening = menu.style.display === "none" || menu.style.display === "";

  document.querySelectorAll(".dd-menu").forEach((m) => (m.style.display = "none"));

  if (isOpening) {
    menu.style.display = "block";
    positionDropdown(menu, btn);
    const searchInput = menu.querySelector(".dd-search");
    if (searchInput) {
      searchInput.value = "";
      filterDropdownOptions(containerId);
      setTimeout(() => searchInput.focus(), 50);
    }
  }
}
window.toggleSearchDropdown = toggleSearchDropdown;

["scroll", "resize"].forEach((evt) => {
  window.addEventListener(
    evt,
    () => {
      document.querySelectorAll(".dd-menu").forEach((menu) => {
        if (menu.style.display === "block") {
          const containerId = menu.closest(".searchable-dropdown")?.id;
          if (!containerId) return;
          const btn = document.getElementById(containerId)?.querySelector(".dd-toggle");
          if (btn) positionDropdown(menu, btn);
        }
      });
    },
    { capture: true, passive: true }
  );
});

function filterDropdownOptions(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const searchInput = container.querySelector(".dd-search");
  const filterText = (searchInput?.value || "").toLowerCase().trim();
  container.querySelectorAll(".dd-option").forEach((opt) => {
    opt.style.display = opt.textContent.toLowerCase().includes(filterText) ? "block" : "none";
  });
}
window.filterDropdownOptions = filterDropdownOptions;

function selectDropdownOption(containerId, val, label) {
  const container = document.getElementById(containerId);
  if (!container) return;

  let hiddenInputId = "filterBankDeity";
  if (containerId === "dd-tempo") hiddenInputId = "filterBankTempo";
  if (containerId === "dd-raga") hiddenInputId = "filterBankRaga";

  const hiddenInput = document.getElementById(hiddenInputId);
  if (hiddenInput) {
    hiddenInput.value = val;
    hiddenInput.dispatchEvent(new Event("change"));
  }

  const labelEl = container.querySelector(".dd-label");
  if (labelEl) labelEl.textContent = label;

  const menu = container.querySelector(".dd-menu");
  if (menu) menu.style.display = "none";

  if (typeof window.filterMasterBank === "function") {
    window.filterMasterBank();
  }
}
window.selectDropdownOption = selectDropdownOption;

document.addEventListener("click", function (e) {
  if (!e.target.closest(".searchable-dropdown")) {
    document.querySelectorAll(".dd-menu").forEach((m) => (m.style.display = "none"));
  }
});

// Top Navigation Progress Bar Controller (Standalone / Admin Layout Only)
(function () {
  if (window.AppShell) return;
  const topBar = document.getElementById("top-nav-bar");
  const topFill = document.getElementById("top-nav-fill");
  if (!topBar || !topFill) return;

  let progressTimer = null;
  let safetyTimer = null;
  let currentWidth = 0;

  function finishTopNav() {
    clearTimeout(progressTimer);
    clearTimeout(safetyTimer);
    topFill.style.width = "100%";
    setTimeout(() => {
      topBar.classList.remove("active");
      setTimeout(() => {
        topFill.style.width = "0%";
        currentWidth = 0;
      }, 200);
    }, 150);
  }

  function startTopNav() {
    clearTimeout(progressTimer);
    clearTimeout(safetyTimer);
    topBar.classList.add("active");
    currentWidth = 20;
    topFill.style.width = "20%";

    function step() {
      if (currentWidth < 85) {
        currentWidth += Math.random() * 12 + 6;
        if (currentWidth > 85) currentWidth = 85;
        topFill.style.width = currentWidth + "%";
        progressTimer = setTimeout(step, 140);
      }
    }
    progressTimer = setTimeout(step, 80);
    safetyTimer = setTimeout(finishTopNav, 2500);
  }

  document.addEventListener("click", function (e) {
    if (e.defaultPrevented) return;
    const link = e.target.closest("a");
    if (!link) return;
    const href = link.getAttribute("href");
    if (
      !href ||
      href.startsWith("#") ||
      href.startsWith("javascript:") ||
      href.startsWith("tel:") ||
      href.startsWith("mailto:")
    ) {
      return;
    }
    if (link.target === "_blank" || link.hasAttribute("download")) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (link.origin && link.origin !== window.location.origin) return;
    startTopNav();
  });

  window.addEventListener("pageshow", finishTopNav);
  window.addEventListener("popstate", finishTopNav);
  window.addEventListener("load", finishTopNav);
  document.addEventListener("DOMContentLoaded", finishTopNav);
})();

// ============================================================================
// Responsive Dual-Layout Navigation System (Desktop Top Bar & Mobile Capsule)
// ============================================================================
(function () {
  "use strict";

  let autoCenterRaf = null;
  function autoCenterActivePill() {
    if (autoCenterRaf) cancelAnimationFrame(autoCenterRaf);
    autoCenterRaf = requestAnimationFrame(function () {
      const activePill = document.querySelector(
        ".mobile-bottom-capsule .capsule-pill.active, .mobile-bottom-capsule .nav-tab.active, .native-bottom-nav .active"
      );
      if (activePill && typeof activePill.scrollIntoView === "function") {
        try {
          activePill.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
        } catch (_) {}
      }
    });
  }

  let scrollTicking = false;
  let lastScrolledElevation = null;

  function updateHeaderElevation() {
    const header = document.getElementById("shellTopHeader") || document.querySelector(".shell-top-header");
    if (!header) return;
    const activePane = document.querySelector(".shell-pane.active-pane");
    const paneScroll = activePane ? activePane.scrollTop : 0;
    const windowScroll = window.scrollY || document.documentElement.scrollTop || 0;
    const isScrolled = paneScroll > 8 || windowScroll > 8;
    if (isScrolled !== lastScrolledElevation) {
      lastScrolledElevation = isScrolled;
      header.classList.toggle("scrolled", isScrolled);
      header.classList.toggle("is-scrolled", isScrolled);
    }
  }

  function onThrottledScroll() {
    if (!scrollTicking) {
      scrollTicking = true;
      requestAnimationFrame(function () {
        updateHeaderElevation();
        scrollTicking = false;
      });
    }
  }

  window.addEventListener("scroll", onThrottledScroll, { passive: true });

  window.addEventListener("hashchange", function () {
    if (window.AppShell && typeof window.AppShell.syncNavIndicators === "function") {
      return;
    }
    const hash = window.location.hash;
    if (hash) {
      // Strictly select at most ONE matching desktop nav link
      const desktopLinks = Array.from(document.querySelectorAll(".desktop-nav .nav-link"));
      const matchLink = desktopLinks.find(function (el) {
        const href = el.getAttribute("href") || "";
        return href.endsWith(hash) || href.includes(hash);
      });
      if (matchLink) {
        desktopLinks.forEach(function (el) {
          el.classList.toggle("active", el === matchLink);
          el.setAttribute("aria-current", el === matchLink ? "page" : "false");
        });
      }

      // Strictly select at most ONE matching mobile pill
      const mobilePills = Array.from(document.querySelectorAll(".capsule-pill, .mobile-bottom-capsule .nav-tab"));
      const matchPill = mobilePills.find(function (el) {
        const href = el.getAttribute("href") || "";
        return href.endsWith(hash) || href.includes(hash);
      });
      if (matchPill) {
        mobilePills.forEach(function (el) {
          el.classList.toggle("active", el === matchPill);
          el.setAttribute("aria-current", el === matchPill ? "page" : "false");
        });
      }
      autoCenterActivePill();
    }
  });

  document.addEventListener("click", function (e) {
    const pill = e.target && e.target.closest ? e.target.closest(".capsule-pill, .mobile-bottom-capsule .nav-tab") : null;
    if (pill) {
      setTimeout(autoCenterActivePill, 50);
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      setTimeout(autoCenterActivePill, 100);
      updateHeaderElevation();
    });
  } else {
    setTimeout(autoCenterActivePill, 100);
    updateHeaderElevation();
  }
})();

