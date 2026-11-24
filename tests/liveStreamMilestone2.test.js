const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const dawEngine = require("../public/js/live-stream-daw-engine");

const ROOT = path.join(__dirname, "..");

test("DAW Engine: layout calculates clip positions & crossfades cleanly", () => {
  const st = dawEngine.createInitialState();
  const s1 = dawEngine.addSource(st, { id: "s1", name: "Part 1", duration: 60 });
  const s2 = dawEngine.addSource(st, { id: "s2", name: "Part 2", duration: 40 });
  dawEngine.appendClip(st, { sourceId: s1, duration: 60 });
  dawEngine.appendClip(st, { sourceId: s2, duration: 40, crossfadePrevSec: 0.5 });

  const layout = dawEngine.computeTimelineLayout(st.clips);
  assert.strictEqual(layout.items.length, 2);
  assert.strictEqual(layout.items[0].timelineStart, 0);
  assert.strictEqual(layout.items[0].timelineEnd, 60);
  assert.strictEqual(layout.items[1].effectiveCrossfade, 0.5);
  assert.strictEqual(layout.items[1].timelineStart, 59.5);
  assert.strictEqual(layout.totalDuration, 99.5);
});

test("DAW Engine: splitAt, trimClip, rippleDeleteRange & rippleDeleteClip shift markers accurately with Undo/Redo", () => {
  const st = dawEngine.createInitialState();
  const srcId = dawEngine.addSource(st, { id: "main", name: "Live Stems", duration: 120 });
  const clip = dawEngine.appendClip(st, { sourceId: srcId, duration: 120 });

  dawEngine.setMarkers(st, [
    { bhajan_title: "Silence Marker", start_seconds: 5 },
    { bhajan_title: "Bhajan One", start_seconds: 25 },
    { bhajan_title: "Mid Intermission", start_seconds: 55 },
    { bhajan_title: "Bhajan Two", start_seconds: 80 }
  ]);

  // 1. Trim 10s of leading silence off front: markers >= 0 inside clip shift earlier by 10s
  const trimmed = dawEngine.trimClip(st, clip.id, { newSourceStart: 10, newSourceEnd: 120 });
  assert.strictEqual(trimmed, true);
  assert.strictEqual(dawEngine.computeTimelineLayout(st.clips).totalDuration, 110);
  assert.strictEqual(st.markers.find((m) => m.bhajan_title === "Bhajan One").start_seconds, 15);
  assert.strictEqual(st.markers.find((m) => m.bhajan_title === "Mid Intermission").start_seconds, 45);
  assert.strictEqual(st.markers.find((m) => m.bhajan_title === "Bhajan Two").start_seconds, 70);

  // 2. Ripple-delete middle silence/talking range [40, 60] (20s) with 0.25s join crossfade
  const cutOk = dawEngine.rippleDeleteRange(st, 40, 60, { joinCrossfadeSec: 0.25 });
  assert.strictEqual(cutOk, true);
  assert.strictEqual(st.clips.length, 2);
  assert.strictEqual(st.clips[1].crossfadePrevSec, 0.25);

  // Mid Intermission (45s) fell inside cut [40, 60) -> removed
  assert.strictEqual(
    st.markers.find((m) => m.bhajan_title === "Mid Intermission"),
    undefined
  );
  // Bhajan One (15s) unaffected
  assert.strictEqual(st.markers.find((m) => m.bhajan_title === "Bhajan One").start_seconds, 15);
  // Bhajan Two (was 70s, after cut ends at 60s; joined with 0.25s crossfade -> shifted by -20.25s = 49.75s)
  assert.strictEqual(st.markers.find((m) => m.bhajan_title === "Bhajan Two").start_seconds, 49.75);

  // 3. Split clip 1 cleanly at 20s without losing markers
  assert.strictEqual(dawEngine.splitAt(st, 20), true);
  assert.strictEqual(st.clips.length, 3);
  assert.strictEqual(st.markers.find((m) => m.bhajan_title === "Bhajan Two").start_seconds, 49.75);

  // 4. Delete first clip [0, 20]: Bhajan One (15s) removed, Bhajan Two shifts by -20s -> 29.75s
  const delClipOk = dawEngine.rippleDeleteClip(st, st.clips[0].id, { joinCrossfadeSec: 0 });
  assert.strictEqual(delClipOk, true);
  assert.strictEqual(st.markers.find((m) => m.bhajan_title === "Bhajan One"), undefined);
  assert.strictEqual(st.markers.find((m) => m.bhajan_title === "Bhajan Two").start_seconds, 29.75);

  // 5. Undo twice restores split & Bhajan One marker cleanly
  assert.strictEqual(dawEngine.undo(st), true);
  assert.strictEqual(st.markers.find((m) => m.bhajan_title === "Bhajan One").start_seconds, 15);
  assert.strictEqual(dawEngine.redo(st), true);
  assert.strictEqual(st.markers.find((m) => m.bhajan_title === "Bhajan One"), undefined);
});

test("Milestone 2 static guarantees: DAW tab, canvas, preview player, offline renderer & zero !important", () => {
  const studioEjs = fs.readFileSync(path.join(ROOT, "views", "admin-live-stream.ejs"), "utf8");
  const studioCss = fs.readFileSync(path.join(ROOT, "public", "css", "live-stream-studio.css"), "utf8");
  const dawUi = fs.readFileSync(path.join(ROOT, "public", "js", "live-stream-daw-ui.js"), "utf8");
  const recJs = fs.readFileSync(path.join(ROOT, "public", "js", "live-stream-recorder.js"), "utf8");

  assert.ok(studioEjs.includes('id="lsTabDawBtn"'));
  assert.ok(studioEjs.includes('id="lsDawCanvas"'));
  assert.ok(studioEjs.includes('id="lsDawRenderPublishBtn"'));
  assert.ok(studioEjs.includes("live-stream-daw-engine.js"));
  assert.ok(studioEjs.includes("live-stream-daw-ui.js"));
  assert.ok(dawUi.includes("OfflineAudioContext"));
  assert.ok(dawUi.includes("decodeWavFallback"));
  assert.ok(recJs.includes("dryCh1File"));
  assert.ok(recJs.includes("dryCh2File"));
  assert.strictEqual((studioCss.match(/!important/g) || []).length, 0);
});
