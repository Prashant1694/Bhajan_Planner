const { Sequelize, Op } = require("sequelize");
const diwaliService = require("../services/diwaliService");
const diwaliExportService = require("../services/diwaliExportService");
const diwaliImportService = require("../services/diwaliImportService");
const activityService = require("../services/activityService");
const {
  MasterBhajan,
  DiwaliParticipant,
  DiwaliParticipantBhajan
} = require("../models/diwaliModels");
const BhajanSubmission = require("../models/BhajanSubmission");

// Pitch-shift calculation matching Thursday Bhajan form
function femaleFallbackShruti(maleShruti) {
  const match = String(maleShruti || "")
    .trim()
    .match(/^(1|1\.5|2|2\.5|3|4|4\.5|5|5\.5|6|6\.5|7)\s*([pPmM])?$/i);
  if (!match) return maleShruti || "";
  const values = ["1", "1.5", "2", "2.5", "3", "4", "4.5", "5", "5.5", "6", "6.5", "7"];
  let pitch = values.indexOf(match[1]);
  if (pitch === -1) return maleShruti || "";
  const suffix = (match[2] || "").toUpperCase();
  if (suffix === "M") pitch = (pitch + 5) % 12;
  const femalePitch = (pitch - 5 + 12) % 12;
  return `${values[femalePitch]}P`;
}

function calculateScaleForGender(bhajan, gender) {
  const isFemale = gender === "Ladies" || gender === "Female";
  const rawFemale = String(bhajan.shruti_female || "").trim();
  const rawMale = String(bhajan.shruti || "").trim();
  const cleanFemale = rawFemale === "#N/A" || !rawFemale ? "" : rawFemale;
  const cleanMale = rawMale === "#N/A" || !rawMale ? "" : rawMale;

  if (isFemale) {
    if (cleanFemale) return cleanFemale;
    if (cleanMale) return femaleFallbackShruti(cleanMale);
    return "";
  }
  return cleanMale;
}

// Helper to resolve the active/selected event
async function resolveSelectedEvent(req) {
  let event = null;
  const requestedYear = req.query?.year || req.body?.year || req.session?.diwaliYear;
  if (requestedYear) {
    const all = await diwaliService.getAllEvents();
    event = all.find((e) => e.year === parseInt(requestedYear, 10));
  }
  if (!event) {
    event = await diwaliService.getOrCreateDefaultEvent();
  }
  if (event && req.session) {
    req.session.diwaliYear = event.year;
  }
  return event;
}

// 1. Dashboard
exports.dashboard = async (req, res) => {
  try {
    const selectedEvent = await resolveSelectedEvent(req);
    const allEvents = await diwaliService.getAllEvents();
    const stats = await diwaliService.getStats(selectedEvent.id);

    const gentsBhajans = await diwaliService.getFlatBhajanRows(selectedEvent.id, {
      gender: "Gents"
    });
    const ladiesBhajans = await diwaliService.getFlatBhajanRows(selectedEvent.id, {
      gender: "Ladies"
    });
    const sequences = await diwaliService.getFullSequences(selectedEvent.id);

    // Extract unique deities and scales for filter dropdowns
    const allBhajans = [...gentsBhajans, ...ladiesBhajans];
    const deities = [...new Set(allBhajans.map((b) => b.deity).filter(Boolean))].sort();
    const scales = [...new Set(allBhajans.map((b) => b.scale).filter(Boolean))].sort();

    res.render("diwali/dashboard", {
      pageTitle: `Diwali Bhajans — ${selectedEvent.name}`,
      page: "diwali",
      selectedEvent,
      allEvents,
      stats,
      gentsBhajans,
      ladiesBhajans,
      sequences,
      deities,
      scales,
      successMsg: req.query.success || null,
      errorMsg: req.query.error || null
    });
  } catch (error) {
    console.error("Error in diwaliController.dashboard:", error);
    res.status(500).send("Error loading Diwali dashboard: " + error.message);
  }
};

// 2. Entry Form View
exports.showEntryForm = async (req, res) => {
  try {
    const selectedEvent = await resolveSelectedEvent(req);
    const allEvents = await diwaliService.getAllEvents();

    res.render("diwali/entry", {
      pageTitle: `Diwali Entry — ${selectedEvent.name}`,
      page: "diwali",
      selectedEvent,
      allEvents,
      errorMsg: null,
      formData: null
    });
  } catch (error) {
    console.error("Error in diwaliController.showEntryForm:", error);
    res.status(500).send("Error loading Diwali entry form: " + error.message);
  }
};

// 3. Create Participant & Bhajans
exports.createParticipant = async (req, res) => {
  try {
    const selectedEvent = await resolveSelectedEvent(req);
    let { lead_name, partner_name, gender, remarks, bhajans } = req.body;

    // Support both JSON API and form-encoded data
    if (typeof bhajans === "string") {
      try {
        bhajans = JSON.parse(bhajans);
      } catch (_) {
        bhajans = [];
      }
    }

    if (!Array.isArray(bhajans) && req.body["bhajan_title"] !== undefined) {
      // If submitted as traditional multi-inputs
      const rawTitles = req.body.bhajan_title;
      const titles = Array.isArray(rawTitles) ? rawTitles : [rawTitles];
      const masterIds = Array.isArray(req.body.master_bhajan_id)
        ? req.body.master_bhajan_id
        : [req.body.master_bhajan_id];
      const scales = Array.isArray(req.body.scale) ? req.body.scale : [req.body.scale];
      const tablas = Array.isArray(req.body.tabla) ? req.body.tabla : [req.body.tabla];
      const shrutis = Array.isArray(req.body.shruti) ? req.body.shruti : [req.body.shruti];
      const deities = Array.isArray(req.body.deity) ? req.body.deity : [req.body.deity];
      const bhajanRemarks = Array.isArray(req.body.bhajan_remarks)
        ? req.body.bhajan_remarks
        : [req.body.bhajan_remarks];

      bhajans = titles.map((title, idx) => ({
        bhajan_title: (title || "").trim(),
        master_bhajan_id: (masterIds && masterIds[idx]) || null,
        scale: (scales && scales[idx]) || "",
        tabla: (tablas && tablas[idx]) || "",
        shruti: (shrutis && shrutis[idx]) || (scales && scales[idx]) || "",
        deity: (deities && deities[idx]) || "",
        remarks: (bhajanRemarks && bhajanRemarks[idx]) || ""
      }));
    }
    if (!Array.isArray(bhajans)) {
      bhajans = [];
    }

    const participant = await diwaliService.createParticipantWithBhajans({
      event_id: selectedEvent.id,
      lead_name,
      partner_name,
      gender,
      remarks,
      bhajans
    });

    await activityService.log(
      req.session.admin,
      "DIWALI_PARTICIPANT_CREATED",
      `Added participant '${lead_name}' & '${partner_name}' (${gender}) with ${bhajans.length} bhajans for ${selectedEvent.name}.`
    );

    if (req.xhr || req.headers.accept?.includes("application/json")) {
      return res.json({ success: true, participant });
    }

    res.redirect(`/admin/diwali?year=${selectedEvent.year}&success=Participant+saved+successfully`);
  } catch (error) {
    console.error("Error creating Diwali participant:", error);
    if (req.xhr || req.headers.accept?.includes("application/json")) {
      return res.status(400).json({ success: false, error: error.message });
    }
    let selectedEvent = null;
    let allEvents = [];
    try {
      selectedEvent = await resolveSelectedEvent(req);
      allEvents = await diwaliService.getAllEvents();
    } catch (_) {}
    if (!selectedEvent) {
      selectedEvent = { year: new Date().getFullYear(), name: `Diwali ${new Date().getFullYear()}` };
    }
    res.render("diwali/entry", {
      pageTitle: `Diwali Entry — ${selectedEvent.name}`,
      page: "diwali",
      selectedEvent,
      allEvents,
      errorMsg: error.message,
      formData: req.body
    });
  }
};

// 4. Get Participant Details for Edit
exports.getParticipantJson = async (req, res) => {
  try {
    const participant = await diwaliService.getParticipantById(req.params.id);
    if (!participant) {
      return res.status(404).json({ success: false, error: "Participant not found" });
    }
    res.json({ success: true, participant });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// 5. Update Participant
exports.updateParticipant = async (req, res) => {
  try {
    let { lead_name, partner_name, gender, remarks, bhajans } = req.body;
    if (typeof bhajans === "string") {
      try {
        bhajans = JSON.parse(bhajans);
      } catch (_) {
        bhajans = [];
      }
    }

    const updated = await diwaliService.updateParticipantWithBhajans(req.params.id, {
      lead_name,
      partner_name,
      gender,
      remarks,
      bhajans
    });

    await activityService.log(
      req.session.admin,
      "DIWALI_PARTICIPANT_EDITED",
      `Updated participant '${lead_name}' & '${partner_name}' (ID: ${req.params.id}).`
    );

    res.json({ success: true, participant: updated });
  } catch (error) {
    console.error("Error updating participant:", error);
    res.status(400).json({ success: false, error: error.message });
  }
};

// 6. Delete Participant
exports.deleteParticipant = async (req, res) => {
  try {
    const participant = await diwaliService.getParticipantById(req.params.id);
    const desc = participant
      ? `'${participant.lead_name}' & '${participant.partner_name}'`
      : `ID ${req.params.id}`;

    await diwaliService.deleteParticipant(req.params.id);

    await activityService.log(
      req.session.admin,
      "DIWALI_PARTICIPANT_DELETED",
      `Deleted participant ${desc}.`
    );

    if (req.xhr || req.headers.accept?.includes("application/json")) {
      return res.json({ success: true });
    }
    res.redirect("/admin/diwali?success=Participant+deleted+successfully");
  } catch (error) {
    console.error("Error deleting participant:", error);
    if (req.xhr || req.headers.accept?.includes("application/json")) {
      return res.status(400).json({ success: false, error: error.message });
    }
    res.redirect("/admin/diwali?error=" + encodeURIComponent(error.message));
  }
};

// 7. Delete Bhajan
exports.deleteBhajan = async (req, res) => {
  try {
    await diwaliService.deleteBhajan(req.params.id);
    await activityService.log(
      req.session.admin,
      "DIWALI_BHAJAN_REMOVED",
      `Removed bhajan ID ${req.params.id}.`
    );
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

// 8. Create Diwali Event / Year
exports.createEvent = async (req, res) => {
  try {
    const { year, name, status } = req.body;
    const newEvent = await diwaliService.createEvent({ year, name, status });

    await activityService.log(
      req.session.admin,
      "DIWALI_EVENT_CREATED",
      `Created new Diwali event '${newEvent.name}' (${newEvent.year}).`
    );

    if (req.session) req.session.diwaliYear = newEvent.year;
    res.redirect(`/admin/diwali?year=${newEvent.year}&success=Event+created+successfully`);
  } catch (error) {
    console.error("Error creating Diwali event:", error);
    res.redirect(`/admin/diwali?error=${encodeURIComponent(error.message)}`);
  }
};

// 9. Show Import Page
exports.showImport = async (req, res) => {
  try {
    const selectedEvent = await resolveSelectedEvent(req);
    const allEvents = await diwaliService.getAllEvents();

    res.render("diwali/import", {
      pageTitle: `Import Diwali Excel — ${selectedEvent.name}`,
      page: "diwali",
      selectedEvent,
      allEvents
    });
  } catch (error) {
    res.status(500).send("Error loading import page: " + error.message);
  }
};

// 10. Preview Import (via Excel file upload)
exports.previewImport = async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res
        .status(400)
        .json({ success: false, error: "Please select an Excel file (.xlsx or .xls) to upload." });
    }

    const previewData = await diwaliImportService.parseExcelBuffer(req.file.buffer);
    res.json({ success: true, ...previewData });
  } catch (error) {
    console.error("Error parsing Excel import:", error);
    res.status(400).json({ success: false, error: "Failed to parse Excel file: " + error.message });
  }
};

// 11. Confirm Import
exports.confirmImport = async (req, res) => {
  try {
    const selectedEvent = await resolveSelectedEvent(req);
    const { participants } = req.body;

    const result = await diwaliImportService.commitImport(selectedEvent.id, participants);

    await activityService.log(
      req.session.admin,
      "DIWALI_EXCEL_IMPORTED",
      `Imported ${result.createdParticipantsCount} pairs and ${result.createdBhajansCount} bhajans into ${selectedEvent.name}.`
    );

    res.json({ success: true, ...result });
  } catch (error) {
    console.error("Error committing import:", error);
    res.status(400).json({ success: false, error: error.message });
  }
};

// 12. Export Yearly Data
exports.exportYearly = async (req, res) => {
  try {
    const selectedEvent = await resolveSelectedEvent(req);
    const format = req.query.format || "excel"; // "excel", "pdf"
    const category = req.query.category || "Both"; // "Gents", "Ladies", "Both"

    await activityService.log(
      req.session.admin,
      "DIWALI_YEARLY_EXPORT",
      `Exported yearly Diwali data for ${selectedEvent.name} as ${format.toUpperCase()} (${category}).`
    );

    if (format === "pdf") {
      const pdfBuffer = await diwaliExportService.generateYearlyPdf(selectedEvent, { category });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="Diwali_Bhajans_${selectedEvent.year}.pdf"`
      );
      return res.send(pdfBuffer);
    } else {
      const excelBuffer = await diwaliExportService.generateYearlyExcel(selectedEvent, {
        category
      });
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="Diwali_Bhajans_${selectedEvent.year}.xlsx"`
      );
      return res.send(excelBuffer);
    }
  } catch (error) {
    console.error("Error exporting yearly data:", error);
    res.status(500).send("Error exporting yearly data: " + error.message);
  }
};

// 13. Make Sequence
exports.makeSequence = async (req, res) => {
  try {
    const selectedEvent = await resolveSelectedEvent(req);
    const { numSequences, categories } = req.body;

    const result = await diwaliService.generateFairSequences(selectedEvent.id, numSequences, {
      categories: categories || ["Gents", "Ladies"]
    });

    await activityService.log(
      req.session.admin,
      "DIWALI_SEQUENCE_GENERATED",
      `Generated ${numSequences} fair sequences for ${selectedEvent.name}. Total bhajans: ${result.fairnessSummary.totalBhajans}.`
    );

    res.json({ success: true, ...result });
  } catch (error) {
    console.error("Error generating sequences:", error);
    res.status(400).json({ success: false, error: error.message });
  }
};

// 14. Sequence Editor View
exports.showSequenceEditor = async (req, res) => {
  try {
    const selectedEvent = await resolveSelectedEvent(req);
    const allEvents = await diwaliService.getAllEvents();
    const sequences = await diwaliService.getFullSequences(selectedEvent.id);

    res.render("diwali/sequence-editor", {
      pageTitle: `Sequence Editor — ${selectedEvent.name}`,
      page: "diwali",
      selectedEvent,
      allEvents,
      sequences
    });
  } catch (error) {
    console.error("Error loading sequence editor:", error);
    res.status(500).send("Error loading sequence editor: " + error.message);
  }
};

// 15. Save Sequence Order / Move
exports.saveSequenceOrder = async (req, res) => {
  try {
    const { sequenceId, orderedEntryIds } = req.body;
    await diwaliService.updateSequenceEntriesOrder(sequenceId, orderedEntryIds);

    await activityService.log(
      req.session.admin,
      "DIWALI_SEQUENCE_EDITED",
      `Reordered sequence ${sequenceId}.`
    );

    res.json({ success: true });
  } catch (error) {
    console.error("Error saving sequence order:", error);
    res.status(400).json({ success: false, error: error.message });
  }
};

// 16. Move Bhajan between sequences
exports.moveSequenceEntry = async (req, res) => {
  try {
    const { entryId, targetSequenceId, targetOrder } = req.body;
    await diwaliService.moveEntryToAnotherSequence(entryId, targetSequenceId, targetOrder);

    await activityService.log(
      req.session.admin,
      "DIWALI_SEQUENCE_EDITED",
      `Moved sequence entry ${entryId} to sequence ${targetSequenceId}.`
    );

    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

// 17. Assign Sequence Date
exports.assignDate = async (req, res) => {
  try {
    const { sequenceId, assignedDate } = req.body;
    const seq = await diwaliService.assignSequenceDate(sequenceId, assignedDate);
    res.json({ success: true, sequence: seq });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

// 18. Finalize Sequence
exports.finalizeSequence = async (req, res) => {
  try {
    const seq = await diwaliService.finalizeSequence(req.params.id);
    await activityService.log(
      req.session.admin,
      "DIWALI_SEQUENCE_FINALIZED",
      `Finalized sequence ${seq.sequence_number}.`
    );
    res.json({ success: true, sequence: seq });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

// 19. Export Sequences
exports.exportSequence = async (req, res) => {
  try {
    const selectedEvent = await resolveSelectedEvent(req);
    const format = req.query.format || "excel"; // "excel", "pdf"
    const sequenceId = req.query.sequenceId ? parseInt(req.query.sequenceId, 10) : null;
    const category = req.query.category || "Both";

    await activityService.log(
      req.session.admin,
      "DIWALI_SEQUENCE_EXPORT",
      `Exported sequences for ${selectedEvent.name} as ${format.toUpperCase()} (Scope: ${sequenceId ? `Seq ${sequenceId}` : "All"}).`
    );

    const filename = sequenceId
      ? `Diwali_${selectedEvent.year}_Sequence_${sequenceId}`
      : `Diwali_${selectedEvent.year}_All_Sequences`;

    if (format === "pdf") {
      const pdfBuffer = await diwaliExportService.generateSequencePdf(selectedEvent, {
        sequenceId,
        category
      });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}.pdf"`);
      return res.send(pdfBuffer);
    } else {
      const excelBuffer = await diwaliExportService.generateSequenceExcel(selectedEvent, {
        sequenceId,
        category
      });
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.setHeader("Content-Disposition", `attachment; filename="${filename}.xlsx"`);
      return res.send(excelBuffer);
    }
  } catch (error) {
    console.error("Error exporting sequence:", error);
    res.status(500).send("Error exporting sequence: " + error.message);
  }
};

// 20. Search Master Bhajans (Autocomplete API)
exports.searchMasterBhajans = async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    const gender = (req.query.gender || "Gents").trim();
    if (!q || q.length < 2) {
      return res.json([]);
    }

    const tokens = q.split(/\s+/).filter(Boolean);
    const likeConditions = tokens.map((tok) => ({
      title: { [Op.like]: `%${tok}%` }
    }));

    const bhajans = await MasterBhajan.findAll({
      where: {
        is_active: true,
        [Op.and]: likeConditions
      },
      limit: 15,
      order: [["title", "ASC"]]
    });

    const results = [];
    for (const b of bhajans) {
      let scale = calculateScaleForGender(b, gender);
      if (!scale) {
        const cleanTitle = b.title.replace(/\s*\(\d+\)$/, "").trim();
        const targetGender = gender === "Ladies" || gender === "Female" ? "Female" : "Male";
        const prev = await BhajanSubmission.findOne({
          where: {
            title: { [Op.or]: [{ [Op.like]: b.title }, { [Op.like]: cleanTitle }] },
            scale: { [Op.and]: [{ [Op.ne]: null }, { [Op.ne]: "" }, { [Op.ne]: "Not specified" }] },
            [Op.or]: [{ gender: targetGender }, { gender: gender }]
          },
          order: [["created_at", "DESC"]],
          attributes: ["scale"]
        });
        if (prev && prev.scale) scale = prev.scale.trim();

        if (!scale) {
          const diwaliPrev = await DiwaliParticipantBhajan.findOne({
            where: {
              bhajan_title: { [Op.or]: [{ [Op.like]: b.title }, { [Op.like]: cleanTitle }] },
              scale: { [Op.and]: [{ [Op.ne]: null }, { [Op.ne]: "" }] }
            },
            include: [
              {
                model: DiwaliParticipant,
                as: "participant",
                where: { gender: gender === "Ladies" || gender === "Female" ? "Ladies" : "Gents" }
              }
            ],
            order: [["created_at", "DESC"]]
          });
          if (diwaliPrev && diwaliPrev.scale) scale = diwaliPrev.scale.trim();
        }
      }

      results.push({
        id: b.id,
        title: b.title,
        deity: b.deity || "",
        tempo: b.tempo || "",
        shruti: b.shruti || "",
        shruti_female: b.shruti_female || "",
        genderScale: scale || ""
      });
    }

    res.json(results);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.calculateScaleForGender = calculateScaleForGender;
exports.femaleFallbackShruti = femaleFallbackShruti;
