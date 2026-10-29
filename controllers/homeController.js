const { getLatestBulletins, CATEGORY_INFO } = require("./bulletinController");
const BhajanSubmission = require("../models/BhajanSubmission");
const SessionPermission = require("../models/SessionPermission");
const {
  getThursdaySubmissionStatus,
  getLocalDateStr,
  isSessionActiveOrUpcoming
} = require("../services/helpers");
const { Sequelize } = require("sequelize");

exports.home = async (req, res) => {
  const isShellFragment =
    req.headers["x-app-shell"] === "1" || req.query._fragment === "1";
  const isIframe =
    req.query._embed === "1" ||
    req.query.embed === "1" ||
    req.headers["sec-fetch-dest"] === "iframe" ||
    (Boolean(req.headers["referer"]) && req.headers["referer"].includes("_embed=1"));

  const todayStr = getLocalDateStr();
  const thuStatus = getThursdaySubmissionStatus();

  const [bulletinsResult, specialSessionsResult] = await Promise.allSettled([
    getLatestBulletins(5),
    SessionPermission.findAll({
      where: { date: { [Sequelize.Op.gte]: todayStr } },
      order: [["date", "ASC"]],
      limit: 3,
      raw: true
    })
  ]);

  const bulletins = bulletinsResult.status === "fulfilled" ? bulletinsResult.value : [];
  if (bulletinsResult.status === "rejected") {
    console.error("Failed to load bulletins for home page:", bulletinsResult.reason?.message);
  }

  let upcomingSessions = [];
  try {
    const specialSessions =
      specialSessionsResult.status === "fulfilled" ? specialSessionsResult.value : [];
    const sessionDatesMap = new Map();

    // 1. Add active / upcoming special sessions
    for (const sp of specialSessions) {
      if (isSessionActiveOrUpcoming(sp.date, sp.description)) {
        const isToday = sp.date === todayStr;
        sessionDatesMap.set(sp.date, {
          date: sp.date,
          type: sp.type || "special",
          label: sp.description || (sp.type === "festival" ? "Festival Bhajan" : "Special Session"),
          tag: sp.type === "festival" ? "Festival" : "Special",
          isOpen: true,
          opensAt8pmToday: false,
          isToday,
          isLiveNow: isToday
        });
      }
    }

    // 2. Add Thursday session
    if (thuStatus.isThursdayLiveActive && !sessionDatesMap.has(thuStatus.todayStr)) {
      sessionDatesMap.set(thuStatus.todayStr, {
        date: thuStatus.todayStr,
        type: "regular",
        label: "Thursday Mandir Bhajan",
        tag: "Mandir Bhajan",
        isOpen: false,
        isClosedForSubmissions: true,
        opensAt8pmToday: false,
        isToday: true,
        isLiveNow: true
      });
    }

    // Add upcoming Thursday (the one open for submissions or opening at 8 PM)
    const upcomingThuDate = thuStatus.openThursday || thuStatus.nextThursdayDate;
    if (upcomingThuDate && !sessionDatesMap.has(upcomingThuDate)) {
      sessionDatesMap.set(upcomingThuDate, {
        date: upcomingThuDate,
        type: "regular",
        label: "Thursday Mandir Bhajan",
        tag: "Regular Session",
        isOpen: !thuStatus.opensAt8pmToday,
        opensAt8pmToday: thuStatus.opensAt8pmToday,
        isToday: false,
        isLiveNow: false
      });
    }

    // 3. Batch submission count query (1 GROUP BY query instead of N sequential counts)
    const sortedEntries = Array.from(sessionDatesMap.values()).sort((a, b) =>
      a.date.localeCompare(b.date)
    );

    const countByDate = new Map();
    if (sortedEntries.length > 0) {
      const dateKeys = sortedEntries.map((s) => s.date);
      const countRows = await BhajanSubmission.findAll({
        attributes: [
          "session_date",
          [Sequelize.fn("COUNT", Sequelize.col("id")), "cnt"]
        ],
        where: { session_date: { [Sequelize.Op.in]: dateKeys } },
        group: ["session_date"],
        raw: true
      });
      countRows.forEach((r) => {
        countByDate.set(r.session_date, parseInt(r.cnt, 10) || 0);
      });
    }

    for (const s of sortedEntries) {
      let formattedDate = s.date;
      try {
        const [y, m, d] = s.date.split("-").map(Number);
        const dObj = new Date(y, m - 1, d);
        formattedDate = dObj.toLocaleDateString("en-GB", {
          weekday: "short",
          day: "numeric",
          month: "short"
        });
      } catch (_) {}

      upcomingSessions.push({
        ...s,
        formattedDate,
        submissionCount: countByDate.get(s.date) || 0
      });
    }
  } catch (err) {
    console.error("Failed to compute upcoming sessions for dashboard:", err.message);
  }

  const upcomingSession = upcomingSessions[0] || null;

  res.render("dashboard", {
    showLoader: !isIframe && !isShellFragment,
    pageTitle: "Home — Bhajan Planner",
    page: "home",
    pageCSS: "dashboard-glass.css",
    bulletins,
    CATEGORY_INFO,
    upcomingSession,
    upcomingSessions
  });
};
