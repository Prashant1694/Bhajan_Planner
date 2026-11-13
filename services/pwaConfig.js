const DEV_VALUES = new Set(["dev", "develop", "development", "staging", "preview"]);
const PROD_VALUES = new Set(["prod", "production", "main", "master"]);
const DEV_HOST_PATTERN = /(?:^|[.-])(dev|develop|development|staging|preview)(?:[.-]|$)/i;

function normalizeEnvValue(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function extractHostname(req) {
  if (!req) return "";
  const rawHost =
    (typeof req.get === "function" && (req.get("x-forwarded-host") || req.get("host"))) ||
    req.hostname ||
    req.headers?.host ||
    "";
  return String(rawHost).split(",")[0].trim().split(":")[0].toLowerCase();
}

/**
 * Determine whether the active deployment/request should serve the development
 * PWA identity (manifest, icons, title, and service worker cache namespace).
 */
function isDevelopmentPwa(req = null) {
  // 1. Explicit override always wins
  const explicitVariant = normalizeEnvValue(process.env.PWA_APP_VARIANT);
  if (DEV_VALUES.has(explicitVariant)) return true;
  if (PROD_VALUES.has(explicitVariant)) return false;

  // 2. Git branch provided by Railway / Render / Vercel
  const gitBranch = normalizeEnvValue(
    process.env.RAILWAY_GIT_BRANCH ||
      process.env.RENDER_GIT_BRANCH ||
      process.env.VERCEL_GIT_COMMIT_REF
  );
  if (DEV_VALUES.has(gitBranch)) return true;
  if (PROD_VALUES.has(gitBranch)) return false;

  // 3. Deployment environment or service name
  const envName = normalizeEnvValue(
    process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_ENVIRONMENT
  );
  if (DEV_VALUES.has(envName)) return true;

  const serviceName = normalizeEnvValue(process.env.RAILWAY_SERVICE_NAME);
  if (serviceName && DEV_HOST_PATTERN.test(serviceName)) return true;

  // 4. Request hostname pattern (e.g. dev.*, *-develop.up.railway.app)
  const hostname = extractHostname(req);
  if (hostname && DEV_HOST_PATTERN.test(hostname)) return true;

  // 5. Local non-test runs (e.g. npm start / npm run dev without NODE_ENV=production)
  const nodeEnv = normalizeEnvValue(process.env.NODE_ENV);
  if (nodeEnv && nodeEnv !== "production" && nodeEnv !== "test") return true;

  return false;
}

/**
 * Return the full PWA metadata bundle for views, manifests, and push payloads.
 */
function getPwaMetadata(req = null) {
  const isDev = isDevelopmentPwa(req);
  return {
    isDevelopmentPwa: isDev,
    variant: isDev ? "development" : "production",
    manifestPath: isDev ? "/manifest.dev.json" : "/manifest.json",
    icon192Path: isDev
      ? "/images/icons/dev/icon-192x192.png"
      : "/images/icons/icon-192x192.png",
    icon512Path: isDev
      ? "/images/icons/dev/icon-512x512.png"
      : "/images/icons/icon-512x512.png",
    appleTouchIconPath: isDev
      ? "/images/icons/dev/apple-touch-icon.png"
      : "/images/icons/icon-192x192.png",
    appleTitle: isDev ? "Bhajan DEV" : "Bhajan Planner",
    appName: isDev ? "Bhajan Planner DEV" : "Bhajan Planner"
  };
}

module.exports = {
  isDevelopmentPwa,
  getPwaMetadata
};

