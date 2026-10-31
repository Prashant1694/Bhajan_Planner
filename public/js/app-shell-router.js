// ============================================================================
// Single-DOM Native App Shell Router — Bhajan Planner (Enterprise v6.0)
// Zero iframes. Instant 0ms cached tab switching, slide-over detail sheet,
// deterministic pixel-accurate scroll & history restoration, and persistent
// WebAudio Tanpura + Session Audio across every route transition.
// ============================================================================

(function () {
  "use strict";

  if ("scrollRestoration" in window.history) {
    window.history.scrollRestoration = "manual";
  }

  const ASSET_VERSION = "6.4";
  const TAB_KEYS = ["home", "bank", "singer", "plan", "hub"];
  const TAB_DEFAULTS = {
    home: "/",
    bank: "/master-bank",
    singer: "/submit-form",
    plan: "/plan-view",
    hub: "/my-hub"
  };

  const TAB_LABELS = {
    home: "Bhajan Planner",
    bank: "Master Songbook",
    singer: "Mark Bhajan",
    plan: "Live Session Plan",
    hub: "Singer Hub"
  };

  const GLOBAL_SHELL_SCRIPTS = new Set([
    "haptics.js",
    "script.js",
    "pwa.js",
    "notifications.js",
    "tanpura.js",
    "session-audio-player.js",
    "loading.js",
    "app-shell-router.js"
  ]);

  const loadedStylesheets = new Set();
  const loadedExternalScripts = new Set();

  // Seed already-present <link rel="stylesheet"> tags
  document.querySelectorAll('link[rel="stylesheet"]').forEach((link) => {
    const href = link.getAttribute("href");
    if (href) loadedStylesheets.add(cleanAssetPath(href));
  });

  // Per-tab persistent state
  const paneState = {};
  TAB_KEYS.forEach((k) => {
    paneState[k] = {
      loaded: false,
      stale: false,
      url: TAB_DEFAULTS[k],
      title: TAB_LABELS[k],
      scrollTop: 0
    };
  });

  let activeTab = "home";
  let detailOpen = false;
  let currentDetailUrl = null;
  let currentDetailTitle = "";
  let historySeq = 1;
  let paneAbort = null;
  let detailAbort = null;
  let progressTimer = null;
  let reportCheckDone = false;
  let cachedReportUnread = false;

  // ── High-Performance In-Memory Fragment Cache ────────────────────────────
  const fragmentCache = new Map();
  const MAX_CACHE_SIZE = 36;
  const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
  const inFlightPrefetches = new Set();

  // ── Utility Helpers ──────────────────────────────────────────────────────
  function cleanAssetPath(href) {
    try {
      const u = new URL(href, window.location.origin);
      return u.pathname;
    } catch (_) {
      return String(href || "").split("?")[0];
    }
  }

  function normalizeInternalUrl(rawUrl) {
    try {
      const u = new URL(rawUrl || "/", window.location.origin);
      u.searchParams.delete("_embed");
      u.searchParams.delete("embed");
      u.searchParams.delete("_fragment");
      const qs = u.searchParams.toString();
      return u.pathname + (qs ? "?" + qs : "") + (u.hash || "");
    } catch (_) {
      return rawUrl || "/";
    }
  }

  function stripHash(url) {
    const idx = url.indexOf("#");
    return idx >= 0 ? url.slice(0, idx) : url;
  }

  function extractPathname(url) {
    try {
      return new URL(url, window.location.origin).pathname;
    } catch (_) {
      return String(url || "/").split("?")[0].split("#")[0];
    }
  }

  function isBypassPath(pathname) {
    const p = pathname.toLowerCase();
    return (
      p === "/admin" ||
      p.startsWith("/admin/") ||
      p === "/admin-login" ||
      p.startsWith("/forgot-password") ||
      p === "/logout" ||
      p === "/singer/logout" ||
      p.startsWith("/api/") ||
      p.startsWith("/sheets/") ||
      p.startsWith("/audio/")
    );
  }

  function isDetailRoute(pathname) {
    const p = pathname.toLowerCase();
    return (
      p.startsWith("/bhajan/") ||
      p === "/database" ||
      p === "/bulletins" ||
      p.startsWith("/bulletins/") ||
      p === "/my-reports" ||
      p === "/my-activity" ||
      p === "/notification-settings" ||
      p === "/singer-dictionary" ||
      p === "/session-select"
    );
  }

  function mapPathToTab(pathname) {
    const p = (pathname || "/").toLowerCase();
    if (p === "/" || p === "") return "home";
    if (
      p.startsWith("/submit-form") ||
      p.startsWith("/submission-status") ||
      p === "/singer-dictionary"
    ) {
      return "singer";
    }
    if (p.startsWith("/master-bank") || p.startsWith("/bhajan/")) {
      return "bank";
    }
    if (p.startsWith("/plan-view") || p === "/session-select" || p === "/database") {
      return "plan";
    }
    if (
      p.startsWith("/my-hub") ||
      p.startsWith("/singer/") ||
      p === "/my-activity"
    ) {
      return "hub";
    }
    return "home";
  }

  function getCsrfToken() {
    return (
      window.csrfToken ||
      (document.querySelector('meta[name="csrf-token"]')
        ? document.querySelector('meta[name="csrf-token"]').getAttribute("content")
        : "")
    );
  }

  function setCsrfToken(token) {
    if (!token) return;
    window.csrfToken = token;
    const meta = document.querySelector('meta[name="csrf-token"]');
    if (meta) meta.setAttribute("content", token);
  }

  function getPaneEl(tabKey) {
    return document.getElementById("pane-" + tabKey);
  }

  function getDetailSheetEl() {
    return document.getElementById("shellDetailSheet");
  }

  function getDetailBodyEl() {
    return document.getElementById("shellDetailBody");
  }

  // ── Top Progress Bar ─────────────────────────────────────────────────────
  function startProgress() {
    clearTimeout(progressTimer);
    const bar = document.getElementById("shellLoadBar");
    if (bar) {
      bar.classList.remove("is-done");
      bar.classList.add("is-loading");
    }
    progressTimer = setTimeout(finishProgress, 4000);
  }

  function finishProgress() {
    clearTimeout(progressTimer);
    const bar = document.getElementById("shellLoadBar");
    if (bar) {
      bar.classList.remove("is-loading");
      bar.classList.add("is-done");
      setTimeout(() => bar.classList.remove("is-done"), 240);
    }
  }

  // ── Stylesheet & External Script Loader ──────────────────────────────────
  function ensureStylesheet(hrefOrName) {
    if (!hrefOrName) return Promise.resolve();
    const fullHref = hrefOrName.startsWith("/") || hrefOrName.startsWith("http")
      ? hrefOrName
      : `/css/${hrefOrName}?v=${ASSET_VERSION}`;
    const cleanKey = cleanAssetPath(fullHref);

    if (loadedStylesheets.has(cleanKey)) {
      return Promise.resolve();
    }
    loadedStylesheets.add(cleanKey);

    return new Promise((resolve) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = fullHref.includes("?") || fullHref.startsWith("http")
        ? fullHref
        : `${fullHref}?v=${ASSET_VERSION}`;

      const timer = setTimeout(resolve, 1200);
      link.onload = () => {
        clearTimeout(timer);
        resolve();
      };
      link.onerror = () => {
        clearTimeout(timer);
        resolve();
      };
      document.head.appendChild(link);
    });
  }

  function ensureExternalScript(srcOrName) {
    if (!srcOrName) return Promise.resolve();
    const fullSrc = srcOrName.startsWith("/") || srcOrName.startsWith("http")
      ? srcOrName
      : `/js/${srcOrName}?v=${ASSET_VERSION}`;
    const cleanKey = cleanAssetPath(fullSrc);
    const baseName = cleanKey.split("/").pop();

    if (GLOBAL_SHELL_SCRIPTS.has(baseName) || loadedExternalScripts.has(cleanKey)) {
      return Promise.resolve();
    }
    loadedExternalScripts.add(cleanKey);

    return new Promise((resolve) => {
      const s = document.createElement("script");
      s.src = fullSrc;
      const timer = setTimeout(resolve, 2000);
      s.onload = () => {
        clearTimeout(timer);
        resolve();
      };
      s.onerror = () => {
        clearTimeout(timer);
        resolve();
      };
      document.body.appendChild(s);
    });
  }

  // ── UI State Synchronization (Zero-Jank Throttled Header & Capsule) ──────
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
      requestAnimationFrame(() => {
        updateHeaderElevation();
        scrollTicking = false;
      });
    }
  }

  let autoCenterRaf = null;
  function smoothCenterPill(pill) {
    if (!pill || typeof pill.scrollIntoView !== "function") return;
    if (autoCenterRaf) cancelAnimationFrame(autoCenterRaf);
    autoCenterRaf = requestAnimationFrame(() => {
      try {
        pill.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
      } catch (_) {}
    });
  }

  function syncNavIndicators(tabKey) {
    const currentPath = extractPathname(
      detailOpen && currentDetailUrl ? currentDetailUrl : paneState[tabKey]?.url || "/"
    );
    const currentHash = window.location.hash || "";

    // 1. Synchronize Desktop Navigation Links (.desktop-nav .nav-link) — Strictly mutually exclusive
    const desktopLinks = Array.from(document.querySelectorAll(".desktop-nav .nav-link, #desktopNav .nav-link"));
    let activeDesktopLink = null;

    // A. Priority 1: Match deep routes explicitly (e.g. /bulletins, /database, /admin)
    activeDesktopLink = desktopLinks.find((link) => {
      const linkRoute = link.getAttribute("data-route");
      return Boolean(linkRoute && (currentPath === linkRoute || currentPath.startsWith(linkRoute + "/")));
    }) || null;

    // B. Priority 2: Match by hash if present and no deep route matched
    if (!activeDesktopLink && currentHash) {
      activeDesktopLink = desktopLinks.find((link) => {
        const linkHref = link.getAttribute("href") || "";
        return Boolean(linkHref.endsWith(currentHash) || linkHref.includes(currentHash));
      }) || null;
    }

    // C. Priority 3: Match primary tab key (strictly only when detail view is not open)
    if (!activeDesktopLink && !detailOpen) {
      activeDesktopLink = desktopLinks.find((link) => {
        const linkTab = link.getAttribute("data-tab");
        const linkRoute = link.getAttribute("data-route");
        return Boolean(linkTab && linkTab === tabKey && !linkRoute);
      }) || null;
    }

    // Apply strictly to the single winner: exactly ONE desktop link is active, all others deactivated
    desktopLinks.forEach((link) => {
      const isMatch = Boolean(activeDesktopLink && link === activeDesktopLink);
      link.classList.toggle("active", isMatch);
      link.setAttribute("aria-current", isMatch ? "page" : "false");
    });

    // 2. Synchronize Mobile Bottom Capsule Navigation — Strictly mutually exclusive
    const mobilePills = Array.from(
      document.querySelectorAll(".capsule-pill, .mobile-bottom-capsule .nav-tab, .native-bottom-nav .nav-tab")
    );
    let activePill = null;

    // A. Priority 1: Match deep routes explicitly
    activePill = mobilePills.find((pill) => {
      const pillRoute = pill.getAttribute("data-route");
      return Boolean(pillRoute && (currentPath === pillRoute || currentPath.startsWith(pillRoute + "/")));
    }) || null;

    // B. Priority 2: Match by hash
    if (!activePill && currentHash) {
      activePill = mobilePills.find((pill) => {
        const pillHref = pill.getAttribute("href") || "";
        return Boolean(pillHref.endsWith(currentHash) || pillHref.includes(currentHash));
      }) || null;
    }

    // C. Priority 3: Match primary tab key (strictly only when detail view is not open)
    if (!activePill && !detailOpen) {
      activePill = mobilePills.find((pill) => {
        const pillTab = pill.getAttribute("data-tab");
        const pillRoute = pill.getAttribute("data-route");
        return Boolean(pillTab && pillTab === tabKey && !pillRoute);
      }) || null;
    }

    // Apply strictly to the single winner: exactly ONE mobile capsule pill is active
    mobilePills.forEach((pill) => {
      const isMatch = Boolean(activePill && pill === activePill);
      pill.classList.toggle("active", isMatch);
      pill.setAttribute("aria-current", isMatch ? "page" : "false");
    });

    // 3. Fallback compatibility for sidebar items if present
    document.querySelectorAll(".sidebar-nav-item[data-tab]").forEach((btn) => {
      const isMatch = !activeDesktopLink && btn.getAttribute("data-tab") === tabKey && !detailOpen;
      btn.classList.toggle("active", isMatch);
    });
    document.querySelectorAll(".sidebar-nav-item[data-route]").forEach((btn) => {
      const route = btn.getAttribute("data-route");
      const isMatch = Boolean(route && (currentPath === route || currentPath.startsWith(route + "/")));
      btn.classList.toggle("active", isMatch);
    });

    // 4. Auto-center the active pill horizontally within the mobile capsule
    if (activePill) {
      smoothCenterPill(activePill);
    }

    // 5. Synchronize header elevation shadow based on current scroll position
    updateHeaderElevation();
  }

  // Bind zero-lag throttled global listeners
  window.addEventListener("scroll", onThrottledScroll, { passive: true });
  document.addEventListener("scroll", onThrottledScroll, { passive: true });
  window.addEventListener("hashchange", function () {
    syncNavIndicators(activeTab);
  });

  // Zero-lag mutual exclusivity on direct clicks (Capture Phase)
  document.addEventListener(
    "click",
    function (e) {
      // Direct click on Desktop Navigation Link: immediately switch visual indicator
      const desktopLink = e.target && e.target.closest ? e.target.closest(".desktop-nav .nav-link, #desktopNav .nav-link") : null;
      if (desktopLink) {
        document.querySelectorAll(".desktop-nav .nav-link, #desktopNav .nav-link").forEach((link) => {
          const isMatch = (link === desktopLink);
          link.classList.toggle("active", isMatch);
          link.setAttribute("aria-current", isMatch ? "page" : "false");
        });
      }

      // Direct click on Mobile Capsule Pill: immediately switch visual indicator & center
      const pill = e.target && e.target.closest ? e.target.closest(".capsule-pill, .mobile-bottom-capsule .nav-tab, .native-bottom-nav .nav-tab") : null;
      if (pill) {
        document.querySelectorAll(".capsule-pill, .mobile-bottom-capsule .nav-tab, .native-bottom-nav .nav-tab").forEach((p) => {
          const isMatch = (p === pill);
          p.classList.toggle("active", isMatch);
          p.setAttribute("aria-current", isMatch ? "page" : "false");
        });
        smoothCenterPill(pill);
      }
    },
    { capture: true }
  );

  function syncContextualWidgets() {
    const effectiveUrl = detailOpen && currentDetailUrl
      ? currentDetailUrl
      : paneState[activeTab]?.url || TAB_DEFAULTS[activeTab];
    const pathname = extractPathname(effectiveUrl).toLowerCase();

    const tanpuraWidget = document.getElementById("tanpuraFloatingWidget");
    if (tanpuraWidget) {
      const isPlaying = Boolean(
        window.BhajanTanpura &&
          typeof window.BhajanTanpura.getState === "function" &&
          window.BhajanTanpura.getState().isPlaying
      );
      const isMusicContext =
        pathname.startsWith("/master-bank") ||
        pathname.startsWith("/submit-form") ||
        pathname.startsWith("/bhajan/");

      if (isMusicContext || isPlaying) {
        tanpuraWidget.classList.add("visible");
      } else {
        tanpuraWidget.classList.remove("visible");
        tanpuraWidget.classList.remove("expanded");
      }
      if (window.BhajanTanpura && typeof window.BhajanTanpura.syncUi === "function") {
        window.BhajanTanpura.syncUi();
      }
    }

    const headerTitle = document.getElementById("headerPageTitle");
    if (headerTitle) {
      headerTitle.textContent = TAB_LABELS[activeTab] || "Bhajan Planner";
    }
  }

  function updateDocumentTitle(rawTitle) {
    if (!rawTitle) return;
    document.title = rawTitle;
  }

  function cleanDetailHeaderTitle(rawTitle) {
    if (!rawTitle) return "Details";
    return rawTitle.replace(/\s*\|\s*Bhajan Planner.*$/i, "").trim() || "Details";
  }

  function applyReportDots() {
    if (cachedReportUnread) {
      ["homeReportDot", "bankReportDot", "unreadReplyDot"].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.style.display = "block";
      });
      return;
    }
    if (reportCheckDone) return;
    reportCheckDone = true;

    try {
      const storedTickets = JSON.parse(localStorage.getItem("bp_my_report_tickets") || "[]");
      const devId = localStorage.getItem("bp_device_id") || "";
      if (storedTickets.length === 0 && !devId) return;

      const p = [];
      if (storedTickets.length > 0) p.push("tickets=" + encodeURIComponent(storedTickets.join(",")));
      if (devId) p.push("visitor_id=" + encodeURIComponent(devId));

      fetch("/api/reports/my-reports?" + p.join("&"))
        .then((r) => r.json())
        .then((data) => {
          if (data && data.has_unread_reply) {
            cachedReportUnread = true;
            ["homeReportDot", "bankReportDot", "unreadReplyDot"].forEach((id) => {
              const el = document.getElementById(id);
              if (el) el.style.display = "block";
            });
          }
        })
        .catch(() => {});
    } catch (_) {}
  }

  // ── History Snapshot Management ──────────────────────────────────────────
  function getCurrentPaneScroll() {
    const pane = getPaneEl(activeTab);
    return pane ? pane.scrollTop : 0;
  }

  function getCurrentDetailScroll() {
    const body = getDetailBodyEl();
    return detailOpen && body ? body.scrollTop : 0;
  }

  function buildHistoryState(seqOverride) {
    return {
      __bpShell: true,
      seq: typeof seqOverride === "number" ? seqOverride : historySeq,
      tab: activeTab,
      tabUrl: paneState[activeTab]?.url || TAB_DEFAULTS[activeTab],
      detailUrl: detailOpen ? currentDetailUrl : null,
      paneScroll: paneState[activeTab]?.scrollTop || 0,
      detailScroll: getCurrentDetailScroll()
    };
  }

  function snapshotScrollToCurrentHistory() {
    const pane = getPaneEl(activeTab);
    if (pane && paneState[activeTab].loaded) {
      paneState[activeTab].scrollTop = pane.scrollTop;
    }
    const curState = window.history.state;
    const seq = curState && typeof curState.seq === "number" ? curState.seq : historySeq;
    const nextState = buildHistoryState(seq);
    const activeUrl = detailOpen && currentDetailUrl
      ? currentDetailUrl
      : paneState[activeTab]?.url || TAB_DEFAULTS[activeTab];
    try {
      window.history.replaceState(nextState, "", activeUrl);
    } catch (_) {}
  }

  function commitNavigationHistory(targetUrl, replace) {
    try {
      sessionStorage.setItem("bp_current_path", targetUrl);
      sessionStorage.setItem("bp_active_tab", activeTab);
    } catch (_) {}

    if (replace) {
      const seq =
        window.history.state && typeof window.history.state.seq === "number"
          ? window.history.state.seq
          : historySeq;
      try {
        window.history.replaceState(buildHistoryState(seq), "", targetUrl);
      } catch (_) {}
    } else {
      historySeq += 1;
      try {
        window.history.pushState(buildHistoryState(historySeq), "", targetUrl);
      } catch (_) {}
    }
  }

  // ── Fragment Fetch & DOM Mount Engine ────────────────────────────────────
  async function fetchAndMountFragment(url, container, abortSignal, fetchOptions) {
    const reqUrl = stripHash(url);
    const opts = Object.assign(
      {
        method: "GET",
        credentials: "same-origin",
        signal: abortSignal,
        headers: {
          "X-App-Shell": "1",
          Accept: "text/html"
        }
      },
      fetchOptions || {}
    );

    if (fetchOptions && fetchOptions.headers) {
      opts.headers = Object.assign(
        {
          "X-App-Shell": "1",
          Accept: "text/html"
        },
        fetchOptions.headers
      );
    }

    const reqKey = stripHash(reqUrl);
    const cached = (!fetchOptions && opts.method === "GET") ? fragmentCache.get(reqKey) : null;
    let html;
    let resolvedUrl = url;
    let fragmentRoot;
    let pageTitle = "Bhajan Planner";
    let pageCss = "";
    let pageJs = "";
    let csrfToken = "";

    if (cached && (Date.now() - (cached.timestamp || 0) < 300000)) {
      html = cached.html;
      resolvedUrl = cached.resolvedUrl || url;
      pageTitle = cached.pageTitle || "Bhajan Planner";
      pageCss = cached.pageCss || "";
      pageJs = cached.pageJs || "";
      csrfToken = cached.csrfToken || "";
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, "text/html");
      fragmentRoot = doc.querySelector(".shell-fragment-root") || doc.body;
    } else {
      const res = await fetch(reqUrl, opts);

      if (res.status === 503) {
        let offlineMsg = "You appear to be offline. Please check your connection and try again.";
        try {
          const data = await res.json();
          if (data && data.message) offlineMsg = data.message;
        } catch (_) {}
        container.innerHTML = `
          <div class="shell-offline-state">
            <div class="shell-offline-card">
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <line x1="1" y1="1" x2="23" y2="23"></line>
                <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"></path>
                <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"></path>
                <path d="M10.71 5.05A16 16 0 0 1 22.58 9"></path>
                <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"></path>
                <path d="M8.53 16.11a6 6 0 0 1 6.95 0"></path>
                <line x1="12" y1="20" x2="12.01" y2="20"></line>
              </svg>
              <h3>Offline</h3>
              <p>${offlineMsg}</p>
              <button type="button" class="btn btn-primary" onclick="window.AppShell.refreshCurrent()">Retry</button>
            </div>
          </div>
        `;
        return {
          resolvedUrl: url,
          pageTitle: "Offline | Bhajan Planner"
        };
      }

      const headerResolvedUrl = res.headers.get("X-Shell-Url");
      resolvedUrl = headerResolvedUrl || url;
      if (!headerResolvedUrl && res.url) {
        try {
          const parsedRes = new URL(res.url);
          if (parsedRes.origin === window.location.origin) {
            resolvedUrl = parsedRes.pathname + parsedRes.search;
          }
        } catch (_) {}
      }

      // Preserve client hash if route didn't redirect elsewhere
      const hashIdx = url.indexOf("#");
      if (hashIdx >= 0 && extractPathname(resolvedUrl) === extractPathname(url) && !resolvedUrl.includes("#")) {
        resolvedUrl += url.slice(hashIdx);
      }

      html = await res.text();

      // If redirected to an Admin or standalone full-document route, navigate top-level cleanly
      if (isBypassPath(extractPathname(resolvedUrl))) {
        window.location.href = resolvedUrl;
        return null;
      }

      const parser = new DOMParser();
      const doc = parser.parseFromString(html, "text/html");
      fragmentRoot = doc.querySelector(".shell-fragment-root") || doc.body;

      pageTitle = fragmentRoot.getAttribute("data-page-title") || doc.title || "Bhajan Planner";
      pageCss = fragmentRoot.getAttribute("data-page-css") || "";
      pageJs = fragmentRoot.getAttribute("data-page-js") || "";
      csrfToken = fragmentRoot.getAttribute("data-csrf-token") || "";

      fragmentCache.set(reqKey, {
        html: fragmentRoot.innerHTML,
        pageTitle,
        pageCss,
        pageJs,
        csrfToken,
        resolvedUrl,
        timestamp: Date.now()
      });
      if (fragmentCache.size > MAX_CACHE_SIZE) {
        const oldest = fragmentCache.keys().next().value;
        fragmentCache.delete(oldest);
      }
    }

    if (csrfToken) setCsrfToken(csrfToken);

    // Collect stylesheets (data-page-css + inline <link rel="stylesheet"> tags) and load before DOM swap
    const cssPromises = [];
    if (pageCss) {
      cssPromises.push(ensureStylesheet(pageCss));
    }

    fragmentRoot.querySelectorAll('link[rel="stylesheet"]').forEach((link) => {
      const href = link.getAttribute("href") || "";
      if (href && !href.includes("fonts.googleapis.com")) {
        cssPromises.push(ensureStylesheet(href));
      }
      link.remove();
    });

    fragmentRoot.querySelectorAll('link[rel="preconnect"]').forEach((link) => link.remove());

    if (cssPromises.length > 0) {
      await Promise.all(cssPromises);
    }

    if (abortSignal && abortSignal.aborted) return null;

    // Swap container HTML
    container.innerHTML = fragmentRoot.innerHTML;

    // Execute scripts inside newly mounted container
    const scripts = Array.from(container.querySelectorAll("script"));
    for (const oldScript of scripts) {
      const type = (oldScript.getAttribute("type") || "").trim().toLowerCase();
      // Preserve JSON data payloads untouched
      if (type === "application/json" || type === "application/ld+json") {
        continue;
      }

      const src = oldScript.getAttribute("src");
      if (src) {
        oldScript.remove();
        await ensureExternalScript(src);
        continue;
      }

      if (oldScript.getAttribute("data-mounted") === "true") {
        continue;
      }

      const executableScript = document.createElement("script");
      Array.from(oldScript.attributes).forEach((attr) => {
        executableScript.setAttribute(attr.name, attr.value);
      });
      executableScript.setAttribute("data-mounted", "true");
      executableScript.textContent = oldScript.textContent;
      oldScript.parentNode.replaceChild(executableScript, oldScript);
    }

    if (pageJs) {
      await ensureExternalScript(pageJs);
    }

    // Run idempotent page enhancements
    if (typeof window.initPageEnhancements === "function") {
      try {
        window.initPageEnhancements(container);
      } catch (err) {
        console.error("[AppShell] initPageEnhancements error:", err);
      }
    }
    if (typeof window.BPWirePwaButtons === "function") {
      try {
        window.BPWirePwaButtons();
      } catch (_) {}
    }

    applyReportDots();

    const cleanResolvedUrl = normalizeInternalUrl(resolvedUrl);
    fragmentCache.set(stripHash(cleanResolvedUrl), {
      html: fragmentRoot.innerHTML,
      pageTitle,
      pageCss,
      pageJs,
      csrfToken,
      resolvedUrl: cleanResolvedUrl,
      timestamp: Date.now()
    });
    if (fragmentCache.size > MAX_CACHE_SIZE) {
      const oldest = fragmentCache.keys().next().value;
      fragmentCache.delete(oldest);
    }

    return {
      resolvedUrl: cleanResolvedUrl,
      pageTitle
    };
  }

  // ── Pane Activation & Detail Sheet Controls ──────────────────────────────
  function setActivePaneDom(tabKey) {
    TAB_KEYS.forEach((k) => {
      const el = getPaneEl(k);
      if (!el) return;
      const isActive = k === tabKey;
      el.classList.toggle("active-pane", isActive);
      el.setAttribute("aria-hidden", isActive ? "false" : "true");
    });
  }

  function openDetailSheetDom(initialTitle) {
    const sheet = getDetailSheetEl();
    if (!sheet) return;
    detailOpen = true;
    sheet.classList.add("open");
    sheet.setAttribute("aria-hidden", "false");
    document.body.classList.add("detail-sheet-open");
    const titleEl = document.getElementById("shellDetailTitle");
    if (titleEl && initialTitle) {
      titleEl.textContent = initialTitle;
    }
  }

  function closeDetailSheetDom() {
    if (detailAbort) {
      detailAbort.abort();
      detailAbort = null;
    }
    const sheet = getDetailSheetEl();
    if (sheet) {
      sheet.classList.remove("open");
      sheet.setAttribute("aria-hidden", "true");
    }
    document.body.classList.remove("detail-sheet-open");
    detailOpen = false;
    currentDetailUrl = null;
    currentDetailTitle = "";
    syncNavIndicators(activeTab);
  }

  function renderDetailSkeleton() {
    const body = getDetailBodyEl();
    if (!body) return;
    body.innerHTML = `
      <div class="shell-skeleton-wrap" aria-busy="true">
        <div class="shell-skeleton-bar shell-sk-lg"></div>
        <div class="shell-skeleton-bar shell-sk-sm"></div>
        <div class="shell-skeleton-card"></div>
        <div class="shell-skeleton-card"></div>
      </div>
    `;
  }

  function scrollHashOrTop(container, url, explicitScrollTop) {
    if (!container) return;
    if (typeof explicitScrollTop === "number" && explicitScrollTop > 0) {
      container.scrollTop = explicitScrollTop;
      requestAnimationFrame(() => {
        container.scrollTop = explicitScrollTop;
      });
      return;
    }
    const hashIdx = url.indexOf("#");
    if (hashIdx >= 0) {
      const hashId = url.slice(hashIdx + 1);
      if (hashId && !hashId.startsWith("tab-")) {
        const target = container.querySelector("#" + CSS.escape(hashId));
        if (target) {
          target.scrollIntoView({ block: "start" });
          return;
        }
      }
    }
    container.scrollTop = 0;
  }

  // ── Core Navigation API ──────────────────────────────────────────────────
  async function loadDetailRoute(url, options) {
    const opts = options || {};
    const normUrl = normalizeInternalUrl(url);

    if (!opts.fromPopState) {
      snapshotScrollToCurrentHistory();
    }

    if (detailAbort) detailAbort.abort();
    detailAbort = new AbortController();

    const body = getDetailBodyEl();
    if (!body) return;

    const reqKey = stripHash(normUrl);
    const cached = fragmentCache.get(reqKey);
    const alreadyShowingSame =
      detailOpen &&
      currentDetailUrl &&
      stripHash(currentDetailUrl) === reqKey &&
      !opts.forceReload;

    // Fast Path: Instant 0ms memory render if cached
    if (cached && !opts.forceReload && !alreadyShowingSame) {
      openDetailSheetDom(cached.pageTitle || "Details");
      body.innerHTML = cached.html;
      if (cached.pageCss) ensureStylesheet(cached.pageCss);
      if (cached.csrfToken) setCsrfToken(cached.csrfToken);

      currentDetailUrl = cached.resolvedUrl || normUrl;
      currentDetailTitle = cached.pageTitle || "Details";

      const titleEl = document.getElementById("shellDetailTitle");
      if (titleEl) titleEl.textContent = cleanDetailHeaderTitle(currentDetailTitle);
      updateDocumentTitle(currentDetailTitle);

      scrollHashOrTop(body, currentDetailUrl, opts.restoreScroll);
      syncNavIndicators(activeTab);
      syncContextualWidgets();

      if (typeof window.initPageEnhancements === "function") {
        try { window.initPageEnhancements(body); } catch (_) {}
      }
      if (typeof window.BPWirePwaButtons === "function") {
        try { window.BPWirePwaButtons(); } catch (_) {}
      }
      applyReportDots();

      if (!opts.fromPopState) {
        commitNavigationHistory(currentDetailUrl, Boolean(opts.replace));
      }

      // Stale-while-revalidate: if cache older than 60s, silently refresh in background
      if (Date.now() - cached.timestamp > 60000) {
        revalidateDetailRoute(normUrl, body);
      }
      return;
    }

    currentDetailUrl = normUrl;
    openDetailSheetDom(currentDetailTitle || "Loading...");
    syncNavIndicators(activeTab);

    if (!alreadyShowingSame) {
      renderDetailSkeleton();
      startProgress();
      try {
        const result = await fetchAndMountFragment(normUrl, body, detailAbort.signal);
        finishProgress();
        if (!result) return;

        // If server redirected detail URL to a tab route (e.g. /my-activity -> /singer/login)
        const resolvedPath = extractPathname(result.resolvedUrl);
        if (!isDetailRoute(resolvedPath)) {
          closeDetailSheetDom();
          const redirectedTab = mapPathToTab(resolvedPath);
          activeTab = redirectedTab;
          setActivePaneDom(redirectedTab);
          const pane = getPaneEl(redirectedTab);
          if (pane) {
            pane.innerHTML = body.innerHTML;
            body.innerHTML = "";
            if (typeof window.initPageEnhancements === "function") {
              window.initPageEnhancements(pane);
            }
            pane.scrollTop = 0;
          }
          paneState[redirectedTab].loaded = true;
          paneState[redirectedTab].stale = false;
          paneState[redirectedTab].url = result.resolvedUrl;
          paneState[redirectedTab].title = result.pageTitle;
          paneState[redirectedTab].scrollTop = 0;
          updateDocumentTitle(result.pageTitle);
          syncNavIndicators(redirectedTab);
          syncContextualWidgets();
          if (!opts.fromPopState) {
            commitNavigationHistory(result.resolvedUrl, Boolean(opts.replace));
          }
          return;
        }

        currentDetailUrl = result.resolvedUrl;
        currentDetailTitle = result.pageTitle;
        const titleEl = document.getElementById("shellDetailTitle");
        if (titleEl) titleEl.textContent = cleanDetailHeaderTitle(result.pageTitle);
        updateDocumentTitle(result.pageTitle);
      } catch (err) {
        finishProgress();
        if (err && err.name === "AbortError") return;
        console.error("[AppShell] Detail fetch error:", err);
        body.innerHTML = `
          <div class="shell-offline-state">
            <div class="shell-offline-card">
              <h3>Unable to load page</h3>
              <p>Please check your connection and try again.</p>
              <button type="button" class="btn btn-primary" onclick="window.AppShell.refreshCurrent()">Retry</button>
            </div>
          </div>
        `;
      }
    }

    scrollHashOrTop(body, currentDetailUrl || normUrl, opts.restoreScroll);
    syncNavIndicators(activeTab);
    syncContextualWidgets();

    if (!opts.fromPopState) {
      commitNavigationHistory(currentDetailUrl || normUrl, Boolean(opts.replace));
    }
  }

  async function switchTabInternal(tabKey, targetUrl, options) {
    const opts = options || {};
    if (tabKey === "admin") {
      window.location.href = targetUrl || "/admin";
      return;
    }
    if (!TAB_KEYS.includes(tabKey)) tabKey = "home";

    // Native behavior: tapping already-active tab when no new URL & no detail sheet open
    if (
      tabKey === activeTab &&
      !detailOpen &&
      !targetUrl &&
      !opts.forceReload &&
      !opts.fromPopState &&
      paneState[tabKey].loaded &&
      !paneState[tabKey].stale
    ) {
      const pane = getPaneEl(tabKey);
      if (pane && pane.scrollTop > 80) {
        pane.scrollTo({ top: 0, behavior: "smooth" });
        paneState[tabKey].scrollTop = 0;
        snapshotScrollToCurrentHistory();
        return;
      }
      if (stripHash(paneState[tabKey].url) !== TAB_DEFAULTS[tabKey]) {
        targetUrl = TAB_DEFAULTS[tabKey];
      } else {
        return;
      }
    }

    if (!opts.fromPopState) {
      snapshotScrollToCurrentHistory();
    }

    if (window.haptics && typeof window.haptics.light === "function" && !opts.silentHaptic) {
      window.haptics.light();
    }

    closeShellSidebar();
    if (detailOpen) {
      closeDetailSheetDom();
    }

    activeTab = tabKey;
    setActivePaneDom(tabKey);
    syncNavIndicators(tabKey);

    const desiredUrl = normalizeInternalUrl(
      targetUrl || paneState[tabKey].url || TAB_DEFAULTS[tabKey]
    );
    const pane = getPaneEl(tabKey);
    if (!pane) return;

    const canReuseCachedDom =
      paneState[tabKey].loaded &&
      !paneState[tabKey].stale &&
      !opts.forceReload &&
      !opts.fetchOptions &&
      stripHash(paneState[tabKey].url) === stripHash(desiredUrl);

    if (canReuseCachedDom) {
      paneState[tabKey].url = desiredUrl;
      const targetScroll =
        typeof opts.restoreScroll === "number" ? opts.restoreScroll : paneState[tabKey].scrollTop;
      pane.scrollTop = targetScroll;
      requestAnimationFrame(() => {
        pane.scrollTop = targetScroll;
      });

      // Notify hash-aware views (e.g., Singer Hub #tab-reports) if hash changed
      if (desiredUrl.includes("#")) {
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      }

      updateDocumentTitle(paneState[tabKey].title);
      syncNavIndicators(tabKey);
      syncContextualWidgets();

      if (!opts.fromPopState) {
        commitNavigationHistory(desiredUrl, Boolean(opts.replace));
      }
      return;
    }

    if (paneAbort) paneAbort.abort();
    paneAbort = new AbortController();

    if (!paneState[tabKey].loaded) {
      pane.innerHTML = `
        <div class="shell-skeleton-wrap" aria-busy="true">
          <div class="shell-skeleton-bar shell-sk-lg"></div>
          <div class="shell-skeleton-bar shell-sk-sm"></div>
          <div class="shell-skeleton-card"></div>
          <div class="shell-skeleton-card"></div>
        </div>
      `;
    }

    startProgress();
    try {
      const result = await fetchAndMountFragment(
        desiredUrl,
        pane,
        paneAbort.signal,
        opts.fetchOptions
      );
      finishProgress();
      if (!result) return;

      paneState[tabKey].loaded = true;
      paneState[tabKey].stale = false;
      paneState[tabKey].url = result.resolvedUrl;
      paneState[tabKey].title = result.pageTitle;

      const targetScroll = typeof opts.restoreScroll === "number" ? opts.restoreScroll : 0;
      scrollHashOrTop(pane, result.resolvedUrl, targetScroll);
      paneState[tabKey].scrollTop = pane.scrollTop;

      updateDocumentTitle(result.pageTitle);
      syncNavIndicators(tabKey);
      syncContextualWidgets();

      if (!opts.fromPopState) {
        commitNavigationHistory(result.resolvedUrl, Boolean(opts.replace));
      }
    } catch (err) {
      finishProgress();
      if (err && err.name === "AbortError") return;
      console.error("[AppShell] Pane fetch error:", err);
      if (!paneState[tabKey].loaded) {
        pane.innerHTML = `
          <div class="shell-offline-state">
            <div class="shell-offline-card">
              <h3>Unable to load view</h3>
              <p>Please check your connection and try again.</p>
              <button type="button" class="btn btn-primary" onclick="window.AppShell.refreshCurrent()">Retry</button>
            </div>
          </div>
        `;
      }
    }
  }

  // ── Speculative Prewarming & Detail Revalidation ─────────────────────────
  function revalidateDetailRoute(url, body) {
    const reqKey = stripHash(url);
    fetch(reqKey, {
      method: "GET",
      credentials: "same-origin",
      headers: { "X-App-Shell": "1", Accept: "text/html" }
    })
      .then(async (res) => {
        if (!res.ok) return;
        const html = await res.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, "text/html");
        const fragmentRoot = doc.querySelector(".shell-fragment-root") || doc.body;
        if (!fragmentRoot) return;

        const pageTitle = fragmentRoot.getAttribute("data-page-title") || doc.title || "Bhajan Planner";
        const pageCss = fragmentRoot.getAttribute("data-page-css") || "";
        const pageJs = fragmentRoot.getAttribute("data-page-js") || "";
        const csrfToken = fragmentRoot.getAttribute("data-csrf-token") || "";

        fragmentCache.set(reqKey, {
          html: fragmentRoot.innerHTML,
          pageTitle,
          pageCss,
          pageJs,
          csrfToken,
          resolvedUrl: url,
          timestamp: Date.now()
        });

        if (detailOpen && currentDetailUrl && stripHash(currentDetailUrl) === reqKey) {
          body.innerHTML = fragmentRoot.innerHTML;
          if (pageCss) ensureStylesheet(pageCss);
          if (typeof window.initPageEnhancements === "function") {
            try { window.initPageEnhancements(body); } catch (_) {}
          }
        }
      })
      .catch(() => {});
  }

  function prefetchRoute(rawUrl) {
    if (!rawUrl) return;
    const normUrl = normalizeInternalUrl(rawUrl);
    const pathname = extractPathname(normUrl);
    if (isBypassPath(pathname)) return;

    const targetTab = mapPathToTab(pathname);
    if (!isDetailRoute(pathname) && targetTab && !paneState[targetTab].loaded) {
      prefetchTab(targetTab);
      return;
    }

    const reqKey = stripHash(normUrl);
    if (fragmentCache.has(reqKey) || inFlightPrefetches.has(reqKey)) return;
    inFlightPrefetches.add(reqKey);

    fetch(reqKey, {
      method: "GET",
      credentials: "same-origin",
      headers: { "X-App-Shell": "1", Accept: "text/html" }
    })
      .then(async (res) => {
        if (!res.ok) return;
        const html = await res.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, "text/html");
        const fragmentRoot = doc.querySelector(".shell-fragment-root") || doc.body;
        if (!fragmentRoot) return;

        const pageTitle = fragmentRoot.getAttribute("data-page-title") || doc.title || "Bhajan Planner";
        const pageCss = fragmentRoot.getAttribute("data-page-css") || "";
        const pageJs = fragmentRoot.getAttribute("data-page-js") || "";
        const csrfToken = fragmentRoot.getAttribute("data-csrf-token") || "";

        if (pageCss) ensureStylesheet(pageCss);

        fragmentCache.set(reqKey, {
          html: fragmentRoot.innerHTML,
          pageTitle,
          pageCss,
          pageJs,
          csrfToken,
          resolvedUrl: normUrl,
          timestamp: Date.now()
        });

        if (fragmentCache.size > MAX_CACHE_SIZE) {
          const oldest = fragmentCache.keys().next().value;
          fragmentCache.delete(oldest);
        }
      })
      .catch(() => {})
      .finally(() => {
        inFlightPrefetches.delete(reqKey);
      });
  }

  function prefetchTab(tabKey) {
    if (!TAB_KEYS.includes(tabKey) || paneState[tabKey].loaded) return;
    const defaultUrl = TAB_DEFAULTS[tabKey];
    if (defaultUrl) {
      prefetchRoute(defaultUrl);
    }
  }

  function scheduleIdlePrewarm() {
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (conn && (conn.saveData || conn.effectiveType === "2g" || conn.effectiveType === "3g" || conn.effectiveType === "slow-2g")) {
      return;
    }

    const PREWARM_NEXT_MAP = {
      home: "plan",
      bank: "plan",
      singer: "plan",
      plan: "home",
      hub: "singer"
    };

    const nextTab = PREWARM_NEXT_MAP[activeTab] || TAB_KEYS.find((k) => k !== activeTab && !paneState[k].loaded);
    if (!nextTab || paneState[nextTab].loaded) return;

    function warmNext() {
      if (paneState[nextTab].loaded) return;
      prefetchTab(nextTab);
    }

    if ("requestIdleCallback" in window) {
      window.requestIdleCallback(warmNext, { timeout: 4000 });
    } else {
      setTimeout(warmNext, 4000);
    }
  }

  function bindNavIntent() {
    const onIntent = (e) => {
      const target = e.target && e.target.closest ? e.target.closest("a, button[data-tab], button[data-route]") : null;
      if (!target) return;

      const tab = target.getAttribute("data-tab");
      if (tab && TAB_KEYS.includes(tab) && !paneState[tab].loaded) {
        prefetchTab(tab);
        return;
      }

      const route = target.getAttribute("data-route") || target.getAttribute("href");
      if (route && typeof route === "string" && route.startsWith("/") && !route.startsWith("//")) {
        prefetchRoute(route);
      }
    };

    document.addEventListener("pointerdown", onIntent, { passive: true, capture: true });
    document.addEventListener("touchstart", onIntent, { passive: true });
    document.addEventListener("pointerenter", onIntent, { passive: true, capture: true });
  }

  async function navigate(rawUrl, options) {
    const opts = options || {};
    if (!rawUrl) return;

    const normUrl = normalizeInternalUrl(rawUrl);
    const pathname = extractPathname(normUrl);

    if (isBypassPath(pathname)) {
      window.location.href = normUrl;
      return;
    }

    // Special redirect resolver (/session-link) — fetch via shell and route according to resolved X-Shell-Url
    if (pathname.toLowerCase() === "/session-link") {
      startProgress();
      try {
        const probe = await fetch(stripHash(normUrl), {
          method: "GET",
          credentials: "same-origin",
          headers: { "X-App-Shell": "1", Accept: "text/html" }
        });
        finishProgress();
        const resolved =
          probe.headers.get("X-Shell-Url") ||
          (probe.url ? new URL(probe.url).pathname + new URL(probe.url).search : "/database");
        return navigate(resolved, opts);
      } catch (_) {
        finishProgress();
        return navigate("/database", opts);
      }
    }

    if (isDetailRoute(pathname)) {
      return loadDetailRoute(normUrl, opts);
    }

    const targetTab = mapPathToTab(pathname);
    return switchTabInternal(targetTab, normUrl, opts);
  }

  function back(fallbackUrl) {
    const curState = window.history.state;
    const seq = curState && typeof curState.seq === "number" ? curState.seq : historySeq;

    if (seq > 1) {
      window.history.back();
      return;
    }

    // Deep-linked entry (seq === 1): stay inside the app instead of exiting PWA
    const fallback = fallbackUrl || TAB_DEFAULTS[activeTab] || "/";
    if (detailOpen) {
      closeDetailSheetDom();
      const targetTab = mapPathToTab(extractPathname(fallback));
      switchTabInternal(targetTab, fallback, { replace: true });
    } else {
      navigate(fallback, { replace: true });
    }
  }

  function markStale(tabs) {
    const list = Array.isArray(tabs) ? tabs : TAB_KEYS;
    list.forEach((k) => {
      if (paneState[k]) paneState[k].stale = true;
    });
  }

  function refreshCurrent() {
    if (detailOpen && currentDetailUrl) {
      return loadDetailRoute(currentDetailUrl, {
        forceReload: true,
        replace: true,
        restoreScroll: getCurrentDetailScroll()
      });
    }
    return switchTabInternal(activeTab, paneState[activeTab].url || TAB_DEFAULTS[activeTab], {
      forceReload: true,
      replace: true,
      restoreScroll: getCurrentPaneScroll(),
      silentHaptic: true
    });
  }

  function onAuthChange(singer) {
    try {
      if (singer && singer.id) {
        localStorage.setItem("bp_singer_id", String(singer.id));
        localStorage.setItem("bp_singer_name", singer.name || "");
        localStorage.setItem("bp_singer_gender", singer.gender || "");
        localStorage.setItem("bp_singer_login_time", String(Date.now()));
        localStorage.setItem("bj_singer_id", String(singer.id));
        localStorage.setItem("bj_singer_name", singer.name || "");
      } else {
        localStorage.removeItem("bp_singer_id");
        localStorage.removeItem("bp_singer_name");
        localStorage.removeItem("bp_singer_gender");
        localStorage.removeItem("bj_singer_id");
        localStorage.removeItem("bj_singer_name");
      }
    } catch (_) {}

    // Update top header singer pill if present
    const singerPill = document.getElementById("shellSingerPill");
    const singerPillName = document.getElementById("shellSingerPillName");
    const singerPillInitial = document.getElementById("shellSingerPillInitial");
    if (singerPill && singer && singer.name) {
      if (singerPillName) singerPillName.textContent = singer.name.split(" ")[0];
      if (singerPillInitial) singerPillInitial.textContent = singer.name.charAt(0).toUpperCase();
      singerPill.style.display = "inline-flex";
    } else if (singerPill && !singer) {
      singerPill.style.display = "none";
    }

    // Mark personalized panes stale so next switch reflects new identity & bookmarks
    markStale(["home", "bank", "singer", "hub"]);
  }

  // ── Sidebar Drawer Controls ──────────────────────────────────────────────
  function toggleShellSidebar() {
    const sidebar = document.getElementById("shellSidebar");
    const overlay = document.getElementById("shellSidebarOverlay");
    if (!sidebar || !overlay) return;
    const isOpen = sidebar.classList.contains("open");
    if (isOpen) {
      closeShellSidebar();
    } else {
      sidebar.classList.add("open");
      overlay.classList.add("open");
      if (window.haptics && typeof window.haptics.light === "function") window.haptics.light();
    }
  }

  function closeShellSidebar() {
    const sidebar = document.getElementById("shellSidebar");
    const overlay = document.getElementById("shellSidebarOverlay");
    if (sidebar) sidebar.classList.remove("open");
    if (overlay) overlay.classList.remove("open");
  }

  // ── Global Link & Shell UI Event Delegation ──────────────────────────────
  document.addEventListener("touchend", (e) => {
    const audioCloseBtn = e.target && e.target.closest ? e.target.closest(".audio-close-bar-btn") : null;
    if (audioCloseBtn) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (window.SessionAudioPlayer && typeof window.SessionAudioPlayer.close === "function") {
        window.SessionAudioPlayer.close();
      } else if (typeof window.closeSessionAudioPlayer === "function") {
        window.closeSessionAudioPlayer();
      } else {
        const bar = document.getElementById("stickySessionAudioBar");
        if (bar) {
          bar.classList.remove("is-visible");
          bar.style.setProperty("display", "none", "important");
          bar.style.setProperty("visibility", "hidden", "important");
        }
      }
    }
  }, { passive: false });

  document.addEventListener("click", (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

    // 0. Sticky audio player close button
    const audioCloseBtn = e.target && e.target.closest ? e.target.closest(".audio-close-bar-btn") : null;
    if (audioCloseBtn) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (window.SessionAudioPlayer && typeof window.SessionAudioPlayer.close === "function") {
        window.SessionAudioPlayer.close();
      } else if (typeof window.closeSessionAudioPlayer === "function") {
        window.closeSessionAudioPlayer();
      } else {
        const bar = document.getElementById("stickySessionAudioBar");
        if (bar) {
          bar.classList.remove("is-visible");
          bar.style.setProperty("display", "none", "important");
          bar.style.setProperty("visibility", "hidden", "important");
        }
      }
      return;
    }

    // 1. Sidebar hamburger toggle button
    const menuBtn = e.target && e.target.closest ? e.target.closest("#shellMenuBtn, .shell-menu-btn") : null;
    if (menuBtn) {
      e.preventDefault();
      e.stopImmediatePropagation();
      toggleShellSidebar();
      return;
    }

    // 2. Sidebar close button or backdrop overlay
    const closeBtn = e.target && e.target.closest ? e.target.closest(".shell-sidebar-close, #shellSidebarOverlay") : null;
    if (closeBtn) {
      e.preventDefault();
      e.stopImmediatePropagation();
      closeShellSidebar();
      return;
    }

    // 3. Sidebar primary workspace item
    const sideTabItem = e.target && e.target.closest ? e.target.closest(".sidebar-nav-item[data-tab]") : null;
    if (sideTabItem) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const tab = sideTabItem.getAttribute("data-tab");
      closeShellSidebar();
      switchTabInternal(tab, null, {});
      return;
    }

    // 4. Sidebar resource item
    const sideRouteItem = e.target && e.target.closest ? e.target.closest(".sidebar-nav-item[data-route]") : null;
    if (sideRouteItem) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const route = sideRouteItem.getAttribute("data-route");
      const parentTab = sideRouteItem.getAttribute("data-tab-parent") || mapPathToTab(route);
      closeShellSidebar();
      if (route && isDetailRoute(extractPathname(route))) {
        loadDetailRoute(route, {});
      } else {
        switchTabInternal(parentTab, route, {});
      }
      return;
    }

    // 5. Mobile bottom navigation bar tab
    const navTabBtn = e.target && e.target.closest ? e.target.closest(".nav-tab[data-tab]") : null;
    if (navTabBtn) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const tab = navTabBtn.getAttribute("data-tab");
      if (tab === "admin") {
        window.location.href = "/admin";
      } else {
        switchTabInternal(tab, null, {});
      }
      return;
    }

    // 6. Header brand / logo click -> Home
    const brandWrap = e.target && e.target.closest ? e.target.closest(".header-brand-wrap") : null;
    if (brandWrap) {
      e.preventDefault();
      e.stopImmediatePropagation();
      switchTabInternal("home", "/", {});
      return;
    }

    // 7. Sidebar brand logo -> Home
    const sidebarLogo = e.target && e.target.closest ? e.target.closest(".shell-sidebar-logo-link") : null;
    if (sidebarLogo) {
      e.preventDefault();
      e.stopImmediatePropagation();
      closeShellSidebar();
      switchTabInternal("home", "/", {});
      return;
    }

    // 8. Singer Profile Pill -> Hub
    const singerPill = e.target && e.target.closest ? e.target.closest("#shellSingerPill") : null;
    if (singerPill) {
      e.preventDefault();
      e.stopImmediatePropagation();
      switchTabInternal("hub", "/my-hub", {});
      return;
    }

    // 9. Slide-over detail back button
    const detailBack = e.target && e.target.closest ? e.target.closest("#shellDetailBackBtn, .shell-detail-back-btn") : null;
    if (detailBack) {
      e.preventDefault();
      e.stopImmediatePropagation();
      back();
      return;
    }


    if (e.defaultPrevented) return;

    const anchor = e.target && e.target.closest ? e.target.closest("a") : null;
    if (!anchor) return;
    if (anchor.hasAttribute("download") || anchor.hasAttribute("data-no-shell")) return;
    const targetAttr = anchor.getAttribute("target");
    if (targetAttr && targetAttr !== "_self") return;

    const rawHref = anchor.getAttribute("href") || "";
    if (
      !rawHref ||
      rawHref.startsWith("#") ||
      rawHref.startsWith("javascript:") ||
      rawHref.startsWith("mailto:") ||
      rawHref.startsWith("tel:") ||
      rawHref.startsWith("whatsapp:")
    ) {
      return;
    }

    let dest;
    try {
      dest = new URL(anchor.href, window.location.origin);
    } catch (_) {
      return;
    }
    if (dest.origin !== window.location.origin) return;

    if (isBypassPath(dest.pathname)) {
      return; // allow normal top-level browser navigation
    }

    e.preventDefault();
    closeShellSidebar();
    navigate(dest.pathname + dest.search + dest.hash);
  });

  document.addEventListener("submit", (e) => {
    if (e.defaultPrevented) return;
    const form = e.target;
    if (!form || form.tagName !== "FORM") return;
    if (form.hasAttribute("data-no-shell")) return;
    if (form.getAttribute("target") && form.getAttribute("target") !== "_self") return;
    if ((form.getAttribute("enctype") || "").toLowerCase() === "multipart/form-data") return;

    const rawAction = form.getAttribute("action") || window.location.pathname;
    let dest;
    try {
      dest = new URL(rawAction, window.location.origin);
    } catch (_) {
      return;
    }
    if (dest.origin !== window.location.origin) return;
    if (isBypassPath(dest.pathname)) return;

    const method = (form.getAttribute("method") || "GET").toUpperCase();

    if (method === "GET") {
      e.preventDefault();
      const fd = new FormData(form);
      const params = new URLSearchParams();
      for (const [k, v] of fd.entries()) {
        if (typeof v === "string") params.append(k, v);
      }
      const qs = params.toString();
      navigate(dest.pathname + (qs ? "?" + qs : ""));
      return;
    }

    // Intercept Mark Bhajan POST (/submit-form) seamlessly inside #pane-singer
    if (method === "POST" && dest.pathname.toLowerCase() === "/submit-form") {
      e.preventDefault();
      const fd = new FormData(form);
      const bodyParams = new URLSearchParams();
      for (const [k, v] of fd.entries()) {
        if (typeof v === "string") bodyParams.append(k, v);
      }

      const submitBtn = form.querySelector('button[type="submit"], input[type="submit"]');
      if (submitBtn) {
        submitBtn.disabled = true;
      }

      markStale(["home", "plan", "hub"]);

      switchTabInternal("singer", dest.pathname, {
        forceReload: true,
        silentHaptic: true,
        fetchOptions: {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "X-CSRF-Token": getCsrfToken()
          },
          body: bodyParams.toString()
        }
      });
    }
  });

  // ── Browser History Popstate Handler ─────────────────────────────────────
  window.addEventListener("popstate", (e) => {
    const state = e.state;
    const browserUrl = window.location.pathname + window.location.search + window.location.hash;

    if (state && state.__bpShell) {
      historySeq = typeof state.seq === "number" ? state.seq : 1;

      if (state.detailUrl) {
        if (state.tab && state.tab !== activeTab) {
          activeTab = state.tab;
          setActivePaneDom(activeTab);
        }
        loadDetailRoute(state.detailUrl, {
          fromPopState: true,
          restoreScroll: state.detailScroll || 0
        });
        return;
      }

      if (detailOpen) {
        closeDetailSheetDom();
      }

      const targetTab = state.tab || mapPathToTab(window.location.pathname);
      const targetTabUrl = state.tabUrl || browserUrl || TAB_DEFAULTS[targetTab];
      switchTabInternal(targetTab, targetTabUrl, {
        fromPopState: true,
        restoreScroll: typeof state.paneScroll === "number" ? state.paneScroll : 0,
        silentHaptic: true
      });
      return;
    }

    // Fallback if browser popped to an untagged history entry
    const path = window.location.pathname;
    if (isDetailRoute(path)) {
      loadDetailRoute(browserUrl, { fromPopState: true });
    } else {
      if (detailOpen) closeDetailSheetDom();
      switchTabInternal(mapPathToTab(path), browserUrl, {
        fromPopState: true,
        silentHaptic: true
      });
    }
  });

  // Escape key closes Detail Sheet when no modal/panel is open on top
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!detailOpen) return;
    const openModal = document.querySelector(
      ".modal.show, .lyrics-modal-backdrop.active, .notif-panel.open, .tanpura-popover.open"
    );
    if (openModal) return;
    e.preventDefault();
    back();
  });

  // Keep pane scroll snapshots fresh during passive scrolling
  let scrollSaveTimer = null;
  document.addEventListener(
    "scroll",
    (e) => {
      const t = e.target;
      if (!t || !t.classList) return;
      if (t.classList.contains("shell-pane") && t.classList.contains("active-pane")) {
        paneState[activeTab].scrollTop = t.scrollTop;
        clearTimeout(scrollSaveTimer);
        scrollSaveTimer = setTimeout(snapshotScrollToCurrentHistory, 250);
      } else if (t.id === "shellDetailBody" && detailOpen) {
        clearTimeout(scrollSaveTimer);
        scrollSaveTimer = setTimeout(snapshotScrollToCurrentHistory, 250);
      }
    },
    { capture: true, passive: true }
  );

  // Service Worker Push Notification Click Message
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data && e.data.type === "BP_NAVIGATE" && e.data.url) {
        navigate(e.data.url);
      }
    });
  }

  // ── Theme Toggle Controller ──────────────────────────────────────────────
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
    const themeBtns = document.querySelectorAll(
      "#shellThemeToggle, .theme-toggle, #themeToggle, #topbarThemeToggle, #themeToggleBtn, .admin-theme-toggle-btn"
    );
    themeBtns.forEach((btn) => {
      btn.setAttribute("aria-pressed", isDark ? "true" : "false");
      btn.setAttribute("data-tooltip", isDark ? "Switch to Light" : "Switch to Dark");
      btn.setAttribute("title", isDark ? "Switch to Light" : "Switch to Dark");
    });
    const metaThemes = document.querySelectorAll('meta[name="theme-color"]');
    metaThemes.forEach((m) => m.setAttribute("content", isDark ? "#12100E" : "#FAF7F2"));
    if (window.top && window.top !== window) {
      try {
        if (typeof window.top.applyTheme === "function" && window.top !== window) {
          window.top.applyTheme(isDark);
        }
      } catch (_) {}
    }
    window.dispatchEvent(new CustomEvent("themechange", { detail: { isDark: isDark } }));
  }

  function handleThemeToggle(e) {
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

  window.toggleTheme = handleThemeToggle;
  window.applyTheme = applyTheme;

  function bindThemeToggle() {
    let stored = null;
    try { stored = localStorage.getItem("bp-theme"); } catch (_) {}
    const isDark = stored === "dark" || (stored !== "light" && (document.documentElement.getAttribute("data-theme") === "dark" || document.documentElement.classList.contains("dark")));
    applyTheme(isDark);

    const themeBtn = document.getElementById("shellThemeToggle");
    if (themeBtn && !themeBtn._themeAttached) {
      themeBtn._themeAttached = true;
      themeBtn.addEventListener("click", handleThemeToggle);
    }
  }

  // ── Public Global API (including backward-compatible helpers) ────────────
  window.switchTab = function (tabKey, targetUrl, skipHistory) {
    if (targetUrl && isDetailRoute(extractPathname(targetUrl))) {
      return loadDetailRoute(targetUrl, { replace: Boolean(skipHistory) });
    }
    return switchTabInternal(tabKey, targetUrl, { replace: Boolean(skipHistory) });
  };

  window.handleNavClick = function (tabKey, targetUrl, evt) {
    if (evt && evt.preventDefault) evt.preventDefault();
    closeShellSidebar();
    return switchTabInternal(tabKey, targetUrl || null, {});
  };

  window.handleDeepLink = function (routePath, tabKey, evt) {
    if (evt && evt.preventDefault) evt.preventDefault();
    closeShellSidebar();
    if (routePath && isDetailRoute(extractPathname(routePath))) {
      return loadDetailRoute(routePath, {});
    }
    return switchTabInternal(tabKey || mapPathToTab(routePath), routePath, {});
  };

  window.toggleShellSidebar = toggleShellSidebar;
  window.closeShellSidebar = closeShellSidebar;

  window.AppShell = {
    navigate,
    switchTab: window.switchTab,
    back,
    refreshCurrent,
    markStale,
    onAuthChange,
    syncContextualWidgets,
    prefetchTab,
    prefetchRoute,
    isActive: true,
    getState: () => ({
      activeTab,
      detailOpen,
      currentDetailUrl,
      paneUrl: paneState[activeTab]?.url
    })
  };

  // ── Boot Initial Route ───────────────────────────────────────────────────
  function boot() {
    bindThemeToggle();

    const bootCfg = window.__SHELL_BOOT__ || {};
    const initialRoute = normalizeInternalUrl(
      bootCfg.initialRoute || window.location.pathname + window.location.search + window.location.hash
    );
    const initPath = extractPathname(initialRoute);
    const bootTab = TAB_KEYS.includes(bootCfg.initialTab)
      ? bootCfg.initialTab
      : mapPathToTab(initPath);

    activeTab = bootTab;
    if (isDetailRoute(initPath)) {
      detailOpen = true;
      currentDetailUrl = initialRoute;
    }
    setActivePaneDom(activeTab);
    syncNavIndicators(activeTab);

    // Check if initial pane has Server-Side Rendered (SSR) HTML
    const activePane = getPaneEl(activeTab);
    const hasSsrContent = Boolean(
      activePane &&
        (activePane.querySelector(".shell-fragment-root") ||
          activePane.querySelector(".dashboard-page, .zen-unified-deck") ||
          activePane.children.length > 0)
    );

    if (hasSsrContent) {
      paneState[activeTab].loaded = true;
      paneState[activeTab].stale = false;
      paneState[activeTab].url = initialRoute;
      paneState[activeTab].title = document.title;

      const fragRoot = activePane.querySelector(".shell-fragment-root");
      if (fragRoot) {
        const pageTitle = fragRoot.getAttribute("data-page-title");
        if (pageTitle) updateDocumentTitle(pageTitle);
        const csrfToken = fragRoot.getAttribute("data-csrf-token");
        if (csrfToken) setCsrfToken(csrfToken);
      }

      if (typeof window.initPageEnhancements === "function") {
        try {
          window.initPageEnhancements(activePane);
        } catch (e) {
          console.warn("[AppShell] initPageEnhancements SSR error:", e);
        }
      }
      if (typeof window.BPWirePwaButtons === "function") {
        try {
          window.BPWirePwaButtons();
        } catch (_) {}
      }
      applyReportDots();
      syncContextualWidgets();
    }

    if (isDetailRoute(initPath)) {
      // Deep-linked directly onto a detail view (e.g. /bhajan/42 or /database):
      // Open detail sheet immediately, and warm underlying parent tab on idle so Back is 0ms!
      loadDetailRoute(initialRoute, { replace: true });
      const warmFn = () => {
        if (!paneState[activeTab].loaded) {
          const pane = getPaneEl(activeTab);
          if (pane) {
            fetchAndMountFragment(TAB_DEFAULTS[activeTab], pane, null)
              .then((res) => {
                if (res) {
                  paneState[activeTab].loaded = true;
                  paneState[activeTab].url = res.resolvedUrl;
                  paneState[activeTab].title = res.pageTitle;
                }
              })
              .catch(() => {});
          }
        }
      };
      if ("requestIdleCallback" in window) {
        window.requestIdleCallback(warmFn, { timeout: 1500 });
      } else {
        setTimeout(warmFn, 600);
      }
    } else if (!hasSsrContent) {
      switchTabInternal(activeTab, initialRoute, {
        replace: true,
        silentHaptic: true
      });
    } else {
      commitNavigationHistory(initialRoute, true);
    }

    // Schedule background idle pre-warming of remaining tabs for instant 0ms switching
    scheduleIdlePrewarm();
    // Bind touchstart / hover intent preloading for instant responsiveness
    bindNavIntent();

    if (window.__pendingNavRoute) {
      const p = window.__pendingNavRoute;
      window.__pendingNavRoute = null;
      window.handleDeepLink(p.route, p.tab);
    } else if (window.__pendingNavTab) {
      const t = window.__pendingNavTab;
      window.__pendingNavTab = null;
      window.handleNavClick(t);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
