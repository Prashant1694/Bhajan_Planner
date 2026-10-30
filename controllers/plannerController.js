const { Sequelize } = require("sequelize");
const sequelize = require("../config/database");

const BhajanSubmission = require("../models/BhajanSubmission");
const SessionPermission = require("../models/SessionPermission");
const SessionMeta = require("../models/SessionMeta");
const DeityRule = require("../models/DeityRule");
const Singer = require("../models/Singer");
const SessionAudio = require("../models/SessionAudio");
const SessionAudioTimestamp = require("../models/SessionAudioTimestamp");

const {
  getThursdaySubmissionStatus,
  getLocalDateStr,
  deityOrderKey,
  SPEED_ORDER,
  normalizeName,
  getWesternScale,
  getDeityIcon
} = require("../services/helpers");
const { DEITY_ALIASES, DEITY_TITLE_MATCHERS } = require("../config/constants");
const { escapeHtml } = require("../templates");
const { generateToken } = require("../middleware/csrfProtection");
const {
  getMasterCatalog,
  getSingersCatalog,
  invalidateSingerCache,
  normalizeTitleKey
} = require("../services/catalogCache");
const {
  normalizeBhajanTitle,
  getAvailableDates,
  buildDeityStatus,
  generateDeityCardsHtml,
  buildSessionOptions
} = require("../services/plannerService");

function renderStatusPage(res, status, { heading, messageHtml, details = null, backHref = "/submit-form", backLabel = "Go Back", variant = "warning" }) {
  return res.status(status).render("submission-status", {
    pageTitle: heading,
    page: "submit-form",
    heading,
    messageHtml,
    details,
    backHref,
    backLabel,
    variant
  });
}

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
        const msg = `Today's Thursday session is locked.<br>Submissions for next Thursday (<strong>${escapeHtml(thuStatus.nextThursdayDate)}</strong>) will open today at 8:00 PM.`;
        if (availableDates.size > 0) {
          return res.render("session-select", {
            pageTitle: "Select Session",
            page: "submit-form",
            heading: "Select Available Session",
            messageHtml: `${msg}<br><br>You can submit for available Special/Festival sessions below:`,
            options: buildSessionOptions(availableDates, isAdmin),
            isAdmin
          });
        }
        return res.render("session-select", {
          pageTitle: "Submissions Opening at 8:00 PM",
          page: "submit-form",
          heading: "Submissions Opening at 8:00 PM",
          messageHtml: msg,
          options: [],
          isAdmin
        });
      }

      if (availableDates.size > 1) {
        return res.render("session-select", {
          pageTitle: "Select Session",
          page: "submit-form",
          heading: "Select Session",
          messageHtml: "Please select an open session to submit your bhajan offering:",
          options: buildSessionOptions(availableDates, isAdmin),
          isAdmin
        });
      }
      sessionDate = thuStatus.openThursday || thuStatus.nextThursdayDate;
    }

    const todayStr = getLocalDateStr();
    const isPastOrToday = todayStr >= sessionDate;

    const [sYear, sMonth, sDay] = sessionDate.split("-").map(Number);
    const dayOfWeek = new Date(sYear, sMonth - 1, sDay).getDay();
    const isThursday = dayOfWeek === 4;

    // Parallelize session metadata, permission, deity rules, and existing submissions
    const [meta, permission, sessionRules, defaultRules, results] = await Promise.all([
      SessionMeta.findByPk(sessionDate, { raw: true }),
      SessionPermission.findByPk(sessionDate, { raw: true }),
      DeityRule.findAll({ where: { session_date: sessionDate }, raw: true }),
      DeityRule.findAll({ where: { session_date: "default" }, raw: true }),
      BhajanSubmission.findAll({ where: { session_date: sessionDate }, raw: true })
    ]);

    const isManuallyLocked = Boolean(meta && meta.is_locked);
    const isNextThuUnopened =
      !isAdmin &&
      sessionDate === thuStatus.nextThursdayDate &&
      thuStatus.opensAt8pmToday &&
      process.env.NODE_ENV !== "test";

    if (!isAdmin && (isManuallyLocked || isPastOrToday)) {
      return res.redirect("/database");
    }

    if (!isAdmin && isNextThuUnopened) {
      const reasonMsg = `Submissions for next Thursday (<strong>${escapeHtml(sessionDate)}</strong>) will open today at 8:00 PM.`;
      return res.render("session-select", {
        pageTitle: "Select Session",
        page: "submit-form",
        heading: "Submissions Opening at 8:00 PM",
        messageHtml: `${reasonMsg}<br>Please select an available upcoming session:`,
        options: buildSessionOptions(availableDates, isAdmin),
        isAdmin
      });
    }

    if (!isAdmin && !isThursday && !permission) {
      return res.render("session-select", {
        pageTitle: "Select Session",
        page: "submit-form",
        heading: "Session Not Open",
        messageHtml: `Bhajan submission for <strong>${escapeHtml(sessionDate)}</strong> is not enabled.<br>Please select an available session:`,
        options: buildSessionOptions(availableDates, isAdmin),
        isAdmin
      });
    }

    const rules = sessionRules.length > 0 ? sessionRules : defaultRules;

    const { deityStatus, mandatoryFilled, totalMandatory, optionalFilled, totalOptional } =
      buildDeityStatus(rules, results);

    const { ganeshaCardHtml, otherDeitiesHtml, hanumanCard } = generateDeityCardsHtml(deityStatus);

    const sortedSubmissions = results.sort(
      (a, b) => new Date(a.created_at) - new Date(b.created_at)
    );

    const csrfToken =
      res.locals.csrfToken ||
      (typeof req.csrfToken === "function" ? req.csrfToken() : generateToken(req, res));

    res.render("submit-form", {
      pageTitle: "Mark Bhajan — Bhajan Planner",
      page: "submit-form",
      pageCSS: "submit-glass.css",
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
      submissions: sortedSubmissions,
      currentSinger: req.session?.singer || null,
      csrfToken
    });
  } catch (error) {
    console.error(`[Req ${req.id || ""}] showSubmitForm error:`, error);
    res
      .status(500)
      .send("<h1>Error</h1><p>An unexpected error occurred loading the submission form.</p>");
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
      master_bhajan_id
    } = req.body;

    if (!isAdmin && (!req.session || !req.session.singer)) {
      const embedParam = req.query._embed === "1" ? "&_embed=1" : "";
      return res.redirect(`/singer/login?redirect=${encodeURIComponent("/submit-form")}${embedParam}`);
    }

    const effectiveSingerName =
      !isAdmin && req.session?.singer ? req.session.singer.name.trim() : (singer_name || "").trim();
    const effectiveGender =
      !isAdmin && req.session?.singer && req.session.singer.gender
        ? req.session.singer.gender
        : locked_gender || gender;

    if (!session_date || !effectiveSingerName || !deity || !title) {
      return renderStatusPage(res, 400, {
        heading: "Missing Required Fields",
        messageHtml: "Please fill in the session date, singer name, deity, and bhajan title.",
        backHref: "/submit-form"
      });
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(session_date)) {
      return renderStatusPage(res, 400, {
        heading: "Invalid Session Date",
        messageHtml: "Invalid session date format.",
        backHref: "/submit-form"
      });
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
      return renderStatusPage(res, 400, {
        heading: "Invalid Deity Category",
        messageHtml: "Please select a valid Mandir deity slot.",
        backHref: `/submit-form?session_date=${encodeURIComponent(session_date)}`
      });
    }

    if (!master_bhajan_id) {
      return renderStatusPage(res, 400, {
        heading: "Selection Required",
        messageHtml:
          "Cannot submit bhajan without selecting from dropdown. Manual entry without selecting a suggested bhajan is not allowed.",
        backHref: `/submit-form?session_date=${encodeURIComponent(session_date)}`
      });
    }

    const catalog = await getMasterCatalog();
    const masterBhajan = catalog.fullById.get(Number(master_bhajan_id));
    if (!masterBhajan || !masterBhajan.is_active) {
      return renderStatusPage(res, 400, {
        heading: "Invalid Bhajan",
        messageHtml:
          "Cannot submit bhajan without selecting from dropdown. The selected bhajan was not found in the active master list.",
        backHref: `/submit-form?session_date=${encodeURIComponent(session_date)}`
      });
    }

    if (normalizeBhajanTitle(masterBhajan.title) !== normalizeBhajanTitle(title)) {
      return renderStatusPage(res, 400, {
        heading: "Invalid Bhajan",
        messageHtml:
          "Cannot submit bhajan without selecting from dropdown. Title does not match the selected suggestion.",
        backHref: `/submit-form?session_date=${encodeURIComponent(session_date)}`
      });
    }

    const aliases = (DEITY_ALIASES[deity] || [deity]).map((a) => a.toLowerCase().trim());
    const titleMatcher = DEITY_TITLE_MATCHERS[deity];

    const bhajanDeities = (masterBhajan.deity || "")
      .split(/[,;&/]+/)
      .map((d) => d.toLowerCase().trim())
      .filter(Boolean);

    const deityMatches =
      aliases.some((alias) =>
        bhajanDeities.some((bd) => {
          if (bd === alias || bd.includes(alias) || alias.includes(bd)) return true;
          const tokenAliases = (DEITY_ALIASES[bd] || []).map((x) => x.toLowerCase().trim());
          return tokenAliases.includes(alias);
        })
      ) || Boolean(titleMatcher && titleMatcher.test(masterBhajan.title));

    if (!deityMatches) {
      return renderStatusPage(res, 400, {
        heading: "Deity Mismatch",
        messageHtml: `Cannot submit bhajan without selecting from dropdown. The selected bhajan does not belong to <strong>${escapeHtml(deity)}</strong>.`,
        backHref: `/submit-form?session_date=${encodeURIComponent(session_date)}`
      });
    }

    const todayStr = getLocalDateStr();
    const thuStatus = getThursdaySubmissionStatus();
    const isPastOrToday = todayStr >= session_date;
    const meta = await SessionMeta.findByPk(session_date, { raw: true });
    const isManuallyLocked = Boolean(meta && meta.is_locked);
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
        reasonMsg = `Submissions for next Thursday (${escapeHtml(session_date)}) will open today at 8:00 PM.`;
      } else {
        reasonMsg = `Submissions for session (${escapeHtml(session_date)}) closed on the night before at 11:59 PM. Submissions for this session are now locked.`;
      }
      return renderStatusPage(res, 403, {
        heading: "Session Locked",
        messageHtml: reasonMsg,
        backHref: isAdmin ? "/admin" : "/",
        backLabel: isAdmin ? "Return to Dashboard" : "Go Home",
        variant: "danger"
      });
    }

    // Pre-fetch cached singer catalog outside write transaction
    const singersCatalog = await getSingersCatalog();
    const normalizedInputName = normalizeName(effectiveSingerName);
    const submittedGender = gender || locked_gender;
    let cachedSinger =
      singersCatalog.rows.find((s) => normalizeName(s.name) === normalizedInputName) || null;
    let singerMutated = false;

    let newSubmission = null;
    await sequelize.transaction(async (t) => {
      const txMeta = await SessionMeta.findByPk(session_date, { transaction: t });
      if (!isAdmin && txMeta && txMeta.is_locked) {
        const err = new Error("LOCKED");
        err.reason = "This session has been locked by the coordinator.";
        throw err;
      }

      const allSubmissions = await BhajanSubmission.findAll({
        where: { session_date },
        transaction: t
      });

      const duplicateBhajan = allSubmissions.find(
        (submission) => normalizeBhajanTitle(submission.title) === normalizeBhajanTitle(title)
      );
      if (duplicateBhajan) {
        const err = new Error("DUPLICATE_BHAJAN");
        err.duplicate = duplicateBhajan;
        throw err;
      }

      if (!isAdmin) {
        let rules = await DeityRule.findAll({ where: { session_date }, transaction: t });
        if (rules.length === 0) {
          rules = await DeityRule.findAll({ where: { session_date: "default" }, transaction: t });
        }

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

      let resolvedGender = cachedSinger?.gender || submittedGender || null;
      if (!cachedSinger) {
        if (!isAdmin) {
          throw new Error("SINGER_NOT_FOUND");
        }
        const createdSinger = await Singer.create(
          {
            name: effectiveSingerName,
            gender: submittedGender || null
          },
          { transaction: t }
        );
        resolvedGender = createdSinger.gender || null;
        singerMutated = true;
      } else if (!cachedSinger.gender && submittedGender) {
        await Singer.update(
          { gender: submittedGender },
          { where: { id: cachedSinger.id }, transaction: t }
        );
        resolvedGender = submittedGender;
        singerMutated = true;
      }

      newSubmission = await BhajanSubmission.create(
        {
          session_date,
          singer_name: effectiveSingerName,
          gender: resolvedGender,
          partner_name: partner_name ? partner_name.trim() : null,
          title,
          deity,
          scale: (scale && scale.trim()) || masterBhajan.shruti || "Not specified",
          speed: (speed && speed.trim()) || masterBhajan.tempo || "Medium",
          raga: (raga && raga.trim()) || masterBhajan.raga || null,
          level: (level && level.trim()) || masterBhajan.level || null,
          language: (language && language.trim()) || masterBhajan.language || null
        },
        { transaction: t }
      );
    });

    if (singerMutated) {
      invalidateSingerCache();
    }

    // Partner notification using cached singers catalog (zero extra DB table scan)
    if (partner_name && partner_name.trim() && newSubmission) {
      try {
        const notificationService = require("../services/notificationService");
        const partnerNormalized = normalizeName(partner_name);
        const latestSingers = singerMutated ? await getSingersCatalog() : singersCatalog;
        const partnerSinger = latestSingers.rows.find(
          (s) => normalizeName(s.name) === partnerNormalized
        );

        if (partnerSinger) {
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
          } catch (_) {}

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

    const adminQuery = isAdmin ? "&admin=true" : "";
    res.redirect(`/submit-form?session_date=${session_date}&success=true${adminQuery}`);
  } catch (error) {
    const adminParam = isAdmin ? "&admin=true" : "";
    const backUrl = `/submit-form?session_date=${encodeURIComponent(req.body.session_date || "")}${adminParam}`;

    if (error.message === "DUPLICATE_BHAJAN" && error.duplicate) {
      return renderStatusPage(res, 409, {
        heading: "Bhajan Already Added",
        messageHtml: `<strong>${escapeHtml(error.duplicate.title)}</strong> has already been submitted for this session by <strong>${escapeHtml(error.duplicate.singer_name)}</strong>.`,
        backHref: backUrl,
        backLabel: "Go back to the form",
        variant: "danger"
      });
    }
    if (error.message === "DEITY_BLOCKED") {
      return renderStatusPage(res, 409, {
        heading: "Slot Blocked",
        messageHtml: `The <strong>${escapeHtml(error.deity)}</strong> deity slot is blocked for this session.`,
        backHref: backUrl,
        variant: "danger"
      });
    }
    if (error.message === "DEITY_LIMIT_EXCEEDED" && error.lastEntry) {
      return renderStatusPage(res, 409, {
        heading: "Slot Already Taken",
        messageHtml: `Sorry, the <strong>${escapeHtml(error.deity)}</strong> deity slot has already been filled.`,
        details: {
          singer_name: error.lastEntry.singer_name,
          title: error.lastEntry.title,
          time: new Date(error.lastEntry.created_at).toLocaleTimeString()
        },
        backHref: backUrl,
        variant: "danger"
      });
    }
    if (error.message === "LOCKED") {
      return renderStatusPage(res, 403, {
        heading: "Session Locked",
        messageHtml: escapeHtml(error.reason),
        backHref: isAdmin ? "/admin" : "/",
        backLabel: isAdmin ? "Return to Dashboard" : "Go Home",
        variant: "danger"
      });
    }
    if (error.message === "SINGER_NOT_FOUND") {
      return renderStatusPage(res, 400, {
        heading: "Singer Profile Required",
        messageHtml: "Singer profile not found in directory. Please sign in through Singer Hub.",
        backHref: "/singer/login",
        backLabel: "Sign In"
      });
    }
    if (error.name === "SequelizeValidationError") {
      const msg =
        error.errors && error.errors.length
          ? error.errors.map((e) => e.message).join(", ")
          : error.message;
      return renderStatusPage(res, 400, {
        heading: "Submission Validation Error",
        messageHtml: `Please check your inputs: <strong>${escapeHtml(msg)}</strong>`,
        backHref: backUrl,
        backLabel: "Return to Form",
        variant: "danger"
      });
    }
    if (
      error.parent?.code === "SQLITE_BUSY" ||
      error.name === "SequelizeTimeoutError" ||
      (error.message && error.message.includes("database is locked"))
    ) {
      return renderStatusPage(res, 503, {
        heading: "Server Busy",
        messageHtml:
          "The database is currently processing multiple offerings. Please tap below to try again in a moment.",
        backHref: backUrl,
        backLabel: "Retry Submission",
        variant: "warning"
      });
    }
    if (error.name === "SequelizeUniqueConstraintError") {
      return renderStatusPage(res, 409, {
        heading: "Slot Already Taken",
        messageHtml: `Another devotee just submitted this bhajan or slot.`,
        details: {
          singer_name: "Another devotee",
          title: req.body.title || "Selected Bhajan",
          time: new Date().toLocaleTimeString()
        },
        backHref: backUrl,
        variant: "danger"
      });
    }
    console.error(`[Req ${req.id || ""}] submitForm error:`, error);
    return renderStatusPage(res, 500, {
      heading: "Unable to Complete Submission",
      messageHtml:
        "An unexpected error occurred while processing your bhajan submission. Your inputs remain available &mdash; please tap below to return and try again.",
      backHref: backUrl,
      backLabel: "Return to Form",
      variant: "danger"
    });
  }
};

exports.planView = async (req, res) => {
  try {
    let sessionDate = req.query.session_date;

    const [{ dates: availableDatesMap, status }, pastSessions, catalog] = await Promise.all([
      getAvailableDates(),
      BhajanSubmission.findAll({
        attributes: [[Sequelize.fn("DISTINCT", Sequelize.col("session_date")), "session_date"]],
        order: [["session_date", "DESC"]],
        limit: 20,
        raw: true
      }),
      getMasterCatalog()
    ]);

    const dateOptionsList = [];
    const seenDates = new Set();

    if (status.isThursdayLiveActive) {
      seenDates.add(status.todayStr);
      dateOptionsList.push({
        date: status.todayStr,
        label: `${status.todayStr} (Today's Live Session — 7:30 PM to 8:30 PM)`,
        isCurrent: false
      });
    }

    const upcomingThursday = status.openThursday || status.nextThursdayDate;
    if (upcomingThursday && !seenDates.has(upcomingThursday)) {
      seenDates.add(upcomingThursday);
      dateOptionsList.push({
        date: upcomingThursday,
        label: `${upcomingThursday} (Upcoming Thursday)`,
        isCurrent: false
      });
    }

    availableDatesMap.forEach((meta, d) => {
      if (!seenDates.has(d)) {
        seenDates.add(d);
        dateOptionsList.push({
          date: d,
          label: `${d} (${meta.label}${meta.desc ? " - " + meta.desc : ""})`,
          isCurrent: false
        });
      }
    });

    pastSessions.forEach((p) => {
      const d = p.session_date;
      if (!seenDates.has(d)) {
        seenDates.add(d);
        dateOptionsList.push({ date: d, label: `${d} (Past Session)`, isCurrent: false });
      }
    });

    if (!sessionDate) {
      if (status.isThursdayLiveActive) {
        sessionDate = status.todayStr;
      } else {
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
      dateOptionsList.unshift({ date: sessionDate, label: sessionDate, isCurrent: true });
    }

    const [results, sessionAudio] = await Promise.all([
      BhajanSubmission.findAll({ where: { session_date: sessionDate }, raw: true }),
      SessionAudio.findOne({
        where: { session_date: sessionDate, is_published: true },
        include: [{ model: SessionAudioTimestamp, as: "timestamps" }],
        order: [[{ model: SessionAudioTimestamp, as: "timestamps" }, "start_seconds", "ASC"]]
      }).catch((audioErr) => {
        console.warn("Could not load plan session audio:", audioErr.message);
        return null;
      })
    ]);

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
      return (a.singer_name || "")
        .toLowerCase()
        .localeCompare((b.singer_name || "").toLowerCase());
    });

    const timestampMap = new Map();
    if (sessionAudio && sessionAudio.timestamps) {
      sessionAudio.timestamps.forEach((t) => {
        if (t.submission_id) timestampMap.set(`sub_${t.submission_id}`, t);
        if (t.bhajan_title) timestampMap.set(`title_${normalizeBhajanTitle(t.bhajan_title)}`, t);
      });
    }

    let rowsHtml = "";
    let timelineCardsHtml = "";
    const whatsappItems = [];

    if (sorted.length === 0) {
      rowsHtml =
        '<tr><td colspan="6" style="text-align:center; padding:36px; color:var(--ink-soft);">No bhajans scheduled for this date yet.</td></tr>';
      timelineCardsHtml = `<div class="plan-empty-state">
        <div class="plan-empty-icon">🪔</div>
        <h3 style="margin:0 0 6px 0; font-size:17px; font-weight:700;">No Bhajans Scheduled Yet</h3>
        <p style="font-size:13.5px; color:var(--ink-soft); margin:0 0 16px 0;">Be the first to submit a bhajan slot for this session!</p>
        <a href="/submit-form?session_date=${encodeURIComponent(sessionDate)}" class="button" style="display:inline-flex; align-items:center; gap:6px; text-decoration:none;">Submit Bhajan Slot</a>
      </div>`;
    } else {
      sorted.forEach((item, index) => {
        const stepNum = index + 1;
        const lowerTitle = String(item.title || "").trim().toLowerCase();
        const matchedMaster =
          catalog.byExactLowerTitle.get(lowerTitle) ||
          catalog.byNormTitle.get(normalizeTitleKey(item.title));
        const sheetFilename = matchedMaster ? matchedMaster.sheet_filename : null;
        const westernKey = getWesternScale(item.scale);
        const deityIcon = getDeityIcon(item.deity);

        const itemTimestamp =
          (item.id && timestampMap.get(`sub_${item.id}`)) ||
          timestampMap.get(`title_${normalizeBhajanTitle(item.title)}`);

        let audioBtnHtml = "";
        if (itemTimestamp && sessionAudio && sessionAudio.audio_url) {
          const m = Math.floor(itemTimestamp.start_seconds / 60);
          const s = itemTimestamp.start_seconds % 60;
          const timeFormatted = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
          audioBtnHtml = `<button type="button" class="plan-card-action-btn plan-action-audio btn-play-bhajan no-print" data-start="${itemTimestamp.start_seconds}" data-title="${escapeHtml(item.title)}" data-singer="${escapeHtml(item.singer_name)}" data-url="${escapeHtml(sessionAudio.audio_url)}" onclick="window.playSessionAudioBtn && window.playSessionAudioBtn(this)" title="Play bhajan recording at ${timeFormatted}">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            <span>${timeFormatted}</span>
          </button>`;
        }

        const sheetBtnHtml = sheetFilename
          ? `<a href="/sheets/${encodeURIComponent(sheetFilename)}" target="_blank" rel="noopener noreferrer" class="plan-card-action-btn plan-action-sheet sheet-link-pill no-print" title="Open official reference sheet music (PDF)"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg><span>Sheet</span></a>`
          : "";
        const lyricsBtnHtml = matchedMaster
          ? `<button type="button" class="plan-card-action-btn plan-action-lyrics btn-quick-lyrics no-print" onclick="window.openPlanLyrics && window.openPlanLyrics(${matchedMaster.id})" title="Read full lyrics"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path></svg><span>Lyrics</span></button>`
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
                ${sheetBtnHtml || lyricsBtnHtml || audioBtnHtml ? `<div class="timeline-actions-row table-actions-row no-print">${sheetBtnHtml}${lyricsBtnHtml}${audioBtnHtml}</div>` : ""}
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
                ${sheetBtnHtml || lyricsBtnHtml || audioBtnHtml ? `<div class="timeline-actions-row no-print">${sheetBtnHtml}${lyricsBtnHtml}${audioBtnHtml}</div>` : ""}
              </div>
              <div class="timeline-singer-row">
                <span class="timeline-avatar">${initials}</span>
                <div class="timeline-singer-info">
                  <span class="timeline-singer-name">${escapeHtml(item.singer_name)}</span>
                  ${item.partner_name ? `<span class="timeline-partner-tag">with ${escapeHtml(item.partner_name)}</span>` : ""}
                </div>
              </div>
              <div class="timeline-accompanist-strip">
                <div class="acc-tile">
                  <span class="acc-tile-icon" aria-hidden="true">🎹</span>
                  <div class="acc-tile-text">
                    <span class="acc-label">Pitch / Scale</span>
                    <span class="acc-value">
                      ${escapeHtml(item.scale || "N/A")}
                      ${westernKey !== "-" ? `<span class="acc-key-tag">${westernKey}</span>` : ""}
                    </span>
                  </div>
                </div>
                <div class="acc-tile">
                  <span class="acc-tile-icon" aria-hidden="true">🥁</span>
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
    } catch (_) {}

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

    res.render("plan-view", {
      pageTitle: `Live Plan – ${sessionDateHuman}`,
      page: "plan-view",
      sessionDate,
      sessionDateHuman,
      rowsHtml,
      timelineCardsHtml,
      dateOptionsList,
      submissionsCount: sorted.length,
      isUpcoming: sessionDate >= getLocalDateStr(),
      isAdmin,
      whatsappText,
      whatsappEncoded,
      sessionAudio
    });
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
      where: { session_date },
      raw: true
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

exports.sessionLink = async (req, res) => {
  try {
    let sessionDate = req.query.session_date || req.query.date;
    const { status: thuStatus } = await getAvailableDates();

    if (!sessionDate) {
      sessionDate = thuStatus.openThursday;
    }

    if (!sessionDate) {
      return res.redirect("/database");
    }

    const todayStr = getLocalDateStr();
    const isPastOrToday = todayStr >= sessionDate;

    const [sYear, sMonth, sDay] = sessionDate.split("-").map(Number);
    const dayOfWeek = new Date(sYear, sMonth - 1, sDay).getDay();
    const isThursday = dayOfWeek === 4;

    const [meta, permission] = await Promise.all([
      SessionMeta.findByPk(sessionDate, { raw: true }),
      SessionPermission.findByPk(sessionDate, { raw: true })
    ]);

    const isManuallyLocked = Boolean(meta && meta.is_locked);
    const isNextThuUnopened =
      sessionDate === thuStatus.nextThursdayDate && thuStatus.opensAt8pmToday;

    if (isPastOrToday || isManuallyLocked || isNextThuUnopened || (!isThursday && !permission)) {
      return res.redirect("/database");
    }

    return res.redirect(`/submit-form?session_date=${sessionDate}`);
  } catch (error) {
    console.error("sessionLink error:", error);
    res.redirect("/database");
  }
};
