# ESPACK — self-extracting single-file ExternalObject bundles

A build-time packer + ES3 self-extracting loader so ExternalObject DLLs ship
**inside a single `.jsx`** and materialize on disk at runtime, in the
**"1 + n" model**:

- **1 shared esb64 accelerator DLL** (vendored at `vendor/ESB64Native.dll`,
  inlined as base64 into every bundle by default). It is unpacked **once per
  system** (`%LOCALAPPDATA%\espack\ESB64Native_v<v>.dll`) using the bundle's
  inlined ES3 base64 lane, then loaded via `ExternalObject` and reused by
  every espack bundle on that machine.
- **n payload DLLs** (`--embed`, repeatable; each `name_v<version>.dll` in the
  per-bundle cache dir `%LOCALAPPDATA%\<bundle-name>\`). Every payload is
  decoded **by the accelerator** (`b64decodeToFile`: native decode written
  straight to disk — NUL-safe, no string channel), so payload extraction is
  microseconds instead of ~140 ms of JSX-lane decoding.

Runtime order: start in ES3 mode → the inlined lane unpacks the accelerator
(only if it is not already on the system) → the accelerator natively unpacks
every payload → all DLLs load via `ExternalObject`. If the accelerator is
unavailable (read-only cache, locked host), payloads fall back to the JSX
lane transparently with the reason surfaced on `ESPAK.lastError()`.

> Distribution is single-file; runtime always materializes the DLLs on disk
> (`ExternalObject` requires a file path; there is no in-memory load).
> Windows x64 only (PE64 DLLs). Verified live on Adobe Illustrator 30.6.0.

```
node espack-build.mjs --embed path/to/MyDll.dll --embed OtherDll.dll=2 \
     --out dist/MyBundle.jsx --name mybundle
```

## Why

Measured on Illustrator 30.6.0 (ExtendScript 4.5.6) — see
[Measured evidence](#measured-evidence):

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

## Repo layout

| Path | Purpose |
|---|---|
| `espack-build.mjs` | The packer (Node ESM, no deps): embed(s) + accel → single-file JSX. `build()` is exported for tests |
| `src/loader.jsx` | The ES3 loader template (`__TOKENS__` replaced at build time) |
| `vendor/` | Vendored esb64 artifacts: `esb64-runtime.js` (the inlined atob lane) + `ESB64Native.dll` (the shared accelerator) — refreshed via `npm run vendor-sync`, drift-guarded by `tests/vendor-sync-test.mjs` |
| `tests/espack-test.mjs` | Node-side suite: packer units + loader logic in a vm sandbox (stubbed `File`/`Folder`/`ExternalObject`/`$`) + chunk-boundary mirror |
| `tests/espack-e2e.mjs` | Live end-to-end on Illustrator via the COM tool (1+n extraction, sharing, skip-extract, version bumps, GC across sessions, failure paths) |
| `probes/espack-measure-prep.mjs` | The measurement generator that produced the evidence below |
| `dist/` | Built bundles (gitignored) |

## Packer CLI

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

## Runtime behavior (the emitted bundle)

The bundle defines the global `ESPAK` (installed on `$.global` so COM-eval'd
bundles persist across `DoJavaScript` calls):

```js
ESPAK.config;             // { bundleName, cacheDir, chunkSize,
                          //   accel: { name, version, fileName, len, dir } | null,
                          //   payloads: [{ name, version, fileName, len }] }
ESPAK.load(i);            // load payload i (index or name; default 0); extract-if-
                          //   needed -> new ExternalObject; { ok, mode, lib, path }
ESPAK.attach(opts, i);    // capability switch (below)
ESPAK.extract(i);         // { ok, lane: "native"|"jsx", path }
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

### The capability switch (`attach`)

The core pattern for consumer libraries (esb64 first — see below):

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

## Vendored esb64 (modularity)

`vendor/` carries the two esb64 artifacts every bundle needs, so espack
builds standalone (no sibling-repo dependency):

| File | Source (upstream esb64 build) | Purpose |
|---|---|---|
| `vendor/esb64-runtime.js` | `esb64/dist/vendor-esb64-runtime.js` | The inlined atob/btoa lane (the JSX extractor) |
| `vendor/ESB64Native.dll` | `esb64/native/bin/ESB64Native.dll` | The shared WHATWG-exact accelerator (`b64encode`/`b64decode`/`b64decodeToFile`) |

Refresh: `npm run vendor-sync` (copies from `../esb64`, or `ESB64_RUNTIME_SRC`
/ `ESB64_NATIVE_SRC`). `npm test` includes the drift guard
(`tests/vendor-sync-test.mjs`).

## Measured evidence

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

## Tests

```
npm test      # 28 Node tests (packer + vm loader logic incl. 1+n sharing +
              #   chunk mirror) + vendor-sync drift guard
npm run e2e   # 50+ live checks on Illustrator (requires COM tool + an
              #   automation instance; kills stale automation instances first)
```

The e2e suite runs: fresh system → v1 (accel JSX extraction + native payload
extraction + smoke + byte-exact) → skip-extract re-run → v2/v3 bumps (accel
never re-extracted; locked versions survive GC) → failure path (blocker
cache dir → clean es3 fallback) → fresh instance (GC removes all stale
versions) → **1+n cross-bundle sharing** (lib1 unpacks the shared accel,
lib2 reuses it untouched, both payloads byte-exact).

## Integration: esb64 (first consumer — complete)

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

## Integration: eson (second consumer — complete)

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

## License

GPL-3.0-or-later (family convention; identical text to eson/esb64).
