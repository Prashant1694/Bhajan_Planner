const { doubleCsrf } = require("csrf-csrf");

const CSRF_COOKIE_NAME = "ps_csrf";

const { doubleCsrfProtection, generateCsrfToken, invalidCsrfTokenError } = doubleCsrf({
  getSecret: () => {
    return (
      process.env.CSRF_SECRET ||
      process.env.SESSION_SECRET ||
      "development-fallback-csrf-secret-minimum-32-characters-required"
    );
  },
  getSessionIdentifier: (req) => {
    return (req.session && req.session.id) || req.ip || "anonymous-session";
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
      req.path === "/api/notifications/mark-all-read"
    );
  }
});

module.exports = {
  doubleCsrfProtection,
  generateToken: generateCsrfToken,
  invalidCsrfTokenError,
  CSRF_COOKIE_NAME
};
