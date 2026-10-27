// ============================================================
// BHAJAN SCHEDULER - Node.js + Express + SQLite
// Sri Sathya Sai Seva Organisation - Gandhinagar
// Native App Shell & Persistent Tabs v3.5
// ============================================================

require("dotenv").config();
process.env.TZ = process.env.TZ || "Asia/Kolkata";

if (
  process.env.NODE_ENV === "production" &&
  (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)
) {
  console.error(
    "FATAL: In production, SESSION_SECRET environment variable must be set with at least 32 characters."
  );
  process.exit(1);
}

const express = require("express");
const expressLayouts = require("express-ejs-layouts");
const path = require("path");
const crypto = require("crypto");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");
const compression = require("compression");
const session = require("express-session");
const SequelizeStore = require("connect-session-sequelize")(session.Store);
const sequelize = require("./config/database");
const logger = require("./services/logger");

const sessionStore = new SequelizeStore({
  db: sequelize,
  tableName: "Sessions",
  checkExpirationInterval: 15 * 60 * 1000, // Automatically prune expired sessions every 15 min
  expiration: 90 * 24 * 60 * 60 * 1000 // 90 days persistent devotee session duration
});

// Ensure session table exists in SQLite
sessionStore.sync();

const {
  securityHeaders,
  blockCrossSiteWrites,
  generalWriteLimit,
  sanitizeInputs
} = require("./middleware/security");
const { doubleCsrfProtection, generateToken } = require("./middleware/csrfProtection");
const { initializeDatabase } = require("./services/databaseInitializer");

// ============================================================
// EXPRESS APP SETUP
// ============================================================

const app = express();
const PORT = process.env.PORT || 8000;

app.use(compression());

// Healthcheck endpoint for Railway and deployment monitoring
app.get("/healthz", async (req, res) => {
  try {
    await sequelize.authenticate();
    const mem = process.memoryUsage();
    res.status(200).json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      database: "connected",
      memory: {
        rssMb: Math.round(mem.rss / 1024 / 1024),
        heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024)
      }
    });
  } catch (err) {
    logger.error({ err }, "Healthcheck failed");
    res.status(503).json({
      status: "unhealthy",
      timestamp: new Date().toISOString(),
      error: "Database connectivity check failed"
    });
  }
});

// configure layout
app.use(expressLayouts);
app.set("layout", "layouts/main");
// Configure EJS Templating Engine
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.set("trust proxy", 1);
app.disable("x-powered-by");

// Request ID tracking
app.use((req, res, next) => {
  const reqId = req.headers["x-request-id"] || crypto.randomUUID();
  req.id = reqId;
  res.setHeader("X-Request-Id", reqId);
  res.locals.requestId = reqId;
  res.locals.nonce = crypto.randomBytes(16).toString("base64");
  next();
});

app.use(
  cookieParser(process.env.SESSION_SECRET || "bhajan-planner-session-secret-gandhinagar-2026")
);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        mediaSrc: ["'self'", "data:", "blob:", "https:"],
        imgSrc: ["'self'", "data:", "https:"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://accounts.google.com"],
        connectSrc: ["'self'", "https://accounts.google.com", "https://oauth2.googleapis.com"],
        frameSrc: ["'self'", "https://accounts.google.com"],
        workerSrc: ["'self'"],
        manifestSrc: ["'self'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'self'"]
      }
    },
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
    crossOriginResourcePolicy: { policy: "same-origin" }
  })
);

app.use(securityHeaders);
// Reject oversized payloads before they can consume server resources.
app.use(express.urlencoded({ extended: true, limit: "100kb", parameterLimit: 100 }));
app.use(express.json({ limit: "100kb" }));
app.use(sanitizeInputs);
app.use(blockCrossSiteWrites);
app.use((req, res, next) => {
  if (req.path.startsWith("/api/activity/")) return next();
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method))
    return generalWriteLimit(req, res, next);
  next();
});

// Static Files
app.use(express.static("public"));

// Official Music Sheets PDF Storage
app.use("/sheets", express.static(path.join(__dirname, "public", "sheets")));

// Submission and admin pages contain time-sensitive data. Do not allow Chrome
// to restore an old form from its back/forward cache when navigating back.
app.use((req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  next();
});

// Session Setup with persistent SQLite storage (no MemoryStore leak)
app.use(
  session({
    secret: process.env.SESSION_SECRET || "bhajan-planner-session-secret-gandhinagar-2026",
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 90 * 24 * 60 * 60 * 1000 // 90-day persistent session
    }
  })
);

app.use(doubleCsrfProtection);

const { trackActivity } = require("./middleware/activityTracker");
app.use(trackActivity);

const { attachSinger } = require("./middleware/singerAuth");
app.use(attachSinger);

const { attachAuthLocals } = require("./middleware/authLocals");
app.use(attachAuthLocals);

const BhajanReport = require("./models/BhajanReport");

const ADMIN_PATH_PREFIXES = [
  "/admin", // /admin, /admin/*, /admin/admin-users/*
  "/admin-login",
  "/forgot-password" // login-recovery flow shares the admin visual language
];

const { getCachedMissingCount } = require("./services/helpers");

app.use(async (req, res, next) => {
  try {
    if (req.session && !req.session.initialized) {
      req.session.initialized = true;
    }
    res.locals.csrfToken =
      typeof req.csrfToken === "function" ? req.csrfToken() : generateToken(req, res);
  } catch (_) {
    res.locals.csrfToken = "";
  }
  res.locals.currentAdmin = req.session.admin || null;
  res.locals.page = "";
  res.locals.pageTitle = "Bhajan Planner";
  res.locals.pageCSS = null;
  res.locals.pageJS = null;
  res.locals.showLoader = false;
  // Embed mode: page is rendered inside the app shell iframe — suppress chrome
  res.locals._embed =
    req.query._embed === "1" ||
    req.query.embed === "1" ||
    req.headers["sec-fetch-dest"] === "iframe";
  res.locals.isAdminPage = ADMIN_PATH_PREFIXES.some(
    (prefix) => req.path === prefix || req.path.startsWith(prefix + "/")
  );
  if (res.locals.isAdminPage && req.session && req.session.admin) {
    try {
      res.locals.missingCount = await getCachedMissingCount();
      res.locals.pendingReportCount = await BhajanReport.count({ where: { status: "pending" } });
    } catch (_) {
      res.locals.missingCount = 0;
      res.locals.pendingReportCount = 0;
    }
  } else {
    res.locals.missingCount = 0;
    res.locals.pendingReportCount = 0;
  }
  next();
});
const homeRoutes = require("./routes/home");
const plannerRoutes = require("./routes/planner");
const apiRoutes = require("./routes/api");
const authRoutes = require("./routes/auth");
const adminRoutes = require("./routes/admin");
const masterBankRoutes = require("./routes/masterBank");
const analyticsRoutes = require("./routes/analytics");
const singerRoutes = require("./routes/singer");
const adminUserRoutes = require("./routes/adminUsers");
const notificationRoutes = require("./routes/notifications");
const bulletinRoutes = require("./routes/bulletin");
const diwaliRoutes = require("./routes/diwali");
const reportsRoutes = require("./routes/reports");
const singerHubRoutes = require("./routes/singerHub");

// Native App Shell for top-level browser navigation and refresh
const SHELL_TAB_MAP = {
  "/": "home",
  "/submit-form": "singer",
  "/master-bank": "bank",
  "/plan-view": "plan",
  "/my-hub": "hub",
  "/singer-dictionary": "singer",
  "/my-activity": "hub",
  "/my-reports": "home",
  "/notification-settings": "home"
};

app.use((req, res, next) => {
  if (req.method !== "GET") return next();
  if (process.env.NODE_ENV === "test") return next();

  // If this is an iframe embedding, standalone mode, or API/static asset, do not wrap
  if (
    req.query._embed === "1" ||
    req.query.embed === "1" ||
    req.query.standalone === "1" ||
    req.headers["sec-fetch-dest"] === "iframe" ||
    (Boolean(req.headers["referer"]) && req.headers["referer"].includes("_embed=1"))
  ) {
    return next();
  }

  const cleanPath = req.path.toLowerCase();

  // Admin routes and auth pages render standalone with admin layout (sidebar is only in admin!)
  if (
    cleanPath.startsWith("/admin") ||
    cleanPath === "/admin-login" ||
    cleanPath === "/forgot-password" ||
    cleanPath === "/logout"
  ) {
    return next();
  }

  // Must be a top-level HTML navigation from a browser (or explicit wrap=1)
  const acceptsHtml = req.accepts ? req.accepts("html") : (req.headers.accept && req.headers.accept.includes("text/html"));
  if (!acceptsHtml) return next();
  if (req.xhr || req.headers["x-requested-with"] === "XMLHttpRequest") return next();

  let matchedTab = SHELL_TAB_MAP[cleanPath];
  if (!matchedTab) {
    if (cleanPath.startsWith("/bhajan/")) matchedTab = "bank";
    else if (cleanPath.startsWith("/bulletins")) matchedTab = "home";
  }

  if (!matchedTab) return next();

  return res.render("app-shell", {
    layout: false,
    pageTitle: "Bhajan Planner",
    initialTab: matchedTab,
    initialRoute: req.originalUrl,
    currentAdmin: req.session?.admin || null,
    currentSinger: req.session?.singer || null
  });
});

app.use("/", homeRoutes);
app.use("/", plannerRoutes);
app.use("/", apiRoutes);
app.use("/", authRoutes);
app.use("/", adminRoutes);
app.use("/", masterBankRoutes);
app.use("/", analyticsRoutes);
app.use("/", singerRoutes);
app.use("/", adminUserRoutes);
app.use("/", notificationRoutes);
app.use("/", bulletinRoutes);
app.use("/", diwaliRoutes);
app.use("/", reportsRoutes);
app.use("/", singerHubRoutes);

// 404 Not Found Handler
app.use((req, res, next) => {
  const isJson =
    req.xhr ||
    (req.headers.accept && req.headers.accept.includes("json")) ||
    req.path.startsWith("/api/");
  if (isJson) {
    return res.status(404).json({ error: "Resource not found." });
  }
  res.status(404).render("404", {
    pageTitle: "Page Not Found | Bhajan Planner"
  });
});

// CSRF token error handler
app.use((error, req, res, next) => {
  if (error && (error.code === "EBADCSRFTOKEN" || error.message === "invalid csrf token")) {
    const isJson =
      req.xhr ||
      (req.headers.accept && req.headers.accept.includes("json")) ||
      req.path.startsWith("/api/");
    if (isJson) {
      return res
        .status(403)
        .json({ error: "Invalid or missing CSRF token. Please refresh the page and try again." });
    }
    return res
      .status(403)
      .send("Security token expired or invalid. Please refresh the page and try again.");
  }
  next(error);
});

// Do not expose stack traces or database details to visitors.
app.use((error, req, res, next) => {
  if (error?.type === "entity.too.large") {
    return res.status(413).send("Request payload is too large.");
  }
  logger.error({ reqId: req.id || "NO-REQ-ID", err: error }, "Unhandled request error");
  const isJson =
    req.xhr ||
    (req.headers.accept && req.headers.accept.includes("json")) ||
    req.path.startsWith("/api/");
  if (isJson) {
    return res.status(500).json({ error: "Something went wrong. Please try again later." });
  }
  try {
    res.status(500).render("500", {
      pageTitle: "Error | Bhajan Planner"
    });
  } catch (_) {
    res.status(500).send("Something went wrong. Please try again later.");
  }
});

// ============================================================
// CRASH RESILIENCE & GRACEFUL SHUTDOWN
// ============================================================

let serverInstance = null;
let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info({ signal }, `Received ${signal}. Initiating graceful shutdown...`);

  // Flush activity log and presence buffer
  try {
    const { flushActivityBuffer } = require("./middleware/activityTracker");
    await flushActivityBuffer();
  } catch (err) {
    logger.error({ err }, "Error flushing activity buffer during shutdown");
  }

  const forceExitTimer = setTimeout(() => {
    logger.error("Graceful shutdown timed out after 30s. Forcefully terminating.");
    process.exit(1);
  }, 30000);
  if (forceExitTimer.unref) forceExitTimer.unref();

  if (serverInstance) {
    serverInstance.close(async () => {
      logger.info("HTTP server closed. Closing database connection pool...");
      try {
        await sequelize.close();
        logger.info("Database pool closed. Shutdown complete.");
        process.exit(0);
      } catch (dbErr) {
        logger.error({ dbErr }, "Error closing database connection pool during shutdown");
        process.exit(1);
      }
    });
  } else {
    process.exit(0);
  }
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

process.on("unhandledRejection", (reason, promise) => {
  logger.fatal({ reason, promise }, "Unhandled Promise Rejection detected. Shutting down.");
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  logger.fatal({ error }, "Uncaught Exception detected. Shutting down.");
  process.exit(1);
});

// ============================================================
// START SERVER
// ============================================================
async function startServer() {
  try {
    await initializeDatabase();

    serverInstance = app.listen(PORT, () => {
      logger.info(`🕉️ Sai Ram! Bhajan Scheduler running on port ${PORT}`);
      console.log(`🕉️ Sai Ram! Bhajan Scheduler is running on http://localhost:${PORT}`);
    });
    return serverInstance;
  } catch (error) {
    logger.fatal({ error }, "Server startup failed");
    console.error("❌ Server startup failed:", error);
    process.exit(1);
  }
}

if (require.main === module) {
  startServer();
}

module.exports = { app, startServer, gracefulShutdown };
