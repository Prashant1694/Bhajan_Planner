const crypto = require("crypto");
const { Sequelize } = require("sequelize");
const ActivityLog = require("../models/ActivityLog");
const UserPresence = require("../models/UserPresence");

const VISITOR_COOKIE_NAME = "bp_vid";

// Automatic Log Retention Cleanup Routine (Runs every 12 hours)
const cleanupTimer = setInterval(
  async () => {
    try {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      await ActivityLog.destroy({
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
    } catch (_) {}
  },
  12 * 60 * 60 * 1000
);
if (cleanupTimer.unref) cleanupTimer.unref();

function getSectionName(urlPath) {
  if (urlPath === "/" || urlPath.startsWith("/submit-form")) return "Submit Form";
  if (urlPath.startsWith("/master-bank")) return "Master Bhajan Bank";
  if (urlPath.startsWith("/plan-view") || urlPath.startsWith("/live")) return "Live Plan & Share";
  if (urlPath.startsWith("/my-hub") || urlPath.startsWith("/singer/hub")) return "Singer Hub";
  if (urlPath.startsWith("/singer/login")) return "Singer Login";
  if (urlPath.startsWith("/admin/activity-logs")) return "Activity Monitor";
  if (urlPath.startsWith("/admin/admin-users")) return "Admin Management";
  if (urlPath.startsWith("/admin/singers") || urlPath.startsWith("/admin/singer-dictionary"))
    return "Singer Directory";
  if (urlPath.startsWith("/admin/rules")) return "Deity Rules";
  if (urlPath.startsWith("/admin/analytics")) return "Analytics";
  if (urlPath.startsWith("/admin/missing-bhajans")) return "Missing Catcher";
  if (urlPath.startsWith("/admin")) return "Admin Dashboard";
  if (urlPath.startsWith("/api/singer/songbook")) return "Singer Repertoire";
  if (urlPath.startsWith("/api")) return "API System";
  return "General";
}

function getActionDetails(req, section, username) {
  const path = req.path;
  const method = req.method;
  const body = req.body || {};

  if (method === "POST") {
    if (path.includes("submit-form") || path.includes("submit")) {
      const bhajan = body.title || body.bhajan_name || body.bhajanName || "Bhajan";
      const deity = body.deity ? ` for ${body.deity}` : "";
      return {
        action: "SUBMIT_BHAJAN",
        details: `${username} submitted "${bhajan}"${deity}`
      };
    }
    if (path.includes("/api/singer/login") || path.includes("/login")) {
      return {
        action: "USER_LOGIN",
        details: `${username} logged in successfully`
      };
    }
    if (path.includes("/singer/logout") || path.includes("/logout")) {
      return {
        action: "USER_LOGOUT",
        details: `${username} logged out`
      };
    }
    if (path.includes("/api/singer/songbook/toggle") || path.includes("/api/singer/songbook")) {
      return {
        action: "UPDATE_SONGBOOK",
        details: `${username} updated their saved repertoire`
      };
    }
    if (path.includes("/api/singer/profile/scale")) {
      return {
        action: "UPDATE_SCALE",
        details: `${username} set preferred pitch scale to ${body.preferred_scale || "default"}`
      };
    }
    if (path.includes("/api/singer/change-pin")) {
      return {
        action: "CHANGE_PIN",
        details: `${username} updated their security PIN`
      };
    }
    if (path.includes("reorder")) {
      return {
        action: "REORDER_SESSION",
        details: `${username} rearranged bhajan lineup order`
      };
    }
    if (path.includes("toggle-lock")) {
      return {
        action: "TOGGLE_LOCK",
        details: `${username} toggled session lineup lock`
      };
    }
    if (path.includes("master")) {
      return {
        action: "MODIFY_MASTER_BANK",
        details: `${username} updated Master Bhajan Bank entry`
      };
    }
    return {
      action: `POST_${path
        .replace(/[^a-zA-Z0-9_]/g, "_")
        .slice(0, 25)
        .toUpperCase()}`,
      details: `${username} performed action on ${section}`
    };
  }

  return {
    action: `VIEW_${section.replace(/[^a-zA-Z0-9_]/g, "_").toUpperCase()}`,
    details: `${username} visited ${section}`
  };
}

let activityBuffer = [];
const presenceMap = new Map();
let isFlushing = false;

async function flushActivityBuffer() {
  if (isFlushing || (activityBuffer.length === 0 && presenceMap.size === 0)) return;
  isFlushing = true;

  const logsToInsert = activityBuffer;
  activityBuffer = [];
  const presencesToUpsert = Array.from(presenceMap.values());
  presenceMap.clear();

  try {
    if (logsToInsert.length > 0) {
      await ActivityLog.bulkCreate(logsToInsert);
    }
    if (presencesToUpsert.length > 0) {
      for (const presence of presencesToUpsert) {
        await UserPresence.upsert(presence);
      }
    }
  } catch (err) {
    console.error("Failed to flush activity buffer:", err.message);
  } finally {
    isFlushing = false;
  }
}

const flushTimer = setInterval(flushActivityBuffer, 5000);
if (flushTimer.unref) flushTimer.unref();

const BOT_REGEX = /bot|googlebot|crawler|spider|robot|crawling|uptime|pingdom|healthcheck/i;

function resolveVisitorId(req, res) {
  if (req.session && req.session.visitorId) {
    return req.session.visitorId;
  }
  const existingCookie = req.cookies && req.cookies[VISITOR_COOKIE_NAME];
  if (existingCookie && /^sess_[a-f0-9]{16}$/.test(existingCookie)) {
    return existingCookie;
  }
  const newVid = "sess_" + crypto.randomBytes(8).toString("hex");
  req.cookies = req.cookies || {};
  req.cookies[VISITOR_COOKIE_NAME] = newVid;
  res.cookie(VISITOR_COOKIE_NAME, newVid, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: 30 * 24 * 60 * 60 * 1000
  });
  return newVid;
}

const trackActivity = async (req, res, next) => {
  try {
    const path = req.path || "";
    const userAgent = (req.headers["user-agent"] || "").slice(0, 250);

    if (
      BOT_REGEX.test(userAgent) ||
      path === "/healthz" ||
      path === "/favicon.ico" ||
      path === "/manifest.json" ||
      path.startsWith("/sheets/") ||
      path.startsWith("/images/") ||
      path.startsWith("/icons/") ||
      path.startsWith("/audio/") ||
      path.match(/\.(css|js|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|map|webmanifest|wav|mp3|m4a|ogg)$/i) ||
      path.startsWith("/css/") ||
      path.startsWith("/js/") ||
      path.startsWith("/api/activity/") ||
      path.startsWith("/api/notifications/") ||
      path.startsWith("/socket.io/") ||
      path.includes("/pin-status")
    ) {
      return next();
    }

    // Use a lightweight cookie for anonymous visitors instead of mutating req.session
    const sessionId = resolveVisitorId(req, res);
    let userType = "guest";
    let adminId = null;
    let username = "Guest Devotee";

    if (req.session && req.session.admin) {
      const admin = req.session.admin;
      userType =
        admin.role === "super_admin" || admin.role === "SUPER_ADMIN" ? "super_admin" : "admin";
      adminId = admin.id;
      const titleStr = admin.title ? ` (${admin.title})` : "";
      username = (admin.display_name || admin.username || "Admin") + titleStr;
    } else if (req.session && req.session.singer && req.session.singer.name) {
      userType = "singer";
      username = req.session.singer.name;
    } else if (
      req.body &&
      req.body.singer_name &&
      typeof req.body.singer_name === "string" &&
      req.body.singer_name.trim().length > 1
    ) {
      userType = "singer";
      username = req.body.singer_name.trim();
    }

    const section = getSectionName(path);
    const { action, details } = getActionDetails(req, section, username);
    const ip = req.ip || req.socket?.remoteAddress || "127.0.0.1";

    presenceMap.set(sessionId, {
      session_id: sessionId,
      admin_id: adminId,
      username,
      user_type: userType,
      current_page: req.originalUrl || path,
      last_section: section,
      ip_address: ip,
      last_seen_at: new Date()
    });

    activityBuffer.push({
      session_id: sessionId,
      user_type: userType,
      admin_id: adminId,
      username,
      action,
      section,
      page_url: req.originalUrl || path,
      method: req.method,
      ip_address: ip,
      user_agent: userAgent,
      duration_seconds: 0,
      details,
      created_at: new Date()
    });

    if (activityBuffer.length >= 50) {
      flushActivityBuffer().catch(() => {});
    }
  } catch (_) {}

  next();
};

module.exports = {
  trackActivity,
  getSectionName,
  flushActivityBuffer,
  resolveVisitorId
};
