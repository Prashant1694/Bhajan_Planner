const crypto = require("crypto");
const { doubleCsrf } = require("csrf-csrf");

const CSRF_COOKIE_NAME = "ps_csrf";
const CSRF_UID_COOKIE_NAME = "ps_csrf_uid";

/**
 * Ensures every browser client has a stable, httpOnly CSRF identifier cookie.
 * Decouples CSRF token validity from `req.session.id` so:
 *  1) `req.session.regenerate()` during Singer/Admin login never invalidates
 *     CSRF tokens across open tabs/panes.
 *  2) Anonymous GET requests do not need to write empty rows to SQLite's Sessions table.
 */
function ensureCsrfUid(req, res, next) {
  req.cookies = req.cookies || {};
  let uid = req.cookies[CSRF_UID_COOKIE_NAME];
  if (!uid || typeof uid !== "string" || uid.length < 16) {
    uid = crypto.randomBytes(16).toString("hex");
    req.cookies[CSRF_UID_COOKIE_NAME] = uid;
    res.cookie(CSRF_UID_COOKIE_NAME, uid, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: process.env.NODE_ENV === "production",
      maxAge: 90 * 24 * 60 * 60 * 1000
    });
  }
  next();
}

const { doubleCsrfProtection: rawDoubleCsrfProtection, generateCsrfToken, invalidCsrfTokenError } =
  doubleCsrf({
    getSecret: () => {
      return (
        process.env.CSRF_SECRET ||
        process.env.SESSION_SECRET ||
        "development-fallback-csrf-secret-minimum-32-characters-required"
      );
    },
    getSessionIdentifier: (req) => {
      return (
        (req.cookies && req.cookies[CSRF_UID_COOKIE_NAME]) ||
        (req.session && req.session.id) ||
        req.ip ||
        "anonymous-session"
      );
    },
    cookieName: CSRF_COOKIE_NAME,
    cookieOptions: {
      sameSite: "lax",
      path: "/",
      secure: process.env.NODE_ENV === "production",
      httpOnly: true
    },
    size: 32,
    ignoredMethods: ["GET", "HEAD", "OPTIONS"],
    getCsrfTokenFromRequest: (req) => {
      return (
        req.headers["x-csrf-token"] ||
        req.headers["x-xsrf-token"] ||
        (req.body && req.body._csrf) ||
        (req.query && req.query._csrf)
      );
    },
    skipCsrfProtection: (req) => {
      return (
        req.path === "/auth/google" ||
        req.path === "/auth/google/recovery" ||
        req.path === "/api/notifications/mark-read" ||
        req.path === "/api/notifications/mark-all-read" ||
        req.path === "/api/activity/offline"
      );
    }
  });

function doubleCsrfProtection(req, res, next) {
  ensureCsrfUid(req, res, () => rawDoubleCsrfProtection(req, res, next));
}

module.exports = {
  doubleCsrfProtection,
  generateToken: generateCsrfToken,
  invalidCsrfTokenError,
  CSRF_COOKIE_NAME,
  CSRF_UID_COOKIE_NAME
};
