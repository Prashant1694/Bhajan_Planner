const { Sequelize } = require("sequelize");

const BhajanSubmission = require("../models/BhajanSubmission");
const SessionAudio = require("../models/SessionAudio");
const SessionAudioTimestamp = require("../models/SessionAudioTimestamp");
const { getLocalDateStr, deityOrderKey, SPEED_ORDER } = require("../services/helpers");
const { getMasterCatalog, normalizeTitleKey } = require("../services/catalogCache");

/** Allocate integer percentages summing strictly to 100 using largest remainder. */
function allocatePercentages(counts) {
  const total = counts.reduce((sum, n) => sum + n, 0);
  if (total <= 0) return counts.map(() => 0);

  const exact = counts.map((n) => (n / total) * 100);
  const floored = exact.map((v) => Math.floor(v));
  let remainder = 100 - floored.reduce((sum, v) => sum + v, 0);

  const ranked = exact
    .map((v, idx) => ({ idx, frac: v - floored[idx], count: counts[idx] }))
    .filter((item) => item.count > 0)
    .sort((a, b) => b.frac - a.frac || a.idx - b.idx);

  for (let i = 0; i < ranked.length && remainder > 0; i++) {
    floored[ranked[i].idx] += 1;
    remainder -= 1;
  }
  return floored;
}

const TEMPO_BUCKET_DEFS = [
  { key: "slow", label: "Slow", color: "#10b981", bg: "#f0fdf4", border: "#bbf7d0", text: "#166534", subText: "#15803d" },
  { key: "mediumSlow", label: "Med Slow", color: "#0ea5e9", bg: "#f0f9ff", border: "#bae6fd", text: "#075985", subText: "#0369a1" },
  { key: "medium", label: "Medium", color: "#4f46e5", bg: "#eef2ff", border: "#c7d2fe", text: "#3730a3", subText: "#4338ca" },
  { key: "mediumFast", label: "Med Fast", color: "#8b5cf6", bg: "#f5f3ff", border: "#ddd6fe", text: "#5b21b6", subText: "#6d28d9" },
  { key: "fast", label: "Fast", color: "#f59e0b", bg: "#fffbeb", border: "#fde68a", text: "#92400e", subText: "#b45309" },
  { key: "unspecified", label: "Unspecified", color: "#94a3b8", bg: "#f8fafc", border: "#cbd5e1", text: "#334155", subText: "#475569" }
];

function classifyTempoBucket(rawSpeed) {
  const sp = String(rawSpeed || "")
    .toLowerCase()
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
  if (sp === "slow") return "slow";
  if (sp === "medium slow" || sp === "vilambit") return "mediumSlow";
  if (sp === "medium" || sp === "madhya") return "medium";
  if (sp === "medium fast" || sp === "drut") return "mediumFast";
  if (sp === "fast") return "fast";
  return "unspecified";
}
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
        distinctTitleRows,
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
        BhajanSubmission.findAll({
          attributes: [[Sequelize.fn("DISTINCT", Sequelize.col("title")), "title"]],
          raw: true
        }),
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

      const uniqueSongsCount = new Set(
        distinctTitleRows.map((r) => normalizeTitleKey(r.title)).filter(Boolean)
      ).size;

      const deityCounts = rawDeities.map((d) => parseInt(d.count, 10) || 0);
      const deityPcts = allocatePercentages(deityCounts);
      const deityStats = rawDeities.map((d, idx) => {
        const name = d.deity || "Unknown";
        const count = deityCounts[idx];
        const icon = DEITY_ICONS[name.toLowerCase().trim()] || "🕉️";
        return { name, count, pct: deityPcts[idx], icon };
      });

      const tempoCountsMap = {
        slow: 0,
        mediumSlow: 0,
        medium: 0,
        mediumFast: 0,
        fast: 0,
        unspecified: 0
      };
      rawSpeeds.forEach((s) => {
        const count = parseInt(s.count, 10) || 0;
        const bucket = classifyTempoBucket(s.speed);
        tempoCountsMap[bucket] += count;
      });

      const bucketCounts = TEMPO_BUCKET_DEFS.map((def) => tempoCountsMap[def.key]);
      const bucketPcts = allocatePercentages(bucketCounts);
      const tempoBuckets = TEMPO_BUCKET_DEFS.map((def, idx) => ({
        ...def,
        count: bucketCounts[idx],
        pct: bucketPcts[idx]
      }));

      const pctByKey = Object.fromEntries(tempoBuckets.map((b) => [b.key, b.pct]));
      const slowPct = pctByKey.slow || 0;
      const medPct = pctByKey.medium || 0;
      const fastPct = pctByKey.fast || 0;

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
          ...tempoCountsMap,
          slowPct,
          medPct,
          fastPct,
          mediumSlowPct: pctByKey.mediumSlow || 0,
          mediumFastPct: pctByKey.mediumFast || 0,
          unspecifiedPct: pctByKey.unspecified || 0,
          buckets: tempoBuckets
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
