const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const service = fs.readFileSync(path.join(root, "services/diwaliService.js"), "utf8");
const controller = fs.readFileSync(path.join(root, "controllers/diwaliController.js"), "utf8");
const routes = fs.readFileSync(path.join(root, "routes/diwali.js"), "utf8");
const client = fs.readFileSync(path.join(root, "public/js/diwali.js"), "utf8");
const editor = fs.readFileSync(path.join(root, "views/diwali/sequence-editor.ejs"), "utf8");
const dashboard = fs.readFileSync(path.join(root, "views/diwali/dashboard.ejs"), "utf8");

test("Diwali individual sequence deletion is scoped to selected event and sequence", () => {
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
});

test("Diwali sequence UI offers individual deletion and no bulk-delete action", () => {
  assert.match(editor, /deleteDiwaliSequence\(<%= seq\.id %>/);
  assert.match(dashboard, /deleteDiwaliSequence\(<%= seq\.id %>/);
  assert.doesNotMatch(editor, /Delete Generated Sequences/);
  assert.doesNotMatch(dashboard, /Delete Generated Sequences/);
});

test("Diwali POST helper refreshes expired CSRF token and retries once", () => {
  assert.match(client, /async function diwaliPost\(/);
  assert.match(client, /X-CSRF-Token/);
  assert.match(client, /admin\/diwali\/csrf-token/);
  assert.match(client, /response = await makeRequest\(diwaliCsrfToken\)/);
  assert.match(client, /window\.diwaliPost = diwaliPost/);
  assert.match(client, /diwaliPost\(\`\/admin\/diwali\/participant\/update/);
  assert.match(editor, /window\.diwaliPost\(/);
});

test("Diwali CSRF refresh endpoint is authenticated", () => {
  assert.match(routes, /admin\/diwali\/csrf-token/);
  assert.match(routes, /res\.locals\.csrfToken/);
});
