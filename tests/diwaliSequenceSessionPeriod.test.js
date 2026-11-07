const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const model = read("models/DiwaliSequence.js");
const migration = read("services/diwaliMigration.js");
const service = read("services/diwaliService.js");
const controller = read("controllers/diwaliController.js");
const routes = read("routes/diwali.js");
const editor = read("views/diwali/sequence-editor.ejs");

test("Diwali sequences store a morning/evening period with a backward-compatible default", () => {
  assert.match(model, /session_period:[\s\S]*?defaultValue:\s*"Morning"/);
  assert.match(migration, /ADD COLUMN session_period VARCHAR\(20\) NOT NULL DEFAULT 'Morning'/);
});

test("Diwali session period assignment validates and scopes the sequence to the selected event", () => {
  const assign = service.slice(
    service.indexOf("async function assignSequencePeriod("),
    service.indexOf("async function assignSequenceMusicians(")
  );
  assert.match(assign, /\["Morning", "Evening"\]/);
  assert.match(assign, /event_id/);
  assert.match(assign, /seq\.session_period = period/);
  assert.match(controller, /exports\.assignSequencePeriod/);
  assert.match(routes, /sequence\/assign-period/);
});

test("Diwali sequence editor exposes a saved Morning/Evening selector for every sequence", () => {
  assert.match(editor, /id="seqPeriod-<%= seq\.id %>"/);
  assert.match(editor, /value="Morning"/);
  assert.match(editor, /value="Evening"/);
  assert.match(editor, /onSessionPeriodChanged\(<%= seq\.id %>, this\.value\)/);
  assert.match(editor, /assign-period/);
});
