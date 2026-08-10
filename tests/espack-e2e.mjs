#!/usr/bin/env node
// ESPACK live end-to-end verification on Illustrator 30.6.0 (mirrors
// esb64-live-verify.mjs). Requires the COM tool and a COM-reachable
// automation instance (launches one if absent).
//
// Sequence (one automation instance, then a fresh one for GC-across-sessions):
//   v1: extract -> load -> native smoke -> byte-exact vs DLL on disk
//       re-run: skip-extract path (extractMs === -1)
//   v2: extract -> load (v1 stays: locked by instance A)
//   fail-path: --cache-dir pointing at an existing FILE -> clear es3 fallback
//   v3: extract -> load (v1+v2 stay: locked)
//   fresh instance B: v4 extract -> GC removes v1/v2/v3 (unlocked), v4 loads
// Prints extraction timings and asserts every step.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../espack-build.mjs';
import { merge } from '../espack-merge.mjs';

var ROOT = dirname(fileURLToPath(import.meta.url));
var SCRIPTS = process.env.ESPAK_DEV_SCRIPTS || 'C:/Program Files/Adobe/Adobe Illustrator 2026/Presets/en_US/Scripts';
var DLL = join(ROOT, '..', 'vendor', 'ESB64Native.dll');
var TOOL = process.env.ILLUSTRATOR_COM_TOOL || SCRIPTS + '/agent-skills/illustrator-com-automation-skill/comtool/ILLUSTRATOR_COM_TOOL.py';
var DIST = join(ROOT, '..', 'dist');
var CACHE = join(process.env.LOCALAPPDATA || '', 'espack-e2e-test');
var BLOCKER = join(process.env.LOCALAPPDATA || '', 'espack-e2e-fail.txt');
var SHARED_ACCEL_DIR = join(process.env.LOCALAPPDATA || '', 'espack');

var dllBytes = readFileSync(DLL);
console.log('E2E: DLL ' + basename(DLL) + ' ' + dllBytes.length + ' bytes; cache ' + CACHE);

var failures = 0;
function check(name, cond, detail) {
  if (cond) console.log('ok   ' + name);
  else { failures++; console.log('FAIL ' + name + (detail ? '  ' + detail : '')); }
}
function runTool(args, timeoutMs) {
  var out = execFileSync('python', [TOOL].concat(args), { encoding: 'utf8', timeout: timeoutMs || 180000 });
  return JSON.parse(out.trim());
}
function evalFile(path) {
  // CLI contract: env.ok = tool success (script errors set env.ok=false);
  // env.result = the script's value directly (null for undefined - the bundle
  // itself returns nothing; its job is installing ESPAK on $.global).
  var env = runTool(['eval', '--file', path.replace(/\\/g, '/')]);
  if (!env.ok) throw new Error('eval failed: ' + JSON.stringify(env).slice(0, 1500));
  return env.result;
}
function evalCode(code) {
  // The COM wrapper swallows plain completion values (ES3 function-body
  // semantics), so the value must be returned explicitly.
  var env = runTool(['eval', '--code', 'return ' + code]);
  if (!env.ok) throw new Error('eval failed: ' + JSON.stringify(env).slice(0, 1500));
  return env.result;
}
// Bundle eval + smoke in ONE invocation: concurrent automation (other
// agents' evals) can re-claim the shared $.global.ESPAK slot between
// separate calls; re-eval'ing the bundle atomically with the smoke makes the
// assertions race-free (re-eval is idempotent: extraction skips, lib cache
// hits, mtime/extractMs unchanged).
function evalSmoke(bundlePath) {
  var env = runTool(['eval', '--code',
    '$.evalFile(File("' + bundlePath.replace(/\\/g, '/') + '")); return ' + SMOKE]);
  if (!env.ok) throw new Error('eval failed: ' + JSON.stringify(env).slice(0, 1500));
  return env.result;
}

// Multi-payload smoke: load(0) + load-by-name, distinct libs, unknown-name
// rejection. Used atomically with the bundle eval (same race-free rationale
// as evalSmoke).
var SMOKE_MULTI = '(function () {' +
  '  var out = { ok: false, error: null };' +
  '  try {' +
  '    var ESP = $.global.ESPAK;' +
  '    if (!ESP) { out.error = "ESPAK not installed on $.global"; return out; }' +
  '    out.payloads = ESP.config.payloads.length;' +
  '    var l0 = ESP.load(0);' +
  '    var lA = ESP.load("LibA");' +
  '    var lB = ESP.load("LibB");' +
  '    out.ok0 = l0.ok; out.okA = lA.ok; out.okB = lB.ok;' +
  '    out.modeA = lA.mode; out.modeB = lB.mode;' +
  '    out.sameLib = (lA.lib === l0.lib);' +
  '    out.distinct = (lA.lib !== lB.lib);' +
  '    out.b64encA = String(lA.lib.b64encode("hello"));' +
  '    out.b64encB = String(lB.lib.b64encode("hello"));' +
  '    var bad = ESP.load("Nope");' +
  '    out.badOk = bad.ok;' +
  '    out.ok = l0.ok && lA.ok && lB.ok && !bad.ok;' +
  '  } catch (e) { out.error = String(e); }' +
  '  return out;' +
  '}());';

function evalMulti(bundlePath) {
  var env = runTool(['eval', '--code',
    '$.evalFile(File("' + bundlePath.replace(/\\/g, '/') + '")); return ' + SMOKE_MULTI]);
  if (!env.ok) throw new Error('eval failed: ' + JSON.stringify(env).slice(0, 1500));
  return env.result;
}

// Merged-bundle smoke: load both payloads by name, report extraction timing.
var SMOKE_MERGED = '(function () {' +
  '  var out = { ok: false, error: null };' +
  '  try {' +
  '    var ESP = $.global.ESPAK;' +
  '    if (!ESP) { out.error = "ESPAK not installed on $.global"; return out; }' +
  '    out.bundleName = ESP.config.bundleName;' +
  '    out.payloads = ESP.config.payloads.length;' +
  '    out.accelReady = ESP.accelReady();' +
  '    var lA = ESP.load("LibA");' +
  '    var lB = ESP.load("LibB");' +
  '    out.okA = lA.ok; out.okB = lB.ok;' +
  '    out.modeA = lA.mode; out.modeB = lB.mode;' +
  '    out.extractMs = ESP.extractMs();' +
  '    out.accelExtractMs = ESP.accelExtractMs();' +
  '    out.b64encA = String(lA.lib.b64encode("hello"));' +
  '    out.b64encB = String(lB.lib.b64encode("hello"));' +
  '    out.ok = lA.ok && lB.ok;' +
  '  } catch (e) { out.error = String(e); }' +
  '  return out;' +
  '}());';

function evalMerged(bundlePath) {
  var env = runTool(['eval', '--code',
    '$.evalFile(File("' + bundlePath.replace(/\\/g, '/') + '")); return ' + SMOKE_MERGED]);
  if (!env.ok) throw new Error('eval failed: ' + JSON.stringify(env).slice(0, 1500));
  return env.result;
}

// Facade-ordering probe: eval a bundle, report which ESPAK facade is active.
function evalConfig(bundlePath) {
  var env = runTool(['eval', '--code',
    '$.evalFile(File("' + bundlePath.replace(/\\/g, '/') + '")); return { bundleName: $.global.ESPAK.config.bundleName, payloads: $.global.ESPAK.config.payloads.length };']);
  if (!env.ok) throw new Error('eval failed: ' + JSON.stringify(env).slice(0, 1500));
  return env.result;
}

// Arbitrary-file payload probe: extract() materializes byte-exact; load() rejects.
var SMOKE_FILE = '(function () {' +
  '  var out = { ok: false, error: null };' +
  '  try {' +
  '    var ESP = $.global.ESPAK;' +
  '    if (!ESP) { out.error = "ESPAK not installed on $.global"; return out; }' +
  '    out.kind = ESP.config.payloads[0].kind;' +
  '    out.fileName = ESP.config.payloads[0].fileName;' +
  '    var x = ESP.extract(0);' +
  '    out.extractOk = x.ok; out.extractLane = x.lane;' +
  '    out.isExtracted = ESP.isExtracted(0);' +
  '    out.path = ESP.payloadPath(0);' +
  '    var l = ESP.load(0);' +
  '    out.loadRejected = l.ok === false;' +
  '    out.loadError = l.error;' +
  '    out.ok = x.ok && !l.ok;' +
  '  } catch (e) { out.error = String(e); }' +
  '  return out;' +
  '}());';

function evalFilePayload(bundlePath) {
  var env = runTool(['eval', '--code',
    '$.evalFile(File("' + bundlePath.replace(/\\/g, '/') + '")); return ' + SMOKE_FILE]);
  if (!env.ok) throw new Error('eval failed: ' + JSON.stringify(env).slice(0, 1500));
  return env.result;
}

var SMOKE = '(function () {' +
  '  var out = { ok: false, error: null };' +
  '  try {' +
  '    var ESP = $.global.ESPAK;' +
  '    if (!ESP) { out.error = "ESPAK not installed on $.global"; return out; }' +
  '    out.espakVersion = ESP.version;' +
  '    out.config = ESP.config;' +
  '    out.isExtractedBefore = ESP.isExtracted();' +
  '    out.accelBefore = ESP.accelReady();' +
  '    var l = ESP.load();' +
  '    out.loadOk = l.ok; out.mode = l.mode; out.path = l.path;' +
  '    out.extractMs = ESP.extractMs(); out.loadMs = ESP.loadMs();' +
  '    out.accelExtractMs = ESP.accelExtractMs();' +
  '    out.nativeExtractMs = ESP.nativeExtractMs();' +
  '    out.accelReady = ESP.accelReady();' +
  '    out.isExtractedAfter = ESP.isExtracted();' +
  '    if (!l.ok) { out.error = l.error; return out; }' +
  '    var lib = l.lib;' +
  '    out.b64enc = String(lib.b64encode("hello"));' +
  '    out.b64dec = String(lib.b64decode("aGVsbG8="));' +
  '    out.ok = true;' +
  '  } catch (e) { out.error = String(e); }' +
  '  return out;' +
  '}());';

var ATTACH_ES3 = '(function () {' +
  '  var out = {};' +
  '  var ESP = $.global.ESPAK;' +
  '  var a = ESP.attach({' +
  '    es3: { atob: function () { return "es3-atob"; }, btoa: function () { return "es3-btoa"; } },' +
  '    buildNative: function (lib) { return { atob: function () { return "native-atob"; }, btoa: function () { return "native-btoa"; } }; }' +
  '  });' +
  '  out.mode = a.mode; out.implAtob = a.impl.atob(); out.ok = a.ok;' +
  '  return out;' +
  '}());';

function extractedPath(version) { return join(CACHE, 'ESB64Native_v' + version + '.dll'); }
function bundlePath(version) { return join(DIST, 'espack-e2e-v' + version + '.jsx'); }
function buildBundle(version, extra) {
  var opts = Object.assign({
    embed: DLL, out: bundlePath(version), name: 'espack-e2e-test', dllVersion: String(version)
  }, extra || {});
  return build(opts);
}

function killAllAutomation() {
  execFileSync('powershell.exe', ['-NoProfile', '-Command',
    '$p = Get-Process -Name Illustrator -ErrorAction SilentlyContinue; if ($p) { $p | Stop-Process -Force }; exit 0'],
    { timeout: 30000 });
}
// Stop-Process -Force is async w.r.t. file-lock release: rmSync immediately
// after can hit still-locked DLLs. Retry with a short sleep so end-of-run
// cleanup actually removes the cache dirs (start-of-run cleanup runs after
// launchFresh and is reliable; this makes the end cleanup reliable too).
function rmRetry(p) {
  for (var i = 0; i < 5; i++) {
    try { rmSync(p, { recursive: true, force: true }); return; } catch (e) {
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400); } catch (e2) {}
    }
  }
}
function launchFresh() {
  var env = runTool(['status', '--launch'], 90000);
  if (!env.ok) throw new Error('instance launch failed: ' + JSON.stringify(env).slice(0, 1000));
  return env.result;
}

// ---- instance A (fresh, owned by this run) ------------------------------------
console.log('E2E: killing any leftover automation instances and launching a fresh one...');
killAllAutomation();
var instA = launchFresh();
check('instance A fresh (' + instA.Version + ', ' + instA.DocumentsCount + ' docs)', instA.DocumentsCount === 0);

if (existsSync(CACHE)) rmSync(CACHE, { recursive: true, force: true });
if (existsSync(SHARED_ACCEL_DIR)) rmSync(SHARED_ACCEL_DIR, { recursive: true, force: true });
['espack-e2e-lib1', 'espack-e2e-lib2', 'espack-e2e-multi', 'espack-e2e-mergeA', 'espack-e2e-mergeB'].forEach(function (d) {
  try { rmSync(join(process.env.LOCALAPPDATA, d), { recursive: true, force: true }); } catch (e) {}
});
try { if (existsSync(BLOCKER)) rmSync(BLOCKER); } catch (e) {}
mkdirSync(DIST, { recursive: true });

// v1: extract -> load -> smoke
buildBundle(1);
var s1 = evalSmoke(bundlePath(1));
check('v1: bundle evals, ESPAK installed', s1.ok === true, s1.error);
check('v1: native mode', s1.mode === 'native', 'mode=' + s1.mode);
check('v1: native b64 vectors', s1.b64enc === 'aGVsbG8=' && s1.b64dec === 'hello', JSON.stringify({ enc: s1.b64enc, dec: s1.b64dec }));
check('v1: extracted before load = false', s1.isExtractedBefore === false, 'before=' + s1.isExtractedBefore);
check('v1: extracted after load = true', s1.isExtractedAfter === true, 'after=' + s1.isExtractedAfter);
check('v1: extract ran (extractMs >= 0)', typeof s1.extractMs === 'number' && s1.extractMs >= 0, String(s1.extractMs));
check('v1: cache dir + versioned name', s1.config.payloads[0].fileName === 'ESB64Native_v1.dll' && s1.config.cacheDir.indexOf('espack-e2e-test') >= 0, JSON.stringify(s1.config));
check('v1: shared accelerator embedded + ready', s1.accelReady === true && s1.config.accel && s1.config.accel.fileName === 'ESB64Native_v1.dll', JSON.stringify(s1.config.accel));
check('v1: accel extracted via JSX lane (accelExtractMs >= 0)', typeof s1.accelExtractMs === 'number' && s1.accelExtractMs >= 0, String(s1.accelExtractMs));
check('v1: payload extracted via the accelerator (nativeExtractMs >= 0)', typeof s1.nativeExtractMs === 'number' && s1.nativeExtractMs >= 0, String(s1.nativeExtractMs));
check('v1: dll file on disk', existsSync(extractedPath(1)));
check('v1: byte-exact vs source DLL', readFileSync(extractedPath(1)).equals(dllBytes));
check('v1: accel file in shared dir', existsSync(join(SHARED_ACCEL_DIR, 'ESB64Native_v1.dll')));
var v1mtime = statSync(extractedPath(1)).mtimeMs;
console.log('      v1 payloadExtractMs=' + s1.extractMs + ' us (' + (s1.extractMs / 1000).toFixed(1) + ' ms)  accelExtractMs=' + s1.accelExtractMs + ' us (' + (s1.accelExtractMs / 1000).toFixed(1) + ' ms)  loadMs=' + s1.loadMs + ' us');
console.log('      v1 extractMs=' + s1.extractMs + ' us (' + (s1.extractMs / 1000).toFixed(1) + ' ms)  loadMs=' + s1.loadMs + ' us');

// re-run: skip-extract path (atomic re-eval = fresh ESPAK instance; no
// extraction happened in its lifetime -> extractMs -1; the mtime check is
// the decisive no-re-extraction proof)
var s1b = evalSmoke(bundlePath(1));
check('re-run: still native', s1b.mode === 'native' && s1b.ok === true);
check('re-run: no re-extraction (fresh instance, extractMs -1)', s1b.extractMs === -1, 'extractMs=' + s1b.extractMs);
check('re-run: no re-extraction (file mtime unchanged)', statSync(extractedPath(1)).mtimeMs === v1mtime, 'mtime changed');
check('re-run: identical vectors', s1b.b64enc === 'aGVsbG8=' && s1b.b64dec === 'hello');
check('re-run: file untouched', existsSync(extractedPath(1)));

// v2: version bump in same host
buildBundle(2);
var s2 = evalSmoke(bundlePath(2));
check('v2: loaded native', s2.ok === true && s2.mode === 'native', s2.error);
check('v2: new versioned file', s2.config.payloads[0].fileName === 'ESB64Native_v2.dll');
check('v2: accel NOT re-extracted (shared, already on system)', s2.accelExtractMs === -1, 'accelExtractMs=' + s2.accelExtractMs);
check('v2: extracted', existsSync(extractedPath(2)));
check('v2: v1 still present (locked by host)', existsSync(extractedPath(1)));
console.log('      v2 extractMs=' + s2.extractMs + ' us (' + (s2.extractMs / 1000).toFixed(1) + ' ms)');

// failure path: cache dir override points at an existing FILE
writeFileSync(BLOCKER, 'blocker');
var failBundle = build({ embed: DLL, out: join(DIST, 'espack-e2e-fail.jsx'), name: 'espack-e2e-fail', dllVersion: '1', cacheDir: BLOCKER.replace(/\\/g, '/') });
var sf = evalSmoke(failBundle.outPath);
check('fail-path: load fails cleanly', sf.loadOk === false, JSON.stringify(sf));
check('fail-path: stays es3', sf.mode === 'es3');
// Live engine: Folder.exists is true for a path that exists as a FILE, so the
// blocker surfaces as a write failure ("cannot open ... for writing") rather
// than an ensureDir failure; both are clean, surfaced errors.
check('fail-path: clear error', sf.error && (sf.error.indexOf('cannot create cache dir') >= 0 || sf.error.indexOf('cannot open') >= 0), sf.error);
var af = evalCode(ATTACH_ES3);
check('fail-path: attach stays es3, es3 impl active', af.mode === 'es3' && af.implAtob === 'es3-atob', JSON.stringify(af));

// v3: another bump; GC best-effort (v1+v2 locked -> survive)
buildBundle(3);
var s3 = evalSmoke(bundlePath(3));
check('v3: loaded native', s3.ok === true && s3.mode === 'native', s3.error);
check('v3: extracted', existsSync(extractedPath(3)));
check('v3: v1+v2 survive (locked, GC best-effort)', existsSync(extractedPath(1)) && existsSync(extractedPath(2)));
console.log('      v3 extractMs=' + s3.extractMs + ' us (' + (s3.extractMs / 1000).toFixed(1) + ' ms)');

// ---- fresh instance B: GC across sessions --------------------------------------
console.log('E2E: closing instance A and launching a fresh instance B...');
killAllAutomation();
launchFresh();
buildBundle(4);
var s4 = evalSmoke(bundlePath(4));
check('v4 (fresh instance): loaded native', s4.ok === true && s4.mode === 'native', s4.error);
check('v4 (fresh instance): extracted', existsSync(extractedPath(4)));
check('v4: GC removed v1 (unlocked)', !existsSync(extractedPath(1)), 'v1 still present');
check('v4: GC removed v2 (unlocked)', !existsSync(extractedPath(2)), 'v2 still present');
check('v4: GC removed v3 (unlocked)', !existsSync(extractedPath(3)), 'v3 still present');
check('v4: byte-exact vs source DLL', readFileSync(extractedPath(4)).equals(dllBytes));
console.log('      v4 extractMs=' + s4.extractMs + ' us (' + (s4.extractMs / 1000).toFixed(1) + ' ms)');

// ---- 1+n cross-bundle sharing on the fresh instance B -------------------------
console.log('E2E: 1+n sharing scenario (lib1/lib2, shared accelerator)...');
var accelMtime = statSync(join(SHARED_ACCEL_DIR, 'ESB64Native_v1.dll')).mtimeMs;
var lib1 = build({ embed: DLL, out: join(DIST, 'espack-e2e-lib1.jsx'), name: 'espack-e2e-lib1', dllVersion: '1' });
var sl1 = evalSmoke(lib1.outPath);
check('lib1: native via shared accel', sl1.ok === true && sl1.mode === 'native', sl1.error);
check('lib1: accel skipped (already on system)', sl1.accelExtractMs === -1, 'accelExtractMs=' + sl1.accelExtractMs);
check('lib1: accel file untouched', statSync(join(SHARED_ACCEL_DIR, 'ESB64Native_v1.dll')).mtimeMs === accelMtime, 'mtime changed');
check('lib1: payload native extraction', sl1.nativeExtractMs >= 0, String(sl1.nativeExtractMs));
check('lib1: byte-exact', readFileSync(join(process.env.LOCALAPPDATA, 'espack-e2e-lib1', 'ESB64Native_v1.dll')).equals(dllBytes));
var lib2 = build({ embed: DLL, out: join(DIST, 'espack-e2e-lib2.jsx'), name: 'espack-e2e-lib2', dllVersion: '1' });
var sl2 = evalSmoke(lib2.outPath);
check('lib2: native via shared accel', sl2.ok === true && sl2.mode === 'native', sl2.error);
check('lib2: accel skipped again', sl2.accelExtractMs === -1, 'accelExtractMs=' + sl2.accelExtractMs);
check('lib2: accel file untouched', statSync(join(SHARED_ACCEL_DIR, 'ESB64Native_v1.dll')).mtimeMs === accelMtime, 'mtime changed');
check('lib2: byte-exact', readFileSync(join(process.env.LOCALAPPDATA, 'espack-e2e-lib2', 'ESB64Native_v1.dll')).equals(dllBytes));
console.log('      lib1 payloadExtractMs=' + sl1.extractMs + ' us (' + (sl1.extractMs / 1000).toFixed(1) + ' ms)  lib2 payloadExtractMs=' + sl2.extractMs + ' us (' + (sl2.extractMs / 1000).toFixed(1) + ' ms)');

// ---- multi-payload bundle: load by index and name ------------------------------
console.log('E2E: multi-payload bundle (load by index and name)...');
var libA = join(DIST, 'LibA.dll');
var libB = join(DIST, 'LibB.dll');
writeFileSync(libA, dllBytes);
writeFileSync(libB, dllBytes);
var multiBundle = build({ embed: [libA, libB], out: join(DIST, 'espack-e2e-multi.jsx'), name: 'espack-e2e-multi', dllVersion: '1' });
var sm = evalMulti(multiBundle.outPath);
check('multi: bundle evals, 2 payloads', sm.ok === true && sm.payloads === 2, sm.error);
check('multi: load(0) + load-by-name all native', sm.ok0 === true && sm.okA === true && sm.okB === true && sm.modeA === 'native' && sm.modeB === 'native', JSON.stringify(sm));
check('multi: load-by-name resolves to index 0 (same lib)', sm.sameLib === true, 'sameLib=' + sm.sameLib);
check('multi: distinct payloads -> distinct libs', sm.distinct === true, 'distinct=' + sm.distinct);
check('multi: unknown payload name rejected', sm.badOk === false, 'badOk=' + sm.badOk);
check('multi: native b64 vectors both payloads', sm.b64encA === 'aGVsbG8=' && sm.b64encB === 'aGVsbG8=', JSON.stringify({ a: sm.b64encA, b: sm.b64encB }));
check('multi: byte-exact both payloads', readFileSync(join(process.env.LOCALAPPDATA, 'espack-e2e-multi', 'LibA_v1.dll')).equals(dllBytes) && readFileSync(join(process.env.LOCALAPPDATA, 'espack-e2e-multi', 'LibB_v1.dll')).equals(dllBytes));

// ---- merged bundle: accel dedupe, cache migration, facade ordering -------------
console.log('E2E: merged bundle (manifest merge)...');
var mA = join(DIST, 'espack-e2e-mergeA.json');
var mB = join(DIST, 'espack-e2e-mergeB.json');
var bundleA = build({ embed: libA, out: join(DIST, 'espack-e2e-mergeA.jsx'), name: 'espack-e2e-mergeA', dllVersion: '1', manifestOut: mA });
var bundleB = build({ embed: libB, out: join(DIST, 'espack-e2e-mergeB.jsx'), name: 'espack-e2e-mergeB', dllVersion: '1', manifestOut: mB });
var merged = merge({ manifests: [mA, mB], out: join(DIST, 'espack-e2e-merged.jsx') });
check('merge: 2 payloads, 1 accel', merged.payloads.length === 2 && !!merged.accel, JSON.stringify({ n: merged.payloads.length, accel: !!merged.accel }));
check('merge: one accel literal in merged text (dedupe)', (merged.text.match(/var ACCEL_B64 = /g) || []).length === 1, 'accel literal count');
check('merge: one PAYLOADS literal, bundle name = first manifest', (merged.text.match(/var PAYLOADS = /g) || []).length === 1 && merged.bundleName === 'espack-e2e-mergeA', merged.bundleName);
var mergeADir = join(process.env.LOCALAPPDATA, 'espack-e2e-mergeA');
var mergeBDir = join(process.env.LOCALAPPDATA, 'espack-e2e-mergeB');

// facade ordering: eval A, then B, then merged -> the LAST eval wins. evalSmoke
// also LOADS payload 0, so A's payload lands in %LOCALAPPDATA%/espack-e2e-mergeA
// (its own dir = the merged bundle's dir, since the merged name defaults to the
// first manifest) and B's payload lands in %LOCALAPPDATA%/espack-e2e-mergeB.
var smA = evalSmoke(bundleA.outPath);
check('facade: A active after A eval', smA.config.bundleName === 'espack-e2e-mergeA' && smA.config.payloads.length === 1, JSON.stringify(smA.config));
check('migration: A payload extracted into its own dir', smA.isExtractedAfter === true && existsSync(join(mergeADir, 'LibA_v1.dll')));
var smB = evalSmoke(bundleB.outPath);
check('facade: B active after B eval (last-wins)', smB.config.bundleName === 'espack-e2e-mergeB' && smB.config.payloads.length === 1, JSON.stringify(smB.config));
check('migration: B payload extracted into its own dir', smB.isExtractedAfter === true && existsSync(join(mergeBDir, 'LibB_v1.dll')));
var smM1 = evalMerged(merged.outPath);
check('facade: merged active after merged eval (last-wins)', smM1.bundleName === 'espack-e2e-mergeA' && smM1.payloads === 2, JSON.stringify({ bundleName: smM1.bundleName, payloads: smM1.payloads }));

// cache migration: the merged bundle reuses the first manifest's cache dir
// (espack-e2e-mergeA), so LibA is skip-extracted; LibB migrates from the mergeB
// dir into the merged dir; the old mergeB copy stays stale but harmless (merged
// GC is scoped to the merged cache dir only).
check('merged: both payloads native via the single shared accel', smM1.ok === true && smM1.okA === true && smM1.okB === true && smM1.modeA === 'native' && smM1.modeB === 'native', smM1.error);
check('merged: accel reused, not re-extracted (dedupe)', smM1.accelExtractMs === -1, 'accelExtractMs=' + smM1.accelExtractMs);
check('merged: LibB extracted into the merged dir (migration)', existsSync(join(mergeADir, 'LibB_v1.dll')));
check('merged: byte-exact both payloads in merged dir', readFileSync(join(mergeADir, 'LibA_v1.dll')).equals(dllBytes) && readFileSync(join(mergeADir, 'LibB_v1.dll')).equals(dllBytes));
check('merged: old mergeB copy stale but harmless', existsSync(join(mergeBDir, 'LibB_v1.dll')), 'mergeB file removed by merged GC?');
check('merged: native b64 vectors both payloads', smM1.b64encA === 'aGVsbG8=' && smM1.b64encB === 'aGVsbG8=', JSON.stringify({ a: smM1.b64encA, b: smM1.b64encB }));
var mergedLibAMtime = statSync(join(mergeADir, 'LibA_v1.dll')).mtimeMs;
var mergedLibBMtime = statSync(join(mergeADir, 'LibB_v1.dll')).mtimeMs;
var smM2 = evalMerged(merged.outPath);
check('merged re-run: skip-extract (extractMs -1)', smM2.ok === true && smM2.extractMs === -1, 'extractMs=' + smM2.extractMs);
check('merged re-run: files untouched (mtime unchanged)', statSync(join(mergeADir, 'LibA_v1.dll')).mtimeMs === mergedLibAMtime && statSync(join(mergeADir, 'LibB_v1.dll')).mtimeMs === mergedLibBMtime, 'mtime changed');
var cfgM = evalConfig(merged.outPath);
check('facade: merged still active after re-eval (last-wins)', cfgM.bundleName === 'espack-e2e-mergeA' && cfgM.payloads === 2, JSON.stringify(cfgM));
console.log('      merged extractMs=' + smM1.extractMs + ' us (' + (smM1.extractMs / 1000).toFixed(1) + ' ms)  re-run extractMs=' + smM2.extractMs + ' us');

// ---- arbitrary-file payload (kind=file): byte-exact extract, load() rejects ----
console.log('E2E: arbitrary-file payload (kind=file)...');
var fileBytes = Buffer.concat([Buffer.from('MZ\x90\x00'), Buffer.from('FAKE EXE PAYLOAD 0123456789'), Buffer.from('\x00\x00\x00\x00PE')]);
var toolExe = join(DIST, 'Tool.exe');
writeFileSync(toolExe, fileBytes);
var fileBundle = build({ embed: toolExe, out: join(DIST, 'espack-e2e-file.jsx'), name: 'espack-e2e-file', dllVersion: '1' });
check('file: kind=file, versioned exe name', fileBundle.payloads[0].kind === 'file' && fileBundle.payloads[0].fileName === 'Tool_v1.exe', JSON.stringify(fileBundle.payloads[0]));
var sf = evalFilePayload(fileBundle.outPath);
check('file: bundle evals, extract ok, load rejected', sf.ok === true && sf.extractOk === true && sf.loadRejected === true, JSON.stringify(sf));
check('file: extract via native lane (shared accel) or skip', sf.extractLane === 'native' || sf.extractLane === 'skip', 'lane=' + sf.extractLane);
check('file: kind surfaced in config', sf.kind === 'file', 'kind=' + sf.kind);
check('file: isExtracted after extract', sf.isExtracted === true, 'isExtracted=' + sf.isExtracted);
check('file: load error mentions kind=file', /kind=file/.test(String(sf.loadError)), 'loadError=' + sf.loadError);
check('file: extracted file on disk with exe name', existsSync(join(process.env.LOCALAPPDATA, 'espack-e2e-file', 'Tool_v1.exe')));
check('file: extracted bytes byte-exact vs source', readFileSync(join(process.env.LOCALAPPDATA, 'espack-e2e-file', 'Tool_v1.exe')).equals(fileBytes));

// ---- cleanup -------------------------------------------------------------------
console.log('E2E: closing instance B...');
killAllAutomation();
rmRetry(CACHE);
rmRetry(SHARED_ACCEL_DIR);
rmRetry(join(process.env.LOCALAPPDATA, 'espack-e2e-lib1'));
rmRetry(join(process.env.LOCALAPPDATA, 'espack-e2e-lib2'));
rmRetry(join(process.env.LOCALAPPDATA, 'espack-e2e-multi'));
rmRetry(join(process.env.LOCALAPPDATA, 'espack-e2e-mergeA'));
rmRetry(join(process.env.LOCALAPPDATA, 'espack-e2e-mergeB'));
try { rmSync(BLOCKER); } catch (e) {}

console.log('\nE2E: ' + (failures ? failures + ' failure(s)' : 'ALL CHECKS PASSED'));
process.exit(failures ? 1 : 0);
