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
['espack-e2e-lib1', 'espack-e2e-lib2'].forEach(function (d) {
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

// ---- cleanup -------------------------------------------------------------------
console.log('E2E: closing instance B...');
killAllAutomation();
try { rmSync(CACHE, { recursive: true, force: true }); } catch (e) {}
try { rmSync(SHARED_ACCEL_DIR, { recursive: true, force: true }); } catch (e) {}
try { rmSync(join(process.env.LOCALAPPDATA, 'espack-e2e-lib1'), { recursive: true, force: true }); } catch (e) {}
try { rmSync(join(process.env.LOCALAPPDATA, 'espack-e2e-lib2'), { recursive: true, force: true }); } catch (e) {}
try { rmSync(BLOCKER); } catch (e) {}

console.log('\nE2E: ' + (failures ? failures + ' failure(s)' : 'ALL CHECKS PASSED'));
process.exit(failures ? 1 : 0);
