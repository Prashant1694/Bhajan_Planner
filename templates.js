const fs = require("fs");
const path = require("path");

let tanpuraWidgetHtml = "";
function getTanpuraWidgetHtml() {
  try {
    return fs.readFileSync(path.join(__dirname, "views", "partials", "tanpura-widget.ejs"), "utf8");
  } catch (e) {
    return tanpuraWidgetHtml;
  }
}
try {
  tanpuraWidgetHtml = getTanpuraWidgetHtml();
} catch (e) {
  console.error("Could not load tanpura-widget.ejs:", e);
}

function escapeHtml(unsafe) {
  if (unsafe === null || unsafe === undefined) return "";
  return String(unsafe)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

const themeHeadScript = `
  <link rel="stylesheet" href="/css/app-shell.css?v=4.6">
  <script>
  (function(){
    try {
      var t = localStorage.getItem('bp-theme');
      if (t === 'dark') document.documentElement.setAttribute('data-theme','dark');
    } catch(e){}

    var inIframe = false;
    try {
      inIframe = (window.self !== window.top) || window.location.search.includes('_embed=1') || window.location.search.includes('embed=1');
    } catch(_) {
      inIframe = true;
    }

    if (inIframe) {
      document.documentElement.classList.add('in-iframe');
    }

    function checkEmbed() {
      if (inIframe) {
        if (document.body) {
          document.body.classList.add('embed-page', 'in-iframe');
        }
        var cleanUrl = (function() {
          try {
            var u = new URL(window.location.href);
            u.searchParams.delete('_embed');
            u.searchParams.delete('embed');
            var qs = u.searchParams.toString();
            return u.pathname + (qs ? ('?' + qs) : '');
          } catch (_) {
            return window.location.pathname;
          }
        })();
        try { sessionStorage.setItem('bp_current_path', cleanUrl); } catch (_) {}
        if (window.top && typeof window.top.onFrameNavigated === 'function') {
          window.top.onFrameNavigated(cleanUrl, window.location.pathname);
        } else if (window.top && window.top.history && window.top.history.replaceState) {
          window.top.history.replaceState({ path: cleanUrl }, '', cleanUrl);
        }
      } else if (!/^\/(admin-login|forgot-password|logout)/i.test(window.location.pathname) && !window.location.search.includes('_embed=1') && !window.location.search.includes('standalone=1')) {
        var fullUrl = window.location.pathname + window.location.search;
        try { sessionStorage.setItem('bp_current_path', fullUrl); } catch (_) {}
        window.location.replace('/?route=' + encodeURIComponent(fullUrl));
      }
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', checkEmbed);
    } else {
      checkEmbed();
    }
  })();
  </script>`;

const themeToggleBtnHtml = `
  <!-- Dark Mode Toggle -->
  <button
    class="theme-toggle"
    id="themeToggle"
    aria-label="Toggle dark mode"
    aria-pressed="false"
    data-tooltip="Switch to Dark"
  >
    <span class="icon-moon" aria-hidden="true">🌙</span>
    <span class="icon-sun"  aria-hidden="true">☀️</span>
  </button>`;

const appBottomNavHtml = "";

function generateSubmitFormHtml(
  sessionDate,
  mandatoryFilled,
  totalMandatory,
  optionalFilled,
  totalOptional,
  ganeshaCardHtml,
  otherDeitiesHtml,
  hanumanCard,
  isAdmin,
  showSuccess = false,
  submissionRowsHtml = "",
  submissionCount = 0,
  currentSinger = null,
  csrfToken = ""
) {
  const isAdminBool = isAdmin === true || isAdmin === "true";
  const dateAttr = isAdminBool ? "" : 'readonly style="cursor:not-allowed;"';
  const dateNotice = isAdminBool
    ? `<div class="date-notice date-notice-admin">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        <span><strong>Admin Mode:</strong> You can select any session date and manage bhajans at any time.</span>
       </div>`
    : `<div class="date-notice date-notice-user">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        <span><strong>Submission Protocol:</strong> Submissions for <strong>${escapeHtml(sessionDate)}</strong> close on the night before at 11:59 PM. At 12:00 AM on the session date, submissions automatically lock.</span>
       </div>`;

  const singerInitial = currentSinger ? (currentSinger.name || 'S').charAt(0).toUpperCase() : (isAdminBool ? 'A' : 'D');
  const totalSlots = (Number(totalMandatory || 0) + Number(totalOptional || 0)) || 11;
  const totalFilled = Number(mandatoryFilled || 0) + Number(optionalFilled || 0);
  const progressPercent = totalSlots > 0 ? Math.min(100, Math.round((totalFilled / totalSlots) * 100)) : 0;
  const progressCountsHtml = (totalMandatory && totalMandatory > 0)
    ? `<span class="submit-count-pill">${mandatoryFilled}/${totalMandatory} Mandatory</span>
       <span class="submit-count-pill" style="background:rgba(120,113,108,0.12); color:#57534e; border-color:rgba(120,113,108,0.25);">${optionalFilled}/${totalOptional} Optional</span>`
    : `<span class="submit-count-pill">${totalFilled}/${totalSlots} Slots Filled</span>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Bhajan Scheduler • Sri Sathya Sai Seva Organisations, Gandhinagar</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="csrf-token" content="${escapeHtml(csrfToken)}" />
  <script>window.csrfToken = "${escapeHtml(csrfToken)}";</script>
  <!-- Google Fonts: Fraunces & Inter (Exact App Typography) -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/css/style.css?v=5.5">
  <link rel="stylesheet" href="/css/submit-glass.css?v=1.0">
  <link rel="stylesheet" href="/css/tanpura.css?v=1.0">
  ${themeHeadScript}
</head>
<body class="embed-page in-iframe">
  ${themeToggleBtnHtml}

  <div class="zen-submit-stage">
    
    <!-- Ambient Sacred Glow Orbs (Background) -->
    <div class="sacred-orbs-canvas">
      <div class="sacred-orb sacred-orb-1"></div>
      <div class="sacred-orb sacred-orb-2"></div>
      <div class="sacred-orb sacred-orb-3"></div>
      <div class="sacred-orb sacred-orb-4"></div>
      <div class="sacred-grid-texture"></div>
    </div>

    <!-- Prasanthi Sanctum Top Border -->
    <div class="prasanthi-border"></div>

    <div class="zen-submit-container">

      <!-- 1. Hero Banner with Authentic Free-Standing Emblems -->
      <header class="zen-glass-panel submit-hero-banner">
        <!-- Left: Original Sri Sathya Sai Lotus Emblem -->
        <div class="submit-emblem-wrap" title="Sri Sathya Sai Lotus Emblem">
          <img src="/images/logo.png" alt="Sri Sathya Sai Lotus Emblem" class="submit-emblem" onerror="this.style.display='none'">
        </div>

        <!-- Center: Organisation Badge & Hero Title -->
        <div class="submit-hero-center">
          <div class="submit-org-badge">
            <span style="display:inline-block; width:6px; height:6px; border-radius:50%; background:#d97706; margin-right:4px;"></span>
            Sri Sathya Sai Seva Organisations, Gandhinagar
          </div>
          <h1 class="submit-hero-title">
            Bhajan Planner
          </h1>
          <p class="submit-hero-subtitle" style="font-family: 'Fraunces', Georgia, serif; font-style: italic; font-size: clamp(12.5px, 1.8vw, 14.5px); color: #78716c; max-width: 640px; line-height: 1.55; margin-top: 6px;">
            &ldquo;Bhajan must spread good-will, love, ecstasy; it must cleanse the polluted atmosphere; it must invite all to share in the joy and peace.&rdquo;
            <span style="font-style: normal; font-weight: 600; font-size: 11px; opacity: 0.85; margin-left: 6px; white-space: nowrap;">&mdash; Baba</span>
          </p>
        </div>

        <!-- Right: Original 100th Birthday Emblem -->
        <div class="submit-emblem-wrap" title="Sri Sathya Sai 100th Birthday Emblem">
          <img src="/images/logo_birthday.png" alt="Sri Sathya Sai 100th Birthday Emblem" class="submit-emblem" onerror="this.style.display='none'">
        </div>
      </header>

      <!-- 2. Session Sequence Progress Indicator -->
      <section class="zen-glass-panel submit-progress-card">
        <div class="submit-progress-top">
          <h2 class="submit-progress-title">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2"><path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/></svg>
            Session Sequence Progress
          </h2>
          <div class="submit-progress-counts">
            ${progressCountsHtml}
          </div>
        </div>
        <div class="submit-progress-track">
          <div class="submit-progress-fill" style="width: ${progressPercent}%;"></div>
        </div>
      </section>

      <!-- 3. Main Submission Form -->
      <div id="scheduler" class="tab-content active" style="display:flex; flex-direction:column; gap:22px;">
        
        <form method="post" action="/submit-form" id="bhajanForm" style="display:flex; flex-direction:column; gap:22px;">
          <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}" />
          <input type="hidden" name="admin" value="${isAdminBool}" />

          <!-- Session Date & Policy Notice -->
          <div class="zen-glass-panel" style="padding:20px 24px;">
            <div class="form-group" style="margin-bottom:0;">
              <label style="display:flex; align-items:center; gap:6px;">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2"><rect width="18" height="18" x="3" y="4" rx="2" ry="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/></svg>
                <span>Bhajan Session Date</span>
              </label>
              <input type="date" name="session_date" value="${sessionDate}" required ${dateAttr} />
              ${dateNotice}
            </div>
          </div>

          <!-- Singer & Accompanist Profile -->
          <div class="zen-glass-panel singer-profile-box">
            <div class="form-row cols-3">
              <div class="form-group">
                <label>Singer Name <span class="required" style="color:#e11d48;">*</span></label>
                <div class="singer-autocomplete">
                  <input type="text" name="singer_name" id="singerName" required placeholder="Enter your full name" autocomplete="off" aria-autocomplete="list" aria-controls="singerSuggestions" aria-expanded="false" value="${currentSinger ? escapeHtml(currentSinger.name) : ""}" data-verified-singer="${currentSinger ? escapeHtml(currentSinger.name) : ""}" data-verified-gender="${currentSinger && currentSinger.gender ? escapeHtml(currentSinger.gender) : ""}" ${currentSinger && !isAdminBool ? 'readonly style="background:rgba(241,245,249,0.7); cursor:not-allowed;"' : ""} />
                  <div id="singerSuggestions" class="bhajan-suggestions" role="listbox" aria-label="Singer suggestions"></div>
                </div>
                <datalist id="singerList"></datalist>
                ${
                  currentSinger && !isAdminBool
                    ? `<small style="color:#059669; font-size:11.5px; margin-top:5px; display:flex; align-items:center; gap:5px; font-weight:600;">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                        Verified: <strong>${escapeHtml(currentSinger.name)}</strong>
                      </small>`
                    : ""
                }
              </div>

              <div class="form-group">
                <label>Partner / Accompanist</label>
                <input type="text" list="singerList" name="partner_name" id="partnerName" placeholder="Optional" autocomplete="off" />
              </div>

              <div class="form-group">
                <label>Gender <span class="required" style="color:#e11d48;">*</span></label>
                <select name="gender" id="gender" required ${currentSinger && currentSinger.gender && !isAdminBool ? 'style="pointer-events:none; background:rgba(241,245,249,0.7);"' : ""}>
                  <option value="">Select Gender</option>
                  <option value="Male" ${currentSinger && currentSinger.gender === "Male" ? "selected" : ""}>Male</option>
                  <option value="Female" ${currentSinger && currentSinger.gender === "Female" ? "selected" : ""}>Female</option>
                  <option value="Other" ${currentSinger && currentSinger.gender === "Other" ? "selected" : ""}>Other</option>
                </select>
                <input type="hidden" name="locked_gender" id="lockedGender" value="${currentSinger && currentSinger.gender ? escapeHtml(currentSinger.gender) : ""}" />
              </div>
            </div>
          </div>

          <!-- Deity Slot Selection -->
          <div class="zen-glass-panel deity-choose-card">
            <h2 class="deity-choose-header">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="m12 8 4 4-4 4M8 12h8"/></svg>
              Choose Deity Slot <span class="required" style="color:#e11d48; font-size:16px;">*</span>
            </h2>
            <p class="deity-choose-subtitle">
              Tile color reflects submission count &bull; Tap an available tile to enter your bhajan &bull; Tap taken tile to view details
            </p>

            <div class="deity-grid ganesha-row">
              ${ganeshaCardHtml}
            </div>

            <div class="deity-grid other-deities-grid">
              ${otherDeitiesHtml}
            </div>

            <div class="deity-grid ganesha-row">
              ${hanumanCard}
            </div>

            <input type="hidden" name="deity" id="selectedDeity" />
          </div>

          <!-- Bhajan Details Form Card (Revealed on Deity Selection) -->
          <div class="zen-glass-panel bhajan-details-card" id="bhajanDetails">
            <h3 class="bhajan-details-heading">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#7d2f45" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
              <span>Bhajan Offering for <span id="deityDisplay" style="color:#d97706;">---</span></span>
            </h3>

            <div class="form-row form-row-title-speed">
              <div class="form-group form-group-title">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; flex-wrap:wrap; gap:6px;">
                  <label style="margin-bottom:0;">Bhajan Title <span class="required" style="color:#e11d48;">*</span></label>
                  ${
                    currentSinger
                      ? `<button type="button" id="openSongbookPickerBtn" class="pick-songbook-btn">
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
                          <span>Pick from My Songbook</span>
                        </button>`
                      : ""
                  }
                </div>

                <div class="bhajan-autocomplete">
                  <input type="hidden" name="master_bhajan_id" id="selectedMasterBhajanId" />
                  <input type="hidden" id="singerPreferredScale" value="${escapeHtml(currentSinger?.preferred_scale || "")}" />
                  <input name="title" id="bhajanTitleInput" required placeholder="Select Deity first to search master songbook..." autocomplete="off" aria-autocomplete="list" aria-controls="bhajanSuggestions" aria-expanded="false" />
                  <div id="bhajanSuggestions" class="bhajan-suggestions" role="listbox" aria-label="Bhajan suggestions"></div>
                </div>

                <div id="masterDataBadge" class="master-sync-badge" style="display:none;">
                  <div class="master-sync-badge-text">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="flex-shrink:0;"><polyline points="20 6 9 17 4 12"/></svg>
                    <span>Master DB Synced <span id="badgeDetails"></span></span>
                  </div>
                  <div class="master-sync-actions">
                    <span id="badgeSheetLink" style="display:none;">
                      <a href="#" id="sheetMusicLink" target="_blank" rel="noopener noreferrer" class="sheet-link-pill" title="Open official reference sheet music (PDF)">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                        <span>Music Sheet &nearr;</span>
                      </a>
                    </span>
                    <span id="badgeLyricsLink" style="display:none;">
                      <a href="#" id="lyricsPageLink" target="_blank" rel="noopener noreferrer" class="sheet-link-pill" title="Open sacred lyrics & singing guide">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
                        <span>Lyrics &nearr;</span>
                      </a>
                    </span>
                  </div>
                </div>

                <div id="cooldownWarning" style="display:none; color:#b91c1c; background:rgba(254,226,226,0.85); border:1px solid #fca5a5; padding:10px 14px; border-radius:10px; font-size:12.5px; margin-top:8px; font-weight:500;"></div>
              </div>

              <div class="form-group form-group-speed">
                <label>Speed / Tempo</label>
                <input type="text" name="speed" id="speedInput" readonly placeholder="Auto-filled..." class="input-readonly" style="background:rgba(241,245,249,0.7); cursor:not-allowed;" />
              </div>
            </div>

            <div class="form-row form-row-scale-raag">
              <div class="form-group form-group-scale">
                <label>Scale / Shruti</label>
                <div style="display:flex; gap:8px; align-items:center;">
                  <input type="text" name="scale" id="scaleInput" placeholder="e.g., 1.5P or C#" style="flex:1;" />
                  <button type="button" id="btnAuditionScale" class="audition-tanpura-btn" title="Sound this pitch in Tanpura" onclick="if(window.playTanpuraPitch){ window.playTanpuraPitch(document.getElementById('scaleInput').value); }">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>
                    <span>Sound Tanpura</span>
                  </button>
                </div>

                <div id="scaleSuggestionsContainer" style="margin-top:6px; display:flex; flex-direction:column; gap:4px;">
                  <div id="singerPrevScaleBadge" class="badge-scale-prev" style="display:none;">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                    <span><strong>Your Previous Scale:</strong> <span id="singerPrevScaleVal"></span></span>
                  </div>
                  <div id="genderCommonScaleBadge" class="badge-scale-common" style="display:none;">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                    <span><strong>Most Common <span id="genderCommonScaleLabel">Male</span> Scale:</strong> <span id="genderCommonScaleVal"></span></span>
                  </div>
                </div>
              </div>

              <div class="form-group form-group-raag">
                <label>Raag / Melody</label>
                <input type="text" name="raga" id="ragaInput" readonly placeholder="Auto-filled..." class="input-readonly" style="background:rgba(241,245,249,0.7); cursor:not-allowed;" />
              </div>
            </div>

            <input type="hidden" name="level" id="hiddenLevel" />
            <input type="hidden" name="language" id="hiddenLanguage" />

            <button type="button" id="preSubmitBtn" class="submit-slot-btn">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
              <span>Review &amp; Submit Offering</span>
            </button>
          </div>
        </form>

        <!-- 5. Registered Bhajan Sequence -->
        <section class="zen-glass-panel submitted-bhajans-card" aria-labelledby="submittedBhajansHeading">
          <div class="submitted-header">
            <h3 id="submittedBhajansHeading" class="submitted-title">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2"><line x1="8" x2="21" y1="6" y2="6"/><line x1="8" x2="21" y1="12" y2="12"/><line x1="8" x2="21" y1="18" y2="18"/><line x1="3" x2="3.01" y1="6" y2="6"/><line x1="3" x2="3.01" y1="12" y2="12"/><line x1="3" x2="3.01" y1="18" y2="18"/></svg>
              <span>Registered Bhajan Sequence (${submissionCount})</span>
            </h3>
            <p class="submitted-subtitle">
              ${submissionCount} bhajan${submissionCount === 1 ? "" : "s"} offered for this session. Please review the sequence to prevent duplicate selections.
            </p>
          </div>

          ${
            submissionCount > 0
              ? `
            <div class="table-glass-container">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Singer</th>
                    <th>Deity</th>
                    <th>Bhajan Title</th>
                    <th>Speed</th>
                    <th>Scale</th>
                  </tr>
                </thead>
                <tbody>${submissionRowsHtml}</tbody>
              </table>
            </div>
          `
              : `<div class="submitted-empty-state">
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#a8a29e" stroke-width="1.8" style="margin-bottom:8px;"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>
                  <div>No bhajans have been offered yet for this session. Select an available deity above to begin!</div>
                </div>`
          }
        </section>

      </div>
    </div>
  </div>


  <!-- Confirm & Submit Review Modal -->
  <div id="confirmSubmitModal" class="modal">
    <div class="modal-content">
      <div class="sheet-drag-handle" onclick="closeConfirmModal()"></div>
      <div class="modal-header">
        <h3 style="color:#15803d;">Review Your Offering</h3>
        <button class="close-btn" onclick="closeConfirmModal()">&times;</button>
      </div>
      <div class="detail-row">
        <div class="detail-label">Singer(s)</div>
        <div class="detail-value" id="modSinger">---</div>
      </div>
      <div class="detail-row">
        <div class="detail-label">Deity</div>
        <div class="detail-value" id="modDeity">---</div>
      </div>
      <div class="detail-row">
        <div class="detail-label">Bhajan</div>
        <div class="detail-value" id="modTitle">---</div>
      </div>
      <div class="detail-row">
        <div class="detail-label">Scale / Shruti</div>
        <div class="detail-value" id="modScale">---</div>
      </div>
      <div class="modal-actions-row">
        <button type="button" id="editBtn" class="button secondary btn-modal-edit">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
          <span>Modify</span>
        </button>
        <button type="button" id="confirmBtn" class="button button-confirm btn-modal-confirm">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
          <span>Confirm &amp; Offer</span>
        </button>
      </div>
    </div>
  </div>

  <!-- Must Select from Suggestions Warning Modal -->
  <div id="selectBhajanModal" class="modal">
    <div class="modal-content select-bhajan-modal-content">
      <div class="sheet-drag-handle" onclick="document.getElementById('selectBhajanModal').classList.remove('is-open')"></div>
      <div class="modal-music-icon" style="color:#d97706;">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>
      </div>
      <h3 class="modal-warning-title">
        Select Bhajan from Songbook
      </h3>
      <p class="modal-warning-text">
        Please select an authentic bhajan from the verified dropdown suggestions to ensure correct scale, tempo, and lyric alignment.
      </p>
      <div style="display:flex; justify-content:center;">
        <button type="button" id="closeSelectBhajanModalBtn" class="button button-select-dropdown">
          Select from Suggestions
        </button>
      </div>
    </div>
  </div>

  <!-- Songbook Picker Modal -->
  <div id="songbookPickerModal" class="modal">
    <div class="modal-content songbook-picker-sheet" style="max-width:540px; width:92%; max-height:85vh; display:flex; flex-direction:column; padding:24px;">
      <div class="sheet-drag-handle" onclick="document.getElementById('songbookPickerModal').classList.remove('is-open')"></div>
      <div class="modal-header" style="padding-bottom:12px; border-bottom:1px solid rgba(0,0,0,0.08);">
        <h3 style="color:#7c3aed; margin:0; display:flex; align-items:center; gap:8px;">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
          <span>Pick from My Songbook</span>
        </h3>
        <button class="close-btn" type="button" id="closeSongbookPickerBtn">&times;</button>
      </div>
      <p style="font-size:12.5px; color:#57534e; margin:10px 0 14px 0;">
        Choose one of your prepared bhajans. The slot, deity, and singing pitch will automatically pre-fill!
      </p>
      <div id="songbookPickerList" style="overflow-y:auto; flex:1; display:flex; flex-direction:column; gap:8px; padding-right:4px;">
        <div style="text-align:center; padding:20px; color:#78716c;">Loading your songbook...</div>
      </div>
    </div>
  </div>

  <!-- Taken Deity Slot Details Modal -->
  <div id="detailsModal" class="zen-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="modalDeityName" onclick="if(event.target===this)closeModal('detailsModal')">
    <div class="zen-glass-panel zen-modal-card">
      <div class="zen-modal-header">
        <h3 id="modalDeityName" class="zen-modal-title">Deity Slot Details</h3>
        <button type="button" class="close-btn" onclick="closeModal('detailsModal')" aria-label="Close">&times;</button>
      </div>
      <div class="zen-modal-body">
        <div class="detail-row">
          <span class="detail-label">Singer</span>
          <span class="detail-value" id="modalSinger">---</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Bhajan Title</span>
          <span class="detail-value" id="modalBhajan">---</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Scale / Shruti</span>
          <span class="detail-value" id="modalScale">---</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Speed / Tempo</span>
          <span class="detail-value" id="modalSpeed">---</span>
        </div>
      </div>
    </div>
  </div>

  ${appBottomNavHtml}
  ${getTanpuraWidgetHtml()}
  <script src="/js/tanpura.js?v=2.2"></script>
  <script src="/js/script.js?v=3.0"></script>
</body>
</html>`;
}

function generatePlanViewHtml(sessionDate, rowsHtml, whatsappText, whatsappEncoded, opts) {
  opts = opts || {};
  const {
    sessionDateHuman = sessionDate,
    timelineCardsHtml = "",
    dateOptionsList = [],
    submissionsCount = 0,
    isUpcoming = false,
    isAdmin = false,
    csrfToken = "",
    sessionAudio = null
  } = opts;

  const dateOptionsHtml = dateOptionsList
    .map(
      (opt) =>
        `<option value="${opt.date}"${opt.isCurrent ? " selected" : ""}>${escapeHtml(opt.label)}</option>`
    )
    .join("");

  const statusBadge = isUpcoming
    ? `<span class="plan-status-badge">🟢 Upcoming</span>`
    : `<span class="plan-status-badge" style="background:rgba(100,116,139,0.12); color:#475569; border-color:rgba(100,116,139,0.25);">📁 Past Session</span>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Live Plan – ${escapeHtml(sessionDateHuman)} | Bhajan Scheduler</title>
  <meta name="description" content="Live bhajan sequence plan for ${escapeHtml(sessionDateHuman)}. View singer order, deity, pitch scale and tempo for accompanists.">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="csrf-token" content="${escapeHtml(csrfToken)}" />
  <script>window.csrfToken = "${escapeHtml(csrfToken)}";</script>
  <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/css/style.css?v=5.3">
  <link rel="stylesheet" href="/css/session-audio.css">
  ${themeHeadScript}
</head>
<body class="embed-page in-iframe">
  ${themeToggleBtnHtml}

  <div class="plan-page-shell">

    <!-- ═══ UNIVERSAL SSSO GANDHINAGAR PRINT LETTERHEAD ═══ -->
    <div class="universal-print-letterhead" aria-hidden="true">
      <div class="letterhead-top-row">
        <div class="letterhead-logo-wrap">
          <img src="/images/logo.png" alt="Sri Sathya Sai Seva Organisation" class="letterhead-logo" />
        </div>
        <div class="letterhead-center-text">
          <div class="letterhead-invoc">|| AUM SRI SAI RAM ||</div>
          <div class="letterhead-org-title">SRI SATHYA SAI SEVA ORGANISATION, GANDHINAGAR</div>
          <div class="letterhead-samiti-address">Satyadeep, 20, Gayatri Society, Vasna Hadmatiya, Sargasan, Gandhinagar - 382015</div>
          <div class="letterhead-contact-line">Email: ssso.gandhinagar@gmail.com &bull; Helpline: +91 9265056242</div>
        </div>
        <div class="letterhead-spacer" aria-hidden="true"></div>
      </div>
      <div class="letterhead-divider">
        <div class="divider-primary"></div>
        <div class="divider-secondary"></div>
      </div>
    </div>

    <!-- Print Session Banner -->
    <div class="print-session-banner">
      <div class="print-banner-title">BHAJAN SCHEDULE &bull; ${escapeHtml(sessionDateHuman)}</div>
      <div class="print-banner-meta">Official Order of Offerings &bull; Total Scheduled Bhajans: ${submissionsCount}</div>
    </div>

    <!-- ═══ APP-FIRST PLAN HEADER ═══ -->
    <div class="plan-header-card no-print">
      <div class="plan-header-top">
        <div class="plan-title-group">
          <div class="plan-icon-bubble">📊</div>
          <div class="plan-header-titles">
            <h1>Live Bhajan Plan</h1>
            <p>
              <span>${escapeHtml(sessionDateHuman)}</span>
              &nbsp;·&nbsp;
              <strong>${submissionsCount}</strong> bhajan${submissionsCount !== 1 ? "s" : ""}
            </p>
          </div>
        </div>
        ${statusBadge}
      </div>

      <div class="plan-switcher-row">
        <form method="get" action="/plan-view" class="plan-date-select-wrap">
          <label style="font-size:13px; font-weight:600; white-space:nowrap; color:var(--ink-soft);">📅 Session:</label>
          <select name="session_date" class="plan-date-select" onchange="this.form.submit()" aria-label="Select bhajan session date">
            ${dateOptionsHtml}
          </select>
        </form>

        <div class="plan-actions-bar">
          ${
            isAdmin
              ? `
          <button id="planShareBtn" type="button" class="plan-btn plan-btn-whatsapp" onclick="sharePlan()" title="Share schedule via WhatsApp or native share">
            <span>📤</span> <span>Share</span>
          </button>`
              : ""
          }
          <button type="button" class="plan-btn plan-btn-secondary" onclick="printPlanSchedule()" title="Print as PDF or paper">
            <span>🖨️</span> <span>Print</span>
          </button>
          <div class="plan-view-tabs" id="planViewTabs">
            <button type="button" class="plan-view-tab active" id="tabTimeline" onclick="switchPlanView('timeline')">
              <span>📋</span> Timeline
            </button>
            <button type="button" class="plan-view-tab" id="tabTable" onclick="switchPlanView('table')">
              <span>📊</span> Table
            </button>
          </div>
        </div>
      </div>
    </div>

    ${sessionAudio && sessionAudio.audio_url ? `
    <!-- ═══ SESSION AUDIO BANNER ═══ -->
    <div class="session-audio-banner no-print">
      <div class="audio-banner-left">
        <div class="audio-banner-badge">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
        </div>
        <div class="audio-banner-info">
          <h3 class="audio-banner-title">${escapeHtml(sessionAudio.title || 'Session Recording')}</h3>
          <p class="audio-banner-sub">Session audio recording is ready. Play the full session or click timestamps next to individual bhajans below.</p>
        </div>
      </div>
      <button type="button" class="audio-banner-play-btn" data-start="0" data-title="${escapeHtml(sessionAudio.title || 'Session Recording')}" data-singer="${escapeHtml(sessionDateHuman)}" data-url="${escapeHtml(sessionAudio.audio_url)}" onclick="window.playSessionAudioBtn(this)">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        <span>Play Full Recording</span>
      </button>
    </div>` : ''}

    <!-- ═══ MOBILE TIMELINE VIEW ═══ -->
    <div class="plan-timeline active-view" id="planTimeline">
      ${timelineCardsHtml}
    </div>

    <!-- ═══ DESKTOP / PRINT TABLE VIEW ═══ -->
    <div class="plan-table-container" id="planTable">
      <table>
        <thead>
          <tr>
            <th width="4%">#</th>
            <th width="20%">Singer</th>
            <th width="28%">Bhajan</th>
            <th width="24%">Deity</th>
            <th width="13%">Pitch / Scale</th>
            <th width="11%">Tempo</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    </div>

    ${
      isAdmin
        ? `
    <!-- ═══ WHATSAPP SHARE CARD (Admin Only) ═══ -->
    <div class="plan-share-card no-print" id="planShareCard">
      <div class="plan-share-header">
        <div style="display:flex; align-items:center; gap:10px;">
          <span style="font-size:22px;">📱</span>
          <div>
            <div style="font-size:15px; font-weight:700; margin-bottom:2px;">Share to Samiti Group</div>
            <div style="font-size:12.5px; color:var(--ink-soft);">One-tap WhatsApp share or copy formatted schedule</div>
          </div>
        </div>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <button type="button" class="plan-btn plan-btn-whatsapp" onclick="sharePlan()" id="planShareBtnBottom">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg> <span>Share</span>
          </button>
          <button type="button" class="plan-btn plan-btn-secondary" onclick="copyPlanText()" id="planCopyBtn">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> <span>Copy</span>
          </button>
        </div>
      </div>
      <textarea id="planShareText" readonly class="plan-share-textarea" aria-label="Schedule text for WhatsApp">${whatsappText}</textarea>
    </div>`
        : ""
    }

    <!-- ═══ UNIVERSAL SSSO GANDHINAGAR PRINT FOOTER ═══ -->
    <div class="universal-print-footer" aria-hidden="true">
      <div class="print-footer-rule"></div>
      <div class="print-footer-quote">"Love All, Serve All &bull; Help Ever, Hurt Never"</div>
      <div class="print-footer-row">
        <div class="footer-center-text">Sri Sathya Sai Seva Organisation, Gandhinagar</div>
      </div>
    </div>

  </div><!-- /.plan-page-shell -->

  ${appBottomNavHtml}

  <script>
    // ─── PLAN VIEW SCRIPT ───────────────────────────────────────────
    const _WHATSAPP_ENCODED = ${JSON.stringify(whatsappEncoded)};
    const _WHATSAPP_TEXT = document.getElementById('planShareText') ? document.getElementById('planShareText').value : '';
    const _PLAN_DATE = ${JSON.stringify(sessionDate)};

    // Highlight active bottom nav tab
    (function() {
      var tabs = document.querySelectorAll('#appBottomNav .nav-tab');
      tabs.forEach(function(t) {
        var route = t.getAttribute('data-route') || '';
        if (window.location.pathname === route || (route === '/plan-view' && window.location.pathname.startsWith('/plan-view'))) {
          t.classList.add('active');
        }
      });
    })();

    // ─── View mode switcher (desktop) ───────────────────────────────
    function switchPlanView(mode) {
      var timeline = document.getElementById('planTimeline');
      var table = document.getElementById('planTable');
      var tabTl = document.getElementById('tabTimeline');
      var tabTb = document.getElementById('tabTable');
      if (mode === 'timeline') {
        if (timeline) {
          timeline.classList.add('active-view');
          timeline.style.setProperty('display', 'flex', 'important');
        }
        if (table) {
          table.classList.remove('active-view');
          table.style.setProperty('display', 'none', 'important');
        }
        if (tabTl) tabTl.classList.add('active');
        if (tabTb) tabTb.classList.remove('active');
      } else {
        if (table) {
          table.classList.add('active-view');
          table.style.setProperty('display', 'block', 'important');
        }
        if (timeline) {
          timeline.classList.remove('active-view');
          timeline.style.setProperty('display', 'none', 'important');
        }
        if (tabTb) tabTb.classList.add('active');
        if (tabTl) tabTl.classList.remove('active');
      }
      try { localStorage.setItem('plan_view_mode', mode); } catch(e) {}
    }

    // Print Plan helper: forces table mode before opening print dialog
    function printPlanSchedule() {
      switchPlanView('table');
      setTimeout(function() {
        window.print();
      }, 50);
    }
    window.addEventListener('beforeprint', function() {
      switchPlanView('table');
    });

    // Restore last view mode on desktop
    (function() {
      if (window.innerWidth > 768) {
        var saved = null;
        try { saved = localStorage.getItem('plan_view_mode'); } catch(e) {}
        if (saved === 'table') switchPlanView('table');
        else switchPlanView('timeline');
      }
    })();

    // Dynamic Admin sync: If admin logged out, immediately hide share controls
    function syncAdminRights() {
      try {
        var isLocalAdmin = localStorage.getItem('bp_is_admin') === 'true';
        var shareBtn = document.getElementById('planShareBtn');
        var shareCard = document.getElementById('planShareCard');
        if (!isLocalAdmin) {
          if (shareBtn) shareBtn.style.display = 'none';
          if (shareCard) shareCard.style.display = 'none';
        }
      } catch(_) {}
    }
    syncAdminRights();
    window.addEventListener('storage', function(e) {
      if (e.key === 'bp_is_admin') syncAdminRights();
    });
    window.addEventListener('focus', syncAdminRights);

    // ─── One-Tap WhatsApp Share (navigator.share + fallback) ─────────
    async function sharePlan() {
      var text = document.getElementById('planShareText') ? document.getElementById('planShareText').value : _WHATSAPP_TEXT;
      var url = window.location.href;
      var title = '🕉️ Live Bhajan Plan – ' + _PLAN_DATE;

      if (navigator.share) {
        try {
          await navigator.share({ title: title, text: text, url: url });
          return;
        } catch(e) {
          if (e.name === 'AbortError') return; // User cancelled
        }
      }
      // Fallback: open WhatsApp web link
      window.open('https://wa.me/?text=' + _WHATSAPP_ENCODED, '_blank', 'noopener');
    }

    // ─── Copy Schedule Text ─────────────────────────────────────────
    async function copyPlanText() {
      var text = document.getElementById('planShareText') ? document.getElementById('planShareText').value : '';
      var btn = document.getElementById('planCopyBtn');
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          var ta = document.getElementById('planShareText');
          ta.select();
          document.execCommand('copy');
        }
        if (btn) {
          var orig = btn.innerHTML;
          btn.innerHTML = '<span>✅</span> <span>Copied!</span>';
          btn.style.background = 'rgba(34,197,94,0.15)';
          btn.style.borderColor = 'rgba(34,197,94,0.4)';
          btn.style.color = '#16a34a';
          setTimeout(function() {
            btn.innerHTML = orig;
            btn.style.background = '';
            btn.style.borderColor = '';
            btn.style.color = '';
          }, 2000);
        }
      } catch(e) {
        alert('Copy failed. Please select and copy manually.');
      }
    }

    // ─── Lyrics Quick View ──────────────────────────────────────────
    function openPlanLyrics(bhajanId) {
      // Redirect to bhajan details page
      window.location.href = '/bhajan/' + bhajanId;
    }
  </script>

  <script src="/js/session-audio-player.js"></script>
  ${sessionAudio && sessionAudio.audio_url ? `
  <script>
    document.addEventListener('DOMContentLoaded', function() {
      if (window.SessionAudioPlayer) {
        window.SessionAudioPlayer.init(${JSON.stringify({
          id: sessionAudio.id,
          title: sessionAudio.title,
          audio_url: sessionAudio.audio_url,
          session_date: sessionAudio.session_date,
          timestamps: (sessionAudio.timestamps || []).map(t => ({
            id: t.id,
            submission_id: t.submission_id,
            bhajan_title: t.bhajan_title,
            singer_name: t.singer_name,
            deity: t.deity,
            start_seconds: t.start_seconds
          }))
        })});
      }
    });
  </script>` : ''}

  <script src="/js/script.js?v=2.10"></script>
</body>
</html>`;
}

function generateErrorHtml(deity, existing, session_date) {
  const safeDate = encodeURIComponent(session_date || "");
  return `<!DOCTYPE html><html><head><meta charset="utf-8" /><title>Slot Taken</title><meta name="viewport" content="width=device-width, initial-scale=1" /><link rel="stylesheet" href="/css/style.css">${themeHeadScript}</head><body>${themeToggleBtnHtml}<div class="container" style="text-align:center; padding:32px;"><div class="error-icon">⚠️</div><h2 style="color:#e03131;">Slot Already Taken</h2><p>Sorry, the <strong>${escapeHtml(deity)}</strong> deity slot has already been taken.</p><div class="info-box"><strong>Taken by:</strong> ${escapeHtml(existing.singer_name)}<br><strong>Bhajan:</strong> ${escapeHtml(existing.title)}<br><strong>Time:</strong> ${new Date(existing.created_at).toLocaleTimeString()}</div><a class="button" href="/submit-form?session_date=${safeDate}">← Go Back</a></div><script src="/js/script.js"></script></body></html>`;
}

function generateSuccessHtml(singer_name, deity, title, speed, scale, session_date, isAdmin) {
  const safeDate = encodeURIComponent(session_date || "");
  let actionButtons;
  if (isAdmin) {
    actionButtons = `
      <a class="button" href="/submit-form?admin=true&session_date=${safeDate}">➕ Append New Bhajan</a>
      <a class="button secondary" href="/admin/date/${safeDate}">⬅️ Back to List</a>
    `;
  } else {
    actionButtons = `
      <a class="button" href="/submit-form?session_date=${safeDate}">View Updated Slots</a>
      <a class="button secondary" href="/plan-view?session_date=${safeDate}">View Full Session Plan</a>
    `;
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8" /><title>Success</title><meta name="viewport" content="width=device-width, initial-scale=1" /><link rel="stylesheet" href="/css/style.css">${themeHeadScript}</head><body>${themeToggleBtnHtml}<div class="container" style="text-align:center; padding:32px;"><div class="success-icon">✅</div><h2 style="color:#2f9e44;">Bhajan Submitted!</h2><div style="font-size:20px; margin-bottom:24px;">🙏 Sai Ram, ${escapeHtml(singer_name)}!</div><div class="details-box" style="text-align:left;"><div><strong>Deity:</strong> ${escapeHtml(deity)}</div><div><strong>Bhajan:</strong> ${escapeHtml(title)}</div><div><strong>Speed:</strong> ${escapeHtml(speed)}</div><div><strong>Scale:</strong> ${escapeHtml(scale || "Not specified")}</div><div><strong>Session:</strong> ${escapeHtml(session_date)}</div></div><p>Your bhajan has been recorded.</p><div style="display:flex; flex-direction:column; gap:12px; margin-top:24px;">${actionButtons}</div></div><script src="/js/script.js"></script></body></html>`;
}

function generateDatePickerHtml(today) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8" /><title>Select Date</title><meta name="viewport" content="width=device-width, initial-scale=1" /><link rel="stylesheet" href="/css/style.css">${themeHeadScript}</head><body style="justify-content: center;">${themeToggleBtnHtml}<div class="container" style="max-width:480px; padding:24px;"><h2 style="text-align: center; margin-bottom: 16px;">🕉️ View Bhajan Plan</h2><form method="get" action="/plan-view"><label style="display:block; margin-bottom:8px;">Bhajan Date</label><input type="date" name="session_date" value="${escapeHtml(today)}" required style="width:100%; padding:12px; margin-bottom:16px;" /><button type="submit" class="button" style="width:100%;">Show Plan</button></form></div><script src="/js/script.js"></script></body></html>`;
}

function generateAdminSessionViewHtml(date, submissions, isLocked) {
  const rows = submissions
    .map(
      (s) => `
    <tr data-id="${s.id}" class="draggable-row" draggable="true" style="cursor: grab;">
      <td style="color:#adb5bd; cursor:grab; font-size:18px;" class="drag-handle" title="Drag to reorder">☰</td>
      <td data-label="Singer(s)"><strong>${escapeHtml(s.singer_name)}</strong>${s.partner_name ? `<br><small>& ${escapeHtml(s.partner_name)}</small>` : ""}</td>
      <td data-label="Gender">${escapeHtml(s.gender || "-")}</td>
      <td data-label="Deity"><span class="deity-pill">${escapeHtml(s.deity)}</span></td>
      <td data-label="Title">${escapeHtml(s.title)}</td>
      <td data-label="Tempo">${escapeHtml(s.speed || "-")}</td>
      <td data-label="Raag">${escapeHtml(s.raga || "-")}</td>
      <td data-label="Scale">${escapeHtml(s.scale || "-")}</td>
      <td data-label="Actions">
        <div style="display:flex; gap:8px; justify-content:flex-end;">
          <a href="/admin/edit/${s.id}" class="button" style="padding:6px 12px; font-size:13px; text-decoration:none;">Edit</a>
          <form action="/admin/delete/${s.id}" method="POST" onsubmit="return confirm('Delete this entry?');" style="margin:0;">
            <button type="submit" class="button" style="padding:6px 12px; font-size:13px; background:#e03131; border:none; color:white; cursor:pointer;">Del</button>
          </form>
        </div>
      </td>
    </tr>
  `
    )
    .join("");

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Admin - Session Details</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="stylesheet" href="/css/style.css">
</head>
<body>
  <div class="container container-xl">
    <div class="header">
      <h1>🛠️ Session Details</h1>
      <p>Date: ${date}</p>
      ${isLocked ? `<span style="background:#e03131; color:white; padding:4px 12px; border-radius:12px; font-size:12px; font-weight:bold; margin-top:10px; display:inline-block;">🔒 SESSION LOCKED</span>` : ""}
    </div>
    
    <div style="margin-bottom: 24px; display:flex; gap:12px; flex-wrap:wrap; justify-content:center;">
      <a href="/admin" class="button secondary">⬅️ Back to Calendar</a>
      <a href="/submit-form?admin=true&session_date=${date}" class="button">➕ Add / Append to this Date</a>
      <a href="/admin/rules?date=${date}" class="button secondary">⚙️ Session Rules</a>
      <button onclick="toggleSessionLock('${date}', ${!isLocked})" class="button" style="background:${isLocked ? "#28a745" : "#e03131"}; border:none;">${isLocked ? "🔓 Unlock Submissions" : "🔒 Lock Submissions"}</button>
      <a href="/plan-view" class="button secondary">📅 View Plans</a>
      <a href="/admin" class="button secondary">🏠 Dashboard</a>
    </div>
    
    <div style="background:#fff3cd; border:1px solid #ffe066; padding:15px; border-radius:12px; margin-bottom:20px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
      <div>
        <strong>↕️ Reorder Sequence:</strong> Drag and drop the ☰ handle on rows to arrange the musical sequence.
      </div>
      <button id="saveOrderBtn" class="button" style="background:#28a745; border:none; display:none;" onclick="saveReorderSequence()">💾 Save New Sequence</button>
    </div>

    <div class="table-container">
      <table>
        <thead>
          <tr>
            <th width="30"></th>
            <th>Singer(s)</th>
            <th>Gender</th>
            <th>Deity</th>
            <th>Title</th>
            <th>Tempo</th>
            <th>Raag</th>
            <th>Scale</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody id="sortable-body">
          ${rows.length > 0 ? rows : '<tr><td colspan="9" style="padding:20px; text-align:center;">No records found for this date.</td></tr>'}
        </tbody>
      </table>
    </div>
    
    <div style="margin-top:40px; background:#f8f9fa; padding:20px; border-radius:12px; border:1px solid #dee2e6;">
      <h3 style="margin-bottom:10px; color:#495057;">🔄 Copy Previous Session</h3>
      <p style="font-size:13px; color:#6c757d; margin-bottom:15px;">Duplicate the singer lineup from a past session directly into this date.</p>
      <form action="/admin/copy-session" method="POST" style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
        <input type="hidden" name="target_date" value="${date}">
        <input type="date" name="source_date" required class="filter-input" style="max-width:200px;">
        <button type="submit" class="button secondary" onclick="return confirm('Copy all entries? This will append to the current list.')">Copy Lineup</button>
      </form>
    </div>
  </div>
  <script src="/js/script.js"></script>
</body>
</html>`;
}

function generateAdminCalendarHtml(
  year,
  month,
  eventCounts,
  permissionMap = {},
  descriptionMap = {},
  missingBhajans = []
) {
  const monthNames = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December"
  ];
  const currentMonthName = monthNames[month - 1];

  // Calendar Logic
  const daysInMonth = new Date(year, month, 0).getDate();
  const firstDayIndex = new Date(year, month - 1, 1).getDay(); // 0 = Sunday

  let calendarCells = "";

  // Empty cells for previous month
  for (let i = 0; i < firstDayIndex; i++) {
    calendarCells += `<div class="calendar-day empty"></div>`;
  }

  // Days
  const today = new Date();
  const isCurrentMonth = today.getFullYear() === year && today.getMonth() + 1 === month;

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const count = eventCounts[dateStr] || 0;
    const perm = permissionMap[dateStr];
    const desc = descriptionMap[dateStr] || "";

    // Determine Color Logic
    const dateObj = new Date(year, month - 1, day);
    const dayOfWeek = dateObj.getDay(); // 0=Sun, 4=Thu
    const isToday = isCurrentMonth && today.getDate() === day;

    let colorClass = "day-none";

    if (perm === "special") {
      colorClass = "day-special";
    } else if (perm === "festival") {
      colorClass = "day-festival-perm";
    } else if (dayOfWeek === 4) {
      colorClass = "day-thursday";
    } else if (count > 0) {
      colorClass = "day-festival";
    }

    const dayClass = `calendar-day ${colorClass} ${isToday ? "today" : ""}`;

    // Changed from <a> to <div onclick> for popup
    calendarCells += `
      <div class="${dayClass}" onclick="openAdminDateModal('${dateStr}', '${perm || ""}', '${desc.replace(/'/g, "&apos;")}')" style="cursor:pointer;">
        <div class="calendar-date-num">${day}</div>
        <div class="calendar-actions">
          ${count > 0 ? `<div class="event-pill">${count} Bhajans</div>` : ""}
          ${perm ? `<div class="perm-pill">${perm.toUpperCase()}</div>` : ""}
        </div>
      </div>
    `;
  }

  // Navigation
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Admin Calendar</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="stylesheet" href="/css/style.css">
</head>
<body>
  <div class="container container-xl">
    <div class="header">
      <h1>🗓️ Admin Calendar</h1>
      <p>Manage Sessions</p>
    </div>
    
    <div style="margin-bottom: 20px; display:flex; gap:10px; flex-wrap:wrap;">
      <a href="/admin" class="button secondary">🏠 Dashboard</a>
      <a href="/submit-form?admin=true" class="button secondary">➕ New Entry (Any Date)</a>
      <a href="/admin/rules" class="button secondary">⚙️ Default Deity Rules</a>
      <a href="/admin/singers" class="button secondary" style="background:#e6fcf5; color:#099268; border-color:#c3fae8;">👤 Singer Directory</a>
      <a href="/admin/singer-dictionary" class="button secondary" style="background:#e3f2fd; color:#0277bd; border-color:#90caf9;">📖 Singer Dictionary</a>
      <a href="/master-bank" class="button secondary" style="background:#fff3cd; color:#e67700; border-color:#ffe066;">📚 Edit Master Bank</a>
      <a href="/admin/import-sessions" class="button secondary" style="background:#e8f5e9; color:#2e7d32; border-color:#c8e6c9;">📥 Import Past Sessions</a>
      <a href="/admin/analytics" class="button secondary" style="background:#f3f0ff; color:#6741d9; border-color:#e5dbff;">📈 Analytics</a>
    </div>

    <div class="calendar-header">
      <a href="/admin?month=${prevMonth}&year=${prevYear}" class="calendar-nav-btn">←</a>
      <div class="calendar-title">${currentMonthName} ${year}</div>
      <a href="/admin?month=${nextMonth}&year=${nextYear}" class="calendar-nav-btn">→</a>
    </div>

    <div class="calendar-legend">
      <div class="legend-item"><span class="legend-color day-none"></span> No Bhajans</div>
      <div class="legend-item"><span class="legend-color day-thursday"></span> Thursday</div>
      <div class="legend-item"><span class="legend-color day-special"></span> Special</div>
      <div class="legend-item"><span class="legend-color day-festival-perm"></span> Festival</div>
    </div>

    <div class="calendar-grid">
      <div class="calendar-day-header">Sun</div><div class="calendar-day-header">Mon</div><div class="calendar-day-header">Tue</div>
      <div class="calendar-day-header">Wed</div><div class="calendar-day-header">Thu</div><div class="calendar-day-header">Fri</div>
      <div class="calendar-day-header">Sat</div>
      ${calendarCells}
    </div>

    <!-- Missing Bhajan Catcher -->
    <div class="admin-section" style="margin-top: 40px; padding: 20px; background: #fff3cd; border-radius: 12px; border: 1px solid #ffe066;">
      <h2 style="color: #d9480f; margin-bottom: 15px;">🚨 Missing Bhajan Catcher</h2>
      <p style="font-size:14px; margin-bottom:15px; color:#555;">The following bhajans have been sung in sessions but are missing from the Master Database.</p>
      <ul style="list-style:none; padding:0; display:flex; flex-direction:column; gap:10px;">
        ${
          missingBhajans.length === 0
            ? '<li style="color:#2b8a3e; font-weight:bold;">✅ All sung bhajans are safely in the Master Database!</li>'
            : missingBhajans
                .map(
                  (b) => `
          <li style="display:flex; justify-content:space-between; align-items:center; background:#fff; padding:10px 15px; border-radius:8px; border:1px solid #ffd43b;">
            <strong>${b}</strong>
            <button class="button" style="padding:6px 12px; font-size:12px; background:#4dabf7; border:none;" onclick="openMissingBhajanModal('${b.replace(/'/g, "\\'")}')">➕ Add to Master</button>
          </li>
        `
                )
                .join("")
        }
      </ul>
    </div>

  </div>

  <!-- Admin Date Modal -->
  <div id="adminDateModal" class="modal">
    <div class="modal-content" style="text-align:center; max-width:350px;">
      <div class="modal-header">
        <h3 id="adminModalDate">Manage Date</h3>
        <button class="close-btn" onclick="closeAdminModal()">&times;</button>
      </div>
      <div style="margin-bottom:15px; text-align:left;">
        <label style="display:block; margin-bottom:5px; font-size:12px; font-weight:600; color:#495057;">Description <span style="color:#e03131;">*</span></label>
        <input type="text" id="permDescription" placeholder="Reason (e.g. Mahashivratri)" maxlength="100" style="width:100%; padding:10px; border:1px solid #dee2e6; border-radius:8px; font-family:inherit;">
      </div>
      <div style="display:grid; gap:12px;">
        <button onclick="updatePermission('special')" class="button" style="background:#4dabf7; border:none;">✨ Add Special Bhajan</button>
        <button onclick="updatePermission('festival')" class="button" style="background:#ff922b; border:none;">🪔 Add Festival Bhajan</button>
        <button onclick="updatePermission('clear')" class="button secondary">❌ Clear Permission</button>
        <hr style="width:100%; border:0; border-top:1px solid #eee; margin:8px 0;">
        <button onclick="viewAdminDate()" class="button secondary">📅 View / Edit Plan</button>
      </div>
    </div>
  </div>

  <!-- Missing Bhajan Catcher Modal -->
  <div id="missingBhajanModal" class="modal">
    <div class="modal-content" style="max-width: 400px; text-align:left;">
      <div class="modal-header">
        <h3>Add to Master Database</h3>
        <button class="close-btn" onclick="closeMissingBhajanModal()">&times;</button>
      </div>
      <div style="display:flex; flex-direction:column; gap:12px; margin-top:15px;">
        <div><label style="font-size:12px; font-weight:600; color:#495057;">Title</label>
          <input type="text" id="mbTitle" readonly style="width:100%; padding:8px; border:1px solid #ddd; background:#f5f5f5; border-radius:4px;"></div>
        <div><label style="font-size:12px; font-weight:600; color:#495057;">Deity</label>
          <select id="mbDeity" style="width:100%; padding:8px; border:1px solid #ddd; border-radius:4px;">
            <option value="Ganesha">Ganesha</option><option value="Guru">Guru</option><option value="Mata">Mata</option><option value="SarvaDharma">SarvaDharma</option><option value="Sai">Sai</option><option value="Shiva">Shiva</option><option value="Krishna">Krishna</option><option value="Rama">Rama</option><option value="Narayana">Narayana</option><option value="Vitthala">Vitthala</option><option value="Hanuman">Hanuman</option>
          </select></div>
        <div><label style="font-size:12px; font-weight:600; color:#495057;">Tempo (Speed)</label>
          <select id="mbTempo" style="width:100%; padding:8px; border:1px solid #ddd; border-radius:4px;">
            <option value="Slow">Slow</option><option value="Medium">Medium</option><option value="Fast">Fast</option>
          </select></div>
        <div><label style="font-size:12px; font-weight:600; color:#495057;">Raga</label>
          <input type="text" id="mbRaga" placeholder="e.g., Yaman Kalyani" style="width:100%; padding:8px; border:1px solid #ddd; border-radius:4px;"></div>
        <div><label style="font-size:12px; font-weight:600; color:#495057;">Shruti ( padding:8px; border:1px solid #ddd; border-radius:4px;"></div>
        <div><label style="font-size:12px; font-weight:600; color:#495057;">Shruti (Female Scale)</label>
          <input type="text" id="mbShrutiFemale" placeholder="e.g., G#" style="width:100%; padding:8px; border:1px solid #ddd; border-radius:4px;"></div>
        <div><label style="font-size:12px; font-weight:600; color:#495057;">Level</label>
          <select id="mbLevel" style="width:100%; padding:8px; border:1px solid #ddd; border-radius:4px;">
            <option value="">Unknown</option><option value="Easy">Easy</option><option value="Medium">Medium</option><option value="Advanced">Advanced</option>
          </select></div>
        <button class="button" onclick="saveMissingBhajan()" style="margin-top:10px; background:#28a745; border:none;">Save to Master DB</button>
      </div>
    </div>
  </div>
  <script src="/js/script.js"></script>
</body>
</html>`;
}

function generateEditFormHtml(s) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8" /><title>Edit Bhajan</title><meta name="viewport" content="width=device-width, initial-scale=1" /><link rel="stylesheet" href="/css/style.css"><link rel="stylesheet" href="/css/admin.css"></head><body class="admin-page">
  <div class="admin-layout">
    <div class="main-content">
    <div class="container">
    <div style="margin-bottom:20px; display:flex; gap:10px; align-items:center;">
      <a href="/admin/date/${s.session_date}" class="button secondary">⬅️ Back to Session</a>
      <a href="/admin" class="button secondary">🏠 Dashboard</a>
    </div>
    <h2>✏️ Edit Bhajan Entry</h2>
    <form method="post" action="/admin/edit/${s.id}">
      <div class="form-row">
        <div class="form-group"><label>Session Date</label><input type="date" name="session_date" value="${s.session_date}" required /></div>
        <div class="form-group"><label>Deity</label><input type="text" name="deity" value="${s.deity}" required /></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>Singer Name</label><input type="text" name="singer_name" value="${escapeHtml(s.singer_name)}" required /></div>
        <div class="form-group"><label>Partner</label><input type="text" name="partner_name" value="${escapeHtml(s.partner_name || "")}" /></div>
      </div>
      <div class="form-group"><label>Title</label><input type="text" name="title" value="${escapeHtml(s.title)}" required /></div>
      <div class="form-row">
        <div class="form-group"><label>Scale</label><input type="text" name="scale" value="${escapeHtml(s.scale || "")}" /></div>
        <div class="form-group"><label>Speed</label>
          <select name="speed" required>
            <option value="slow" ${s.speed === "slow" ? "selected" : ""}>Slow</option>
            <option value="medium" ${s.speed === "medium" ? "selected" : ""}>Medium</option>
            <option value="fast" ${s.speed === "fast" ? "selected" : ""}>Fast</option>
          </select>
        </div>
        <div class="form-group"><label>🎼 Raag</label><input type="text" name="raga" value="${escapeHtml(s.raga || "")}" placeholder="e.g. Yaman Kalyani" /></div>
      </div>
      <div style="margin-top:20px; display:flex; gap:10px;"><button type="submit" class="button">Save Changes</button><a href="/admin/date/${s.session_date}" class="button secondary">Cancel</a></div>
    </form>
    </div>
    </div>
  </div>
  <script src="/js/script.js"></script>
</body></html>`;
}

function generateAdminRulesHtml(rules, date) {
  const title = date === "default" ? "⚙️ Default Deity Rules" : `⚙️ Rules for ${date}`;
  const subtitle =
    date === "default"
      ? "Set base limits for all future sessions"
      : "Set custom limits for this specific session";

  const rows = rules
    .map(
      (r) => `
    <tr>
      <td>
        <strong>${r.deity_name}</strong>
        <input type="hidden" class="rule-deity" value="${r.deity_name}">
      </td>
      <td><input type="number" class="rule-min filter-input" value="${r.min_required}" min="0" max="9" style="width:80px; text-align:center;"></td>
      <td><input type="number" class="rule-max filter-input" value="${r.max_allowed}" min="0" max="99" style="width:80px; text-align:center;"></td>
    </tr>
  `
    )
    .join("");

  return `<!DOCTYPE html><html><head><meta charset="utf-8" /><title>Manage Deity Rules</title><meta name="viewport" content="width=device-width, initial-scale=1" /><link href="https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700&display=swap" rel="stylesheet"><link rel="stylesheet" href="/css/style.css"></head><body>
  <div class="container container-lg">
    <div class="header">
      <h1>${title}</h1>
      <p>${subtitle}</p>
    </div>
    <div style="margin-bottom: 20px;">
      <a href="${date === "default" ? "/admin" : `/admin/date/${date}`}" class="button secondary">⬅️ Go Back</a>
    </div>
    <input type="hidden" id="ruleDate" value="${date}">
    <div class="table-container">
      <table id="rulesTable">
        <thead>
          <tr>
            <th>Deity</th>
            <th>Min Required</th>
            <th>Max Allowed <br><small style="font-weight:normal">(0 = Blocked)</small></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div style="margin-top:20px; text-align:right;">
      <button class="button" onclick="saveDeityRules()" style="background:#28a745; border:none;">💾 Save Rules</button>
    </div>
  </div><script src="/js/script.js"></script></body></html>`;
}

function generateAdminImportSessionsHtml(resultInfo = null) {
  let resultBanner = "";
  if (resultInfo) {
    if (resultInfo.error) {
      resultBanner = `
        <div style="background:#ffebee; border:1px solid #ffcdd2; color:#c62828; padding:16px; border-radius:12px; margin-bottom:24px;">
          <strong>❌ Error importing sessions:</strong> ${escapeHtml(resultInfo.error)}
        </div>
      `;
    } else {
      const sessionList = (resultInfo.sessionSummary || [])
        .map((s) => `<li>📅 <strong>${s.date}</strong>: ${s.count} bhajans</li>`)
        .join("");
      resultBanner = `
        <div style="background:#e8f5e9; border:1px solid #c8e6c9; color:#2e7d32; padding:18px; border-radius:12px; margin-bottom:24px;">
          <h3 style="margin:0 0 8px 0; color:#1b5e20;">🎉 Import Successful!</h3>
          <p style="margin:0 0 10px 0;">Successfully processed <strong>${resultInfo.totalSessions} session(s)</strong> and <strong>${resultInfo.totalBhajans} bhajan(s)</strong>.</p>
          <ul style="margin:0; padding-left:20px; font-size:14px;">${sessionList}</ul>
          <div style="margin-top:14px;">
            <a href="/database" class="button" style="padding:6px 16px; font-size:13px; text-decoration:none;">🗃️ View in History</a>
          </div>
        </div>
      `;
    }
  }

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Admin - Import Past Sessions</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/css/style.css">
</head>
<body>
  <div class="container container-xl">
    <div class="header">
      <h1>📥 Import Past Sessions</h1>
      <p>Bulk add historical bhajan records into the database</p>
    </div>
    
    <div style="margin-bottom: 24px; display:flex; gap:10px; flex-wrap:wrap;">
      <a href="/admin" class="button secondary">🏠 Dashboard</a>
      <a href="/database" class="button secondary">🗃️ View History</a>
      <a href="/plan-view" class="button secondary">📅 View Plans</a>
    </div>

    ${resultBanner}

    <div style="background:#fff; border:1px solid var(--border); border-radius:var(--radius); padding:24px; margin-bottom:24px;">
      <form action="/admin/import-sessions" method="POST">
        <div style="margin-bottom:16px;">
          <label style="display:block; font-weight:700; font-size:15px; margin-bottom:8px; color:#343a40;">
            📋 Paste Session Text / WhatsApp Plan Data below:
          </label>
          <textarea name="raw_text" required rows="14" placeholder="Paste your past session text here...&#10;&#10;Example 1:&#10;23/07/2026&#10;1. Gajanana Gajanana, Prathama Poojana — A#&#10;2. Jaya Kailash Patey Shiva Shankara — C#&#10;&#10;Example 2:&#10;Bhajan Plan – 2026-07-30&#10;1) Nisarg Chaudhari – [Ganesha] Prathama Vandana Gowri Nandana – Scale: 2.5P, Speed: Slow" style="width:100%; padding:14px; border:1px solid #ced4da; border-radius:8px; font-family:monospace; font-size:13.5px; line-height:1.5; resize:vertical; background:#f8f9fa;"></textarea>
        </div>

        <button type="submit" class="button" style="background:#28a745; border:none; padding:12px 28px; font-weight:700; font-size:15px; cursor:pointer;">
          🚀 Import Sessions to Database
        </button>
      </form>
    </div>

    <div style="background:#f1f3f5; border:1px solid #dee2e6; border-radius:var(--radius); padding:20px;">
      <h3 style="margin-top:0; color:#343a40; font-size:16px;">💡 Supported Format Examples</h3>
      <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap:16px; margin-top:12px;">
        <div style="background:#fff; padding:14px; border-radius:8px; border:1px solid #e9ecef;">
          <strong style="color:#e65100;">Format 1: Plain Text</strong>
          <pre style="margin:8px 0 0 0; font-size:12px; color:#495057;">23/07/2026
1. Bhajan Title — Scale
2. Singer Name: Bhajan Title — Scale</pre>
        </div>
        <div style="background:#fff; padding:14px; border-radius:8px; border:1px solid #e9ecef;">
          <strong style="color:#e65100;">Format 2: WhatsApp Plan View</strong>
          <pre style="margin:8px 0 0 0; font-size:12px; color:#495057;">Bhajan Plan – 2026-07-30
1) Singer (Partner) – [Deity] Title – Scale: 2.5P, Speed: Slow</pre>
        </div>
      </div>
    </div>
  </div>
  <script src="/js/script.js"></script>
</body>
</html>`;
}

module.exports = {
  escapeHtml,
  generateSubmitFormHtml,
  generatePlanViewHtml,
  generateErrorHtml,
  generateSuccessHtml,
  generateDatePickerHtml,
  generateEditFormHtml,
  generateAdminCalendarHtml,
  generateAdminSessionViewHtml,
  generateAdminRulesHtml,
  generateAdminImportSessionsHtml
};
