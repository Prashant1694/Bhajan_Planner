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

// Universal CSRF header injection for non-GET requests and form submissions
(function () {
  function getCsrfToken() {
    var meta = document.querySelector('meta[name="csrf-token"]');
    return (meta && meta.getAttribute("content")) || window.csrfToken || "";
  }

  var originalFetch = window.fetch;
  window.fetch = function (url, options) {
    var opts = Object.assign({}, options || {});
    var method = (opts.method || "GET").toUpperCase();
    if (["POST", "PUT", "PATCH", "DELETE"].indexOf(method) !== -1) {
      var token = getCsrfToken();
      if (token) {
        if (opts.headers instanceof Headers) {
          if (!opts.headers.has("X-CSRF-Token")) {
            opts.headers.append("X-CSRF-Token", token);
          }
        } else if (Array.isArray(opts.headers)) {
          if (
            !opts.headers.some(function (h) {
              return h[0].toLowerCase() === "x-csrf-token";
            })
          ) {
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

  document.addEventListener(
    "submit",
    function (e) {
      var form = e.target;
      if (!form || form.tagName !== "FORM") return;
      var method = (form.method || "GET").toUpperCase();
      if (["POST", "PUT", "PATCH", "DELETE"].indexOf(method) !== -1) {
        if (form.dataset.submitting === "true") {
          e.preventDefault();
          return false;
        }
        form.dataset.submitting = "true";
        var submitBtn = form.querySelector('button[type="submit"], input[type="submit"]');
        if (submitBtn) {
          setTimeout(function () {
            submitBtn.disabled = true;
            submitBtn.style.opacity = "0.7";
            submitBtn.style.cursor = "wait";
          }, 10);
        }
        setTimeout(function () {
          delete form.dataset.submitting;
          if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.style.opacity = "";
            submitBtn.style.cursor = "";
          }
        }, 8000);

        var token = getCsrfToken();
        if (token && !form.querySelector('input[name="_csrf"]')) {
          var input = document.createElement("input");
          input.type = "hidden";
          input.name = "_csrf";
          input.value = token;
          form.appendChild(input);
        }
      }
    },
    true
  );
})();

// Global Dark Mode Controller
(function initGlobalTheme() {
  function syncAllThemeToggles() {
    var isDark = document.documentElement.getAttribute("data-theme") === "dark";
    var btns = document.querySelectorAll(".theme-toggle, #themeToggle, #topbarThemeToggle, #shellThemeToggle, .admin-theme-toggle-btn");
    btns.forEach(function (btn) {
      btn.setAttribute("data-tooltip", isDark ? "Switch to Light" : "Switch to Dark");
      btn.setAttribute("aria-pressed", isDark ? "true" : "false");
    });
  }

  function handleToggleClick(e) {
    if (e && e.preventDefault) e.preventDefault();
    var isDark = document.documentElement.getAttribute("data-theme") === "dark";
    var next = isDark ? "light" : "dark";
    if (next === "light") {
      document.documentElement.removeAttribute("data-theme");
      try {
        localStorage.setItem("bp-theme", "light");
      } catch (err) {}
    } else {
      document.documentElement.setAttribute("data-theme", "dark");
      try {
        localStorage.setItem("bp-theme", "dark");
      } catch (err) {}
    }

    // Sync to window.top if inside an iframe
    try {
      if (window.top && window.top !== window && window.top.document && window.top.document.documentElement) {
        if (next === "dark") {
          window.top.document.documentElement.setAttribute("data-theme", "dark");
        } else {
          window.top.document.documentElement.removeAttribute("data-theme");
        }
      }
    } catch (_) {}

    // Sync to any child iframes
    try {
      document.querySelectorAll("iframe").forEach(function(f) {
        if (f.contentDocument && f.contentDocument.documentElement) {
          if (next === "dark") {
            f.contentDocument.documentElement.setAttribute("data-theme", "dark");
          } else {
            f.contentDocument.documentElement.removeAttribute("data-theme");
          }
        }
      });
    } catch (_) {}

    syncAllThemeToggles();
  }

  window.toggleTheme = handleToggleClick;

  function bindThemeButtons() {
    syncAllThemeToggles();
    var btns = document.querySelectorAll(".theme-toggle, #themeToggle, #topbarThemeToggle, #shellThemeToggle, .admin-theme-toggle-btn");
    btns.forEach(function (btn) {
      if (!btn._themeAttached) {
        btn._themeAttached = true;
        btn.addEventListener("click", handleToggleClick);
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindThemeButtons);
  } else {
    bindThemeButtons();
  }
})();

function switchTab(tabName, element) {
  document.querySelectorAll(".tab-content").forEach((tab) => tab.classList.remove("active"));
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.remove("active"));
  document.getElementById(tabName).classList.add("active");

  // Highlight clicked tab
  if (element) {
    element.classList.add("active");
  } else if (window.event && window.event.currentTarget) {
    window.event.currentTarget.classList.add("active");
  }
}

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

function closeSelectBhajanModal() {
  const modal = document.getElementById("selectBhajanModal");
  if (modal) modal.classList.remove("show");
  const titleInput = document.getElementById("bhajanTitleInput");
  if (titleInput) {
    titleInput.focus();
  }
}

function openSelectBhajanModal() {
  const modal = document.getElementById("selectBhajanModal");
  if (modal) modal.classList.add("show");
}

document.addEventListener("DOMContentLoaded", function () {
  const sidebarToggle = document.getElementById("sidebarToggle");
  const mobileSidebarToggle = document.getElementById("mobileSidebarToggle");
  const sidebarOverlay = document.getElementById("sidebarOverlay");

  // Desktop: collapse/expand sidebar (icon-only mode)
  if (localStorage.getItem("admin_sidebar_collapsed") === "true")
    document.body.classList.add("sidebar-collapsed");
  sidebarToggle?.addEventListener("click", () => {
    // On mobile, treat the in-sidebar toggle as a close button
    if (window.innerWidth <= 768) {
      document.body.classList.remove("mobile-sidebar-open");
      return;
    }
    document.body.classList.toggle("sidebar-collapsed");
    localStorage.setItem(
      "admin_sidebar_collapsed",
      String(document.body.classList.contains("sidebar-collapsed"))
    );
  });

  // Mobile: hamburger opens overlay sidebar
  const openMobileSidebar = () => {
    document.body.classList.add("mobile-sidebar-open");
  };
  const closeMobileSidebar = () => {
    document.body.classList.remove("mobile-sidebar-open");
  };

  mobileSidebarToggle?.addEventListener("click", openMobileSidebar);

  // Clicking the dim overlay closes the sidebar
  sidebarOverlay?.addEventListener("click", closeMobileSidebar);

  // Close sidebar when a nav link is tapped on mobile
  if (window.innerWidth <= 768) {
    document.querySelectorAll(".sidebar-nav a, .sidebar-footer a").forEach((link) => {
      link.addEventListener("click", closeMobileSidebar);
    });
  }

  // Close mobile sidebar on resize to desktop
  window.addEventListener("resize", () => {
    if (window.innerWidth > 768) {
      closeMobileSidebar();
    }
  });

  const adminInput = document.querySelector('input[name="admin"]');
  const isAdmin = adminInput && adminInput.value === "true";

  if (
    new URLSearchParams(window.location.search).get("copy") === "true" &&
    typeof openCopySessionModal === "function"
  ) {
    setTimeout(openCopySessionModal, 0);
  }

  // Fetch Singer Dictionary for Autocomplete
  const singerList = document.getElementById("singerList");
  const singerInput = document.getElementById("singerName");
  const singerSuggestions = document.getElementById("singerSuggestions");
  const genderSelect = document.getElementById("gender");
  const lockedGenderInput = document.getElementById("lockedGender");
  let singerNames = [];
  let singersByName = new Map();
  let activeSingerIndex = -1;

  const hideSingerSuggestions = () => {
    singerSuggestions?.classList.remove("show");
    singerInput?.setAttribute("aria-expanded", "false");
  };

  const applySingerGender = (name) => {
    const singer = singersByName.get(name.trim().toLocaleLowerCase());
    if (singer?.gender && genderSelect) {
      const genderChanged = genderSelect.value !== singer.gender;
      genderSelect.value = singer.gender;
      genderSelect.disabled = true;
      genderSelect.setAttribute("aria-disabled", "true");
      if (lockedGenderInput) lockedGenderInput.value = singer.gender;
      if (genderChanged) genderSelect.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (genderSelect) {
      genderSelect.disabled = false;
      genderSelect.removeAttribute("aria-disabled");
      if (lockedGenderInput) lockedGenderInput.value = "";
    }
  };

  const renderSingerSuggestions = () => {
    if (!singerInput || !singerSuggestions) return;
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
        singerNames = data.map((singer) => singer.name);
        singersByName = new Map(data.map((singer) => [singer.name.toLocaleLowerCase(), singer]));
        data.forEach((singer) => {
          const option = document.createElement("option");
          option.value = singer.name;
          singerList.appendChild(option);
        });
        if (singerInput?.value) applySingerGender(singerInput.value);
      })
      .catch((err) => console.error("Failed to load singer dictionary"));
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
      options.forEach((option, index) =>
        option.classList.toggle("active", index === activeSingerIndex)
      );
      singerInput.setAttribute("aria-activedescendant", options[activeSingerIndex].id);
    } else if (event.key === "Enter" && activeSingerIndex >= 0) {
      event.preventDefault();
      options[activeSingerIndex].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    } else if (event.key === "Escape") {
      hideSingerSuggestions();
    }
  });

  // 1. Ensure verified devotee profile identity is preserved, or fallback to saved details
  const nameInput = document.querySelector('input[name="singer_name"]');
  const activeGenderEl = genderSelect || document.querySelector('select[name="gender"]');

  if (nameInput) {
    const verifiedName = nameInput.getAttribute("data-verified-singer") || "";
    const verifiedGender = nameInput.getAttribute("data-verified-gender") || "";

    if (verifiedName && verifiedName.trim().length > 0) {
      // Devotee is authenticated: strictly enforce verified session identity
      nameInput.value = verifiedName.trim();
      try {
        localStorage.setItem("bj_singer_name", verifiedName.trim());
        if (verifiedGender) {
          localStorage.setItem("bj_gender", verifiedGender);
        }
      } catch (_) {}
      if (verifiedGender && genderSelect) {
        genderSelect.value = verifiedGender;
      }
    } else if (!isAdmin) {
      // Non-authenticated fallback: load saved details only if input is empty
      const savedName = localStorage.getItem("bj_singer_name");
      const savedGender = localStorage.getItem("bj_gender");

      if (savedName && !nameInput.value) {
        nameInput.value = savedName;
      }
      if (savedGender && genderSelect && !genderSelect.value) {
        genderSelect.value = savedGender;
      }
    }
  }

  // Modal close on outside click
  window.onclick = function (event) {
    const modal = document.getElementById("detailsModal");
    const confirmModal = document.getElementById("confirmSubmitModal");
    const selectModal = document.getElementById("selectBhajanModal");
    if (event.target == modal) closeModal();
    if (confirmModal && event.target == confirmModal) closeConfirmModal();
    if (selectModal && event.target == selectModal) closeSelectBhajanModal();
  };

  let selectedDeity = null;
  let currentMasterBhajans = []; // Array to hold the API data
  const titleInput = document.getElementById("bhajanTitleInput");
  const suggestions = document.getElementById("bhajanSuggestions");
  let activeSuggestionIndex = -1;

  const normalizeForSearch = (str) => {
    return (str || "")
      .toLowerCase()
      .replace(/[''`".,;:!?()\[\]{}\/\\-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
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
        if (searchTokens.length > 1 && searchTokens.every((tok) => normTitle.includes(tok)))
          return true;
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
        event.preventDefault(); // Keep focus in the input while selecting.
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

  const hideBhajanSuggestions = () => {
    suggestions?.classList.remove("show");
    titleInput?.setAttribute("aria-expanded", "false");
  };

  // Convert the stored Indian shruti notation by five semitones. This is used
  // only when a dedicated female shruti has not been entered in the master DB.
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

  // Deity card selection
  function handleDeityCardSelect(card) {
    if (!card || !card.classList.contains("available")) return;
    document.querySelectorAll(".deity-card").forEach((c) => c.classList.remove("selected"));
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

    // Reset fields
    if (titleInput) {
      titleInput.value = "";
      titleInput.placeholder = `Loading ${selectedDeity} bhajans...`;
      // Immediately focus search/type field on deity tap so keyboard & cursor appear
      titleInput.focus();
    }
    const masterIdInput = document.getElementById("selectedMasterBhajanId");
    if (masterIdInput) masterIdInput.value = "";
    const badge = document.getElementById("masterDataBadge");
    if (badge) badge.style.display = "none";

    // Pre-fill singer's preferred default pitch if configured
    const prefScaleEl = document.getElementById("singerPreferredScale");
    const scaleInputEl = document.getElementById("scaleInput");
    if (prefScaleEl && prefScaleEl.value && scaleInputEl && !scaleInputEl.value) {
      scaleInputEl.value = prefScaleEl.value;
      scaleInputEl.dispatchEvent(new Event("input", { bubbles: true }));
    }

    // Fetch Master Bhajans
    fetch(`/api/master-bhajans/${encodeURIComponent(selectedDeity)}`)
      .then((response) => response.json())
      .then((data) => {
        currentMasterBhajans = data || []; // Save data globally for this session
        if (titleInput) {
          titleInput.placeholder = `Search ${currentMasterBhajans.length} ${selectedDeity} bhajans...`;
          titleInput.focus();
        }
        renderBhajanSuggestions();
      })
      .catch((err) => {
        if (titleInput) titleInput.placeholder = "Type bhajan name here...";
      });

    setTimeout(() => {
      const details = document.getElementById("bhajanDetails");
      if (details) details.scrollIntoView({ behavior: "smooth", block: "nearest" });
      if (titleInput) {
        titleInput.focus();
      }
    }, 100);
  }

  document.querySelectorAll(".deity-card.available").forEach((card) => {
    card.addEventListener("click", function () {
      handleDeityCardSelect(this);
    });
  });

  // Delegated fallback for mobile touch / dynamic DOM
  document.addEventListener("click", function (e) {
    const card = e.target && e.target.closest && e.target.closest(".deity-card.available");
    if (card) {
      handleDeityCardSelect(card);
    }
  });

  // Phase 4 Integration: Check for Songbook / Master Bank prefill query params
  (function handleSongbookPrefill() {
    try {
      const params = new URLSearchParams(window.location.search);
      const prefillTitle = params.get("prefill_title");
      const prefillDeity = params.get("prefill_deity");
      const prefillScale = params.get("prefill_scale");
      const prefillSpeed = params.get("prefill_speed");
      const masterId = params.get("master_id");

      if (prefillDeity) {
        const prefillDeities = prefillDeity
          .split(/[,;&\/]+/)
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean);
        const deityCard = Array.from(document.querySelectorAll(".deity-card.available")).find(
          (c) => {
            const cardDeity = (c.dataset.deity || "").toLowerCase();
            return prefillDeities.some(
              (pd) =>
                pd === cardDeity ||
                (pd === "mata" && cardDeity === "devi") ||
                (pd === "devi" && cardDeity === "mata") ||
                (pd === "hanuman" && cardDeity === "anjaneya") ||
                (pd === "anjaneya" && cardDeity === "hanuman")
            );
          }
        );
        if (deityCard) {
          deityCard.click();
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
            }, 450);
          }
        }
      }
    } catch (e) {
      console.warn("Songbook prefill error:", e);
    }
  })();

  // MAGIC AUTO-FILL LOGIC: Listen for when they select a title
  let searchTimeout;
  titleInput.addEventListener("input", function (e) {
    if (e.isTrusted) {
      // User typed or edited manually: require explicit dropdown selection
      const masterIdInput = document.getElementById("selectedMasterBhajanId");
      if (masterIdInput) masterIdInput.value = "";
    }
    const enteredTitle = e.target.value.trim().toLocaleLowerCase();
    const isExactBhajan = currentMasterBhajans.some(
      (bhajan) => bhajan.title.trim().toLocaleLowerCase() === enteredTitle
    );
    if (isExactBhajan) hideBhajanSuggestions();
    else renderBhajanSuggestions();
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      const selectedTitle = e.target.value;

      // Find the bhajan in our downloaded master list
      const matchedBhajan = currentMasterBhajans.find((b) => b.title === selectedTitle);

      // Helper to catch empty strings or #N/A from the excel file
      const cleanValue = (val) =>
        val && val !== "#N/A" && String(val).trim() !== "" ? val : "Not specified";

      const warningDiv = document.getElementById("cooldownWarning");
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
          title: title,
          singer_name: singer,
          gender: gender
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
          .catch((err) => {
            if (prevBadge) prevBadge.style.display = "none";
            if (genderBadge) genderBadge.style.display = "none";
          });
      };

      if (selectedTitle.trim().length > 0) {
        fetch("/api/check-cooldown?title=" + encodeURIComponent(selectedTitle))
          .then((res) => res.json())
          .then((data) => {
            if (data && warningDiv) {
              const safeSinger = (window.escapeHTML || escapeHTML)(data.singer_name);
              const safeDate = (window.escapeHTML || escapeHTML)(data.session_date);
              warningDiv.innerHTML = `<strong>Cool-down warning:</strong> This bhajan was last sung by <strong>${safeSinger}</strong> on <strong>${safeDate}</strong>.`;
              warningDiv.style.display = "block";
            } else if (warningDiv) {
              warningDiv.style.display = "none";
            }
          });
        fetchScaleSuggestions();
      } else {
        if (warningDiv) warningDiv.style.display = "none";
        fetchScaleSuggestions();
      }

      if (matchedBhajan) {
        // 1. Auto-fill visible inputs
        const genderSelect = document.getElementById("gender");
        const gender = genderSelect ? genderSelect.value : "";
        const scaleSelection = scaleForGender(matchedBhajan, gender);
        const scaleInput = document.getElementById("scaleInput");
        scaleInput.value = scaleSelection.scale;
        scaleInput.dispatchEvent(new Event("input", { bubbles: true }));
        document.getElementById("speedInput").value = cleanValue(matchedBhajan.tempo);

        // 2. Auto-fill other inputs to send to database
        document.getElementById("ragaInput").value = cleanValue(matchedBhajan.raga);
        document.getElementById("hiddenLevel").value = matchedBhajan.level || "";
        document.getElementById("hiddenLanguage").value = matchedBhajan.language || "";

        // 3. Show a nice green success message to the singer
        const badge = document.getElementById("masterDataBadge");
        let badgeText = "";
        const cleanRaag = cleanValue(matchedBhajan.raga);
        if (cleanRaag !== "Not specified") badgeText += `(Raag: ${cleanRaag})`;
        if (scaleSelection.usedFallback) {
          badgeText += `${badgeText ? " " : ""}(Female shruti: −5 from ${matchedBhajan.shruti})`;
        }

        document.getElementById("badgeDetails").textContent = badgeText;

        // Wire Music Sheet & Lyrics Links
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

        badge.style.display = "flex";
      } else {
        // If they type a custom bhajan not in the list, hide the badge
        const badge = document.getElementById("masterDataBadge");
        if (badge) badge.style.display = "none";
        const sheetLinkSpan = document.getElementById("badgeSheetLink");
        if (sheetLinkSpan) sheetLinkSpan.style.display = "none";
        const lyricsLinkSpan = document.getElementById("badgeLyricsLink");
        if (lyricsLinkSpan) lyricsLinkSpan.style.display = "none";
        document.getElementById("speedInput").value = "Not specified";
        document.getElementById("ragaInput").value = "Not specified";
        document.getElementById("hiddenLevel").value = "";
        document.getElementById("hiddenLanguage").value = "";
      }
    }, 300);
  });

  titleInput.addEventListener("focus", renderBhajanSuggestions);
  titleInput.addEventListener("blur", () => {
    setTimeout(() => {
      hideBhajanSuggestions();
    }, 150);
  });
  titleInput.addEventListener("keydown", (event) => {
    const options = Array.from(suggestions?.querySelectorAll(".bhajan-suggestion") || []);
    if (!options.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      activeSuggestionIndex =
        event.key === "ArrowDown"
          ? (activeSuggestionIndex + 1) % options.length
          : (activeSuggestionIndex - 1 + options.length) % options.length;
      options.forEach((option, index) =>
        option.classList.toggle("active", index === activeSuggestionIndex)
      );
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
      suggestions.classList.remove("show");
      titleInput.setAttribute("aria-expanded", "false");
    }
  });

  // Instantly swap scale if they change gender AFTER picking a bhajan
  document.getElementById("gender")?.addEventListener("change", function (e) {
    const selectedTitle = document.getElementById("bhajanTitleInput").value;
    if (selectedTitle && currentMasterBhajans) {
      const matchedBhajan = currentMasterBhajans.find((b) => b.title === selectedTitle);
      if (matchedBhajan) {
        const gender = e.target.value;
        const scaleInput = document.getElementById("scaleInput");
        scaleInput.value = scaleForGender(matchedBhajan, gender).scale;
        scaleInput.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
    fetchScaleSuggestions();
  });

  // POPUP LOGIC & Form validation
  const preSubmitBtn = document.getElementById("preSubmitBtn");
  const confirmSubmitModal = document.getElementById("confirmSubmitModal");
  const editBtn = document.getElementById("editBtn");
  const confirmBtn = document.getElementById("confirmBtn");
  const form = document.getElementById("bhajanForm");

  if (preSubmitBtn) {
    preSubmitBtn.addEventListener("click", function () {
      // Check standard HTML5 validation
      if (!form.checkValidity()) {
        form.reportValidity();
        return;
      }

      if (!document.getElementById("selectedDeity").value) {
        alert("Please select a deity first");
        return;
      }

      // Check if bhajan was explicitly selected from the dropdown
      const masterIdInput = document.getElementById("selectedMasterBhajanId");
      if (!masterIdInput || !masterIdInput.value) {
        openSelectBhajanModal();
        return;
      }

      // Populate Modal
      const singer = document.getElementById("singerName").value;
      const partner = document.getElementById("partnerName").value;
      document.getElementById("modSinger").textContent =
        singer + (partner ? ` (& ${partner})` : "");

      document.getElementById("modDeity").textContent =
        document.getElementById("selectedDeity").value;
      document.getElementById("modTitle").textContent =
        document.getElementById("bhajanTitleInput").value;
      document.getElementById("modScale").textContent =
        document.getElementById("scaleInput").value || "Not specified";

      // Show Modal
      confirmSubmitModal.classList.add("show");
    });
  }

  if (editBtn) {
    editBtn.addEventListener("click", closeConfirmModal);
  }

  if (confirmBtn) {
    confirmBtn.addEventListener("click", function () {
      if (!isAdmin) {
        const name = document.querySelector('input[name="singer_name"]').value;
        const gender = document.querySelector('select[name="gender"]').value;
        localStorage.setItem("bj_singer_name", name);
        localStorage.setItem("bj_gender", gender);
      }
      var csrfInput = form.querySelector('input[name="_csrf"]');
      var token = (typeof getCsrfToken === "function" ? getCsrfToken() : "") || window.csrfToken || "";
      if (!csrfInput && token) {
        csrfInput = document.createElement("input");
        csrfInput.type = "hidden";
        csrfInput.name = "_csrf";
        csrfInput.value = token;
        form.appendChild(csrfInput);
      } else if (csrfInput && !csrfInput.value && token) {
        csrfInput.value = token;
      }
      form.submit();
    });
  }

  if (form) {
    form.addEventListener("submit", function (e) {
      const masterIdInput = document.getElementById("selectedMasterBhajanId");
      if (!masterIdInput || !masterIdInput.value) {
        e.preventDefault();
        openSelectBhajanModal();
        return;
      }
      // If the modal isn't open yet, prevent native submit and trigger the pre-submit flow
      if (confirmSubmitModal && !confirmSubmitModal.classList.contains("show")) {
        e.preventDefault();
        if (preSubmitBtn) preSubmitBtn.click();
        return;
      }
      var csrfInput = form.querySelector('input[name="_csrf"]');
      var token = (typeof getCsrfToken === "function" ? getCsrfToken() : "") || window.csrfToken || "";
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

  const closeSelectBhajanBtn = document.getElementById("closeSelectBhajanModalBtn");
  if (closeSelectBhajanBtn) {
    closeSelectBhajanBtn.addEventListener("click", closeSelectBhajanModal);
  }

  // Mobile Bottom Sheet backdrop click dismissal
  document.querySelectorAll(".modal").forEach((modal) => {
    modal.addEventListener("click", function (e) {
      if (e.target === this) {
        this.classList.remove("show");
      }
    });
  });

  // Touch drag-down to dismiss on mobile bottom sheets
  document.querySelectorAll(".modal-content").forEach((content) => {
    let startY = 0;
    let currentY = 0;
    let isDragging = false;

    content.addEventListener(
      "touchstart",
      function (e) {
        if (content.scrollTop === 0) {
          startY = e.touches[0].clientY;
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
      content.style.transition = "transform 0.25s cubic-bezier(0.16, 1, 0.3, 1)";
      if (deltaY > 80) {
        const modal = content.closest(".modal");
        if (modal) modal.classList.remove("show");
        setTimeout(() => {
          content.style.transform = "";
        }, 300);
      } else {
        content.style.transform = "";
      }
    });
  });

  window.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      document.querySelectorAll(".modal.show").forEach((m) => m.classList.remove("show"));
    }
  });

  // Keep body.modal-open synchronized whenever any modal opens or closes
  function updateBodyModalOpenState() {
    const hasOpenModal = document.querySelector(".modal.show") !== null;
    document.body.classList.toggle("modal-open", hasOpenModal);
  }

  try {
    const modalObserver = new MutationObserver(function () {
      updateBodyModalOpenState();
    });
    document.querySelectorAll(".modal").forEach((m) => {
      modalObserver.observe(m, { attributes: true, attributeFilter: ["class"] });
    });
    updateBodyModalOpenState();
  } catch (err) {
    console.error("Modal observer init error:", err);
  }
});

let filterTableTimeout;
function filterTable() {
  clearTimeout(filterTableTimeout);
  filterTableTimeout = setTimeout(() => {
    const inputs = document.querySelectorAll("#dbTable .filter-input");
    const table = document.getElementById("dbTable");
    if (!table) return;
    const tr = table.getElementsByTagName("tr");

    // Start from 2 because row 0 is inputs, row 1 is headers
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
  }, 250);
}

// Master bank filtering is managed natively with instant in-memory search in master-bank.ejs

// Admin Calendar Modal Logic
let currentAdminDate = null;

function openAdminDateModal(date, type, description) {
  currentAdminDate = date;
  document.getElementById("adminModalDate").textContent = "Manage " + date;
  document.getElementById("permDescription").value = description || "";
  document.getElementById("adminDateModal").classList.add("show");
}

function closeAdminModal() {
  document.getElementById("adminDateModal").classList.remove("show");
}

function viewAdminDate() {
  if (currentAdminDate) window.location.href = "/admin/date/" + currentAdminDate;
}

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
    body: JSON.stringify({ date: currentAdminDate, type: type, description: description })
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
      if (data.success) {
        location.reload();
      } else {
        alert(data.error || "Error updating permission");
      }
    })
    .catch((err) => {
      alert("Network error updating permission: " + err.message);
    });
}

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
function closeMissingBhajanModal() {
  document.getElementById("missingBhajanModal").classList.remove("show");
}

function reconcileBhajan(submittedTitle, action, masterBhajanId) {
  if (
    action === "link" &&
    !confirm(
      `Link all historical submissions of:\n\n"${submittedTitle}"\n\n...to the master bhajan? This will update all matching session records.`
    )
  )
    return;

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
          // Hide this reconcile card
          const cardId = "card-" + encodeURIComponent(submittedTitle);
          const card = document.getElementById(cardId);
          if (card) card.remove();
        }
      } else {
        alert("Error: " + (data.error || "Unknown error"));
      }
    })
    .catch((err) => alert("Request failed: " + err.message));
}
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

// Deity Rules Management
function saveDeityRules() {
  const table = document.getElementById("rulesTable");
  const date = document.getElementById("ruleDate").value;
  if (!table) return;

  const rules = [];
  const trs = table.getElementsByTagName("tbody")[0].getElementsByTagName("tr");

  for (let tr of trs) {
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

function getWesternScale(indianScale) {
  if (!indianScale || indianScale === "-" || indianScale === "Not specified") return "-";
  const match = indianScale
    .toString()
    .trim()
    .match(/^([\d\.]+)\s*([PMpm])?.*$/);
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

// Master Bhajan Edit & Delete
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

  const csrf = window.csrfToken || (document.querySelector('meta[name="csrf-token"]') ? document.querySelector('meta[name="csrf-token"]').getAttribute('content') : '');

  fetch(`/api/admin/update-master-bhajan/${id}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrf
    },
    body: JSON.stringify(updatedData)
  })
    .then((res) => res.json())
    .then((response) => {
      if (response.success) {
        const row = document.getElementById(`row-${id}`);
        if (row) {
          row.setAttribute("data-deity", (updatedData.deity || "").toLowerCase());
          const cells = row.querySelectorAll(".edit-cell");
          cells.forEach((cell) => {
            const fieldName = cell.getAttribute("data-field");
            const val = updatedData[fieldName] || "-";
            if (fieldName === "deity") {
              cell.innerHTML = `<span class="deity-pill">${typeof escapeHTML === "function" ? escapeHTML(val) : val}</span>`;
            } else {
              cell.textContent = val;
            }
          });
        }

        // Update western scale display dynamically
        const westM = document.getElementById(`west-m-${id}`);
        const westF = document.getElementById(`west-f-${id}`);
        if (westM) westM.textContent = getWesternScale(updatedData.shruti);
        if (westF) westF.textContent = getWesternScale(updatedData.shruti_female);

        const actionCell = row.querySelector(".action-cell");
        if (actionCell) {
          actionCell.innerHTML = `<button class="button" style="padding:6px 12px; font-size:12px; background:#4dabf7; border:none; margin-right:4px;" onclick="editMasterRow(${id})">Edit</button><button class="button" style="padding:6px 12px; font-size:12px; background:#e03131; border:none;" onclick="deleteMasterRow(${id})">Del</button>`;
        }
      } else {
        alert("Error: " + response.error);
      }
    })
    .catch((err) => {
      alert("Failed to save changes.");
      console.error(err);
    });
}

function deleteMasterRow(id) {
  if (typeof window.deleteMasterRow === "function" && window.deleteMasterRow !== deleteMasterRow) {
    return window.deleteMasterRow(id);
  }
  if (
    !confirm("Are you sure you want to permanently delete this bhajan from the Master Database?")
  )
    return;
  const csrf = window.csrfToken || (document.querySelector('meta[name="csrf-token"]') ? document.querySelector('meta[name="csrf-token"]').getAttribute('content') : '');

  fetch(`/api/admin/delete-master-bhajan/${id}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrf
    }
  })
    .then((res) => res.json())
    .then((response) => {
      if (response.success) {
        const row = document.getElementById(`row-${id}`);
        if (row) row.remove();
        const card = document.getElementById(`card-${id}`);
        if (card) card.remove();
      } else {
        alert("Error: " + response.error);
      }
    })
    .catch((err) => {
      alert("Failed to delete.");
      console.error(err);
    });
}

function sortTable(n, tableId) {
  const table = document.getElementById(tableId);
  if (!table) return;
  // Target the tbody to avoid sorting table headers
  const tbody = table.getElementsByTagName("TBODY")[0] || table;
  let rows,
    switching,
    i,
    x,
    y,
    shouldSwitch,
    dir,
    switchcount = 0;
  switching = true;
  dir = "asc";

  while (switching) {
    switching = false;
    rows = tbody.getElementsByTagName("TR");

    for (i = 0; i < rows.length - 1; i++) {
      shouldSwitch = false;
      x = rows[i].getElementsByTagName("TD")[n];
      y = rows[i + 1].getElementsByTagName("TD")[n];
      if (!x || !y) continue;

      // Use data-sort attribute if present (for accurate Date sorting), else text
      let valX = x.getAttribute("data-sort") || x.innerHTML.replace(/(<([^>]+)>)/gi, "").trim();
      let valY = y.getAttribute("data-sort") || y.innerHTML.replace(/(<([^>]+)>)/gi, "").trim();

      valX = valX.toLowerCase();
      valY = valY.toLowerCase();

      if (dir === "asc") {
        if (valX > valY) {
          shouldSwitch = true;
          break;
        }
      } else if (dir === "desc") {
        if (valX < valY) {
          shouldSwitch = true;
          break;
        }
      }
    }
    if (shouldSwitch) {
      rows[i].parentNode.insertBefore(rows[i + 1], rows[i]);
      switching = true;
      switchcount++;
    } else {
      if (switchcount === 0 && dir === "asc") {
        dir = "desc";
        switching = true;
      }
    }
  }
}

// ==========================================
// Drag & Drop Sequence Reordering
// ==========================================
document.addEventListener("DOMContentLoaded", () => {
  const sortableBody = document.getElementById("sortable-body");
  if (!sortableBody) return;

  let draggedRow = null;

  function updateRowIndexNumbers() {
    const rows = sortableBody.querySelectorAll("tr[data-id]");
    rows.forEach((row, index) => {
      const numEl = row.querySelector(".row-num");
      if (numEl) numEl.textContent = index + 1;
    });
  }

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

  // Touch drag-and-drop support for mobile touch screens
  let touchRow = null;

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
});

function saveReorderSequence() {
  const rows = document.querySelectorAll("#sortable-body tr[data-id]");
  const orderData = Array.from(rows).map((row, index) => ({
    id: parseInt(row.getAttribute("data-id")),
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

// ==========================================
// Edit Singer Dictionary
// ==========================================
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

// Chrome can otherwise restore a stale form from its back/forward cache.
window.addEventListener("pageshow", (event) => {
  if (event.persisted) window.location.reload();
});
function openCopySessionModal() {
  document.getElementById("copySessionModal").classList.add("show");
}
function closeCopySessionModal() {
  document.getElementById("copySessionModal").classList.remove("show");
}
function submitCopySession() {
  const source_date = document.getElementById("copySourceDate").value;
  const target_date = document.getElementById("copyTargetDate").value;
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

// Real-time Activity & Presence Heartbeat
(function () {
  let pageStartTime = Date.now();
  function sendHeartbeat() {
    if (window.self !== window.top) return;
    const elapsedSeconds = Math.round((Date.now() - pageStartTime) / 1000);
    pageStartTime = Date.now();
    fetch("/api/activity/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        page: window.location.pathname + window.location.search,
        duration: elapsedSeconds
      })
    }).catch(function () {});
  }

  function sendOfflineBeacon() {
    if (navigator.sendBeacon) {
      navigator.sendBeacon("/api/activity/offline");
    } else {
      fetch("/api/activity/offline", { method: "POST", keepalive: true }).catch(function () {});
    }
  }

  setInterval(sendHeartbeat, 45000);
  window.addEventListener("pagehide", sendOfflineBeacon);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") {
      sendOfflineBeacon();
    }
  });
})();

// Searchable Dropdowns for Master Bhajan Bank Filters
// Using position:fixed + getBoundingClientRect so the dropdown escapes
// ALL parent overflow:hidden, flex clipping, and body overflow-x:hidden.
function positionDropdown(menu, btn) {
  const rect = btn.getBoundingClientRect();
  const menuW = parseInt(menu.style.width) || 220;
  const viewportW = window.innerWidth;

  // Default: align left edge with button
  let left = rect.left;

  // If dropdown overflows right edge, align right edge with button's right
  if (left + menuW > viewportW - 8) {
    left = rect.right - menuW;
  }
  // Clamp to viewport left
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

  // Close all dropdowns first
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

// Reposition open dropdown on scroll or resize
["scroll", "resize"].forEach((evt) => {
  window.addEventListener(
    evt,
    () => {
      document.querySelectorAll(".dd-menu").forEach((menu) => {
        if (menu.style.display === "block") {
          const containerId = menu.closest(".searchable-dropdown")?.id;
          if (!containerId) return;
          const container = document.getElementById(containerId);
          const btn = container?.querySelector(".dd-toggle");
          if (btn) positionDropdown(menu, btn);
        }
      });
    },
    { passive: true }
  );
});

function filterDropdownOptions(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const searchInput = container.querySelector(".dd-search");
  const filterText = (searchInput?.value || "").toLowerCase().trim();
  const options = container.querySelectorAll(".dd-option");

  options.forEach((opt) => {
    const text = opt.textContent.toLowerCase();
    opt.style.display = text.includes(filterText) ? "block" : "none";
  });
}

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

  filterMasterBank();
}

document.addEventListener("click", function (e) {
  if (!e.target.closest(".searchable-dropdown")) {
    document.querySelectorAll(".dd-menu").forEach((m) => (m.style.display = "none"));
  }
});

// ========================================================
// PHASE 3: SONGBOOK PICKER FOR SUBMISSION FORM
// ========================================================
(function initSongbookPicker() {
  const openBtn = document.getElementById("openSongbookPickerBtn");
  const modal = document.getElementById("songbookPickerModal");
  const closeBtn = document.getElementById("closeSongbookPickerBtn");
  const listContainer = document.getElementById("songbookPickerList");

  if (!openBtn || !modal) return;

  function closeModal() {
    modal.classList.remove("show");
  }

  closeBtn?.addEventListener("click", closeModal);
  modal.addEventListener("click", function (e) {
    if (e.target === modal) closeModal();
  });

  openBtn.addEventListener("click", async function () {
    modal.classList.add("show");
    if (!listContainer) return;
    listContainer.innerHTML =
      '<div style="text-align:center; padding:24px; color:var(--ink-soft);"><span style="display:inline-block; animation:spin 1s infinite linear;">⏳</span> Loading your repertoire...</div>';

    try {
      const res = await fetch("/api/singer/songbook");
      if (!res.ok) throw new Error("Failed to load songbook");
      const data = await res.json();
      const bookmarks = data.bookmarks || [];

      if (bookmarks.length === 0) {
        listContainer.innerHTML = `
          <div style="background:var(--bg); border:1px dashed var(--border); border-radius:12px; padding:28px 16px; text-align:center;">
            <div style="width:40px; height:40px; margin:0 auto 10px; display:flex; align-items:center; justify-content:center; background:rgba(79,70,229,0.1); border-radius:10px; color:var(--primary);">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>
            </div>
            <h4 style="margin:0 0 6px 0; color:var(--ink);">Your Songbook is Empty</h4>
            <p style="font-size:12.5px; color:var(--ink-soft); margin:0 0 12px 0;">Visit the Master Bhajan Bank and click "Songbook" on any bhajan to save it here with your custom singing pitch.</p>
            <a href="/master-bank" class="button secondary" style="font-size:12px; padding:6px 12px; text-decoration:none;">Browse Bhajan Bank</a>
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
          "background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:12px 14px; display:flex; justify-content:space-between; align-items:center; gap:12px; box-shadow:0 1px 3px rgba(0,0,0,0.04);";

        const effectiveScale = item.custom_scale || b.shruti || "";

        row.innerHTML = `
          <div style="flex:1; min-width:0;">
            <div style="display:flex; align-items:center; gap:6px; margin-bottom:4px; flex-wrap:wrap;">
              <span style="background:#f1f5f9; color:#475569; font-size:11px; font-weight:700; padding:2px 7px; border-radius:5px; text-transform:uppercase;">
                ${b.deity}
              </span>
              ${
                effectiveScale
                  ? `
                <span style="background:#fdf4ff; color:#a21caf; border:1px solid #fae8ff; font-size:11px; font-weight:700; padding:2px 7px; border-radius:5px;">
                  Scale: ${effectiveScale}
                </span>
              `
                  : ""
              }
            </div>
            <div style="font-size:14.5px; font-weight:700; color:var(--ink); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
              ${b.title}
            </div>
            ${
              item.notes
                ? `
              <div style="font-size:11.5px; color:var(--ink-soft); margin-top:3px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                <em>${item.notes}</em>
              </div>
            `
                : ""
            }
          </div>
          <div>
            <button type="button" class="button primary sb-pick-btn" style="padding:6px 14px; font-size:12.5px; font-weight:700; background:#7c3aed; border-color:#7c3aed; white-space:nowrap;">
              Select
            </button>
          </div>
        `;

        row.querySelector(".sb-pick-btn").addEventListener("click", function () {
          // 1. Match and select deity card
          const bDeities = (b.deity || "").split(/[,;&\/]+/).map((s) => s.trim()).filter(Boolean);
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

          // 2. Populate title & master ID
          const titleInput = document.getElementById("bhajanTitleInput");
          const masterIdInput = document.getElementById("selectedMasterBhajanId");
          const scaleInput = document.getElementById("scaleInput");

          if (titleInput) titleInput.value = b.title;
          if (masterIdInput) masterIdInput.value = b.id;
          if (scaleInput && effectiveScale) scaleInput.value = effectiveScale;

          closeModal();

          // 3. Trigger input event to populate auto-filled raga, tempo, and badges
          if (titleInput) {
            titleInput.dispatchEvent(new Event("input", { bubbles: true }));
          }

          setTimeout(() => {
            const bhajanDetails = document.getElementById("bhajanDetails");
            if (bhajanDetails) {
              bhajanDetails.classList.add("show");
              bhajanDetails.scrollIntoView({ behavior: "smooth", block: "nearest" });
            }
          }, 150);
        });

        listContainer.appendChild(row);
      });
    } catch (err) {
      listContainer.innerHTML = `<div style="color:#ef4444; padding:16px; text-align:center;">Failed to load songbook: ${err.message}</div>`;
    }
  });
})();

// ==========================================================================
// Top Navigation Progress Bar Controller (YouTube / GitHub Style)
// Smooth, non-intrusive feedback on in-app link navigation & form submission
// ==========================================================================
(function () {
  const topBar = document.getElementById("top-nav-bar");
  const topFill = document.getElementById("top-nav-fill");
  if (!topBar || !topFill) return;

  // Never run a duplicate progress bar inside an iframe tab
  if (window.self !== window.top) {
    topBar.style.display = "none";
    return;
  }

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

    // Hard safety timeout: ALWAYS auto-finish within 2.5 seconds to prevent getting stuck
    safetyTimer = setTimeout(finishTopNav, 2500);
  }

  // Intercept navigation links
  document.addEventListener("click", function (e) {
    const link = e.target.closest("a");
    if (!link) return;
    const href = link.getAttribute("href");
    if (
      !href ||
      href.startsWith("#") ||
      href.startsWith("javascript:") ||
      href.startsWith("tel:") ||
      href.startsWith("mailto:")
    )
      return;
    if (link.target === "_blank" || link.hasAttribute("download")) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (link.origin && link.origin !== window.location.origin) return;

    startTopNav();
  });

  // Intercept form submissions
  document.addEventListener("submit", function (e) {
    const form = e.target;
    if (form && form.target !== "_blank") {
      startTopNav();
    }
  });

  // Always finish on back/forward, page restore, DOM ready, or visibility changes
  window.addEventListener("pageshow", finishTopNav);
  window.addEventListener("popstate", finishTopNav);
  window.addEventListener("pagehide", finishTopNav);
  window.addEventListener("load", finishTopNav);
  document.addEventListener("DOMContentLoaded", finishTopNav);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") finishTopNav();
  });
})();

// ==========================================================================
// App-First Mobile Bottom Navigation Controller
// Active Route Highlighting & Notification Badge Sync
// ==========================================================================
(function () {
  function updateActiveNavTab() {
    const nav = document.getElementById("appBottomNav");
    if (!nav) return;

    const path = window.location.pathname.toLowerCase();
    const tabs = nav.querySelectorAll(".nav-tab");

    tabs.forEach((tab) => {
      const route = (tab.getAttribute("data-route") || "").toLowerCase();
      let isActive = false;

      if (route === "/" && (path === "/" || path === "")) {
        isActive = true;
      } else if (route !== "/") {
        if (path === route || path.startsWith(route)) {
          isActive = true;
        } else if (
          route === "/my-hub" &&
          (path.startsWith("/singer/hub") || path.startsWith("/my-hub"))
        ) {
          isActive = true;
        }
      }

      tab.classList.toggle("active", isActive);
      if (isActive) {
        tab.setAttribute("aria-current", "page");
      } else {
        tab.removeAttribute("aria-current");
      }
    });

    // Sync notification dot for My Hub tab
    try {
      const hubDot = document.getElementById("hubBadgeDot");
      if (hubDot) {
        const storedTickets = JSON.parse(localStorage.getItem("bp_my_report_tickets") || "[]");
        const devId = localStorage.getItem("bp_device_id") || "";
        if (storedTickets.length > 0 || devId) {
          const reportDots = ["homeReportDot", "bankReportDot", "unreadReplyDot"];
          const hasUnread = reportDots.some((id) => {
            const el = document.getElementById(id);
            return el && el.style.display !== "none";
          });
          if (hasUnread) {
            hubDot.style.display = "block";
          }
        }
      }
    } catch (e) {}
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", updateActiveNavTab);
  } else {
    updateActiveNavTab();
  }
  window.addEventListener("pageshow", updateActiveNavTab);
})();

// Cross-tab link navigation inside native shell
(function () {
  document.addEventListener("click", function (e) {
    var a = e.target.closest("a");
    if (!a || !a.getAttribute("href")) return;
    var href = a.getAttribute("href");
    if (href.startsWith("#") || href.startsWith("javascript:")) return;

    if (
      window.parent &&
      window.parent !== window &&
      typeof window.parent.switchTabFromChild === "function"
    ) {
      try {
        var url = new URL(href, window.location.origin);
        if (url.origin === window.location.origin) {
          var tabMap = {
            "/": "home",
            "/submit-form": "singer",
            "/master-bank": "bank",
            "/plan-view": "plan",
            "/my-hub": "hub"
          };
          var tabKey = tabMap[url.pathname];
          if (tabKey) {
            e.preventDefault();
            window.parent.switchTabFromChild(tabKey, url.pathname + url.search);
          }
        }
      } catch (err) {}
    }
  });
})();
