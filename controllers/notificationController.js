const Singer = require("../models/Singer");
const PushSubscription = require("../models/PushSubscription");
const notificationService = require("../services/notificationService");

// ── API: Get notifications for device/singer ─────────────────
exports.getNotifications = async (req, res) => {
  try {
    const deviceId = req.query.device_id;
    if (!deviceId) return res.json({ notifications: [] });

    // Find singer associated with this device or session
    const sub = await PushSubscription.findOne({ where: { device_id: deviceId } });
    const singerId = req.session?.singer?.id || (sub ? sub.singer_id : null);

    const notifications = await notificationService.getNotificationsForDevice(
      deviceId,
      singerId,
      30
    );
    res.json({ notifications });
  } catch (error) {
    console.error(`[Req ${req.id || ""}] Failed to get notifications:`, error);
    res.status(500).json({ error: "Failed to retrieve notifications." });
  }
};

// ── API: Get unread count ────────────────────────────────────
exports.getUnreadCount = async (req, res) => {
  try {
    const deviceId = req.query.device_id;
    if (!deviceId) return res.json({ count: 0 });

    const sub = await PushSubscription.findOne({ where: { device_id: deviceId } });
    const singerId = req.session?.singer?.id || (sub ? sub.singer_id : null);

    const count = await notificationService.getUnreadCount(deviceId, singerId);
    res.json({ count });
  } catch (error) {
    console.error(`[Req ${req.id || ""}] Failed to get unread count:`, error);
    res.status(500).json({ error: "Failed to retrieve unread notification count." });
  }
};

// ── API: Mark notification as read ───────────────────────────
exports.markRead = async (req, res) => {
  try {
    const { notification_id, device_id } = req.body;
    if (!notification_id || !device_id) {
      return res.status(400).json({ error: "Missing notification_id or device_id" });
    }
    await notificationService.markRead(notification_id, device_id);
    res.json({ success: true });
  } catch (error) {
    console.error(`[Req ${req.id || ""}] Failed to mark read:`, error);
    res.status(500).json({ error: "Failed to update notification." });
  }
};

// ── API: Mark all as read ────────────────────────────────────
exports.markAllRead = async (req, res) => {
  try {
    const { device_id } = req.body;
    if (!device_id) return res.status(400).json({ error: "Missing device_id" });

    const sub = await PushSubscription.findOne({ where: { device_id } });
    const singerId = req.session?.singer?.id || (sub ? sub.singer_id : null);

    await notificationService.markAllRead(device_id, singerId);
    res.json({ success: true });
  } catch (error) {
    console.error(`[Req ${req.id || ""}] Failed to mark all read:`, error);
    res.status(500).json({ error: "Failed to update notifications." });
  }
};

// ── API: Check singer PIN status ────────────────────────────
exports.getSingerPinStatus = async (req, res) => {
  try {
    const { singer_id } = req.query;
    if (!singer_id) {
      return res.status(400).json({ error: "Missing singer_id" });
    }

    const singer = await Singer.scope("withSecrets").findByPk(singer_id);
    if (!singer) {
      return res.status(404).json({ error: "Singer not found" });
    }

    res.json({
      hasPin: Boolean(singer.pin),
      singer_id: singer.id,
      singer_name: singer.name
    });
  } catch (error) {
    console.error(`[Req ${req.id || ""}] Failed to get singer PIN status:`, error);
    res.status(500).json({ error: "Failed to check PIN status." });
  }
};

// ── API: Subscribe to push notifications ─────────────────────
// Requires an active singer session for initial registration, or an existing
// device subscription when upgrading/refreshing Web Push keys.
exports.subscribe = async (req, res) => {
  try {
    const { device_id, subscription } = req.body;

    if (!device_id) {
      return res.status(400).json({ error: "Missing required device_id" });
    }

    const { Sequelize } = require("sequelize");
    const incomingEndpoint =
      subscription && typeof subscription.endpoint === "string" ? subscription.endpoint.trim() : "";
    const incomingP256dh =
      subscription && subscription.keys && typeof subscription.keys.p256dh === "string"
        ? subscription.keys.p256dh
        : "";
    const incomingAuth =
      subscription && subscription.keys && typeof subscription.keys.auth === "string"
        ? subscription.keys.auth
        : "";
    const hasValidPushKeys = Boolean(
      incomingEndpoint && !incomingEndpoint.startsWith("in_app_") && incomingP256dh && incomingAuth
    );

    const lookupOr = [{ device_id }];
    if (hasValidPushKeys) {
      lookupOr.unshift({ endpoint: incomingEndpoint });
    }

    const existing = await PushSubscription.findOne({
      where: {
        [Sequelize.Op.or]: lookupOr
      }
    });

    let singer_id = req.session?.singer?.id || null;
    if (!singer_id) {
      if (existing && existing.device_id === device_id && hasValidPushKeys) {
        singer_id = existing.singer_id;
      } else {
        return res.status(401).json({
          error:
            "Active singer session required to register for notifications. Please sign in via Singer Hub."
        });
      }
    }

    const singer = await Singer.findByPk(singer_id);
    if (!singer) {
      return res.status(404).json({ error: "Singer not found" });
    }

    const preserveExistingNativePush =
      !hasValidPushKeys && existing && notificationService.isNativePushSubscription(existing);

    const endpoint = preserveExistingNativePush
      ? existing.endpoint
      : hasValidPushKeys
        ? incomingEndpoint
        : `in_app_${device_id}`;
    const p256dh = preserveExistingNativePush
      ? existing.p256dh
      : hasValidPushKeys
        ? incomingP256dh
        : "";
    const auth = preserveExistingNativePush
      ? existing.auth
      : hasValidPushKeys
        ? incomingAuth
        : "";

    if (existing) {
      await existing.update({
        singer_id,
        device_id,
        endpoint,
        p256dh,
        auth,
        enabled: true
      });
      return res.json({
        success: true,
        updated: true,
        singer_name: singer.name,
        hasNativePush: notificationService.isNativePushSubscription({ endpoint, p256dh, auth })
      });
    }

    await PushSubscription.create({
      singer_id,
      device_id,
      endpoint,
      p256dh,
      auth,
      enabled: true
    });

    res.json({
      success: true,
      created: true,
      singer_name: singer.name,
      hasNativePush: notificationService.isNativePushSubscription({ endpoint, p256dh, auth })
    });
  } catch (error) {
    console.error(`[Req ${req.id || ""}] Subscribe error:`, error);
    res.status(500).json({ error: "Failed to register notification subscription." });
  }
};

// ── API: Unsubscribe from push notifications ─────────────────
exports.unsubscribe = async (req, res) => {
  try {
    const { device_id } = req.body;
    if (!device_id) return res.status(400).json({ error: "Missing device_id" });

    await PushSubscription.destroy({ where: { device_id } });
    res.json({ success: true });
  } catch (error) {
    console.error(`[Req ${req.id || ""}] Unsubscribe error:`, error);
    res.status(500).json({ error: "Failed to unsubscribe." });
  }
};

// ── API: Get subscription status ─────────────────────────────
exports.subscriptionStatus = async (req, res) => {
  try {
    const deviceId = req.query.device_id;
    const vapidConfigured = notificationService.isVapidConfigured();
    const hasSessionSinger = Boolean(req.session?.singer?.id);
    if (!deviceId) {
      return res.json({
        subscribed: false,
        hasNativePush: false,
        vapidConfigured,
        hasSessionSinger
      });
    }

    const sub = await PushSubscription.findOne({ where: { device_id: deviceId } });
    if (!sub) {
      return res.json({
        subscribed: false,
        hasNativePush: false,
        vapidConfigured,
        hasSessionSinger
      });
    }

    const singer = await Singer.findByPk(sub.singer_id);
    res.json({
      subscribed: true,
      enabled: sub.enabled,
      hasNativePush: notificationService.isNativePushSubscription(sub),
      vapidConfigured,
      hasSessionSinger,
      singer_id: sub.singer_id,
      singer_name: singer ? singer.name : "Unknown"
    });
  } catch (error) {
    console.error(`[Req ${req.id || ""}] Subscription status error:`, error);
    res.status(500).json({ error: "Failed to retrieve subscription status." });
  }
};

// ── API: Get VAPID public key ────────────────────────────────
exports.getVapidKey = (req, res) => {
  res.json({ publicKey: notificationService.VAPID_PUBLIC_KEY });
};

// ── API: Send a native push test strictly to calling device ──
exports.sendTestToDevice = async (req, res) => {
  try {
    const deviceId = req.body?.device_id;
    if (!deviceId) {
      return res.status(400).json({ success: false, error: "Missing required device_id." });
    }

    const sub = await PushSubscription.findOne({ where: { device_id: deviceId } });
    const hasAuth = Boolean(req.session?.singer?.id || req.session?.admin);
    if (!hasAuth && (!sub || !notificationService.isNativePushSubscription(sub))) {
      return res.status(401).json({
        success: false,
        error: "Please enable notifications on this device first."
      });
    }

    const result = await notificationService.sendPushToDevice(deviceId, {
      id: Date.now(),
      type: "test",
      title: "Bhajan Planner",
      body: "Native notification bar alerts are active on this device!",
      link: "/notification-settings",
      event_key: `device_test:${Date.now()}`
    });

    if (result.status === "sent") {
      return res.json({
        success: true,
        status: result.status,
        vapidConfigured: result.vapidConfigured
      });
    }

    return res.status(result.status === "vapid_unconfigured" ? 503 : 400).json({
      success: false,
      status: result.status,
      vapidConfigured: result.vapidConfigured,
      error: result.error || "Could not deliver native push notification to this device."
    });
  } catch (error) {
    console.error(`[Req ${req.id || ""}] sendTestToDevice error:`, error);
    res.status(500).json({ success: false, error: "Failed to send device test notification." });
  }
};

// ── Admin: Notification overview ─────────────────────────────
exports.adminNotifications = async (req, res) => {
  try {
    const notifications = await notificationService.getAllNotifications(100);
    const subscriptions = await PushSubscription.findAll({
      order: [["created_at", "DESC"]]
    });

    const nativePushCount = subscriptions.filter((s) =>
      notificationService.isNativePushSubscription(s)
    ).length;
    const inAppOnlyCount = subscriptions.length - nativePushCount;

    // Get all singers for dropdown and for singerMap
    const allSingers = await Singer.findAll({
      attributes: ["id", "name"],
      order: [["name", "ASC"]]
    });

    const singerMap = {};
    allSingers.forEach((s) => {
      singerMap[s.id] = s.name;
    });

    res.render("admin-notifications", {
      notifications,
      subscriptions,
      singerMap,
      allSingers,
      vapidConfigured: notificationService.isVapidConfigured(),
      nativePushCount,
      inAppOnlyCount,
      page: "notifications",
      pageTitle: "Notifications"
    });
  } catch (error) {
    console.error(`[Req ${req.id || ""}] Admin notifications error:`, error);
    res.status(500).send("<h1>Error</h1><p>Failed to load admin notifications.</p>");
  }
};

// ── Admin: Send custom notification ──────────────────────────
exports.sendCustomNotification = async (req, res) => {
  try {
    const { title, body, link, target_type, singer_id } = req.body;

    if (!title || !title.trim() || !body || !body.trim()) {
      return res.status(400).json({ error: "Title and message are required." });
    }

    const eventKey = `custom:${Date.now()}`;
    const cleanTitle = title.trim();
    const cleanBody = body.trim();
    const cleanLink = link && link.trim() ? link.trim() : "/";

    let result;
    if (target_type === "singer" && singer_id) {
      const singerIdNum = parseInt(singer_id, 10);
      const singer = await Singer.findByPk(singerIdNum);
      if (!singer) {
        return res.status(404).json({ error: "Selected singer not found." });
      }

      result = await notificationService.createPersonalized({
        type: "custom",
        title: cleanTitle,
        body: cleanBody,
        link: cleanLink,
        eventKey,
        singerId: singerIdNum
      });
    } else {
      result = await notificationService.createAndBroadcast({
        type: "custom",
        title: cleanTitle,
        body: cleanBody,
        link: cleanLink,
        eventKey
      });
    }

    const ps = result.pushSummary || {};
    let msg = "Custom notification saved in-app!";
    if (!notificationService.isVapidConfigured()) {
      msg = "Notification saved in-app, but Web Push VAPID keys are not configured on the server.";
    } else if (ps.sent > 0) {
      msg = `Notification sent! Delivered native bar push to ${ps.sent} device(s)${ps.inAppOnly ? ` (${ps.inAppOnly} in-app only)` : ""}.`;
    } else {
      msg = `Notification saved in-app, but 0 native Web Push devices are registered yet${ps.inAppOnly ? ` (${ps.inAppOnly} in-app only)` : ""}.`;
    }

    res.json({
      success: true,
      created: result.created,
      pushSummary: ps,
      message: msg
    });
  } catch (error) {
    console.error(`[Req ${req.id || ""}] sendCustomNotification error:`, error);
    res.status(500).json({ error: "Failed to send notification." });
  }
};

// ── Admin: Send test notification ────────────────────────────
exports.sendTestNotification = async (req, res) => {
  try {
    const eventKey = `test:${Date.now()}`;
    const result = await notificationService.createAndBroadcast({
      type: "test",
      title: "🔔 Test Notification",
      body: "This is a test notification from the Bhajan Planner admin panel.",
      link: "/",
      eventKey
    });
    const ps = result.pushSummary || {};
    let message = "Test notification sent!";
    if (!notificationService.isVapidConfigured()) {
      message = "Test saved in-app, but Web Push VAPID keys are not configured on the server.";
    } else if (ps.sent > 0) {
      message = `Test notification sent! Delivered native push to ${ps.sent} device(s).`;
    } else {
      message = `Test saved in-app, but 0 native Web Push devices are subscribed yet${ps.inAppOnly ? ` (${ps.inAppOnly} in-app only)` : ""}.`;
    }
    res.json({ success: true, created: result.created, pushSummary: ps, message });
  } catch (error) {
    console.error(`[Req ${req.id || ""}] sendTestNotification error:`, error);
    res.status(500).json({ error: "Failed to send test notification." });
  }
};

// ── Admin: Delete notification ───────────────────────────────
exports.deleteNotification = async (req, res) => {
  try {
    await notificationService.deleteNotification(req.params.id);
    res.json({ success: true });
  } catch (error) {
    console.error(`[Req ${req.id || ""}] deleteNotification error:`, error);
    res.status(500).json({ error: "Failed to delete notification." });
  }
};
