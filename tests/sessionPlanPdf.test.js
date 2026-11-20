const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PassThrough } = require("stream");
const { setupTestDb } = require("./setup");

let app;
let BhajanSubmission;
let generateSessionPlanPdf;

function invokeApp(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = new PassThrough();
    req.url = url;
    req.originalUrl = url;
    req.method = "GET";
    req.headers = Object.assign({ host: "localhost:8000", accept: "text/html" }, headers);
    req.connection = { remoteAddress: "127.0.0.1" };
    req.socket = req.connection;

    const resHeaders = {};
    const chunks = [];
    const res = new PassThrough();
    res.statusCode = 200;
    res.setHeader = (k, v) => {
      resHeaders[k.toLowerCase()] = v;
    };
    res.getHeader = (k) => resHeaders[k.toLowerCase()];
    res.removeHeader = (k) => {
      delete resHeaders[k.toLowerCase()];
    };
    res.getHeaders = () => resHeaders;
    res.writeHead = (code, h) => {
      res.statusCode = code;
      if (h) Object.assign(resHeaders, h);
    };
    res.write = (chunk) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return true;
    };
    res.end = (chunk) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      const buf = Buffer.concat(chunks);
      resolve({ status: res.statusCode, headers: resHeaders, body: buf, text: buf.toString("utf8") });
    };

    app(req, res, (err) => {
      if (err) reject(err);
    });
  });
}

test.before(async () => {
  await setupTestDb();
  ({ app } = require("../app"));
  BhajanSubmission = require("../models/BhajanSubmission");
  ({ generateSessionPlanPdf } = require("../services/sessionPdfService"));

  await BhajanSubmission.create({
    session_date: "2026-11-19",
    singer_name: "Mamta Sharma",
    partner_name: "Thulasi",
    deity: "Ganesha",
    title: "Maha Ganapathey Namostuthey",
    scale: "5.5P",
    speed: "Medium Fast",
    list_order: 1
  });
});

test("sessionPdfService generates valid single-page, empty, and multi-page A4 PDFs", async () => {
  const singleBuf = await generateSessionPlanPdf({
    sessionDate: "2026-11-19",
    sessionDateHuman: "Thursday, Nov 19, 2026",
    planItems: [
      {
        stepNum: 1,
        singerName: "Mamta Sharma",
        partnerName: "Thulasi",
        title: "Maha Ganapathey Namostuthey",
        raga: "Hamsadhwani",
        deity: "Ganesha",
        scale: "5.5P",
        westernKey: "G#",
        speed: "Medium Fast"
      }
    ]
  });
  assert.ok(Buffer.isBuffer(singleBuf));
  assert.strictEqual(singleBuf.subarray(0, 5).toString("ascii"), "%PDF-");

  const emptyBuf = await generateSessionPlanPdf({
    sessionDate: "2026-11-26",
    sessionDateHuman: "Thursday, Nov 26, 2026",
    planItems: []
  });
  assert.strictEqual(emptyBuf.subarray(0, 5).toString("ascii"), "%PDF-");

  const manyItems = Array.from({ length: 24 }, (_, i) => ({
    stepNum: i + 1,
    singerName: `Singer ${i + 1}`,
    partnerName: i % 2 === 0 ? `Partner ${i + 1}` : "",
    title: `Bhajan Offering ${i + 1}`,
    raga: i % 3 === 0 ? "Bhairavi" : "",
    deity: "Sai",
    scale: "4.5P",
    westernKey: "F#",
    speed: "Medium"
  }));
  const multiBuf = await generateSessionPlanPdf({
    sessionDate: "2026-11-19",
    sessionDateHuman: "Thursday, Nov 19, 2026",
    planItems: manyItems
  });
  assert.strictEqual(multiBuf.subarray(0, 5).toString("ascii"), "%PDF-");
  assert.ok(multiBuf.length > singleBuf.length);
});

test("GET /plan-view/pdf streams clean application/pdf inline and attachment responses", async () => {
  const inlineRes = await invokeApp("/plan-view/pdf?session_date=2026-11-19");
  assert.strictEqual(inlineRes.status, 200);
  assert.ok(String(inlineRes.headers["content-type"]).includes("application/pdf"));
  assert.ok(
    String(inlineRes.headers["content-disposition"]).includes(
      'inline; filename="Bhajan_Plan_2026-11-19.pdf"'
    )
  );
  assert.strictEqual(inlineRes.body.subarray(0, 5).toString("ascii"), "%PDF-");

  const downloadRes = await invokeApp("/plan-view/pdf?session_date=2026-11-19&download=1");
  assert.strictEqual(downloadRes.status, 200);
  assert.ok(
    String(downloadRes.headers["content-disposition"]).includes(
      'attachment; filename="Bhajan_Plan_2026-11-19.pdf"'
    )
  );
  assert.strictEqual(downloadRes.body.subarray(0, 5).toString("ascii"), "%PDF-");

  const badDateRes = await invokeApp('/plan-view/pdf?session_date="><script>alert(1)</script>');
  assert.strictEqual(badDateRes.status, 200);
  assert.ok(String(badDateRes.headers["content-type"]).includes("application/pdf"));
});

test("View Plan tab exposes PDF export button and isolates inactive app-shell panes in print", async () => {
  const planRes = await invokeApp("/plan-view?session_date=2026-11-19");
  assert.strictEqual(planRes.status, 200);
  assert.ok(planRes.text.includes("/plan-view/pdf?session_date=2026-11-19"));
  assert.ok(planRes.text.includes('id="planDownloadPdfBtn"'));
  assert.ok(planRes.text.includes("print-accompanist-cue"));
  assert.ok(planRes.text.includes('class="plan-partner-sub"'));
  assert.ok(planRes.text.includes("with Thulasi"));
  assert.ok(!planRes.text.includes("w/ Thulasi"));
  assert.ok(planRes.text.includes('class="print-hide-emoji"'));
  assert.ok(!planRes.text.includes('table.style.setProperty("display", "none", "important")'));

  const routerSrc = fs.readFileSync(
    path.join(__dirname, "../public/js/app-shell-router.js"),
    "utf8"
  );
  assert.ok(routerSrc.includes('"/plan-view/pdf"'));

  const appShellCss = fs.readFileSync(
    path.join(__dirname, "../public/css/app-shell.css"),
    "utf8"
  );
  const printIdx = appShellCss.indexOf("@media print");
  assert.ok(printIdx >= 0);
  const printBlock = appShellCss.slice(printIdx);
  assert.ok(printBlock.includes(".shell-pane:not(.active-pane)"));
  assert.ok(!/^\s*\.shell-pane,\s*$/m.test(printBlock));

  const appShellEjs = fs.readFileSync(
    path.join(__dirname, "../views/app-shell.ejs"),
    "utf8"
  );
  assert.ok(appShellEjs.includes(".shell-pane:not(.active-pane)"));

  const styleCss = fs.readFileSync(
    path.join(__dirname, "../public/css/style.css"),
    "utf8"
  );
  assert.ok(styleCss.includes(".shell-pane:not(.active-pane)"));
  assert.ok(styleCss.includes("table-layout: fixed;"));
});
