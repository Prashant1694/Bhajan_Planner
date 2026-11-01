const MasterBhajan = require("../models/MasterBhajan");
const BhajanSubmission = require("../models/BhajanSubmission");
const sequelize = require("../config/database");
const { Sequelize } = require("sequelize");
const { invalidateMissingCount } = require("../services/helpers");
const {
  getMasterCatalog,
  invalidateMasterCache,
  normalizeTitleKey
} = require("../services/catalogCache");
const ExcelJS = require("exceljs");

exports.showMasterBank = async (req, res) => {
  try {
    const catalog = await getMasterCatalog();
    const isAdmin = !!(req.session && (req.session.adminUserId || req.session.admin));
    res.render("master-bank", {
      bhajans: catalog.lightRows,
      aggregates: catalog.aggregates,
      pageTitle: "Songbook — Prashanti Bhajan Catalog",
      page: "master-bank",
      isAdmin
    });
  } catch (error) {
    console.error(`[Req ${req.id || ""}] showMasterBank error:`, error);
    res.status(500).send("<h1>Error</h1><p>Failed to load master songbook.</p>");
  }
};

function normalizeDeityString(str) {
  if (!str) return str;
  return str
    .split(",")
    .map((s) => {
      const trimmed = s.trim();
      const lower = trimmed.toLowerCase();
      if (
        lower === "vittala" ||
        lower === "vithhala" ||
        lower === "vithala" ||
        lower === "vitthala"
      ) {
        return "Vitthala";
      }
      if (
        lower === "anjaneya" ||
        lower === "aanjaneya" ||
        lower === "hanuman" ||
        lower === "maruti" ||
        lower === "maruthi"
      ) {
        return "Hanuman";
      }
      return trimmed;
    })
    .join(", ");
}

exports.addMasterBhajan = async (req, res) => {
  try {
    const {
      title,
      deity,
      raga,
      raga_notes,
      tempo,
      level,
      shruti,
      shruti_female,
      lyrics,
      sheet_filename
    } = req.body;
    const cleanDeity = normalizeDeityString(deity);
    await MasterBhajan.create({
      title,
      deity: cleanDeity,
      raga,
      raga_notes,
      tempo,
      level,
      shruti,
      shruti_female,
      lyrics,
      sheet_filename,
      is_active: true
    });
    invalidateMasterCache();
    invalidateMissingCount();
    res.json({ success: true });
  } catch (error) {
    console.error(`[Req ${req.id || ""}] addMasterBhajan error:`, error);
    res.status(500).json({ error: "Failed to add bhajan to catalog." });
  }
};

exports.updateMasterBhajan = async (req, res) => {
  try {
    const {
      title,
      deity,
      level,
      tempo,
      raga,
      raga_notes,
      shruti,
      shruti_female,
      language,
      lyrics,
      sheet_filename
    } = req.body;

    const updateFields = {
      title,
      deity: normalizeDeityString(deity),
      level,
      tempo,
      raga,
      raga_notes,
      shruti,
      shruti_female,
      language,
      lyrics
    };
    if (sheet_filename !== undefined) {
      updateFields.sheet_filename = sheet_filename || null;
    }

    await MasterBhajan.update(updateFields, { where: { id: req.params.id } });
    invalidateMasterCache();
    invalidateMissingCount();

    res.json({ success: true, message: "Bhajan updated successfully!" });
  } catch (error) {
    console.error(`[Req ${req.id || ""}] updateMasterBhajan error:`, error);
    res.status(500).json({ error: "Failed to update bhajan." });
  }
};

exports.deleteMasterBhajan = async (req, res) => {
  try {
    // Soft-delete / archive to preserve historical foreign references
    await MasterBhajan.update({ is_active: false }, { where: { id: req.params.id } });
    invalidateMasterCache();
    invalidateMissingCount();
    res.json({ success: true, message: "Bhajan archived successfully" });
  } catch (error) {
    console.error(`[Req ${req.id || ""}] deleteMasterBhajan error:`, error);
    res.status(500).json({ error: "Failed to archive bhajan." });
  }
};

exports.exportMaster = async (req, res) => {
  try {
    const catalog = await getMasterCatalog();
    const allBhajans = catalog.fullRows;

    const format = (req.query.format || "json").toLowerCase();
    if (format === "excel" || format === "xlsx") {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Master Bhajans");
      sheet.addRow([
        "ID",
        "Title",
        "Deity",
        "Tempo",
        "Raag",
        "Raag Notes",
        "Shruti (Gents)",
        "Shruti (Ladies)",
        "Language",
        "Lyrics"
      ]);
      allBhajans.forEach((b) => {
        sheet.addRow([
          b.id,
          b.title,
          b.deity,
          b.tempo,
          b.raga,
          b.raga_notes,
          b.shruti,
          b.shruti_female,
          b.language,
          b.lyrics
        ]);
      });
      const buffer = await workbook.xlsx.writeBuffer();
      res.setHeader("Content-Disposition", "attachment; filename=master_bhajans.xlsx");
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      return res.send(Buffer.from(buffer));
    }

    const jsonString = JSON.stringify(allBhajans, null, 2);
    res.setHeader("Content-disposition", "attachment; filename=cleaned_master_bhajans.json");
    res.setHeader("Content-type", "application/json");
    res.send(jsonString);
  } catch (error) {
    console.error(`[Req ${req.id || ""}] exportMaster error:`, error);
    res.status(500).send("Export failed.");
  }
};

exports.showArchivedMasterBank = async (req, res) => {
  try {
    const isAdmin = !!(req.session && (req.session.adminUserId || req.session.admin));
    const archivedBhajans = await MasterBhajan.findAll({
      where: { is_active: false },
      order: [["title", "ASC"]]
    });

    let diwaliRefs = [];
    try {
      const [refs] = await sequelize.query(`
        SELECT master_bhajan_id, COUNT(*) as ref_count
        FROM diwali_participant_bhajans
        WHERE master_bhajan_id IS NOT NULL
        GROUP BY master_bhajan_id
      `);
      diwaliRefs = refs || [];
    } catch (_) {
      diwaliRefs = [];
    }
    const refMap = new Map();
    diwaliRefs.forEach((r) => refMap.set(Number(r.master_bhajan_id), r.ref_count));

    const bhajansWithRefs = archivedBhajans.map((b) => ({
      ...b.toJSON(),
      refCount: refMap.get(b.id) || 0
    }));

    res.render("admin-archived-master", {
      pageTitle: "Archived Master Bhajans",
      isAdminPage: true,
      bhajans: bhajansWithRefs,
      isAdmin
    });
  } catch (error) {
    console.error(`[Req ${req.id || ""}] Error loading archived bhajans:`, error);
    res.status(500).send("<h1>Error</h1><p>Failed to load archived bhajans catalog.</p>");
  }
};

exports.reconcileBhajan = async (req, res) => {
  try {
    const { submitted_title, action, master_bhajan_id } = req.body;

    if (!submitted_title) {
      return res.status(400).json({ error: "submitted_title is required." });
    }

    if (action === "link") {
      if (!master_bhajan_id) {
        return res.status(400).json({ error: "master_bhajan_id is required for link action." });
      }

      const catalog = await getMasterCatalog();
      const master = catalog.fullById.get(Number(master_bhajan_id));
      if (!master || !master.is_active) {
        return res.status(404).json({ error: "Active Master bhajan not found." });
      }

      const normSubmitted = normalizeTitleKey(submitted_title);

      const allSubmissions = await BhajanSubmission.findAll({
        attributes: ["id", "title"],
        raw: true
      });

      const toUpdate = allSubmissions.filter(
        (s) => normalizeTitleKey(s.title) === normSubmitted
      );

      if (toUpdate.length > 0) {
        const ids = toUpdate.map((s) => s.id);
        await BhajanSubmission.update(
          { title: master.title },
          { where: { id: { [Sequelize.Op.in]: ids } } }
        );
        invalidateMissingCount();
      }

      return res.json({
        success: true,
        updatedCount: toUpdate.length,
        masterTitle: master.title
      });
    }

    return res.json({ success: true, action: "add" });
  } catch (error) {
    console.error(`[Req ${req.id || ""}] reconcileBhajan error:`, error);
    res.status(500).json({ error: "Failed to reconcile bhajan." });
  }
};

exports.showBhajanDetails = async (req, res) => {
  try {
    const rawId = req.params.id;
    if (!rawId || rawId === "null" || rawId === "undefined") {
      return res.status(404).render("not-found", {
        pageTitle: "Bhajan Not Found",
        message: "The requested bhajan could not be identified or found in the catalog.",
        pageCSS: null
      });
    }

    const trimmed = String(rawId).trim();
    const catalog = await getMasterCatalog();
    let bhajan = null;

    if (/^\d+$/.test(trimmed)) {
      bhajan = catalog.fullById.get(parseInt(trimmed, 10)) || null;
    } else {
      const decoded = decodeURIComponent(trimmed).trim().toLowerCase();
      bhajan =
        catalog.byExactLowerTitle.get(decoded) ||
        catalog.byNormTitle.get(normalizeTitleKey(decoded)) ||
        null;
      if (!bhajan) {
        const dbRow = await MasterBhajan.findOne({
          where: {
            is_active: true,
            title: { [Sequelize.Op.like]: decodeURIComponent(trimmed) }
          },
          raw: true
        });
        if (dbRow) bhajan = dbRow;
      }
    }

    if (!bhajan || !bhajan.is_active) {
      return res.status(404).render("not-found", {
        pageTitle: "Bhajan Not Found",
        message: "The requested bhajan could not be found or has been archived.",
        pageCSS: null
      });
    }

    const isAdmin = !!(req.session && (req.session.adminUserId || req.session.admin));

    res.render("bhajan-details", {
      bhajan,
      pageTitle: `${bhajan.title} — Lyrics & Details`,
      pageCSS: "bhajan-details.css",
      page: "bhajan-details",
      isAdmin
    });
  } catch (error) {
    console.error(`[Req ${req.id || ""}] Error in showBhajanDetails:`, error);
    res.status(404).render("not-found", {
      pageTitle: "Bhajan Not Found",
      message: "The requested bhajan could not be retrieved at this time.",
      pageCSS: null
    });
  }
};
