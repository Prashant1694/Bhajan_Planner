const DEITY_ORDER = [
  "Ganesha",
  "Guru",
  "Mata",
  "SarvaDharma",
  "Sai",
  "Shiva",
  "Krishna",
  "Rama",
  "Narayana",
  "Vitthala",
  "Hanuman"
];

const SPEED_ORDER = { slow: 0, medium: 1, fast: 2 };

function deityOrderKey(deity) {
  let d = (deity || "").toLowerCase().trim();
  if (d === "vittala" || d === "vithhala" || d === "vithala") d = "vitthala";
  if (d === "anjaneya" || d === "aanjaneya" || d === "maruti" || d === "maruthi") d = "hanuman";
  const index = DEITY_ORDER.findIndex((o) => o.toLowerCase() === d);
  return index !== -1 ? index : DEITY_ORDER.length;
}

const TIMEZONE = process.env.APP_TIMEZONE || "Asia/Kolkata";

const DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

const DAY_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: TIMEZONE,
  weekday: "short"
});

const HOUR_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: TIMEZONE,
  hour: "numeric",
  hour12: false
});

const DAY_MAP = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function getLocalDateStr(date = new Date(), timeZone = TIMEZONE) {
  if (timeZone === TIMEZONE) return DATE_FORMATTER.format(date);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function getThursdaySubmissionStatus(now = new Date(), timeZone = TIMEZONE) {
  const todayStr = getLocalDateStr(now, timeZone);

  const dayStr =
    timeZone === TIMEZONE
      ? DAY_FORMATTER.format(now)
      : new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(now);
  const day = DAY_MAP[dayStr] ?? 0;

  const hourStr =
    timeZone === TIMEZONE
      ? HOUR_FORMATTER.format(now)
      : new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hour12: false }).format(now);
  const hour = parseInt(hourStr, 10);

  const minStr = new Intl.DateTimeFormat("en-US", { timeZone, minute: "numeric" }).format(now);
  const minute = parseInt(minStr, 10);
  const currentMinutes = hour * 60 + minute;

  const daysUntilNextThu = (4 - day + 7) % 7 || 7;
  const [y, m, d] = todayStr.split("-").map(Number);
  const nextThuObj = new Date(y, m - 1, d + daysUntilNextThu);
  const nextThuStr = getLocalDateStr(nextThuObj, timeZone);

  const isTodayThursday = day === 4;
  const isThursdayLiveActive = isTodayThursday && currentMinutes <= 20 * 60 + 30;
  const activeLiveThursday = isThursdayLiveActive ? todayStr : nextThuStr;

  if (day === 4 && hour < 20) {
    return {
      openThursday: null,
      opensAt8pmToday: true,
      nextThursdayDate: nextThuStr,
      activeLiveThursday,
      isThursdayLiveActive,
      todayStr
    };
  }

  return {
    openThursday: nextThuStr,
    opensAt8pmToday: false,
    nextThursdayDate: nextThuStr,
    activeLiveThursday,
    isThursdayLiveActive,
    todayStr
  };
}

function parseSessionEndTime(desc) {
  if (!desc || typeof desc !== "string") return { hour: 20, minute: 30 };
  const match =
    desc.match(/(?:to|-|till|until)\s*(\d{1,2})(?::|\.)?(\d{2})?\s*(am|pm)?/i) ||
    desc.match(/(\d{1,2})(?::|\.)?(\d{2})?\s*(am|pm)/i);
  if (match) {
    let h = parseInt(match[1], 10);
    const m = match[2] ? parseInt(match[2], 10) : 0;
    const meridiem = (match[3] || "").toLowerCase();
    if (meridiem === "pm" && h < 12) h += 12;
    if (meridiem === "am" && h === 12) h = 0;
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      return { hour: h, minute: m };
    }
  }
  return { hour: 20, minute: 30 };
}

function isSessionActiveOrUpcoming(dateStr, desc = "", now = new Date(), timeZone = TIMEZONE) {
  const todayStr = getLocalDateStr(now, timeZone);
  if (dateStr > todayStr) return true;
  if (dateStr < todayStr) return false;
  const hourStr =
    timeZone === TIMEZONE
      ? HOUR_FORMATTER.format(now)
      : new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hour12: false }).format(now);
  const minStr = new Intl.DateTimeFormat("en-US", { timeZone, minute: "numeric" }).format(now);
  const currentMinutes = parseInt(hourStr, 10) * 60 + parseInt(minStr, 10);
  const { hour: endH, minute: endM } = parseSessionEndTime(desc);
  const endMinutes = endH * 60 + endM;
  return currentMinutes <= endMinutes;
}

function getNextThursday() {
  return getThursdaySubmissionStatus().nextThursdayDate;
}

function normalizeName(str) {
  return String(str || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function formatDateHuman(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  const options = { day: "2-digit", month: "short", year: "numeric" };
  return d.toLocaleDateString("en-GB", options);
}

function timeSince(dateStr) {
  if (!dateStr) return "-";
  const date = new Date(dateStr);
  const now = new Date();
  date.setHours(0, 0, 0, 0);
  now.setHours(0, 0, 0, 0);

  const diffTime = now - date;
  const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "Today";
  if (diffDays < 0) {
    const absDays = Math.abs(diffDays);
    if (absDays === 1) return "Tomorrow";
    if (absDays < 7) return `In ${absDays} days`;
    if (absDays < 30) return `In ${Math.floor(absDays / 7)} week(s)`;
    if (absDays < 365) return `In ${Math.floor(absDays / 30)} month(s)`;
    return `In ${Math.floor(absDays / 365)} year(s)`;
  }
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} week(s) ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)} month(s) ago`;
  return `${Math.floor(diffDays / 365)} year(s) ago`;
}

let cachedMissingCount = null;
let lastMissingCountTime = 0;

async function getCachedMissingCount(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedMissingCount !== null && now - lastMissingCountTime < 60000) {
    return cachedMissingCount;
  }
  try {
    const BhajanSubmission = require("../models/BhajanSubmission");
    const { getMasterCatalog, normalizeTitleKey } = require("./catalogCache");
    const { Sequelize } = require("sequelize");

    const [submitted, catalog] = await Promise.all([
      BhajanSubmission.findAll({
        attributes: [[Sequelize.fn("DISTINCT", Sequelize.col("title")), "title"]],
        raw: true
      }),
      getMasterCatalog()
    ]);

    const count = submitted.filter((s) => {
      const norm = normalizeTitleKey(s.title);
      return norm && !catalog.byNormTitle.has(norm);
    }).length;

    cachedMissingCount = count;
    lastMissingCountTime = now;
    return count;
  } catch (e) {
    return cachedMissingCount || 0;
  }
}

function invalidateMissingCount() {
  cachedMissingCount = null;
}

function getWesternScale(indianScale) {
  if (!indianScale || indianScale === "-" || indianScale === "Not specified") return "-";
  const match = indianScale
    .toString()
    .trim()
    .match(/^([\d\.]+)\s*([PMpm])?.*$/);
  if (!match) return "-";
  const numMap = {
    1: 0,
    1.5: 1,
    2: 2,
    2.5: 3,
    3: 4,
    4: 5,
    4.5: 6,
    5: 7,
    5.5: 8,
    6: 9,
    6.5: 10,
    7: 11
  };
  if (numMap[match[1]] === undefined) return "-";
  let index = numMap[match[1]];
  if ((match[2] || "").toUpperCase() === "M") index = (index + 5) % 12;
  return ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"][index];
}

function getDeityIcon(deity) {
  if (!deity) return "🕉️";
  const d = deity.toLowerCase();
  if (d.includes("ganesh")) return "🐘";
  if (d.includes("guru")) return "🙏";
  if (d.includes("shiva")) return "🔱";
  if (
    d.includes("devi") ||
    d.includes("amman") ||
    d.includes("durga") ||
    d.includes("saraswati") ||
    d.includes("lakshmi") ||
    d.includes("mata")
  )
    return "🌸";
  if (d.includes("ram")) return "🏹";
  if (d.includes("krishna")) return "🪈";
  if (d.includes("sai") || d.includes("baba")) return "🪔";
  if (d.includes("subrahmanya") || d.includes("muruga") || d.includes("kartikeya")) return "🪶";
  if (d.includes("hanuman") || d.includes("anjaneya") || d.includes("maruti")) return "🐒";
  if (
    d.includes("narayana") ||
    d.includes("vishnu") ||
    d.includes("vitthal") ||
    d.includes("panduranga")
  )
    return "🦚";
  if (d.includes("sarva") || d.includes("all")) return "🕊️";
  return "🕉️";
}

function getNumberEmoji(num) {
  const map = {
    1: "1️⃣",
    2: "2️⃣",
    3: "3️⃣",
    4: "4️⃣",
    5: "5️⃣",
    6: "6️⃣",
    7: "7️⃣",
    8: "8️⃣",
    9: "9️⃣",
    10: "🔟"
  };
  return map[num] || `${num}.`;
}

module.exports = {
  DEITY_ORDER,
  SPEED_ORDER,
  deityOrderKey,
  getNextThursday,
  getThursdaySubmissionStatus,
  getLocalDateStr,
  normalizeName,
  formatDateHuman,
  timeSince,
  getCachedMissingCount,
  invalidateMissingCount,
  getWesternScale,
  getDeityIcon,
  getNumberEmoji,
  parseSessionEndTime,
  isSessionActiveOrUpcoming
};
