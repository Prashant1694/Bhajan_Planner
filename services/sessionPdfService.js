const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");

const LOGO_LEFT_PATH = path.join(__dirname, "../public/images/logo.png");
const LOGO_RIGHT_PATH = path.join(__dirname, "../public/images/logo_birthday.png");

const PALETTE = {
  maroon: "#7d2f45",
  maroonDark: "#631e32",
  gold: "#d98a2b",
  ink: "#1e293b",
  inkSoft: "#475569",
  muted: "#64748b",
  cream: "#fcf8f2",
  stripe: "#fdfbf7",
  white: "#ffffff",
  border: "#e6dcd0",
  tableBorder: "#ebdccb",
  deityBg: "#fef3c7",
  deityBorder: "#f59e0b",
  deityText: "#92400e",
  scaleBg: "#ede9fe",
  scaleBorder: "#c4b5fd",
  scaleText: "#5b21b6",
  tempoSlowBg: "#ecfdf5",
  tempoSlowBorder: "#6ee7b7",
  tempoSlowText: "#065f46",
  tempoMedBg: "#eff6ff",
  tempoMedBorder: "#93c5fd",
  tempoMedText: "#1e40af",
  tempoFastBg: "#fff7ed",
  tempoFastBorder: "#fdba74",
  tempoFastText: "#9a3412",
  cueBg: "#f8fafc",
  cueBorder: "#e2e8f0"
};

function cleanText(value, fallback = "") {
  const s = String(value == null ? "" : value)
    .replace(/\s+/g, " ")
    .trim();
  return s || fallback;
}

function getTempoStyle(speed) {
  const s = cleanText(speed, "Medium").toLowerCase();
  if (s.includes("fast")) {
    return {
      bg: PALETTE.tempoFastBg,
      border: PALETTE.tempoFastBorder,
      text: PALETTE.tempoFastText
    };
  }
  if (s.includes("slow") && !s.includes("medium")) {
    return {
      bg: PALETTE.tempoSlowBg,
      border: PALETTE.tempoSlowBorder,
      text: PALETTE.tempoSlowText
    };
  }
  return {
    bg: PALETTE.tempoMedBg,
    border: PALETTE.tempoMedBorder,
    text: PALETTE.tempoMedText
  };
}

function measurePillSize(doc, text, maxW, fontSize = 7.4) {
  const label = cleanText(text);
  if (!label) return { label: "", pillW: 0, pillH: 0, textH: 0, innerW: 0, fitsSingleLine: true, padX: 5.5 };

  doc.font("Helvetica-Bold").fontSize(fontSize);
  const padX = 5.5;
  const padY = 3.2;
  const textW = doc.widthOfString(label);
  const pillW = Math.min(maxW, textW + padX * 2);
  const innerW = Math.max(12, pillW - padX * 2);
  const fitsSingleLine = textW <= innerW + 0.5;
  const textH = fitsSingleLine
    ? doc.currentLineHeight()
    : doc.heightOfString(label, { width: innerW });
  const pillH = Math.max(16, textH + padY * 2);
  return { label, pillW, pillH, textH, innerW, fitsSingleLine, padX };
}

function drawPill(doc, text, x, y, maxW, style, fontSize = 7.4) {
  const m = measurePillSize(doc, text, maxW, fontSize);
  if (!m.label) return 0;

  doc.roundedRect(x, y, m.pillW, m.pillH, 4).fillAndStroke(style.bg, style.border);
  doc
    .fillColor(style.text)
    .font("Helvetica-Bold")
    .fontSize(fontSize)
    .text(m.label, x + m.padX, y + (m.pillH - m.textH) / 2 + 0.3, {
      width: m.innerW,
      align: "center",
      lineBreak: !m.fitsSingleLine
    });

  return m.pillW;
}

/**
 * Generate a clean, elegant, balanced A4 Portrait PDF
 * for a Live Bhajan Plan session.
 */
function generateSessionPlanPdf({
  sessionDate,
  sessionDateHuman,
  planItems = []
}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "A4",
        layout: "portrait",
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        autoFirstPage: false,
        bufferPages: true,
        info: {
          Title: `Bhajan Schedule - ${cleanText(sessionDateHuman || sessionDate)}`,
          Author: "Sri Sathya Sai Seva Organisation, Gandhinagar",
          Subject: "Official Bhajan Order of Offerings"
        }
      });

      const buffers = [];
      doc.on("data", (chunk) => buffers.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(buffers)));
      doc.on("error", reject);

      // A4 Portrait: 595.28 x 841.89 pt with generous 38pt (~13.4mm) side margins
      const PAGE_W = 595.28;
      const PAGE_H = 841.89;
      const LEFT = 38;
      const RIGHT = PAGE_W - 38;
      const CONTENT_W = RIGHT - LEFT; // 519.28 pt
      const FOOTER_Y = PAGE_H - 52;
      const MAX_CONTENT_Y = FOOTER_Y - 14;

      const hasLeftLogo = fs.existsSync(LOGO_LEFT_PATH);
      const hasRightLogo = fs.existsSync(LOGO_RIGHT_PATH);

      const columns = [
        { key: "step", label: "#", width: 26, align: "center" },
        { key: "singer", label: "SINGER", width: 108, align: "left" },
        { key: "bhajan", label: "BHAJAN & RAAG", width: 151, align: "left" },
        { key: "deity", label: "DEITY", width: 88, align: "left" },
        { key: "scale", label: "PITCH / SCALE", width: 72, align: "left" },
        { key: "tempo", label: "TEMPO", width: 74.28, align: "left" }
      ];

      let cx = LEFT;
      columns.forEach((col) => {
        col.x = cx;
        cx += col.width;
      });

      const drawLetterhead = (isContinuation) => {
        const top = 30;
        if (!isContinuation) {
          const logoSize = 50;
          if (hasLeftLogo) {
            try {
              doc.image(LOGO_LEFT_PATH, LEFT, top, {
                fit: [logoSize, logoSize],
                align: "center",
                valign: "center"
              });
            } catch {
              // Ignore missing/unreadable emblem
            }
          }
          if (hasRightLogo) {
            try {
              doc.image(LOGO_RIGHT_PATH, RIGHT - logoSize, top, {
                fit: [logoSize, logoSize],
                align: "center",
                valign: "center"
              });
            } catch {
              // Ignore missing/unreadable emblem
            }
          }

          const centerX = LEFT + (hasLeftLogo ? 58 : 0);
          const centerW = RIGHT - (hasRightLogo ? 58 : 0) - centerX;

          doc
            .fillColor(PALETTE.maroon)
            .font("Times-Bold")
            .fontSize(10)
            .text("|| AUM SRI SAI RAM ||", centerX, top + 1, {
              width: centerW,
              align: "center",
              lineBreak: false
            });
          doc
            .fillColor(PALETTE.ink)
            .font("Helvetica-Bold")
            .fontSize(11.4)
            .text("SRI SATHYA SAI SEVA ORGANISATION, GANDHINAGAR", centerX, top + 16, {
              width: centerW,
              align: "center",
              lineBreak: false,
              ellipsis: true
            });
          doc
            .fillColor(PALETTE.inkSoft)
            .font("Helvetica")
            .fontSize(7.6)
            .text(
              "Satyadeep, 20, Gayatri Society, Vasna Hadmatiya, Sargasan, Gandhinagar - 382015",
              centerX,
              top + 32,
              { width: centerW, align: "center", lineBreak: false, ellipsis: true }
            );
          doc
            .fillColor(PALETTE.muted)
            .font("Helvetica-Bold")
            .fontSize(7.4)
            .text(
              "Email: ssso.gandhinagar@gmail.com  •  Helpline: +91 9265056242",
              centerX,
              top + 43,
              { width: centerW, align: "center", lineBreak: false, ellipsis: true }
            );

          const divY = top + 62;
          doc.rect(LEFT, divY, CONTENT_W, 2.5).fill(PALETTE.maroon);
          doc.rect(LEFT, divY + 4, CONTENT_W, 1.25).fill(PALETTE.gold);

          const bannerY = divY + 14;
          const bannerH = 44;
          doc.roundedRect(LEFT, bannerY, CONTENT_W, bannerH, 4).fillAndStroke(PALETTE.cream, PALETTE.border);
          doc.rect(LEFT, bannerY, 4.5, bannerH).fill(PALETTE.maroon);

          const dateLabel = cleanText(sessionDateHuman || sessionDate).toUpperCase();
          doc
            .fillColor(PALETTE.maroon)
            .font("Helvetica-Bold")
            .fontSize(11.2)
            .text(`BHAJAN SCHEDULE  •  ${dateLabel}`, LEFT + 14, bannerY + 9, {
              width: CONTENT_W - 28,
              lineBreak: false,
              ellipsis: true
            });
          doc
            .fillColor("#8c6038")
            .font("Helvetica-Bold")
            .fontSize(8.5)
            .text(
              `Official Order of Offerings  •  Total Scheduled Bhajans: ${planItems.length}`,
              LEFT + 14,
              bannerY + 26,
              { width: CONTENT_W - 28, lineBreak: false, ellipsis: true }
            );

          return bannerY + bannerH + 14;
        }

        // Compact continuation header on page 2+
        const dateLabel = cleanText(sessionDateHuman || sessionDate).toUpperCase();
        doc
          .fillColor(PALETTE.maroon)
          .font("Helvetica-Bold")
          .fontSize(9.5)
          .text(`BHAJAN SCHEDULE  •  ${dateLabel} (Continued)`, LEFT, top, {
            width: CONTENT_W,
            lineBreak: false,
            ellipsis: true
          });
        doc.rect(LEFT, top + 14, CONTENT_W, 1.5).fill(PALETTE.gold);
        return top + 24;
      };

      const TABLE_HEADER_H = 26;
      const CUE_BOX_H = 30;
      const CUE_GAP = 14;

      const drawTableHeader = (y) => {
        doc.rect(LEFT, y, CONTENT_W, TABLE_HEADER_H).fill(PALETTE.maroon);
        doc.rect(LEFT, y + TABLE_HEADER_H - 2, CONTENT_W, 2).fill(PALETTE.gold);

        columns.forEach((col) => {
          doc
            .fillColor(PALETTE.white)
            .font("Helvetica-Bold")
            .fontSize(7.8)
            .text(col.label, col.x + 6, y + 8.5, {
              width: col.width - 12,
              align: col.align || "left",
              lineBreak: false,
              ellipsis: true
            });
        });
        return y + TABLE_HEADER_H;
      };

      // Use slightly larger, generous typography for single-page schedules
      const isCompactCount = planItems.length > 14;
      const fontCfg = isCompactCount
        ? { main: 8.8, sub: 7.5, pill: 7.1, step: 9.5, padV: 7 }
        : { main: 9.6, sub: 8.1, pill: 7.3, step: 10.5, padV: 9 };

      const measureNaturalRowHeight = (item) => {
        doc.font("Helvetica-Bold").fontSize(fontCfg.main);
        let singerH = doc.heightOfString(cleanText(item.singerName, "-"), {
          width: columns[1].width - 12,
          lineGap: 1.3
        });
        if (item.partnerName) {
          doc.font("Helvetica").fontSize(fontCfg.sub);
          singerH +=
            2.5 +
            doc.heightOfString(`with ${cleanText(item.partnerName)}`, {
              width: columns[1].width - 12,
              lineGap: 1.1
            });
        }

        doc.font("Helvetica-Bold").fontSize(fontCfg.main);
        let bhajanH = doc.heightOfString(cleanText(item.title, "-"), {
          width: columns[2].width - 12,
          lineGap: 1.4
        });
        if (item.raga) {
          doc.font("Helvetica").fontSize(fontCfg.sub);
          bhajanH +=
            2.5 +
            doc.heightOfString(`Raag: ${cleanText(item.raga)}`, {
              width: columns[2].width - 12,
              lineGap: 1.1
            });
        }

        const deityLabel = cleanText(item.deity, "-").toUpperCase();
        const deityH = measurePillSize(doc, deityLabel, columns[3].width - 10, fontCfg.pill).pillH;

        const tempoLabel = cleanText(item.speed, "Medium");
        const tempoH = measurePillSize(doc, tempoLabel, columns[5].width - 10, fontCfg.pill).pillH;

        return Math.max(36, Math.max(singerH, bhajanH, deityH, tempoH, 18) + fontCfg.padV * 2);
      };

      const naturalHeights = planItems.map(measureNaturalRowHeight);
      const totalNaturalH = naturalHeights.reduce((sum, h) => sum + h, 0);

      // On Page 1, calculate exact space between table header and accompanist cue + footer
      const FIRST_PAGE_TABLE_TOP = 164; // top(30) + letterhead/div(62+14) + banner(44+14) = 164
      const FIRST_PAGE_ROWS_BUDGET = MAX_CONTENT_Y - (FIRST_PAGE_TABLE_TOP + TABLE_HEADER_H + CUE_GAP + CUE_BOX_H + 8);
      const fitsSinglePage = planItems.length > 0 && totalNaturalH <= FIRST_PAGE_ROWS_BUDGET;

      // Distribute extra vertical space proportionally on single-page schedules
      // so the table fills the page gracefully without awkward bottom whitespace.
      let rowHeights = naturalHeights.slice();
      if (fitsSinglePage) {
        const extraTotal = Math.max(0, FIRST_PAGE_ROWS_BUDGET - totalNaturalH);
        const maxPerRowExtra = planItems.length <= 5 ? 36 : 30;
        const perRowExtra = Math.min(maxPerRowExtra, extraTotal / planItems.length);
        rowHeights = naturalHeights.map((h) => h + perRowExtra);
      }

      let tableTopY = 0;
      let cursorY = 0;

      const startPage = (isContinuation) => {
        doc.addPage({ size: "A4", layout: "portrait", margins: 0 });
        const headerBottom = drawLetterhead(isContinuation);
        tableTopY = headerBottom;
        cursorY = drawTableHeader(headerBottom);
      };

      const closeTableBordersOnPage = (bottomY) => {
        if (bottomY <= tableTopY) return;
        let sx = LEFT;
        columns.slice(0, -1).forEach((col) => {
          sx += col.width;
          doc
            .strokeColor(PALETTE.tableBorder)
            .lineWidth(0.5)
            .moveTo(sx, tableTopY + TABLE_HEADER_H)
            .lineTo(sx, bottomY)
            .stroke();
        });
        doc
          .strokeColor(PALETTE.maroon)
          .lineWidth(1)
          .rect(LEFT, tableTopY, CONTENT_W, bottomY - tableTopY)
          .stroke();
      };

      startPage(false);

      if (!planItems.length) {
        const emptyH = 56;
        doc.rect(LEFT, cursorY, CONTENT_W, emptyH).fill(PALETTE.stripe);
        doc
          .fillColor(PALETTE.muted)
          .font("Helvetica")
          .fontSize(10)
          .text("No bhajans scheduled for this session date yet.", LEFT + 12, cursorY + 21, {
            width: CONTENT_W - 24,
            align: "center"
          });
        cursorY += emptyH;
        closeTableBordersOnPage(cursorY);
      } else {
        planItems.forEach((item, index) => {
          const rowH = rowHeights[index];
          if (cursorY + rowH > MAX_CONTENT_Y) {
            closeTableBordersOnPage(cursorY);
            startPage(true);
          }

          const y = cursorY;
          const rowBg = index % 2 === 0 ? PALETTE.white : PALETTE.stripe;
          doc.rect(LEFT, y, CONTENT_W, rowH).fill(rowBg);
          doc
            .strokeColor(PALETTE.tableBorder)
            .lineWidth(0.5)
            .moveTo(LEFT, y + rowH)
            .lineTo(RIGHT, y + rowH)
            .stroke();

          // Col 0: #
          doc
            .fillColor(PALETTE.maroon)
            .font("Helvetica-Bold")
            .fontSize(fontCfg.step)
            .text(String(item.stepNum || index + 1), columns[0].x + 3, y + (rowH - 11) / 2, {
              width: columns[0].width - 6,
              align: "center",
              lineBreak: false
            });

          // Col 1: Singer + Partner
          const singerX = columns[1].x + 6;
          const singerW = columns[1].width - 12;
          doc.font("Helvetica-Bold").fontSize(fontCfg.main);
          const singerName = cleanText(item.singerName, "-");
          const singerNameH = doc.heightOfString(singerName, { width: singerW, lineGap: 1.3 });
          let singerBlockH = singerNameH;
          let partnerLine = "";
          if (item.partnerName) {
            partnerLine = `with ${cleanText(item.partnerName)}`;
            doc.font("Helvetica").fontSize(fontCfg.sub);
            singerBlockH += 2.5 + doc.heightOfString(partnerLine, { width: singerW, lineGap: 1.1 });
          }
          const singerStartY = y + Math.max(6, (rowH - singerBlockH) / 2);
          doc
            .fillColor(PALETTE.ink)
            .font("Helvetica-Bold")
            .fontSize(fontCfg.main)
            .text(singerName, singerX, singerStartY, { width: singerW, lineGap: 1.3 });
          if (partnerLine) {
            doc
              .fillColor(PALETTE.inkSoft)
              .font("Helvetica")
              .fontSize(fontCfg.sub)
              .text(partnerLine, singerX, singerStartY + singerNameH + 2.5, {
                width: singerW,
                lineGap: 1.1
              });
          }

          // Col 2: Bhajan & Raag
          const bhajanX = columns[2].x + 6;
          const bhajanW = columns[2].width - 12;
          const titleStr = cleanText(item.title, "-");
          doc.font("Helvetica-Bold").fontSize(fontCfg.main);
          const titleH = doc.heightOfString(titleStr, { width: bhajanW, lineGap: 1.4 });
          let bhajanBlockH = titleH;
          let ragaStr = "";
          if (item.raga) {
            ragaStr = `Raag: ${cleanText(item.raga)}`;
            doc.font("Helvetica").fontSize(fontCfg.sub);
            bhajanBlockH += 2.5 + doc.heightOfString(ragaStr, { width: bhajanW, lineGap: 1.1 });
          }
          const bhajanStartY = y + Math.max(6, (rowH - bhajanBlockH) / 2);
          doc
            .fillColor(PALETTE.ink)
            .font("Helvetica-Bold")
            .fontSize(fontCfg.main)
            .text(titleStr, bhajanX, bhajanStartY, { width: bhajanW, lineGap: 1.4 });
          if (ragaStr) {
            doc
              .fillColor(PALETTE.muted)
              .font("Helvetica")
              .fontSize(fontCfg.sub)
              .text(ragaStr, bhajanX, bhajanStartY + titleH + 2.5, {
                width: bhajanW,
                lineGap: 1.1
              });
          }

          // Col 3: Deity pill
          const deityLabel = cleanText(item.deity, "-").toUpperCase();
          const deityPillH = measurePillSize(doc, deityLabel, columns[3].width - 10, fontCfg.pill).pillH;
          drawPill(
            doc,
            deityLabel,
            columns[3].x + 5,
            y + (rowH - deityPillH) / 2,
            columns[3].width - 10,
            { bg: PALETTE.deityBg, border: PALETTE.deityBorder, text: PALETTE.deityText },
            fontCfg.pill
          );

          // Col 4: Pitch / Scale
          const scaleX = columns[4].x + 6;
          const scaleMain = cleanText(item.scale, "-");
          const hasWest = item.westernKey && item.westernKey !== "-";
          doc.font("Helvetica-Bold").fontSize(fontCfg.main);
          const scaleMainW = doc.widthOfString(scaleMain);
          const scaleY = y + (rowH - 12) / 2;
          doc
            .fillColor(PALETTE.ink)
            .font("Helvetica-Bold")
            .fontSize(fontCfg.main)
            .text(scaleMain, scaleX, scaleY + 0.5, { lineBreak: false });
          if (hasWest) {
            const westX = scaleX + scaleMainW + 5;
            const availW = columns[4].x + columns[4].width - 5 - westX;
            if (availW >= 18) {
              drawPill(
                doc,
                item.westernKey,
                westX,
                y + (rowH - 16) / 2,
                availW,
                { bg: PALETTE.scaleBg, border: PALETTE.scaleBorder, text: PALETTE.scaleText },
                fontCfg.pill
              );
            }
          }

          // Col 5: Tempo pill
          const tempoLabel = cleanText(item.speed, "Medium");
          const tempoPillH = measurePillSize(doc, tempoLabel, columns[5].width - 10, fontCfg.pill).pillH;
          drawPill(
            doc,
            tempoLabel,
            columns[5].x + 5,
            y + (rowH - tempoPillH) / 2,
            columns[5].width - 10,
            getTempoStyle(tempoLabel),
            fontCfg.pill
          );

          cursorY += rowH;
        });

        closeTableBordersOnPage(cursorY);
      }

      // Accompanist cue box placed neatly above footer when single-page, or right after table
      if (cursorY + CUE_GAP + CUE_BOX_H > MAX_CONTENT_Y) {
        startPage(true);
      }
      const cueY = fitsSinglePage
        ? Math.max(cursorY + CUE_GAP, FOOTER_Y - CUE_BOX_H - 14)
        : cursorY + CUE_GAP;
      doc.roundedRect(LEFT, cueY, CONTENT_W, CUE_BOX_H, 3.5).fillAndStroke(PALETTE.cueBg, PALETTE.cueBorder);
      doc.rect(LEFT, cueY, 3.5, CUE_BOX_H).fill(PALETTE.gold);
      doc
        .fillColor(PALETTE.ink)
        .font("Helvetica-Bold")
        .fontSize(8.2)
        .text("Accompanists (Harmonium & Tabla):", LEFT + 11, cueY + 10.5, {
          continued: true
        })
        .fillColor(PALETTE.inkSoft)
        .font("Helvetica")
        .text(" Follow listed pitch, Western scale & Raag cues; start at 7:30 PM sharp.", {
          width: CONTENT_W - 22
        });

      // Universal SSSO Footer on every page
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        doc
          .strokeColor(PALETTE.gold)
          .lineWidth(1)
          .moveTo(LEFT, FOOTER_Y)
          .lineTo(RIGHT, FOOTER_Y)
          .stroke();
        doc
          .fillColor(PALETTE.maroon)
          .font("Times-Italic")
          .fontSize(9.5)
          .text('"Love All, Serve All  •  Help Ever, Hurt Never"', LEFT, FOOTER_Y + 6, {
            width: CONTENT_W,
            align: "center",
            lineBreak: false
          });
        doc
          .fillColor(PALETTE.inkSoft)
          .font("Helvetica-Bold")
          .fontSize(7.8)
          .text("Sri Sathya Sai Seva Organisation, Gandhinagar", LEFT, FOOTER_Y + 21, {
            width: CONTENT_W,
            align: "center",
            lineBreak: false
          });
        doc
          .fillColor(PALETTE.muted)
          .font("Helvetica")
          .fontSize(7.2)
          .text(`Page ${i + 1} of ${range.count}`, LEFT, FOOTER_Y + 21, {
            width: CONTENT_W,
            align: "right",
            lineBreak: false
          });
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = {
  generateSessionPlanPdf
};
