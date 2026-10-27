const path = require("path");
const { Sequelize } = require("sequelize");
const sequelize = require("../config/database");

const BhajanSubmission = require("../models/BhajanSubmission");
const SessionPermission = require("../models/SessionPermission");
const SessionMeta = require("../models/SessionMeta");
const DeityRule = require("../models/DeityRule");
const Singer = require("../models/Singer");
const MasterBhajan = require("../models/MasterBhajan");
const SessionAudio = require("../models/SessionAudio");
const SessionAudioTimestamp = require("../models/SessionAudioTimestamp");

const {
  getNextThursday,
  getThursdaySubmissionStatus,
  getLocalDateStr,
  deityOrderKey,
  SPEED_ORDER,
  normalizeName,
  formatDateHuman,
  getWesternScale,
  getDeityIcon,
  getNumberEmoji,
  isSessionActiveOrUpcoming
} = require("../services/helpers");
const { DEITY_ALIASES, DEITY_TITLE_MATCHERS } = require("../config/constants");

const {
  generateSubmitFormHtml,
  generateErrorHtml,
  generatePlanViewHtml,
  generateDatePickerHtml,
  escapeHtml
} = require("../templates");

const { generateToken } = require("../middleware/csrfProtection");

const {
  normalizeBhajanTitle,
  getAvailableDates,
  buildDeityStatus,
  generateDeityCardsHtml,
  renderSelectionScreenHtml
} = require("../services/plannerService");

exports.showSubmitForm = async (req, res) => {
  try {
    const isAdmin = Boolean(req.session && req.session.admin);

    // Devotees must be logged in as a singer to submit bhajans
    if (!isAdmin && (!req.session || !req.session.singer)) {
      const { safeRedirect } = require("../services/securityHelpers");
      const returnTo = encodeURIComponent(safeRedirect(req.originalUrl, "/submit-form"));
      const embedParam = req.query._embed === "1" ? "&_embed=1" : "";
      return res.redirect(`/singer/login?redirect=${returnTo}${embedParam}`);
    }

    const showSuccess = req.query.success === "true";
    let sessionDate = req.query.session_date;

    const { dates: availableDates, status: thuStatus } = await getAvailableDates();

    if (!sessionDate) {
      if (!isAdmin && thuStatus.opensAt8pmToday && process.env.NODE_ENV !== "test") {
        const msg = `Today's Thursday session is locked.<br>Submissions for next Thursday (<strong>${thuStatus.nextThursdayDate}</strong>) will open today at 8:00 PM.`;
        if (availableDates.size > 0) {
          return res.send(
            renderSelectionScreenHtml(
              `${msg}<br><br>You can submit for available Special/Festival sessions below:`,
              availableDates,
              isAdmin
            )
          );
        } else {
          const homeUrl = isAdmin ? "/admin" : "/";
          const homeText = isAdmin ? "🏠 Return to Dashboard" : "🏠 Return Home";
          const themeHeadScript = `<script>(function(){try{var t=localStorage.getItem('bp-theme');if(t==='dark')document.documentElement.setAttribute('data-theme','dark');}catch(e){}})();</script>`;
          const themeToggleBtn = `<button class="theme-toggle" id="themeToggle" aria-label="Toggle dark mode" aria-pressed="false" data-tooltip="Switch to Dark"><span class="icon-moon">&#127769;</span><span class="icon-sun">&#9728;&#65039;</span></button>`;
          return res.send(
            `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Submissions Opening at 8:00 PM</title><meta name="viewport" content="width=device-width, initial-scale=1" /><link rel="stylesheet" href="/css/style.css">${themeHeadScript}</head><body>${themeToggleBtn}<div class="container" style="text-align:center; padding:40px; max-width:500px;"><h2 style="color:var(--saffron); margin-bottom:20px;">🔒 Submissions Opening at 8:00 PM</h2><p style="color:var(--ink-soft); margin-bottom:25px; line-height:1.6;">${msg}</p><div><a href="${homeUrl}" class="button secondary">${homeText}</a></div></div><script src="/js/script.js"></script></body></html>`
          );
        }
      }

      if (availableDates.size > 1) {
        return res.send(
          renderSelectionScreenHtml(
            "Please select a session to submit your bhajan:",
            availableDates,
            isAdmin
          )
        );
      }
      sessionDate = thuStatus.openThursday || thuStatus.nextThursdayDate;
    }

    const todayStr = getLocalDateStr();
    const isPastOrToday = todayStr >= sessionDate;
    const meta = await SessionMeta.findByPk(sessionDate);
    const isManuallyLocked = meta && meta.is_locked;
    const isNextThuUnopened =
      !isAdmin &&
      sessionDate === thuStatus.nextThursdayDate &&
      thuStatus.opensAt8pmToday &&
      process.env.NODE_ENV !== "test";

    if (!isAdmin && (isManuallyLocked || isPastOrToday)) {
      // Session has already locked and moved — redirect directly to history tab
      return res.redirect("/database");
    }

    if (!isAdmin && isNextThuUnopened) {
      const reasonMsg = `Submissions for next Thursday (<strong>${sessionDate}</strong>) will open today at 8:00 PM.`;
      return res.send(
        renderSelectionScreenHtml(
          `${reasonMsg}<br>Please select an available upcoming session:`,
          availableDates,
          isAdmin
        )
      );
    }

    // Check Permissions: Allow if Thursday OR Admin OR Explicitly Permitted
    const [sYear, sMonth, sDay] = sessionDate.split("-").map(Number);
    const dayOfWeek = new Date(sYear, sMonth - 1, sDay).getDay();
    const isThursday = dayOfWeek === 4;
    const permission = await SessionPermission.findByPk(sessionDate);

    if (!isAdmin && !isThursday && !permission) {
      return res.send(
        renderSelectionScreenHtml(
          `Bhajan submission for <strong>${sessionDate}</strong> is not enabled.<br>Please select an available session:`,
          availableDates,
          isAdmin
        )
      );
    }

    // Load rules specifically for this session
    let rules = await DeityRule.findAll({ where: { session_date: sessionDate } });
    if (rules.length === 0) rules = await DeityRule.findAll({ where: { session_date: "default" } });

    // Fetch existing submissions
    const results = await BhajanSubmission.findAll({
      where: { session_date: sessionDate }
    });

    const { deityStatus, mandatoryFilled, totalMandatory, optionalFilled, totalOptional } =
      buildDeityStatus(rules, results);

    const { ganeshaCardHtml, otherDeitiesHtml, hanumanCard } = generateDeityCardsHtml(deityStatus);

    // Send HTML response
    const submissionRowsHtml = results
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      .map(
        (submission, index) => `
        <tr>
          <td>${index + 1}</td>
          <td>${escapeHtml(submission.singer_name)}</td>
          <td>${escapeHtml(submission.deity)}</td>
          <td>${escapeHtml(submission.title)}</td>
          <td>${escapeHtml(submission.speed || "Not specified")}</td>
          <td>${escapeHtml(submission.scale || "Not specified")}</td>
        </tr>
      `
      )
      .join("");

    const csrfToken =
      res.locals.csrfToken ||
      (typeof req.csrfToken === "function" ? req.csrfToken() : generateToken(req, res));

    res.send(
      generateSubmitFormHtml(
        sessionDate,
        mandatoryFilled,
        totalMandatory,
        optionalFilled,
        totalOptional,
        ganeshaCardHtml,
        otherDeitiesHtml,
        hanumanCard,
        isAdmin,
        showSuccess,
        submissionRowsHtml,
        results.length,
        req.session?.singer,
        csrfToken
      )
    );
  } catch (error) {
    console.error(`[Req ${req.id || ""}] showSubmitForm error:`, error);
    res
      .status(500)
      .send(`<h1>Error</h1><p>An unexpected error occurred loading the submission form.</p>`);
  }
};

exports.submitForm = async (req, res) => {
  const isAdmin = Boolean(req.session && req.session.admin);
  try {
    const {
      session_date,
      singer_name,
      gender,
      locked_gender,
      partner_name,
      deity,
      title,
      speed,
      scale,
      raga,
      level,
      language,
      admin,
      master_bhajan_id
    } = req.body;

    if (!isAdmin && (!req.session || !req.session.singer)) {
      const embedParam = req.query._embed === "1" ? "&_embed=1" : "";
      return res.redirect(`/singer/login?redirect=${encodeURIComponent("/submit-form")}${embedParam}`);
    }

    // For devotees, strictly enforce their verified singer name; non-admins can never set a different name
    const effectiveSingerName =
      !isAdmin && req.session?.singer ? req.session.singer.name.trim() : (singer_name || "").trim();
    const effectiveGender =
      !isAdmin && req.session?.singer && req.session.singer.gender
        ? req.session.singer.gender
        : locked_gender || gender;

    if (!session_date || !effectiveSingerName || !deity || !title) {
      return res
        .status(400)
        .send(
          '<h1>Error</h1><p>Missing required fields.</p><a class="button" href="javascript:history.back()">Go Back</a>'
        );
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(session_date)) {
      return res
        .status(400)
        .send(
          '<h1>Error</h1><p>Invalid session date format.</p><a class="button" href="javascript:history.back()">Go Back</a>'
        );
    }

    const VALID_DEITIES = [
      "Ganesha",
      "Guru",
      "Mata",
      "SarvaDharma",
      "Sai",
      "Shiva",
      "Krishna",
      "Rama",
      "Narayana",
      "Vitthala",
      "Hanuman"
    ];
    if (!VALID_DEITIES.includes(deity)) {
      return res
        .status(400)
        .send(
          '<h1>Error</h1><p>Invalid deity category.</p><a class="button" href="javascript:history.back()">Go Back</a>'
        );
    }

    // Dropdown selection enforcement: Must be selected from the master bhajan database
    if (!master_bhajan_id) {
      return res
        .status(400)
        .send(
          `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/css/style.css"><title>Cannot submit bhajan without selecting from dropdown</title></head><body><div class="container" style="max-width:560px; padding:32px; text-align:center;"><h2>⚠️ Selection Required</h2><p>Cannot submit bhajan without selecting from dropdown. Manual entry without selecting a suggested bhajan is not allowed.</p><a class="button secondary" href="javascript:history.back()">Go Back</a></div></body></html>`
        );
    }

    const masterBhajan = await MasterBhajan.findByPk(master_bhajan_id);
    if (!masterBhajan || !masterBhajan.is_active) {
      return res
        .status(400)
        .send(
          `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/css/style.css"><title>Invalid Bhajan Selection</title></head><body><div class="container" style="max-width:560px; padding:32px; text-align:center;"><h2>⚠️ Invalid Bhajan</h2><p>Cannot submit bhajan without selecting from dropdown. The selected bhajan was not found in the active master list.</p><a class="button secondary" href="javascript:history.back()">Go Back</a></div></body></html>`
        );
    }

    // Verify title matches canonical master bhajan title
    if (normalizeBhajanTitle(masterBhajan.title) !== normalizeBhajanTitle(title)) {
      return res
        .status(400)
        .send(
          `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/css/style.css"><title>Invalid Bhajan Selection</title></head><body><div class="container" style="max-width:560px; padding:32px; text-align:center;"><h2>⚠️ Invalid Bhajan</h2><p>Cannot submit bhajan without selecting from dropdown. Title does not match the selected suggestion.</p><a class="button secondary" href="javascript:history.back()">Go Back</a></div></body></html>`
        );
    }

    const aliases = (DEITY_ALIASES[deity] || [deity]).map((a) => a.toLowerCase().trim());
    const titleMatcher = DEITY_TITLE_MATCHERS[deity];

    const bhajanDeities = (masterBhajan.deity || "")
      .split(/[,;&\/]+/)
      .map((d) => d.toLowerCase().trim())
      .filter(Boolean);

    const deityMatches =
      aliases.some((alias) =>
        bhajanDeities.some((bd) => {
          if (bd === alias || bd.includes(alias) || alias.includes(bd)) return true;
          const tokenAliases = (DEITY_ALIASES[bd] || []).map((x) => x.toLowerCase().trim());
          return tokenAliases.includes(alias);
        })
      ) ||
      (titleMatcher && titleMatcher.test(masterBhajan.title));

    if (!deityMatches) {
      return res
        .status(400)
        .send(
          `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/css/style.css"><title>Invalid Bhajan Selection</title></head><body><div class="container" style="max-width:560px; padding:32px; text-align:center;"><h2>⚠️ Invalid Bhajan</h2><p>Cannot submit bhajan without selecting from dropdown. The selected bhajan does not belong to ${escapeHtml(deity)}.</p><a class="button secondary" href="javascript:history.back()">Go Back</a></div></body></html>`
        );
    }

    const todayStr = getLocalDateStr();
    const thuStatus = getThursdaySubmissionStatus();
    const isPastOrToday = todayStr >= session_date;
    const meta = await SessionMeta.findByPk(session_date);
    const isManuallyLocked = meta && meta.is_locked;
    const isNextThuUnopened =
      !isAdmin &&
      session_date === thuStatus.nextThursdayDate &&
      thuStatus.opensAt8pmToday &&
      process.env.NODE_ENV !== "test";

    if (!isAdmin && (isManuallyLocked || isPastOrToday || isNextThuUnopened)) {
      let reasonMsg = "";
      if (isManuallyLocked) {
        reasonMsg = "This session has been locked by the coordinator.";
      } else if (isNextThuUnopened) {
        reasonMsg = `Submissions for next Thursday (${session_date}) will open today at 8:00 PM.`;
      } else {
        reasonMsg = `Submissions for session (${session_date}) closed on the night before at 11:59 PM. Submissions for this session are now locked.`;
      }
      return res
        .status(403)
        .send(
          `<h1>Locked</h1><p>${reasonMsg}</p><a class="button" href="${isAdmin ? "/admin" : "/"}">${isAdmin ? "Return to Dashboard" : "Go Home"}</a>`
        );
    }

    let newSubmission = null;
    await sequelize.transaction(async (t) => {
      // 1. Re-verify lock inside transaction
      const meta = await SessionMeta.findByPk(session_date, { transaction: t });
      if (!isAdmin && meta && meta.is_locked) {
        const err = new Error("LOCKED");
        err.reason = "This session has been locked by the coordinator.";
        throw err;
      }

      // 2. Fetch all submissions for this date inside transaction
      const allSubmissions = await BhajanSubmission.findAll({
        where: { session_date },
        transaction: t
      });

      // 3. A title may be used only once in a session
      const duplicateBhajan = allSubmissions.find(
        (submission) => normalizeBhajanTitle(submission.title) === normalizeBhajanTitle(title)
      );
      if (duplicateBhajan) {
        const err = new Error("DUPLICATE_BHAJAN");
        err.duplicate = duplicateBhajan;
        throw err;
      }

      // 4. Check deity limits strictly inside the transaction
      if (!isAdmin) {
        let rules = await DeityRule.findAll({ where: { session_date }, transaction: t });
        if (rules.length === 0)
          rules = await DeityRule.findAll({ where: { session_date: "default" }, transaction: t });

        const ruleForDeity = rules.find((r) => r.deity_name === deity) || { max_allowed: 2 };
        const maxAllowed = ruleForDeity.max_allowed;

        if (maxAllowed === 0) {
          const err = new Error("DEITY_BLOCKED");
          err.deity = deity;
          throw err;
        }

        const existingEntries = allSubmissions.filter((s) => s.deity === deity);
        if (existingEntries.length >= maxAllowed) {
          const err = new Error("DEITY_LIMIT_EXCEEDED");
          err.deity = deity;
          err.lastEntry = existingEntries[existingEntries.length - 1];
          throw err;
        }
      }

      // 5. Singer gender and profile resolution
      const submittedGender = gender || locked_gender;
      const normalizedInputName = normalizeName(effectiveSingerName);

      const allSingers = await Singer.findAll({
        attributes: ["id", "name", "gender"],
        transaction: t
      });
      let singer = allSingers.find((s) => normalizeName(s.name) === normalizedInputName) || null;

      if (!singer) {
        if (!isAdmin) {
          const err = new Error("SINGER_NOT_FOUND");
          throw err;
        }
        singer = await Singer.create(
          {
            name: effectiveSingerName,
            gender: submittedGender || null
          },
          { transaction: t }
        );
      } else if (!singer.gender && submittedGender) {
        await singer.update({ gender: submittedGender }, { transaction: t });
        singer.gender = submittedGender;
      }
      const resolvedGender = singer.gender || submittedGender || null;

      // 6. Save submission inside transaction
      newSubmission = await BhajanSubmission.create(
        {
          session_date,
          singer_name: effectiveSingerName,
          gender: resolvedGender,
          partner_name: partner_name ? partner_name.trim() : null,
          title,
          deity,
          scale: scale || "Not specified",
          speed,
          raga,
          level,
          language
        },
        { transaction: t }
      );
    });

    // ── Partner notification ──────────────────────────────────────────
    // If a partner was specified, send a personalized notification
    // to the partner's registered devices (if any).
    if (partner_name && partner_name.trim() && newSubmission) {
      try {
        const notificationService = require("../services/notificationService");
        const partnerNormalized = normalizeName(partner_name);
        const allSingers = await Singer.findAll({ attributes: ["id", "name"] });
        const partnerSinger = allSingers.find((s) => normalizeName(s.name) === partnerNormalized);

        if (partnerSinger) {
          // Format day and date for notification (e.g. Thursday, 3 September)
          let dateText = session_date;
          try {
            const [y, m, d] = session_date.split("-").map(Number);
            const dateObj = new Date(y, m - 1, d);
            const dayName = dateObj.toLocaleDateString("en-US", { weekday: "long" });
            const dateFormatted = dateObj.toLocaleDateString("en-GB", {
              day: "numeric",
              month: "long"
            });
            dateText = `${dayName}, ${dateFormatted}`;
          } catch (e) {}

          await notificationService.createPersonalized({
            type: "partner_bhajan",
            title: "🔔 Bhajan Added With You",
            body: `${effectiveSingerName} added "${title}" with you as partner for ${dateText}. Tap to view.`,
            link: `/session-link?session_date=${session_date}`,
            eventKey: `partner_bhajan:${newSubmission.id}`,
            singerId: partnerSinger.id
          });
        }
      } catch (notifErr) {
        console.error("Partner notification failed:", notifErr.message);
      }
    }

    // Success response
    const adminQuery = isAdmin ? "&admin=true" : "";
    res.redirect(`/submit-form?session_date=${session_date}&success=true${adminQuery}`);
  } catch (error) {
    if (error.message === "DUPLICATE_BHAJAN" && error.duplicate) {
      const adminParam = isAdmin ? "&admin=true" : "";
      return res
        .status(409)
        .send(
          `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/css/style.css"><title>Bhajan Already Added</title></head><body><div class="container" style="max-width:560px; padding:32px; text-align:center;"><h2>Bhajan Already Added</h2><p><strong>${escapeHtml(error.duplicate.title)}</strong> has already been submitted for this session by <strong>${escapeHtml(error.duplicate.singer_name)}</strong>.</p><a class="button secondary" href="/submit-form?session_date=${encodeURIComponent(req.body.session_date)}${adminParam}">Go back to the form</a></div></body></html>`
        );
    }
    if (error.message === "DEITY_BLOCKED") {
      return res
        .status(409)
        .send(
          generateErrorHtml(
            error.deity,
            { singer_name: "Admin", title: "Blocked for this session", created_at: new Date() },
            req.body.session_date
          )
        );
    }
    if (error.message === "DEITY_LIMIT_EXCEEDED" && error.lastEntry) {
      return res
        .status(409)
        .send(generateErrorHtml(error.deity, error.lastEntry, req.body.session_date));
    }
    if (error.message === "LOCKED") {
      return res
        .status(403)
        .send(
          `<h1>Locked</h1><p>${error.reason}</p><a class="button" href="${isAdmin ? "/admin" : "/"}">${isAdmin ? "Return to Dashboard" : "Go Home"}</a>`
        );
    }
    if (error.message === "SINGER_NOT_FOUND") {
      return res
        .status(400)
        .send(
          '<h1>Error</h1><p>Singer profile not found in directory. Please sign in through Singer Hub.</p><a class="button" href="/singer/login">Login</a>'
        );
    }
    if (error.name === "SequelizeUniqueConstraintError") {
      return res.status(409).send(
        generateErrorHtml(
          req.body.deity,
          {
            singer_name: "Another devotee",
            title: req.body.title || "Selected Bhajan",
            created_at: new Date()
          },
          req.body.session_date
        )
      );
    }
    console.error(`[Req ${req.id || ""}] submitForm error:`, error);
    res
      .status(500)
      .send(
        "<h1>Error</h1><p>An unexpected error occurred while processing your bhajan submission.</p>"
      );
  }
};

exports.planView = async (req, res) => {
  try {
    let sessionDate = req.query.session_date;

    const { dates: availableDatesMap, status } = await getAvailableDates();

    // Query past session dates that have bhajans submitted
    const pastSessions = await BhajanSubmission.findAll({
      attributes: [[Sequelize.fn("DISTINCT", Sequelize.col("session_date")), "session_date"]],
      order: [["session_date", "DESC"]],
      limit: 20,
      raw: true
    });

    const pastDateSet = new Set(pastSessions.map((p) => p.session_date));

    // Build dropdown list of all known dates
    const dateOptionsList = [];
    const seenDates = new Set();

    // If today's Thursday session is active (before 8:30 PM), show it first in dropdown
    if (status.isThursdayLiveActive) {
      seenDates.add(status.todayStr);
      dateOptionsList.push({
        date: status.todayStr,
        label: `🔴 ${status.todayStr} (Today's Live Session — 7:30 PM to 8:30 PM)`,
        isCurrent: false
      });
    }

    const upcomingThursday = status.openThursday || status.nextThursdayDate;
    if (upcomingThursday && !seenDates.has(upcomingThursday)) {
      seenDates.add(upcomingThursday);
      dateOptionsList.push({
        date: upcomingThursday,
        label: `📅 ${upcomingThursday} (Upcoming Thursday)`,
        isCurrent: false
      });
    }

    availableDatesMap.forEach((meta, d) => {
      if (!seenDates.has(d)) {
        seenDates.add(d);
        dateOptionsList.push({
          date: d,
          label: `✨ ${d} (${meta.label}${meta.desc ? " - " + meta.desc : ""})`,
          isCurrent: false
        });
      }
    });

    pastSessions.forEach((p) => {
      const d = p.session_date;
      if (!seenDates.has(d)) {
        seenDates.add(d);
        dateOptionsList.push({ date: d, label: `📁 ${d}`, isCurrent: false });
      }
    });

    // Auto-select best default date
    if (!sessionDate) {
      // 1. If today is Thursday and before 8:30 PM, default to today's active session!
      if (status.isThursdayLiveActive) {
        sessionDate = status.todayStr;
      } else {
        // 2. Look for active session today among available special dates, or earliest upcoming date
        const activeAvailable = Array.from(availableDatesMap.keys()).sort();
        if (activeAvailable.length > 0) {
          sessionDate = activeAvailable[0];
        } else if (upcomingThursday) {
          sessionDate = upcomingThursday;
        } else if (pastSessions.length > 0) {
          sessionDate = pastSessions[0].session_date;
        } else {
          sessionDate = getLocalDateStr();
        }
      }
    }

    dateOptionsList.forEach((opt) => {
      opt.isCurrent = opt.date === sessionDate;
    });
    if (!seenDates.has(sessionDate)) {
      dateOptionsList.unshift({ date: sessionDate, label: `📅 ${sessionDate}`, isCurrent: true });
    }

    // Fetch submissions for the selected date
    const results = await BhajanSubmission.findAll({ where: { session_date: sessionDate } });

    const masterBhajans = await MasterBhajan.findAll({
      where: { is_active: true },
      attributes: [
        "id",
        "title",
        "sheet_filename",
        "lyrics",
        "deity",
        "raga",
        "tempo",
        "shruti",
        "shruti_female"
      ]
    });
    const masterMap = new Map();
    masterBhajans.forEach((mb) => {
      masterMap.set(normalizeBhajanTitle(mb.title), mb);
    });

    const sorted = results.sort((a, b) => {
      if (a.list_order > 0 || b.list_order > 0) {
        if (a.list_order === 0) return 1;
        if (b.list_order === 0) return -1;
        return a.list_order - b.list_order;
      }
      const deityCompare = deityOrderKey(a.deity) - deityOrderKey(b.deity);
      if (deityCompare !== 0) return deityCompare;
      const speedCompare =
        (SPEED_ORDER[(a.speed || "").toLowerCase()] || 1) -
        (SPEED_ORDER[(b.speed || "").toLowerCase()] || 1);
      if (speedCompare !== 0) return speedCompare;
      return a.singer_name.toLowerCase().localeCompare(b.singer_name.toLowerCase());
    });

    // Fetch published session audio recording & timestamps (if any)
    let sessionAudio = null;
    const timestampMap = new Map();
    try {
      sessionAudio = await SessionAudio.findOne({
        where: { session_date: sessionDate, is_published: true },
        include: [{ model: SessionAudioTimestamp, as: "timestamps" }],
        order: [[{ model: SessionAudioTimestamp, as: "timestamps" }, "start_seconds", "ASC"]]
      });
      if (sessionAudio && sessionAudio.timestamps) {
        sessionAudio.timestamps.forEach((t) => {
          if (t.submission_id) timestampMap.set(`sub_${t.submission_id}`, t);
          if (t.bhajan_title) timestampMap.set(`title_${normalizeBhajanTitle(t.bhajan_title)}`, t);
        });
      }
    } catch (audioErr) {
      console.warn("Could not load plan session audio:", audioErr.message);
    }

    let rowsHtml = "";
    let timelineCardsHtml = "";
    let whatsappItems = [];

    if (sorted.length === 0) {
      rowsHtml =
        '<tr><td colspan="6" style="text-align:center; padding:36px; color:var(--ink-soft);">No bhajans scheduled for this date yet.</td></tr>';
      timelineCardsHtml = `<div class="plan-empty-state">
        <div class="plan-empty-icon">🪔</div>
        <h3 style="margin:0 0 6px 0; font-size:17px; font-weight:700;">No Bhajans Scheduled Yet</h3>
        <p style="font-size:13.5px; color:var(--ink-soft); margin:0 0 16px 0;">Be the first to submit a bhajan slot for this session!</p>
        <a href="/submit-form?session_date=${sessionDate}" class="button" style="display:inline-flex; align-items:center; gap:6px;">🎤 Submit Bhajan Slot</a>
      </div>`;
    } else {
      sorted.forEach((item, index) => {
        const stepNum = index + 1;
        const matchedMaster = masterMap.get(normalizeBhajanTitle(item.title));
        const sheetFilename = matchedMaster ? matchedMaster.sheet_filename : null;
        const westernKey = getWesternScale(item.scale);
        const deityIcon = getDeityIcon(item.deity);
        const numEmoji = getNumberEmoji(stepNum);

        // Check for audio timestamp
        const itemTimestamp =
          (item.id && timestampMap.get(`sub_${item.id}`)) ||
          timestampMap.get(`title_${normalizeBhajanTitle(item.title)}`);

        let audioBtnHtml = "";
        if (itemTimestamp && sessionAudio && sessionAudio.audio_url) {
          const m = Math.floor(itemTimestamp.start_seconds / 60);
          const s = itemTimestamp.start_seconds % 60;
          const timeFormatted = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
          audioBtnHtml = `<button type="button" class="plan-card-action-btn plan-action-audio btn-play-bhajan no-print" data-start="${itemTimestamp.start_seconds}" data-title="${escapeHtml(item.title)}" data-singer="${escapeHtml(item.singer_name)}" data-url="${escapeHtml(sessionAudio.audio_url)}" onclick="window.playSessionAudioBtn(this)" title="Play bhajan recording at ${timeFormatted}">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            <span>${timeFormatted}</span>
          </button>`;
        }

        const sheetBtnHtml = sheetFilename
          ? `<a href="/sheets/${encodeURIComponent(sheetFilename)}" target="_blank" rel="noopener noreferrer" class="plan-card-action-btn plan-action-sheet sheet-link-pill no-print" title="Open official reference sheet music (PDF)"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg><span>Sheet</span></a>`
          : "";
        const lyricsBtnHtml = matchedMaster
          ? `<button type="button" class="plan-card-action-btn plan-action-lyrics btn-quick-lyrics no-print" onclick="openPlanLyrics(${matchedMaster.id})" title="Read full lyrics"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path></svg><span>Lyrics</span></button>`
          : "";
        const lyricsLinkHtml = matchedMaster
          ? `<a href="/bhajan/${matchedMaster.id}" style="color:inherit; text-decoration:none;" title="View lyrics & details">${escapeHtml(item.title)}</a>`
          : escapeHtml(item.title);

        const nameParts = (item.singer_name || "").trim().split(/\s+/);
        const initials =
          nameParts.length > 1
            ? (nameParts[0][0] + nameParts[nameParts.length - 1][0]).toUpperCase()
            : nameParts[0]
              ? nameParts[0].substring(0, 2).toUpperCase()
              : "SB";

        const speedStr = (item.speed || "Medium").toLowerCase();
        let speedIcon = "🎵";
        if (speedStr.includes("fast")) speedIcon = "⚡";
        if (speedStr.includes("slow")) speedIcon = "🕊️";

        rowsHtml += `
          <tr>
            <td data-label="#"><strong>${stepNum}</strong></td>
            <td data-label="Singer">
              <div style="display:flex; align-items:center; gap:8px;">
                <span class="timeline-avatar no-print" style="width:26px; height:26px; font-size:11px;">${initials}</span>
                <div>
                  <strong>${escapeHtml(item.singer_name)}</strong>
                  ${item.partner_name ? `<br><small style="color:var(--ink-soft); font-weight:500;">w/ ${escapeHtml(item.partner_name)}</small>` : ""}
                </div>
              </div>
            </td>
            <td data-label="Bhajan">
              <div>
                <strong>${lyricsLinkHtml}</strong>
                ${(sheetBtnHtml || lyricsBtnHtml || audioBtnHtml) ? `<div class="timeline-actions-row table-actions-row no-print">${sheetBtnHtml}${lyricsBtnHtml}${audioBtnHtml}</div>` : ""}
              </div>
            </td>
            <td data-label="Deity">
              <span class="deity-pill" style="display:inline-flex; align-items:center; gap:5px;">
                <span>${deityIcon}</span><span>${escapeHtml(item.deity)}</span>
              </span>
            </td>
            <td data-label="Pitch / Scale">
              <strong>${escapeHtml(item.scale || "-")}</strong>
              ${westernKey !== "-" ? `<span class="acc-key-tag">${westernKey}</span>` : ""}
            </td>
            <td data-label="Tempo"><span class="speed-pill">${speedIcon} ${escapeHtml(item.speed)}</span></td>
          </tr>`;

        timelineCardsHtml += `
          <div class="timeline-item" id="bhajan-step-${stepNum}">
            <div class="timeline-spine">
              <div class="timeline-step-badge">${stepNum}</div>
              <div class="timeline-line"></div>
            </div>
            <div class="timeline-card">
              <div class="timeline-card-header">
                <div class="timeline-card-header-left">
                  <span class="deity-pill"><span>${deityIcon}</span><span>${escapeHtml(item.deity)}</span></span>
                  <span class="speed-pill">${speedIcon} ${escapeHtml(item.speed)}</span>
                </div>
                <span style="font-size:12px; font-weight:700; color:var(--ink-soft);">#${stepNum}</span>
              </div>
              <div>
                <h3 class="timeline-bhajan-title">${lyricsLinkHtml}</h3>
                ${(sheetBtnHtml || lyricsBtnHtml || audioBtnHtml) ? `<div class="timeline-actions-row no-print">${sheetBtnHtml}${lyricsBtnHtml}${audioBtnHtml}</div>` : ""}
              </div>
              <div class="timeline-singer-row">
                <span class="timeline-avatar">${initials}</span>
                <div class="timeline-singer-info">
                  <span class="timeline-singer-name">${escapeHtml(item.singer_name)}</span>
                  ${item.partner_name ? `<span class="timeline-partner-tag">👥 with ${escapeHtml(item.partner_name)}</span>` : ""}
                </div>
              </div>
              <div class="timeline-accompanist-strip">
                <div class="acc-tile">
                  <span class="acc-tile-icon">🎹</span>
                  <div class="acc-tile-text">
                    <span class="acc-label">Pitch / Scale</span>
                    <span class="acc-value">
                      ${escapeHtml(item.scale || "N/A")}
                      ${westernKey !== "-" ? `<span class="acc-key-tag">${westernKey}</span>` : ""}
                    </span>
                  </div>
                </div>
                <div class="acc-tile">
                  <span class="acc-tile-icon">🥁</span>
                  <div class="acc-tile-text">
                    <span class="acc-label">Tempo</span>
                    <span class="acc-value">${speedIcon} ${escapeHtml(item.speed)}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>`;

        const scaleStr = `${item.scale || "N/A"}${westernKey !== "-" ? ` (${westernKey})` : ""}`;
        const tempoDisplay = item.speed
          ? item.speed.charAt(0).toUpperCase() + item.speed.slice(1)
          : "Medium";
        const partnerStr = item.partner_name ? ` (with ${item.partner_name})` : "";

        const waItem = `${index + 1}. [${item.deity}] ${item.title}\n   Singer: ${item.singer_name}${partnerStr}\n   Pitch: ${scaleStr} | Tempo: ${tempoDisplay}`;
        whatsappItems.push(waItem);
      });
    }

    let sessionDateHuman = sessionDate;
    try {
      const [y, m, d] = sessionDate.split("-").map(Number);
      const dateObj = new Date(y, m - 1, d);
      sessionDateHuman = dateObj.toLocaleDateString("en-US", {
        weekday: "long",
        day: "2-digit",
        month: "short",
        year: "numeric"
      });
    } catch (e) {}

    const protocol = req.protocol || "http";
    const host = req.get("host") || "localhost:8000";
    const livePlanUrl = `${protocol}://${host}/plan-view?session_date=${sessionDate}`;

    let whatsappText = `*SRI SATHYA SAI SEVA ORGANISATION*\n*BHAJAN PROGRAM – ${sessionDateHuman}*\nTotal Bhajans: ${sorted.length}\n--------------------------------------------------\n\n`;
    whatsappText +=
      whatsappItems.length > 0
        ? whatsappItems.join("\n\n") + "\n\n"
        : "No bhajans scheduled for this date yet.\n\n";
    whatsappText += `--------------------------------------------------\nSai Ram to all Accompanists & Devotees\nLive Plan: ${livePlanUrl}`;
    const whatsappEncoded = encodeURIComponent(whatsappText);

    const isAdmin = Boolean(req.session && (req.session.admin || req.session.adminUserId));

    const html = generatePlanViewHtml(sessionDate, rowsHtml, whatsappText, whatsappEncoded, {
      sessionDateHuman,
      timelineCardsHtml,
      dateOptionsList,
      submissionsCount: sorted.length,
      isUpcoming: sessionDate >= getLocalDateStr(),
      isAdmin,
      csrfToken: res.locals.csrfToken || "",
      sessionAudio
    });

    res.send(html);
  } catch (error) {
    console.error(`[Req ${req.id || ""}] planView error:`, error);
    res.status(500).send("<h1>Error</h1><p>Failed to load session plan.</p>");
  }
};
exports.submitApi = async (req, res) => {
  try {
    const { session_date, singer_name, partner_name, bhajans } = req.body;
    if (!session_date || !singer_name || !Array.isArray(bhajans) || bhajans.length === 0) {
      return res.status(400).json({
        error: "Validation failed: session_date, singer_name, and bhajans array are required."
      });
    }

    await sequelize.transaction(async (t) => {
      for (const bhajan of bhajans) {
        if (!bhajan.title || !bhajan.deity) continue;
        await BhajanSubmission.create(
          {
            session_date,
            singer_name,
            partner_name: partner_name ? partner_name.trim() : null,
            title: bhajan.title.trim(),
            deity: bhajan.deity.trim(),
            scale: bhajan.scale || null,
            speed: bhajan.speed || null
          },
          { transaction: t }
        );
      }
    });

    res.json({
      status: "ok",
      message: "Bhajans saved to database.",
      total_bhajans_received: bhajans.length
    });
  } catch (error) {
    console.error(`[Req ${req.id || ""}] submitApi error:`, error);
    res.status(500).json({ error: "Failed to save bhajans." });
  }
};
exports.getPlan = async (req, res) => {
  try {
    const { session_date } = req.params;

    const results = await BhajanSubmission.findAll({
      where: { session_date }
    });

    const sorted = results.sort((a, b) => {
      // 1. Manual Drag-and-Drop sequence overrides everything else
      if (a.list_order > 0 || b.list_order > 0) {
        if (a.list_order === 0) return 1;
        if (b.list_order === 0) return -1;
        return a.list_order - b.list_order;
      }

      // 2. Default fallback sorting
      const deityCompare = deityOrderKey(a.deity) - deityOrderKey(b.deity);
      if (deityCompare !== 0) return deityCompare;

      const speedCompare =
        (SPEED_ORDER[(a.speed || "").toLowerCase()] || 1) -
        (SPEED_ORDER[(b.speed || "").toLowerCase()] || 1);
      if (speedCompare !== 0) return speedCompare;

      return a.singer_name.toLowerCase().localeCompare(b.singer_name.toLowerCase());
    });

    const plan = sorted.map((item, index) => ({
      order: index + 1,
      session_date: item.session_date,
      singer: item.singer_name,
      partner: item.partner_name,
      title: item.title,
      deity: item.deity,
      scale: item.scale,
      speed: item.speed
    }));

    res.json(plan);
  } catch (error) {
    console.error(`[Req ${req.id || ""}] getPlan error:`, error);
    res.status(500).json({ error: "Failed to retrieve session plan." });
  }
};

// ── Smart session redirection (routes to submit-form if open, history if moved/closed) ──
exports.sessionLink = async (req, res) => {
  try {
    const { getLocalDateStr } = require("../services/helpers");
    const SessionMeta = require("../models/SessionMeta");
    const SessionPermission = require("../models/SessionPermission");

    let sessionDate = req.query.session_date || req.query.date;

    const { dates: availableDates, status: thuStatus } = await getAvailableDates();

    if (!sessionDate) {
      sessionDate = thuStatus.openThursday;
    }

    if (!sessionDate) {
      return res.redirect("/database");
    }

    const todayStr = getLocalDateStr();
    const isPastOrToday = todayStr >= sessionDate;
    const meta = await SessionMeta.findByPk(sessionDate);
    const isManuallyLocked = meta && meta.is_locked;
    const isNextThuUnopened =
      sessionDate === thuStatus.nextThursdayDate && thuStatus.opensAt8pmToday;

    // Check if date is a Thursday or has explicit admin permission
    const [sYear, sMonth, sDay] = sessionDate.split("-").map(Number);
    const dayOfWeek = new Date(sYear, sMonth - 1, sDay).getDay();
    const isThursday = dayOfWeek === 4;
    const permission = await SessionPermission.findByPk(sessionDate);

    // If session submissions are closed/locked/past or not enabled, direct to History tab
    if (isPastOrToday || isManuallyLocked || isNextThuUnopened || (!isThursday && !permission)) {
      return res.redirect("/database");
    }

    // Submissions are open — direct to submit-form for this session
    return res.redirect(`/submit-form?session_date=${sessionDate}`);
  } catch (error) {
    console.error("sessionLink error:", error);
    res.redirect("/database");
  }
};
