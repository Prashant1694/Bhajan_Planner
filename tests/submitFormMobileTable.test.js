const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

function extractMediaBlock(cssText, mediaHeaderRegex) {
  const match = cssText.match(mediaHeaderRegex);
  assert.ok(match, `Expected media query matching ${mediaHeaderRegex}`);
  const start = match.index + match[0].length;
  let depth = 1;
  let i = start;
  while (i < cssText.length && depth > 0) {
    if (cssText[i] === "{") depth++;
    else if (cssText[i] === "}") depth--;
    i++;
  }
  assert.strictEqual(depth, 0, "Media query block must have balanced braces");
  return cssText.slice(start, i - 1);
}

test("submit-glass.css: balanced braces and contained horizontally scrollable sequence table", () => {
  const css = fs.readFileSync(path.join(__dirname, "../public/css/submit-glass.css"), "utf8");
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");

  let depth = 0;
  for (let i = 0; i < stripped.length; i++) {
    if (stripped[i] === "{") depth++;
    else if (stripped[i] === "}") depth--;
    assert.ok(depth >= 0, `Unexpected closing brace in submit-glass.css at index ${i}`);
  }
  assert.strictEqual(depth, 0, "submit-glass.css must have balanced braces");

  assert.ok(
    /\.submitted-bhajans-card\s*\{[^}]*overflow:\s*hidden/.test(stripped) &&
      /\.zen-submit-stage[\s\S]*?\.submitted-bhajans-card\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%/.test(
        stripped
      ),
    "submit-glass.css must clamp .submitted-bhajans-card width and clip overflow"
  );

  const screenBlock = extractMediaBlock(stripped, /@media\s+screen\s*\{/);
  assert.ok(
    /\.submitted-bhajans-card\s+\.table-glass-container\s*\{[^}]*overflow-x:\s*auto\s*!important[^}]*\}/.test(
      screenBlock
    ) &&
      screenBlock.includes("max-width: 100% !important") &&
      screenBlock.includes("min-width: 0 !important"),
    "Screen rules must contain horizontal table scroll inside .table-glass-container"
  );
  assert.ok(
    screenBlock.includes("display: table !important") &&
      screenBlock.includes("display: table-header-group !important") &&
      screenBlock.includes("display: table-cell !important") &&
      screenBlock.includes("text-align: left !important") &&
      /\.submitted-bhajans-card\s+\.table-glass-container\s+td::before\s*\{[^}]*display:\s*none\s*!important/.test(
        screenBlock
      ),
    "Screen rules must preserve semantic table layout with left-aligned cells and no data-label prefixes"
  );
  assert.ok(
    !/thead\s*\{[^}]*display:\s*none/.test(stripped),
    "submit-glass.css must not hide sequence table thead"
  );
  assert.ok(
    screenBlock.includes('[data-theme="dark"]') && screenBlock.includes(".dark "),
    "Screen rules must include dark mode overrides"
  );

  const mobileBlock = extractMediaBlock(
    stripped,
    /@media\s+screen\s+and\s+\(max-width:\s*768px\)\s*\{/
  );
  assert.ok(
    mobileBlock.includes(".submitted-bhajans-card .table-glass-container table") &&
      mobileBlock.includes("min-width: 520px !important") &&
      mobileBlock.includes("padding: 10px 10px !important"),
    "<= 768px block should apply compact mobile table spacing"
  );
});

test("style.css: keeps .submitted-bhajans-card as a contained scrollable table on mobile", () => {
  const styleCss = fs.readFileSync(path.join(__dirname, "../public/css/style.css"), "utf8");
  const match = styleCss.match(
    /\.submitted-bhajans-card\s+\.table-glass-container\s*\{([^}]*)\}/
  );
  assert.ok(match, "style.css must define .submitted-bhajans-card .table-glass-container");
  assert.ok(
    !match[1].includes("overflow-x: visible"),
    "style.css must not set overflow-x: visible on .submitted-bhajans-card .table-glass-container"
  );
  assert.ok(
    match[1].includes("overflow-x: auto !important") &&
      match[1].includes("max-width: 100% !important") &&
      match[1].includes("min-width: 0 !important"),
    "style.css must keep .submitted-bhajans-card .table-glass-container scrollable and bounded"
  );
  assert.ok(
    !/\.submitted-bhajans-card\s+thead\s*\{[^}]*display:\s*none/.test(styleCss),
    "style.css must not hide .submitted-bhajans-card thead"
  );
});

test("views/submit-form.ejs: sequence table keeps semantic thead and 6 columns", () => {
  const submitForm = fs.readFileSync(path.join(__dirname, "../views/submit-form.ejs"), "utf8");
  const cardMatch = submitForm.match(
    /<section[^>]*class="[^"]*submitted-bhajans-card[^"]*"[\s\S]*?<\/section>/
  );
  assert.ok(cardMatch, "submit-form.ejs should contain .submitted-bhajans-card section");

  const labels = Array.from(cardMatch[0].matchAll(/<td\b[^>]*data-label="([^"]+)"/g)).map(
    (m) => m[1]
  );
  assert.deepStrictEqual(labels, ["#", "Singer", "Deity", "Bhajan Title", "Speed", "Scale"]);
});

test("Cache busting: asset versions synchronized and sw.js revalidates CSS/JS fetches", () => {
  const appShell = fs.readFileSync(path.join(__dirname, "../views/app-shell.ejs"), "utf8");
  const mainLayout = fs.readFileSync(path.join(__dirname, "../views/layouts/main.ejs"), "utf8");
  const routerJs = fs.readFileSync(
    path.join(__dirname, "../public/js/app-shell-router.js"),
    "utf8"
  );
  const swJs = fs.readFileSync(path.join(__dirname, "../public/sw.js"), "utf8");

  assert.ok(appShell.includes('/css/style.css?v=6.10"'));
  assert.ok(appShell.includes("/css/<%= initialPageCss %>?v=6.10"));
  assert.ok(appShell.includes('/js/app-shell-router.js?v=6.9"'));

  assert.ok(mainLayout.includes('/css/style.css?v=6.10"'));
  assert.ok(mainLayout.includes("/css/<%= pageCSS %>?v=6.10"));

  assert.ok(routerJs.includes('const ASSET_VERSION = "6.10";'));

  assert.ok(swJs.includes('const CACHE_VERSION = "v6.17";'));
  assert.ok(swJs.includes('"/css/style.css?v=6.10"'));
  assert.ok(swJs.includes('"/js/app-shell-router.js?v=6.9"'));
  assert.ok(swJs.includes('fetch(request, { cache: "no-cache" })'));
});
