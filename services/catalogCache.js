/**
 * Enterprise In-Memory Catalog Cache Service
 *
 * Caches the active Prashanti Mandir Bhajan catalog (~1,024 entries),
 * pre-computed filter metadata, O(1) ID/title lookup maps, pre-built
 * fuzzyMatcher index, and active Singer directory.
 *
 * Eliminates full-table SQLite scans + O(N) string crunching across
 * /master-bank, /plan-view, /database, /submit-form, /api/master-bhajans/*,
 * /admin/missing-bhajans, and /diwali/*.
 */
const MasterBhajan = require("../models/MasterBhajan");
const Singer = require("../models/Singer");
const { buildMasterIndex } = require("./fuzzyMatcher");

let masterCache = null;
let masterCachePromise = null;
let masterCacheBuiltAt = 0;
const MASTER_CACHE_TTL_MS = 10 * 60 * 1000; // 10 min safety TTL + instant invalidation on write

let singerCache = null;
let singerCachePromise = null;
let singerCacheBuiltAt = 0;
const SINGER_CACHE_TTL_MS = 5 * 60 * 1000;

function normalizeTitleKey(str) {
  return String(str || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

function buildFilterAggregates(lightRows) {
  const deityMap = new Map();
  const ragaMap = new Map();

  lightRows.forEach((b) => {
    if (b.deity) {
      b.deity
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((d) => {
          let name = d;
          let key = d.toLowerCase();
          if (
            key === "vittala" ||
            key === "vithhala" ||
            key === "vithala" ||
            key === "vitthala"
          ) {
            name = "Vitthala";
            key = "vitthala";
          } else if (
            key === "anjaneya" ||
            key === "aanjaneya" ||
            key === "hanuman" ||
            key === "maruti" ||
            key === "maruthi"
          ) {
            name = "Hanuman";
            key = "hanuman";
          }
          if (!deityMap.has(key)) {
            deityMap.set(key, { name, count: 0 });
          }
          deityMap.get(key).count++;
        });
    }

    if (b.raga) {
      const cleanRaga = b.raga.replace(/~/g, "").trim();
      cleanRaga
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((r) => {
          const key = r.toLowerCase();
          if (!ragaMap.has(key)) {
            ragaMap.set(key, { name: r, count: 0 });
          }
          ragaMap.get(key).count++;
        });
    }
  });

  const uniqueDeities = Array.from(deityMap.values()).sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );
  const uniqueTempos = [
    ...new Set(lightRows.map((b) => (b.tempo || "").trim()).filter(Boolean))
  ].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  const uniqueRagas = Array.from(ragaMap.values()).sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );

  return { uniqueDeities, uniqueTempos, uniqueRagas };
}

async function loadMasterCache() {
  const rows = await MasterBhajan.findAll({
    where: { is_active: true },
    order: [["title", "ASC"]],
    raw: true
  });

  const fullById = new Map();
  const byExactLowerTitle = new Map();
  const byNormTitle = new Map();
  const lightList = [];

  for (const r of rows) {
    const hasLyrics = Boolean(r.lyrics && r.lyrics.trim().length > 0);
    const fullItem = {
      id: r.id,
      title: r.title || "",
      deity: r.deity || "",
      level: r.level || "",
      tempo: r.tempo || "",
      raga: r.raga || "",
      raga_notes: r.raga_notes || "",
      shruti: r.shruti || "",
      shruti_female: r.shruti_female || "",
      language: r.language || "",
      lyrics: r.lyrics || "",
      sheet_filename: r.sheet_filename || "",
      is_active: Boolean(r.is_active),
      has_lyrics: hasLyrics
    };

    const lightItem = {
      id: r.id,
      title: r.title || "",
      deity: r.deity || "",
      level: r.level || "",
      tempo: r.tempo || "",
      raga: r.raga || "",
      raga_notes: r.raga_notes || "",
      shruti: r.shruti || "",
      shruti_female: r.shruti_female || "",
      language: r.language || "",
      sheet_filename: r.sheet_filename || "",
      is_active: true,
      has_lyrics: hasLyrics
    };

    fullById.set(Number(r.id), fullItem);
    const lowerTitle = (r.title || "").trim().toLowerCase();
    if (lowerTitle && !byExactLowerTitle.has(lowerTitle)) {
      byExactLowerTitle.set(lowerTitle, fullItem);
    }
    const normTitle = normalizeTitleKey(r.title);
    if (normTitle && !byNormTitle.has(normTitle)) {
      byNormTitle.set(normTitle, fullItem);
    }
    lightList.push(lightItem);
  }

  const fuzzyIndex = buildMasterIndex(lightList);
  const aggregates = buildFilterAggregates(lightList);

  masterCache = {
    fullRows: Array.from(fullById.values()),
    lightRows: lightList,
    fullById,
    byExactLowerTitle,
    byNormTitle,
    fuzzyIndex,
    aggregates
  };
  masterCacheBuiltAt = Date.now();
  return masterCache;
}

async function getMasterCatalog(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && masterCache && now - masterCacheBuiltAt < MASTER_CACHE_TTL_MS) {
    return masterCache;
  }
  if (!forceRefresh && masterCachePromise) {
    return masterCachePromise;
  }
  masterCachePromise = loadMasterCache().finally(() => {
    masterCachePromise = null;
  });
  return masterCachePromise;
}

function invalidateMasterCache() {
  masterCache = null;
  masterCacheBuiltAt = 0;
}

async function getSingersCatalog(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && singerCache && now - singerCacheBuiltAt < SINGER_CACHE_TTL_MS) {
    return singerCache;
  }
  if (!forceRefresh && singerCachePromise) {
    return singerCachePromise;
  }
  singerCachePromise = Singer.findAll({
    order: [["name", "ASC"]],
    raw: true
  })
    .then((rows) => {
      const byLowerName = new Map();
      const byId = new Map();
      rows.forEach((s) => {
        byId.set(Number(s.id), s);
        const key = (s.name || "").trim().toLowerCase();
        if (key && !byLowerName.has(key)) byLowerName.set(key, s);
      });
      singerCache = { rows, byLowerName, byId };
      singerCacheBuiltAt = Date.now();
      return singerCache;
    })
    .finally(() => {
      singerCachePromise = null;
    });

  return singerCachePromise;
}

function invalidateSingerCache() {
  singerCache = null;
  singerCacheBuiltAt = 0;
}

module.exports = {
  getMasterCatalog,
  invalidateMasterCache,
  getSingersCatalog,
  invalidateSingerCache,
  normalizeTitleKey
};

