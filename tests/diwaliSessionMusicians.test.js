const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const model = fs.readFileSync(path.join(root, "models/DiwaliSequence.js"), "utf8");
const migration = fs.readFileSync(path.join(root, "services/diwaliMigration.js"), "utf8");
const service = fs.readFileSync(path.join(root, "services/diwaliService.js"), "utf8");
const controller = fs.readFileSync(path.join(root, "controllers/diwaliController.js"), "utf8");
const routes = fs.readFileSync(path.join(root, "routes/diwali.js"), "utf8");
const editor = fs.readFileSync(path.join(root, "views/diwali/sequence-editor.ejs"), "utf8");
const exportsService = fs.readFileSync(path.join(root, "services/diwaliExportService.js"), "utf8");

test("Diwali sequences persist one harmonium and one tabla player per session", () => {
  assert.match(model, /harmonium_player:[\s\S]*?allowNull:\s*true/);
  assert.match(model, /tabla_player:[\s\S]*?allowNull:\s*true/);
  assert.match(migration, /ADD COLUMN harmonium_player/);
  assert.match(migration, /ADD COLUMN tabla_player/);
});

test("Diwali sequence editor exposes required musician fields and save action", () => {
  assert.match(editor, /id="harmoniumPlayer-<%= seq\.id %>"/);
  assert.match(editor, /id="tablaPlayer-<%= seq\.id %>"/);
  assert.match(editor, /required/);
  assert.match(editor, /saveSequenceMusicians\(<%= seq\.id %>\)/);
  assert.match(editor, /diwaliMusicianOptions/);
});

test("Musician assignments are validated and required before finalization", () => {
  const assignment = service.slice(
    service.indexOf("async function assignSequenceMusicians("),
    service.indexOf("async function finalizeSequence(")
  );
  const finalize = service.slice(
    service.indexOf("async function finalizeSequence("),
    service.indexOf("module.exports")
  );
  assert.match(assignment, /if \(!harmonium \|\| !tabla\)/);
  assert.match(assignment, /seq\.harmonium_player = harmonium/);
  assert.match(assignment, /seq\.tabla_player = tabla/);
  assert.match(finalize, /Assign both a harmonium player and a tabla player before finalizing/);
  assert.match(controller, /exports\.assignMusicians/);
  assert.match(routes, /sequence\/assign-musicians/);
});

test("Diwali Excel and PDF sequence exports show the assigned instrumentalists", () => {
  assert.match(exportsService, /"Harmonium Player"/);
  assert.match(exportsService, /"Tabla Player"/);
  assert.match(exportsService, /Harmonium: \\${seq\.harmonium_player/);
  assert.match(exportsService, /Tabla: \\${seq\.tabla_player/);
});
