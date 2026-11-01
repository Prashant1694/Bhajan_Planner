const { getValidatedAdmin } = require("./auth");

/**
 * Single source of truth for view authorization state.
 * Validates admin idle expiry / active status so the App Shell never displays
 * stale admin UI for an expired session.
 */
async function attachAuthLocals(req, res, next) {
  try {
    if (req.session && (req.session.adminUserId || req.session.admin)) {
      await getValidatedAdmin(req);
    }
  } catch (_) {
    // Non-fatal fallback
  }

  const admin = req.session?.admin || null;
  const singer = req.session?.singer || null;

  const isAdmin = Boolean(admin);
  const isSuperAdmin = Boolean(
    admin && (admin.role === "super_admin" || admin.role === "SUPER_ADMIN")
  );
  const isSinger = Boolean(singer && singer.name);

  const auth = {
    isAdmin,
    isSuperAdmin,
    isSinger,
    admin,
    singer,
    user: admin ? { ...admin, type: "admin" } : singer ? { ...singer, type: "singer" } : null
  };

  res.locals.auth = auth;
  res.locals.isAdmin = isAdmin;
  res.locals.isSuperAdmin = isSuperAdmin;
  res.locals.isSinger = isSinger;
  res.locals.currentAdmin = admin;
  res.locals.currentSinger = singer;

  next();
}

module.exports = { attachAuthLocals };
