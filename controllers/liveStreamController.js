const BhajanSubmission = require("../models/BhajanSubmission");
const MasterBhajan = require("../models/MasterBhajan");
const LiveStreamPreset = require("../models/LiveStreamPreset");
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
      streamState: liveStreamService.getPublicState()
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
