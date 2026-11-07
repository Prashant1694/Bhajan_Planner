const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const sidebar = fs.readFileSync(path.join(root, "views/partials/sidebar.ejs"), "utf8");
const styles = fs.readFileSync(path.join(root, "public/css/admin.css"), "utf8");
const script = fs.readFileSync(path.join(root, "public/js/script.js"), "utf8");

test("Admin sidebar toggle has one click handler and accessible pin state", () => {
  assert.match(sidebar, /id="sidebarToggle"/);
  assert.match(sidebar, /aria-expanded="true"/);
  assert.match(sidebar, /aria-label="Pin sidebar open"/);
  assert.doesNotMatch(sidebar, /id="sidebarToggle"[^>]*onclick=/);
  assert.match(script, /sidebarToggle\.addEventListener\("click", window\.toggleAdminSidebar\)/);
});

test("Desktop sidebar click switches between hover mode and pinned mode", () => {
  assert.match(script, /localStorage\.setItem\("admin_sidebar_mode", state\)/);
  assert.match(script, /classList\.toggle\("sidebar-collapsed", hoverMode\)/);
  assert.match(script, /classList\.toggle\("sidebar-pinned-open", !hoverMode\)/);
  assert.match(script, /const nextMode = document\.body\.classList\.contains\("sidebar-collapsed"\) \? "pinned" : "hover"/);
  assert.match(script, /localStorage\.getItem\("admin_sidebar_mode"\)/);
});

test("Hover and keyboard focus expand the compact desktop rail without changing mobile drawer rules", () => {
  assert.match(styles, /@media \(min-width: 1025px\)[\s\S]*?sidebar-collapsed \.sidebar:hover/);
  assert.match(styles, /sidebar-collapsed \.sidebar:has\(:focus-visible\)/);
  assert.match(styles, /sidebar-pinned-open \.sidebar/);
  assert.match(styles, /@media \(max-width: 1024px\)/);
  assert.match(script, /if \(!desktopQuery\.matches\) window\.closeMobileSidebar\(\)/);
});
