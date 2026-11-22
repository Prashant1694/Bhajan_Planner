const webpush = require("web-push");
const Notification = require("../models/Notification");
const NotificationRead = require("../models/NotificationRead");
const PushSubscription = require("../models/PushSubscription");
const { Sequelize } = require("sequelize");
const { getPwaMetadata } = require("./pwaConfig");

const VAPID_PUBLIC_KEY = (process.env.VAPID_PUBLIC_KEY || "").trim();
const VAPID_PRIVATE_KEY = (process.env.VAPID_PRIVATE_KEY || "").trim();
const RAW_VAPID_SUBJECT = (process.env.VAPID_SUBJECT || "mailto:admin@example.com").trim();
const VAPID_SUBJECT =
  RAW_VAPID_SUBJECT && !/^(mailto:|https?:\/\/)/i.test(RAW_VAPID_SUBJECT)
    ? `mailto:${RAW_VAPID_SUBJECT}`
    : RAW_VAPID_SUBJECT || "mailto:admin@example.com";
const UNREAD_WINDOW_DAYS = 60;

let vapidConfigured = false;
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    vapidConfigured = true;
  } catch (vapidErr) {
    console.error("[Push] Invalid VAPID configuration:", vapidErr.message);
  }
}

function isVapidConfigured() {
  return vapidConfigured;
}

function isNativePushSubscription(sub) {
  return Boolean(
    sub &&
      sub.endpoint &&
      !String(sub.endpoint).startsWith("in_app_") &&
      sub.p256dh &&
      sub.auth
  );
}

function buildPushPayload(notification) {
  const pwaIcon = getPwaMetadata().icon192Path;
  return JSON.stringify({
    title: notification.title,
    body: notification.body,
    url: notification.link || "/",
    icon: pwaIcon,
    badge: pwaIcon,
    tag: notification.event_key || `bp-notif-${notification.id || Date.now()}`,
    timestamp: Date.now(),
    type: notification.type || "general"
  });
}

async function createNotification({
  type,
  title,
  body,
  link,
  eventKey,
  targetSingerId = null,
  metadata = null
}) {
  try {
    const [notification, created] = await Notification.findOrCreate({
      where: { event_key: eventKey },
      defaults: {
        type,
        title,
        body,
        link: link || null,
        target_singer_id: targetSingerId,
        metadata: metadata ? JSON.stringify(metadata) : null
      }
    });
    return { notification, created };
  } catch (error) {
    if (error.name === "SequelizeUniqueConstraintError") {
      const existing = await Notification.findOne({ where: { event_key: eventKey } });
      return { notification: existing, created: false };
    }
    throw error;
  }
}

async function dispatchBatchedPush(subscriptions, payload, batchSize = 15) {
  const summary = {
    total: subscriptions.length,
    sent: 0,
    inAppOnly: 0,
    gone: 0,
    failed: 0,
    vapidConfigured
  };

  for (let i = 0; i < subscriptions.length; i += batchSize) {
    const batch = subscriptions.slice(i, i + batchSize);
    const batchRes = await Promise.allSettled(batch.map((sub) => sendPush(sub, payload)));
    for (const r of batchRes) {
      if (r.status === "fulfilled" && r.value) {
        if (r.value.status === "sent") summary.sent++;
        else if (r.value.status === "in_app_only") summary.inAppOnly++;
        else if (r.value.status === "gone") summary.gone++;
        else summary.failed++;
      } else {
        summary.failed++;
      }
    }
  }
  return summary;
}

async function sendPushToAll(notification) {
  if (!vapidConfigured) {
    return { total: 0, sent: 0, inAppOnly: 0, gone: 0, failed: 0, vapidConfigured: false };
  }

  const subscriptions = await PushSubscription.findAll({ where: { enabled: true } });
  if (subscriptions.length === 0) {
    return { total: 0, sent: 0, inAppOnly: 0, gone: 0, failed: 0, vapidConfigured: true };
  }

  const payload = buildPushPayload(notification);
  return dispatchBatchedPush(subscriptions, payload, 15);
}

async function sendPushToSinger(singerId, notification) {
  if (!vapidConfigured) {
    return { total: 0, sent: 0, inAppOnly: 0, gone: 0, failed: 0, vapidConfigured: false };
  }

  const subscriptions = await PushSubscription.findAll({
    where: { singer_id: singerId, enabled: true }
  });
  if (subscriptions.length === 0) {
    return { total: 0, sent: 0, inAppOnly: 0, gone: 0, failed: 0, vapidConfigured: true };
  }

  const payload = buildPushPayload(notification);
  return dispatchBatchedPush(subscriptions, payload, 15);
}

async function sendPush(sub, payload) {
  if (!isNativePushSubscription(sub)) {
    return { status: "in_app_only" };
  }
  try {
    await webpush.sendNotification(
      {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth }
      },
      payload,
      { TTL: 86400, urgency: "high" }
    );
    return { status: "sent" };
  } catch (error) {
    if (error.statusCode === 404 || error.statusCode === 410) {
      await sub.destroy();
      return { status: "gone", statusCode: error.statusCode };
    }
    const detail = error.body ? ` (${String(error.body).slice(0, 160)})` : "";
    console.error(
      `[Push] Failed to send to subscription ${sub.id} [HTTP ${error.statusCode || "ERR"}]: ${error.message}${detail}`
    );
    return {
      status: "failed",
      statusCode: error.statusCode || null,
      error: error.message
    };
  }
}

async function sendPushToDevice(deviceId, notification) {
  if (!vapidConfigured) {
    return { status: "vapid_unconfigured", vapidConfigured: false, error: "VAPID keys are not configured." };
  }
  if (!deviceId) {
    return { status: "missing_device", vapidConfigured: true, error: "Device ID is required." };
  }
  const sub = await PushSubscription.findOne({
    where: { device_id: deviceId, enabled: true }
  });
  if (!sub) {
    return { status: "not_subscribed", vapidConfigured: true, error: "No subscription found for this device." };
  }
  if (!isNativePushSubscription(sub)) {
    return {
      status: "in_app_only",
      vapidConfigured: true,
      error: "This device only has an in-app subscription without browser push keys."
    };
  }
  const payload = buildPushPayload(notification);
  const res = await sendPush(sub, payload);
  return { ...res, vapidConfigured: true };
}

async function getNotificationsForDevice(deviceId, singerId = null, limit = 30) {
  const whereClause = singerId
    ? {
        [Sequelize.Op.or]: [{ target_singer_id: null }, { target_singer_id: singerId }]
      }
    : { target_singer_id: null };

  const notifications = await Notification.findAll({
    where: whereClause,
    order: [["created_at", "DESC"]],
    limit,
    raw: true
  });

  if (notifications.length === 0) return [];

  const notificationIds = notifications.map((n) => n.id);
  const reads = await NotificationRead.findAll({
    where: {
      device_id: deviceId,
      notification_id: { [Sequelize.Op.in]: notificationIds }
    },
    attributes: ["notification_id"],
    raw: true
  });
  const readSet = new Set(reads.map((r) => r.notification_id));

  return notifications.map((n) => {
    let parsedMeta = null;
    if (n.metadata) {
      try {
        parsedMeta = JSON.parse(n.metadata);
      } catch (_) {}
    }
    return {
      id: n.id,
      type: n.type,
      title: n.title,
      body: n.body,
      link: n.link,
      isRead: readSet.has(n.id),
      createdAt: n.created_at,
      metadata: parsedMeta
    };
  });
}

async function getUnreadCount(deviceId, singerId = null) {
  const cutoff = new Date(Date.now() - UNREAD_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const targetCond = singerId
    ? { [Sequelize.Op.or]: [{ target_singer_id: null }, { target_singer_id: singerId }] }
    : { target_singer_id: null };

  const recentNotifications = await Notification.findAll({
    where: {
      ...targetCond,
      created_at: { [Sequelize.Op.gte]: cutoff }
    },
    attributes: ["id"],
    order: [["created_at", "DESC"]],
    limit: 100,
    raw: true
  });

  const notificationIds = recentNotifications.map((n) => n.id);
  if (notificationIds.length === 0) return 0;

  const readIds = await NotificationRead.count({
    where: {
      device_id: deviceId,
      notification_id: { [Sequelize.Op.in]: notificationIds }
    }
  });

  return Math.max(0, notificationIds.length - readIds);
}

async function markRead(notificationId, deviceId) {
  try {
    await NotificationRead.findOrCreate({
      where: { notification_id: notificationId, device_id: deviceId },
      defaults: { read_at: new Date() }
    });
    return true;
  } catch (error) {
    if (error.name === "SequelizeUniqueConstraintError") return true;
    throw error;
  }
}

async function markAllRead(deviceId, singerId = null) {
  const cutoff = new Date(Date.now() - UNREAD_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const targetCond = singerId
    ? { [Sequelize.Op.or]: [{ target_singer_id: null }, { target_singer_id: singerId }] }
    : { target_singer_id: null };

  const notifications = await Notification.findAll({
    where: {
      ...targetCond,
      created_at: { [Sequelize.Op.gte]: cutoff }
    },
    attributes: ["id"],
    limit: 200,
    raw: true
  });

  if (notifications.length === 0) return true;

  const bulkData = notifications.map((n) => ({
    notification_id: n.id,
    device_id: deviceId,
    read_at: new Date()
  }));

  await NotificationRead.bulkCreate(bulkData, { ignoreDuplicates: true });
  return true;
}

async function createAndBroadcast({ type, title, body, link, eventKey, metadata = null }) {
  const { notification, created } = await createNotification({
    type,
    title,
    body,
    link,
    eventKey,
    targetSingerId: null,
    metadata
  });
  let pushSummary = null;
  if (created) {
    pushSummary = await sendPushToAll(notification);
  }
  return { notification, created, pushSummary };
}

async function createPersonalized({
  type,
  title,
  body,
  link,
  eventKey,
  singerId,
  metadata = null
}) {
  const { notification, created } = await createNotification({
    type,
    title,
    body,
    link,
    eventKey,
    targetSingerId: singerId,
    metadata
  });
  let pushSummary = null;
  if (created) {
    pushSummary = await sendPushToSinger(singerId, notification);
  }
  return { notification, created, pushSummary };
}

async function getAllNotifications(limit = 100) {
  return Notification.findAll({
    order: [["created_at", "DESC"]],
    limit
  });
}

async function deleteNotification(id) {
  await NotificationRead.destroy({ where: { notification_id: id } });
  await Notification.destroy({ where: { id } });
}

module.exports = {
  createNotification,
  createAndBroadcast,
  createPersonalized,
  sendPushToAll,
  sendPushToSinger,
  sendPushToDevice,
  buildPushPayload,
  isVapidConfigured,
  isNativePushSubscription,
  getNotificationsForDevice,
  getUnreadCount,
  markRead,
  markAllRead,
  getAllNotifications,
  deleteNotification,
  VAPID_PUBLIC_KEY
};
