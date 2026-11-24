const express = require("express");
const router = express.Router();

const liveStreamController = require("../controllers/liveStreamController");
const { requireLogin, requireApiLogin } = require("../middleware/auth");

// Admin Live Broadcast Studio & Controls
router.get("/admin/live-stream", requireLogin, liveStreamController.showStudio);
router.get("/api/admin/live-stream/bhajans", requireApiLogin, liveStreamController.getSessionBhajans);
router.post("/api/admin/live-stream/start", requireApiLogin, liveStreamController.startBroadcast);
router.post("/api/admin/live-stream/stop", requireApiLogin, liveStreamController.stopBroadcast);
router.post("/api/admin/live-stream/now-singing", requireApiLogin, liveStreamController.setNowSinging);
router.get("/api/admin/live-stream/presets", requireApiLogin, liveStreamController.listPresets);
router.post("/api/admin/live-stream/presets", requireApiLogin, liveStreamController.savePreset);
router.delete("/api/admin/live-stream/presets/:id", requireApiLogin, liveStreamController.deletePreset);

// Public / Devotee Listener Endpoints
router.get("/api/live-stream/status", liveStreamController.getStatus);
router.get("/api/live-stream/events", liveStreamController.subscribeEvents);
router.get("/api/live-stream/audio", liveStreamController.streamAudio);

module.exports = router;
