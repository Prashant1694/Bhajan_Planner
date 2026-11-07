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
    const single = await getSingleSequence(sequenceId, event.id);
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
    const sequenceLabel = seq.sequence_type === "Manual" ? `Manual Sequence ${seq.sequence_number}` : `Sequence ${seq.sequence_number}`;
    const sheetName = sequenceLabel.slice(0, 31);
    const sheet = workbook.addWorksheet(sheetName);

    const dateStr = seq.assigned_date ? ` (Date: ${seq.assigned_date})` : "";
    sheet.addRow([
      `DIWALI BHAJANS — ${event.name.toUpperCase()} — ${sequenceLabel.toUpperCase()}${dateStr}`
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
    const single = await getSingleSequence(sequenceId, event.id);
    if (single) sequences.push(single);
  } else {
    sequences = await getFullSequences(event.id);
  }

  return new Promise((resolve, reject) => {
    try {
      // Use the same landscape, letterhead-led visual language as the
      // Thursday Live Bhajan Plan print stylesheet.
      const doc = new PDFDocument({
        size: "A4",
        layout: "landscape",
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        autoFirstPage: false
      });
      const buffers = [];
      doc.on("data", (buffer) => buffers.push(buffer));
      doc.on("end", () => resolve(Buffer.concat(buffers)));
      doc.on("error", reject);

      const PAGE_W = 841.89;
      const PAGE_H = 595.28;
      const LEFT = 28;
      const RIGHT = PAGE_W - 28;
      const CONTENT_W = RIGHT - LEFT;
      const MAROON = "#7d2f45";
      const GOLD = "#d98a2b";
      const INK = "#1e293b";
      const MUTED = "#64748b";
      const BORDER = "#ebdccb";
      const CREAM = "#fcf8f2";
      const LOGO_PATH = require("path").join(__dirname, "../public/images/logo.png");
      const hasLogo = require("fs").existsSync(LOGO_PATH);

      const columns = [
        { label: "#", width: 34, align: "center" },
        { label: "Lead Singer", width: 105 },
        { label: "Partner", width: 105 },
        { label: "Bhajan", width: 220, bold: true },
        { label: "Pitch / Scale", width: 58, align: "center" },
        { label: "Tabla Shruti", width: 75, align: "center" },
        { label: "Deity", width: 85 },
        { label: "Remarks", width: 103 }
      ];
      const tableX = LEFT;
      const tableW = columns.reduce((sum, column) => sum + column.width, 0);
      let cursorX = tableX;
      columns.forEach((column) => {
        column.x = cursorX;
        cursorX += column.width;
      });

      const filteredEntries = (seq) => {
        const entries = seq.entries || [];
        if (category === "Gents") {
          return entries.filter((entry) =>
            entry.participantBhajan?.participant?.gender === "Gents"
          );
        }
        if (category === "Ladies") {
          return entries.filter((entry) =>
            entry.participantBhajan?.participant?.gender === "Ladies"
          );
        }
        return entries;
      };

      const drawSequencePage = (seq, sequenceIndex) => {
        const sequenceLabel = seq.sequence_type === "Manual"
          ? \`Manual Sequence \${seq.sequence_number}\`
          : \`Sequence \${seq.sequence_number}\`;
        const entries = filteredEntries(seq);
        const pageTop = 18;

        doc.addPage({ size: "A4", layout: "landscape", margins: 0 });

        // Organisation letterhead, matching the Thursday session printout.
        if (hasLogo) {
          try {
            doc.image(LOGO_PATH, LEFT, pageTop, { fit: [54, 54], align: "center", valign: "center" });
          } catch (logoError) {
            console.warn("Diwali PDF logo could not be embedded:", logoError.message);
          }
        }
        const letterX = hasLogo ? LEFT + 64 : LEFT;
        const letterW = RIGHT - letterX;
        doc.fillColor(MAROON).font("Times-Bold").fontSize(10)
          .text("|| AUM SRI SAI RAM ||", letterX, pageTop + 1, {
            width: letterW, align: "center", lineBreak: false
          });
        doc.fillColor(INK).font("Helvetica-Bold").fontSize(12)
          .text("SRI SATHYA SAI SEVA ORGANISATION, GANDHINAGAR", letterX, pageTop + 17, {
            width: letterW, align: "center", lineBreak: false, ellipsis: true
          });
        doc.fillColor(MUTED).font("Helvetica").fontSize(7.2)
          .text("Satyadeep, 20, Gayatri Society, Vasna Hadmatiya, Sargasan, Gandhinagar - 382015", letterX, pageTop + 34, {
            width: letterW, align: "center", lineBreak: false, ellipsis: true
          });
        doc.text("Email: ssso.gandhinagar@gmail.com  •  Helpline: +91 9265056242", letterX, pageTop + 45, {
          width: letterW, align: "center", lineBreak: false
        });

        const dividerY = pageTop + 65;
        doc.rect(LEFT, dividerY, CONTENT_W, 3).fill(MAROON);
        doc.rect(LEFT, dividerY + 4, CONTENT_W, 1.5).fill(GOLD);

        // Print-session banner: warm ivory background and maroon left rule.
        const bannerY = dividerY + 13;
        const bannerH = 42;
        doc.roundedRect(LEFT, bannerY, CONTENT_W, bannerH, 3)
          .fillAndStroke(CREAM, "#e6dcd0");
        doc.rect(LEFT, bannerY, 4, bannerH).fill(MAROON);
        doc.fillColor(MAROON).font("Helvetica-Bold").fontSize(11)
          .text(\`DIWALI BHAJANS  •  \${String(event.name || "").toUpperCase()}\`, LEFT + 12, bannerY + 7, {
            width: CONTENT_W - 24, lineBreak: false, ellipsis: true
          });
        const dateText = seq.assigned_date ? \`  •  Date: \${seq.assigned_date}\` : "";
        doc.fillColor(GOLD).font("Helvetica-Bold").fontSize(9)
          .text(\`\${sequenceLabel.toUpperCase()}\${dateText}\`, LEFT + 12, bannerY + 24, {
            width: CONTENT_W - 24, lineBreak: false, ellipsis: true
          });

        // Accompanist strip.
        const musicianY = bannerY + bannerH + 8;
        const musicianH = 26;
        doc.roundedRect(LEFT, musicianY, CONTENT_W, musicianH, 3)
          .fill("#f8fafc").stroke("#e2e8f0");
        doc.fillColor(INK).font("Helvetica-Bold").fontSize(8.5)
          .text("HARMONIUM", LEFT + 10, musicianY + 9, { lineBreak: false });
        doc.font("Helvetica").fontSize(8.5)
          .text(seq.harmonium_player || "Not assigned", LEFT + 78, musicianY + 9, {
            width: 250, lineBreak: false, ellipsis: true
          });
        doc.font("Helvetica-Bold")
          .text("TABLA", LEFT + 400, musicianY + 9, { lineBreak: false });
        doc.font("Helvetica")
          .text(seq.tabla_player || "Not assigned", LEFT + 445, musicianY + 9, {
            width: CONTENT_W - 455, lineBreak: false, ellipsis: true
          });

        // Reserve a footer and calculate row height from the actual entry
        // count. Typical sequences get generous spacing; large sequences
        // shrink proportionally so the complete sequence remains on one page.
        const tableHeaderY = musicianY + musicianH + 10;
        const tableHeaderH = 25;
        const footerY = PAGE_H - 23;
        const rowsTop = tableHeaderY + tableHeaderH;
        const rowsAvailable = Math.max(0, footerY - rowsTop - 8);
        const rowH = entries.length
          ? Math.max(7.5, Math.min(34, rowsAvailable / entries.length))
          : 30;
        const fontSize = Math.max(5.2, Math.min(8.8, rowH * 0.29));
        const verticalInset = Math.max(1.5, (rowH - fontSize) / 2 - 1);

        // Table heading uses the same maroon/gold treatment as Thursday export.
        doc.rect(tableX, tableHeaderY, tableW, tableHeaderH).fill(MAROON);
        doc.rect(tableX, tableHeaderY + tableHeaderH - 2, tableW, 2).fill(GOLD);
        columns.forEach((column) => {
          doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(7.3)
            .text(column.label.toUpperCase(), column.x + 3, tableHeaderY + 8, {
              width: column.width - 6, align: column.align || "left",
              lineBreak: false, ellipsis: true
            });
        });

        if (!entries.length) {
          doc.rect(tableX, rowsTop, tableW, rowH).fill("#fdfbf7");
          doc.fillColor(MUTED).font("Helvetica").fontSize(9)
            .text("No bhajans are assigned to this sequence for the selected category.", tableX + 8, rowsTop + 10, {
              width: tableW - 16, align: "center", lineBreak: false
            });
        } else {
          entries.forEach((entry, index) => {
            const b = entry.participantBhajan || {};
            const participant = b.participant || {};
            const rowY = rowsTop + index * rowH;
            const rowBottom = rowY + rowH;

            doc.rect(tableX, rowY, tableW, rowH)
              .fill(index % 2 === 0 ? "#ffffff" : "#fdfbf7");
            doc.strokeColor(BORDER).lineWidth(0.45)
              .moveTo(tableX, rowBottom).lineTo(tableX + tableW, rowBottom).stroke();

            const values = [
              String(index + 1),
              participant.lead_name || "-",
              participant.partner_name || "-",
              b.bhajan_title || "-",
              b.scale || "-",
              b.tabla || "-",
              b.deity || "-",
              b.remarks || ""
            ];

            columns.forEach((column, colIndex) => {
              doc.fillColor(INK)
                .font(colIndex === 3 ? "Helvetica-Bold" : "Helvetica")
                .fontSize(fontSize)
                .text(String(values[colIndex]), column.x + 4, rowY + verticalInset, {
                  width: column.width - 8,
                  height: Math.max(6, rowH - verticalInset),
                  align: column.align || "left",
                  lineBreak: false,
                  ellipsis: true
                });
            });
          });
        }

        // Vertical separators and a restrained table outline.
        let separatorX = tableX;
        columns.slice(0, -1).forEach((column) => {
          separatorX += column.width;
          doc.strokeColor("#eadfD3").lineWidth(0.35)
            .moveTo(separatorX, tableHeaderY)
            .lineTo(separatorX, rowsTop + entries.length * rowH)
            .stroke();
        });
        doc.strokeColor("#d8c7b7").lineWidth(0.8)
          .rect(tableX, tableHeaderY, tableW, tableHeaderH + entries.length * rowH)
          .stroke();

        // Footer remains on this sequence's page; no continuation pages.
        doc.strokeColor(GOLD).lineWidth(1)
          .moveTo(LEFT, footerY - 5).lineTo(RIGHT, footerY - 5).stroke();
        doc.fillColor(MAROON).font("Times-Italic").fontSize(8)
          .text("Love All • Serve All", LEFT, footerY, {
            width: CONTENT_W, align: "center", lineBreak: false
          });
      };

      if (!sequences.length) {
        doc.addPage({ size: "A4", layout: "landscape", margins: 0 });
        doc.fillColor(MAROON).font("Times-Bold").fontSize(12)
          .text("|| AUM SRI SAI RAM ||", LEFT, 35, { width: CONTENT_W, align: "center" });
        doc.fillColor(INK).font("Helvetica-Bold").fontSize(15)
          .text(\`DIWALI BHAJANS — \${String(event.name || "").toUpperCase()}\`, LEFT, 60, {
            width: CONTENT_W, align: "center"
          });
        doc.fillColor(MUTED).font("Helvetica").fontSize(11)
          .text("No sequences have been generated yet for this Diwali event.", LEFT, 110, {
            width: CONTENT_W, align: "center"
          });
      } else {
        sequences.forEach((seq, index) => drawSequencePage(seq, index));
      }

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

module.exports = {
  generateYearlyExcel,
  generateYearlyPdf,
  generateSequenceExcel,
  generateSequencePdf
};
