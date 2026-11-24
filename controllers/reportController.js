const crypto = require("crypto");
const { Sequelize, Op } = require("sequelize");
const BhajanReport = require("../models/BhajanReport");
const ActivityLog = require("../models/ActivityLog");
const { getMasterCatalog } = require("../services/catalogCache");
const { resolveVisitorId } = require("../middleware/activityTracker");

function generateTicketCode() {
  const chars = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  let code = "REP-";
  for (let i = 0; i < 10; i++) {
    const idx = crypto.randomInt(0, chars.length);
    code += chars.charAt(idx);
  }
  return code;
}

const BHAJAN_CATEGORY_MAP = {
  lyrics: "Lyrics incorrect or missing lines",
  scale: "Harmonium scale / pitch incorrect",
  raga: "Raga name inaccurate",
  deity: "Deity categorization inaccurate",
  tempo: "Tempo incorrect",
  sheet: "Music sheet notation error",
  spelling: "Title or lyrics spelling typo",
  other: "General correction"
};

const GENERAL_CATEGORY_LABELS = {
  missing_bhajan: "Missing Bhajan Request",
  app_bug: "App Bug Report",
  suggestion: "Feature Suggestion",
  session_audio: "Schedule / Audio Issue",
  account_notif: "Login / Notifications Issue",
  general_other: "General Feedback"
};

const CATEGORY_ALIASES = {
  bug: "app_bug",
  missing: "missing_bhajan",
  feedback: "general_other"
};

const ALL_CATEGORY_DESCRIPTIONS = {
  ...BHAJAN_CATEGORY_MAP,
  ...GENERAL_CATEGORY_LABELS
};

function normalizeCategories(rawCategories) {
  const arr = Array.isArray(rawCategories) ? rawCategories : rawCategories ? [rawCategories] : [];
  const seen = new Set();
  const normalized = [];
  for (const raw of arr) {
    const cleaned = String(raw || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "");
    if (!cleaned) continue;
    const mapped = CATEGORY_ALIASES[cleaned] || cleaned;
    if (Object.prototype.hasOwnProperty.call(ALL_CATEGORY_DESCRIPTIONS, mapped) && !seen.has(mapped)) {
      seen.add(mapped);
      normalized.push(mapped);
    }
  }
  return normalized;
}

// -------------------------------------------------------------
// USER ENDPOINTS
// -------------------------------------------------------------

exports.submitReport = async (req, res) => {
  try {
    const {
      report_type,
      subject,
      master_id,
      bhajan_title,
      categories,
      description,
      suggested_correction,
      reporter_name,
      reporter_contact,
      visitor_id,
      page_context
    } = req.body;

    let normalizedCategories = normalizeCategories(categories);
    const safeDesc = (description || "").toString().trim().slice(0, 2000);

    if (normalizedCategories.length === 0 && !safeDesc) {
      return res
        .status(400)
        .json({ error: "Please select at least one category or provide details." });
    }

    let mid = null;
    if (master_id && !isNaN(parseInt(master_id, 10))) {
      const catalog = await getMasterCatalog();
      const mb = catalog.fullById.get(parseInt(master_id, 10));
      if (mb) mid = mb.id;
    }

    const hasGeneralCat = normalizedCategories.some((c) =>
      Object.prototype.hasOwnProperty.call(GENERAL_CATEGORY_LABELS, c)
    );
    const hasSubjectInput = Boolean(subject !== undefined && String(subject).trim());
    const explicitGeneral = String(report_type || "").trim().toLowerCase() === "general";
    const resolvedType =
      explicitGeneral || (!mid && (hasGeneralCat || hasSubjectInput)) ? "general" : "bhajan";

    if (normalizedCategories.length === 0) {
      normalizedCategories = [resolvedType === "general" ? "general_other" : "other"];
    }

    const rawTitleInput = hasSubjectInput ? subject : bhajan_title;
    let cleanTitle = (rawTitleInput || "")
      .toString()
      .replace(/<[^>]*>/g, "")
      .trim()
      .slice(0, 200);

    if (!cleanTitle) {
      cleanTitle =
        resolvedType === "general"
          ? GENERAL_CATEGORY_LABELS[normalizedCategories[0]] || "General Feedback"
          : "Unknown Bhajan";
    }

    let effectiveDescription = safeDesc;
    if (!effectiveDescription) {
      const labels = normalizedCategories.map((c) => ALL_CATEGORY_DESCRIPTIONS[c] || c);
      effectiveDescription = "Issue reported in: " + labels.join(", ");
    }

    let code = generateTicketCode();
    for (let attempts = 0; attempts < 5; attempts++) {
      const exists = await BhajanReport.findOne({
        where: { ticket_code: code },
        attributes: ["id"],
        raw: true
      });
      if (!exists) break;
      code = generateTicketCode();
    }

    let effectiveSingerId = null;
    let effectiveReporterName =
      (reporter_name || "")
        .toString()
        .replace(/<[^>]*>/g, "")
        .trim()
        .slice(0, 80) || null;

    if (req.session?.singer) {
      effectiveSingerId = req.session.singer.id;
      if (!effectiveReporterName) {
        effectiveReporterName = req.session.singer.name;
      }
    }

    const cleanPageContext =
      (page_context || "")
        .toString()
        .replace(/<[^>]*>/g, "")
        .trim()
        .slice(0, 200) || null;

    const catJson = JSON.stringify(normalizedCategories);
    const resolvedVisitor = visitor_id || resolveVisitorId(req, res) || null;

    const report = await BhajanReport.create({
      ticket_code: code,
      master_id: mid,
      singer_id: effectiveSingerId,
      report_type: resolvedType,
      bhajan_title: cleanTitle,
      categories: catJson,
      description: effectiveDescription,
      suggested_correction: suggested_correction
        ? suggested_correction.toString().trim().slice(0, 2000)
        : null,
      page_context: cleanPageContext,
      reporter_name: effectiveReporterName,
      reporter_contact: reporter_contact ? reporter_contact.toString().trim().slice(0, 100) : null,
      visitor_id: resolvedVisitor,
      status: "pending"
    });

    try {
      await ActivityLog.create({
        session_id: resolvedVisitor || "guest",
        user_type: req.session?.admin ? "admin" : req.session?.singer ? "singer" : "guest",
        username: effectiveReporterName || "Anonymous Devotee",
        action: "REPORT_SUBMITTED",
        details: `[${resolvedType === "general" ? "General" : "Bhajan"}] Report ${code} filed for "${cleanTitle}"`,
        ip_address: req.ip || req.socket?.remoteAddress || "127.0.0.1",
        user_agent: req.headers["user-agent"] || "",
        created_at: new Date()
      });
    } catch (_) {}

    res.status(201).json({
      success: true,
      ticket_code: code,
      report_id: report.id,
      report_type: resolvedType,
      ticket: {
        id: report.id,
        ticket_code: code,
        report_type: resolvedType,
        bhajan_title: cleanTitle,
        categories: normalizedCategories,
        page_context: cleanPageContext,
        status: report.status
      },
      message:
        resolvedType === "general"
          ? "Feedback submitted successfully. Our coordinators will review it soon!"
          : "Report submitted successfully. Thank you for helping keep our Bhajan Bank accurate!"
    });
  } catch (error) {
    console.error(`[Req ${req.id || ""}] Error submitting report:`, error);
    res.status(500).json({ error: "Failed to submit report. Please try again later." });
  }
};

exports.getMyReports = async (req, res) => {
  try {
    const visitorId = req.query.visitor_id || req.cookies?.bp_vid || req.session?.visitorId || null;
    const ticketCodes = req.query.tickets
      ? req.query.tickets
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
      : [];

    const orClauses = [];
    if (visitorId) orClauses.push({ visitor_id: visitorId });
    if (ticketCodes.length > 0) orClauses.push({ ticket_code: { [Op.in]: ticketCodes } });
    if (req.session?.singer) {
      if (req.session.singer.id) orClauses.push({ singer_id: req.session.singer.id });
      if (req.session.singer.name) orClauses.push({ reporter_name: req.session.singer.name });
    }

    if (orClauses.length === 0) {
      return res.json({ reports: [], has_unread_reply: false });
    }

    const reports = await BhajanReport.findAll({
      where: { [Op.or]: orClauses },
      order: [["created_at", "DESC"]]
    });

    const parsed = reports.map((r) => {
      const plain = r.toJSON();
      try {
        plain.categories = JSON.parse(plain.categories);
      } catch (_) {
        plain.categories = [];
      }
      return plain;
    });

    const hasUnreadReply = parsed.some((r) => r.admin_response && !r.user_viewed_reply);

    res.json({
      reports: parsed,
      has_unread_reply: hasUnreadReply
    });
  } catch (error) {
    console.error(`[Req ${req.id || ""}] Error fetching user reports:`, error);
    res.status(500).json({ error: "Failed to retrieve your reports." });
  }
};

exports.getTicketStatus = async (req, res) => {
  try {
    const rawCode = (req.params.code || "").trim().toUpperCase().slice(0, 30);
    if (!/^REP-[A-Z0-9]{5,25}$/.test(rawCode)) {
      return res.status(400).json({ error: "Invalid ticket code format." });
    }
    const report = await BhajanReport.findOne({
      where: { ticket_code: rawCode }
    });

    if (!report) {
      return res.status(404).json({ error: "Ticket not found." });
    }

    const plain = report.toJSON();
    try {
      plain.categories = JSON.parse(plain.categories);
    } catch (_) {
      plain.categories = [];
    }

    res.json(plain);
  } catch (error) {
    console.error(`[Req ${req.id || ""}] Error fetching ticket status:`, error);
    res.status(500).json({ error: "Failed to retrieve ticket status." });
  }
};

exports.markTicketSeen = async (req, res) => {
  try {
    const rawCode = (req.params.code || "").trim().toUpperCase().slice(0, 30);
    if (!/^REP-[A-Z0-9]{5,25}$/.test(rawCode)) {
      return res.status(400).json({ error: "Invalid ticket code format." });
    }
    await BhajanReport.update({ user_viewed_reply: true }, { where: { ticket_code: rawCode } });
    res.json({ success: true });
  } catch (error) {
    console.error(`[Req ${req.id || ""}] Error marking ticket seen:`, error);
    res.status(500).json({ error: "Failed to update ticket." });
  }
};

exports.showMyReportsPage = async (req, res) => {
  try {
    const rawCat = normalizeCategories(req.query.cat);
    const prefillCategory = rawCat.length > 0 ? rawCat[0] : "";
    const openNew = req.query.new === "1" || req.query.compose === "1";
    const fromPage = (req.query.from || "")
      .toString()
      .replace(/<[^>]*>/g, "")
      .trim()
      .slice(0, 200);

    res.render("user-reports", {
      page: "my-reports",
      pageTitle: "Reports & Feedback | Bhajan Planner",
      currentAdmin: req.session.admin || null,
      prefillCategory,
      openNew,
      fromPage
    });
  } catch (error) {
    console.error(`[Req ${req.id || ""}] Error loading user reports page:`, error);
    res.status(500).send("<h1>Error</h1><p>Failed to load reports page.</p>");
  }
};

// -------------------------------------------------------------
// ADMIN ENDPOINTS
// -------------------------------------------------------------

exports.showAdminReports = async (req, res) => {
  try {
    const { status, category, search, type } = req.query;
    const where = {};
    const selectedType = ["bhajan", "general"].includes(type) ? type : "";

    if (selectedType) {
      where.report_type = selectedType;
    }

    if (status && ["pending", "under_review", "resolved", "closed"].includes(status)) {
      where.status = status;
    }

    const normalizedCatFilter = normalizeCategories(category);
    const safeCategory = normalizedCatFilter.length > 0 ? normalizedCatFilter[0] : "";
    if (safeCategory) {
      where.categories = { [Op.like]: `%"${safeCategory}"%` };
    }

    if (search && search.trim()) {
      const q = `%${search.trim()}%`;
      where[Op.or] = [
        { ticket_code: { [Op.like]: q } },
        { bhajan_title: { [Op.like]: q } },
        { reporter_name: { [Op.like]: q } },
        { description: { [Op.like]: q } }
      ];
    }

    // Parallelize filtered report fetch + status & type count queries
    const [reports, statusGroups, typeGroups] = await Promise.all([
      BhajanReport.findAll({
        where,
        order: [["created_at", "DESC"]],
        limit: 200
      }),
      BhajanReport.findAll({
        attributes: ["status", [Sequelize.fn("COUNT", Sequelize.col("id")), "cnt"]],
        group: ["status"],
        raw: true
      }),
      BhajanReport.findAll({
        attributes: ["report_type", [Sequelize.fn("COUNT", Sequelize.col("id")), "cnt"]],
        group: ["report_type"],
        raw: true
      })
    ]);

    const parsedReports = reports.map((r) => {
      const plain = r.toJSON();
      try {
        plain.categories = JSON.parse(plain.categories);
      } catch (_) {
        plain.categories = [];
      }
      return plain;
    });

    const counts = {
      all: 0,
      total: 0,
      pending: 0,
      under_review: 0,
      resolved: 0,
      closed: 0,
      bhajan: 0,
      general: 0
    };
    statusGroups.forEach((g) => {
      const n = parseInt(g.cnt, 10) || 0;
      counts.all += n;
      counts.total += n;
      if (g.status && counts[g.status] !== undefined) {
        counts[g.status] = n;
      }
    });
    typeGroups.forEach((g) => {
      const n = parseInt(g.cnt, 10) || 0;
      const t = g.report_type === "general" ? "general" : "bhajan";
      counts[t] += n;
    });

    res.render("admin-reports", {
      page: "reports",
      pageTitle: "Reports & Devotee Feedback | Admin",
      reports: parsedReports,
      counts,
      selectedStatus: status || "",
      selectedCategory: safeCategory || "",
      selectedType,
      searchQuery: search || "",
      currentAdmin: req.session.admin
    });
  } catch (error) {
    console.error(`[Req ${req.id || ""}] Error loading admin reports:`, error);
    res.status(500).send("<h1>Error</h1><p>Failed to load admin reports dashboard.</p>");
  }
};

exports.updateReport = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, admin_response, admin_notes } = req.body;

    const report = await BhajanReport.findByPk(id);
    if (!report) {
      return res.status(404).json({ error: "Report not found." });
    }

    const admin = req.session.admin;
    const adminName = admin ? admin.display_name || admin.username || "Admin" : "Admin";

    const updatePayload = {
      admin_response: admin_response !== undefined ? admin_response.trim() : report.admin_response,
      admin_notes: admin_notes !== undefined ? admin_notes.trim() : report.admin_notes,
      reviewed_by: adminName,
      reviewed_at: new Date(),
      user_viewed_reply: false
    };

    if (status && ["pending", "under_review", "resolved", "closed"].includes(status)) {
      updatePayload.status = status;
      if (status === "resolved" || status === "closed") {
        updatePayload.resolved_at = new Date();
      }
    }

    await report.update(updatePayload);

    if (report.singer_id) {
      try {
        const notificationService = require("../services/notificationService");
        const statusLabel = (status || report.status).replace("_", " ");
        const isGeneral = report.report_type === "general";
        const notifTitle =
          status === "resolved"
            ? `✅ ${isGeneral ? "Report" : "Ticket"} Resolved: ${report.bhajan_title}`
            : `💬 Coordinator Update: ${report.ticket_code}`;
        const notifBody = admin_response
          ? `${adminName} replied: "${admin_response.slice(0, 100)}${admin_response.length > 100 ? "..." : ""}"`
          : isGeneral
            ? `Your report (${report.ticket_code}) for "${report.bhajan_title}" is now ${statusLabel}.`
            : `Your correction ticket for "${report.bhajan_title}" status is now ${statusLabel}.`;

        await notificationService.createPersonalized({
          type: "report_update",
          title: notifTitle,
          body: notifBody,
          link: `/my-hub#tab-reports`,
          eventKey: `ticket_update:${report.id}:${Date.now()}`,
          singerId: report.singer_id,
          metadata: { ticket_code: report.ticket_code, report_id: report.id, status }
        });
      } catch (notifErr) {
        console.error("Failed to dispatch ticket notification:", notifErr.message);
      }
    }

    res.json({
      success: true,
      message: `Ticket ${report.ticket_code} updated successfully.`,
      report: report.toJSON()
    });
  } catch (error) {
    console.error(`[Req ${req.id || ""}] Error updating report:`, error);
    res.status(500).json({ error: "Failed to update report." });
  }
};
