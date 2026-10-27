const { Sequelize } = require("sequelize");

const BhajanSubmission = require("../models/BhajanSubmission");
const MasterBhajan = require("../models/MasterBhajan");
const SessionAudio = require("../models/SessionAudio");
const SessionAudioTimestamp = require("../models/SessionAudioTimestamp");
const { getLocalDateStr, deityOrderKey, SPEED_ORDER } = require("../services/helpers");

exports.showDatabase = async (req, res) => {
  try {
    // Today as YYYY-MM-DD string using local timezone
    const todayStr = getLocalDateStr();

    // Fetch sessions whose date <= todayStr (shows Thursday's session immediately at 12:00 AM Thursday)
    const rawSubmissions = await BhajanSubmission.findAll({
      where: {
        session_date: { [Sequelize.Op.lte]: todayStr }
      },
      order: [
        ["session_date", "DESC"],
        ["list_order", "ASC"],
        ["created_at", "ASC"]
      ],
      raw: true
    });

    // Fetch active master bhajans to link details and music sheets in History
    const masterBhajans = await MasterBhajan.findAll({
      where: { is_active: true },
      attributes: ["id", "title", "sheet_filename"]
    });

    const { cleanAndStemBhajanTitle } = require("../services/fuzzyMatcher");
    const exactMap = new Map();
    const stemmedMap = new Map();

    masterBhajans.forEach((mb) => {
      const lower = String(mb.title || "")
        .trim()
        .toLowerCase();
      if (!exactMap.has(lower)) exactMap.set(lower, mb);
      const stemmed = cleanAndStemBhajanTitle(mb.title);
      if (!stemmedMap.has(stemmed)) stemmedMap.set(stemmed, mb);
    });

    const findMaster = (title) => {
      if (!title) return null;
      const lower = String(title).trim().toLowerCase();
      if (exactMap.has(lower)) return exactMap.get(lower);
      const stemmed = cleanAndStemBhajanTitle(title);
      if (stemmedMap.has(stemmed)) return stemmedMap.get(stemmed);
      return null;
    };

    // Group submissions by session_date
    const { deityOrderKey, SPEED_ORDER } = require("../services/helpers");
    const sessionsMap = new Map();

    rawSubmissions.forEach((s) => {
      const match = findMaster(s.title);
      s.master_id = match ? match.id : null;
      s.sheet_filename = match ? match.sheet_filename || null : null;

      if (!sessionsMap.has(s.session_date)) {
        sessionsMap.set(s.session_date, []);
      }
      sessionsMap.get(s.session_date).push(s);
    });

    // Fetch published session recordings and timestamps for archive sessions
    const audioByDate = new Map();
    try {
      const audioRecords = await SessionAudio.findAll({
        where: { is_published: true },
        include: [{ model: SessionAudioTimestamp, as: "timestamps" }]
      });
      audioRecords.forEach((rec) => {
        audioByDate.set(rec.session_date, {
          id: rec.id,
          title: rec.title,
          audio_url: rec.audio_url,
          session_date: rec.session_date,
          timestamps: (rec.timestamps || []).map((t) => ({
            id: t.id,
            submission_id: t.submission_id,
            bhajan_title: t.bhajan_title,
            singer_name: t.singer_name,
            deity: t.deity,
            start_seconds: t.start_seconds
          }))
        });
      });
    } catch (audioErr) {
      console.warn("Could not load archive session audio records:", audioErr.message);
    }

    // Build sessions array with heading and sorted bhajans
    const DAY_NAMES = [
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday"
    ];
    const sessions = [];

    for (const [dateStr, bhajans] of sessionsMap) {
      // Sort within session: manual order first, then deity/speed/singer fallback
      bhajans.sort((a, b) => {
        if (a.list_order > 0 || b.list_order > 0) {
          if (a.list_order === 0) return 1;
          if (b.list_order === 0) return -1;
          return a.list_order - b.list_order;
        }
        const deityCompare = deityOrderKey(a.deity) - deityOrderKey(b.deity);
        if (deityCompare !== 0) return deityCompare;
        const speedCompare =
          (SPEED_ORDER[(a.speed || "").toLowerCase()] || 1) -
          (SPEED_ORDER[(b.speed || "").toLowerCase()] || 1);
        if (speedCompare !== 0) return speedCompare;
        return (a.singer_name || "")
          .toLowerCase()
          .localeCompare((b.singer_name || "").toLowerCase());
      });

      // Heading: DD-MM-YYYY - DayName
      const [y, m, d] = dateStr.split("-").map(Number);
      const dateObj = new Date(y, m - 1, d);
      const dayName = DAY_NAMES[dateObj.getDay()];
      const heading = `${String(d).padStart(2, "0")}-${String(m).padStart(2, "0")}-${y} - ${dayName}`;

      const sessionAudio = audioByDate.get(dateStr) || null;
      if (sessionAudio && sessionAudio.timestamps) {
        const tsBySubId = new Map();
        const tsByTitle = new Map();
        sessionAudio.timestamps.forEach((t) => {
          if (t.submission_id) tsBySubId.set(String(t.submission_id), t);
          if (t.bhajan_title) tsByTitle.set(t.bhajan_title.trim().toLowerCase(), t);
        });

        bhajans.forEach((b) => {
          const matchedTs =
            (b.id && tsBySubId.get(String(b.id))) ||
            tsByTitle.get((b.title || "").trim().toLowerCase());
          if (matchedTs) {
            b.audioTimestamp = matchedTs;
          }
        });
      }

      sessions.push({ date: dateStr, heading, bhajans, sessionAudio });
    }

    const initialSearch = (req.query.search || "").trim();
    const initialDate = (req.query.date || "").trim();
    const totalBhajans = rawSubmissions.length;

    res.render("database", {
      sessions,
      initialSearch,
      initialDate,
      totalBhajans,
      pageTitle: "Bhajan Archives"
    });
  } catch (error) {
    res.status(500).send(`<h1>Error</h1><p>${error.message}</p>`);
  }
};

exports.showAnalytics = async (req, res) => {
  try {
    const DEITY_ICONS = {
      ganesha: "🐘",
      guru: "🙏",
      mata: "🌸",
      devi: "🌸",
      sarvadharma: "🕉️",
      sai: "🪔",
      shiva: "🔱",
      krishna: "🦚",
      rama: "🏹",
      narayana: "☀️",
      vitthala: "🪘",
      vithala: "🪘",
      hanuman: "🐵",
      anjaneya: "🐵"
    };

    // 1. Top 15 Most Sung Bhajans
    const topBhajans = await BhajanSubmission.findAll({
      attributes: [
        "title",
        "deity",
        [Sequelize.fn("COUNT", Sequelize.col("title")), "count"],
        [Sequelize.fn("MAX", Sequelize.col("session_date")), "last_sung"]
      ],
      group: ["title", "deity"],
      order: [[Sequelize.fn("COUNT", Sequelize.col("title")), "DESC"]],
      limit: 15,
      raw: true
    });

    // 2. High-level KPIs
    const totalSung = await BhajanSubmission.count();
    const uniqueSongsCount = await BhajanSubmission.count({
      distinct: true,
      col: "title"
    });
    const totalSessions = await BhajanSubmission.count({
      distinct: true,
      col: "session_date"
    });
    const uniqueSingers = await BhajanSubmission.count({
      distinct: true,
      col: "singer_name"
    });

    // 3. Deity Breakdown
    const rawDeities = await BhajanSubmission.findAll({
      attributes: ["deity", [Sequelize.fn("COUNT", Sequelize.col("id")), "count"]],
      group: ["deity"],
      order: [[Sequelize.fn("COUNT", Sequelize.col("id")), "DESC"]],
      raw: true
    });

    const deityStats = rawDeities.map((d) => {
      const name = d.deity || "Unknown";
      const count = parseInt(d.count, 10) || 0;
      const pct = totalSung > 0 ? Math.round((count / totalSung) * 100) : 0;
      const icon = DEITY_ICONS[name.toLowerCase().trim()] || "🕉️";
      return { name, count, pct, icon };
    });

    // 4. Tempo Breakdown
    const rawSpeeds = await BhajanSubmission.findAll({
      attributes: ["speed", [Sequelize.fn("COUNT", Sequelize.col("id")), "count"]],
      group: ["speed"],
      raw: true
    });

    const tempoStats = {
      slow: 0,
      medium: 0,
      fast: 0
    };
    rawSpeeds.forEach((s) => {
      const sp = (s.speed || "").toLowerCase().trim();
      const count = parseInt(s.count, 10) || 0;
      if (sp === "slow") tempoStats.slow += count;
      else if (sp === "fast") tempoStats.fast += count;
      else tempoStats.medium += count;
    });

    const slowPct = totalSung > 0 ? Math.round((tempoStats.slow / totalSung) * 100) : 0;
    const medPct = totalSung > 0 ? Math.round((tempoStats.medium / totalSung) * 100) : 0;
    const fastPct = totalSung > 0 ? Math.round((tempoStats.fast / totalSung) * 100) : 0;

    // 5. Top 10 Most Active Singers
    const topSingers = await BhajanSubmission.findAll({
      attributes: [
        "singer_name",
        [Sequelize.fn("COUNT", Sequelize.col("id")), "count"],
        [Sequelize.fn("MAX", Sequelize.col("session_date")), "last_sung"]
      ],
      group: ["singer_name"],
      order: [[Sequelize.fn("COUNT", Sequelize.col("id")), "DESC"]],
      limit: 10,
      raw: true
    });

    res.render("analytics", {
      topBhajans,
      kpis: {
        totalSung,
        uniqueSongsCount,
        totalSessions,
        uniqueSingers,
        avgPerSession: totalSessions > 0 ? (totalSung / totalSessions).toFixed(1) : "0"
      },
      deityStats,
      tempoStats: {
        ...tempoStats,
        slowPct,
        medPct,
        fastPct
      },
      topSingers,
      pageTitle: "Mandir Bhajan Analytics",
      isAdminPage: true,
      pageCSS: "admin.css",
      page: "analytics"
    });
  } catch (error) {
    res.status(500).send(`<h1>Analytics Error</h1><p>${error.message}</p>`);
  }
};
