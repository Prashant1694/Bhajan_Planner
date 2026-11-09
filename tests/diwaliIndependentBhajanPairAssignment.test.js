const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const service = fs.readFileSync(path.join(root, "services/diwaliService.js"), "utf8");
const controller = fs.readFileSync(path.join(root, "controllers/diwaliController.js"), "utf8");
const frontend = fs.readFileSync(path.join(root, "public/js/diwali.js"), "utf8");
const dashboard = fs.readFileSync(path.join(root, "views/diwali/dashboard.ejs"), "utf8");

test("each Diwali bhajan can be assigned to an event-scoped singer pair", () => {
  const start = service.indexOf("async function updateParticipantWithBhajans(");
  const end = service.indexOf("\nasync function deleteParticipant(", start);
  const update = service.slice(start, end);
  assert.match(update, /b\.participant_id/);
  assert.match(update, /where: \{ id: \{ \[Op\.in\]: targetIds \}, event_id: participant\.event_id \}/);
  assert.match(update, /Object\.assign\(existingRecord, values\)/);
});

test("empty pairs remain available after their bhajans are moved", () => {
  const start = service.indexOf("async function updateParticipantWithBhajans(");
  const end = service.indexOf("\nasync function deleteParticipant(", start);
  const update = service.slice(start, end);
  assert.doesNotMatch(update, /validBhajans\.length === 0/);
  assert.match(dashboard, /Singer Pair Directory/);
  assert.match(dashboard, /\(pair\.bhajans \|\| \[\]\)\.length/);
});

test("edit modal exposes an independent pair selector on every bhajan", () => {
  assert.match(controller, /availablePairs/);
  assert.match(frontend, /diwaliAvailablePairs/);
  assert.match(frontend, /edit-bhajan-pair/);
  assert.match(frontend, /participant_id: parseInt\(assignedPairId, 10\)/);
  assert.match(frontend, /Select a singer pair for every bhajan/);
});

test("deleting an individual bhajan is allowed when it is a pair last bhajan", () => {
  const start = service.indexOf("async function deleteBhajan(");
  const end = service.indexOf("\nasync function ", start + 10);
  const remove = service.slice(start, end);
  assert.doesNotMatch(remove, /count <= 1/);
  assert.match(remove, /normalizeSequencesAfterBhajanRemoval/);
});
