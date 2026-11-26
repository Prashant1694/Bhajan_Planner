const express = require("express");
const router = express.Router();

const liveStreamController = require("../controllers/liveStreamController");
const { requireLogin, requireApiLogin } = require("../middleware/auth");

const rawBinaryChunkParser = express.raw({
  type: "application/octet-stream",
  limit: "12mb"
});

// Admin Live Broadcast Studio & Controls
router.get("/admin/live-stream", requireLogin, liveStreamController.showStudio);
router.get("/api/admin/live-stream/bhajans", requireApiLogin, liveStreamController.getSessionBhajans);
router.post("/api/admin/live-stream/start", requireApiLogin, liveStreamController.startBroadcast);
router.post("/api/admin/live-stream/stop", requireApiLogin, liveStreamController.stopBroadcast);
router.post("/api/admin/live-stream/now-singing", requireApiLogin, liveStreamController.setNowSinging);
router.get("/api/admin/live-stream/presets", requireApiLogin, liveStreamController.listPresets);
router.post("/api/admin/live-stream/presets", requireApiLogin, liveStreamController.savePreset);
router.delete("/api/admin/live-stream/presets/:id", requireApiLogin, liveStreamController.deletePreset);

// Admin Direct Cloudflare R2 Upload & Auto-Publish
router.get("/api/admin/live-stream/r2/status", requireApiLogin, liveStreamController.getR2Status);
router.post("/api/admin/live-stream/r2/presign", requireApiLogin, liveStreamController.r2PresignUpload);
router.post("/api/admin/live-stream/r2/upload-init", requireApiLogin, liveStreamController.r2InitUpload);
router.post(
  "/api/admin/live-stream/r2/upload-part",
  requireApiLogin,
  rawBinaryChunkParser,
  liveStreamController.r2UploadPart
);
router.post("/api/admin/live-stream/r2/upload-complete", requireApiLogin, liveStreamController.r2CompleteUpload);
router.post("/api/admin/live-stream/r2/upload-abort", requireApiLogin, liveStreamController.r2AbortUpload);
router.post("/api/admin/live-stream/r2/publish", requireApiLogin, liveStreamController.r2PublishSession);

// Admin DAW Studio Project Persistence
router.get("/api/admin/live-stream/projects", requireApiLogin, liveStreamController.listStudioProjects);
router.get("/api/admin/live-stream/projects/:idOrDate", requireApiLogin, liveStreamController.getStudioProject);
router.post("/api/admin/live-stream/projects", requireApiLogin, liveStreamController.saveStudioProject);
router.delete("/api/admin/live-stream/projects/:id", requireApiLogin, liveStreamController.deleteStudioProject);

// Public / Devotee Listener Endpoints
router.get("/api/live-stream/status", liveStreamController.getStatus);
router.get("/api/live-stream/events", liveStreamController.subscribeEvents);
router.get("/api/live-stream/audio", liveStreamController.streamAudio);

module.exports = router;
