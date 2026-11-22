// ============================================================
// Session Scheduler — Bhajan Planner
// Periodic check that generates deadline reminders and
// schedule-published notifications using the existing
// session lifecycle (getThursdaySubmissionStatus, SessionMeta,
// SessionPermission). NOT a competing scheduler.
// ============================================================

const { Sequelize } = require("sequelize");
const BhajanSubmission = require("../models/BhajanSubmission");
const SessionPermission = require("../models/SessionPermission");
const SessionMeta = require("../models/SessionMeta");
const { getThursdaySubmissionStatus, getLocalDateStr } = require("./helpers");
const notificationService = require("./notificationService");

const CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const REMINDER_HOURS_BEFORE = 6; // Send deadline reminder 6 hours before midnight lock

let schedulerTimer = null;

// ── Start the scheduler ──────────────────────────────────────
function startSessionScheduler() {
  if (process.env.NODE_ENV === "test") return;
  console.log("[Scheduler] Session lifecycle scheduler started (interval: 15 min)");
  // Run immediately on startup to catch anything missed during downtime
  runSchedulerCheck().catch((err) => console.error("[Scheduler] Initial check failed:", err));
  // Then run periodically
  schedulerTimer = setInterval(() => {
    runSchedulerCheck().catch((err) => console.error("[Scheduler] Periodic check failed:", err));
  }, CHECK_INTERVAL_MS);
  if (schedulerTimer && typeof schedulerTimer.unref === "function") {
    schedulerTimer.unref();
  }
}

// ── Stop the scheduler ───────────────────────────────────────
function stopSessionScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

// ── Main scheduler check ─────────────────────────────────────
async function runSchedulerCheck() {
  try {
    await checkDeadlineReminders();
    await checkSchedulePublished();
  } catch (error) {
    console.error("[Scheduler] Check error:", error);
  }
}

// ── Check if deadline reminders need to be sent ──────────────
async function checkDeadlineReminders() {
  const now = new Date();
  const todayStr = getLocalDateStr(now);
  const status = getThursdaySubmissionStatus(now);

  // Collect all upcoming session dates that need reminders
  const upcomingSessions = [];

  // Regular Thursday session
  if (status.openThursday) {
    upcomingSessions.push({
      date: status.openThursday,
      label: "Thursday"
    });
  }

  // Special/Festival sessions
  const specialDays = await SessionPermission.findAll({
    where: { date: { [Sequelize.Op.gt]: todayStr } },
    order: [["date", "ASC"]]
  });
  specialDays.forEach((p) => {
    upcomingSessions.push({
      date: p.date,
      label: p.description || (p.type === "festival" ? "Festival" : "Special")
    });
  });

  for (const session of upcomingSessions) {
    // Calculate hours until session date (midnight lock)
    const sessionMidnight = new Date(session.date + "T00:00:00+05:30");
    const hoursUntil = (sessionMidnight - now) / (1000 * 60 * 60);

    // Send reminder when within REMINDER_HOURS_BEFORE window (but not after the lock)
    if (hoursUntil > 0 && hoursUntil <= REMINDER_HOURS_BEFORE) {
      const eventKey = `submission_deadline_reminder:${session.date}`;

      // Format a nice date string
      const dateObj = new Date(session.date + "T12:00:00+05:30");
      const dayName = dateObj.toLocaleDateString("en-US", { weekday: "long" });
      const dateFormatted = dateObj.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "long"
      });

      const result = await notificationService.createAndBroadcast({
        type: "deadline_reminder",
        title: "🔔 Bhajan Submission Reminder",
        body: `The bhajan submission window for ${dayName}'s session (${dateFormatted}) will close soon. Please submit your bhajan before the deadline.`,
        link: `/session-link?session_date=${session.date}`,
        eventKey
      });

      if (result.created) {
        console.log(`[Scheduler] Created deadline reminder for ${session.date}`);
      }
    }
  }
}

// ── Check if schedule-published notifications need to be sent ─
async function checkSchedulePublished() {
  const now = new Date();
  const todayStr = getLocalDateStr(now);

  // Find sessions that are now past (locked by date) and have submissions
  // Look back up to 7 days to catch anything missed during downtime
  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const sevenDaysAgoStr = getLocalDateStr(sevenDaysAgo);

  // Find session dates that have submissions and are past
  const sessions = await BhajanSubmission.findAll({
    attributes: [[Sequelize.fn("DISTINCT", Sequelize.col("session_date")), "session_date"]],
    where: {
      session_date: {
        [Sequelize.Op.between]: [sevenDaysAgoStr, todayStr]
      }
    },
    raw: true
  });

  for (const session of sessions) {
    const sessionDate = session.session_date;

    // Only trigger if session date has passed (auto-locked)
    if (todayStr < sessionDate) continue;

    const eventKey = `schedule_published:${sessionDate}`;

    // Format date
    const dateObj = new Date(sessionDate + "T12:00:00+05:30");
    const dayName = dateObj.toLocaleDateString("en-US", { weekday: "long" });
    const dateFormatted = dateObj.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long"
    });

    const result = await notificationService.createAndBroadcast({
      type: "schedule_published",
      title: "📖 Bhajan Schedule Published",
      body: `The bhajan schedule for ${dayName}, ${dateFormatted} is now available. Tap to view the sequence.`,
      link: `/database`,
      eventKey
    });

    if (result.created) {
      console.log(`[Scheduler] Created schedule-published notification for ${sessionDate}`);
    }
  }
}

// ── Trigger schedule-published for a specific date (manual lock) ──
async function triggerSchedulePublished(sessionDate) {
  const eventKey = `schedule_published:${sessionDate}`;

  const dateObj = new Date(sessionDate + "T12:00:00+05:30");
  const dayName = dateObj.toLocaleDateString("en-US", { weekday: "long" });
  const dateFormatted = dateObj.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long"
  });

  const result = await notificationService.createAndBroadcast({
    type: "schedule_published",
    title: "📖 Bhajan Schedule Published",
    body: `The bhajan schedule for ${dayName}, ${dateFormatted} is now available. Tap to view the sequence.`,
    link: `/database`,
    eventKey
  });

  if (result.created) {
    console.log(`[Scheduler] Manual lock triggered schedule-published for ${sessionDate}`);
  }

  return result;
}

module.exports = {
  startSessionScheduler,
  stopSessionScheduler,
  runSchedulerCheck,
  triggerSchedulePublished
};
