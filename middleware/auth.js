const AdminUser = require("../models/AdminUser");

const adminCache = new Map(); // adminId -> { user, cachedAt }
const ADMIN_CACHE_TTL_MS = 60 * 1000; // 60-second in-memory cache
const DEFAULT_ADMIN_SESSION_DAYS = 90;
const parsedAdminDays = Number(process.env.ADMIN_SESSION_MAX_DAYS);
const ADMIN_SESSION_DAYS =
  Number.isFinite(parsedAdminDays) && parsedAdminDays > 0
    ? parsedAdminDays
    : DEFAULT_ADMIN_SESSION_DAYS;
const ADMIN_IDLE_MAX_MS = ADMIN_SESSION_DAYS * 24 * 60 * 60 * 1000; // 90-day rolling validity
const ADMIN_SESSION_WRITE_THROTTLE_MS = 5 * 60 * 1000; // Throttle DB session writes to once per 5 min

async function getValidatedAdmin(req) {
  const rawAdminId = req.session && (req.session.adminUserId || req.session.admin?.id);
  if (!rawAdminId) return null;
  const adminId = Number(rawAdminId);
  if (!Number.isFinite(adminId) || adminId <= 0) return null;
  req.session.adminUserId = adminId;
  const now = Date.now();

  // 1. Check 90-day rolling session validity
  if (req.session.adminLastActive && now - req.session.adminLastActive > ADMIN_IDLE_MAX_MS) {
    delete req.session.adminUserId;
    delete req.session.admin;
    delete req.session.adminLastActive;
    adminCache.delete(adminId);
    return null;
  }

  // 2. Fetch admin (from cache if fresh, otherwise DB)
  let adminRecord;
  const cached = adminCache.get(adminId);
  if (cached && now - cached.cachedAt < ADMIN_CACHE_TTL_MS) {
    adminRecord = cached.user;
  } else {
    try {
      adminRecord = await AdminUser.findByPk(adminId);
      if (adminRecord) {
        adminCache.set(adminId, { user: adminRecord, cachedAt: now });
      } else {
        adminCache.delete(adminId);
      }
    } catch (dbErr) {
      const isTransientLock =
        dbErr &&
        (dbErr.name === "SequelizeTimeoutError" ||
          /SQLITE_BUSY|SQLITE_LOCKED/i.test(dbErr.message || ""));
      if (isTransientLock && req.session.admin && req.session.admin.id && req.session.admin.role) {
        console.warn("[Auth] Transient DB lock while validating admin session; preserving cached session:", dbErr.message);
        return { ...req.session.admin, is_active: true };
      }
      throw dbErr;
    }
  }

  // 3. Reject if record missing or inactive
  if (!adminRecord || !adminRecord.is_active) {
    delete req.session.adminUserId;
    delete req.session.admin;
    delete req.session.adminLastActive;
    adminCache.delete(adminId);
    return null;
  }

  // 4. Throttle session mutations to avoid concurrent SQLite session write contention
  const prevAdmin = req.session.admin;
  const profileChanged =
    !prevAdmin ||
    prevAdmin.role !== adminRecord.role ||
    prevAdmin.displayName !== adminRecord.display_name ||
    prevAdmin.singer_id !== adminRecord.singer_id;
  const needsActivityTouch =
    !req.session.adminLastActive ||
    now - req.session.adminLastActive >= ADMIN_SESSION_WRITE_THROTTLE_MS;

  if (profileChanged || needsActivityTouch) {
    req.session.adminLastActive = now;
    req.session.admin = {
      id: adminRecord.id,
      username: adminRecord.username,
      display_name: adminRecord.display_name,
      displayName: adminRecord.display_name,
      title: adminRecord.title,
      role: adminRecord.role,
      singer_id: adminRecord.singer_id
    };
    if (
      req.session.cookie &&
      (!req.session.cookie.originalMaxAge || req.session.cookie.originalMaxAge < ADMIN_IDLE_MAX_MS)
    ) {
      req.session.cookie.maxAge = ADMIN_IDLE_MAX_MS;
    }
  }

  return adminRecord;
}

function invalidateAdminCache(adminId) {
  if (adminId) {
    adminCache.delete(Number(adminId));
  }
}

const requireLogin = async (req, res, next) => {
  try {
    const admin = await getValidatedAdmin(req);
    if (admin) {
      res.locals.currentAdmin = req.session.admin;
      return next();
    }
    return res.redirect("/admin-login");
  } catch (err) {
    console.error("[Auth] requireLogin error:", err.message);
    return res.redirect("/admin-login");
  }
};

const requireApiLogin = async (req, res, next) => {
  try {
    const admin = await getValidatedAdmin(req);
    if (admin) {
      res.locals.currentAdmin = req.session.admin;
      return next();
    }
    return res.status(401).json({
      success: false,
      error: "Unauthorized or session expired"
    });
  } catch (err) {
    console.error("[Auth] requireApiLogin error:", err.message);
    return res.status(401).json({
      success: false,
      error: "Unauthorized"
    });
  }
};

const requireSuperAdmin = async (req, res, next) => {
  try {
    const admin = await getValidatedAdmin(req);
    if (!admin) {
      return res.redirect("/admin-login");
    }

    if (admin.role === "super_admin") {
      res.locals.currentAdmin = req.session.admin;
      return next();
    }

    const isJson =
      req.xhr ||
      (req.headers.accept && req.headers.accept.includes("json")) ||
      req.path.includes("/api/");
    if (isJson) {
      return res.status(403).json({
        success: false,
        error: "Forbidden: Super Admin access required"
      });
    }

    res.locals.currentAdmin = req.session.admin;
    return res.status(403).render(
      "admin-error",
      {
        statusCode: 403,
        errorTitle: "Super Admin Access Required",
        errorMessage: "This administrative section is restricted to Super Admins.",
        technicalDetail: "Forbidden: Super Admin access required",
        backUrl: "/admin",
        isAdminPage: true,
        pageCSS: "admin.css",
        pageTitle: "Access Restricted"
      },
      (renderErr, html) => {
        if (renderErr) {
          return res.status(403).send("Forbidden: Super Admin access required");
        }
        return res.status(403).send(html);
      }
    );
  } catch (err) {
    console.error("[Auth] requireSuperAdmin error:", err.message);
    return res.redirect("/admin-login");
  }
};

const requireApiSuperAdmin = async (req, res, next) => {
  try {
    const admin = await getValidatedAdmin(req);
    if (!admin) {
      return res.status(401).json({
        success: false,
        error: "Unauthorized or session expired"
      });
    }

    if (admin.role === "super_admin") {
      res.locals.currentAdmin = req.session.admin;
      return next();
    }

    return res.status(403).json({
      success: false,
      error: "Forbidden: Super Admin access required"
    });
  } catch (err) {
    console.error("[Auth] requireApiSuperAdmin error:", err.message);
    return res.status(401).json({
      success: false,
      error: "Unauthorized"
    });
  }
};

module.exports = {
  requireLogin,
  requireApiLogin,
  requireSuperAdmin,
  requireApiSuperAdmin,
  invalidateAdminCache,
  getValidatedAdmin,
  ADMIN_IDLE_MAX_MS
};
