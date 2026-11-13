const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const editor = fs.readFileSync(path.join(__dirname, "../views/diwali/sequence-editor.ejs"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "../public/css/diwali.css"), "utf8");
const service = fs.readFileSync(path.join(__dirname, "../services/diwaliService.js"), "utf8");
const database = fs.readFileSync(path.join(__dirname, "../config/database.js"), "utf8");

test("Diwali sequence editor exposes a touch-friendly drag handle for every bhajan", () => {
  assert.match(editor, /class="sequence-drag-handle"/);
  assert.match(editor, /data-entry-id="<%= e\.id %>"/);
  assert.match(editor, /data-seq-id="<%= seq\.id %>"/);
  assert.match(styles, /\.sequence-drag-handle[\s\S]*?touch-action:\s*none/);
});

test("Diwali sequence drag supports same-list reorder and cross-sequence moves", () => {
  assert.match(editor, /addEventListener\("pointerdown"/);
  assert.match(editor, /addEventListener\("pointermove"/);
  assert.match(editor, /addEventListener\("pointerup"/);
  assert.match(editor, /\/admin\/diwali\/sequence\/save-order/);
  assert.match(editor, /\/admin\/diwali\/sequence\/move-entry/);
  assert.match(editor, /targetOrder/);
  assert.match(editor, /pointercancel/);
});

test("Diwali sequence editor provides a desktop table view with matching draggable entries", () => {
  assert.match(editor, /data-sequence-view="cards"/);
  assert.match(editor, /setDiwaliSequenceView\('table'\)/);
  assert.match(editor, /class="sequence-view-cards"/);
  assert.match(editor, /class="sequence-view-table"/);
  assert.match(editor, /class="sequence-entries-list sequence-table-body"/);
  assert.match(editor, /class="sequence-entry-card sequence-table-row"/);
  assert.match(editor, /syncCardAndTableLists/);
  assert.match(styles, /data-sequence-view="table".*sequence-view-cards/s);
  assert.match(styles, /sequence-table-body\.sequence-entries-list/);
});

test("Diwali drag auto-scrolls the page when the pointer reaches viewport edges", () => {
  assert.match(editor, /autoScrollWhileDragging/);
  assert.match(editor, /window\.scrollBy\(\{ top: scrollDelta/);
  assert.match(editor, /requestAnimationFrame\(autoScrollWhileDragging\)/);
  assert.match(editor, /cancelAnimationFrame/);
});

test("SQLite connection pool serializes local writes and waits/retries external locks", () => {
  assert.match(database, /max:\s*1/);
  assert.match(database, /PRAGMA busy_timeout = 30000/);
  assert.match(database, /match:\s*\[\/SQLITE_BUSY\/,\s*\/SQLITE_LOCKED\//);
  assert.match(database, /backoffBase:\s*250/);
});

test("Diwali sequence order writes acquire an immediate SQLite transaction", () => {
  const reorder = service.slice(
    service.indexOf("async function updateSequenceEntriesOrder("),
    service.indexOf("async function moveEntryToAnotherSequence(")
  );
  const move = service.slice(
    service.indexOf("async function moveEntryToAnotherSequence("),
    service.indexOf("async function getManualSequencePool(")
  );
  assert.match(reorder, /sequelize\.transaction\(\{ type: Transaction\.TYPES\.IMMEDIATE \}\)/);
  assert.match(move, /sequelize\.transaction\(\{ type: Transaction\.TYPES\.IMMEDIATE \}\)/);
});

test("Diwali sequence drag has visible dragging and saved states", () => {
  assert.match(styles, /\.sequence-entry-card\.is-dragging/);
  assert.match(styles, /\.sequence-entry-card\.is-drop-saved/);
});

test("Diwali cross-sequence drops persist the requested insertion position", () => {
  const moveFunction = service.slice(
    service.indexOf("async function moveEntryToAnotherSequence("),
    service.indexOf("async function assignSequenceDate")
  );
  assert.match(moveFunction, /targetIds\.splice\(insertAt, 0, sourceEntryId\)/);
  assert.match(moveFunction, /persistSequenceOrder\(sourceSequence\.id, sourceNextIds, transaction\)/);
  assert.match(moveFunction, /persistSequenceOrder\(targetSequence\.id, targetIds, transaction, \{ updateSequenceId: true \}\)/);
  assert.match(moveFunction, /Number\(sourceSequence\.id\) === Number\(targetSequence\.id\)/);
  assert.match(moveFunction, /Sequences can only be edited within the selected Diwali event/);
});
