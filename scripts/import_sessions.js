const { initializeDatabase } = require("../services/databaseInitializer");
const BhajanSubmission = require("../models/BhajanSubmission");
const MasterBhajan = require("../models/MasterBhajan");
const Singer = require("../models/Singer");
const SessionPermission = require("../models/SessionPermission");
const { normalizeName } = require("../services/helpers");
const { Sequelize } = require("sequelize");

const DEITY_KEYWORDS = [
  {
    deity: "Ganesha",
    keywords: [
      "gajanana",
      "ganesha",
      "ganapathi",
      "vigneshwara",
      "vignesh",
      "gajananam",
      "ganayaka",
      "gajavadana",
      "gauri ganesh",
      "gauri sutaya",
      "vighna",
      "gananatha",
      "ganapati"
    ]
  },
  {
    deity: "Guru",
    keywords: [
      "guru",
      "gurunatha",
      "gurudeva",
      "subrahmanya",
      "sharavanabhava",
      "sadguru",
      "aruna ramana"
    ]
  },
  {
    deity: "Mata",
    keywords: [
      "devi",
      "mata",
      "jagadeeshwari",
      "amba",
      "durga",
      "bhawani",
      "janani",
      "amritanandamayi",
      "shakti",
      "raj rajeshwari",
      "parvati",
      "jaganmohini",
      "sharade",
      "gouri",
      "gauri",
      "triputa"
    ]
  },
  {
    deity: "Sai",
    keywords: [
      "sai",
      "baba",
      "parthi",
      "sathya",
      "puttaparthi",
      "shirdi",
      "partishwara",
      "sayeesha"
    ]
  },
  {
    deity: "Shiva",
    keywords: [
      "shiva",
      "shankara",
      "shambho",
      "hara",
      "bholenath",
      "nataraja",
      "mahadeva",
      "shankaram",
      "pashupati",
      "neelakantha",
      "lingam",
      "tatsat",
      "arunachal"
    ]
  },
  {
    deity: "Krishna",
    keywords: [
      "krishna",
      "gopal",
      "govinda",
      "radhey",
      "radhe",
      "madhav",
      "giridhari",
      "murlidhar",
      "kanna",
      "nandalal",
      "nanda",
      "kanhaiya",
      "radhika",
      "keshava",
      "muralidhara"
    ]
  },
  {
    deity: "Rama",
    keywords: [
      "rama",
      "raghu",
      "raghupathi",
      "ramachandra",
      "dasharatha",
      "ayodhya",
      "janaki",
      "raghuveer"
    ]
  },
  {
    deity: "Narayana",
    keywords: ["narayana", "hari", "vishnu", "govinda", "madhava", "vasudevaya", "vasudeva"]
  },
  { deity: "Vitthala", keywords: ["vitthala", "vithala", "panduranga", "pandhari"] },
  {
    deity: "Hanuman",
    keywords: ["hanuman", "maruti", "anjaneya", "aanjaneya", "ram duta", "vanara"]
  }
];

function cleanWhatsAppMarkdown(text) {
  if (!text) return "";
  return text
    .replace(/^\*+|\*+$/g, "")
    .replace(/^_+|_+$/g, "")
    .replace(/^~+|~+$/g, "")
    .trim();
}

function normalizeDeity(deity) {
  if (!deity) return "SarvaDharma";
  const d = deity.replace(/[*_~\[\]]/g, "").trim();
  const lower = d.toLowerCase();
  if (["devi", "durga", "mata", "amba", "janani"].includes(lower)) return "Mata";
  if (["anjaneya", "maruti", "hanuman"].includes(lower)) return "Hanuman";
  if (["vittala", "vitthala", "vithhala", "vithala", "panduranga", "pandhari"].includes(lower)) return "Vitthala";
  if (["subrahmanya", "guru"].includes(lower)) return "Guru";
  if (["ganesha", "ganapathi", "vigneshwara"].includes(lower)) return "Ganesha";
  if (["sai", "baba"].includes(lower)) return "Sai";
  if (["shiva", "shankara", "mahadeva"].includes(lower)) return "Shiva";
  if (["krishna", "govinda", "gopala"].includes(lower)) return "Krishna";
  if (["rama", "ramachandra"].includes(lower)) return "Rama";
  if (["narayana", "vishnu", "hari"].includes(lower)) return "Narayana";
  if (["sarvadharma", "sarva dharma"].includes(lower)) return "SarvaDharma";

  const std = [
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
  for (const s of std) {
    if (s.toLowerCase() === lower) return s;
  }
  return "SarvaDharma";
}

function inferDeity(title) {
  if (!title) return "SarvaDharma";
  const lower = title.toLowerCase();
  for (const item of DEITY_KEYWORDS) {
    for (const kw of item.keywords) {
      if (lower.includes(kw)) {
        return item.deity;
      }
    }
  }
  return "SarvaDharma";
}

function parseDateString(str) {
  if (!str) return null;

  // 1. Check for session_date=YYYY-MM-DD
  const urlMatch = str.match(/session_date=(\d{4}-\d{2}-\d{2})/i);
  if (urlMatch) return urlMatch[1];

  // 2. Check for ISO YYYY-MM-DD
  const isoMatch = str.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;

  // 3. Check for DD/MM/YYYY or DD-MM-YYYY
  const dmyMatch = str.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b/);
  if (dmyMatch) {
    const day = String(dmyMatch[1]).padStart(2, "0");
    const month = String(dmyMatch[2]).padStart(2, "0");
    const year = dmyMatch[3];
    return `${year}-${month}-${day}`;
  }

  // 4. Textual month formats
  const months = {
    jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
    jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12"
  };

  // e.g. "Oct 22, 2026" or "October 22, 2026"
  const m1 = str.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i);
  if (m1) {
    const month = months[m1[1].slice(0, 3).toLowerCase()];
    const day = String(m1[2]).padStart(2, "0");
    const year = m1[3];
    return `${year}-${month}-${day}`;
  }

  // e.g. "22 Oct 2026" or "22nd October 2026"
  const m2 = str.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?,?\s+(\d{4})\b/i);
  if (m2) {
    const day = String(m2[1]).padStart(2, "0");
    const month = months[m2[2].slice(0, 3).toLowerCase()];
    const year = m2[3];
    return `${year}-${month}-${day}`;
  }

  return null;
}

function isBhajanHeaderLine(line) {
  const trimmed = line.trim();
  if (/^\(?\d+\)?[\.\)\-–—\s]/.test(trimmed)) return true;
  if (/^[0-9]\uFE0F?\u20E3/.test(trimmed) || /^\uD83D\uDD1F/.test(trimmed)) return true;
  return false;
}

function splitIntoSessionSections(fullText) {
  const lines = fullText.split(/\r?\n/);
  const sections = [];
  let currentLines = [];

  function isNewSessionBoundary(line, currentLines) {
    const t = line.trim();
    if (!t) return false;
    const isHeader =
      /^(?:🕉️\s*)?\*?SRI SATHYA SAI SEVA ORGANISATION\*?/i.test(t) ||
      /^(?:📅\s*)?\*?(?:BHAJAN PROGRAM|LIVE BHAJAN PLAN)\s*[-–—]/i.test(t) ||
      /^Bhajan Plan\s*[-–—]/i.test(t) ||
      /^(?:\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}|\d{4}-\d{2}-\d{2})$/.test(t);

    if (!isHeader) return false;
    // Only split if current session already parsed at least one bhajan
    return currentLines.some((l) => isBhajanHeaderLine(l));
  }

  for (const line of lines) {
    if (isNewSessionBoundary(line, currentLines)) {
      const joined = currentLines.join("\n").trim();
      if (joined.length > 0) {
        sections.push(joined);
        currentLines = [];
      }
    }
    currentLines.push(line);
  }
  if (currentLines.length > 0) {
    const joined = currentLines.join("\n").trim();
    if (joined.length > 0) sections.push(joined);
  }

  return sections.length > 0 ? sections : [fullText];
}

async function parseBatchSessions(fullText) {
  await initializeDatabase();

  const existingSingers = await Singer.findAll({ attributes: ["id", "name", "gender"], raw: true });

  async function resolveSinger(rawName) {
    if (!rawName || !rawName.trim()) return null;
    const norm = normalizeName(rawName);
    let found = existingSingers.find((s) => normalizeName(s.name) === norm);
    if (!found) {
      const created = await Singer.create({ name: rawName.trim(), gender: null });
      found = { id: created.id, name: created.name, gender: created.gender };
      existingSingers.push(found);
    }
    return found;
  }

  const rawSections = splitIntoSessionSections(fullText);

  let totalSessions = 0;
  let totalBhajans = 0;
  const sessionSummary = [];

  for (const section of rawSections) {
    const lines = section
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (lines.length === 0) continue;

    // Detect session date
    let sessionDate = null;
    for (const line of lines) {
      sessionDate = parseDateString(line);
      if (sessionDate) break;
    }
    if (!sessionDate) continue;

    totalSessions++;

    // Ensure session permission exists
    try {
      if (SessionPermission) {
        await SessionPermission.findOrCreate({
          where: { date: sessionDate },
          defaults: { type: "regular", description: "Regular Session" }
        });
      }
    } catch (_) {}

    // Clear existing entries for this date to prevent duplicate records
    await BhajanSubmission.destroy({ where: { session_date: sessionDate } });

    console.log(`\n========================================`);
    console.log(`🗓️ Processing Session: ${sessionDate}`);

    // Group lines into individual bhajan blocks
    const blocks = [];
    let currentBlock = [];

    for (const line of lines) {
      if (/^[-–—─═]{3,}/.test(line)) {
        if (currentBlock.length > 0) {
          blocks.push(currentBlock);
          currentBlock = [];
        }
        continue;
      }
      if (/Sai Ram to all Accompanists/i.test(line) || /Live Plan:\s*http/i.test(line)) {
        if (currentBlock.length > 0) {
          blocks.push(currentBlock);
          currentBlock = [];
        }
        continue;
      }

      if (isBhajanHeaderLine(line)) {
        if (currentBlock.length > 0) {
          blocks.push(currentBlock);
        }
        currentBlock = [line];
      } else if (currentBlock.length > 0) {
        currentBlock.push(line);
      }
    }
    if (currentBlock.length > 0) {
      blocks.push(currentBlock);
    }

    let listOrder = 0;
    for (const block of blocks) {
      let title = "";
      let singerName = "Group / Devotee";
      let partnerName = null;
      let deity = "SarvaDharma";
      let scale = "Not specified";
      let speed = "medium";

      const blockText = block.join("\n");

      // Extract Pitch & Tempo if present anywhere in the block
      const pitchMatch = blockText.match(/(?:🎹\s*)?(?:Pitch|Scale)\s*:\s*([^|\n\r]+)/i);
      if (pitchMatch) {
        scale = pitchMatch[1].trim();
      }
      const tempoMatch = blockText.match(/(?:🥁\s*)?(?:Tempo|Speed)\s*:\s*([^|\n\r]+)/i);
      if (tempoMatch) {
        speed = tempoMatch[1].trim().toLowerCase();
      }

      // Extract Singer & Partner
      // Look for lines like "👤 Prashant Bhatt (with Nisarg Chaudhry)" or "Singer: ..." or "Lead: ..."
      let singerLine = block.find((l) => /^(?:👤\s*|(?:Singer|Lead)\s*:\s*)/i.test(l));
      if (singerLine) {
        let rawSinger = singerLine.replace(/^(?:👤\s*|(?:Singer|Lead)\s*:\s*)/i, "").trim();
        const withMatch = rawSinger.match(/^(.*?)\s*\((?:with\s+)?(.*?)\)$/i);
        if (withMatch) {
          singerName = withMatch[1].trim();
          partnerName = withMatch[2].trim();
        } else {
          singerName = rawSinger;
        }
      }

      // Extract Deity
      const bracketDeity = blockText.match(/\[([A-Za-z\s]+)\]/);
      if (bracketDeity) {
        deity = normalizeDeity(bracketDeity[1]);
      } else {
        const firstLineClean = block[0].replace(/^[0-9\uFE0F\u20E3\uD83D\uDD1F\(\)\.\s\-–—]+/, "").trim();
        const deityTokenMatch = firstLineClean.match(/^\*?([A-Za-z]+)\*?/);
        if (deityTokenMatch) {
          const testD = normalizeDeity(deityTokenMatch[1]);
          if (testD !== "SarvaDharma" || deityTokenMatch[1].toLowerCase() === "sarvadharma") {
            deity = testD;
          }
        }
      }

      // Extract Title
      const noteLine = block.find((l) => /^🎵/u.test(l));
      if (noteLine) {
        title = cleanWhatsAppMarkdown(noteLine.replace(/^🎵\s*/u, "").trim());
      } else {
        let firstLineContent = block[0].replace(/^[0-9\uFE0F\u20E3\uD83D\uDD1F\(\)\.\s\-–—]+/, "").trim();
        firstLineContent = firstLineContent.replace(/^\[[A-Za-z\s]+\]\s*/, "").trim();

        const checkD = normalizeDeity(firstLineContent);
        if ((checkD !== "SarvaDharma" || firstLineContent.toLowerCase() === "sarvadharma") && block.length > 1 && !singerLine) {
          deity = checkD;
          title = cleanWhatsAppMarkdown(block[1]);
        } else {
          title = cleanWhatsAppMarkdown(firstLineContent);
        }
      }

      // Single-line legacy format handling
      if (block.length === 1 && block[0].includes("[") && block[0].includes("]")) {
        const planMatch = block[0].match(/^\d+[\.\)]\s*(.*?)\s*[-–—]\s*\[(.*?)\]\s*(.*?)(?:\s*[-–—]\s*(.*))?$/);
        if (planMatch) {
          let rawSinger = planMatch[1].trim();
          deity = normalizeDeity(planMatch[2].trim());
          title = planMatch[3].trim();
          const pMatch = rawSinger.match(/^(.*?)\s*\((.*?)\)$/);
          if (pMatch) {
            singerName = pMatch[1].trim();
            partnerName = pMatch[2].trim();
          } else {
            singerName = rawSinger;
          }
        }
      } else if (block.length === 1 && !title.includes("[") && block[0].includes("—")) {
        // Plain text "1. Title — Scale"
        let line = block[0].replace(/^\d+[\.\)]\s*/, "").trim();
        let parts = line.split(/\s*[-–—]\s*/);
        title = parts[0].trim();
        if (parts.length > 1) {
          scale = parts[1].trim();
        }
      }

      // Link with Master Bhajan Bank for verification and auto-enrichment
      const cleanTitle = (title || "")
        .replace(/\s*\(\d+.*?\)/g, "")
        .replace(/\(.*?\)/g, "")
        .trim();

      if (cleanTitle) {
        try {
          const masterMatch = await MasterBhajan.findOne({
            where: {
              is_active: true,
              title: { [Sequelize.Op.like]: `%${cleanTitle}%` }
            }
          });

          if (masterMatch) {
            if (deity === "SarvaDharma" && masterMatch.deity) {
              deity = normalizeDeity(masterMatch.deity);
            }
            if (speed === "medium" && masterMatch.tempo) {
              speed = masterMatch.tempo.toLowerCase();
            }
          } else if (deity === "SarvaDharma") {
            deity = normalizeDeity(inferDeity(cleanTitle));
          }
        } catch (_) {}
      }

      // Resolve singer & partner in Singer directory table
      await resolveSinger(singerName);
      if (partnerName) await resolveSinger(partnerName);

      listOrder++;

      await BhajanSubmission.create({
        session_date: sessionDate,
        singer_name: singerName,
        partner_name: partnerName,
        title: title || "Untitled Bhajan",
        deity: deity,
        scale: scale,
        speed: speed,
        list_order: listOrder
      });

      console.log(
        `  [${listOrder}] ${singerName}${partnerName ? ` & ${partnerName}` : ""} | ${deity} | "${title}" | Pitch: ${scale} | Tempo: ${speed}`
      );
      totalBhajans++;
    }

    sessionSummary.push({ date: sessionDate, count: listOrder });
  }

  console.log(`\n========================================`);
  console.log(`✅ Complete! Processed ${totalSessions} session(s) and ${totalBhajans} bhajan(s).`);

  return { totalSessions, totalBhajans, sessionSummary };
}

module.exports = {
  parseBatchSessions,
  parseDateString,
  normalizeDeity,
  DEITY_KEYWORDS
};
