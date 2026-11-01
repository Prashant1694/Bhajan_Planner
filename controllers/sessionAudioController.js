const SessionAudio = require("../models/SessionAudio");
const SessionAudioTimestamp = require("../models/SessionAudioTimestamp");
const BhajanSubmission = require("../models/BhajanSubmission");
const audioStorageService = require("../services/audioStorageService");
const ActivityLog = require("../models/ActivityLog");
const notificationService = require("../services/notificationService");

/**
 * GET /admin/api/sessions/:date/audio
 * Returns the session audio recording, configured timestamps,
 * and the list of scheduled bhajans (with singers) for dropdown selection.
 */
exports.getSessionAudioData = async (req, res) => {
  try {
    const { date } = req.params;
    if (!date) return res.status(400).json({ error: "Session date is required." });

    // 1. Fetch current audio record (if any)
    const audio = await SessionAudio.findOne({
      where: { session_date: date },
      include: [
        {
          model: SessionAudioTimestamp,
          as: "timestamps"
        }
      ],
      order: [[{ model: SessionAudioTimestamp, as: "timestamps" }, "start_seconds", "ASC"]]
    });

    // 2. Fetch all bhajans scheduled for this session date (for the dropdown)
    const scheduledBhajans = await BhajanSubmission.findAll({
      where: { session_date: date },
      order: [["list_order", "ASC"], ["id", "ASC"]]
    });

    const bhajansList = scheduledBhajans.map((b) => ({
      id: b.id,
      title: b.title,
      singer_name: b.singer_name,
      partner_name: b.partner_name,
      deity: b.deity,
      scale: b.scale,
      speed: b.speed,
      list_order: b.list_order
    }));

    // 3. Fetch Cloudflare R2 files list
    const r2Result = await audioStorageService.listR2AudioFiles();

    res.json({
      success: true,
      session_date: date,
      audio: audio
        ? {
            id: audio.id,
            session_date: audio.session_date,
            title: audio.title,
            audio_url: audio.audio_url,
            storage_key: audio.storage_key,
            duration_seconds: audio.duration_seconds,
            duration_formatted: audioStorageService.formatSecondsToTimestamp(audio.duration_seconds),
            is_published: audio.is_published,
            timestamps: (audio.timestamps || []).map((t) => ({
              id: t.id,
              submission_id: t.submission_id,
              bhajan_title: t.bhajan_title,
              singer_name: t.singer_name,
              deity: t.deity,
              start_seconds: t.start_seconds,
              start_formatted: audioStorageService.formatSecondsToTimestamp(t.start_seconds),
              end_seconds: t.end_seconds,
              end_formatted: t.end_seconds ? audioStorageService.formatSecondsToTimestamp(t.end_seconds) : null,
              order_index: t.order_index
            }))
          }
        : null,
      scheduledBhajans: bhajansList,
      cloudflare: {
        configured: r2Result.configured,
        message: r2Result.message,
        files: r2Result.files || []
      }
    });
  } catch (err) {
    console.error("getSessionAudioData error:", err);
    res.status(500).json({ error: "Failed to load session audio data." });
  }
};

/**
 * POST /admin/api/sessions/:date/audio
 * Upserts the audio recording for this session.
 */
exports.saveSessionAudio = async (req, res) => {
  try {
    const { date } = req.params;
    let { audio_url, storage_key, title, duration_seconds, is_published } = req.body;

    if (!date) return res.status(400).json({ error: "Session date is required." });

    // If storage_key is provided without audio_url, compute public url
    if (!audio_url && storage_key) {
      audio_url = audioStorageService.getPublicUrlForKey(storage_key);
    }

    if (!audio_url || !audio_url.trim()) {
      return res.status(400).json({ error: "Audio URL or Cloudflare storage key is required." });
    }

    audio_url = audio_url.trim();
    title = (title && title.trim()) || `Session Recording – ${date}`;
    duration_seconds = parseInt(duration_seconds, 10) || 0;
    is_published = typeof is_published === "boolean" ? is_published : true;

    let [audio, created] = await SessionAudio.findOrCreate({
      where: { session_date: date },
      defaults: {
        session_date: date,
        title,
        audio_url,
        storage_key: storage_key || null,
        duration_seconds,
        is_published
      }
    });

    if (!created) {
      audio.title = title;
      audio.audio_url = audio_url;
      audio.storage_key = storage_key || null;
      if (duration_seconds > 0) audio.duration_seconds = duration_seconds;
      audio.is_published = is_published;
      await audio.save();
    }

    // Log admin activity
    try {
      await ActivityLog.create({
        action: created ? "CREATE_SESSION_AUDIO" : "UPDATE_SESSION_AUDIO",
        details: `Linked audio recording for session ${date}: "${title}"`,
        session_id: date,
        ip_address: req.ip || "127.0.0.1"
      });
    } catch (_) {}

    // Broadcast notification to everyone that session audio is now available
    if (audio.is_published) {
      try {
        const dParts = String(date).split("-");
        let formattedDate = date;
        let dayName = "";
        if (dParts.length === 3) {
          const dObj = new Date(parseInt(dParts[0], 10), parseInt(dParts[1], 10) - 1, parseInt(dParts[2], 10));
          dayName = dObj.toLocaleDateString("en-US", { weekday: "long" });
          formattedDate = dObj.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
        }
        const notifTitle = "Devotional Session Audio Available";
        const notifBody = dayName
          ? `The recorded audio for the ${dayName} (${formattedDate}) bhajan session is now available to hear in Live Plan & Archives.`
          : `The recorded audio for the ${formattedDate} bhajan session is now available to hear in Live Plan & Archives.`;

        await notificationService.createAndBroadcast({
          type: "session_audio_published",
          title: notifTitle,
          body: notifBody,
          link: `/plan-view?session_date=${date}`,
          eventKey: `session_audio_${date}_${Date.now()}`,
          metadata: {
            session_date: date,
            audio_id: audio.id,
            title: audio.title
          }
        });
      } catch (notifErr) {
        console.error("Failed to broadcast session audio notification:", notifErr);
      }
    }

    res.json({
      success: true,
      message: created ? "Audio recording linked successfully." : "Audio recording updated.",
      audio: {
        id: audio.id,
        session_date: audio.session_date,
        title: audio.title,
        audio_url: audio.audio_url,
        storage_key: audio.storage_key,
        duration_seconds: audio.duration_seconds,
        is_published: audio.is_published
      }
    });
  } catch (err) {
    console.error("saveSessionAudio error:", err);
    res.status(500).json({ error: "Failed to save session audio recording." });
  }
};

/**
 * POST /admin/api/sessions/:date/audio/timestamps
 * Saves or updates timestamps for the session audio.
 */
exports.saveAudioTimestamps = async (req, res) => {
  try {
    const { date } = req.params;
    const { timestamps } = req.body;

    if (!date) return res.status(400).json({ error: "Session date is required." });
    if (!Array.isArray(timestamps)) {
      return res.status(400).json({ error: "Timestamps array is required." });
    }

    const audio = await SessionAudio.findOne({ where: { session_date: date } });
    if (!audio) {
      return res.status(404).json({ error: "No audio recording found for this session. Please link an audio recording first." });
    }

    // Replace all existing timestamps for this audio with the updated set
    await SessionAudioTimestamp.destroy({ where: { session_audio_id: audio.id } });

    const newRows = [];
    for (let i = 0; i < timestamps.length; i++) {
      const t = timestamps[i];
      if (!t.bhajan_title || !t.singer_name) continue;

      const startSec = audioStorageService.parseTimestampToSeconds(t.start_timestamp != null ? t.start_timestamp : t.start_seconds);
      const endSec = t.end_timestamp != null || t.end_seconds != null
        ? audioStorageService.parseTimestampToSeconds(t.end_timestamp != null ? t.end_timestamp : t.end_seconds)
        : null;

      newRows.push({
        session_audio_id: audio.id,
        submission_id: t.submission_id ? parseInt(t.submission_id, 10) : null,
        bhajan_title: String(t.bhajan_title).trim(),
        singer_name: String(t.singer_name).trim(),
        deity: t.deity ? String(t.deity).trim() : null,
        start_seconds: startSec,
        end_seconds: endSec,
        order_index: typeof t.order_index === "number" ? t.order_index : i
      });
    }

    // Sort by start_seconds
    newRows.sort((a, b) => a.start_seconds - b.start_seconds);

    let createdTimestamps = [];
    if (newRows.length > 0) {
      createdTimestamps = await SessionAudioTimestamp.bulkCreate(newRows);
    }

    // Log admin activity
    try {
      await ActivityLog.create({
        action: "UPDATE_AUDIO_TIMESTAMPS",
        details: `Updated ${newRows.length} bhajan timestamps for session ${date}`,
        session_id: date,
        ip_address: req.ip || "127.0.0.1"
      });
    } catch (_) {}

    res.json({
      success: true,
      message: `Saved ${createdTimestamps.length} bhajan timestamps.`,
      count: createdTimestamps.length,
      timestamps: createdTimestamps.map((t) => ({
        id: t.id,
        submission_id: t.submission_id,
        bhajan_title: t.bhajan_title,
        singer_name: t.singer_name,
        deity: t.deity,
        start_seconds: t.start_seconds,
        start_formatted: audioStorageService.formatSecondsToTimestamp(t.start_seconds),
        end_seconds: t.end_seconds,
        end_formatted: t.end_seconds ? audioStorageService.formatSecondsToTimestamp(t.end_seconds) : null,
        order_index: t.order_index
      }))
    });
  } catch (err) {
    console.error("saveAudioTimestamps error:", err);
    res.status(500).json({ error: "Failed to save audio timestamps." });
  }
};

/**
 * DELETE /admin/api/sessions/:date/audio
 * Unlinks the audio recording and associated timestamps.
 */
exports.deleteSessionAudio = async (req, res) => {
  try {
    const { date } = req.params;
    const audio = await SessionAudio.findOne({ where: { session_date: date } });
    if (!audio) {
      return res.status(404).json({ error: "No audio recording found for this session." });
    }

    await SessionAudioTimestamp.destroy({ where: { session_audio_id: audio.id } });
    await audio.destroy();

    try {
      await ActivityLog.create({
        action: "DELETE_SESSION_AUDIO",
        details: `Removed audio recording for session ${date}`,
        session_id: date,
        ip_address: req.ip || "127.0.0.1"
      });
    } catch (_) {}

    res.json({ success: true, message: "Session audio removed successfully." });
  } catch (err) {
    console.error("deleteSessionAudio error:", err);
    res.status(500).json({ error: "Failed to remove session audio." });
  }
};

/**
 * GET /admin/api/cloudflare/audio-files
 * Fetches available files from Cloudflare R2 bucket.
 */
exports.getCloudflareAudioFiles = async (req, res) => {
  try {
    const r2Result = await audioStorageService.listR2AudioFiles();
    res.json({ success: true, ...r2Result });
  } catch (err) {
    console.error("getCloudflareAudioFiles error:", err);
    res.status(500).json({ error: "Failed to list Cloudflare R2 audio files." });
  }
};

/**
 * GET /api/sessions/:date/audio (Public / Devotee endpoint)
 * Returns the published session audio recording with timestamps.
 */
exports.getPublicSessionAudio = async (req, res) => {
  try {
    const { date } = req.params;
    if (!date) return res.status(400).json({ error: "Session date is required." });

    const audio = await SessionAudio.findOne({
      where: { session_date: date, is_published: true },
      include: [
        {
          model: SessionAudioTimestamp,
          as: "timestamps"
        }
      ],
      order: [[{ model: SessionAudioTimestamp, as: "timestamps" }, "start_seconds", "ASC"]]
    });

    if (!audio) {
      return res.json({ success: true, hasAudio: false, audio: null });
    }

    res.json({
      success: true,
      hasAudio: true,
      audio: {
        id: audio.id,
        session_date: audio.session_date,
        title: audio.title,
        audio_url: audio.audio_url,
        duration_seconds: audio.duration_seconds,
        duration_formatted: audioStorageService.formatSecondsToTimestamp(audio.duration_seconds),
        timestamps: (audio.timestamps || []).map((t) => ({
          id: t.id,
          submission_id: t.submission_id,
          bhajan_title: t.bhajan_title,
          singer_name: t.singer_name,
          deity: t.deity,
          start_seconds: t.start_seconds,
          start_formatted: audioStorageService.formatSecondsToTimestamp(t.start_seconds),
          end_seconds: t.end_seconds,
          end_formatted: t.end_seconds ? audioStorageService.formatSecondsToTimestamp(t.end_seconds) : null,
          order_index: t.order_index
        }))
      }
    });
  } catch (err) {
    console.error("getPublicSessionAudio error:", err);
    res.status(500).json({ error: "Failed to fetch public session audio." });
  }
};

/**
 * GET /api/singers/:singerName/audio-bhajans (Public / Devotee endpoint)
 * Returns all past bhajans sung by this singer with playable audio timestamps.
 */
exports.getSingerAudioBhajans = async (req, res) => {
  try {
    const { singerName } = req.params;
    if (!singerName) return res.status(400).json({ error: "Singer name is required." });

    const timestamps = await SessionAudioTimestamp.findAll({
      where: { singer_name: singerName },
      include: [
        {
          model: SessionAudio,
          as: "sessionAudio",
          where: { is_published: true }
        }
      ],
      order: [["created_at", "DESC"], ["start_seconds", "ASC"]]
    });

    const items = timestamps.map((t) => ({
      timestamp_id: t.id,
      submission_id: t.submission_id,
      bhajan_title: t.bhajan_title,
      singer_name: t.singer_name,
      deity: t.deity,
      session_date: t.sessionAudio.session_date,
      session_title: t.sessionAudio.title,
      audio_url: t.sessionAudio.audio_url,
      start_seconds: t.start_seconds,
      start_formatted: audioStorageService.formatSecondsToTimestamp(t.start_seconds),
      end_seconds: t.end_seconds
    }));

    res.json({ success: true, singer: singerName, count: items.length, audioBhajans: items });
  } catch (err) {
    console.error("getSingerAudioBhajans error:", err);
    res.status(500).json({ error: "Failed to fetch singer audio bhajans." });
  }
};
