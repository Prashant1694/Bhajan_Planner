const { Sequelize } = require("sequelize");
const SessionPermission = require("../models/SessionPermission");
const {
  getLocalDateStr,
  getThursdaySubmissionStatus,
  isSessionActiveOrUpcoming
} = require("./helpers");

const normalizeBhajanTitle = (title) =>
  String(title || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();

/**
 * Fetches available upcoming/active session dates
 */
const getAvailableDates = async () => {
  const todayStr = getLocalDateStr();
  const status = getThursdaySubmissionStatus();

  const specialDays = await SessionPermission.findAll({
    where: { date: { [Sequelize.Op.gte]: todayStr } },
    order: [["date", "ASC"]]
  });

  const dates = new Map();
  if (status.isThursdayLiveActive) {
    dates.set(status.todayStr, {
      label: "Today's Thursday Bhajan",
      desc: "Active Session (7:30 PM - 8:30 PM)"
    });
  }
  if (status.openThursday) {
    dates.set(status.openThursday, {
      label: "Upcoming Thursday",
      desc: "Regular Session"
    });
  }
  specialDays.forEach((p) => {
    if (isSessionActiveOrUpcoming(p.date, p.description)) {
      const label = p.type === "festival" ? "Festival" : "Special";
      dates.set(p.date, { label, desc: p.description || "" });
    }
  });
  return { dates, status };
};

/**
 * Computes deity status map and card counts for a session
 */
function buildDeityStatus(rules, submissions) {
  const deityStatus = {};
  const ALL_DEITIES = [
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

  ALL_DEITIES.forEach((d) => {
    const rule = rules.find((r) => r.deity_name === d) || {
      min_required: 0,
      max_allowed: 2
    };
    deityStatus[d] = {
      taken: false,
      count: 0,
      by: "",
      bhajan: "",
      scale: "",
      speed: "",
      mandatory: rule.min_required > 0,
      minReq: rule.min_required,
      maxAllowed: rule.max_allowed
    };
  });

  submissions.forEach((bhajan) => {
    if (deityStatus[bhajan.deity]) {
      deityStatus[bhajan.deity].taken = true;
      deityStatus[bhajan.deity].by = bhajan.singer_name;
      deityStatus[bhajan.deity].bhajan = bhajan.title;
      deityStatus[bhajan.deity].scale = bhajan.scale || "Not specified";
      deityStatus[bhajan.deity].speed = bhajan.speed;
      deityStatus[bhajan.deity].count += 1;
    }
  });

  const mandatoryFilled = Object.values(deityStatus).filter(
    (d) => d.mandatory && d.count >= 1
  ).length;
  const totalMandatory = Object.values(deityStatus).filter((d) => d.mandatory).length;

  const optionalFilled = Object.values(deityStatus).filter(
    (d) => !d.mandatory && d.count >= 1
  ).length;
  const totalOptional = Object.values(deityStatus).filter(
    (d) => !d.mandatory && d.maxAllowed > 0
  ).length;

  return {
    deityStatus,
    mandatoryFilled,
    totalMandatory,
    optionalFilled,
    totalOptional
  };
}

/**
 * Generates deity HTML cards from deity status map
 */
function generateDeityCardsHtml(deityStatus) {
  const generateCard = (deity) => {
    const status = deityStatus[deity];
    let cardClass;
    let statusBadge;
    let onclick;
    const countClass = `count-${Math.min(status.count, 3)}`;

    const starSvg = `<svg class="req-star-svg" width="11" height="11" viewBox="0 0 24 24" fill="currentColor" style="display:inline-block; vertical-align:-1px; margin-right:3px;"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
    const checkSvg = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="display:inline-block; vertical-align:-1px; margin-right:2px;"><polyline points="20 6 9 17 4 12"/></svg>`;

    if (status.maxAllowed === 0) {
      return `<div class="deity-card disabled ${countClass}" style="opacity:0.4; pointer-events:none;"><div class="deity-name">${deity}</div><span class="badge badge-taken" style="background:#e03131;">Blocked</span></div>`;
    }

    const isFull = status.count >= status.maxAllowed;
    const bhajanText = `${status.count} Bhajan${status.count === 1 ? "" : "s"}`;

    if (isFull) {
      cardClass = `deity-card taken ${countClass}`;
      statusBadge = `<span class="badge badge-taken">${checkSvg} ${status.count} Taken</span>`;
      onclick = `onclick="showDetails('${deity}', '${status.by.replace(/'/g, "\\'")}', '${status.bhajan.replace(/'/g, "\\'")}', '${status.scale}', '${status.speed}')" style="cursor:pointer;"`;
    } else {
      cardClass = `deity-card available ${countClass}`;
      statusBadge = `<span class="badge badge-available">${bhajanText}</span>`;
      onclick = "";
    }

    let mandatoryLabel = "";
    if (status.mandatory) {
      if (status.count >= status.minReq) {
        mandatoryLabel = `<div class="rule-warning rule-fulfilled">${starSvg} Required (${status.minReq}) ${checkSvg}</div>`;
      } else {
        mandatoryLabel = `<div class="rule-warning">${starSvg} Required (${status.minReq})</div>`;
      }
    }

    return `
      <div class="${cardClass}" data-deity="${deity}" ${onclick}>
        <div class="deity-name">${deity}</div>
        ${statusBadge}
        ${mandatoryLabel}
      </div>
    `;
  };

  const ganeshaCardHtml = generateCard("Ganesha");
  const otherDeities = [
    "Guru",
    "Mata",
    "SarvaDharma",
    "Sai",
    "Shiva",
    "Krishna",
    "Rama",
    "Narayana",
    "Vitthala"
  ];
  let otherDeitiesHtml = "";
  otherDeities.forEach((d) => (otherDeitiesHtml += generateCard(d)));
  const hanumanCard = generateCard("Hanuman").replace("deity-card", "deity-card hanuman-card");

  return { ganeshaCardHtml, otherDeitiesHtml, hanumanCard };
}

/**
 * Renders selection screen HTML for choosing an open session date
 */
function renderSelectionScreenHtml(msg, availableDates, isAdmin) {
  const sortedDates = Array.from(availableDates.keys()).sort();
  let optionsHtml = "";
  const adminParam = isAdmin ? "&admin=true" : "";

  sortedDates.forEach((date) => {
    const info = availableDates.get(date);
    const type = info.label;
    const descText = info.desc ? ` - ${info.desc}` : "";
    const displayLabel = `${type} (${date})${descText}`;
    let btnStyle = "margin-bottom:10px; width:100%; display:block; text-decoration:none;";
    if (type === "Festival") {
      btnStyle += " background: #ff922b; border:none; color:white;";
    } else if (type === "Special") {
      btnStyle += " background: #4dabf7; border:none; color:white;";
    } else {
      btnStyle += " background: linear-gradient(135deg, #ff9933 0%, #ff7700 100%); color:white;";
    }
    optionsHtml += `<a href="/submit-form?session_date=${date}${adminParam}" class="button" style="${btnStyle}">${displayLabel}</a>`;
  });

  const themeHeadScript = `<script>(function(){try{var t=localStorage.getItem('bp-theme');if(t==='dark')document.documentElement.setAttribute('data-theme','dark');}catch(e){}})();</script>`;
  const themeToggleBtn = `<button class="theme-toggle" id="themeToggle" aria-label="Toggle dark mode" aria-pressed="false" data-tooltip="Switch to Dark"><span class="icon-moon">&#127769;</span><span class="icon-sun">&#9728;&#65039;</span></button>`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Select Session</title><meta name="viewport" content="width=device-width, initial-scale=1" /><link rel="stylesheet" href="/css/style.css">${themeHeadScript}</head><body>${themeToggleBtn}<div class="container" style="text-align:center; padding:40px; max-width:500px;"><h2 style="color:var(--saffron); margin-bottom:20px;">📅 Select Session</h2><p style="color:var(--ink-soft); margin-bottom:20px;">${msg}</p><div style="background:var(--surface); padding:20px; border-radius:12px; border:1px solid var(--border);"><div style="display:flex; flex-direction:column; gap:10px;">${optionsHtml}</div></div></div><script src="/js/script.js"></script></body></html>`;
}

module.exports = {
  normalizeBhajanTitle,
  getAvailableDates,
  buildDeityStatus,
  generateDeityCardsHtml,
  renderSelectionScreenHtml
};
