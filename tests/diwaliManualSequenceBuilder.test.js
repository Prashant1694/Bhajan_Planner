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

test("Manual Diwali sequence pool excludes bhajans assigned to any sequence type", () => {
  const pool = service.slice(
    service.indexOf("async function getManualSequencePool("),
    service.indexOf("async function createManualSequence(")
  );
  assert.match(pool, /SELECT DISTINCT entry\.participant_bhajan_id/);
  assert.match(pool, /WHERE sequence\.event_id = :eventId/);
  assert.doesNotMatch(pool, /sequence_type = 'Manual'/);
  assert.match(pool, /DiwaliParticipantBhajan\.findAll/);
});

test("Automatic generation does not duplicate bhajans already curated manually", () => {
  const generator = service.slice(
    service.indexOf("async function generateFairSequences("),
    service.indexOf("async function getFullSequences(")
  );
  assert.match(generator, /manuallyAssignedBhajanIds/);
  assert.match(generator, /!manuallyAssignedBhajanIds\.has\(Number\(bhajan\.id\)\)/);
});

test("Manual add rejects bhajans assigned in either automatic or manual sequences", () => {
  const add = service.slice(
    service.indexOf("async function addBhajansToManualSequence("),
    service.indexOf("async function removeBhajanFromManualSequence(")
  );
  assert.match(add, /where: \{ event_id: sequence\.event_id \}/);
  assert.match(add, /already assigned to a sequence/);
});

test("Automatic and manual sequences can exchange entries without creating duplicates", () => {
  const move = service.slice(
    service.indexOf("async function moveEntryToAnotherSequence("),
    service.indexOf("async function getManualSequencePool(")
  );
  assert.doesNotMatch(move, /sequence_type !== targetSequence\.sequence_type/);
  assert.match(move, /duplicateAssignment/);
  assert.match(move, /participant_bhajan_id: entry\.participant_bhajan_id/);
  assert.match(move, /entry\.sequence_id = targetSequence\.id/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS idx_diwali_sequence_entries_bhajan_unique/);
  assert.ok(
    migration.indexOf("ALTER TABLE diwali_sequence_entries_rebuild RENAME TO diwali_sequence_entries") <
      migration.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS idx_diwali_sequence_entries_bhajan_unique"),
    "The unique index must be created after any legacy table rebuild."
  );
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
  assert.match(controller, /exports\.deleteSequence/);
  assert.match(routes, /sequence\/delete\/:id/);
  assert.doesNotMatch(routes, /delete-generated/);
  assert.doesNotMatch(service, /async function deleteGeneratedSequences/);
  assert.match(editor, /deleteDiwaliSequence/);
  assert.match(dashboard, /deleteDiwaliSequence/);
});

test("Diwali reorder persistence validates a complete unique list and uses batched updates", () => {
  const persist = service.slice(
    service.indexOf("async function persistSequenceOrder("),
    service.indexOf("async function normalizeSequenceOrder(")
  );
  assert.match(persist, /new Set\(ids\)\.size !== ids\.length/);
  assert.match(persist, /ids\.length !== existing\.length/);
  assert.match(persist, /bulkCreate/);
  assert.match(service, /normalizeSequencesAfterBhajanRemoval/);
});

test("Diwali participant, date, import, and sequence actions preserve CSRF and event boundaries", () => {
  assert.match(dashboard, /name="_csrf" value="<%= csrfToken %>"/);
  const entry = fs.readFileSync(path.join(root, "views/diwali/entry.ejs"), "utf8");
  const importView = fs.readFileSync(path.join(root, "views/diwali/import.ejs"), "utf8");
  assert.match(entry, /name="_csrf" value="<%= csrfToken %>"/);
  assert.match(importView, /window\.diwaliPost\("\/admin\/diwali\/import\/preview"/);
  assert.match(importView, /window\.diwaliPost\("\/admin\/diwali\/import\/confirm"/);
  assert.match(service, /event_id: requirePositiveId\(eventId, "event"\)/);
  assert.match(service, /Enter a real calendar date/);
});
