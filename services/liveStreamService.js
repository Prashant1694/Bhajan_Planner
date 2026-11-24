const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const LiveStream = require("../models/LiveStream");

const ALLOWED_BITRATES = new Set([128, 192, 256, 320]);
const MAX_BURST_BYTES = 160 * 1024; // ~4 seconds at 320 kbps
const MAX_LISTENER_QUEUE_BYTES = 192 * 1024;
const STALLED_LISTENER_QUEUE_BYTES = 512 * 1024;
const BROADCASTER_GRACE_MS = 25 * 1000;

const DEFAULT_PRESETS = [
  {
    id: "builtin-mandir-studio",
    name: "Mandir Bhajan Studio",
    description: "Balanced 2-bus harmonium warmth, clear vocals, vocal leveling & soft hall reverb",
    isBuiltIn: true,
    config: {
      mode: "split",
      swapChannels: false,
      inst: { gain: 100, mute: false, hpf: 45, low: 1.5, mid: 0, high: -1.0 },
      vocal: { gain: 112, mute: false, hpf: 85, low: 0.5, mid: 2.5, deesser: 2.5, high: 1.5, comp: true },
      reverb: { wet: 14, decay: 1.4 },
      master: { b80: 0.5, b250: -1.5, b1k: 0, b3k5: 1.5, b10k: 1.0, glueComp: true, limiter: true, gain: 100, bypass: false }
    }
  },
  {
    id: "builtin-warm-hall",
    name: "Warm Devotional Hall",
    description: "Lush satsang hall ambience with gentle high-end smoothness",
    isBuiltIn: true,
    config: {
      mode: "split",
      swapChannels: false,
      inst: { gain: 105, mute: false, hpf: 40, low: 2.0, mid: 0.5, high: -1.5 },
      vocal: { gain: 110, mute: false, hpf: 80, low: 1.5, mid: 1.5, deesser: 2.5, high: 0.5, comp: true },
      reverb: { wet: 24, decay: 1.8 },
      master: { b80: 1.0, b250: -1.0, b1k: 0, b3k5: 1.0, b10k: 0.5, glueComp: true, limiter: true, gain: 100, bypass: false }
    }
  },
  {
    id: "builtin-vocal-forward",
    name: "Vocal Forward / Satsang",
    description: "Pulls instruments back slightly and lifts vocal lyric intelligibility",
    isBuiltIn: true,
    config: {
      mode: "split",
      swapChannels: false,
      inst: { gain: 85, mute: false, hpf: 60, low: 0, mid: -2.0, high: -1.5 },
      vocal: { gain: 120, mute: false, hpf: 95, low: -1.0, mid: 4.0, deesser: 3.5, high: 2.5, comp: true },
      reverb: { wet: 12, decay: 1.2 },
      master: { b80: -0.5, b250: -2.5, b1k: 0.5, b3k5: 2.5, b10k: 1.5, glueComp: true, limiter: true, gain: 100, bypass: false }
    }
  },
  {
    id: "builtin-tabla-harmonium",
    name: "Harmonium & Tabla Crisp",
    description: "Tight tabla low-end punch and articulated reed/manjira harmonics",
    isBuiltIn: true,
    config: {
      mode: "split",
      swapChannels: false,
      inst: { gain: 108, mute: false, hpf: 38, low: 3.0, mid: 1.0, high: 2.0 },
      vocal: { gain: 110, mute: false, hpf: 85, low: 0, mid: 2.0, deesser: 2.5, high: 2.0, comp: true },
      reverb: { wet: 10, decay: 1.1 },
      master: { b80: 1.5, b250: -2.0, b1k: 0, b3k5: 2.0, b10k: 2.5, glueComp: true, limiter: true, gain: 100, bypass: false }
    }
  },
  {
    id: "builtin-flat",
    name: "Flat / Pass-Through (Limiter Only)",
    description: "Zero EQ or reverb coloring with broadcast safety brickwall limiter",
    isBuiltIn: true,
    config: {
      mode: "split",
      swapChannels: false,
      inst: { gain: 100, mute: false, hpf: 20, low: 0, mid: 0, high: 0 },
      vocal: { gain: 100, mute: false, hpf: 20, low: 0, mid: 0, deesser: 0, high: 0, comp: false },
      reverb: { wet: 0, decay: 1.2 },
      master: { b80: 0, b250: 0, b1k: 0, b3k5: 0, b10k: 0, glueComp: false, limiter: true, gain: 100, bypass: true }
    }
  }
];

const state = {
  isLive: false,
  streamId: null,
  title: "Live Bhajan Session",
  sessionDate: null,
  bitrateKbps: 320,
  accessMode: "public",
  startedAt: null,
  startedByName: null,
  nowSinging: null,
  ingestToken: null,
  broadcasterWs: null,
  broadcasterConnected: false,
  disconnectGraceTimer: null,
  peakListeners: 0,
  bytesReceived: 0,
  lastChunkAt: null
};

let burstChunks = [];
let burstBytes = 0;

const audioListeners = new Set();
const sseClients = new Set();
let wssInstance = null;

function findMpegSyncOffset(buf) {
  if (!buf || buf.length < 2) return -1;
  for (let i = 0; i < buf.length - 1; i++) {
    if (buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0 && (buf[i + 1] & 0x06) !== 0x00) {
      return i;
    }
  }
  return -1;
}

function getSyncedBurstBuffer() {
  if (burstChunks.length === 0) return null;
  const combined = Buffer.concat(burstChunks);
  const syncOffset = findMpegSyncOffset(combined);
  if (syncOffset < 0) return null;
  return syncOffset === 0 ? combined : combined.subarray(syncOffset);
}

function appendBurstChunk(buf) {
  burstChunks.push(buf);
  burstBytes += buf.length;
  while (burstBytes > MAX_BURST_BYTES && burstChunks.length > 1) {
    const removed = burstChunks.shift();
    burstBytes -= removed.length;
  }
}

function clearGraceTimer() {
  if (state.disconnectGraceTimer) {
    clearTimeout(state.disconnectGraceTimer);
    state.disconnectGraceTimer = null;
  }
}

function getPublicState() {
  return {
    isLive: state.isLive,
    streamId: state.streamId,
    title: state.title,
    sessionDate: state.sessionDate,
    bitrateKbps: state.bitrateKbps,
    accessMode: state.accessMode,
    startedAt: state.startedAt,
    startedByName: state.startedByName,
    nowSinging: state.nowSinging,
    broadcasterConnected: state.broadcasterConnected,
    listenerCount: audioListeners.size,
    peakListeners: state.peakListeners
  };
}

function broadcastSseEvent(eventName = "status") {
  if (sseClients.size === 0) return;
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(getPublicState())}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

function broadcastAudioChunk(chunk) {
  if (!state.isLive || !chunk || chunk.length === 0) return;
  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (buf.length === 0) return;

  state.bytesReceived += buf.length;
  state.lastChunkAt = Date.now();
  appendBurstChunk(buf);

  for (const res of audioListeners) {
    if (res.writableEnded || res.destroyed) {
      audioListeners.delete(res);
      continue;
    }
    if (res.writableLength > STALLED_LISTENER_QUEUE_BYTES) {
      audioListeners.delete(res);
      try {
        res.destroy();
      } catch {
        // ignore socket cleanup error
      }
      continue;
    }
    if (res.writableLength > MAX_LISTENER_QUEUE_BYTES) {
      continue;
    }
    try {
      res.write(buf);
    } catch {
      audioListeners.delete(res);
    }
  }
}

function addAudioListener(req, res) {
  audioListeners.add(res);
  if (audioListeners.size > state.peakListeners) {
    state.peakListeners = audioListeners.size;
    if (state.streamId) {
      LiveStream.update(
        { peak_listeners: state.peakListeners, updated_at: new Date() },
        { where: { id: state.streamId } }
      ).catch(() => {});
    }
  }

  const initialBurst = getSyncedBurstBuffer();
  if (initialBurst && initialBurst.length > 0 && !res.writableEnded && !res.destroyed) {
    try {
      res.write(initialBurst);
    } catch {
      audioListeners.delete(res);
      return;
    }
  }

  broadcastSseEvent("status");

  const cleanup = () => {
    if (audioListeners.delete(res)) {
      broadcastSseEvent("status");
    }
  };
  req.on("close", cleanup);
  req.on("aborted", cleanup);
  res.on("close", cleanup);
  res.on("error", cleanup);
}

function addSseClient(req, res) {
  sseClients.add(res);
  try {
    res.write(`event: status\ndata: ${JSON.stringify(getPublicState())}\n\n`);
  } catch {
    sseClients.delete(res);
    return;
  }

  const pingTimer = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      clearInterval(pingTimer);
      sseClients.delete(res);
      return;
    }
    try {
      res.write(": ping\n\n");
    } catch {
      clearInterval(pingTimer);
      sseClients.delete(res);
    }
  }, 25000);
  if (pingTimer.unref) pingTimer.unref();

  const cleanup = () => {
    clearInterval(pingTimer);
    sseClients.delete(res);
  };
  req.on("close", cleanup);
  req.on("aborted", cleanup);
  res.on("close", cleanup);
}

async function startStream({
  title,
  sessionDate = null,
  bitrateKbps = 320,
  accessMode = "public",
  adminId = null,
  adminName = "Admin"
} = {}) {
  if (state.isLive) {
    await stopStream("Replaced by new broadcast session");
  }

  clearGraceTimer();
  const parsedBitrate = Number(bitrateKbps);
  const cleanBitrate = ALLOWED_BITRATES.has(parsedBitrate) ? parsedBitrate : 320;
  const cleanMode = accessMode === "singers_only" ? "singers_only" : "public";
  const cleanTitle = String(title || "Live Bhajan Session").trim().slice(0, 140) || "Live Bhajan Session";
  const cleanToken = crypto.randomBytes(32).toString("hex");
  const now = new Date();

  const record = await LiveStream.create({
    status: "live",
    title: cleanTitle,
    session_date: sessionDate || null,
    bitrate_kbps: cleanBitrate,
    access_mode: cleanMode,
    started_by_admin_id: adminId || null,
    started_by_name: adminName || "Admin",
    started_at: now,
    peak_listeners: 0,
    created_at: now,
    updated_at: now
  });

  state.isLive = true;
  state.streamId = record.id;
  state.title = cleanTitle;
  state.sessionDate = sessionDate || null;
  state.bitrateKbps = cleanBitrate;
  state.accessMode = cleanMode;
  state.startedAt = now.toISOString();
  state.startedByName = adminName || "Admin";
  state.nowSinging = null;
  state.ingestToken = cleanToken;
  state.broadcasterWs = null;
  state.broadcasterConnected = false;
  state.peakListeners = 0;
  state.bytesReceived = 0;
  state.lastChunkAt = null;
  burstChunks = [];
  burstBytes = 0;

  broadcastSseEvent("status");

  return {
    ingestToken: cleanToken,
    stream: getPublicState()
  };
}

async function stopStream() {
  clearGraceTimer();
  const prevStreamId = state.streamId;
  const prevPeak = state.peakListeners;

  state.isLive = false;
  state.ingestToken = null;
  state.broadcasterConnected = false;
  state.nowSinging = null;
  burstChunks = [];
  burstBytes = 0;

  if (state.broadcasterWs) {
    try {
      state.broadcasterWs.close(1000, "Stream ended");
    } catch {
      // ignore ws close error
    }
    state.broadcasterWs = null;
  }

  for (const res of audioListeners) {
    try {
      if (!res.writableEnded) res.end();
    } catch {
      // ignore listener close error
    }
  }
  audioListeners.clear();

  state.streamId = null;

  if (prevStreamId) {
    try {
      await LiveStream.update(
        {
          status: "offline",
          ended_at: new Date(),
          peak_listeners: prevPeak,
          updated_at: new Date()
        },
        { where: { id: prevStreamId } }
      );
    } catch {
      // keep state consistent even if DB write fails during shutdown
    }
  }

  broadcastSseEvent("status");
  return getPublicState();
}

async function updateNowSinging({
  submissionId = null,
  title = null,
  singerName = null,
  masterId = null,
  clear = false
} = {}) {
  if (!state.isLive || !state.streamId) {
    return null;
  }

  const nextNowSinging =
    clear || !title
      ? null
      : {
          submissionId: submissionId ? Number(submissionId) : null,
          title: String(title).trim().slice(0, 140),
          singerName: singerName ? String(singerName).trim().slice(0, 100) : "",
          masterId: masterId ? Number(masterId) : null
        };

  state.nowSinging = nextNowSinging;

  await LiveStream.update(
    {
      current_submission_id: nextNowSinging ? nextNowSinging.submissionId : null,
      current_bhajan_title: nextNowSinging ? nextNowSinging.title : null,
      current_singer_name: nextNowSinging ? nextNowSinging.singerName : null,
      current_master_id: nextNowSinging ? nextNowSinging.masterId : null,
      updated_at: new Date()
    },
    { where: { id: state.streamId } }
  );

  broadcastSseEvent("status");
  return nextNowSinging;
}

function tokensMatch(candidate, active) {
  if (!candidate || !active) return false;
  const bufA = Buffer.from(String(candidate), "utf8");
  const bufB = Buffer.from(String(active), "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function attachLiveStreamWebSocket(httpServer) {
  if (!httpServer) return null;
  if (wssInstance) {
    try {
      wssInstance.close();
    } catch {
      // ignore old wss close error
    }
  }

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 512 * 1024
  });
  wssInstance = wss;

  const upgradeHandler = (req, socket, head) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    } catch {
      socket.destroy();
      return;
    }

    if (parsedUrl.pathname !== "/ws/live-stream/ingest") {
      return;
    }

    const token = parsedUrl.searchParams.get("token") || "";
    if (!state.isLive || !tokensMatch(token, state.ingestToken)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  };

  httpServer.on("upgrade", upgradeHandler);

  wss.on("connection", (ws) => {
    clearGraceTimer();
    if (state.broadcasterWs && state.broadcasterWs !== ws) {
      try {
        state.broadcasterWs.close(4001, "Superseded by reconnected broadcaster");
      } catch {
        // ignore old broadcaster close
      }
    }

    state.broadcasterWs = ws;
    state.broadcasterConnected = true;
    broadcastSseEvent("status");

    ws.on("message", (data, isBinary) => {
      if (!state.isLive || state.broadcasterWs !== ws) return;
      if (isBinary) {
        broadcastAudioChunk(data);
        return;
      }
      try {
        const msg = JSON.parse(String(data));
        if (msg && msg.type === "ping") {
          ws.send(
            JSON.stringify({
              type: "pong",
              isLive: state.isLive,
              listeners: audioListeners.size,
              bytesReceived: state.bytesReceived
            })
          );
        }
      } catch {
        // ignore malformed control message
      }
    });

    ws.on("close", (code) => {
      if (state.broadcasterWs !== ws) return;
      state.broadcasterWs = null;
      state.broadcasterConnected = false;

      if (!state.isLive) return;

      if (code === 1000) {
        stopStream().catch(() => {});
        return;
      }

      broadcastSseEvent("status");
      clearGraceTimer();
      state.disconnectGraceTimer = setTimeout(() => {
        if (state.isLive && !state.broadcasterConnected) {
          stopStream().catch(() => {});
        }
      }, BROADCASTER_GRACE_MS);
      if (state.disconnectGraceTimer.unref) {
        state.disconnectGraceTimer.unref();
      }
    });
  });

  return wss;
}

function shutdownLiveStream() {
  clearGraceTimer();
  state.isLive = false;
  state.ingestToken = null;
  state.broadcasterConnected = false;

  if (state.broadcasterWs) {
    try {
      state.broadcasterWs.terminate();
    } catch {
      // ignore
    }
    state.broadcasterWs = null;
  }

  for (const res of audioListeners) {
    try {
      res.end();
    } catch {
      // ignore
    }
  }
  audioListeners.clear();

  for (const res of sseClients) {
    try {
      res.end();
    } catch {
      // ignore
    }
  }
  sseClients.clear();

  if (wssInstance) {
    try {
      wssInstance.close();
    } catch {
      // ignore
    }
    wssInstance = null;
  }
}

module.exports = {
  ALLOWED_BITRATES,
  DEFAULT_PRESETS,
  findMpegSyncOffset,
  attachLiveStreamWebSocket,
  startStream,
  stopStream,
  updateNowSinging,
  getPublicState,
  addAudioListener,
  addSseClient,
  broadcastAudioChunk,
  shutdownLiveStream
};
