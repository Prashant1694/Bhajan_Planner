// ============================================================
// Bulletin Controller — Bhajan Planner
// Admin CRUD and user-facing bulletin/notice board display
// ============================================================

const Bulletin = require("../models/Bulletin");
const notificationService = require("../services/notificationService");
const { Sequelize } = require("sequelize");

// ── Sanitize content to prevent XSS ──────────────────────────
function sanitizeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ── Format content for display (preserve line breaks) ────────
function formatContent(content) {
  if (!content) return "";
  return sanitizeHtml(content).replace(/\n/g, "<br>");
}

// Category labels and styling
const CATEGORY_INFO = {
  update: { label: "Samiti Update", icon: "", color: "#0284c7" },
  event: { label: "Event", icon: "", color: "#ea580c" },
  announcement: { label: "Announcement", icon: "", color: "#4f46e5" },
  bhajan_info: { label: "Bhajan Info", icon: "", color: "#16a34a" }
};

// ── Public: List published bulletins ─────────────────────────
exports.listBulletins = async (req, res) => {
  try {
    const now = new Date();
    const bulletins = await Bulletin.findAll({
      where: {
        status: "published",
        [Sequelize.Op.or]: [{ expires_at: null }, { expires_at: { [Sequelize.Op.gt]: now } }]
      },
      order: [
        ["is_pinned", "DESC"],
        ["published_at", "DESC"]
      ]
    });

    res.render("bulletins", {
      bulletins,
      CATEGORY_INFO,
      formatContent,
      pageTitle: "Latest Updates",
      showLoader: false
    });
  } catch (error) {
    res.status(500).send(`<h1>Error</h1><p>${error.message}</p>`);
  }
};

// ── Public: Bulletin detail page ─────────────────────────────
exports.bulletinDetail = async (req, res) => {
  try {
    const bulletin = await Bulletin.findByPk(req.params.id);
    if (!bulletin || bulletin.status !== "published") {
      return res
        .status(404)
        .send(
          `<!DOCTYPE html><html><head><title>Not Found</title><link rel="stylesheet" href="/css/style.css"></head><body><div class="container" style="text-align:center;padding:40px;"><h2>Bulletin Not Found</h2><p>This bulletin may have been removed or is not yet published.</p><a href="/bulletins" class="button secondary">← Back to Updates</a></div></body></html>`
        );
    }

    res.render("bulletin-detail", {
      bulletin,
      CATEGORY_INFO,
      formatContent,
      pageTitle: bulletin.title,
      showLoader: false
    });
  } catch (error) {
    res.status(500).send(`<h1>Error</h1><p>${error.message}</p>`);
  }
};

// ── Admin: List all bulletins ────────────────────────────────
exports.adminListBulletins = async (req, res) => {
  try {
    const bulletins = await Bulletin.findAll({
      order: [
        ["is_pinned", "DESC"],
        ["created_at", "DESC"]
      ]
    });

    res.render("admin-bulletins", {
      bulletins,
      CATEGORY_INFO,
      page: "bulletins",
      pageTitle: "Manage Bulletins"
    });
  } catch (error) {
    res.status(500).send(`<h1>Error</h1><p>${error.message}</p>`);
  }
};

// ── Admin: New bulletin form ─────────────────────────────────
exports.adminNewBulletin = (req, res) => {
  res.render("admin-bulletin-form", {
    bulletin: null,
    CATEGORY_INFO,
    page: "bulletins",
    pageTitle: "New Bulletin"
  });
};

// ── Admin: Create bulletin ───────────────────────────────────
exports.adminCreateBulletin = async (req, res) => {
  try {
    const { title, content, category, status, is_pinned, expires_at, send_notification } = req.body;
    const adminId = req.session.adminUserId || null;

    const publishedAt = status === "published" ? new Date() : null;

    const bulletin = await Bulletin.create({
      title: sanitizeHtml(title),
      content,
      category: category || "announcement",
      status: status || "draft",
      is_pinned: is_pinned === "on" || is_pinned === true,
      published_at: publishedAt,
      expires_at: expires_at || null,
      admin_id: adminId
    });

    // Send notification if requested and bulletin is published
    if (send_notification === "on" && status === "published") {
      await notificationService.createAndBroadcast({
        type: "bulletin_published",
        title: "📢 " + sanitizeHtml(title),
        body: (content || "").substring(0, 150) + (content && content.length > 150 ? "..." : ""),
        link: `/bulletins/${bulletin.id}`,
        eventKey: `bulletin_published:${bulletin.id}`
      });
    }

    res.redirect("/admin/bulletins");
  } catch (error) {
    res.status(500).send(`<h1>Error</h1><p>${error.message}</p>`);
  }
};

// ── Admin: Edit bulletin form ────────────────────────────────
exports.adminEditBulletin = async (req, res) => {
  try {
    const bulletin = await Bulletin.findByPk(req.params.id);
    if (!bulletin) return res.status(404).send("Bulletin not found");

    res.render("admin-bulletin-form", {
      bulletin,
      CATEGORY_INFO,
      page: "bulletins",
      pageTitle: "Edit Bulletin"
    });
  } catch (error) {
    res.status(500).send(`<h1>Error</h1><p>${error.message}</p>`);
  }
};

// ── Admin: Update bulletin ───────────────────────────────────
exports.adminUpdateBulletin = async (req, res) => {
  try {
    const bulletin = await Bulletin.findByPk(req.params.id);
    if (!bulletin) return res.status(404).send("Bulletin not found");

    const { title, content, category, status, is_pinned, expires_at, send_notification } = req.body;

    const wasPublished = bulletin.status === "published";
    const nowPublished = status === "published";
    const publishedAt = !wasPublished && nowPublished ? new Date() : bulletin.published_at;

    await bulletin.update({
      title: sanitizeHtml(title),
      content,
      category: category || bulletin.category,
      status: status || bulletin.status,
      is_pinned: is_pinned === "on" || is_pinned === true,
      published_at: publishedAt,
      expires_at: expires_at || null
    });

    // Send notification only when first publishing with notification checkbox
    if (send_notification === "on" && !wasPublished && nowPublished) {
      await notificationService.createAndBroadcast({
        type: "bulletin_published",
        title: "📢 " + sanitizeHtml(title),
        body: (content || "").substring(0, 150) + (content && content.length > 150 ? "..." : ""),
        link: `/bulletins/${bulletin.id}`,
        eventKey: `bulletin_published:${bulletin.id}`
      });
    }

    res.redirect("/admin/bulletins");
  } catch (error) {
    res.status(500).send(`<h1>Error</h1><p>${error.message}</p>`);
  }
};

// ── Admin: Delete/archive bulletin ───────────────────────────
exports.adminDeleteBulletin = async (req, res) => {
  try {
    const bulletin = await Bulletin.findByPk(req.params.id);
    if (bulletin) {
      await bulletin.update({ status: "archived" });
    }
    res.redirect("/admin/bulletins");
  } catch (error) {
    res.status(500).send(`<h1>Error</h1><p>${error.message}</p>`);
  }
};

// ── Admin: Toggle pin ────────────────────────────────────────
exports.togglePin = async (req, res) => {
  try {
    const bulletin = await Bulletin.findByPk(req.params.id);
    if (!bulletin) return res.status(404).json({ error: "Not found" });
    await bulletin.update({ is_pinned: !bulletin.is_pinned });
    res.json({ success: true, is_pinned: bulletin.is_pinned });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ── Admin: Toggle publish/unpublish ──────────────────────────
exports.togglePublish = async (req, res) => {
  try {
    const bulletin = await Bulletin.findByPk(req.params.id);
    if (!bulletin) return res.status(404).json({ error: "Not found" });

    const newStatus = bulletin.status === "published" ? "draft" : "published";
    const publishedAt =
      newStatus === "published" && !bulletin.published_at ? new Date() : bulletin.published_at;

    await bulletin.update({ status: newStatus, published_at: publishedAt });
    res.json({ success: true, status: newStatus });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ── Helper: Get latest bulletins for home page ───────────────
exports.getLatestBulletins = async (limit = 5) => {
  const now = new Date();
  return Bulletin.findAll({
    where: {
      status: "published",
      [Sequelize.Op.or]: [{ expires_at: null }, { expires_at: { [Sequelize.Op.gt]: now } }]
    },
    order: [
      ["is_pinned", "DESC"],
      ["published_at", "DESC"]
    ],
    limit
  });
};

// Export for use in other controllers
exports.CATEGORY_INFO = CATEGORY_INFO;
exports.formatContent = formatContent;
exports.sanitizeHtml = sanitizeHtml;
