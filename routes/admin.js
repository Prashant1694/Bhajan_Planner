const express = require("express");
const router = express.Router();

const adminController = require("../controllers/adminController");
const activityController = require("../controllers/activityController");
const {
  requireLogin,
  requireApiLogin,
  requireSuperAdmin,
  requireApiSuperAdmin
} = require("../middleware/auth");

router.get("/admin", requireLogin, adminController.dashboard);
router.get("/admin/missing-bhajans", requireLogin, adminController.showMissingBhajans);
router.get("/admin/activity-logs", requireLogin, activityController.showActivityLogs);
router.get("/api/admin/activity-feed", requireLogin, activityController.getActivityFeedJson);
router.post("/admin/activity-logs/purge", requireSuperAdmin, activityController.purgeOldLogs);
router.get("/admin/date/:date", requireLogin, adminController.sessionView);
router.get("/admin/edit/:id", requireLogin, adminController.editSubmissionForm);
router.post("/admin/edit/:id", requireLogin, adminController.updateSubmission);
router.post("/admin/delete/:id", requireLogin, adminController.deleteSubmission);
router.get("/admin/rules", requireLogin, adminController.showRules);
router.post("/admin/update-rules", requireLogin, adminController.updateRules);
router.post("/admin/permission", requireApiLogin, adminController.updatePermission);
router.post("/api/admin/toggle-lock", requireApiLogin, adminController.toggleLock);
router.post("/api/admin/reorder", requireApiLogin, adminController.reorderBhajans);
router.get("/admin/import-sessions", requireLogin, adminController.showImportSessions);
router.post("/admin/import-sessions", requireLogin, adminController.processImportSessions);
router.post("/admin/copy-session", requireLogin, adminController.copySession);
router.get(
  "/admin/danger-reset-history",
  requireSuperAdmin,
  adminController.showDangerResetHistory
);
router.get("/admin/download-backup", requireSuperAdmin, adminController.downloadBackup);

// Session Audio & Cloudflare R2 Management
const sessionAudioController = require("../controllers/sessionAudioController");
router.get("/admin/api/sessions/:date/audio", requireLogin, sessionAudioController.getSessionAudioData);
router.post("/admin/api/sessions/:date/audio", requireLogin, sessionAudioController.saveSessionAudio);
router.post("/admin/api/sessions/:date/audio/timestamps", requireLogin, sessionAudioController.saveAudioTimestamps);
router.delete("/admin/api/sessions/:date/audio", requireLogin, sessionAudioController.deleteSessionAudio);
router.get("/admin/api/cloudflare/audio-files", requireLogin, sessionAudioController.getCloudflareAudioFiles);

module.exports = router;
