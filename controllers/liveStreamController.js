const BhajanSubmission = require("../models/BhajanSubmission");
const MasterBhajan = require("../models/MasterBhajan");
const LiveStreamPreset = require("../models/LiveStreamPreset");
const SessionAudio = require("../models/SessionAudio");
const SessionAudioTimestamp = require("../models/SessionAudioTimestamp");
const StudioProject = require("../models/StudioProject");
const ActivityLog = require("../models/ActivityLog");
const audioStorageService = require("../services/audioStorageService");
const liveStreamService = require("../services/liveStreamService");
const notificationService = require("../services/notificationService");
const { getLocalDateStr } = require("../services/helpers");

async function loadSessionBhajansWithMasterIds(sessionDate) {
  if (!sessionDate) return [];
  const rows = await BhajanSubmission.findAll({
    where: { session_date: sessionDate },
    order: [["list_order", "ASC"], ["id", "ASC"]],
    raw: true
  });
  if (rows.length === 0) return [];

  const masters = await MasterBhajan.findAll({
    where: { is_active: true },
    attributes: ["id", "title"],
    raw: true
  });
  const masterMap = new Map();
  for (const m of masters) {
    const key = String(m.title || "").trim().toLowerCase();
    if (key && !masterMap.has(key)) {
      masterMap.set(key, m.id);
    }
  }

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    singer_name: r.singer_name,
    partner_name: r.partner_name || "",
    deity: r.deity || "",
    scale: r.scale || "",
    speed: r.speed || "",
    master_id: masterMap.get(String(r.title || "").trim().toLowerCase()) || null
  }));
}

async function resolveDefaultSessionDate() {
  const todayStr = getLocalDateStr();
  const todayCount = await BhajanSubmission.count({ where: { session_date: todayStr } });
  if (todayCount > 0) return todayStr;

  const latest = await BhajanSubmission.findOne({
    order: [["session_date", "DESC"]],
    attributes: ["session_date"],
    raw: true
  });
  return latest && latest.session_date ? latest.session_date : todayStr;
}

exports.showStudio = async (req, res) => {
  try {
    const sessionDate = req.query.date || (await resolveDefaultSessionDate());
    const [bhajans, customPresetRows] = await Promise.all([
      loadSessionBhajansWithMasterIds(sessionDate),
      LiveStreamPreset.findAll({ order: [["name", "ASC"]], raw: true })
    ]);

    const customPresets = customPresetRows.map((p) => {
      let config = null;
      try {
        config = JSON.parse(p.config_json);
      } catch {
        config = null;
      }
      return {
        id: `custom-${p.id}`,
        dbId: p.id,
        name: p.name,
        description: p.description || "Saved custom studio preset",
        isBuiltIn: false,
        config
      };
    }).filter((p) => p.config);

    res.render("admin-live-stream", {
      pageTitle: "Live Stream Broadcast Studio | Bhajan Planner",
      page: "live-stream",
      pageCSS: "live-stream-studio.css",
      sessionDate,
      scheduledBhajans: bhajans,
      presets: [...liveStreamService.DEFAULT_PRESETS, ...customPresets],
      streamState: liveStreamService.getPublicState(),
      r2Status: {
        configured: audioStorageService.isCloudflareConfigured(),
        bucketName: process.env.CLOUDFLARE_R2_BUCKET_NAME || "",
        publicUrlConfigured: Boolean(process.env.CLOUDFLARE_R2_PUBLIC_URL)
      }
    });
  } catch (error) {
    console.error("Failed to render Live Stream Studio:", error);
    res.status(500).render("500", {
      pageTitle: "Error | Bhajan Planner"
    });
  }
};

exports.getSessionBhajans = async (req, res) => {
  try {
    const sessionDate = (req.query.date || "").trim() || (await resolveDefaultSessionDate());
    const bhajans = await loadSessionBhajansWithMasterIds(sessionDate);
    res.json({ success: true, sessionDate, bhajans });
  } catch (error) {
    console.error("getSessionBhajans error:", error);
    res.status(500).json({ error: "Failed to load session bhajans." });
  }
};

exports.startBroadcast = async (req, res) => {
  try {
    const {
      title,
      session_date,
      bitrate_kbps,
      access_mode,
      notify_devotees
    } = req.body || {};

    const cleanDate = session_date && /^\d{4}-\d{2}-\d{2}$/.test(String(session_date).trim())
      ? String(session_date).trim()
      : getLocalDateStr();

    const adminName = req.session?.admin?.displayName || req.session?.admin?.username || "Admin";
    const result = await liveStreamService.startStream({
      title: title || `Live Bhajan Session (${cleanDate})`,
      sessionDate: cleanDate,
      bitrateKbps: Number(bitrate_kbps) || 320,
      accessMode: access_mode === "singers_only" ? "singers_only" : "public",
      adminId: req.session?.adminUserId || req.session?.admin?.id || null,
      adminName
    });

    let pushSummary = null;
    if (notify_devotees === true || notify_devotees === "true") {
      try {
        const pushRes = await notificationService.createAndBroadcast({
          type: "live_stream",
          title: "Live Bhajan Stream Started",
          body: `${result.stream.title} is now streaming live in high quality. Tap to listen.`,
          link: "/?live=1",
          eventKey: `live_stream:${result.stream.streamId}:${Date.now()}`,
          metadata: { streamId: result.stream.streamId }
        });
        pushSummary = pushRes.pushSummary || null;
      } catch (pushErr) {
        console.warn("Live stream push broadcast failed (continuing stream):", pushErr.message);
      }
    }

    res.json({
      success: true,
      ingestToken: result.ingestToken,
      wsPath: "/ws/live-stream/ingest",
      stream: result.stream,
      pushSummary
    });
  } catch (error) {
    console.error("startBroadcast error:", error);
    res.status(500).json({ error: "Failed to start live broadcast." });
  }
};

exports.stopBroadcast = async (req, res) => {
  try {
    const stream = await liveStreamService.stopStream();
    res.json({ success: true, stream });
  } catch (error) {
    console.error("stopBroadcast error:", error);
    res.status(500).json({ error: "Failed to stop live broadcast." });
  }
};

exports.setNowSinging = async (req, res) => {
  try {
    const state = liveStreamService.getPublicState();
    if (!state.isLive) {
      return res.status(409).json({ error: "Start a live broadcast before setting Now Singing." });
    }

    const { submission_id, title, singer_name, master_id, clear } = req.body || {};
    let resolvedTitle = title;
    let resolvedSinger = singer_name;
    let resolvedMasterId = master_id;

    if (!clear && submission_id && !resolvedTitle) {
      const sub = await BhajanSubmission.findByPk(Number(submission_id), { raw: true });
      if (sub) {
        resolvedTitle = sub.title;
        resolvedSinger = sub.singer_name;
      }
    }

    if (!clear && resolvedTitle && !resolvedMasterId) {
      const masters = await MasterBhajan.findAll({
        where: { is_active: true },
        attributes: ["id", "title"],
        raw: true
      });
      const match = masters.find(
        (m) => String(m.title || "").trim().toLowerCase() === String(resolvedTitle).trim().toLowerCase()
      );
      if (match) resolvedMasterId = match.id;
    }

    const nowSinging = await liveStreamService.updateNowSinging({
      submissionId: submission_id,
      title: resolvedTitle,
      singerName: resolvedSinger,
      masterId: resolvedMasterId,
      clear: Boolean(clear)
    });

    res.json({
      success: true,
      nowSinging,
      stream: liveStreamService.getPublicState()
    });
  } catch (error) {
    console.error("setNowSinging error:", error);
    res.status(500).json({ error: "Failed to update Now Singing." });
  }
};

exports.listPresets = async (req, res) => {
  try {
    const customRows = await LiveStreamPreset.findAll({
      order: [["name", "ASC"]],
      raw: true
    });
    const custom = customRows.map((p) => {
      let config = null;
      try {
        config = JSON.parse(p.config_json);
      } catch {
        config = null;
      }
      return {
        id: `custom-${p.id}`,
        dbId: p.id,
        name: p.name,
        description: p.description || "Saved custom studio preset",
        isBuiltIn: false,
        config
      };
    }).filter((p) => p.config);

    res.json({
      success: true,
      presets: [...liveStreamService.DEFAULT_PRESETS, ...custom]
    });
  } catch (error) {
    console.error("listPresets error:", error);
    res.status(500).json({ error: "Failed to load EQ presets." });
  }
};

exports.savePreset = async (req, res) => {
  try {
    const rawName = String(req.body?.name || "").trim().slice(0, 80);
    const description = String(req.body?.description || "").trim().slice(0, 180);
    const config = req.body?.config;

    if (!rawName) {
      return res.status(400).json({ error: "Preset name is required." });
    }
    if (!config || typeof config !== "object") {
      return res.status(400).json({ error: "Valid preset audio configuration is required." });
    }

    const serialized = JSON.stringify(config);
    const adminId = req.session?.adminUserId || req.session?.admin?.id || null;
    const now = new Date();

    const existing = await LiveStreamPreset.findOne({ where: { name: rawName } });
    let record;
    if (existing) {
      await existing.update({
        description: description || existing.description,
        config_json: serialized,
        created_by_admin_id: adminId,
        updated_at: now
      });
      record = existing;
    } else {
      record = await LiveStreamPreset.create({
        name: rawName,
        description: description || "Saved custom studio preset",
        config_json: serialized,
        created_by_admin_id: adminId,
        created_at: now,
        updated_at: now
      });
    }

    res.json({
      success: true,
      preset: {
        id: `custom-${record.id}`,
        dbId: record.id,
        name: record.name,
        description: record.description,
        isBuiltIn: false,
        config
      }
    });
  } catch (error) {
    console.error("savePreset error:", error);
    res.status(500).json({ error: "Failed to save EQ preset." });
  }
};

exports.deletePreset = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid preset ID." });
    }
    const deleted = await LiveStreamPreset.destroy({ where: { id } });
    if (!deleted) {
      return res.status(404).json({ error: "Preset not found." });
    }
    res.json({ success: true });
  } catch (error) {
    console.error("deletePreset error:", error);
    res.status(500).json({ error: "Failed to delete EQ preset." });
  }
};

exports.getStatus = (req, res) => {
  const status = liveStreamService.getPublicState();
  const isAuthenticated = Boolean(req.session?.singer?.id || req.session?.admin);
  const canListen = status.accessMode !== "singers_only" || isAuthenticated;
  res.setHeader("Cache-Control", "no-store");
  res.json({
    ...status,
    canListen
  });
};

exports.subscribeEvents = (req, res) => {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }
  liveStreamService.addSseClient(req, res);
};

exports.streamAudio = (req, res) => {
  const status = liveStreamService.getPublicState();
  if (!status.isLive) {
    return res.status(404).json({ error: "No live stream is currently active." });
  }

  const isAuthenticated = Boolean(req.session?.singer?.id || req.session?.admin);
  if (status.accessMode === "singers_only" && !isAuthenticated) {
    return res.status(401).json({
      error: "This live stream is restricted to signed-in singers. Please sign in via Singer Hub."
    });
  }

  res.status(200);
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("icy-name", status.title || "Live Bhajan Stream");
  res.setHeader("icy-br", String(status.bitrateKbps || 320));
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  liveStreamService.addAudioListener(req, res);
};

exports.getR2Status = (req, res) => {
  res.json({
    configured: audioStorageService.isCloudflareConfigured(),
    bucketName: process.env.CLOUDFLARE_R2_BUCKET_NAME || "",
    publicUrlConfigured: Boolean(process.env.CLOUDFLARE_R2_PUBLIC_URL)
  });
};

exports.r2InitUpload = async (req, res) => {
  try {
    if (!audioStorageService.isCloudflareConfigured()) {
      return res.status(503).json({
        success: false,
        error: "Cloudflare R2 credentials are not configured in environment."
      });
    }

    const { key, session_date, content_type, single_part } = req.body || {};
    const cleanKey = audioStorageService.sanitizeR2StorageKey(key, session_date);
    const contentType = String(content_type || "audio/mpeg").trim() || "audio/mpeg";

    if (single_part === true || single_part === "true") {
      return res.json({
        success: true,
        mode: "single",
        key: cleanKey
      });
    }

    const init = await audioStorageService.initMultipartUpload({
      key: cleanKey,
      contentType
    });

    return res.json({
      success: true,
      mode: "multipart",
      uploadId: init.uploadId,
      key: init.key
    });
  } catch (err) {
    console.error("r2InitUpload error:", err);
    return res.status(500).json({
      success: false,
      error: err.message || "Failed to initialize Cloudflare R2 upload."
    });
  }
};

exports.r2UploadPart = async (req, res) => {
  try {
    const mode = String(req.query.mode || "multipart").trim();
    const rawKey = req.query.key;
    const cleanKey = audioStorageService.sanitizeR2StorageKey(rawKey);
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || "");

    if (!body || body.length === 0) {
      return res.status(400).json({ success: false, error: "Empty audio chunk body." });
    }

    if (mode === "single") {
      const allowedTypes = new Set([
        "audio/mpeg",
        "audio/wav",
        "audio/wave",
        "audio/x-wav",
        "application/json",
        "audio/mp4",
        "audio/ogg",
        "audio/webm",
        "application/octet-stream"
      ]);
      const requestedType = req.query.contentType ? String(req.query.contentType).split(";")[0].trim().toLowerCase() : "";
      const contentType = allowedTypes.has(requestedType) ? requestedType : "audio/mpeg";
      const putRes = await audioStorageService.putSingleObject({
        key: cleanKey,
        contentType,
        body
      });
      return res.json({
        success: true,
        mode: "single",
        key: putRes.key,
        contentType,
        publicUrl: putRes.publicUrl,
        etag: putRes.etag
      });
    }

    const uploadId = String(req.query.uploadId || "").trim();
    const partNumber = Number(req.query.partNumber);
    const partRes = await audioStorageService.uploadMultipartPart({
      key: cleanKey,
      uploadId,
      partNumber,
      body
    });

    return res.json({
      success: true,
      mode: "multipart",
      key: cleanKey,
      partNumber: partRes.partNumber,
      etag: partRes.etag
    });
  } catch (err) {
    console.error("r2UploadPart error:", err);
    return res.status(500).json({
      success: false,
      error: err.message || "Failed to upload audio chunk to Cloudflare R2."
    });
  }
};

exports.r2CompleteUpload = async (req, res) => {
  try {
    const { key, uploadId, parts } = req.body || {};
    const cleanKey = audioStorageService.sanitizeR2StorageKey(key);
    const completed = await audioStorageService.completeMultipartUpload({
      key: cleanKey,
      uploadId,
      parts
    });
    return res.json({
      success: true,
      key: completed.key,
      publicUrl: completed.publicUrl,
      etag: completed.etag
    });
  } catch (err) {
    console.error("r2CompleteUpload error:", err);
    return res.status(500).json({
      success: false,
      error: err.message || "Failed to complete Cloudflare R2 upload."
    });
  }
};

exports.r2AbortUpload = async (req, res) => {
  try {
    const { key, uploadId } = req.body || {};
    const cleanKey = audioStorageService.sanitizeR2StorageKey(key);
    await audioStorageService.abortMultipartUpload({ key: cleanKey, uploadId });
    return res.json({ success: true });
  } catch {
    return res.json({ success: true });
  }
};

exports.r2PublishSession = async (req, res) => {
  try {
    const {
      session_date,
      title,
      storage_key,
      audio_url,
      duration_seconds,
      file_size_bytes,
      is_published,
      notify_devotees,
      timestamps,
      clear_timestamps,
      project_uid,
      checksum_sha256,
      artifact_role,
      r2_keys
    } = req.body || {};

    const cleanDate = session_date ? String(session_date).trim() : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cleanDate)) {
      return res.status(400).json({ success: false, error: "Valid session_date (YYYY-MM-DD) is required." });
    }

    const cleanKey = storage_key ? audioStorageService.sanitizeR2StorageKey(storage_key, cleanDate) : null;
    const resolvedUrl =
      (audio_url && String(audio_url).trim()) ||
      (cleanKey ? audioStorageService.getPublicUrlForKey(cleanKey) : "");

    if (!resolvedUrl) {
      return res.status(400).json({ success: false, error: "audio_url or storage_key is required." });
    }

    const cleanTitle =
      (title && String(title).trim().slice(0, 140)) || `Session Recording – ${cleanDate}`;
    const cleanDuration = Math.max(0, parseInt(duration_seconds, 10) || 0);
    const cleanSize = file_size_bytes != null ? Math.max(0, parseInt(file_size_bytes, 10) || 0) : null;
    const publishedFlag = typeof is_published === "boolean" ? is_published : true;
    const role = ["live_ref", "final_master", "stem_ch1", "stem_ch2"].includes(String(artifact_role || ""))
      ? String(artifact_role)
      : "final_master";
    const cleanChecksum = checksum_sha256 ? String(checksum_sha256).trim().slice(0, 64) : null;

    const existingBefore = await SessionAudio.findOne({ where: { session_date: cleanDate } });
    const idempotentRetry = Boolean(
      existingBefore &&
      cleanKey &&
      existingBefore.storage_key === cleanKey &&
      existingBefore.audio_url === resolvedUrl &&
      existingBefore.title === cleanTitle &&
      (cleanDuration === 0 || existingBefore.duration_seconds === cleanDuration) &&
      (cleanSize == null || existingBefore.file_size_bytes === cleanSize)
    );

    const [audio, created] = await SessionAudio.findOrCreate({
      where: { session_date: cleanDate },
      defaults: {
        session_date: cleanDate,
        title: cleanTitle,
        audio_url: resolvedUrl,
        storage_key: cleanKey,
        duration_seconds: cleanDuration,
        file_size_bytes: cleanSize,
        is_published: publishedFlag
      }
    });

    if (!created) {
      audio.title = cleanTitle;
      audio.audio_url = resolvedUrl;
      audio.storage_key = cleanKey;
      if (cleanDuration > 0) audio.duration_seconds = cleanDuration;
      if (cleanSize != null && cleanSize > 0) audio.file_size_bytes = cleanSize;
      audio.is_published = publishedFlag;
      await audio.save();
    }

    let createdTimestamps = [];
    let preservedTimestamps = false;
    const hasIncomingTimestamps = Array.isArray(timestamps) && timestamps.length > 0;
    const shouldClearTimestamps = clear_timestamps === true || clear_timestamps === "true";

    if (hasIncomingTimestamps || shouldClearTimestamps) {
      await SessionAudioTimestamp.destroy({ where: { session_audio_id: audio.id } });
      const rows = [];
      const seenKeys = new Map();
      const inputList = Array.isArray(timestamps) ? timestamps : [];
      const candidateSubIds = Array.from(
        new Set(
          inputList
            .map((t) => (t && t.submission_id ? parseInt(t.submission_id, 10) : 0))
            .filter((n) => Number.isInteger(n) && n > 0)
        )
      );
      const existingSubs = candidateSubIds.length > 0
        ? await BhajanSubmission.findAll({
            where: { id: candidateSubIds },
            attributes: ["id"],
            raw: true
          })
        : [];
      const validSubmissionIds = new Set(existingSubs.map((s) => Number(s.id)));

      for (let i = 0; i < inputList.length; i++) {
        const t = inputList[i];
        if (!t || !t.bhajan_title) continue;
        const bhajanTitle = String(t.bhajan_title).trim().slice(0, 140);
        if (!bhajanTitle) continue;
        const startSec = audioStorageService.parseTimestampToSeconds(
          t.start_timestamp != null ? t.start_timestamp : t.start_seconds
        );
        const explicitEnd = t.end_timestamp != null || t.end_seconds != null
          ? audioStorageService.parseTimestampToSeconds(t.end_timestamp != null ? t.end_timestamp : t.end_seconds)
          : null;
        const parsedSubId = t.submission_id ? parseInt(t.submission_id, 10) : null;
        const dedupKey = `${bhajanTitle.toLowerCase()}::${startSec}`;
        const row = {
          session_audio_id: audio.id,
          submission_id: parsedSubId && validSubmissionIds.has(parsedSubId) ? parsedSubId : null,
          bhajan_title: bhajanTitle,
          singer_name: String(t.singer_name || "Samiti Singer").trim().slice(0, 100),
          deity: t.deity ? String(t.deity).trim().slice(0, 60) : null,
          start_seconds: startSec,
          end_seconds: explicitEnd,
          order_index: typeof t.order_index === "number" ? t.order_index : i
        };
        if (seenKeys.has(dedupKey)) {
          const idx = seenKeys.get(dedupKey);
          rows[idx] = Object.assign({}, rows[idx], row, {
            submission_id: row.submission_id || rows[idx].submission_id
          });
        } else {
          seenKeys.set(dedupKey, rows.length);
          rows.push(row);
        }
      }
      rows.sort((a, b) => a.start_seconds - b.start_seconds);
      for (let i = 0; i < rows.length; i++) {
        rows[i].order_index = i;
        if (rows[i].end_seconds == null) {
          if (i + 1 < rows.length && rows[i + 1].start_seconds > rows[i].start_seconds) {
            rows[i].end_seconds = rows[i + 1].start_seconds;
          } else if (cleanDuration > rows[i].start_seconds) {
            rows[i].end_seconds = cleanDuration;
          }
        }
      }
      if (rows.length > 0) {
        createdTimestamps = await SessionAudioTimestamp.bulkCreate(rows);
      }
    } else {
      const existingRows = await SessionAudioTimestamp.findAll({
        where: { session_audio_id: audio.id },
        order: [["order_index", "ASC"], ["start_seconds", "ASC"]]
      });
      if (existingRows.length > 0) {
        preservedTimestamps = true;
        const lastRow = existingRows[existingRows.length - 1];
        if (lastRow && lastRow.end_seconds == null && cleanDuration > lastRow.start_seconds) {
          lastRow.end_seconds = cleanDuration;
          await lastRow.save().catch(() => { });
        }
        createdTimestamps = existingRows;
      }
    }

    let revisionsCount = 0;
    if (project_uid) {
      const cleanUid = String(project_uid).trim();
      const linkedProj = await StudioProject.findOne({ where: { project_uid: cleanUid } }).catch(() => null);
      if (linkedProj) {
        let existingKeys = {};
        try {
          existingKeys = linkedProj.r2_keys_json ? JSON.parse(linkedProj.r2_keys_json) : {};
        } catch {
          existingKeys = {};
        }
        const mergedKeys = Object.assign(
          {},
          existingKeys,
          r2_keys && typeof r2_keys === "object" ? r2_keys : {}
        );
        if (cleanKey) {
          if (role === "live_ref") mergedKeys.live_ref_key = cleanKey;
          else if (role === "final_master") mergedKeys.final_master_key = cleanKey;
          mergedKeys.latest_key = cleanKey;
          mergedKeys.latest_url = resolvedUrl;
        }
        const prevRevisions = Array.isArray(mergedKeys.revisions) ? mergedKeys.revisions : [];
        const revSig = `${role}::${cleanKey || resolvedUrl}::${cleanChecksum || ""}`;
        const alreadyRecorded = prevRevisions.some(
          (r) => `${r.artifact_role || ""}::${r.key || r.url || ""}::${r.checksum_sha256 || ""}` === revSig
        );
        if (!alreadyRecorded) {
          prevRevisions.push({
            artifact_role: role,
            key: cleanKey,
            url: resolvedUrl,
            duration_seconds: cleanDuration,
            file_size_bytes: cleanSize,
            checksum_sha256: cleanChecksum,
            published_at: new Date().toISOString()
          });
        }
        mergedKeys.revisions = prevRevisions.slice(-25);
        revisionsCount = mergedKeys.revisions.length;

        await linkedProj.update({
          publication_status: "published",
          r2_keys_json: JSON.stringify(mergedKeys),
          updated_at: new Date()
        }).catch(() => { });
      } else {
        await StudioProject.update(
          {
            publication_status: "published",
            updated_at: new Date()
          },
          { where: { project_uid: cleanUid } }
        ).catch(() => { });
      }
    }

    try {
      await ActivityLog.create({
        action: "LIVE_STUDIO_PUBLISH_AUDIO",
        details: `Published Cloudflare R2 audio (${role}) for ${cleanDate} ("${cleanTitle}") with ${createdTimestamps.length} timestamps${cleanChecksum ? ` [sha256:${cleanChecksum.slice(0, 12)}]` : ""}${idempotentRetry ? " [idempotent]" : ""}`,
        session_id: cleanDate,
        ip_address: req.ip || "127.0.0.1"
      });
    } catch {
      // ignore activity log failure
    }

    let pushSummary = null;
    if (publishedFlag && (notify_devotees === true || notify_devotees === "true")) {
      try {
        const pushRes = await notificationService.createAndBroadcast({
          type: "session_audio_published",
          title: "Devotional Session Audio Available",
          body: `The recorded audio for ${cleanDate} (${cleanTitle}) is now available in Live Plan & Archives.`,
          link: `/plan-view?session_date=${cleanDate}`,
          eventKey: `session_audio_${cleanDate}_${Date.now()}`,
          metadata: { session_date: cleanDate, audio_id: audio.id, title: audio.title }
        });
        pushSummary = pushRes.pushSummary || null;
      } catch (pushErr) {
        console.warn("Session audio push failed (audio still published):", pushErr.message);
      }
    }

    return res.json({
      success: true,
      idempotentRetry,
      preservedTimestamps,
      revisionsCount,
      artifactRole: role,
      audio: {
        id: audio.id,
        session_date: audio.session_date,
        title: audio.title,
        audio_url: audio.audio_url,
        storage_key: audio.storage_key,
        duration_seconds: audio.duration_seconds,
        file_size_bytes: audio.file_size_bytes,
        is_published: audio.is_published
      },
      timestampCount: createdTimestamps.length,
      pushSummary
    });
  } catch (err) {
    console.error("r2PublishSession error:", err);
    return res.status(500).json({
      success: false,
      error: err.message || "Failed to publish session recording."
    });
  }
};

exports.r2PresignUpload = async (req, res) => {
  try {
    if (!audioStorageService.isCloudflareConfigured()) {
      return res.status(503).json({
        success: false,
        error: "Cloudflare R2 credentials are not configured in environment."
      });
    }
    const { key, session_date, session_id, artifact_type, uploadId, partNumber, method } = req.body || {};
    const rawKey = key || audioStorageService.buildSessionObjectKey({
      sessionDate: session_date,
      sessionId: session_id,
      artifactType: artifact_type || "final-master.mp3"
    });
    const cleanKey = audioStorageService.sanitizeR2StorageKey(rawKey, session_date);
    const queryParams = {};
    if (uploadId && partNumber) {
      queryParams.uploadId = String(uploadId);
      queryParams.partNumber = String(partNumber);
    }
    const presigned = audioStorageService.createPresignedR2Url({
      method: method || "PUT",
      key: cleanKey,
      queryParams,
      expiresIn: 3600
    });
    return res.json({
      success: true,
      url: presigned.url,
      method: presigned.method,
      key: presigned.key,
      publicUrl: presigned.publicUrl,
      expiresIn: presigned.expiresIn
    });
  } catch (err) {
    console.error("r2PresignUpload error:", err);
    return res.status(500).json({
      success: false,
      error: err.message || "Failed to generate direct R2 upload URL."
    });
  }
};

exports.listStudioProjects = async (req, res) => {
  try {
    const rows = await StudioProject.findAll({
      order: [["updated_at", "DESC"]],
      limit: 50,
      raw: true
    });
    const projects = rows.map((r) => ({
      id: r.id,
      project_uid: r.project_uid,
      session_date: r.session_date,
      title: r.title,
      sample_rate: r.sample_rate,
      bit_depth: r.bit_depth,
      channel_config: r.channel_config,
      duration_seconds: r.duration_seconds,
      publication_status: r.publication_status,
      updated_at: r.updated_at
    }));
    res.json({ success: true, projects });
  } catch (err) {
    console.error("listStudioProjects error:", err);
    res.status(500).json({ success: false, error: "Failed to list studio projects." });
  }
};

exports.getStudioProject = async (req, res) => {
  try {
    const param = String(req.params.idOrDate || "").trim();
    if (!param) return res.status(400).json({ success: false, error: "Project ID or date required." });

    let row = null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(param)) {
      row = await StudioProject.findOne({
        where: { session_date: param },
        order: [["updated_at", "DESC"]],
        raw: true
      });
    } else if (/^\d+$/.test(param)) {
      row = await StudioProject.findByPk(Number(param), { raw: true });
    } else {
      row = await StudioProject.findOne({ where: { project_uid: param }, raw: true });
    }

    if (!row) {
      return res.status(404).json({ success: false, error: "Studio project not found." });
    }

    let manifest = null;
    try {
      manifest = JSON.parse(row.project_state_json);
    } catch {
      manifest = null;
    }

    return res.json({
      success: true,
      project: {
        id: row.id,
        project_uid: row.project_uid,
        session_date: row.session_date,
        title: row.title,
        sample_rate: row.sample_rate,
        bit_depth: row.bit_depth,
        channel_config: row.channel_config,
        duration_seconds: row.duration_seconds,
        publication_status: row.publication_status,
        checksum_sha256: row.checksum_sha256,
        local_files: row.local_files_json ? JSON.parse(row.local_files_json) : {},
        r2_keys: row.r2_keys_json ? JSON.parse(row.r2_keys_json) : {},
        manifest
      }
    });
  } catch (err) {
    console.error("getStudioProject error:", err);
    return res.status(500).json({ success: false, error: "Failed to load studio project." });
  }
};

exports.saveStudioProject = async (req, res) => {
  try {
    const body = req.body || {};
    const manifest = body.manifest || body;
    const rawDate = String(body.session_date || body.sessionDate || manifest.sessionDate || getLocalDateStr()).trim();
    const cleanDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : getLocalDateStr();
    const projectUid = String(body.project_uid || body.projectUid || manifest.projectUid || `proj-${cleanDate}`).trim().slice(0, 96);
    const title = String(body.title || manifest.title || `Bhajan Session – ${cleanDate}`).trim().slice(0, 160);
    const sampleRate = parseInt(body.sample_rate || body.sampleRate || manifest.sampleRate || 48000, 10) || 48000;
    const rawBitDepth = body.bit_depth || body.bitDepth || manifest.bitDepth || 24;
    const validation = audioStorageService.validateSessionManifest(Object.assign({}, manifest, {
      session_date: cleanDate,
      project_uid: projectUid,
      sample_rate: sampleRate,
      bit_depth: Number(rawBitDepth),
      duration_seconds: Number(body.duration_seconds ?? body.durationSeconds ?? manifest.durationSeconds ?? 0)
    }));
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        error: validation.errors.join(" "),
        errors: validation.errors
      });
    }
    const bitDepth = [16, 24, 32].includes(Number(rawBitDepth)) ? Number(rawBitDepth) : 24;
    const channelConfig = String(body.channel_config || body.channelConfig || manifest.channelConfig || "dual_mono_split").slice(0, 64);
    const durationSeconds = Math.max(0, Number(body.duration_seconds ?? body.durationSeconds ?? manifest.durationSeconds ?? 0) || 0);
    const pubStatus = String(body.publication_status || body.publicationStatus || manifest.publicationStatus || "draft").slice(0, 32);
    const checksum = (body.checksum_sha256 || body.checksumSha256)
      ? String(body.checksum_sha256 || body.checksumSha256).trim().slice(0, 64)
      : null;
    const now = new Date();

    const existing = await StudioProject.findOne({ where: { project_uid: projectUid } });
    let existingR2Keys = {};
    if (existing && existing.r2_keys_json) {
      try {
        existingR2Keys = JSON.parse(existing.r2_keys_json) || {};
      } catch {
        existingR2Keys = {};
      }
    }
    const incomingR2Keys = body.r2_keys || body.r2Keys || manifest.r2Keys || {};
    const mergedR2Keys = Object.assign({}, existingR2Keys, incomingR2Keys);
    if (!Array.isArray(incomingR2Keys.revisions) && Array.isArray(existingR2Keys.revisions)) {
      mergedR2Keys.revisions = existingR2Keys.revisions;
    }

    const payload = {
      project_uid: projectUid,
      session_date: cleanDate,
      title,
      sample_rate: Math.max(8000, sampleRate),
      bit_depth: bitDepth,
      channel_config: channelConfig,
      duration_seconds: durationSeconds,
      local_files_json: JSON.stringify(body.local_files || body.localFiles || manifest.localFiles || {}),
      r2_keys_json: JSON.stringify(mergedR2Keys),
      project_state_json: JSON.stringify(manifest),
      publication_status: pubStatus,
      checksum_sha256: checksum,
      updated_at: now
    };

    let saved;
    if (existing) {
      await existing.update(payload);
      saved = existing;
    } else {
      saved = await StudioProject.create(Object.assign({ created_at: now }, payload));
    }

    return res.json({
      success: true,
      project: {
        id: saved.id,
        project_uid: saved.project_uid,
        session_date: saved.session_date,
        title: saved.title,
        publication_status: saved.publication_status,
        duration_seconds: saved.duration_seconds,
        updated_at: saved.updated_at
      }
    });
  } catch (err) {
    console.error("saveStudioProject error:", err);
    return res.status(500).json({ success: false, error: "Failed to save studio project." });
  }
};

exports.deleteStudioProject = async (req, res) => {
  try {
    const param = String(req.params.id || "").trim();
    if (!param) {
      return res.status(400).json({ success: false, error: "Invalid project ID." });
    }
    const where = /^\d+$/.test(param) ? { id: Number(param) } : { project_uid: param };
    const deleted = await StudioProject.destroy({ where });
    if (!deleted) {
      return res.status(404).json({ success: false, error: "Project not found." });
    }
    return res.json({ success: true });
  } catch (err) {
    console.error("deleteStudioProject error:", err);
    return res.status(500).json({ success: false, error: "Failed to delete studio project." });
  }
};
