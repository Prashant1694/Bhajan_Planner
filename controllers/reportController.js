const crypto = require("crypto");
const { Sequelize, Op } = require("sequelize");
const BhajanReport = require("../models/BhajanReport");
const MasterBhajan = require("../models/MasterBhajan");
const ActivityLog = require("../models/ActivityLog");

function generateTicketCode() {
  const chars = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  let code = "REP-";
  for (let i = 0; i < 10; i++) {
    const idx = crypto.randomInt(0, chars.length);
    code += chars.charAt(idx);
  }
  return code;
}

// -------------------------------------------------------------
// USER ENDPOINTS
// -------------------------------------------------------------

exports.submitReport = async (req, res) => {
  try {
    const {
      master_id,
      bhajan_title,
      categories,
      description,
      suggested_correction,
      reporter_name,
      reporter_contact,
      visitor_id
    } = req.body;

    const cleanTitle = (bhajan_title || "")
      .toString()
      .replace(/<[^>]*>/g, "")
      .trim()
      .slice(0, 200);
    if (!cleanTitle) {
      return res.status(400).json({ error: "Bhajan title is required." });
    }

    const hasCategories = Array.isArray(categories) ? categories.length > 0 : Boolean(categories);
    const hasDesc = Boolean(description && description.trim());

    if (!hasCategories && !hasDesc) {
      return res
        .status(400)
        .json({ error: "Please select at least one issue category or provide details." });
    }

    const catMap = {
      lyrics: "Lyrics incorrect or missing lines",
      scale: "Harmonium scale / pitch incorrect",
      raga: "Raga name inaccurate",
      deity: "Deity categorization inaccurate",
      tempo: "Tempo incorrect",
      sheet: "Music sheet notation error",
      spelling: "Title or lyrics spelling typo",
      other: "General correction"
    };

    let effectiveDescription = hasDesc ? description.trim() : "";
    if (!effectiveDescription) {
      const catList = Array.isArray(categories) ? categories : [categories];
      const labels = catList.map((c) => catMap[c] || c);
      effectiveDescription = "Issue reported in: " + labels.join(", ");
    }

    let mid = null;
    if (master_id && !isNaN(parseInt(master_id, 10))) {
      const mb = await MasterBhajan.findByPk(parseInt(master_id, 10));
      if (mb) mid = mb.id;
    }

    let code = generateTicketCode();
    for (let attempts = 0; attempts < 5; attempts++) {
      const exists = await BhajanReport.findOne({ where: { ticket_code: code } });
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

    const catJson = JSON.stringify(
      Array.isArray(categories) ? categories : categories ? [categories] : []
    );

    const report = await BhajanReport.create({
      ticket_code: code,
      master_id: mid,
      singer_id: effectiveSingerId,
      bhajan_title: cleanTitle,
      categories: catJson,
      description: effectiveDescription,
      suggested_correction: suggested_correction
        ? suggested_correction.trim().slice(0, 1000)
        : null,
      reporter_name: effectiveReporterName,
      reporter_contact: reporter_contact ? reporter_contact.trim().slice(0, 100) : null,
      visitor_id: visitor_id || req.session?.visitorId || null,
      status: "pending"
    });

    try {
      await ActivityLog.create({
        session_id: req.session?.visitorId || "guest",
        user_type: req.session?.admin ? "admin" : req.session?.singer ? "singer" : "guest",
        username: effectiveReporterName || "Anonymous Devotee",
        action: "REPORT_SUBMITTED",
        details: `Report ${code} filed for "${cleanTitle}"`,
        ip_address: req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "127.0.0.1",
        user_agent: req.headers["user-agent"] || "",
        created_at: new Date()
      });
    } catch (_) {}

    res.json({
      success: true,
      ticket_code: code,
      report_id: report.id,
      message: "Report submitted successfully. Thank you for helping keep our Bhajan Bank accurate!"
    });
  } catch (error) {
    console.error(`[Req ${req.id || ""}] Error submitting bhajan report:`, error);
    res.status(500).json({ error: "Failed to submit report. Please try again later." });
  }
};

exports.getMyReports = async (req, res) => {
  try {
    const visitorId = req.query.visitor_id || req.session?.visitorId || null;
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
    res.render("user-reports", {
      page: "my-reports",
      pageTitle: "My Reported Issues | Bhajan Planner",
      currentAdmin: req.session.admin || null
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
    const { status, category, search } = req.query;
    const where = {};

    if (status && ["pending", "under_review", "resolved", "closed"].includes(status)) {
      where.status = status;
    }

    if (category) {
      where.categories = { [Op.like]: `%"${category}"%` };
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

    const reports = await BhajanReport.findAll({
      where,
      order: [["created_at", "DESC"]],
      limit: 200
    });

    const parsedReports = reports.map((r) => {
      const plain = r.toJSON();
      try {
        plain.categories = JSON.parse(plain.categories);
      } catch (_) {
        plain.categories = [];
      }
      return plain;
    });

    const totalCount = await BhajanReport.count();
    const counts = {
      all: totalCount,
      total: totalCount,
      pending: await BhajanReport.count({ where: { status: "pending" } }),
      under_review: await BhajanReport.count({ where: { status: "under_review" } }),
      resolved: await BhajanReport.count({ where: { status: "resolved" } }),
      closed: await BhajanReport.count({ where: { status: "closed" } })
    };

    res.render("admin-reports", {
      page: "reports",
      pageTitle: "Bhajan Issue Reports | Admin",
      reports: parsedReports,
      counts,
      selectedStatus: status || "",
      selectedCategory: category || "",
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
        const notifTitle =
          status === "resolved"
            ? `✅ Ticket Resolved: ${report.bhajan_title}`
            : `💬 Coordinator Update: ${report.ticket_code}`;
        const notifBody = admin_response
          ? `${adminName} replied: "${admin_response.slice(0, 100)}${admin_response.length > 100 ? "..." : ""}"`
          : `Your correction ticket for "${report.bhajan_title}" status is now ${(status || report.status).replace("_", " ")}.`;

        await notificationService.createPersonalized({
          type: "report_update",
          title: notifTitle,
          body: notifBody,
          link: `/singer/hub#tab-reports`,
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
