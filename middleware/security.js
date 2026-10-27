const crypto = require("crypto");

function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  // Google Identity completes sign-in in a popup and must be able to message
  // its opener. `same-origin` blocks that callback and leaves the popup blank.
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("X-DNS-Prefetch-Control", "off");
  // Inline scripts/styles are still used by the existing templates; restrict
  // every other source while preserving their current functionality.
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; media-src 'self' data: blob: https:; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.tailwindcss.com; font-src 'self' https://fonts.gstatic.com; script-src 'self' 'unsafe-inline' https://accounts.google.com https://cdn.tailwindcss.com https://unpkg.com; connect-src 'self' https://accounts.google.com https://oauth2.googleapis.com; frame-src 'self' https://accounts.google.com; worker-src 'self'; manifest-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'"
  );
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
}

/**
 * Memory-safe rate limiter with periodic cleanup
 */
function rateLimit({ windowMs, max, message, keyGenerator }) {
  const hits = new Map();

  // Prune expired records every 5 minutes to prevent memory leaks
  const timer = setInterval(
    () => {
      const now = Date.now();
      for (const [k, v] of hits.entries()) {
        if (now - v.startedAt > windowMs) {
          hits.delete(k);
        }
      }
    },
    5 * 60 * 1000
  );
  if (timer.unref) timer.unref();

  return (req, res, next) => {
    const key = keyGenerator ? keyGenerator(req) : req.ip || req.socket?.remoteAddress || "unknown";
    const now = Date.now();
    const record = hits.get(key);
    const current =
      !record || now - record.startedAt > windowMs
        ? { startedAt: now, count: 1 }
        : { ...record, count: record.count + 1 };
    hits.set(key, current);

    if (current.count > max) {
      res.setHeader("Retry-After", Math.ceil((windowMs - (now - current.startedAt)) / 1000));
      const isJson =
        req.xhr ||
        (req.headers.accept && req.headers.accept.includes("json")) ||
        req.path.startsWith("/api/");

      const errMsg = message || "Too many requests. Please try again later.";
      if (isJson) {
        return res.status(429).json({ error: errMsg });
      }
      return res.status(429).send(errMsg);
    }
    next();
  };
}

/**
 * Cross-Site Write Protection (defense-in-depth on state changes)
 */
function blockCrossSiteWrites(req, res, next) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();
  const fetchSite = req.get("sec-fetch-site");
  if (fetchSite === "cross-site") {
    const isJson =
      req.xhr ||
      (req.headers.accept && req.headers.accept.includes("json")) ||
      req.path.startsWith("/api/");
    return isJson
      ? res.status(403).json({ error: "Cross-site request blocked." })
      : res.status(403).send("Cross-site request blocked.");
  }
  const origin = req.get("origin");
  if (origin) {
    const host = req.get("host");
    try {
      const originUrl = new URL(origin);
      if (originUrl.host.toLowerCase() !== host.toLowerCase()) {
        return res.status(403).send("Invalid request origin.");
      }
    } catch (_) {
      return res.status(403).send("Malformed request origin.");
    }
  }
  next();
}

/**
 * Deep Prototype Pollution and Null Byte Sanitizer
 */
function sanitizeInputs(req, res, next) {
  function clean(obj) {
    if (!obj || typeof obj !== "object") return;
    for (const key of Object.keys(obj)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        delete obj[key];
        continue;
      }
      if (typeof obj[key] === "string") {
        // Strip dangerous null bytes
        obj[key] = obj[key].replace(/\0/g, "");
      } else if (typeof obj[key] === "object") {
        clean(obj[key]);
      }
    }
  }

  if (req.body) clean(req.body);
  if (req.query) clean(req.query);
  if (req.params) clean(req.params);
  next();
}

module.exports = {
  securityHeaders,
  blockCrossSiteWrites,
  sanitizeInputs,
  generalWriteLimit: rateLimit({ windowMs: 15 * 60 * 1000, max: 1500 }),
  authLimit: rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: "Too many sign-in attempts. Please wait 15 minutes."
  }),
  singerLoginLimit: rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 15,
    message: "Too many PIN attempts. Please wait 15 minutes."
  }),
  singerPinChangeLimit: rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: "Too many PIN change attempts. Please wait 15 minutes."
  }),
  reportSubmitLimit: rateLimit({
    windowMs: 30 * 60 * 1000,
    max: 25,
    message: "Too many reports submitted. Please wait before submitting more."
  }),
  ticketRateLimit: rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    message: "Too many ticket requests. Please wait a moment."
  }),
  bhajanSubmitLimit: rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 30,
    message: "Too many bhajan submissions in a short period. Please wait a moment."
  }),
  recoveryLimit: rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 15,
    message: "Too many recovery attempts. Please wait before trying again."
  }),
  activityLimit: rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 60,
    message: "Too many activity pings."
  })
};
