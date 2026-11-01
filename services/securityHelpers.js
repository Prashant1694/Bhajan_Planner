/**
 * Validates and normalizes redirect URLs to prevent open redirect vulnerabilities.
 * Strictly permits only relative URLs beginning with a single forward slash
 * (not followed by another slash or backslash).
 */
function safeRedirect(url, fallback = "/") {
  if (typeof url !== "string") return fallback;
  const trimmed = url.trim();
  const regex = /^\/(?!\/|\\)[^\r\n]*$/;
  if (regex.test(trimmed)) {
    return trimmed;
  }
  return fallback;
}

/**
 * Escapes unsafe HTML characters to prevent XSS.
 */
function escapeHtml(unsafe) {
  if (unsafe === null || unsafe === undefined) return "";
  return String(unsafe)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Safely stringifies JSON for embedding in inline <script> tags,
 * escaping '<' as '\u003c' to prevent script breakout attacks.
 */
function safeJsonStringify(obj) {
  return JSON.stringify(obj).replace(/</g, "\\u003c");
}

/**
 * Validates password policy:
 * - At least 10 characters
 * - Not equal to username (case-insensitive)
 */
function validatePasswordPolicy(password, username = "") {
  const cleanPass = String(password || "").trim();
  const cleanUser = String(username || "")
    .trim()
    .toLowerCase();

  if (cleanPass.length < 10) {
    return {
      isValid: false,
      message: "Password must be at least 10 characters long."
    };
  }

  if (cleanUser && cleanPass.toLowerCase() === cleanUser) {
    return {
      isValid: false,
      message: "Password cannot be identical to the username."
    };
  }

  return { isValid: true };
}

/**
 * Valid 60-character bcrypt hash (cost 10) for constant-time comparisons when accounts are missing
 */
const DUMMY_BCRYPT_HASH = "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";

module.exports = {
  safeRedirect,
  escapeHtml,
  safeJsonStringify,
  validatePasswordPolicy,
  DUMMY_BCRYPT_HASH
};
