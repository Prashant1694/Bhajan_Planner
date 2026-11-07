const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");
const { getFlatBhajanRows, getFullSequences, getSingleSequence } = require("./diwaliService");

// Helper to auto-fit Excel column widths in ExcelJS
function autoFitWorksheetColumns(worksheet) {
  worksheet.columns.forEach((column) => {
    let maxLen = 10;
    column.eachCell({ includeEmpty: false }, (cell) => {
      const val = cell.value ? String(cell.value) : "";
      if (val.length > maxLen) {
        maxLen = Math.min(val.length + 2, 40);
      }
    });
    column.width = maxLen;
  });
}

// ============================================================
// 1. YEARLY DATA EXPORT (EXCEL)
// ============================================================

async function generateYearlyExcel(event, options = {}) {
  const category = options.category || "Both"; // "Gents", "Ladies", "Both"
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Bhajan Scheduler";
  workbook.created = new Date();

  const headers = [
    "Sr.",
    "Name",
    "Lead Singer",
    "Partner",
    "Bhajan",
    "Scale",
    "Tabla Shruti",
    "Deity",
    "Remarks"
  ];

  function formatBhajanRow(sr, b) {
    const lead = b.participant?.lead_name || "";
    const partner = b.participant?.partner_name || "";
    const pairName = lead && partner ? `${lead} + ${partner}` : lead || partner || "";
    return [
      sr,
      pairName,
      lead,
      partner,
      b.bhajan_title || "",
      b.scale || "",
      b.tabla || "",
      b.deity || "",
      b.remarks || ""
    ];
  }

  // 1. Consolidated "Total Data" sheet
  if (category === "Both") {
    const gentsBhajans = await getFlatBhajanRows(event.id, { gender: "Gents" });
    const ladiesBhajans = await getFlatBhajanRows(event.id, { gender: "Ladies" });

    const totalSheet = workbook.addWorksheet("Total Data");
    totalSheet.addRow([`DIWALI BHAJANS — ${event.name.toUpperCase()} (TOTAL YEARLY DATA)`]);
    totalSheet.addRow([]);

    // Gents Section
    totalSheet.addRow(["Gents"]);
    totalSheet.addRow([]);
    totalSheet.addRow(headers);
    let gSr = 1;
    for (const b of gentsBhajans) {
      totalSheet.addRow(formatBhajanRow(gSr++, b));
    }

    // Space before Ladies
    totalSheet.addRow([]);
    totalSheet.addRow([]);

    // Ladies Section
    totalSheet.addRow(["Ladies"]);
    totalSheet.addRow([]);
    totalSheet.addRow(headers);
    let lSr = 1;
    for (const b of ladiesBhajans) {
      totalSheet.addRow(formatBhajanRow(lSr++, b));
    }

    autoFitWorksheetColumns(totalSheet);
  }

  // 2. Individual Category Sheets
  async function createCategorySheet(genderName) {
    const bhajans = await getFlatBhajanRows(event.id, { gender: genderName });
    const sheet = workbook.addWorksheet(genderName);

    sheet.addRow([`DIWALI BHAJANS — ${event.name.toUpperCase()} (${genderName.toUpperCase()})`]);
    sheet.addRow([]);
    sheet.addRow(headers);

    let sr = 1;
    for (const b of bhajans) {
      sheet.addRow(formatBhajanRow(sr++, b));
    }

    autoFitWorksheetColumns(sheet);
  }

  if (category === "Gents" || category === "Both") {
    await createCategorySheet("Gents");
  }
  if (category === "Ladies" || category === "Both") {
    await createCategorySheet("Ladies");
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

// ============================================================
// 2. YEARLY DATA EXPORT (PDF)
// ============================================================

async function generateYearlyPdf(event, options = {}) {
  const category = options.category || "Both";

  let gentsBhajans = [];
  let ladiesBhajans = [];
  if (category === "Both" || category === "Gents") {
    gentsBhajans = await getFlatBhajanRows(event.id, { gender: "Gents" });
  }
  if (category === "Both" || category === "Ladies") {
    ladiesBhajans = await getFlatBhajanRows(event.id, { gender: "Ladies" });
  }

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "A4",
        layout: "landscape",
        margins: { top: 30, bottom: 30, left: 30, right: 30 }
      });

      const buffers = [];
      doc.on("data", (b) => buffers.push(b));
      doc.on("end", () => resolve(Buffer.concat(buffers)));
      doc.on("error", reject);

      const colX = [30, 65, 175, 285, 485, 550, 630, 700];
      const colWidths = [35, 110, 110, 200, 65, 80, 70, 80];
      const colHeaders = [
        "Sr.",
        "Lead Singer",
        "Partner",
        "Bhajan",
        "Scale",
        "Tabla Shruti",
        "Deity",
        "Remarks"
      ];

      const renderTableHeader = () => {
        doc.rect(30, doc.y, 750, 20).fill("#f8f4ed");
        doc.fillColor("#221e2a").font("Helvetica-Bold").fontSize(9);
        const curY = doc.y + 5;
        for (let i = 0; i < colHeaders.length; i++) {
          doc.text(colHeaders[i], colX[i] + 2, curY, { width: colWidths[i] - 4, ellipsis: true });
        }
        doc.y += 20;
        doc.font("Helvetica").fontSize(8.5);
      };

      const renderSection = (title, items) => {
        doc
          .fontSize(15)
          .fillColor("#7d2f45")
          .font("Helvetica-Bold")
          .text(`DIWALI BHAJANS — ${event.name.toUpperCase()} — ${title.toUpperCase()}`, {
            align: "center"
          });
        doc.moveDown(0.4);

        if (items.length === 0) {
          doc
            .fontSize(11)
            .fillColor("#666666")
            .font("Helvetica")
            .text(`No ${title.toLowerCase()} participants registered yet.`, { align: "center" });
          return;
        }

        renderTableHeader();

        let sr = 1;
        for (const b of items) {
          if (doc.y > 520) {
            doc.addPage();
            doc
              .fontSize(12)
              .fillColor("#7d2f45")
              .font("Helvetica-Bold")
              .text(
                `DIWALI BHAJANS — ${event.name.toUpperCase()} — ${title.toUpperCase()} (Continued)`,
                { align: "center" }
              );
            doc.moveDown(0.3);
            renderTableHeader();
          }

          const lead = b.participant?.lead_name || "-";
          const partner = b.participant?.partner_name || "-";
          const rowY = doc.y;

          if (sr % 2 === 0) {
            doc.rect(30, rowY - 2, 750, 18).fill("#fcfbf8");
          }

          doc.fillColor("#221e2a");
          doc.text(String(sr++), colX[0] + 2, rowY, { width: colWidths[0] - 4 });
          doc.text(lead, colX[1] + 2, rowY, { width: colWidths[1] - 4, ellipsis: true });
          doc.text(partner, colX[2] + 2, rowY, { width: colWidths[2] - 4, ellipsis: true });
          doc
            .font("Helvetica-Bold")
            .text(b.bhajan_title || "-", colX[3] + 2, rowY, {
              width: colWidths[3] - 4,
              ellipsis: true
            })
            .font("Helvetica");
          doc.text(b.scale || "-", colX[4] + 2, rowY, { width: colWidths[4] - 4, ellipsis: true });
          doc.text(b.tabla || "-", colX[5] + 2, rowY, { width: colWidths[5] - 4, ellipsis: true });
          doc.text(b.deity || "-", colX[6] + 2, rowY, { width: colWidths[6] - 4, ellipsis: true });
          doc.text(b.remarks || "", colX[7] + 2, rowY, { width: colWidths[7] - 4, ellipsis: true });

          doc
            .strokeColor("#e7e0d2")
            .lineWidth(0.5)
            .moveTo(30, rowY + 16)
            .lineTo(780, rowY + 16)
            .stroke();
          doc.y = rowY + 18;
        }
      };

      if (category === "Both") {
        renderSection("Gents", gentsBhajans);
        doc.addPage();
        renderSection("Ladies", ladiesBhajans);
      } else if (category === "Gents") {
        renderSection("Gents", gentsBhajans);
      } else if (category === "Ladies") {
        renderSection("Ladies", ladiesBhajans);
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ============================================================
// 3. SEQUENCE EXPORT (EXCEL)
// ============================================================

async function generateSequenceExcel(event, options = {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Bhajan Scheduler";
  workbook.created = new Date();

  const sequenceId = options.sequenceId;
  const category = options.category || "Both";

  let sequences = [];
  if (sequenceId) {
    const single = await getSingleSequence(sequenceId);
    if (single) sequences.push(single);
  } else {
    sequences = await getFullSequences(event.id);
  }

  const headers = [
    "Sr.",
    "Sequence",
    "Gender",
    "Lead Singer",
    "Partner",
    "Bhajan",
    "Scale",
    "Tabla Shruti",
    "Deity",
    "Remarks"
  ];

  for (const seq of sequences) {
    const sheetName = `Sequence ${seq.sequence_number}`.slice(0, 31);
    const sheet = workbook.addWorksheet(sheetName);

    const dateStr = seq.assigned_date ? ` (Date: ${seq.assigned_date})` : "";
    sheet.addRow([
      `DIWALI BHAJANS — ${event.name.toUpperCase()} — SEQUENCE ${seq.sequence_number}${dateStr}`
    ]);
    sheet.addRow([
      "Harmonium Player",
      seq.harmonium_player || "Not assigned",
      "Tabla Player",
      seq.tabla_player || "Not assigned"
    ]);
    sheet.addRow([]);
    sheet.addRow(headers);

    let filteredEntries = seq.entries || [];
    if (category === "Gents") {
      filteredEntries = filteredEntries.filter(
        (e) => e.participantBhajan?.participant?.gender === "Gents"
      );
    } else if (category === "Ladies") {
      filteredEntries = filteredEntries.filter(
        (e) => e.participantBhajan?.participant?.gender === "Ladies"
      );
    }

    let sr = 1;
    for (const entry of filteredEntries) {
      const b = entry.participantBhajan || {};
      const p = b.participant || {};
      sheet.addRow([
        sr++,
        `Seq ${seq.sequence_number}`,
        p.gender || "",
        p.lead_name || "",
        p.partner_name || "",
        b.bhajan_title || "",
        b.scale || "",
        b.tabla || "",
        b.deity || "",
        b.remarks || ""
      ]);
    }

    autoFitWorksheetColumns(sheet);
  }

  if (sequences.length === 0) {
    const noticeSheet = workbook.addWorksheet("Notice");
    noticeSheet.addRow([`DIWALI BHAJANS — ${event.name.toUpperCase()}`]);
    noticeSheet.addRow([]);
    noticeSheet.addRow([
      "No sequences have been generated yet. Please click 'Make Sequence' on the dashboard first."
    ]);
    autoFitWorksheetColumns(noticeSheet);
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

// ============================================================
// 4. SEQUENCE EXPORT (PDF)
// ============================================================

async function generateSequencePdf(event, options = {}) {
  const sequenceId = options.sequenceId;
  const category = options.category || "Both";

  let sequences = [];
  if (sequenceId) {
    const single = await getSingleSequence(sequenceId);
    if (single) sequences.push(single);
  } else {
    sequences = await getFullSequences(event.id);
  }

  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "A4",
        layout: "landscape",
        margins: { top: 30, bottom: 30, left: 30, right: 30 }
      });

      const buffers = [];
      doc.on("data", (b) => buffers.push(b));
      doc.on("end", () => resolve(Buffer.concat(buffers)));
      doc.on("error", reject);

      const colX = [30, 65, 175, 285, 485, 550, 630, 700];
      const colWidths = [35, 110, 110, 200, 65, 80, 70, 80];
      const colHeaders = [
        "Sr.",
        "Lead Singer",
        "Partner",
        "Bhajan",
        "Scale",
        "Tabla Shruti",
        "Deity",
        "Remarks"
      ];

      const renderTableHeader = () => {
        doc.rect(30, doc.y, 750, 20).fill("#f8f4ed");
        doc.fillColor("#221e2a").font("Helvetica-Bold").fontSize(9);
        const curY = doc.y + 5;
        for (let i = 0; i < colHeaders.length; i++) {
          doc.text(colHeaders[i], colX[i] + 2, curY, { width: colWidths[i] - 4, ellipsis: true });
        }
        doc.y += 20;
        doc.font("Helvetica").fontSize(8.5);
      };

      if (sequences.length === 0) {
        doc
          .fontSize(16)
          .fillColor("#7d2f45")
          .font("Helvetica-Bold")
          .text(`DIWALI BHAJANS — ${event.name.toUpperCase()}`, { align: "center" });
        doc.moveDown(1);
        doc
          .fontSize(12)
          .fillColor("#666666")
          .font("Helvetica")
          .text("No sequences have been generated yet for this Diwali event.", { align: "center" });
        doc.moveDown(0.5);
        doc
          .fontSize(10)
          .fillColor("#999999")
          .text("Please click 'Make Sequence' on the dashboard first to create fair sequences.", {
            align: "center"
          });
        doc.end();
        return;
      }

      for (let sIdx = 0; sIdx < sequences.length; sIdx++) {
        const seq = sequences[sIdx];
        if (sIdx > 0) doc.addPage();

        // Sequence Header
        doc
          .fontSize(16)
          .fillColor("#7d2f45")
          .font("Helvetica-Bold")
          .text(`DIWALI BHAJANS — ${event.name.toUpperCase()}`, { align: "center" });
        doc.moveDown(0.2);

        const dateText = seq.assigned_date ? `  |  Date: ${seq.assigned_date}` : "";
        doc
          .fontSize(13)
          .fillColor("#d98a2b")
          .font("Helvetica-Bold")
          .text(`SEQUENCE ${seq.sequence_number}${dateText}`, { align: "center" });
        doc.moveDown(0.25);
        doc
          .fontSize(9)
          .fillColor("#444444")
          .font("Helvetica")
          .text(
            `Harmonium: ${seq.harmonium_player || "Not assigned"}  |  Tabla: ${seq.tabla_player || "Not assigned"}`,
            { align: "center" }
          );
        doc.moveDown(0.5);

        let entries = seq.entries || [];
        if (category === "Gents") {
          entries = entries.filter((e) => e.participantBhajan?.participant?.gender === "Gents");
        } else if (category === "Ladies") {
          entries = entries.filter((e) => e.participantBhajan?.participant?.gender === "Ladies");
        }

        renderTableHeader();

        let sr = 1;
        for (const entry of entries) {
          if (doc.y > 520) {
            doc.addPage();
            doc
              .fontSize(12)
              .fillColor("#7d2f45")
              .font("Helvetica-Bold")
              .text(`SEQUENCE ${seq.sequence_number} (Continued)`, { align: "center" });
            doc.moveDown(0.3);
            renderTableHeader();
          }

          const b = entry.participantBhajan || {};
          const p = b.participant || {};
          const rowY = doc.y;

          if (sr % 2 === 0) {
            doc.rect(30, rowY - 2, 750, 18).fill("#fcfbf8");
          }

          doc.fillColor("#221e2a");
          doc.text(String(sr++), colX[0] + 2, rowY, { width: colWidths[0] - 4 });
          doc.text(p.lead_name || "-", colX[1] + 2, rowY, {
            width: colWidths[1] - 4,
            ellipsis: true
          });
          doc.text(p.partner_name || "-", colX[2] + 2, rowY, {
            width: colWidths[2] - 4,
            ellipsis: true
          });
          doc
            .font("Helvetica-Bold")
            .text(b.bhajan_title || "-", colX[3] + 2, rowY, {
              width: colWidths[3] - 4,
              ellipsis: true
            })
            .font("Helvetica");
          doc.text(b.scale || "-", colX[4] + 2, rowY, { width: colWidths[4] - 4, ellipsis: true });
          doc.text(b.tabla || "-", colX[5] + 2, rowY, { width: colWidths[5] - 4, ellipsis: true });
          doc.text(b.deity || "-", colX[6] + 2, rowY, { width: colWidths[6] - 4, ellipsis: true });
          doc.text(b.remarks || "", colX[7] + 2, rowY, { width: colWidths[7] - 4, ellipsis: true });

          doc
            .strokeColor("#e7e0d2")
            .lineWidth(0.5)
            .moveTo(30, rowY + 16)
            .lineTo(780, rowY + 16)
            .stroke();
          doc.y = rowY + 18;
        }
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = {
  generateYearlyExcel,
  generateYearlyPdf,
  generateSequenceExcel,
  generateSequencePdf
};
