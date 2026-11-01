/**
 * Audio Storage & Cloudflare R2 Service
 * Handles Cloudflare R2 S3-compatible audio bucket listing, URL generation,
 * and timestamp formatting for Mandir session recordings.
 */

const { S3Client, ListObjectsV2Command, HeadObjectCommand } = require("@aws-sdk/client-s3");

let s3ClientInstance = null;

function getS3Client() {
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
  if (typeof input === "number") return Math.max(0, Math.floor(input));

  const str = String(input).trim();
  if (!str) return 0;

  // Pure integer seconds
  if (/^\d+$/.test(str)) {
    return parseInt(str, 10);
  }

  // Split by colons: HH:MM:SS or MM:SS
  const parts = str.split(":").map((p) => parseInt(p, 10) || 0);
  if (parts.length === 3) {
    const [hh, mm, ss] = parts;
    return hh * 3600 + mm * 60 + ss;
  }
  if (parts.length === 2) {
    const [mm, ss] = parts;
    return mm * 60 + ss;
  }

  return 0;
}

module.exports = {
  isCloudflareConfigured,
  getPublicUrlForKey,
  listR2AudioFiles,
  formatSecondsToTimestamp,
  parseTimestampToSeconds
};
