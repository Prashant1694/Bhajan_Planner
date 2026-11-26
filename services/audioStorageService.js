/**
 * Audio Storage & Cloudflare R2 Service
 * Handles Cloudflare R2 S3-compatible audio bucket listing, URL generation,
 * and timestamp formatting for Mandir session recordings.
 */

const crypto = require("crypto");
const {
  S3Client,
  ListObjectsV2Command,
  PutObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand
} = require("@aws-sdk/client-s3");

let s3ClientInstance = null;
let testS3Override = null;

function __setS3ClientForTest(mockClient) {
  testS3Override = mockClient || null;
}

function getS3Client() {
  if (testS3Override) return testS3Override;
  if (s3ClientInstance) return s3ClientInstance;

  const accountId = process.env.CLOUDFLARE_R2_ACCOUNT_ID;
  const accessKeyId = process.env.CLOUDFLARE_R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY;

  if (!accountId || !accessKeyId || !secretAccessKey) {
    return null;
  }

  // Cloudflare R2 S3-compatible endpoint format:
  // https://<account_id>.r2.cloudflarestorage.com
  const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;

  s3ClientInstance = new S3Client({
    region: "auto",
    endpoint: endpoint,
    credentials: {
      accessKeyId: accessKeyId,
      secretAccessKey: secretAccessKey
    }
  });

  return s3ClientInstance;
}

/**
 * Checks whether Cloudflare R2 credentials are fully configured in environment
 */
function isCloudflareConfigured() {
  return Boolean(
    process.env.CLOUDFLARE_R2_ACCOUNT_ID &&
    process.env.CLOUDFLARE_R2_ACCESS_KEY_ID &&
    process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY &&
    process.env.CLOUDFLARE_R2_BUCKET_NAME
  );
}

/**
 * Derives public streaming URL for an object key
 */
function getPublicUrlForKey(key) {
  if (!key) return "";
  const publicBase = (process.env.CLOUDFLARE_R2_PUBLIC_URL || "").trim().replace(/\/+$/, "");
  if (publicBase) {
    const cleanKey = key.replace(/^\/+/, "");
    return `${publicBase}/${cleanKey}`;
  }
  // Fallback if no public domain configured yet
  return key.startsWith("http") ? key : `https://${key}`;
}

/**
 * Lists available audio recordings in the Cloudflare R2 bucket.
 * Returns empty array with status if credentials are not yet configured.
 */
async function listR2AudioFiles() {
  const bucketName = process.env.CLOUDFLARE_R2_BUCKET_NAME;
  const client = getS3Client();

  if (!client || !bucketName) {
    return {
      configured: false,
      files: [],
      message: "Cloudflare R2 is ready for connection. Set CLOUDFLARE_R2_ACCOUNT_ID, CLOUDFLARE_R2_ACCESS_KEY_ID, CLOUDFLARE_R2_SECRET_ACCESS_KEY, and CLOUDFLARE_R2_BUCKET_NAME in your environment."
    };
  }

  try {
    const cmd = new ListObjectsV2Command({
      Bucket: bucketName,
      MaxKeys: 150
    });

    const response = await client.send(cmd);
    const contents = response.Contents || [];

    // Filter to audio extensions
    const audioRegex = /\.(mp3|m4a|aac|wav|ogg|flac|opus)$/i;
    const files = contents
      .filter((obj) => obj.Key && audioRegex.test(obj.Key))
      .map((obj) => {
        const parts = obj.Key.split("/");
        const filename = parts[parts.length - 1];
        const sizeMb = obj.Size ? (obj.Size / (1024 * 1024)).toFixed(1) + " MB" : "0 MB";
        const publicUrl = getPublicUrlForKey(obj.Key);
        return {
          key: obj.Key,
          filename: filename,
          name: filename,
          sizeBytes: obj.Size || 0,
          size: obj.Size || 0,
          size_formatted: sizeMb,
          lastModified: obj.LastModified || new Date(),
          publicUrl: publicUrl,
          url: publicUrl
        };
      })
      .sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));

    return {
      configured: true,
      files: files,
      count: files.length
    };
  } catch (err) {
    console.error("Cloudflare R2 ListObjects error:", err.message);
    return {
      configured: true,
      error: err.message,
      files: []
    };
  }
}

/**
 * Convert seconds into MM:SS or HH:MM:SS format
 * e.g. 185 -> "03:05", 3665 -> "01:01:05"
 */
function formatSecondsToTimestamp(sec) {
  if (sec == null || isNaN(sec)) return "00:00";
  const total = Math.max(0, Math.floor(sec));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");

  if (hours > 0) {
    const hh = String(hours).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

/**
 * Parse MM:SS or HH:MM:SS or raw integer seconds string into integer seconds
 * e.g. "03:05" -> 185, "1:02:10" -> 3730, "95" -> 95
 */
function parseTimestampToSeconds(input) {
  if (input == null) return 0;
  if (typeof input === "number") {
    return Number.isFinite(input) ? Math.max(0, Math.floor(input)) : 0;
  }

  const str = String(input).trim();
  if (!str) return 0;

  // Pure integer or decimal seconds (e.g. "125" or "125.75")
  if (/^\d+(?:\.\d+)?$/.test(str)) {
    const val = parseFloat(str);
    return Number.isFinite(val) ? Math.max(0, Math.floor(val)) : 0;
  }

  // Split by colons: HH:MM:SS(.ms) or MM:SS(.ms)
  const rawParts = str.split(":");
  if (rawParts.length === 3) {
    const hh = Math.max(0, parseFloat(rawParts[0]) || 0);
    const mm = Math.max(0, parseFloat(rawParts[1]) || 0);
    const ss = Math.max(0, parseFloat(rawParts[2]) || 0);
    return Math.max(0, Math.floor(hh * 3600 + mm * 60 + ss));
  }
  if (rawParts.length === 2) {
    const mm = Math.max(0, parseFloat(rawParts[0]) || 0);
    const ss = Math.max(0, parseFloat(rawParts[1]) || 0);
    return Math.max(0, Math.floor(mm * 60 + ss));
  }

  return 0;
}

function validateSessionManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { valid: false, errors: ["Manifest must be a JSON object."] };
  }

  const sessionDate = manifest.session_date || manifest.sessionDate;
  if (sessionDate != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(sessionDate).trim())) {
    errors.push("session_date must use YYYY-MM-DD format.");
  }

  const projectUid = manifest.project_uid || manifest.projectUid;
  if (projectUid != null) {
    const uidStr = String(projectUid).trim();
    if (!uidStr || uidStr.length > 96) {
      errors.push("project_uid must be between 1 and 96 characters.");
    }
  }

  const sr = manifest.sample_rate ?? manifest.sampleRate;
  if (sr != null) {
    const numSr = Number(sr);
    if (!Number.isFinite(numSr) || numSr < 8000 || numSr > 384000) {
      errors.push("sample_rate must be between 8000 and 384000 Hz.");
    }
  }

  const bd = manifest.bit_depth ?? manifest.bitDepth;
  if (bd != null && ![16, 24, 32].includes(Number(bd))) {
    errors.push("bit_depth must be 16, 24, or 32.");
  }

  const duration = manifest.duration_seconds ?? manifest.durationSeconds;
  if (duration != null && (!Number.isFinite(Number(duration)) || Number(duration) < 0)) {
    errors.push("duration_seconds must be a non-negative number.");
  }

  const markers = Array.isArray(manifest.timestamps)
    ? manifest.timestamps
    : Array.isArray(manifest.markers)
      ? manifest.markers
      : null;
  if (markers) {
    for (let i = 0; i < markers.length; i++) {
      const m = markers[i];
      if (!m || typeof m !== "object") {
        errors.push(`Marker at index ${i} must be an object.`);
        continue;
      }
      const startVal = m.start_seconds ?? m.startSeconds ?? m.timeSeconds ?? m.time;
      if (startVal != null && (!Number.isFinite(Number(startVal)) && typeof startVal !== "string")) {
        errors.push(`Marker at index ${i} has invalid start time.`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

function sanitizeR2StorageKey(rawKey, fallbackDate) {
  const safeDate =
    fallbackDate && /^\d{4}-\d{2}-\d{2}$/.test(String(fallbackDate).trim())
      ? String(fallbackDate).trim()
      : new Date().toISOString().slice(0, 10);
  const raw = String(rawKey || "").trim().replace(/\\/g, "/");
  if (!raw || raw.includes("..")) {
    return `recordings/${safeDate}-session.mp3`;
  }
  const cleaned = raw
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/")
    .replace(/[^a-zA-Z0-9._/-]/g, "-");
  return cleaned || `recordings/${safeDate}-session.mp3`;
}

function formatR2Error(err) {
  const msg = String(err && err.message ? err.message : "Cloudflare R2 upload error");
  const code = err && (err.name || err.Code || err.code);
  const httpStatus = err && err.$metadata && err.$metadata.httpStatusCode;
  if (
    httpStatus === 403 ||
    /AccessDenied|Forbidden|Unauthorized/i.test(`${code} ${msg}`)
  ) {
    return new Error(
      `Cloudflare R2 permission denied (${code || 403}). Ensure your R2 API token has Object Read & Write permissions for bucket "${process.env.CLOUDFLARE_R2_BUCKET_NAME || "your bucket"}".`
    );
  }
  return err instanceof Error ? err : new Error(msg);
}

function requireConfiguredR2() {
  const client = getS3Client();
  const bucket = process.env.CLOUDFLARE_R2_BUCKET_NAME;
  if (!client || !bucket) {
    throw new Error(
      "Cloudflare R2 is not configured. Set CLOUDFLARE_R2_ACCOUNT_ID, CLOUDFLARE_R2_ACCESS_KEY_ID, CLOUDFLARE_R2_SECRET_ACCESS_KEY, and CLOUDFLARE_R2_BUCKET_NAME."
    );
  }
  return { client, bucket };
}

async function putSingleObject({ key, contentType = "audio/mpeg", body }) {
  const { client, bucket } = requireConfiguredR2();
  const cleanKey = sanitizeR2StorageKey(key);
  try {
    const res = await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: cleanKey,
        Body: body,
        ContentType: contentType
      })
    );
    return {
      key: cleanKey,
      publicUrl: getPublicUrlForKey(cleanKey),
      etag: res && res.ETag ? res.ETag : ""
    };
  } catch (err) {
    throw formatR2Error(err);
  }
}

async function initMultipartUpload({ key, contentType = "audio/mpeg" }) {
  const { client, bucket } = requireConfiguredR2();
  const cleanKey = sanitizeR2StorageKey(key);
  try {
    const res = await client.send(
      new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: cleanKey,
        ContentType: contentType
      })
    );
    return {
      uploadId: res.UploadId,
      key: cleanKey,
      bucket
    };
  } catch (err) {
    throw formatR2Error(err);
  }
}

async function uploadMultipartPart({ key, uploadId, partNumber, body }) {
  const { client, bucket } = requireConfiguredR2();
  const cleanKey = sanitizeR2StorageKey(key);
  const partNum = Number(partNumber);
  if (!uploadId || !Number.isFinite(partNum) || partNum < 1) {
    throw new Error("Valid uploadId and positive partNumber are required.");
  }
  try {
    const res = await client.send(
      new UploadPartCommand({
        Bucket: bucket,
        Key: cleanKey,
        UploadId: uploadId,
        PartNumber: partNum,
        Body: body
      })
    );
    return {
      partNumber: partNum,
      etag: res && res.ETag ? res.ETag : ""
    };
  } catch (err) {
    throw formatR2Error(err);
  }
}

async function completeMultipartUpload({ key, uploadId, parts }) {
  const { client, bucket } = requireConfiguredR2();
  const cleanKey = sanitizeR2StorageKey(key);
  if (!uploadId || !Array.isArray(parts) || parts.length === 0) {
    throw new Error("uploadId and uploaded parts array are required to complete upload.");
  }
  const normalizedParts = parts
    .map((p) => ({
      PartNumber: Number(p.PartNumber != null ? p.PartNumber : p.partNumber),
      ETag: String(p.ETag || p.etag || "").trim()
    }))
    .filter((p) => Number.isFinite(p.PartNumber) && p.PartNumber > 0 && p.ETag)
    .sort((a, b) => a.PartNumber - b.PartNumber);

  if (normalizedParts.length === 0) {
    throw new Error("No valid part ETags received to complete upload.");
  }

  try {
    const res = await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: cleanKey,
        UploadId: uploadId,
        MultipartUpload: { Parts: normalizedParts }
      })
    );
    return {
      key: cleanKey,
      publicUrl: getPublicUrlForKey(cleanKey),
      etag: res && res.ETag ? res.ETag : ""
    };
  } catch (err) {
    throw formatR2Error(err);
  }
}

async function abortMultipartUpload({ key, uploadId }) {
  const { client, bucket } = requireConfiguredR2();
  const cleanKey = sanitizeR2StorageKey(key);
  if (!uploadId) return false;
  try {
    await client.send(
      new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: cleanKey,
        UploadId: uploadId
      })
    );
    return true;
  } catch {
    return false;
  }
}

function hmacSha256(key, data) {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

function encodeRfc3986(str) {
  return encodeURIComponent(String(str)).replace(/[!'()*]/g, (c) =>
    "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

/**
 * Generates an AWS Signature V4 presigned URL for direct browser -> Cloudflare R2 PUT uploads,
 * avoiding proxying audio payloads through Railway while keeping secret keys strictly server-side.
 */
function createPresignedR2Url({
  method = "PUT",
  key,
  queryParams = {},
  expiresIn = 3600
} = {}) {
  const accountId = (process.env.CLOUDFLARE_R2_ACCOUNT_ID || "").trim();
  const accessKeyId = (process.env.CLOUDFLARE_R2_ACCESS_KEY_ID || "").trim();
  const secretAccessKey = (process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY || "").trim();
  const bucket = (process.env.CLOUDFLARE_R2_BUCKET_NAME || "").trim();

  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error(
      "Cloudflare R2 is not configured. Set CLOUDFLARE_R2_ACCOUNT_ID, CLOUDFLARE_R2_ACCESS_KEY_ID, CLOUDFLARE_R2_SECRET_ACCESS_KEY, and CLOUDFLARE_R2_BUCKET_NAME."
    );
  }

  const cleanKey = sanitizeR2StorageKey(key);
  const safeExpires = Math.max(60, Math.min(86400, Math.floor(Number(expiresIn) || 3600)));
  const httpMethod = String(method || "PUT").toUpperCase();
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const region = "auto";
  const service = "s3";

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;

  const allQuery = Object.assign({}, queryParams || {}, {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${accessKeyId}/${credentialScope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(safeExpires),
    "X-Amz-SignedHeaders": "host"
  });

  const canonicalQuery = Object.keys(allQuery)
    .filter((k) => allQuery[k] !== undefined && allQuery[k] !== null && allQuery[k] !== "")
    .sort()
    .map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(allQuery[k])}`)
    .join("&");

  const encodedPath = cleanKey
    .split("/")
    .map((seg) => encodeRfc3986(seg))
    .join("/");
  const canonicalUri = `/${encodeRfc3986(bucket)}/${encodedPath}`;
  const canonicalHeaders = `host:${host}\n`;
  const canonicalRequest = [
    httpMethod,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    "host",
    "UNSIGNED-PAYLOAD"
  ].join("\n");

  const canonicalHash = crypto.createHash("sha256").update(canonicalRequest, "utf8").digest("hex");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    canonicalHash
  ].join("\n");

  const kDate = hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  return {
    url: `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`,
    method: httpMethod,
    key: cleanKey,
    bucket,
    publicUrl: getPublicUrlForKey(cleanKey),
    expiresIn: safeExpires
  };
}

function buildSessionObjectKey({ sessionDate, sessionId, artifactType = "final-master.mp3" } = {}) {
  const safeDate =
    sessionDate && /^\d{4}-\d{2}-\d{2}$/.test(String(sessionDate).trim())
      ? String(sessionDate).trim()
      : new Date().toISOString().slice(0, 10);
  const safeSession = String(sessionId || `session-${safeDate}`)
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .slice(0, 64) || `session-${safeDate}`;
  const safeArtifact = String(artifactType || "final-master.mp3")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "-") || "final-master.mp3";
  return sanitizeR2StorageKey(`recordings/${safeDate}/${safeSession}/${safeArtifact}`, safeDate);
}

module.exports = {
  isCloudflareConfigured,
  getPublicUrlForKey,
  sanitizeR2StorageKey,
  buildSessionObjectKey,
  createPresignedR2Url,
  formatR2Error,
  listR2AudioFiles,
  putSingleObject,
  initMultipartUpload,
  uploadMultipartPart,
  completeMultipartUpload,
  abortMultipartUpload,
  formatSecondsToTimestamp,
  parseTimestampToSeconds,
  validateSessionManifest,
  __setS3ClientForTest
};
