const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const editor = fs.readFileSync(path.join(__dirname, "../views/diwali/sequence-editor.ejs"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "../public/css/diwali.css"), "utf8");

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

test("Diwali sequence drag has visible dragging and saved states", () => {
  assert.match(styles, /\.sequence-entry-card\.is-dragging/);
  assert.match(styles, /\.sequence-entry-card\.is-drop-saved/);
});
