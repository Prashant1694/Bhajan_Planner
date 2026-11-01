const { Sequelize } = require("sequelize");

const BhajanSubmission = require("../models/BhajanSubmission");
const SessionAudio = require("../models/SessionAudio");
const SessionAudioTimestamp = require("../models/SessionAudioTimestamp");
const { getLocalDateStr, deityOrderKey, SPEED_ORDER } = require("../services/helpers");
const { getMasterCatalog } = require("../services/catalogCache");
const { cleanAndStemBhajanTitle } = require("../services/fuzzyMatcher");

let analyticsCache = null;
let analyticsCacheAt = 0;
const ANALYTICS_TTL_MS = 2 * 60 * 1000;

exports.showDatabase = async (req, res) => {
  try {
    const todayStr = getLocalDateStr();

    const [rawSubmissions, catalog, audioResult] = await Promise.all([
      BhajanSubmission.findAll({
        where: {
          session_date: { [Sequelize.Op.lte]: todayStr }
        },
        order: [
          ["session_date", "DESC"],
          ["list_order", "ASC"],
          ["created_at", "ASC"]
        ],
        raw: true
      }),
      getMasterCatalog(),
      SessionAudio.findAll({
        where: { is_published: true },
        include: [{ model: SessionAudioTimestamp, as: "timestamps" }]
      }).catch((audioErr) => {
        console.warn("Could not load archive session audio records:", audioErr.message);
        return [];
      })
    ]);

    const exactMap = catalog.byExactLowerTitle;
    const stemmedMap = new Map();
    catalog.lightRows.forEach((mb) => {
      const stemmed = cleanAndStemBhajanTitle(mb.title);
      if (stemmed && !stemmedMap.has(stemmed)) stemmedMap.set(stemmed, mb);
    });

    const findMaster = (title) => {
      if (!title) return null;
      const lower = String(title).trim().toLowerCase();
      if (exactMap.has(lower)) return exactMap.get(lower);
      const stemmed = cleanAndStemBhajanTitle(title);
      if (stemmed && stemmedMap.has(stemmed)) return stemmedMap.get(stemmed);
      return null;
    };

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

    const audioByDate = new Map();
    (audioResult || []).forEach((rec) => {
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
      page: "database",
      pageTitle: "Bhajan Archives"
    });
  } catch (error) {
    console.error(`[Req ${req.id || ""}] showDatabase error:`, error);
    res.status(500).send("<h1>Error</h1><p>Failed to load bhajan archives.</p>");
  }
};

exports.showAnalytics = async (req, res) => {
  try {
    const now = Date.now();
    if (!analyticsCache || now - analyticsCacheAt > ANALYTICS_TTL_MS || req.query.refresh === "1") {
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

      const [
        topBhajans,
        totalSung,
        uniqueSongsCount,
        totalSessions,
        uniqueSingers,
        rawDeities,
        rawSpeeds,
        topSingers
      ] = await Promise.all([
        BhajanSubmission.findAll({
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
        }),
        BhajanSubmission.count(),
        BhajanSubmission.count({ distinct: true, col: "title" }),
        BhajanSubmission.count({ distinct: true, col: "session_date" }),
        BhajanSubmission.count({ distinct: true, col: "singer_name" }),
        BhajanSubmission.findAll({
          attributes: ["deity", [Sequelize.fn("COUNT", Sequelize.col("id")), "count"]],
          group: ["deity"],
          order: [[Sequelize.fn("COUNT", Sequelize.col("id")), "DESC"]],
          raw: true
        }),
        BhajanSubmission.findAll({
          attributes: ["speed", [Sequelize.fn("COUNT", Sequelize.col("id")), "count"]],
          group: ["speed"],
          raw: true
        }),
        BhajanSubmission.findAll({
          attributes: [
            "singer_name",
            [Sequelize.fn("COUNT", Sequelize.col("id")), "count"],
            [Sequelize.fn("MAX", Sequelize.col("session_date")), "last_sung"]
          ],
          group: ["singer_name"],
          order: [[Sequelize.fn("COUNT", Sequelize.col("id")), "DESC"]],
          limit: 10,
          raw: true
        })
      ]);

      const deityStats = rawDeities.map((d) => {
        const name = d.deity || "Unknown";
        const count = parseInt(d.count, 10) || 0;
        const pct = totalSung > 0 ? Math.round((count / totalSung) * 100) : 0;
        const icon = DEITY_ICONS[name.toLowerCase().trim()] || "🕉️";
        return { name, count, pct, icon };
      });

      const tempoStats = { slow: 0, medium: 0, fast: 0 };
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

      analyticsCache = {
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
        topSingers
      };
      analyticsCacheAt = now;
    }

    res.render("analytics", {
      ...analyticsCache,
      pageTitle: "Mandir Bhajan Analytics",
      isAdminPage: true,
      pageCSS: "admin.css",
      page: "analytics"
    });
  } catch (error) {
    console.error(`[Req ${req.id || ""}] showAnalytics error:`, error);
    res.status(500).send("<h1>Analytics Error</h1><p>Failed to load analytics data.</p>");
  }
};
