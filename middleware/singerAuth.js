const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const Singer = require("../models/Singer");
const AdminUser = require("../models/AdminUser");
const { Op } = require("sequelize");

/**
 * Intelligent resolver: connects an Admin user to their corresponding Singer profile.
 */
async function resolveSingerForAdmin(adminId, displayName, username) {
  try {
    // 1. If admin has an explicit singer_id linked
    if (adminId) {
      const admin = await AdminUser.findByPk(adminId);
      if (admin && admin.singer_id) {
        const linkedSinger = await Singer.findByPk(admin.singer_id);
        if (linkedSinger) return linkedSinger;
      }
    }

    const nameToMatch = (displayName || username || "").trim();
    if (!nameToMatch) return null;

    // 2. Exact name match
    let singer = await Singer.findOne({ where: { name: nameToMatch } });
    if (singer) {
      if (adminId) {
        AdminUser.update({ singer_id: singer.id }, { where: { id: adminId } }).catch(() => {});
      }
      return singer;
    }

    // 3. Prefix match (e.g. Admin "Prashant" -> Singer "Prashant Bhatt")
    singer = await Singer.findOne({
      where: {
        name: { [Op.like]: `${nameToMatch}%` }
      }
    });
    if (singer) {
      if (adminId) {
        AdminUser.update({ singer_id: singer.id }, { where: { id: adminId } }).catch(() => {});
      }
      return singer;
    }

    // 4. Substring match
    singer = await Singer.findOne({
      where: {
        name: { [Op.like]: `%${nameToMatch}%` }
      }
    });
    if (singer) {
      if (adminId) {
        AdminUser.update({ singer_id: singer.id }, { where: { id: adminId } }).catch(() => {});
      }
      return singer;
    }

    // 5. Auto-create Singer profile for the Admin so their user login is seamless
    const singerName = nameToMatch;
    singer = await Singer.create({
      name: singerName,
      gender: "Male",
      is_active: true
    });
    if (adminId) {
      await AdminUser.update({ singer_id: singer.id }, { where: { id: adminId } }).catch(() => {});
    }
    return singer;
  } catch (err) {
    console.error("resolveSingerForAdmin error:", err.message);
    return null;
  }
}

/**
 * Global middleware to attach currently authenticated singer to res.locals
 * and enforce the 90-day re-verification window.
 * Seamlessly connects admin accounts with singer profiles.
 */
async function attachSinger(req, res, next) {
  try {
    const isAdmin = Boolean(req.session && (req.session.admin || req.session.adminUserId));

    if (req.session && req.session.singer) {
      const verifiedAt = req.session.singer.pinVerifiedAt || 0;
      const isExpired = Date.now() - verifiedAt > NINETY_DAYS_MS;

      // Admins are exempt from the 90-day PIN expiry on their own profile
      if (isExpired && !isAdmin) {
        delete req.session.singer;
        res.locals.currentSinger = null;
      } else {
        res.locals.currentSinger = req.session.singer;
      }
    } else if (isAdmin) {
      // Admin is logged in, but singer is not yet in session — auto-resolve!
      const adminId = req.session.adminUserId || req.session.admin?.id;
      const displayName = req.session.admin?.display_name || req.session.admin?.displayName;
      const username = req.session.admin?.username;

      const singer = await resolveSingerForAdmin(adminId, displayName, username);
      if (singer) {
        req.session.singer = {
          id: singer.id,
          name: singer.name,
          gender: singer.gender,
          preferred_scale: singer.preferred_scale || null,
          pinVerifiedAt: Date.now(),
          isAdminLinked: true
        };
        res.locals.currentSinger = req.session.singer;
      } else {
        res.locals.currentSinger = null;
      }
    } else {
      res.locals.currentSinger = null;
    }
    next();
  } catch (err) {
    console.error("attachSinger middleware error:", err.message);
    res.locals.currentSinger = req.session?.singer || null;
    next();
  }
}

/**
 * Gatekeeper middleware for singer-only pages (e.g. submitting bhajans, accessing /my-hub).
 * Allows admin access and ensures an admin has an active singer session.
 */
async function requireSingerAuth(req, res, next) {
  const isAdmin = Boolean(req.session && (req.session.admin || req.session.adminUserId));

  if (req.session && req.session.singer) {
    const verifiedAt = req.session.singer.pinVerifiedAt || 0;
    const isExpired = Date.now() - verifiedAt > NINETY_DAYS_MS;

    if (!isExpired || isAdmin) {
      return next();
    }

    // 90 days have elapsed — re-verify PIN for regular devotee
    delete req.session.singer;
    const { safeRedirect } = require("../services/securityHelpers");
    const returnTo = encodeURIComponent(safeRedirect(req.originalUrl, "/submit-form"));
    const embedParam = req.query._embed === "1" ? "&_embed=1" : "";
    return res.redirect(`/singer/login?expired=true&redirect=${returnTo}${embedParam}`);
  }

  if (isAdmin) {
    // Attempt auto-resolve for admin
    const adminId = req.session.adminUserId || req.session.admin?.id;
    const displayName = req.session.admin?.display_name || req.session.admin?.displayName;
    const username = req.session.admin?.username;

    const singer = await resolveSingerForAdmin(adminId, displayName, username);
    if (singer) {
      req.session.singer = {
        id: singer.id,
        name: singer.name,
        gender: singer.gender,
        preferred_scale: singer.preferred_scale || null,
        pinVerifiedAt: Date.now(),
        isAdminLinked: true
      };
      res.locals.currentSinger = req.session.singer;
    }
    return next();
  }

  // Not logged in
  if (
    req.path.startsWith("/api/") ||
    req.xhr ||
    (req.headers.accept && req.headers.accept.includes("application/json"))
  ) {
    return res.status(401).json({ error: "Unauthorized", bookmarks: [] });
  }

  const { safeRedirect } = require("../services/securityHelpers");
  const returnTo = encodeURIComponent(safeRedirect(req.originalUrl, "/submit-form"));
  const embedParam = req.query._embed === "1" ? "&_embed=1" : "";
  return res.redirect(`/singer/login?redirect=${returnTo}${embedParam}`);
}

module.exports = {
  attachSinger,
  requireSingerAuth,
  resolveSingerForAdmin,
  NINETY_DAYS_MS
};
