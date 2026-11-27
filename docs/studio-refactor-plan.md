# Studio Module — Refactoring Plan (non-UI)

Scope: audio engine, recording, broadcast, DAW logic, bridge, server. UI redesign is on hold; this plan
creates the clean state/logic layer the future UI will bind to. No feature removal.

## 0. Requirements traceability (what exists vs. what must change)

| # | Requirement | Status today | Action |
|---|---|---|---|
| R1 | Live stream + pro recording on one platform, simultaneously | Exists (shared engine; stems + MP3 stream) | Decouple into two state machines (Phase 3) |
| R2 | Live mix has EQ; user shapes raw input for the stream | Exists (per-channel HPF/LPF/3-band EQ/comp/de-esser + master EQ/limiter) | Unify DSP (Phase 2) |
| R3 | Recording = RAW only, never the live EQ/post mix | Stems are raw: `bp-dry-capture` taps routing pin gains *before* trim/EQ (studio.js:3085). **But** a post-mix master MP3 is also recorded and is **on by default** (`recordMasterMp3 !== false`, recorder.js:404) | Stems stay raw: 24-bit/48 kHz WAV, no browser AGC/NS/EC (already off). Replace the separate master MP3 encode with the **live stream copy** (R12) |
| R4 | CH1 & CH2 each get an independent signal from the interface | Bridge (WASAPI-exclusive/ASIO) delivers discrete pins; browser `getUserMedia` fallback can mono-sum on Windows | Require bridge for recording; add automatic **isolation check** (signal on pin A must not appear on pin B) + per-pin level meters before Arm (Phase 1) |
| R5 | Two separate processed channels on the stream; two separate tracks in recording | Exists | Keep; covered by golden tests |
| R6 | Post-stream DAW: edit, plugins, EQ, mastering | Exists (engine + FX rack + offline render + LUFS) | Refactor only |
| R7 | Export format/compression user chooses | WAV 16 (dither)/24, MP3 bitrates, sample rate | Add **FLAC** (lossless, ~50% smaller) and optionally Opus/AAC via WebCodecs `AudioEncoder` where supported; format presets |
| R8 | Per-bhajan timestamps added while editing | DAW markers (`submission_id`, title, singer, start) synced to studio via `LiveStudioBridge.setTimestamps`; ripple-cut shifts markers in UI code (daw-ui.js:6102) | Markers are added **during post-session editing** (primary path). Add: bhajan picker fed from that date's plan, start + optional end, drag/rename/delete, snap to playhead/silence gap, list panel to jump between bhajans, check for duplicate/missing bhajans. Marker shifting moves into the DAW engine for every edit (split/ripple/trim/paste). Live "Now Singing" times are only an optional starting point |
| R12 | Save the live-streamed audio (live EQ version, same format) on the laptop for review | A separate MP3 encode of the master is recorded (`recordMasterMp3`), not the actual stream bytes | Save the **exact bytes sent to listeners** (copy at `encoderWorker.onmessage` before `ws.send`, studio.js:~3376) to `.../live/stream.mp3` on the SSD. Same bitrate, bit-identical to what listeners heard. Crash-safe append; never uploaded. Opens in a "Stream Review" player and can be loaded into the DAW as a reference track for A/B |
| R13 | DAW upgraded to an FL Studio-style workflow, quality first | Audition-style multitrack | Phase 7 |
| R9 | One button → auto upload to R2, auto-link to the date's bhajan plan + timestamps | Render → `autoUploadAfter` simulates a click on `lsPublishR2Btn` → `uploadFileToR2AndPublish` → `/r2/publish` upserts `SessionAudio` by `session_date` + `SessionAudioTimestamp` | Replace DOM-click glue with a `publishSession({sessionDate, file, timestamps})` service call; session date taken from the recording's manifest (not "today"); resumable upload + server-side idempotent publish |
| R10 | Clean, high-quality audio | 48 kHz float graph, true-peak limiter, LUFS normalisation, TPDF dither | Add quality gates before publish: no clipping, TP ≤ −1 dBTP, LUFS within target, sample-aligned stems; show report |
| R11 | End-to-end automation | Pieces exist, joined by globals and DOM clicks | **"Finish Session" pipeline** (Phase 3b) |

### Storage & compute policy (hard rules)
- **Raw CH1/CH2 stems and DAW projects live on the local SSD only.** Nothing raw is ever uploaded or
  backed up to R2, automatically or manually. There's no option for it in the code.
- **No upload ever starts by itself.** The only path to R2 is the user pressing "Upload to Cloudflare" after
  rendering and previewing the final file.
- **Only the final rendered file** (after editing, in the user's chosen format) is uploaded to R2, plus its
  metadata (session date, title, timestamps) sent to the app DB through `/r2/publish`.
- **All audio computation runs on the laptop** (browser worklets/workers + local bridge). Railway only signs
  R2 URLs, stores DB rows, and forwards the already-encoded live MP3 bytes to listeners (no decoding or
  processing). Cloudflare only stores the final file: no Workers, no transforms.

Code that violates this today and must be removed or changed:
| Where | What it does | Change |
|---|---|---|
| studio.js:5182 → recorder.js:1410 `backupDryStemsToR2` | Uploads raw stems to R2 after recording | Delete function, its checkbox and call sites |
| studio.js:4960 `lsAutoUploadRefCheck` → `artifactRole: "live_ref"` | Auto-uploads the live post-mix MP3 to R2 and publishes it | Delete the upload. The stream copy stays on the SSD only (R12) |
| recorder.js:1314 `uploadAuxObjectToR2` (manifest JSON) | Uploads project manifest to R2 | Keep manifest on SSD; send only the metadata in the publish call |
| recorder.js:1075/1108/1234 → `/r2/upload-part` | Fallback that streams file bytes **through Railway** when direct presigned PUT fails | Remove proxy fallback; use presigned multipart parts straight to R2 (set bucket CORS for the app origin). Delete `r2UploadPart` route |
| daw-ui.js `autoUploadAfter` → clicks `lsPublishR2Btn` after render | Starts an upload without the user pressing the button | Delete; render ends at preview |
| `retryPendingUploads` queue (IndexedDB) | Retries queued uploads | Keep, but only allow `artifactRole: "final"` in the queue |

Server guard: `/r2/presign` and `/r2/upload-init` accept only keys under `sessions/<date>/final/` with audio
content types, and reject anything flagged `raw`, so a client bug can't upload stems.

### Using the laptop's full resources
- Offline render split across Web Workers: one per track (CH1, CH2), then master, encoder in its own worker.
  Long sessions are rendered in chunks so memory stays bounded.
- Local encoders in workers: MP3 (lamejs, or a WASM LAME for speed), FLAC (WASM libFLAC), Opus/AAC via
  WebCodecs `AudioEncoder` where the browser supports it. Linear-phase EQ and true-peak oversampling at full
  quality, since speed isn't capped.
- Bridge: high-priority capture thread, larger ring buffer, exclusive mode. Waveform pyramids built in a worker.
- Recording uses the SSD folder the user picked; show free space and estimated remaining time
  (24-bit/48 kHz stereo pair ≈ 0.5 GB/hour).

> Interface: no attachment arrived. Code comments mention a Behringer 2-in USB interface; on this PC the bridge
> only sees ASIO4ALL and Realtek ASIO. Plug in the interface and run
> `python scripts/local_asio_bridge.py --list` to confirm its pins before Phase 1 testing.

## 1. Current architecture (as found)

| Layer | File | Lines | Role |
|---|---|---|---|
| Live console (everything) | public/js/live-stream-studio.js | 6.2k | config, hardware/bridge client, live graph, meters, broadcast, recording workflow, vault, guards, DOM wiring |
| DAW UI + logic | public/js/live-stream-daw-ui.js | 6.5k | decode/peaks, playback graph, DAW recording, offline render/MP3 export, inspectors, DOM wiring |
| DAW model | public/js/live-stream-daw-engine.js | 1.5k | pure state: clips, tracks, FX slots, automation, undo/redo, manifest (good, testable) |
| DSP math | public/js/live-stream-dsp.js | 3.0k | offline EQ/comp/gate/de-esser/reverb/limiter/LUFS + stateful master (good, testable) |
| Worklets | public/js/live-stream-worklet.js | 0.8k | bp-pcm-capture (MP3 feed), bp-dry-capture (stems), bp-asio-ingest, bp-pro-dsp |
| Recorder / vault / R2 | public/js/live-stream-recorder.js | 1.7k | File System Access/OPFS WAV writing, vault listing, R2 multipart queue |
| Native bridge | scripts/local_asio_bridge.py | 2.6k | WASAPI-exclusive / ASIO COM / WinMM / sounddevice capture → ws://127.0.0.1:17940 |
| Server | controllers/liveStreamController.js (1.0k), services/liveStreamService.js (0.7k) | | start/stop, ingest WS (token), SSE, MP3 fan-out, presets, R2 presign/multipart, projects |

Signal path: Bridge (or getUserMedia) → splitter/pin gains → CH1/CH2 strip (native Biquads + optional
`bp-pro-dsp` worklet + native compressor) → reverb bus → master (5 native EQ bands + `bp-pro-dsp` + limiter)
→ `bp-pcm-capture` → encoder Worker → ingest WS → server → listeners. Stems tapped pre-FX by `bp-dry-capture`
→ postMessage → main thread → recorder → `createWritable()`.

## 2. Test results (2026-11-27)

- `npm test`: **175/175 pass**.
- `scripts/verify_audio_workstation.js`: all synthetic signals clean (no clipping/NaN, TP ≤ −6 dBTP).
- Bridge: compiles; `--list` enumerates ASIO4ALL + Realtek ASIO correctly.
- Gap: studio tests are ~240 `readFileSync(...).includes("...")` source-string checks
  (proAudioWorkstation, liveStreamDawPro, Milestone1–3). They verify text, not behaviour, and **will break on
  any refactor** even when behaviour is preserved. Real hardware/browser paths (recording, broadcast, R2) have
  no automated coverage.

## 3. Problems found (priority order)

**P0 — data loss / correctness**
1. **Recordings are not crash-safe.** Each stem uses one `FileSystemWritableFileStream` opened at start and
   closed at stop (recorder.js:477-487, 696-703). Chrome writes to a `.crswap` swap file and only commits on
   `close()`. A tab crash, browser kill or power loss during a 2-hour bhajan loses **all** stems and master.
   `repairWavFileIfNeeded` cannot help because the file never lands.
2. **Stem PCM goes through the main thread.** Worklet → `postMessage` → main thread → recorder. Heavy canvas/
   UI work or GC stalls delay writes; ScriptProcessor fallback (studio.js:3092) runs on the main thread entirely.
   The redesigned (heavier) UI will make this worse.
3. **Three DSP implementations of the same strip**: native WebAudio nodes (live), `bp-pro-dsp` worklet (live),
   `live-stream-dsp.js` (DAW/offline). Biquad math is duplicated (`computeRbjBiquad` in worklet vs
   `computeBiquadCoeffs` in dsp.js). Live sound ≠ DAW render for the same settings.
4. **Inconsistent strip order**: vocal = HPF→LPF→EQlow→EQmid→proDSP→de-esser→EQhigh→comp;
   instruments = …EQmid→EQhigh→proDSP→comp (studio.js:2874-2959). Native comp stays in the chain and is
   neutralised by parameters, not bypassed structurally — easy to double-compress after a param bug.

**P1 — maintainability**
5. God files: `initAudioEngine` ≈ 800 lines, `wireStudioEvents` ≈ 735, `stopRecordingWorkflow` ≈ 470,
   DAW `wireDawEvents`+context menu ≈ 1.1k. Logic and DOM are interleaved; ~90 mutable module-level `let`s.
   The UI redesign cannot proceed safely on this.
6. Duplicated helpers across studio.js and daw-ui.js (`colorWithAlpha`, `getStudioPalette`,
   `prepareHiDpiCanvas`, `formatPanLabel`, dB/gain conversions).
7. Config schema is implicit (`normalizeStudioConfig`); live presets, DAW track FX and project manifests use
   different shapes (`importLiveMixerSettingsIntoTracks` is a translation layer).
8. Broadcast and recording lifecycles share engine globals; no explicit state machines (idle/arming/recording/
   finalizing/uploading vs offline/connecting/live/reconnecting/stopping).
9. Bridge protocol (hello JSON, `BPAS`/`BPMC` binary packets, commands) is defined only implicitly in two
   languages; no version field check.
10. Controller holds ~500 lines of R2 multipart logic that belongs in a service.

**P2 — hygiene**
11. `setInterval(updateResourceStrip, 2500)` never cleared; verify `releaseAudioEngine` disconnects all nodes,
    worklets, workers, sockets.
12. Stale header in studio.js says "Ch1 Instruments / Ch2 Vocals"; everything else is CH1 Vocals / CH2 Instruments.
13. `scripts/__pycache__/*.pyc` is tracked in git.
14. `docs/architecture.md` is empty.

## 4. Implementation plan

Work on a branch off `develop` **after committing or stashing the current UI WIP** (5 modified files).
Each phase ends with `npm test` green and a manual hardware smoke test (checklist in §5).

### Phase 0 — Safety net (do first)
- Commit/stash UI WIP; branch `refactor/studio-core`.
- Add behavioural tests for pure modules (dsp, daw-engine, wav-utils, recorder with fake OPFS via
  `setTestOpfsRoot`) and Python `unittest` for `route_channels_frame`, `pack_bpas_packet`, `pack_bpmc_packet`.
- **Golden-audio tests**: render fixed config through dsp.js and the worklet processor (run in Node by stubbing
  `AudioWorkletProcessor`/`registerProcessor`); assert output matches within −90 dB.
- Replace source-string tests with behaviour tests module by module as each is extracted (keep the old ones
  until the replacement exists; delete only then).

### Phase 1 — Crash-safe, off-main-thread recording (P0 #1, #2)
- New `live-stream-capture-worker.js` (dedicated Worker) owning all stem/master file writes.
- Transfer a `MessagePort` from main thread to both the worklet and the worker so PCM flows
  worklet → worker directly (main thread out of the audio path).
- Storage strategy:
  - OPFS vault: `createSyncAccessHandle()` in the worker — writes in place, `flush()` every ~2 s.
  - User-picked SSD folder: write **rolling segments** (e.g. 60 s WAV parts, each closed on rotation) plus a
    `session.json` journal; on stop, stitch into final WAV (or keep parts + concat on export). A crash loses at
    most one segment.
  - Rewrite RIFF/data sizes on each flush/segment close so partial files stay valid.
- Record the shared sample-frame clock start in the journal so CH1, CH2 and master stay sample-aligned
  (write BWF `bext` time reference).
- Remove the ScriptProcessor fallback, or keep it only behind a warning (no AudioWorklet = unsupported).
- **Raw stems (R3):** CH1/CH2 raw WAV stems in `.../raw/`. Remove the second master MP3 encoder
  (`recordMasterMp3`/`pushMasterPcm`).
- **Stream copy (R12):** while live, the capture worker appends every encoded MP3 chunk that goes to the
  ingest socket into `.../live/stream.mp3` (MP3 frames are self-contained, so a crash loses at most the last
  flush). Written even if the socket drops, so the copy has no gaps from network loss. Manifest records the
  bitrate and the stream start offset against the stem frame clock (to align it in the DAW).
- **Isolation check (R4):** before Arm, run a 3 s check per pin (level, DC, clipping, cross-correlation between
  CH1/CH2). Block recording if channels are identical (mono-summed) or the browser fallback is in use.
- Recovery: on load, detect unfinished journals → offer to finalize (extend existing vault recovery banner).

### Phase 2 — One DSP model, one implementation (P0 #3, #4, P1 #7)
- Define `studio-schema.js`: `ChannelStrip {trim, hpf, lpf, eq[], gate, deesser, comp, fader, pan, mute, solo,
  sends}`, `MasterBus {eq[], glue, limiter, ceiling, lufsTarget}`, `Routing`, `Session`. Versioned, with
  migrations from current `normalizeStudioConfig` output and existing presets/manifests in the DB.
- Shared math file `live-stream-dsp-core.js` (pure, no DOM): biquad coeffs, comp/gate curves, K-weighting,
  true-peak. Load it with `audioWorklet.addModule()` before the worklet (modules share the global scope), and
  `require`/import it in dsp.js and Node tests.
- Live strip = one `bp-pro-dsp` worklet per channel + one for master implementing the schema exactly; the
  native-node chain stays only as a fallback, with structural bypass (disconnect), not zeroed params.
- Same order for both channels: trim → HPF/LPF → gate → EQ → de-esser (vocal only) → comp → fader → pan.
- DAW uses the same schema per track → `importLiveMixerSettingsIntoTracks` becomes a copy.
- Golden tests from Phase 0 prove live == offline.

### Phase 3 — Split the monoliths into logic modules (P1 #5, #6, #8)
Keep the `window.LiveStudio*` IIFE pattern (no bundler needed) or switch to `<script type="module">`; pick
one and apply it to all files. Target modules, each ≤ ~600 lines, no DOM access except `ui/*`:

```
studio/core/store.js          observable state + events (single source of truth for UI)
studio/core/schema.js         (Phase 2)
studio/hardware/bridge-client.js   ws to 17940, hello/packets, reconnect, device list, pin detect
studio/hardware/devices.js    getUserMedia/setSinkId, channel probing, routing matrix, swap
studio/engine/live-graph.js   build/teardown graph from store state (from initAudioEngine/applyConfigToGraph)
studio/engine/meters.js       peak/RMS/LUFS/GR telemetry → store (no canvas)
studio/broadcast/broadcast.js state machine + encoder worker + ingest socket with backoff
studio/record/recording.js    state machine; drives capture worker (Phase 1)
studio/record/vault.js, r2-upload.js   (from recorder.js)
studio/guards.js              unload/history guards
daw/decode.js, daw/peaks.js, daw/playback.js, daw/render-export.js, daw/daw-recording.js
shared/format.js, shared/canvas.js   deduplicated helpers
ui/*                          current DOM wiring, thin, binds to store (replaced later by new UI)
```
- Broadcast and recording become independent state machines that both consume the master/stem taps, so
  "broadcast + record simultaneously" is a composition, not shared globals.
- Convert `wireStudioEvents` into a declarative binding table (`{selector, event, action}`) → actions on store.
- Clear all timers/RAFs/listeners in a single `dispose()`; leak test: start/stop engine 20× in a test page.

### Phase 3b — "Finish Session" end-to-end pipeline (R7–R11)
One orchestrator (`studio/pipeline/finish-session.js`), every step resumable from the session journal:
1. **End stream** → finalize raw stems → verify (SHA-256, duration match, sample alignment).
2. Raw stems + journal stay in the SSD session folder (`<root>/<date>/<session>/raw/ch1.wav`, `ch2.wav`).
   No upload.
3. **Open the DAW** automatically with both stems as two tracks; live console strip settings imported as the
   starting mix; that date's bhajan plan loaded into the marker picker; the stream copy available as a muted
   reference track.
4. User edits, **adds the bhajan markers** (M key / button at playhead → pick bhajan from the plan), masters.
   Markers follow all edits (engine-level).
5. **Render** in the chosen format preset (WAV 24/16, FLAC, MP3 128–320, Opus/AAC if supported) → quality gate
   → file saved to the SSD (`.../final/`).
5a. **Preview**: the rendered file loads into a player with the markers shown, so the user hears the final
   output. Nothing is uploaded automatically. Remove `autoUploadAfter` (daw-ui.js, the code that clicks
   `lsPublishR2Btn` after render). Re-rendering replaces the preview file.
6. **Upload to Cloudflare** (one button, enabled only after a render exists, pressed by the user after
   preview), then everything below is automatic: the rendered file is also saved to the SSD (`.../final/`), then a resumable
   multipart upload goes **directly** to R2 via presigned URLs → `/r2/publish` upserts `SessionAudio` for the
   manifest's `session_date`, replaces `SessionAudioTimestamp` rows from markers (`submission_id` links each
   to the plan entry) → listeners notified. Idempotent: re-publishing replaces, never duplicates.
7. Save the DAW project (`StudioProject`) so the session can be re-edited and re-published later.
Tests: an end-to-end test with fake stems + fake R2 asserting the DB rows (SessionAudio + timestamps linked to
the plan) after one `finishSession()` call.

### Phase 7 — FL Studio-style DAW (engine + workflow; visuals come with the UI redesign)
Match FL's **workflow and tool set**, built with an original look. Don't use FL's names, graphics or plugin
names: the workflow can be copied, the trade dress and branding can't.

**Workflow model to adopt (engine changes in `live-stream-daw-engine.js`)**
- **Playlist**: clips placed freely on any lane. CH1/CH2 stay the two primary audio tracks; extra lanes are
  allowed for bounces, the stream reference and automation clips.
- **Mixer with inserts**: separate from playlist lanes. Each lane routes to an insert; each insert has 10 FX
  slots, a fader, pan, stereo separation, phase invert and a mix-level knob per slot; sends between inserts
  and to the master; sidechain routing (e.g. vocal ducks instruments). Routing is validated as a DAG.
- **Automation clips**: automation as timeline objects that can be linked to any plugin or mixer parameter
  (replaces the per-track lanes; old manifests are migrated).
- **Plugin windows** with per-plugin presets, A/B compare, randomise off, undo per change; **plugin delay
  compensation** across inserts.
- **Audio editor** (destructive, per clip, like FL's sample editor): normalise, fade shapes, reverse,
  declick, spectral noise reduction, time-stretch/pitch with formant preservation, loop/cut at zero crossings.
- **Browser**: the SSD session vault, presets and rendered files in one tree, with drag to playlist.
- Not adopted (MIDI/beat-making, not relevant to live bhajan recordings): channel rack step sequencer,
  piano roll, patterns. Can be added later if loops or virtual instruments are wanted.

**Best-quality tools (all run on the laptop)**
| Need | Choice | Why |
|---|---|---|
| Built-in plugins (EQ, comp, gate, de-esser, limiter, reverb, delay, saturation) | Rewrite the DSP core in **Faust** or **Rust → WASM** (64-bit internal, oversampled nonlinear stages); the same binary runs in AudioWorklet (preview) and Workers (render) | Preview = render, bit for bit; native-like speed and precision |
| Pro third-party plugins (FabFilter, iZotope, Waves, etc.) | **VST3 host in the local bridge** using Spotify's `pedalboard` (JUCE-based Python library: loads VST3, shows the plugin's own window, renders offline and in real time) | The only way to reach studio-grade plugins from this stack. Note: pedalboard is GPLv3, fine for local use; check the licence before distributing the bridge |
| Time-stretch / pitch | Rubber Band (WASM; GPL or commercial licence) or SoundTouch (LGPL) | Industry-standard stretch quality |
| Noise reduction / declick | Spectral gating in WASM worker (the method behind the `noisereduce` library) + click detection | Removes hall hiss and fan noise without speech-only models |
| Loudness / true peak | Keep the current BS.1770 code; verify against **libebur128** in tests | Measurement must match broadcast tools |
| Encoders | WASM LAME (MP3), libFLAC (FLAC), WebCodecs Opus/AAC | Full quality, local, multi-core |

Delivery order: 7a engine model (mixer inserts, sends, PDC, automation clips, manifest migration) →
7b WASM DSP core + golden tests vs current dsp.js → 7c audio editor tools → 7d VST3 host via bridge
→ 7e UI (with the redesign).

**Decision (2026-11-27): VST3 hosting is in scope (7d), as an optional add-on.**
- Built-in WASM plugins remain the default and cover everything on their own; VST3 adds flexibility on top.
- Bridge checks for `pedalboard` at start-up. If it's missing, the DAW offers a one-click
  `pip install pedalboard`; VST3 features stay hidden until it's installed. Nothing else depends on it.
- Bridge scans the standard VST3 folder (`C:\Program Files\Common Files\VST3`) and lists plugins in the
  DAW browser. Any insert slot can hold a built-in or a VST3 plugin.
- Each VST3 slot stores its plugin ID and full state (preset chunk) in the project, so a session reopens
  exactly. A missing plugin is shown as "offline" and bypassed, never silently dropped.
- Preview: tracks with VST3 slots are processed in the bridge and streamed back to the DAW (same ws path as
  ASIO ingest, reversed) with latency reported for PDC. Render: the bridge renders those tracks offline at
  full quality and returns the stems to the browser for mastering/encoding.
- Free, high-quality VST3s to start with (no cost): TDR Nova (dynamic EQ), Valhalla Supermassive (reverb),
  LSP Plugins (open source: EQ, compressors, limiter, gate), Airwindows (MIT: console, saturation,
  mastering tools), Voxengo SPAN (spectrum analyser).

### Phase 4 — Bridge cleanup (P1 #9)
- Split `local_asio_bridge.py` into a package: `protocol.py` (packets, hello, commands, `PROTOCOL_VERSION`),
  `backends/{wasapi_exclusive,asio_com,winmm,sounddevice}.py`, `routing.py`, `server.py`, `cli.py`.
- Write `docs/bridge-protocol.md`; JS client rejects/warns on version mismatch.
- Add telemetry fields: xruns/dropped blocks, clock drift vs 48 kHz, buffer depth → shown later in UI.
- Untrack `__pycache__`, add to `.gitignore`.

### Phase 5 — Server
- Move R2 presign/multipart/publish from the controller into `services/r2UploadService.js`; controller only
  validates and calls the service.
- Validate key prefixes (`sessions/<date>/final/` only), part counts and content length on presign;
  rate-limit upload endpoints. Remove the `/r2/upload-part` byte proxy (see storage policy).
- Ingest WS: keep token auth; add heartbeat/idle timeout and a "source lost" SSE event for listeners.

### Phase 6 — Docs & cleanup (P2)
- Fill `docs/architecture.md` (diagram from §1, schema, protocol, state machines).
- Fix stale channel comment; remove dead code found during extraction.

## 5. Manual verification checklist (per phase)
1. Bridge `--list`, connect, select interface, ASIO and WASAPI paths.
2. CH1/CH2 isolated signal (tone in one input only → only that meter moves); swap works.
3. Record 10 min CH1+CH2+master; kill the tab mid-way → recovery yields valid WAVs (Phase 1+).
4. Stems sample-aligned (null test vs master with DSP bypassed).
5. Go live + record simultaneously 30 min; listener hears stream; no dropouts; files intact.
6. DAW: open recording, edit, mix, export WAV/MP3; LUFS within ±0.5 of target.
7. R2 upload + publish; resume after network drop.

## 6. Order and effort (rough)
Phase 0 (2-3 d) → Phase 1 (3-4 d, highest value) → Phase 2 (4-5 d) → Phase 3 (5-7 d, can overlap Phase 2)
→ Phase 3b (3-4 d) → Phase 4 (2-3 d) → Phase 5 (1-2 d) → Phase 6 (1 d) → Phase 7a-d (3-5 weeks; 7d alone about 1-2 weeks). The UI redesign should start after Phase 3, binding to
`studio/core/store.js` instead of today's DOM-coupled code.
