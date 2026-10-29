const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const SLIDING_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // Refresh sliding window once per 24h
const SINGER_SYNC_INTERVAL_MS = 5 * 60 * 1000; // Sync singer metadata from cache every 5 min
const Singer = require("../models/Singer");
const AdminUser = require("../models/AdminUser");
const { getSingersCatalog, invalidateSingerCache } = require("../services/catalogCache");
const { Op } = require("sequelize");

async function resolveSingerForAdmin(adminId, displayName, username) {
  try {
    if (adminId) {
      const admin = await AdminUser.findByPk(adminId);
      if (admin && admin.singer_id) {
        const linkedSinger = await Singer.findByPk(admin.singer_id);
        if (linkedSinger) return linkedSinger;
      }
    }

    const nameToMatch = (displayName || username || "").trim();
    if (!nameToMatch) return null;

    let singer = await Singer.findOne({ where: { name: nameToMatch } });
    if (singer) {
      if (adminId) {
        AdminUser.update({ singer_id: singer.id }, { where: { id: adminId } }).catch(() => {});
      }
      return singer;
    }

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

    singer = await Singer.create({
      name: nameToMatch,
      gender: "Male",
      is_active: true
    });
    invalidateSingerCache();
    if (adminId) {
      await AdminUser.update({ singer_id: singer.id }, { where: { id: adminId } }).catch(() => {});
    }
    return singer;
  } catch (err) {
    console.error("resolveSingerForAdmin error:", err.message);
    return null;
  }
}

async function attachSinger(req, res, next) {
  try {
    const isAdmin = Boolean(req.session && (req.session.admin || req.session.adminUserId));
    const now = Date.now();

    if (req.session && req.session.singer) {
      const verifiedAt = req.session.singer.pinVerifiedAt || 0;
      const isExpired = now - verifiedAt > NINETY_DAYS_MS;

      if (isExpired && !isAdmin) {
        delete req.session.singer;
        res.locals.currentSinger = null;
      } else {
        // Periodically sync singer profile & slide the 90-day active window forward
        const lastSynced = req.session.singer.lastSyncedAt || 0;
        if (now - lastSynced > SINGER_SYNC_INTERVAL_MS) {
          try {
            const catalog = await getSingersCatalog();
            const liveSinger = catalog.byId.get(Number(req.session.singer.id));
            if (!liveSinger) {
              delete req.session.singer;
              res.locals.currentSinger = null;
              return next();
            }
            const needsSlide = now - verifiedAt > SLIDING_REFRESH_INTERVAL_MS;
            const metaChanged =
              req.session.singer.name !== liveSinger.name ||
              req.session.singer.gender !== liveSinger.gender ||
              req.session.singer.preferred_scale !== (liveSinger.preferred_scale || null);

            if (needsSlide || metaChanged || !req.session.singer.lastSyncedAt) {
              req.session.singer = {
                ...req.session.singer,
                name: liveSinger.name,
                gender: liveSinger.gender,
                preferred_scale: liveSinger.preferred_scale || null,
                pinVerifiedAt: needsSlide ? now : verifiedAt,
                lastSyncedAt: now
              };
            }
          } catch (_) {}
        }
        res.locals.currentSinger = req.session.singer;
      }
    } else if (isAdmin) {
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
          pinVerifiedAt: now,
          lastSyncedAt: now,
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

async function requireSingerAuth(req, res, next) {
  const isAdmin = Boolean(req.session && (req.session.admin || req.session.adminUserId));

  if (req.session && req.session.singer) {
    const verifiedAt = req.session.singer.pinVerifiedAt || 0;
    const isExpired = Date.now() - verifiedAt > NINETY_DAYS_MS;

    if (!isExpired || isAdmin) {
      return next();
    }

    delete req.session.singer;
    if (
      req.path.startsWith("/api/") ||
      req.xhr ||
      (req.headers.accept && req.headers.accept.includes("application/json"))
    ) {
      return res.status(401).json({ error: "Session expired. Please sign in again.", bookmarks: [] });
    }
    const { safeRedirect } = require("../services/securityHelpers");
    const returnTo = encodeURIComponent(safeRedirect(req.originalUrl, "/submit-form"));
    const embedParam = req.query._embed === "1" ? "&_embed=1" : "";
    return res.redirect(`/singer/login?expired=true&redirect=${returnTo}${embedParam}`);
  }

  if (isAdmin) {
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
        lastSyncedAt: Date.now(),
        isAdminLinked: true
      };
      res.locals.currentSinger = req.session.singer;
    }
    return next();
  }

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
