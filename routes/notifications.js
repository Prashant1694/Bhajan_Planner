const express = require("express");
const router = express.Router();

const notificationController = require("../controllers/notificationController");
const { requireLogin, requireApiLogin } = require("../middleware/auth");

// ── Public API routes (use device_id for identity) ───────────
router.get("/notification-settings", (req, res) => {
  res.render("notification-settings", { pageTitle: "Notification Settings", showLoader: false });
});
router.get("/api/notifications", notificationController.getNotifications);
router.get("/api/notifications/unread-count", notificationController.getUnreadCount);
router.post("/api/notifications/mark-read", notificationController.markRead);
router.post("/api/notifications/mark-all-read", notificationController.markAllRead);
router.post("/api/notifications/subscribe", notificationController.subscribe);
router.post("/api/notifications/unsubscribe", notificationController.unsubscribe);
router.get("/api/notifications/subscription-status", notificationController.subscriptionStatus);
router.get("/api/notifications/singer-pin-status", notificationController.getSingerPinStatus);
router.get("/api/notifications/vapid-key", notificationController.getVapidKey);
router.post("/api/notifications/test-device", notificationController.sendTestToDevice);

// ── Admin routes ─────────────────────────────────────────────
router.get("/admin/notifications", requireLogin, notificationController.adminNotifications);
router.post(
  "/admin/notifications/send-custom",
  requireApiLogin,
  notificationController.sendCustomNotification
);
router.post(
  "/admin/notifications/test",
  requireApiLogin,
  notificationController.sendTestNotification
);
router.post(
  "/admin/notifications/:id/delete",
  requireApiLogin,
  notificationController.deleteNotification
);

module.exports = router;
