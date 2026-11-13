const ActivityLog = require("../models/ActivityLog");
const UserPresence = require("../models/UserPresence");
const AdminUser = require("../models/AdminUser");
const Singer = require("../models/Singer");
const { Sequelize, Op } = require("sequelize");
const { flushActivityBuffer } = require("../middleware/activityTracker");

exports.showActivityLogs = async (req, res) => {
  try {
    if (!req.session.admin) {
      return res
        .status(403)
        .send(
          "<h1>403 Forbidden</h1><p>You must be an administrator to view the Activity Monitor.</p>"
        );
    }

    await flushActivityBuffer();

    // 1. Fetch Bounded Presence List & evaluate online status (30 seconds threshold)
    const now = new Date();
    const thirtySecondsAgo = new Date(now.getTime() - 30 * 1000);
    const presence = await UserPresence.findAll({
      order: [Sequelize.literal("last_seen_at DESC")],
      limit: 50
    });

    const presenceList = presence.map((p) => {
      const pObj = p.toJSON();
      const lastSeen = new Date(pObj.last_seen_at);
      pObj.isOnline = lastSeen >= thirtySecondsAgo;
      pObj.timeAgo = Math.max(0, Math.round((now - lastSeen) / 1000));
      return pObj;
    });

    // Online counts
    const onlinePresence = presenceList.filter((p) => p.isOnline);
    const uniqueOnlineAdmins = new Set(
      onlinePresence
        .filter((p) => p.user_type !== "singer" && p.user_type !== "guest" && p.admin_id !== null)
        .map((p) => (p.admin_id ? `admin_${p.admin_id}` : p.username))
    ).size;

    const uniqueOnlineSingers = new Set(
      onlinePresence.filter((p) => p.user_type === "singer").map((p) => p.username)
    ).size;

    const uniqueOnlineGuests = new Set(
      onlinePresence.filter((p) => p.user_type === "guest").map((p) => p.session_id)
    ).size;

    // 2. User Summaries (Grouped activities per user account)
    const userSummaries = await ActivityLog.findAll({
      attributes: [
        "username",
        "user_type",
        [Sequelize.fn("COUNT", Sequelize.col("id")), "action_count"],
        [Sequelize.fn("MAX", Sequelize.col("created_at")), "last_active"]
      ],
      group: ["username", "user_type"],
      order: [[Sequelize.fn("MAX", Sequelize.col("created_at")), "DESC"]],
      limit: 30,
      raw: true
    });

    // 3. Filtering by specific user or user type
    const filterUser = req.query.user ? req.query.user.trim() : null;
    const filterType = req.query.user_type ? req.query.user_type.trim() : "all";

    const whereClause = {};
    if (filterUser) {
      whereClause.username = filterUser;
    }
    if (filterType === "singer") {
      whereClause.user_type = "singer";
    } else if (filterType === "admin") {
      whereClause.user_type = { [Op.in]: ["admin", "super_admin"] };
    } else if (filterType === "guest") {
      whereClause.user_type = "guest";
    }

    // 4. Fetch Bounded Activity Logs
    const pageNum = Math.max(1, parseInt(req.query.page || 1, 10) || 1);
    const limit = 50;
    const offset = (pageNum - 1) * limit;

    const { count, rows: logs } = await ActivityLog.findAndCountAll({
      where: whereClause,
      order: [Sequelize.literal("created_at DESC")],
      limit,
      offset
    });

    // 5. Section stats
    const sectionStats = await ActivityLog.findAll({
      attributes: ["section", [Sequelize.fn("COUNT", Sequelize.col("id")), "visit_count"]],
      group: ["section"],
      order: [[Sequelize.fn("COUNT", Sequelize.col("id")), "DESC"]],
      limit: 10,
      raw: true
    });

    // 6. Registered Admin Users for filter reference
    const admins = await AdminUser.findAll({
      attributes: ["id", "username", "display_name", "title", "role"]
    });

    res.render("activity-logs", {
      presenceList,
      userSummaries,
      logs,
      totalLogs: count,
      sectionStats,
      admins,
      filterUser,
      filterType,
      onlineAdminsCount: uniqueOnlineAdmins,
      onlineSingersCount: uniqueOnlineSingers,
      onlineUsersCount: uniqueOnlineGuests,
      currentPage: pageNum,
      totalPages: Math.max(1, Math.ceil(count / limit)),
      currentAdmin: req.session.admin,
      pageTitle: "Activity Monitor & User Audit",
      isAdminPage: true,
      pageCSS: "admin.css",
      page: "activity"
    });
  } catch (error) {
    res.status(500).send(`<h1>Error loading Activity Monitor</h1><p>${error.message}</p>`);
  }
};

exports.purgeOldLogs = async (req, res) => {
  try {
    if (
      !req.session.admin ||
      (req.session.admin.role !== "super_admin" && req.session.admin.role !== "SUPER_ADMIN")
    ) {
      return res.status(403).json({ error: "Unauthorized. Super Admin only." });
    }

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const deletedLogs = await ActivityLog.destroy({
      where: {
        created_at: { [Sequelize.Op.lt]: thirtyDaysAgo }
      }
    });

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    await UserPresence.destroy({
      where: {
        last_seen_at: { [Sequelize.Op.lt]: sevenDaysAgo }
      }
    });

    res.json({ success: true, message: `Purged ${deletedLogs} logs older than 30 days.` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getActivityFeedJson = async (req, res) => {
  try {
    if (!req.session.admin) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    await flushActivityBuffer();

    const presence = await UserPresence.findAll({
      order: [Sequelize.literal("last_seen_at DESC")],
      limit: 50
    });

    const now = new Date();
    const thirtySecondsAgo = new Date(now.getTime() - 30 * 1000);

    const presenceList = presence.map((p) => {
      const pObj = p.toJSON();
      const lastSeen = new Date(pObj.last_seen_at);
      pObj.isOnline = lastSeen >= thirtySecondsAgo;
      pObj.timeAgo = Math.max(0, Math.round((now - lastSeen) / 1000));
      return pObj;
    });

    const feedLimit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 30));
    const feedOffset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const { count, rows: logs } = await ActivityLog.findAndCountAll({
      order: [Sequelize.literal("created_at DESC")],
      limit: feedLimit,
      offset: feedOffset
    });

    res.json({
      success: true,
      presenceList,
      logs,
      totalLogs: count
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// User-facing personal activity audit trail (for singers/devotees logged into their account)
exports.showMyActivity = async (req, res) => {
  try {
    const currentSinger = req.session.singer || res.locals.currentSinger;
    const currentAdmin = req.session.admin;
    const username = currentSinger
      ? currentSinger.name
      : currentAdmin
        ? currentAdmin.display_name || currentAdmin.username
        : null;

    if (!username) {
      const embedParam = req.query._embed === "1" ? "&_embed=1" : "";
      return res.redirect(`/singer/login?redirect=${encodeURIComponent("/my-activity")}${embedParam}`);
    }

    const logs = await ActivityLog.findAll({
      where: { username },
      order: [["created_at", "DESC"]],
      limit: 50
    });

    res.render("my-activity", {
      username,
      singer: currentSinger,
      admin: currentAdmin,
      logs,
      pageCSS: "style.css",
      page: "my-activity"
    });
  } catch (err) {
    res.status(500).send(err.message);
  }
};
