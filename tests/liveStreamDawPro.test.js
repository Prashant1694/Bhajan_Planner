const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const Dsp = require("../public/js/live-stream-dsp");
const Engine = require("../public/js/live-stream-daw-engine");

const ROOT = path.join(__dirname, "..");

test("WAV recording bugfix: explicit file offsets, worklet flush, and discrete dual-channel capture", () => {
  const workletSrc = fs.readFileSync(path.join(ROOT, "public/js/live-stream-worklet.js"), "utf8");
  const recSrc = fs.readFileSync(path.join(ROOT, "public/js/live-stream-recorder.js"), "utf8");
  const studioSrc = fs.readFileSync(path.join(ROOT, "public/js/live-stream-studio.js"), "utf8");

  // Worklet handles explicit flush & uses 2048-sample dry blocks
  assert.ok(workletSrc.includes('ev.data.type === "flush"'));
  assert.ok(workletSrc.includes("this.blockSize = 2048"));

  // Recorder writes dry PCM at explicit sequential byte offsets (>= 44) so header updates never reset the write cursor
  assert.ok(recSrc.includes("ch1WritePos: 44"));
  assert.ok(recSrc.includes("ch2WritePos: 44"));
  assert.ok(recSrc.includes("position: pos1"));
  assert.ok(recSrc.includes("position: pos2"));

  // Studio loads v2.0 worklet, configures discrete 2-ch capture, includes fallback & flushes on stop
  assert.ok(studioSrc.includes("/js/live-stream-worklet.js?v=2.0"));
  assert.ok(studioSrc.includes('channelInterpretation: "discrete"'));
  assert.ok(studioSrc.includes("createScriptProcessor"));
  assert.ok(studioSrc.includes('dryWorkletNode.port.postMessage({ type: "flush" })'));
});

test("Modular FX Catalog defines all 8 FL/Audition-style rack effects & builder", () => {
  const expectedTypes = ["eq", "filter", "compressor", "deesser", "reverb", "delay", "saturation", "limiter"];
  expectedTypes.forEach((t) => {
    const def = Dsp.FX_CATALOG[t];
    assert.ok(def, `Missing FX_CATALOG entry for ${t}`);
    assert.ok(Array.isArray(def.controls) && def.controls.length >= 2);
    const slot = Dsp.createDefaultFxSlot(t, { enabled: true });
    assert.equal(slot.type, t);
    assert.ok(slot.id);
    assert.equal(slot.enabled, true);
  });
  assert.equal(typeof Dsp.buildModularFxChain, "function");
});

test("DAW Engine: dynamic tracks (add, rename, gain/pan/mute/solo, delete, last-track guard) with Undo/Redo", () => {
  const st = Engine.createInitialState();
  assert.equal(st.tracks.length, 2);
  assert.equal(st.masterTrack.id, "master");
  assert.ok(st.masterTrack.fxRack.some((f) => f.type === "eq"));
  assert.ok(st.masterTrack.fxRack.some((f) => f.type === "limiter"));

  const t3 = Engine.addTrack(st, { name: "Tanpura Drone" });
  assert.equal(st.tracks.length, 3);
  assert.equal(st.selectedTrackId, t3.id);

  assert.equal(Engine.renameTrack(st, t3.id, "Acoustic Tanpura"), true);
  assert.equal(Engine.getTrackById(st, t3.id).name, "Acoustic Tanpura");

  assert.equal(Engine.updateTrackProps(st, t3.id, { gain: 85, pan: -35, mute: true }), true);
  assert.equal(Engine.getTrackById(st, t3.id).pan, -35);
  assert.equal(Engine.getTrackById(st, t3.id).mute, true);

  const src3 = Engine.addSource(st, { id: "src-tanpura", name: "tanpura.wav", duration: 30 });
  const clip3 = Engine.appendClip(st, { sourceId: src3, trackId: t3.id, timelineOffsetSec: 5 });
  assert.equal(clip3.trackId, t3.id);
  const layout = Engine.computeTimelineLayout(st.clips);
  assert.equal(layout.totalDuration, 35);

  // Deleting custom track removes its clips and updates selection cleanly
  assert.equal(Engine.deleteTrack(st, t3.id), true);
  assert.equal(st.tracks.length, 2);
  assert.equal(st.clips.filter((c) => c.trackId === t3.id).length, 0);

  // Undo restores deleted track & clip
  assert.equal(Engine.undo(st), true);
  assert.equal(st.tracks.length, 3);
  assert.equal(st.clips.filter((c) => c.trackId === t3.id).length, 1);

  // Guard: cannot delete master or the final remaining track
  assert.equal(Engine.deleteTrack(st, "master"), false);
  Engine.deleteTrack(st, t3.id);
  Engine.deleteTrack(st, "track-2");
  assert.equal(st.tracks.length, 1);
  assert.equal(Engine.deleteTrack(st, "track-1"), false);
});

test("DAW Engine: per-track FX racks allow independent manual EQ curves, reordering & bypass", () => {
  const st = Engine.createInitialState();
  const eq1 = Engine.addTrackFx(st, "track-1", "eq", { b80: 4.5, b3k5: -2 });
  const sat1 = Engine.addTrackFx(st, "track-1", "saturation", { drive: 35 });
  const eq2 = Engine.addTrackFx(st, "track-2", "eq", { b80: -4, b3k5: 4, b10k: 3 });

  assert.ok(eq1 && sat1 && eq2);
  assert.equal(Engine.getTrackById(st, "track-1").fxRack.length, 2);
  assert.equal(Engine.getTrackById(st, "track-2").fxRack.length, 1);

  // Reorder Track 1 saturation above EQ
  assert.equal(Engine.moveTrackFx(st, "track-1", sat1.id, -1), true);
  assert.equal(Engine.getTrackById(st, "track-1").fxRack[0].id, sat1.id);

  // Toggle bypass on EQ 1
  assert.equal(Engine.toggleTrackFx(st, "track-1", eq1.id), true);
  assert.equal(Engine.getTrackById(st, "track-1").fxRack[1].enabled, false);

  // Compute independent EQ curves per track (32 Hz low-shelf body vs 3.5 kHz presence)
  const curve1 = Dsp.computeEqCurvePoints(eq1.params, [32, 3500]);
  const curve2 = Dsp.computeEqCurvePoints(eq2.params, [32, 3500]);
  assert.ok(curve1[0].db > 3.5 && curve2[0].db < -3.0, "Track 1 low boost vs Track 2 low cut must stay independent");
  assert.ok(curve2[1].db > 2.5 && curve1[1].db < -1.5, "Track 2 vocal presence boost must stay independent");

  // Update Track 2 EQ manually and remove Track 1 saturation
  assert.equal(Engine.updateTrackFxParams(st, "track-2", eq2.id, { b1k: 2.5 }), true);
  assert.equal(eq2.params.b1k, 2.5);
  assert.equal(Engine.removeTrackFx(st, "track-1", sat1.id), true);
  assert.equal(Engine.getTrackById(st, "track-1").fxRack.length, 1);
});

test("DAW Pro Studio markup & CSS contracts are wired cleanly with zero !important", () => {
  const ejs = fs.readFileSync(path.join(ROOT, "views/admin-live-stream.ejs"), "utf8");
  const dawUi = fs.readFileSync(path.join(ROOT, "public/js/live-stream-daw-ui.js"), "utf8");
  const studioCss = fs.readFileSync(path.join(ROOT, "public/css/live-stream-studio.css"), "utf8");

  [
    "lsDawAddTrackBtn",
    "lsDawDeleteTrackBtn",
    "lsDawSelectMasterBtn",
    "lsDawTrackFileInput",
    "lsDawTrackHeaders",
    "lsDawFxRackPanel",
    "lsDawFxTrackSelect",
    "lsDawAddFxSelect",
    "lsDawAddFxBtn",
    "lsDawImportLiveFxBtn",
    "lsDawFxSlotList",
    "lsDawFxEditorPane"
  ].forEach((id) => {
    assert.ok(ejs.includes(`id="${id}"`), `Missing Pro DAW element #${id} in admin-live-stream.ejs`);
  });

  assert.ok(dawUi.includes("buildDawAudioGraph"));
  assert.ok(dawUi.includes("buildModularFxChain"));
  assert.ok(dawUi.includes("drawTrackEqCurve"));
  assert.equal((studioCss.match(/!important/g) || []).length, 0);
});
