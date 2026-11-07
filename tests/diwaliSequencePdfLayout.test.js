const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(
  path.join(__dirname, "../services/diwaliExportService.js"),
  "utf8"
);
const start = source.indexOf("async function generateSequencePdf(");
const end = source.indexOf("\nmodule.exports =", start);
const pdf = source.slice(start, end);

test("Diwali sequence PDF uses the Thursday print letterhead and branded table palette", () => {
  assert.match(pdf, /AUM SRI SAI RAM/);
  assert.match(pdf, /SRI SATHYA SAI SEVA ORGANISATION, GANDHINAGAR/);
  assert.match(pdf, /public\/images\/logo\.png/);
  assert.match(pdf, /#7d2f45/);
  assert.match(pdf, /#d98a2b/);
  assert.match(pdf, /#fcf8f2/);
  assert.match(pdf, /HARMONIUM/);
  assert.match(pdf, /TABLA/);
});

test("Each Diwali sequence gets its own landscape A4 page", () => {
  assert.match(pdf, /layout: "landscape"/);
  assert.match(pdf, /sequences\.forEach\(\(seq\) => drawSequencePage\(seq\)\)/);
  assert.match(pdf, /doc\.addPage\(\{ size: "A4", layout: "landscape", margins: 0 \}\)/);
  assert.doesNotMatch(pdf, /Continued/);
});

test("Sequence rows receive dynamic spacing and never trigger continuation pages", () => {
  assert.match(pdf, /rowsAvailable \/ entries\.length/);
  assert.match(pdf, /Math\.min\(34, rowsAvailable \/ entries\.length\)/);
  assert.match(pdf, /index % 2 === 0 \? "#ffffff" : "#fdfbf7"/);
  const rowLoopStart = pdf.indexOf("entries.forEach((entry, index) =>");
  const rowLoopEnd = pdf.indexOf("// Vertical separators", rowLoopStart);
  assert.ok(rowLoopStart >= 0 && rowLoopEnd > rowLoopStart);
  assert.doesNotMatch(pdf.slice(rowLoopStart, rowLoopEnd), /addPage/);
});

test("Diwali sequence PDF retains the selected category filtering and sequence metadata", () => {
  assert.match(pdf, /category === "Gents"/);
  assert.match(pdf, /category === "Ladies"/);
  assert.match(pdf, /seq\.assigned_date/);
  assert.match(pdf, /seq\.harmonium_player/);
  assert.match(pdf, /seq\.tabla_player/);
});
