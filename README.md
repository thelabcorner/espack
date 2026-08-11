<div align="center">

# ESPACK: Self-Extracting ExternalObject Bundles for Adobe ExtendScript (ES3)

## ExtendScript PACKer = E.S.PACK

### The build-time packer + ES3 self-extracting loader that ships ExternalObject DLLs inside a single `.jsx` for Adobe Illustrator, InDesign, Photoshop & any ExtendScript host

[![Parity: byte-exact native/ES3](https://img.shields.io/badge/parity-byte--exact%20native%2FES3-success)](#performance)
[![Tests: 33 Node + 50%2B live](https://img.shields.io/badge/tests-33%20Node%20%2B%2050%2B%20live-purple)](#validation)
[![Native: x64 Windows](https://img.shields.io/badge/native-x64%20Windows-blue)](#compatibility)
[![Adobe: Creative Suite](https://img.shields.io/badge/Adobe%20-Creative%20Suite-red?logo=adobe&logoColor=white)](https://extendscript.docsforadobe.dev/)
[![Engine](https://img.shields.io/badge/ExtendScript-ES3-green)](#compatibility)
[![License: GPL-3.0-or-later](https://img.shields.io/badge/license-GPL%203.0--or--later-blue)](https://www.gnu.org/licenses/gpl-3.0.html)

</div>

---

## Part Of The Same Toolkit

> Production-grade ExtendScript infrastructure for Illustrator-era JavaScript engines.

<table>
<tr>
<td width="50%" valign="top">

### Runtime Primitives

**[ESON](https://github.com/thelabcorner/eson)**  
Strict RFC 8259 JSON for ExtendScript.

**[ESB64](https://github.com/thelabcorner/es-b64)**  
Base64 and UTF-8 utilities.

**[ESARR](https://github.com/thelabcorner/es-arr)**  
ES5+ Array compatibility methods.

**[ESSTR](https://github.com/thelabcorner/es-str)**  
String whitespace and trim methods.

**[ESCHARS](https://github.com/thelabcorner/es-chars)**  
Native bulk byte operations.

**[ESHTTP](https://github.com/thelabcorner/es-http)**  
HTTP transport for ExtendScript automation.

</td>
<td width="50%" valign="top">

### Build & Integration Tools

**[ESPACK](https://github.com/thelabcorner/espack)**  
Self-extracting ExternalObject bundles.

**[ESMIN](https://github.com/thelabcorner/es-min)**  
Minification for shipped JSX bundles.

**ESOBF** <sub>coming soon</sub>  
Obfuscation for hardened JSX distribution.

</td>
</tr>
</table>

Also from the same team: **[ArcFit.dev](https://arcfit.dev)**, deterministic arc warp for Illustrator.

---

## Table of Contents

- [Why ESPACK?](#why-espack)
- [Features](#features)
  - [Real-world adoption](#real-world-adoption)
- [Get the Release](#get-the-release)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [API](#api)
- [Validation](#validation)
- [Performance](#performance)
- [Security Model](#security-model)
- [Compatibility](#compatibility)
- [Engine quirks that shaped the design](#engine-quirks-that-shaped-the-design)
- [Development](#development)
  - [Vendored esb64 (modularity)](#vendored-esb64-modularity)
- [Repository layout](#repository-layout)
- [Credits](#credits)
- [License](#license)

---

## Why ESPACK?

ExternalObject requires a **file path** — there is no in-memory DLL load. Every library that wants a native lane (esb64, eson, eschars) therefore has to ship a DLL next to the script, or materialize it at runtime. ESPACK is the materializer: a build-time packer + ES3 self-extracting loader so ExternalObject DLLs ship **inside a single `.jsx`** and materialize on disk at runtime, in the **"1 + n" model**:

- **1 shared esb64 accelerator DLL** (vendored at `vendor/ESB64Native.dll`, inlined as base64 into every bundle by default). It is unpacked **once per system** (`%LOCALAPPDATA%\espack\ESB64Native_v<v>.dll`) using the bundle's inlined ES3 base64 lane, then loaded via `ExternalObject` and reused by every espack bundle on that machine.
- **n payload DLLs** (`--embed`, repeatable; each `name_v<version>.dll` in the per-bundle cache dir `%LOCALAPPDATA%\<bundle-name>\`). Every payload is decoded **by the accelerator** (`b64decodeToFile`: native decode written straight to disk — NUL-safe, no string channel), so payload extraction is microseconds instead of ~140 ms of JSX-lane decoding.

Runtime order: start in ES3 mode → the inlined lane unpacks the accelerator (only if it is not already on the system) → the accelerator natively unpacks every payload → all DLLs load via `ExternalObject`. If the accelerator is unavailable (read-only cache, locked host), payloads fall back to the JSX lane transparently with the reason surfaced on `ESPAK.lastError()`.

**Accel-less bundles still get the native lane when the shared accelerator is already on the system.** A bundle built with `--no-accel` discovers the canonical shared accelerator at `%LOCALAPPDATA%\espack\ESB64Native_v1.dll` (the exact path every accel-carrying bundle materializes) and reuses it for native payload decode — no composition change needed. If the file is absent, cannot be loaded, or is not the ESB64Native accelerator (no `b64decodeToFile`), payloads fall back to the JSX lane with the reason surfaced. The same fallback applies when an *embedded* accelerator cannot be extracted (e.g. read-only cache) but the shared one is already on disk. This is what makes merged/accel-less bundles fast on machines that have run any accel-carrying bundle.

---

## Features

- **Single-file distribution**: the packer inlines the shared accelerator and every payload DLL as base64 into one self-contained `.jsx` — no `$.evalFile`, no `#include`, no references to DLL or vendor paths. Runtime always materializes the DLLs on disk (`ExternalObject` requires a file path; there is no in-memory load).
- **A complete esb64 ships inside every bundle, by construction.** The JSX extractor IS the vendored esb64 runtime lane (`vendor/esb64-runtime.js` — WHATWG-exact `atob`/`btoa`, the same code esb64 ships) — the bundle cannot exist without it, because it decodes its own payloads. Once the shared accelerator is materialized and loaded, the same codec is also available natively (`b64encode`/`b64decode`/`b64decodeToFile`). A script that evals an espack bundle already has base64 — use it (see [API](#api)) before vendoring a second copy.
- **"1 + n" model**: one shared esb64 accelerator unpacked once per system (reused by every espack bundle on the machine); every payload decoded natively by `b64decodeToFile` — **3-10 µs** instead of ~140 ms of JSX-lane decoding (measured, live).
- **Byte-exact BINARY I/O**: file `"BINARY"` reads/writes round-trip **all 256 byte values** including NULs (the surrogate window is a JS↔native *string-channel* problem, not a BINARY-file problem — verified).
- **Versioned, GC'd cache**: extracted files are `<name>_v<version>.dll`, extracted once, **never deleted while loaded** (locked until host exit); older versions are GC'd best-effort after a successful extraction, scoped per DLL name.
- **Arbitrary-file payloads** (`kind=file`): `--embed` accepts **any file** — EXEs, PNGs, fonts, JSON, anything. The original extension is preserved in the versioned cache name (`Tool_v1.exe`), extraction is byte-exact through the same native/JSX lanes, and GC works identically. Non-DLL payloads are materialized via `ESPAK.extract(i)` / `ESPAK.payloadPath(i)`; `ESPAK.load(i)` rejects them with a clear `kind=file` error instead of ever feeding a non-DLL to `ExternalObject`. DLL payloads are unchanged and byte-compatible with v0.3.0.
- **Deterministic output**: the emitted bundle contains no timestamps; identical input produces byte-identical output.
- **The `attach` capability switch**: the consumer pattern esb64 and eson use — the library's ES3 impls stay in place until the native lib is loaded and the native impls are built; any failure keeps the bundle in ES3 mode with the reason surfaced, never a thrown consumer-facing error.
- **Zero dependencies**: the packer is Node ESM with no runtime deps; the emitted loader is ES3-clean.

### Real-world adoption

#### Integration: esb64 (first consumer — complete)

esb64's own bundle is the accelerator-only form: `--accel ESB64Native.dll`
with no payloads. Its ES3 runtime is its own extractor (self-referential),
and once the shared accelerator is on disk/loaded, `btoa`/`atob` switch to
the native lane via `ESPAK.attach`. Parity policy (user-approved):
**differential-corpus parity** — verified live: the same 66-vector WHATWG
battery passes byte-identically in ES3 mode and in native mode
(`esb64: npm run live-verify`). Measured acceleration: `btoa` 16 K:
18.6 ms → 317 µs (**58.5×**); `atob` 48 K: 66.8 ms → 957 µs (**69.8×**).

Design constraint honored from the skill's measured channel rules: the
kTypeString return channel truncates at the first NUL, so a native `atob`
whose decoded output contains NULs cannot round-trip — the native lane
returns a `kTypeUndefined` sentinel for NUL-containing outputs and the facade
falls back to the ES3 lane transparently (e.g. `atob("AA==")` still yields
`"\u0000"` exactly). Payload extraction avoids the channel entirely via
`b64decodeToFile`.

Build the accelerated bundle with: `cd esb64 && npm run native-build && npm
run build:accel` → `esb64/dist/ESB64.accel.jsx` (self-extracting single
file; accelerator in the shared `%LOCALAPPDATA%\espack\` dir).

#### Integration: eson (second consumer — complete)

`eson` ships as `dist/ESON.accel.jsx`: `ESONJson.dll` is the espack payload
(+ the shared esb64 accelerator), the bundle auto-enables ESON's native
parse gate with the espack-provided lib (`ESON.useEspack()`, outcome on
`ESON.espack`). Live-verified on Illustrator 30.6.0 (`cd eson && npm run
build:accel && npm run accel-live`): gate enabled + certified (71 cases),
gate-ON vs gate-OFF verdict parity on 28 valid/invalid cases, byte-exact
extraction. Measured: gate-ON parse ≈ 191 µs vs gate-OFF ≈ 179 µs at
49 KB — parity-speed (ESON's current pre-scan is ~3.7 µs/KB; the historical
14-17× native win was against the old pre-scan) — the gate's value is the
certified RFC-exact native verdict + single-file delivery.

The integration also fixed an ESON core bug the live runs exposed: the ES3
engine truncates property names at U+0000, so ESON's parse memo collided on
raw-NUL texts (the invalid case `{"a":1}\u0000,1` poisoned parses of the
valid `{"a":1}`). Fixed in `eson/src/parse.ts` (NUL texts never memoized).

---

## Get the Release

<div align="center">

**All production bundles ship as GitHub release assets — this repo holds the packer. Grab the runnable demo bundle from the [Releases page](https://github.com/thelabcorner/espack/releases).**

[![Latest stable](https://img.shields.io/github/v/release/thelabcorner/espack?label=Latest%20stable)](https://github.com/thelabcorner/espack/releases/latest)
[![Release date](https://img.shields.io/github/release-date/thelabcorner/espack?label=Released)](https://github.com/thelabcorner/espack/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/thelabcorner/espack/total?label=Downloads)](https://github.com/thelabcorner/espack/releases)

</div>

**How it works, in three steps:**

1. Open the [Releases page](https://github.com/thelabcorner/espack/releases).
2. Pick the **latest stable** tag (top of the list — today that is `v0.4.0`).
3. Download the asset that matches your use case:

| You are... | Take this release | And this asset |
|---|---|---|
| Trying the 1+n model end-to-end | **Latest stable** | `ESPAK-demo.accel.jsx` — runnable demo bundle with the shared accelerator |
| Building your own bundle | Latest stable | Build from source: `node espack-build.mjs` (this repo holds the packer, not release bundles) |

---

## Installation

The packer is a build-time tool, used from Node:

```bash
git clone ... # or copy the espack/ folder from the family checkout
cd espack
npm install        # zero runtime deps; devDeps only for tests
npm run vendor-sync  # refresh vendor/ from the sibling esb64 build (optional)
```

---

## Quick Start

```bash
node espack-build.mjs --embed path/to/MyDll.dll --embed OtherDll.dll=2 \
     --embed path/to/Tool.exe --embed path/to/logo.png \
     --out dist/MyBundle.jsx --name mybundle
```

Emits `dist/MyBundle.jsx` — a single self-contained file. Drop it into any
Illustrator/ExtendScript host (File > Scripts, `$.evalFile`, or
COM/automation `eval --file`); on first eval it materializes the shared
accelerator (once per system) and the payload DLLs (once per bundle), then
loads them via `ExternalObject`.

---

## Composition & merge (manifest-assisted)

ESPAK composes several bundles into ONE at build time — the model the family
uses to ship eson + esarr + arcfit as a single composed file with one loader,
one shared accelerator, and N payloads.

### The manifest contract (schema v1)

`espack-build.mjs --manifest-out <path>` emits a deterministic sidecar
manifest (fixed key order, no machine paths):

```json
{
  "format": "espack-manifest",
  "version": 1,
  "bundleName": "eson",
  "cacheDir": "",
  "chunkSize": 24576,
  "accel": { "name": "ESB64Native", "version": "1", "len": 9728, "b64": "...", "fileName": "ESB64Native_v1.dll" },
  "payloads": [ { "name": "ESONJson", "version": "1", "len": 103424, "b64": "...", "fileName": "ESONJson_v1.dll" } ]
}
```

`accel` is `null` for `--no-accel` bundles. The manifest is the merge input;
it is never loaded at runtime.

### Merging

`espack-merge.mjs --merge <m1.json> <m2.json> ... --out <bundle.jsx>` reads
the manifests and re-renders ONE loader with ONE shared accelerator and N
payloads. Merge happens **pre-minify/pre-obfuscate** — the merged bundle is
the normal deterministic output, so minified/obfuscated variants are produced
by the same downstream pipeline as any other bundle. Collision policy (hard
errors, not warnings):

- same payload name+version+same b64 → dedupe (keep one)
- same payload name+version+different b64 → HARD ERROR
- same payload name, different version → keep the higher integer version
  (non-integer versions → HARD ERROR)
- accel: all manifests' accel must be identical (name+version+len+b64) or
  HARD ERROR; `null` accel is allowed (merged bundle accel-less → warn — the
  loader still discovers the shared accelerator on the system)
- merged bundle name defaults to the FIRST manifest's bundleName; its cache
  dir is reused, so payloads already extracted there are skipped

### Composition model

Four layers:

1. **Runtime** — one loader per composed file (the emitted `ESPAK` facade).
2. **Tooling** — `espack-build --manifest-out` + `espack-merge`.
3. **Consumers** — manifest + loader-free facade artifacts; adapters load by
   payload NAME (`ESONJson` / `ESARRArray` / `ArcFit_IPC`), never `load(0)`.
4. **Composer** — the build script (e.g. arcfit `build.mjs`) runs
   `espack-merge`, then appends the consumer facades.

Facade ordering: `$.global.ESPAK` is **last-wins** — the merged bundle must be
evaluated LAST in the injection order so its facade (all payloads) is the
active one. Cache migration: payloads move from `%LOCALAPPDATA%\<old-bundle>`
to the merged dir; old extracted files become stale but harmless (GC is
scoped per DLL name inside the merged cache dir only, so the merged bundle
never deletes the old bundles' files).

---

## API

ESPAK has two API surfaces: the build-time **packer CLI** and the runtime
**`ESPAK` facade** the emitted bundle defines.

### The packer CLI

```
node espack-build.mjs --embed <dll>[=<ver>] [--embed <dll2>[=<ver>] ...] \
     --out <bundle.jsx> \
     [--name <bundle-name>]        # cache-dir segment; default = out stem
     [--dll-version <v>]           # default version for --embed payloads
     [--cache-dir <abs>]           # override for the per-bundle payload dir
     [--accel <dll> | --no-accel]  # default: vendor/ESB64Native.dll
     [--accel-version <v>]         # shared accelerator version (v1, v2, ...)
     [--accel-dir <abs>]           # override for the shared accel dir
     [--standalone]                # prepend `#target illustrator`
     [--quiet]
```

Environment: `ESB64_RUNTIME_PATH` overrides the inlined atob lane source;
`ESB64_ACCEL_PATH` overrides the accelerator. Output is deterministic (no
timestamps). The emitted bundle is self-contained: no `$.evalFile`, no
`#include`, no references to the DLL or vendor paths.

### The emitted bundle (`ESPAK` facade)

The bundle defines the global `ESPAK` (installed on `$.global` so COM-eval'd
bundles persist across `DoJavaScript` calls):

```js
ESPAK.config;             // { bundleName, cacheDir, chunkSize,
                          //   accel: { name, version, fileName, len, dir } | null,
                          //   payloads: [{ name, version, fileName, len }] }
ESPAK.load(i);            // load payload i (index or name; default 0); extract-if-
                          //   needed -> new ExternalObject; { ok, mode, lib, path }.
                          //   Rejects kind=file payloads (not loadable DLLs).
ESPAK.extract(i);         // { ok, lane: "native"|"jsx"|"skip", path } - materialize any
                          //   payload (DLL or arbitrary file) to the cache dir
ESPAK.isExtracted(i);     // file exists && size matches (size + versioned name)
ESPAK.mode();             // "es3" | "native"
ESPAK.lastError();
ESPAK.accelReady();       // accelerator loaded (only needed for extraction)
ESPAK.accelExtractMs();   // JSX-lane accelerator extraction µs (-1 = skipped/absent)
ESPAK.nativeExtractMs();  // native payload extraction µs (-1 = JSX lane used)
ESPAK.extractMs();        // last payload extraction µs (either lane)
ESPAK.loadMs();
```

Cache directories: payloads in `%LOCALAPPDATA%\<bundle-name>\`, the shared
accelerator in `%LOCALAPPDATA%\espack\` (per-user, writable — verified from
JSX; per-segment directory creation is used). Extracted files are
`<name>_v<version>.dll`, extracted once, **never deleted while loaded**
(locked until host exit). After a *successful* extraction of a newer
version, older `<name>_v*.dll` files are GC'd best-effort (locked files fail
silently and survive until the host exits — verified live). GC masks are
scoped per DLL name, so different DLLs in the same directory never touch
each other. Loaded libraries are cached on `$.global.__ESPAK_LIBS__` keyed
by path.

#### Arbitrary-file payloads (EXEs, assets, anything)

`--embed` accepts **any file**, not just DLLs. Non-DLL payloads are tagged
`kind=file`: the original extension is preserved in the versioned cache name
(`Tool_v1.exe`), extraction is byte-exact via the same native (`b64decodeToFile`)
or JSX lanes, and GC works identically. They are **never** handed to
`ExternalObject` — use `extract()` + `payloadPath()` instead:

```js
var x = ESPAK.extract('Tool');          // { ok: true, lane: "native", path }
if (x.ok) {
  var exe = new File(x.path);           // Tool_v1.exe in the cache dir
  exe.execute();                        // spawn it (Windows)
}
var r = ESPAK.load('Tool');             // { ok: false, error: "...kind=file..." }
// load() rejects kind=file payloads with a clear error - no ExternalObject.
```

Typical use: ship a freestanding helper EXE (or a logo PNG, a font, a JSON
asset) inside the same self-extracting bundle as your DLLs — the Scripts
folder stays `.jsx`-only and everything materializes on first use. DLL
payloads are unchanged and byte-compatible with v0.3.0 (no `kind` is emitted
for them in bundles or manifests).

#### Base64 is built in — use it

Every bundle carries esb64 (see [Features](#features)): the WHATWG-exact ES3
lane inlined as the extractor, and — once the shared accelerator is on disk
and loaded — the same codec natively. Two ways to reach it:

```js
// 1. direct native calls, once the lib is loaded:
var r = ESPAK.load(0);
if (r.mode === "native") {
  var b64 = r.lib.b64encode("Hello World");   // "SGVsbG8gV29ybGQ="
  var raw = r.lib.b64decode(b64);             // "Hello World"
}
// r.lib.b64decodeToFile(b64, path) writes bytes straight to disk (NUL-safe)
```

```js
// 2. the capability switch — full atob/btoa contract, ES3-first:
ESPAK.attach({
  es3: { atob: myEs3Atob, btoa: myEs3Btoa },
  buildNative: function (lib) {
    return { atob: function (s) { return lib.b64decode(s); },
             btoa: function (s) { return lib.b64encode(s); } };
  }
});
// mode "es3" keeps your impls; mode "native" swaps in the lib-backed ones
```

If you need a ready-made full facade, esb64's own accelerated bundle
(`ESB64.accel.jsx`, shipped in esb64 v1.1.0) is the reference
implementation of this exact pattern.

#### The capability switch (`attach`)

The core pattern for consumer libraries (esb64 first — see above):

```js
var result = ESPAK.attach({
  es3: { atob: es3Atob, btoa: es3Btoa },          // the library's fallback impls
  buildNative: function (lib) {                     // returns native impls
    return { atob: function (s) { return lib.b64decode(s); },
             btoa: function (s) { return lib.b64encode(s); } };
  },
  onMode: function (mode, lib, impl) { ... }        // swap point
}, 0);                                               // payload index (default 0)
// result = { ok, mode, lib, impl, path, error } — impl is the active set
```

Order: start in ES3 → `load()` → on success build the native impls → swap;
on any failure stay in ES3 with a surfaced `lastError`. `attach` never
throws to the consumer.

---

## Validation

| Check | Command | Result |
|---|---|---|
| Packer units + loader logic in a vm sandbox (stubbed `File`/`Folder`/`ExternalObject`/`$`) — 1+n sharing, shared-accel discovery, chunk-boundary mirror, failure paths | `npm test` | 33/33 + vendor-sync drift guard |
| Live end-to-end on Illustrator via the COM tool — 1+n extraction, sharing, skip-extract, version bumps, GC across sessions, failure paths, multi-payload load-by-name, merged-bundle accel dedupe, cache migration, facade ordering | `npm run e2e` | 60+ live checks (requires COM tool + an automation instance) |
| Vendored esb64 artifacts match upstream (runtime lane + accelerator) | `npm test` (vendor-sync guard) | drift-guarded |

The e2e suite runs: fresh system → v1 (accel JSX extraction + native payload
extraction + smoke + byte-exact) → skip-extract re-run → v2/v3 bumps (accel
never re-extracted; locked versions survive GC) → failure path (blocker
cache dir → clean es3 fallback) → fresh instance (GC removes all stale
versions) → **1+n cross-bundle sharing** (lib1 unpacks the shared accel,
lib2 reuses it untouched, both payloads byte-exact).

---

## Performance

All measurements live on Illustrator 30.6.0 / ExtendScript 4.5.6 via COM
(2026-08-07). Medians of 3 fresh inputs per size.

### ESB64 atob decode (chunk sizes, base64 chars → µs)

| Input | 16,384 | 24,576 | 32,768 | 49,152 | 65,536 |
|---|---|---|---|---|---|
| decode µs | ~16,000 | ~25,000 | ~32,000 | ~49,000 | ~65,000 |

Linear, no engine wedge through 64 K (the encode-path wedge threshold is
128 K — decode is a different implementation and must not be assumed to
transfer; measured). **Chunk = 24,576 chars** (≈25 ms/pass).

### 1 + n extraction (live end-to-end)

| Step | Lane | Measured |
|---|---|---|
| Accelerator extraction (first ever on a system) | JSX (chunked atob) | ~151-168 ms |
| Payload extraction (any bundle, any version) | native `b64decodeToFile` | **3-10 µs** |
| Second bundle on the same system | accel skipped (exists + size match) | 0 µs |
| Load (skip-extract path) | — | ~1.2-1.9 ms |

Full DLL payload decode check (99,328 bytes → 132,440 base64 chars): chunked
JSX ~132 ms across 6 chunks of 24,576; window-sums matched Node exactly;
extracted files verified byte-exact vs the source DLL (`Buffer.equals`).

### File BINARY fidelity (measured, previously unverified)

- 512-unit round trip of bytes 0x00–0xFF ×2: byte-exact, `firstMismatch = -1`.
- 98,304-unit round trip: file length 98,304, window sums + samples matched
  Node, byte-exact. NULs survive; the surrogate-window caveat does NOT apply
  to BINARY file I/O (it is a UTF-8 string-channel issue).

### %LOCALAPPDATA% writes (measured, previously unverified)

`Folder.create()` on nested missing parents succeeded live (contradicts the
documentation claim that parents are not created — the loader uses
per-segment creation anyway for cross-version robustness). Writes and file
lengths verified.

### Load-bearing decisions from the handoff, resolved by data

| Question | Decision | Evidence |
|---|---|---|
| Chunk size | 24,576 | linear decode; ~25 ms/pass; ≪ wedge threshold |
| Write strategy | native decode-to-file; JSX per-chunk writes as fallback | byte-exact (both) |
| Integrity | size + versioned name | cheap; partial writes caught (verified: wrong-size file triggers re-extraction) |
| Cleanup | versioned names, GC best-effort, never delete loaded | locked files survive until host exit (verified live) |
| Cache dirs | payloads `%LOCALAPPDATA%\<bundle>\`, accel `%LOCALAPPDATA%\espack\` | writable, per-user |

---

## Security Model

ESPAK extracts and loads native DLLs at runtime, so the trust surface is
concrete and bounded:

- **No remote fetch, ever.** Everything that materializes on disk comes from
  the bundle's own embedded base64 (build-time inlined from local files).
  The extractor is either the bundle's inlined ES3 base64 lane or the
  embedded accelerator's `b64decodeToFile` — no other code runs during
  extraction.
- **Per-user, writable cache only.** DLLs land in `%LOCALAPPDATA%\<bundle-name>\`
  and `%LOCALAPPDATA%\espack\` — no elevation, no writes outside the user
  profile (verified from JSX; per-segment directory creation is used).
- **Extraction is verified before use.** Integrity is checked by file size +
  versioned name; a wrong-size file (partial/corrupt write) triggers
  re-extraction and is never loaded.
- **Versioned + GC'd.** Old versions are removed only after a successful
  extraction of the newer one, best-effort, scoped per DLL name; a loaded
  DLL is never deleted (the host locks it until exit).
- **Fail-open posture.** If the accelerator is unavailable (read-only cache,
  locked host, missing `ExternalObject`), payloads fall back to the JSX lane
  transparently with the reason surfaced on `ESPAK.lastError()` — the bundle
  degrades to pure ES3, it never executes a half-extracted DLL.
- **No code execution beyond the embedded payloads.** The DLLs that load are
  exactly the ones the packer embedded at build time; `attach` swaps in
  native impls only after `load()` succeeds.

---

## Compatibility

| Target | Status |
|---|---|
| Windows x64 (PE64 DLLs) | Required — ExternalObject loads local files only; no macOS scope |
| Adobe Illustrator 30.6.0 | Verified live (extraction, load, attach, GC, failure paths) |
| ExtendScript ES3 (the emitted loader template is ES3-clean) | Bundled |
| Node.js (ESM, no deps) | Build-time packer + test harnesses |

---

## Engine quirks that shaped the design

Measured on Illustrator 30.6.0 (ExtendScript 4.5.6) — see
[Performance](#performance):

- Pure-JSX per-unit string loops wedge the engine at ≥128 K input; a 90 KB DLL
  is ~132 K base64 chars — **the runtime decode must be chunked**.
- The esb64 `atob` lane decodes **linearly (~1 µs/base64 char, no wedge
  through 64 K passes)** — chunking to 24,576 chars per pass is conservative.
- File `"BINARY"` I/O round-trips all 256 byte values byte-exact (incl. NULs;
  the surrogate window is a JS↔native *string-channel* problem, not a
  BINARY-file problem).
- **The JSX lane is a one-time system cost**: the accelerator (~155 ms) is
  decoded once per machine; every payload afterwards decodes natively in
  **~5-10 µs** (measured end-to-end inside Illustrator).
- A loaded DLL stays locked until the host exits (LNK1104) — hence
  versioned filenames + best-effort GC of older versions.

---

## Development

```
npm install              # devDeps only (esbuild + typescript for tests/build)
npm run build            # bundles src/loader.jsx -> dist bundles via espack-build.mjs
npm test                 # 33 Node tests (packer + vm loader logic incl. 1+n sharing +
                         #   shared-accel discovery + chunk mirror) + vendor-sync drift guard
npm run e2e              # 50+ live checks on Illustrator (requires COM tool + an
                         #   automation instance; kills stale automation instances first)
npm run vendor-sync      # refresh vendor/ from the sibling esb64 build
```

### Vendored esb64 (modularity)

`vendor/` carries the two esb64 artifacts every bundle needs, so espack
builds standalone (no sibling-repo dependency):

| File | Source (upstream esb64 build) | Purpose |
|---|---|---|
| `vendor/esb64-runtime.js` | `esb64/dist/vendor-esb64-runtime.js` | The inlined atob/btoa lane (the JSX extractor) |
| `vendor/ESB64Native.dll` | `esb64/native/bin/ESB64Native.dll` | The shared WHATWG-exact accelerator (`b64encode`/`b64decode`/`b64decodeToFile`) |

Refresh: `npm run vendor-sync` (copies from `../esb64`, or `ESB64_RUNTIME_SRC`
/ `ESB64_NATIVE_SRC`). `npm test` includes the drift guard
(`tests/vendor-sync-test.mjs`).

---

## Repository layout

| Path | Purpose |
|---|---|
| `espack-build.mjs` | The packer (Node ESM, no deps): embed(s) + accel → single-file JSX. `build()` is exported for tests |
| `src/loader.jsx` | The ES3 loader template (`__TOKENS__` replaced at build time) |
| `vendor/` | Vendored esb64 artifacts: `esb64-runtime.js` (the inlined atob lane) + `ESB64Native.dll` (the shared accelerator) — refreshed via `npm run vendor-sync`, drift-guarded by `tests/vendor-sync-test.mjs` |
| `tests/espack-test.mjs` | Node-side suite: packer units + loader logic in a vm sandbox (stubbed `File`/`Folder`/`ExternalObject`/`$`) + chunk-boundary mirror |
| `tests/espack-e2e.mjs` | Live end-to-end on Illustrator via the COM tool (1+n extraction, sharing, skip-extract, version bumps, GC across sessions, failure paths) |
| `probes/espack-measure-prep.mjs` | The measurement generator that produced the evidence below |
| `dist/` | Built bundles (gitignored) |

---

## Credits

ESPAK stands on the shoulders of the ExtendScript community:

- **[docsforadobe](https://github.com/docsforadobe) and the docsforadobe.dev community:** maintainers of the de-facto reference documentation for the ExtendScript runtime and the `ExternalObject` interface this library is built on.
- **esb64:** the vendored runtime lane and the shared `ESB64Native.dll` accelerator that make extraction fast — the first consumer of this library in its own right.
- **eson and eschars:** the peer libraries the 1+n model was proven against live (the second consumer, and the native-DLL channel-rules research).
- **The ArcFit family:** the freestanding-native-build and measured-channel-rules culture this library's design inherits.

---

## License

GPL-3.0-or-later (family convention; identical text to eson/esb64). See [LICENSE](LICENSE).

---

<p align="center"><small>ESPACK: ExtendScript Packer. Built for the engine, measured on the engine, single-file by construction.</small></p>
