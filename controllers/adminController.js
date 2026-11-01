const { Sequelize } = require("sequelize");
const sequelize = require("../config/database");
const activityService = require("../services/activityService");
const BhajanSubmission = require("../models/BhajanSubmission");
const SessionPermission = require("../models/SessionPermission");
const SessionMeta = require("../models/SessionMeta");
const DeityRule = require("../models/DeityRule");
const AdminUser = require("../models/AdminUser");
const SessionAudio = require("../models/SessionAudio");
const SessionAudioTimestamp = require("../models/SessionAudioTimestamp");
const bcrypt = require("bcrypt");
const path = require("path");
const {
  validateCopySession,
  validateUpdatePermission,
  validateReorder,
  validateToggleLock
} = require("../services/validators");
const { createBackup, getOrGenerateBackup } = require("../services/backupService");
const {
  getLocalDateStr,
  deityOrderKey,
  DEITY_ORDER,
  getWesternScale,
  getDeityIcon,
  invalidateMissingCount
} = require("../services/helpers");
const { matchWithIndex } = require("../services/fuzzyMatcher");
const { getMasterCatalog, normalizeTitleKey } = require("../services/catalogCache");
const { escapeHtml } = require("../templates");
const { parseBatchSessions } = require("../scripts/import_sessions");

exports.dashboard = async (req, res) => {
  try {
    const today = new Date();
    const year = parseInt(req.query.year, 10) || today.getFullYear();
    const month = parseInt(req.query.month, 10) || today.getMonth() + 1;

    const startDateStr = `${year}-${String(month).padStart(2, "0")}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const endDateStr = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

    const [
      submissions,
      permissions,
      totalSessions,
      catalog,
      totalSingers,
      nextSession,
      recentActivity
    ] = await Promise.all([
      BhajanSubmission.findAll({
        attributes: ["session_date"],
        where: {
          session_date: {
            [Sequelize.Op.between]: [startDateStr, endDateStr]
          }
        },
        raw: true
      }),
      SessionPermission.findAll({
        where: {
          date: {
            [Sequelize.Op.between]: [startDateStr, endDateStr]
          }
        },
        raw: true
      }),
      SessionMeta.count(),
      getMasterCatalog(),
      BhajanSubmission.count({
        distinct: true,
        col: "singer_name"
      }),
      SessionPermission.findOne({
        where: {
          date: {
            [Sequelize.Op.gte]: getLocalDateStr()
          }
        },
        order: [["date", "ASC"]]
      }),
      activityService.getRecent(10)
    ]);

    const totalBhajans = catalog.lightRows.length;
    const permissionMap = {};
    const descriptionMap = {};

    permissions.forEach((p) => {
      permissionMap[p.date] = p.type;
      descriptionMap[p.date] = p.description;
    });

    const eventCounts = {};
    submissions.forEach((s) => {
      eventCounts[s.session_date] = (eventCounts[s.session_date] || 0) + 1;
    });

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
    const daysInMonth = new Date(year, month, 0).getDate();
    const firstDayIndex = new Date(year, month - 1, 1).getDay();

    const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    let calendarHeadersHtml = "";
    for (const wd of weekdays) {
      calendarHeadersHtml += `<div class="calendar-day-header">${wd}</div>`;
    }

    let calendarCells = "";
    for (let i = 0; i < firstDayIndex; i++) {
      calendarCells += `<div class="calendar-day empty"></div>`;
    }

    const todayDate = new Date();
    const isCurrentMonth = todayDate.getFullYear() === year && todayDate.getMonth() + 1 === month;
    const todayStrGlobal = `${todayDate.getFullYear()}-${String(todayDate.getMonth() + 1).padStart(2, "0")}-${String(todayDate.getDate()).padStart(2, "0")}`;

    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const count = eventCounts[dateStr] || 0;
      const perm = permissionMap[dateStr];
      const desc = descriptionMap[dateStr] || "";

      const dow = new Date(year, month - 1, day).getDay();
      const isThursday = dow === 4;
      const isPast = dateStr < todayStrGlobal;

      let colorClass = "day-none";
      let pillHtml = count ? `<div class="event-pill">${count} Bhajans</div>` : "";

      if (perm === "special") {
        colorClass = "day-special";
      } else if (perm === "festival") {
        colorClass = "day-festival-perm";
      } else if (count > 0) {
        colorClass = isThursday ? "day-thursday" : "day-festival";
      } else if (isThursday && !isPast) {
        colorClass = "day-thursday-upcoming";
        pillHtml = `<div class="event-pill pill-muted">Regular Session</div>`;
      } else if (isThursday && isPast) {
        colorClass = "day-thursday-missed";
        pillHtml = `<div class="event-pill pill-missed">Missed Session</div>`;
      }

      let mobileIndicatorHtml = "";
      if (count > 0) {
        mobileIndicatorHtml = `<span class="mobile-count-pill">${count}</span>`;
      } else if (isThursday && !isPast) {
        mobileIndicatorHtml = `<span class="mobile-thu-indicator">Thu</span>`;
      } else if (isThursday && isPast) {
        mobileIndicatorHtml = `<span class="mobile-missed-indicator">✕</span>`;
      }

      let mobilePermHtml = "";
      if (perm === "special") {
        mobilePermHtml = `<span class="mobile-perm-pill special">✨ Spec</span>`;
      } else if (perm === "festival") {
        mobilePermHtml = `<span class="mobile-perm-pill festival">🪔 Fest</span>`;
      }

      const isToday = isCurrentMonth && todayDate.getDate() === day;

      calendarCells += `
<div class="calendar-day ${colorClass} ${isToday ? "today" : ""}"
onclick="openAdminDateModal('${dateStr}','${perm || ""}','${desc.replace(/'/g, "&apos;")}')">
  <div class="calendar-date-num">${day}</div>
  <div class="calendar-actions desktop-only">
    ${pillHtml}
    ${perm ? `<div class="perm-pill">${perm.toUpperCase()}</div>` : ""}
  </div>
  <div class="calendar-actions-mobile mobile-only">
    ${mobileIndicatorHtml}
    ${mobilePermHtml}
  </div>
</div>`;
    }

    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear = month === 1 ? year - 1 : year;
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;

    res.render("admin-dashboard", {
      page: "dashboard",
      pageTitle: "Dashboard",
      showLoader: false,
      isAdminPage: true,
      year,
      month,
      currentMonthName,
      calendarHeadersHtml,
      calendarCells,
      prevMonth,
      prevYear,
      nextMonth,
      nextYear,
      eventCounts,
      permissionMap,
      descriptionMap,
      stats: {
        totalSessions,
        totalBhajans,
        totalSingers,
        nextSession
      },
      recentActivity
    });
  } catch (error) {
    console.error(`[Req ${req.id || ""}] admin dashboard error:`, error);
    res.status(500).send(`<h1>Error</h1><p>${escapeHtml(error.message)}</p>`);
  }
};

exports.sessionView = async (req, res) => {
  try {
    const { date } = req.params;

    const [submissions, meta, sessionPerm, catalog, recentSessions, sessionAudio] =
      await Promise.all([
        BhajanSubmission.findAll({ where: { session_date: date } }),
        SessionMeta.findByPk(date),
        SessionPermission.findByPk(date),
        getMasterCatalog(),
        BhajanSubmission.findAll({
          attributes: ["session_date", [Sequelize.fn("COUNT", Sequelize.col("id")), "bhajan_count"]],
          where: { session_date: { [Sequelize.Op.ne]: date } },
          group: ["session_date"],
          order: [["session_date", "DESC"]],
          limit: 12,
          raw: true
        }),
        SessionAudio.findOne({
          where: { session_date: date },
          include: [{ model: SessionAudioTimestamp, as: "timestamps" }],
          order: [[{ model: SessionAudioTimestamp, as: "timestamps" }, "start_seconds", "ASC"]]
        }).catch((audioErr) => {
          console.warn("Could not load session audio:", audioErr.message);
          return null;
        })
      ]);

    const sorted = submissions.sort((a, b) => {
      if (a.list_order > 0 || b.list_order > 0) {
        if (a.list_order === 0) return 1;
        if (b.list_order === 0) return -1;
        return a.list_order - b.list_order;
      }
      const deityCompare = deityOrderKey(a.deity) - deityOrderKey(b.deity);
      if (deityCompare !== 0) return deityCompare;
      return a.singer_name.toLowerCase().localeCompare(b.singer_name.toLowerCase());
    });

    const isLocked = meta ? meta.is_locked : false;

    const enrichedSubmissions = sorted.map((sub, idx) => {
      const plain = sub.get ? sub.get({ plain: true }) : { ...sub };
      const lowerTitle = String(plain.title || "").trim().toLowerCase();
      const matched =
        catalog.byExactLowerTitle.get(lowerTitle) ||
        catalog.byNormTitle.get(normalizeTitleKey(plain.title));
      if (matched) {
        plain.sheet_filename = matched.sheet_filename || null;
        plain.master_id = matched.id;
      }
      plain.displayOrder = idx + 1;
      plain.westernScale = getWesternScale(plain.scale);
      plain.deityIcon = getDeityIcon(plain.deity);
      return plain;
    });

    let humanDate = date;
    let dayOfWeek = "";
    try {
      const [y, m, d] = date.split("-").map(Number);
      const dateObj = new Date(y, m - 1, d);
      dayOfWeek = dateObj.toLocaleDateString("en-US", { weekday: "long" });
      humanDate = dateObj.toLocaleDateString("en-US", {
        weekday: "long",
        day: "numeric",
        month: "short",
        year: "numeric"
      });
    } catch (_) {}

    const uniqueSingers = new Set(
      enrichedSubmissions.map((s) =>
        String(s.singer_name || "")
          .trim()
          .toLowerCase()
      )
    ).size;
    const deityCounts = {};
    const speedCounts = { slow: 0, medium: 0, fast: 0 };

    enrichedSubmissions.forEach((s) => {
      const d = s.deity || "Unknown";
      deityCounts[d] = (deityCounts[d] || 0) + 1;
      const sp = (s.speed || "medium").toLowerCase();
      if (speedCounts[sp] !== undefined) speedCounts[sp]++;
      else speedCounts.medium++;
    });

    const uniqueDeities = Object.keys(deityCounts).length;
    const speedBreakdown = {
      med: speedCounts.medium,
      fast: speedCounts.fast,
      slow: speedCounts.slow
    };

    const ganeshaOpening =
      enrichedSubmissions.length > 0 &&
      String(enrichedSubmissions[0].deity || "")
        .toLowerCase()
        .includes("ganesh");
    const saiIncluded = enrichedSubmissions.some((s) =>
      String(s.deity || "")
        .toLowerCase()
        .includes("sai")
    );

    const consecutiveRepeats = [];
    for (let i = 0; i < enrichedSubmissions.length - 1; i++) {
      if (
        String(enrichedSubmissions[i].deity || "").toLowerCase() ===
        String(enrichedSubmissions[i + 1].deity || "").toLowerCase()
      ) {
        consecutiveRepeats.push({
          index1: i + 1,
          index2: i + 2,
          deity: enrichedSubmissions[i].deity,
          song1: enrichedSubmissions[i].title,
          song2: enrichedSubmissions[i + 1].title
        });
      }
    }

    const protocol = req.protocol || "http";
    const host = req.get("host") || "localhost:8000";
    const livePlanUrl = `${protocol}://${host}/plan-view?session_date=${date}`;

    const whatsappItems = enrichedSubmissions.map((item, idx) => {
      const scaleStr = item.scale
        ? `${item.scale}${item.westernScale && item.westernScale !== "-" ? ` (${item.westernScale})` : ""}`
        : "N/A";
      const speedStr = item.speed
        ? item.speed.charAt(0).toUpperCase() + item.speed.slice(1)
        : "Medium";
      const partnerStr = item.partner_name ? ` (with ${item.partner_name})` : "";

      return `${idx + 1}. [${item.deity}] ${item.title}\n   Singer: ${item.singer_name}${partnerStr}\n   Pitch: ${scaleStr} | Tempo: ${speedStr}`;
    });

    let whatsappText = `*SRI SATHYA SAI SEVA ORGANISATION*\n*BHAJAN PROGRAM – ${humanDate}*\nTotal Bhajans: ${enrichedSubmissions.length}\n--------------------------------------------------\n\n`;
    whatsappText +=
      whatsappItems.length > 0
        ? whatsappItems.join("\n\n") + "\n\n"
        : "No bhajans scheduled for this date yet.\n\n";
    whatsappText += `--------------------------------------------------\nSai Ram to all Accompanists & Devotees\nLive Plan: ${livePlanUrl}`;
    const whatsappEncoded = encodeURIComponent(whatsappText);

    const isUpcoming = date >= getLocalDateStr();

    res.render("admin-session-view", {
      date,
      humanDate,
      dayOfWeek,
      sessionPerm,
      submissions: enrichedSubmissions,
      isLocked,
      isUpcoming,
      sessionAudio,
      totalBhajans: enrichedSubmissions.length,
      uniqueSingers,
      uniqueDeities,
      speedBreakdown,
      deityCounts,
      speedCounts,
      ganeshaOpening,
      saiIncluded,
      consecutiveRepeats,
      whatsappText,
      whatsappEncoded,
      livePlanUrl,
      recentSessions,
      pageTitle: `Session Sequencer - ${date}`,
      isAdminPage: true,
      pageCSS: "admin.css",
      page: "sessions"
    });
  } catch (error) {
    console.error(`[Req ${req.id || ""}] sessionView error:`, error);
    res.status(500).send(`<h1>Error</h1><p>${escapeHtml(error.message)}</p>`);
  }
};

exports.editSubmissionForm = async (req, res) => {
  try {
    const submission = await BhajanSubmission.findByPk(req.params.id);
    if (!submission) return res.status(404).send("Entry not found");
    res.render("admin-edit-submission", {
      s: submission,
      pageTitle: "Edit Bhajan Entry"
    });
  } catch (error) {
    res.status(500).send(`<h1>Error</h1><p>${escapeHtml(error.message)}</p>`);
  }
};

exports.updateSubmission = async (req, res) => {
  try {
    const { session_date, singer_name, partner_name, title, deity, scale, speed, raga } = req.body;
    await BhajanSubmission.update(
      {
        session_date,
        singer_name,
        partner_name,
        title,
        deity,
        scale,
        speed,
        raga: raga || null
      },
      {
        where: { id: req.params.id }
      }
    );
    invalidateMissingCount();
    res.redirect(`/admin/date/${session_date}`);
  } catch (error) {
    res.status(500).send(`<h1>Error</h1><p>${escapeHtml(error.message)}</p>`);
  }
};

exports.deleteSubmission = async (req, res) => {
  try {
    const submission = await BhajanSubmission.findByPk(req.params.id);
    if (submission) {
      const date = submission.session_date;
      await submission.destroy();
      invalidateMissingCount();
      res.redirect(`/admin/date/${date}`);
    } else {
      res.redirect("/admin");
    }
  } catch (error) {
    res.status(500).send(`<h1>Error</h1><p>${escapeHtml(error.message)}</p>`);
  }
};

exports.showRules = async (req, res) => {
  try {
    const date = req.query.date || "default";

    const defaultDeities = DEITY_ORDER || [
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

    const existingDefaultRules = await DeityRule.findAll({
      where: { session_date: "default" }
    });
    const existingSet = new Set(existingDefaultRules.map((r) => r.deity_name));
    const missingDefaults = defaultDeities
      .filter((d) => !existingSet.has(d))
      .map((d) => ({
        session_date: "default",
        deity_name: d,
        min_required: 0,
        max_allowed: 2
      }));
    if (missingDefaults.length > 0) {
      await DeityRule.bulkCreate(missingDefaults, { ignoreDuplicates: true });
    }

    let rules =
      date === "default" && missingDefaults.length === 0
        ? existingDefaultRules
        : await DeityRule.findAll({ where: { session_date: date } });

    if (rules.length === 0 && date !== "default") {
      rules = await DeityRule.findAll({ where: { session_date: "default" } });
    }

    rules.sort((a, b) => deityOrderKey(a.deity_name) - deityOrderKey(b.deity_name));

    res.render("admin-rules", {
      rules,
      date,
      pageTitle: date === "default" ? "Default Deity Rules" : `Rules for ${date}`,
      isAdminPage: true,
      pageCSS: "admin.css",
      page: "rules"
    });
  } catch (error) {
    res.status(500).send(`<h1>Error</h1><p>${escapeHtml(error.message)}</p>`);
  }
};

exports.updateRules = async (req, res) => {
  try {
    const newRules = req.body.rules;
    const date = req.body.date || "default";
    await sequelize.transaction(async (t) => {
      for (const rule of newRules) {
        const existing = await DeityRule.findOne({
          where: { session_date: date, deity_name: rule.deity_name },
          transaction: t
        });
        if (existing) {
          await existing.update(
            {
              min_required: rule.min_required,
              max_allowed: rule.max_allowed
            },
            { transaction: t }
          );
        } else {
          await DeityRule.create(
            {
              session_date: date,
              deity_name: rule.deity_name,
              min_required: rule.min_required,
              max_allowed: rule.max_allowed
            },
            { transaction: t }
          );
        }
      }
    });
    res.json({ success: true, message: "Rules successfully saved!" });
  } catch (error) {
    res.status(500).json({ error: "Failed to save deity rules." });
  }
};

exports.updatePermission = async (req, res) => {
  try {
    const validation = validateUpdatePermission(req.body);
    if (!validation.valid) {
      return res.status(400).json({ error: "Validation failed", details: validation.errors });
    }
    const { date, type, description } = validation.data;
    if (type === "clear") {
      await SessionPermission.destroy({ where: { date } });
    } else {
      await SessionPermission.upsert({ date, type, description });
    }
    res.json({ success: true });
  } catch (error) {
    console.error("updatePermission error:", error);
    res.status(500).json({ error: "Unable to update session permissions." });
  }
};

exports.toggleLock = async (req, res) => {
  try {
    const validation = validateToggleLock(req.body);
    if (!validation.valid) {
      return res.status(400).json({ error: "Validation failed", details: validation.errors });
    }
    const { date, is_locked } = validation.data;
    await SessionMeta.upsert({ session_date: date, is_locked });

    if (is_locked) {
      try {
        const { triggerSchedulePublished } = require("../services/sessionScheduler");
        await triggerSchedulePublished(date);
      } catch (err) {
        console.error("Schedule published notification failed:", err.message);
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error("toggleLock error:", error);
    res.status(500).json({ error: "Unable to update session lock." });
  }
};

exports.reorderBhajans = async (req, res) => {
  try {
    const validation = validateReorder(req.body);
    if (!validation.valid) {
      return res.status(400).json({ error: "Validation failed", details: validation.errors });
    }
    const orderData = validation.data;
    await sequelize.transaction(async (t) => {
      for (const item of orderData) {
        await BhajanSubmission.update(
          { list_order: item.order },
          { where: { id: item.id }, transaction: t }
        );
      }
    });
    res.json({ success: true });
  } catch (error) {
    console.error("reorderBhajans error:", error);
    res.status(500).json({ error: "Unable to save new order." });
  }
};

exports.copySession = async (req, res) => {
  try {
    const validation = validateCopySession(req.body);
    if (!validation.valid) {
      return res.status(400).json({ error: "Validation failed", details: validation.errors });
    }
    const { source_date, target_date } = validation.data;

    await sequelize.transaction(async (t) => {
      const sourceSubs = await BhajanSubmission.findAll({
        where: { session_date: source_date },
        raw: true,
        transaction: t
      });

      const newSubs = sourceSubs.map((s) => {
        delete s.id;
        s.session_date = target_date;
        s.list_order = 0;
        s.created_at = new Date();
        return s;
      });
      if (newSubs.length > 0) {
        await BhajanSubmission.bulkCreate(newSubs, { transaction: t });
      }
    });

    res.redirect(`/admin/date/${encodeURIComponent(target_date)}`);
  } catch (e) {
    console.error("copySession error:", e);
    res.status(500).send("Unable to copy session at this time.");
  }
};

exports.showDangerResetHistory = (req, res) => {
  res.render("admin-danger-reset", { page: "danger", pageTitle: "Reset History", error: null });
};

exports.dangerResetHistory = async (req, res) => {
  try {
    const { confirmation, admin_password } = req.body;
    if ((confirmation || "").trim() !== "DELETE ALL HISTORY") {
      return res.status(400).render("admin-danger-reset", {
        page: "danger",
        pageTitle: "Reset History",
        error: "Confirmation phrase did not match 'DELETE ALL HISTORY'."
      });
    }

    const adminId = req.session?.admin?.id || req.session?.adminUserId;
    if (!adminId) {
      return res.status(403).send("Unauthorized: Admin session required.");
    }

    const admin = await AdminUser.scope("withSecrets").findByPk(adminId);
    if (!admin) {
      return res.status(403).send("Unauthorized: Admin record not found.");
    }

    const passwordMatches = await bcrypt.compare(admin_password || "", admin.password_hash);
    if (!passwordMatches) {
      return res.status(403).render("admin-danger-reset", {
        page: "danger",
        pageTitle: "Reset History",
        error: "Incorrect administrator password."
      });
    }

    await createBackup("before_danger_reset");

    await sequelize.transaction(async (t) => {
      await BhajanSubmission.destroy({ where: {}, truncate: true, transaction: t });
      await SessionMeta.destroy({ where: {}, truncate: true, transaction: t });
    });
    invalidateMissingCount();

    try {
      await sequelize.query("DROP TABLE IF EXISTS bhajan_submissions");
    } catch (_) {}

    res.send(`
      <!DOCTYPE html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/css/style.css"><title>Reset Complete</title></head>
      <body style="text-align:center; padding:50px; background:#fff5f5;">
        <h1 style="color:#e03131; font-size:40px;">🚨 History Wiped!</h1>
        <p style="font-size:18px; margin-bottom:20px;">All past bhajan submissions and session locks have been permanently deleted.</p>
        <p style="font-size:14px; color:#555; margin-bottom:30px;">A pre-wipe backup was automatically preserved in the backups directory.</p>
        <a class="button" href="/admin" style="background:#b23b32; color:#fff; padding:12px 24px; text-decoration:none; border-radius:6px;">Return to Control Tower</a>
      </body></html>
    `);
  } catch (error) {
    console.error("dangerResetHistory error:", error);
    res.status(500).send("Failed to execute danger reset.");
  }
};

exports.downloadBackup = async (req, res) => {
  try {
    const backupPath = await getOrGenerateBackup();
    res.download(backupPath, path.basename(backupPath));
  } catch (err) {
    console.error("downloadBackup error:", err);
    res.status(500).send("Unable to prepare database backup for download.");
  }
};

exports.showImportSessions = (req, res) => {
  res.render("admin-import-sessions", {
    resultInfo: null,
    pageTitle: "Import Past Sessions"
  });
};

exports.processImportSessions = async (req, res) => {
  try {
    const rawText = req.body.raw_text;
    if (!rawText || !rawText.trim()) {
      return res.render("admin-import-sessions", {
        resultInfo: { error: "No text provided. Please paste session data." },
        pageTitle: "Import Past Sessions"
      });
    }

    const result = await parseBatchSessions(rawText);
    if (!result || result.totalSessions === 0) {
      return res.render("admin-import-sessions", {
        resultInfo: {
          error:
            "No valid dates found in the text. Make sure dates are formatted as DD/MM/YYYY or 'Bhajan Plan – YYYY-MM-DD'."
        },
        pageTitle: "Import Past Sessions"
      });
    }
    invalidateMissingCount();

    res.render("admin-import-sessions", {
      resultInfo: result,
      pageTitle: "Import Past Sessions"
    });
  } catch (error) {
    res.render("admin-import-sessions", {
      resultInfo: { error: error.message },
      pageTitle: "Import Past Sessions"
    });
  }
};

exports.showMissingBhajans = async (req, res) => {
  try {
    const [submittedTitles, catalog] = await Promise.all([
      BhajanSubmission.findAll({
        attributes: [[Sequelize.fn("DISTINCT", Sequelize.col("title")), "title"]],
        raw: true
      }),
      getMasterCatalog()
    ]);

    const rawMissingTitles = submittedTitles
      .map((s) => (s.title || "").trim())
      .filter((title) => title && !catalog.byExactLowerTitle.has(title.toLowerCase()));

    const totalMissing = rawMissingTitles.length;
    const PAGE_SIZE = 50;
    const totalPages = Math.max(1, Math.ceil(totalMissing / PAGE_SIZE));
    let currentPage = parseInt(req.query.page, 10) || 1;
    if (currentPage < 1) currentPage = 1;
    if (currentPage > totalPages) currentPage = totalPages;

    const startIndex = (currentPage - 1) * PAGE_SIZE;
    const pageTitles = rawMissingTitles.slice(startIndex, startIndex + PAGE_SIZE);

    const missingBhajans =
      pageTitles.length > 0
        ? pageTitles.map((submittedTitle) => ({
            submittedTitle,
            candidates: matchWithIndex(submittedTitle, catalog.fuzzyIndex, 0.45, 4)
          }))
        : [];

    res.render("admin-missing-bhajans", {
      page: "missing-bhajans",
      pageTitle: "Missing Bhajan Catcher",
      missingBhajans,
      totalMissing,
      missingCount: totalMissing,
      currentPage,
      totalPages,
      hasPrev: currentPage > 1,
      hasNext: currentPage < totalPages,
      pageSize: PAGE_SIZE,
      startIndex: totalMissing === 0 ? 0 : startIndex + 1,
      endIndex: Math.min(startIndex + pageTitles.length, totalMissing)
    });
  } catch (error) {
    console.error(`[Req ${req.id || ""}] showMissingBhajans error:`, error);
    res.status(500).send(`<h1>Error</h1><p>${escapeHtml(error.message)}</p>`);
  }
};
