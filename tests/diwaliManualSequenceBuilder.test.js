const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const service = fs.readFileSync(path.join(root, "services/diwaliService.js"), "utf8");
const migration = fs.readFileSync(path.join(root, "services/diwaliMigration.js"), "utf8");
const model = fs.readFileSync(path.join(root, "models/DiwaliSequence.js"), "utf8");
const associations = fs.readFileSync(path.join(root, "models/diwaliModels.js"), "utf8");
const controller = fs.readFileSync(path.join(root, "controllers/diwaliController.js"), "utf8");
const routes = fs.readFileSync(path.join(root, "routes/diwali.js"), "utf8");
const editor = fs.readFileSync(path.join(root, "views/diwali/sequence-editor.ejs"), "utf8");
const dashboard = fs.readFileSync(path.join(root, "views/diwali/dashboard.ejs"), "utf8");
const exportsService = fs.readFileSync(path.join(root, "services/diwaliExportService.js"), "utf8");

test("Diwali sequences are explicitly typed and existing rows migrate as automatic", () => {
  assert.match(model, /sequence_type:[\s\S]*?defaultValue:\s*"Auto"/);
  assert.match(migration, /ADD COLUMN sequence_type VARCHAR\(20\) NOT NULL DEFAULT 'Auto'/);
  assert.match(associations, /DiwaliParticipantBhajan\.hasMany\(DiwaliSequenceEntry/);
});

test("Regenerating automatic Diwali sequences preserves all manual sequences", () => {
  const generator = service.slice(
    service.indexOf("async function generateFairSequences("),
    service.indexOf("async function getFullSequences(")
  );
  assert.match(generator, /where:\s*\{\s*event_id:\s*eventId,\s*sequence_type:\s*"Auto"\s*\}/);
  assert.match(generator, /sequence_type:\s*"Auto"/);
});

test("Manual Diwali sequence pool excludes only bhajans already used manually", () => {
  const pool = service.slice(
    service.indexOf("async function getManualSequencePool("),
    service.indexOf("async function createManualSequence(")
  );
  assert.match(pool, /sequence_type = 'Manual'/);
  assert.match(pool, /DiwaliParticipantBhajan\.findAll/);
});

test("Manual sequence builder supports creation, transactional multi-add, and removal", () => {
  assert.match(service, /async function createManualSequence\(/);
  assert.match(service, /async function addBhajansToManualSequence\(/);
  assert.match(service, /async function removeBhajanFromManualSequence\(/);
  assert.match(service, /sequence\.sequence_type !== "Manual"/);
  assert.match(service, /await t\.commit\(\)/);
  assert.match(editor, /createManualDiwaliSequence/);
  assert.match(editor, /manualPool-<%= seq\.id %>/);
  assert.match(editor, /addBhajansToManualSequence/);
  assert.match(editor, /removeBhajanFromManualSequence/);
});

test("Manual sequence API is protected by the Diwali route group and controller", () => {
  assert.match(controller, /exports\.createManualSequence/);
  assert.match(controller, /exports\.addManualBhajans/);
  assert.match(controller, /exports\.removeManualBhajan/);
  assert.match(routes, /sequence\/manual\/create/);
  assert.match(routes, /sequence\/manual\/add-bhajans/);
  assert.match(routes, /sequence\/manual\/remove-bhajan/);
  assert.match(dashboard, /Sequence Editor \/ Manual Builder/);
});

test("Automatic and manual Diwali exports have distinct labels", () => {
  assert.match(exportsService, /Manual Sequence/);
  assert.match(exportsService, /sequenceLabel\.toUpperCase\(\)/);
});


test("Individual Diwali sequence deletion is event-scoped and preserves unrelated sequences", () => {
  const deletion = service.slice(
    service.indexOf("async function deleteSequence(eventId, sequenceId)"),
    service.indexOf("async function getFullSequences(")
  );
  assert.match(deletion, /where:\s*\{\s*id,\s*event_id:\s*eventId\s*\}/);
  assert.match(deletion, /DiwaliSequenceEntry\.destroy/);
  assert.match(deletion, /sequence\.destroy/);
  assert.match(deletion, /await t\.commit\(\)/);
  assert.match(deletion, /await t\.rollback\(\)/);
  assert.match(controller, /exports\\.deleteSequence/);
  assert.match(routes, /sequence\/delete\/:id/);
  assert.doesNotMatch(routes, /delete-generated/);
  assert.doesNotMatch(service, /async function deleteGeneratedSequences/);
  assert.match(editor, /deleteDiwaliSequence/);
  assert.match(dashboard, /deleteDiwaliSequence/);
});
