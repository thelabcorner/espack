#!/usr/bin/env node
// ESPACK Node-side test suite (plain assert harness, no framework).
//   - packer unit tests: embed(s) -> parse -> correct payload(s)/size/version,
//     accel embedding/disable/accel-only, deterministic output,
//     self-contained bundle, token hygiene.
//   - loader logic tests: the emitted bundle is executed in a vm sandbox with
//     stubbed File/Folder/ExternalObject/$ backed by the real filesystem, so
//     extract/load/attach/GC/error paths are exercised without Illustrator.
//     Covers both lanes: JSX lane (--no-accel bundles) and the native lane
//     (bundles with the shared accelerator, incl. the 1+n sharing scenario).
//   - chunk-boundary mirror: the loader's chunk arithmetic decoded in Node
//     must reproduce the embedded bytes exactly.
import assert from 'node:assert';
import { build } from '../espack-build.mjs';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, rmdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import vm from 'node:vm';

var TMP = mkdtempSync(join(tmpdir(), 'espack-test-'));

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }
function run() {
  var failed = 0;
  for (var i = 0; i < tests.length; i++) {
    try {
      tests[i].fn();
      console.log('ok   ' + tests[i].name);
    } catch (e) {
      failed++;
      console.log('FAIL ' + tests[i].name + ': ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n    ') : String(e)));
    }
  }
  console.log('\n' + (tests.length - failed) + '/' + tests.length + ' passed');
  process.exit(failed ? 1 : 0);
}

// ---- fixtures ---------------------------------------------------------------

function fakeDll(n, seed) {
  var b = Buffer.alloc(n);
  for (var i = 0; i < n; i++) b[i] = ((i * 7 + 3) * (seed || 1) + (seed || 0)) & 0xff;
  return b;
}
var DLL_1 = fakeDll(100000); // not a multiple of 3 -> b64 padding edge case
  var DLL_2 = fakeDll(99328);  // typical payload DLL size
var DLL_3 = fakeDll(65536, 5);

function writeDll(dir, name, bytes) {
  var p = join(dir, name);
  writeFileSync(p, bytes);
  return p;
}

function buildOnce(opts) {
  opts = opts || {};
  var dir = mkdtempSync(join(TMP, 'dll-'));
  var dll = writeDll(dir, opts.dllName || 'FakeDll.dll', opts.bytes || DLL_1);
  var out = join(dir, 'out.jsx');
  var bopts = {
    out: out,
    name: opts.name,
    dllVersion: opts.dllVersion,
    cacheDir: opts.cacheDir,
    standalone: opts.standalone,
    accel: false // explicit: existing tests exercise the JSX lane
  };
  if (opts.accel === true) {
    bopts.accel = opts.accelPath || writeDll(dir, 'ESB64Native.dll', opts.accelBytes || DLL_2);
    if (opts.accelVersion) bopts.accelVersion = opts.accelVersion;
  }
  bopts.embed = dll;
  return build(bopts);
}

// ---- packer unit tests ------------------------------------------------------

test('packer: single payload tokens correct', function () {
  var r = buildOnce({ dllName: 'FakeDll.dll', name: 'mybundle', dllVersion: '3' });
  var t = r.text;
  assert.strictEqual(r.payloads.length, 1);
  assert.strictEqual(r.payloads[0].name, 'FakeDll');
  assert.strictEqual(r.payloads[0].version, '3');
  assert.strictEqual(r.payloads[0].len, 100000);
  assert.strictEqual(r.payloads[0].fileName, 'FakeDll_v3.dll');
  assert.ok(t.indexOf('var PAYLOADS = [{ name: "FakeDll", version: "3", len: 100000, b64: "' + r.payloads[0].b64 + '", fileName: "FakeDll_v3.dll" }];') >= 0, 'payloads literal');
  assert.ok(t.indexOf('var BUNDLE_NAME = "mybundle";') >= 0, 'bundle name');
  assert.ok(t.indexOf('var CACHE_DIR_OVERRIDE = "";') >= 0, 'default cache override empty');
  assert.ok(t.indexOf('var CHUNK = 24576;') >= 0, 'chunk size');
  assert.strictEqual(r.payloads[0].b64.length, 133336, 'b64 length for 100000 bytes');
});

test('packer: multi-embed (n payloads)', function () {
  var dir = mkdtempSync(join(TMP, 'multi-'));
  var p1 = writeDll(dir, 'LibA.dll', DLL_1);
  var p2 = writeDll(dir, 'LibB.dll', DLL_2);
  var out = join(dir, 'out.jsx');
  var r = build({ embed: [p1, p2], out: out, name: 'multi', accel: false });
  assert.strictEqual(r.payloads.length, 2);
  assert.strictEqual(r.payloads[0].fileName, 'LibA_v1.dll');
  assert.strictEqual(r.payloads[1].fileName, 'LibB_v1.dll');
  assert.ok(r.text.indexOf('{ name: "LibA", version: "1", len: 100000,') >= 0);
  assert.ok(r.text.indexOf('{ name: "LibB", version: "1", len: 99328,') >= 0);
  // per-embed version override via =ver suffix
  var r2 = build({ embed: [p1 + '=2', p2], out: out, name: 'multi2', accel: false });
  assert.strictEqual(r2.payloads[0].version, '2');
  assert.strictEqual(r2.payloads[0].fileName, 'LibA_v2.dll');
  assert.strictEqual(r2.payloads[1].fileName, 'LibB_v1.dll');
});

test('packer: accel embedded when requested, disabled by --no-accel', function () {
  var withAccel = buildOnce({ accel: true });
  assert.ok(withAccel.accel, 'accel present');
  assert.strictEqual(withAccel.accel.name, 'ESB64Native');
  assert.strictEqual(withAccel.accel.fileName, 'ESB64Native_v1.dll');
  assert.ok(withAccel.text.indexOf('var ACCEL_LEN = 99328;') >= 0, 'accel len token');
  assert.ok(withAccel.text.indexOf('var ACCEL_B64 = "' + withAccel.accel.b64 + '";') >= 0, 'accel b64 token');
  var noAccel = buildOnce({ accel: false });
  assert.strictEqual(noAccel.accel, null);
  assert.ok(noAccel.text.indexOf('var ACCEL_LEN = 0;') >= 0, 'accel disabled -> len 0');
  assert.ok(noAccel.text.indexOf('var ACCEL_NAME = "";') >= 0, 'accel disabled -> empty name');
});

test('packer: accel-only bundle (1 + 0 payloads)', function () {
  var dir = mkdtempSync(join(TMP, 'accelonly-'));
  var accel = writeDll(dir, 'ESB64Native.dll', DLL_2);
  var out = join(dir, 'out.jsx');
  var r = build({ out: out, name: 'accelonly', accel: accel });
  assert.strictEqual(r.payloads.length, 0);
  assert.ok(r.text.indexOf('var PAYLOADS = [];') >= 0, 'empty payloads');
  assert.ok(r.accel && r.accel.fileName === 'ESB64Native_v1.dll');
});

test('packer: deterministic output', function () {
  var a = buildOnce({});
  var b = buildOnce({});
  assert.strictEqual(a.text, b.text, 'two builds byte-identical');
});

test('packer: self-contained (no external references)', function () {
  var r = buildOnce({});
  assert.ok(r.text.indexOf('vendor-esb64') < 0, 'no vendor path');
  assert.ok(r.text.indexOf('esb64-runtime') < 0, 'no runtime path');
  assert.ok(r.text.indexOf('evalFile') < 0, 'no evalFile');
  assert.ok(r.text.indexOf('#include') < 0, 'no include');
  assert.ok(r.text.indexOf('esb64/') < 0, 'no repo reference');
});

test('packer: standalone banner', function () {
  var r = buildOnce({ standalone: true });
  assert.ok(r.text.indexOf('#target illustrator') === 0, 'banner first');
  var r2 = buildOnce({ standalone: false });
  assert.ok(r2.text.indexOf('#target illustrator') !== 0, 'no banner by default');
});

test('packer: cache-dir override', function () {
  var r = buildOnce({ cacheDir: 'C:\\X Y\\cache' });
  assert.ok(r.text.indexOf('var CACHE_DIR_OVERRIDE = "C:/X Y/cache";') >= 0, 'override normalized');
});

test('packer: emitted JSX parses as JS (syntax check)', function () {
  var r = buildOnce({});
  new Function(r.text); // throws on syntax error
});

test('packer: rejects missing embed', function () {
  assert.throws(function () { build({ embed: join(TMP, 'nope.dll'), out: join(TMP, 'x.jsx') }); }, /not found/);
});

test('packer: rejects nothing to embed', function () {
  assert.throws(function () { build({ out: join(TMP, 'x.jsx'), accel: false }); }, /nothing to embed/);
});

// ---- chunk boundary mirror (loader arithmetic in Node) -----------------------

test('chunking: mirrors loader decode for many payload sizes', function () {
  var CHUNK = 24576;
  var sizes = [1, 2, 3, 4, 5, 24575, 24576, 24577, 65536, 99328, 100000, 200000];
  sizes.forEach(function (n) {
    var bytes = fakeDll(n);
    var b64 = bytes.toString('base64');
    assert.strictEqual(b64.length % 4, 0, 'b64 len multiple of 4');
    var parts = [];
    for (var i = 0; i < b64.length; i += CHUNK) parts.push(b64.substring(i, Math.min(i + CHUNK, b64.length)));
    for (var j = 0; j < parts.length - 1; j++) assert.strictEqual(parts[j].length % 4, 0, 'interior chunk quad-aligned');
    assert.strictEqual(parts[parts.length - 1].length % 4, 0, 'last chunk quad-aligned');
    var joined = parts.map(function (p) { return Buffer.from(p, 'base64').toString('latin1'); }).join('');
    assert.strictEqual(joined.length, n, 'decoded units match');
    var re = Buffer.from(joined, 'latin1');
    assert.ok(re.equals(bytes), 'round trip byte-exact for n=' + n);
  });
});

// ---- loader logic in a vm sandbox --------------------------------------------

function makeSandbox(root, opts) {
  opts = opts || {};
  var fs = { existsSync: existsSync, statSync: statSync, readdirSync: readdirSync, mkdirSync: mkdirSync, unlinkSync: unlinkSync, rmdirSync: rmdirSync, readFileSync: readFileSync, writeFileSync: writeFileSync };
  var norm = function (p) { return String(p).replace(/\//g, '\\'); };
  function matchesMask(name, mask) {
    var re = new RegExp('^' + mask.split('*').map(function (s) { return s.replace(/[.+\-^${}()|[\]\\]/g, '\\$&'); }).join('.*') + '$');
    return re.test(name);
  }
  function FolderCtor(p) { this.p = norm(p); }
  FolderCtor.prototype = {
    get exists() { try { return fs.statSync(this.p).isDirectory(); } catch (e) { return false; } },
    create: function () {
      if (opts.failMkdir) return false;
      try { fs.mkdirSync(this.p, { recursive: true }); return this.exists; } catch (e) { return false; }
    },
    remove: function () { try { fs.rmdirSync(this.p); return true; } catch (e) { return false; } },
    getFiles: function (mask) {
      try {
        var out = [];
        fs.readdirSync(this.p).forEach(function (n) {
          if (matchesMask(n, mask)) out.push(new FileCtor(join(this.p, n)));
        }, this);
        return out;
      } catch (e) { return []; }
    }
  };
  FolderCtor.temp = { fsName: norm(root) };
  function FileCtor(p) { this.p = norm(p); this.encoding = null; this._buf = null; this._open = false; }
  FileCtor.prototype = {
    get exists() { try { return fs.statSync(this.p).isFile(); } catch (e) { return false; } },
    get name() { return basename(this.p); },
    get fsName() { return this.p; },
    get length() {
      if (this._buf) return this._buf.length;
      try { return fs.statSync(this.p).size; } catch (e) { return 0; }
    },
    open: function (mode) {
      this._open = true;
      this._mode = mode;
      if (mode === 'w') { this._buf = Buffer.alloc(0); return !opts.failOpen; }
      if (mode === 'r') {
        if (!this.exists) return false;
        this._buf = fs.readFileSync(this.p);
        return true;
      }
      return false;
    },
    write: function (s) {
      if (this._mode !== 'w' || !this._buf) return false;
      this._buf = Buffer.concat([this._buf, Buffer.from(s, 'latin1')]);
      return true;
    },
    read: function () { return this._buf ? this._buf.toString('latin1') : ''; },
    close: function () {
      if (this._open && this._mode === 'w' && this._buf) fs.writeFileSync(this.p, this._buf);
      this._open = false;
      return true;
    },
    remove: function () { try { fs.unlinkSync(this.p); return true; } catch (e) { return false; } }
  };
  function ExternalCtor(spec) {
    if (opts.externalThrows) throw new Error('stub ExternalObject load failure: ' + spec);
    this.spec = spec;
    this.getVersion = function () { return 'stub 1.0.0'; };
    this.add = function (a, b) { return a + b; };
    this.b64decodeToFile = function (b64, path) {
      if (opts.accelNativeFails) throw new Error('stub native decode failure');
      var bytes = Buffer.from(b64, 'base64');
      fs.writeFileSync(norm(path), bytes);
      return bytes.length;
    };
  }
  ExternalCtor.search = function () { return 'stub-search-result'; };
  var sandbox = {};
  var $ = new Proxy({}, {
    get: function (t, k) {
      if (k === 'hiresTimer') {
        var now = process.hrtime.bigint();
        var d = Number(now - last) / 1000;
        last = now;
        return d;
      }
      if (k === 'global') return sandbox;
      if (k === 'getenv') return function (name) { return opts.env && opts.env[name] !== undefined ? opts.env[name] : null; };
      if (k === 'version') return 'stub-engine';
      return t[k];
    },
    set: function (t, k, v) { t[k] = v; return true; }
  });
  var last = process.hrtime.bigint();
  sandbox.$ = $;
  sandbox.File = FileCtor;
  sandbox.Folder = FolderCtor;
  sandbox.ExternalObject = ExternalCtor;
  return sandbox;
}

function runBundle(sandbox, r) {
  vm.createContext(sandbox);
  vm.runInContext(r.text, sandbox);
  return sandbox;
}

// ---- JSX lane (no accel): the existing single-payload contract ---------------

test('loader: extract writes byte-exact DLL, load reaches native, attach swaps', function () {
  var root = mkdtempSync(join(TMP, 'sandbox-'));
  var r = buildOnce({ dllName: 'FakeDll.dll', name: 'bundle1', dllVersion: '1' });
  var sandbox = makeSandbox(root, { env: { LOCALAPPDATA: root } });
  runBundle(sandbox, r);
  var ESPAK = sandbox.ESPAK;
  assert.ok(ESPAK, 'ESPAK installed on $.global');
  assert.strictEqual(ESPAK.version, '0.2.0');
  assert.strictEqual(ESPAK.config.payloads.length, 1);
  assert.strictEqual(ESPAK.config.payloads[0].fileName, 'FakeDll_v1.dll');
  assert.strictEqual(ESPAK.config.accel, null, 'no accel in bundle');
  assert.strictEqual(ESPAK.config.cacheDir, root.replace(/\\/g, '/') + '/bundle1');
  assert.strictEqual(ESPAK.isExtracted(0), false);
  var e = ESPAK.extract(0);
  assert.strictEqual(e.ok, true, 'extract ok');
  assert.strictEqual(e.lane, 'jsx', 'no accel -> JSX lane');
  var extracted = readFileSync(join(root, 'bundle1', 'FakeDll_v1.dll'));
  assert.ok(extracted.equals(r.payloads[0] && Buffer.from(r.payloads[0].b64, 'base64') || r.bytes), 'extracted file byte-exact');
  assert.strictEqual(ESPAK.isExtracted(0), true);
  var l = ESPAK.load(0);
  assert.strictEqual(l.ok, true);
  assert.strictEqual(l.mode, 'native');
  assert.strictEqual(l.lib.getVersion(), 'stub 1.0.0');
  assert.strictEqual(ESPAK.mode(), 'native');
  var es3Impl = { atob: function () { return 'es3'; }, btoa: function () { return 'es3'; } };
  var nativeImpl = { atob: function () { return 'native'; }, btoa: function () { return 'native'; } };
  var modes = [];
  var a = ESPAK.attach({
    es3: es3Impl,
    buildNative: function () { return nativeImpl; },
    onMode: function (m, lib, impl) { modes.push([m, impl === nativeImpl]); }
  });
  assert.strictEqual(a.mode, 'native');
  assert.strictEqual(a.impl.atob(), 'native');
  assert.deepStrictEqual(modes[0], ['native', true]);
});

test('loader: skip-extract path (file exists with right size, no write)', function () {
  var root = mkdtempSync(join(TMP, 'sandbox-'));
  var r = buildOnce({ dllName: 'FakeDll.dll', name: 'bundle2', dllVersion: '1' });
  var dir = join(root, 'bundle2');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'FakeDll_v1.dll'), Buffer.from(r.payloads[0].b64, 'base64'));
  var sandbox = makeSandbox(root, { env: { LOCALAPPDATA: root } });
  runBundle(sandbox, r);
  var ESPAK = sandbox.ESPAK;
  assert.strictEqual(ESPAK.isExtracted(0), true);
  var before = statSync(join(dir, 'FakeDll_v1.dll')).mtimeMs;
  var l = ESPAK.load(0);
  assert.strictEqual(l.ok, true);
  assert.strictEqual(l.mode, 'native');
  assert.strictEqual(ESPAK.extractMs(), -1, 'extract not re-run');
  assert.strictEqual(statSync(join(dir, 'FakeDll_v1.dll')).mtimeMs, before, 'file untouched');
});

test('loader: size mismatch triggers re-extraction', function () {
  var root = mkdtempSync(join(TMP, 'sandbox-'));
  var r = buildOnce({ dllName: 'FakeDll.dll', name: 'bundle3', dllVersion: '1' });
  var dir = join(root, 'bundle3');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'FakeDll_v1.dll'), Buffer.alloc(10, 0x41));
  var sandbox = makeSandbox(root, { env: { LOCALAPPDATA: root } });
  runBundle(sandbox, r);
  var ESPAK = sandbox.ESPAK;
  assert.strictEqual(ESPAK.isExtracted(0), false);
  var l = ESPAK.load(0);
  assert.strictEqual(l.ok, true);
  assert.strictEqual(l.mode, 'native');
  var extracted = readFileSync(join(dir, 'FakeDll_v1.dll'));
  assert.ok(extracted.equals(Buffer.from(r.payloads[0].b64, 'base64')), 'replaced with correct bytes');
});

test('loader: GC removes older versions after extraction', function () {
  var root = mkdtempSync(join(TMP, 'sandbox-'));
  var r = buildOnce({ dllName: 'FakeDll.dll', name: 'bundle4', dllVersion: '2' });
  var dir = join(root, 'bundle4');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'FakeDll_v1.dll'), Buffer.alloc(100, 0x42));
  writeFileSync(join(dir, 'other_v9.dll'), Buffer.alloc(100, 0x43));
  var sandbox = makeSandbox(root, { env: { LOCALAPPDATA: root } });
  runBundle(sandbox, r);
  var e = sandbox.ESPAK.extract(0);
  assert.strictEqual(e.ok, true);
  assert.ok(!existsSync(join(dir, 'FakeDll_v1.dll')), 'old version removed');
  assert.ok(existsSync(join(dir, 'other_v9.dll')), 'other DLL untouched');
});

test('loader: fail-open -> extract error surfaced, load stays es3', function () {
  var root = mkdtempSync(join(TMP, 'sandbox-'));
  var r = buildOnce({ dllName: 'FakeDll.dll', name: 'bundle5', dllVersion: '1' });
  var sandbox = makeSandbox(root, { env: { LOCALAPPDATA: root }, failOpen: true });
  runBundle(sandbox, r);
  var ESPAK = sandbox.ESPAK;
  var e = ESPAK.extract(0);
  assert.strictEqual(e.ok, false);
  assert.ok(/cannot open/.test(e.error), 'clear error: ' + e.error);
  var l = ESPAK.load(0);
  assert.strictEqual(l.ok, false);
  assert.strictEqual(l.mode, 'es3');
});

test('loader: fail-mkdir -> cache dir error surfaced', function () {
  var root = mkdtempSync(join(TMP, 'sandbox-'));
  var r = buildOnce({ dllName: 'FakeDll.dll', name: 'bundle6', dllVersion: '1' });
  var sandbox = makeSandbox(root, { env: { LOCALAPPDATA: root }, failMkdir: true });
  runBundle(sandbox, r);
  var ESPAK = sandbox.ESPAK;
  var l = ESPAK.load(0);
  assert.strictEqual(l.ok, false);
  assert.strictEqual(l.mode, 'es3');
  assert.ok(/cannot create cache dir/.test(l.error), 'clear error: ' + l.error);
  assert.ok(ESPAK.lastError().length > 0);
});

test('loader: ExternalObject throws -> diagnostics + es3 fallback', function () {
  var root = mkdtempSync(join(TMP, 'sandbox-'));
  var r = buildOnce({ dllName: 'FakeDll.dll', name: 'bundle7', dllVersion: '1' });
  var sandbox = makeSandbox(root, { env: { LOCALAPPDATA: root }, externalThrows: true });
  runBundle(sandbox, r);
  var ESPAK = sandbox.ESPAK;
  var l = ESPAK.load(0);
  assert.strictEqual(l.ok, false);
  assert.strictEqual(l.mode, 'es3');
  assert.ok(/ExternalObject load failed/.test(l.error), 'load error: ' + l.error);
  assert.ok(/search: stub-search-result/.test(l.error), 'diagnostics included');
  var a = ESPAK.attach({ es3: { atob: function () { return 'es3'; } }, buildNative: function () { return {}; } });
  assert.strictEqual(a.mode, 'es3');
});

test('loader: buildNative throwing keeps ES3 impl, error surfaced', function () {
  var root = mkdtempSync(join(TMP, 'sandbox-'));
  var r = buildOnce({ dllName: 'FakeDll.dll', name: 'bundle8', dllVersion: '1' });
  var sandbox = makeSandbox(root, { env: { LOCALAPPDATA: root } });
  runBundle(sandbox, r);
  var ESPAK = sandbox.ESPAK;
  var a = ESPAK.attach({
    es3: { atob: function () { return 'es3'; } },
    buildNative: function () { throw new Error('boom'); }
  });
  assert.strictEqual(a.mode, 'es3');
  assert.strictEqual(a.impl.atob(), 'es3');
  assert.ok(/buildNative failed/.test(a.error), 'error surfaced: ' + a.error);
});

test('loader: cache-dir override honored', function () {
  var root = mkdtempSync(join(TMP, 'sandbox-'));
  var override = mkdtempSync(join(TMP, 'override-'));
  var r = buildOnce({ dllName: 'FakeDll.dll', name: 'bundle9', dllVersion: '1', cacheDir: override });
  var sandbox = makeSandbox(root, { env: { LOCALAPPDATA: root } });
  runBundle(sandbox, r);
  var ESPAK = sandbox.ESPAK;
  assert.strictEqual(ESPAK.config.cacheDir, override.replace(/\\/g, '/'));
  var l = ESPAK.load(0);
  assert.strictEqual(l.ok, true);
  assert.ok(existsSync(join(override, 'FakeDll_v1.dll')), 'extracted into override dir');
});

test('loader: lib cached across load() calls ($.global keyed by path)', function () {
  var root = mkdtempSync(join(TMP, 'sandbox-'));
  var r = buildOnce({ dllName: 'FakeDll.dll', name: 'bundle10', dllVersion: '1' });
  var sandbox = makeSandbox(root, { env: { LOCALAPPDATA: root } });
  runBundle(sandbox, r);
  var ESPAK = sandbox.ESPAK;
  var l1 = ESPAK.load(0);
  var l2 = ESPAK.load(0);
  assert.strictEqual(l1.ok, true);
  assert.strictEqual(l1.cached, false, 'first load creates');
  assert.strictEqual(l2.ok, true);
  assert.strictEqual(l2.cached, true, 'second load reuses');
  assert.strictEqual(l1.lib, l2.lib, 'same lib object');
  assert.ok(sandbox.__ESPAK_LIBS__ && sandbox.__ESPAK_LIBS__[ESPAK.payloadPath(0)], 'cache entry keyed by dll path');
});

// ---- 1 + n: shared accelerator -------------------------------------------------

test('loader: accel extracted via JSX lane, payload natively, byte-exact', function () {
  var root = mkdtempSync(join(TMP, 'sandbox-'));
  var r = buildOnce({ dllName: 'FakeDll.dll', name: 'bundle11', dllVersion: '1', accel: true });
  assert.ok(r.accel, 'bundle carries accel');
  var sandbox = makeSandbox(root, { env: { LOCALAPPDATA: root } });
  runBundle(sandbox, r);
  var ESPAK = sandbox.ESPAK;
  assert.ok(ESPAK.config.accel, 'config exposes accel');
  assert.strictEqual(ESPAK.config.accel.fileName, 'ESB64Native_v1.dll');
  var accelFile = join(root, 'espack', 'ESB64Native_v1.dll');
  assert.ok(!existsSync(accelFile), 'accel not yet extracted');
  var e = ESPAK.extract(0);
  assert.strictEqual(e.ok, true);
  assert.strictEqual(e.lane, 'native', 'payload extracted via the accelerator');
  assert.ok(ESPAK.accelReady(), 'accel loaded');
  assert.ok(ESPAK.accelExtractMs() >= 0, 'accel JSX-lane extraction measured');
  assert.ok(ESPAK.nativeExtractMs() >= 0, 'native extraction measured');
  assert.ok(existsSync(accelFile), 'accel file on disk (shared dir)');
  assert.strictEqual(statSync(accelFile).size, r.accel.len, 'accel size');
  var extracted = readFileSync(join(root, 'bundle11', 'FakeDll_v1.dll'));
  assert.ok(extracted.equals(Buffer.from(r.payloads[0].b64, 'base64')), 'payload byte-exact');
  var l = ESPAK.load(0);
  assert.strictEqual(l.ok, true);
  assert.strictEqual(l.mode, 'native');
});

test('loader: 1+n sharing - second bundle reuses the extracted accelerator', function () {
  var root = mkdtempSync(join(TMP, 'sandbox-'));
  var accelPath = writeDll(mkdtempSync(join(TMP, 'acc-')), 'ESB64Native.dll', DLL_2);
  var rA = buildOnce({ dllName: 'LibA.dll', name: 'bundleA', accel: true, accelPath: accelPath, bytes: DLL_1 });
  var rB = buildOnce({ dllName: 'LibB.dll', name: 'bundleB', accel: true, accelPath: accelPath, bytes: DLL_3 });
  var sandbox = makeSandbox(root, { env: { LOCALAPPDATA: root } });

  runBundle(sandbox, rA);
  var A = sandbox.ESPAK;
  var la = A.load(0);
  assert.strictEqual(la.ok, true);
  assert.strictEqual(la.mode, 'native');
  assert.ok(A.accelExtractMs() >= 0, 'A extracted the accel (JSX lane)');
  var accelFile = join(root, 'espack', 'ESB64Native_v1.dll');
  var accelMtime = statSync(accelFile).mtimeMs;
  assert.ok(readFileSync(join(root, 'bundleA', 'LibA_v1.dll')).equals(Buffer.from(rA.payloads[0].b64, 'base64')), 'A payload byte-exact');

  runBundle(sandbox, rB);
  var B = sandbox.ESPAK;
  var lb = B.load(0);
  assert.strictEqual(lb.ok, true);
  assert.strictEqual(lb.mode, 'native');
  assert.strictEqual(B.accelExtractMs(), -1, 'B did NOT re-extract the accel');
  assert.strictEqual(statSync(accelFile).mtimeMs, accelMtime, 'accel file untouched by B');
  assert.ok(B.accelReady(), 'B uses the shared accel');
  assert.ok(readFileSync(join(root, 'bundleB', 'LibB_v1.dll')).equals(Buffer.from(rB.payloads[0].b64, 'base64')), 'B payload byte-exact');
});

test('loader: accel-only bundle loads the accelerator as the lib', function () {
  var root = mkdtempSync(join(TMP, 'sandbox-'));
  var dir = mkdtempSync(join(TMP, 'acc-'));
  var accel = writeDll(dir, 'ESB64Native.dll', DLL_2);
  var out = join(dir, 'out.jsx');
  var r = build({ out: out, name: 'accelonly', accel: accel });
  var sandbox = makeSandbox(root, { env: { LOCALAPPDATA: root } });
  runBundle(sandbox, r);
  var ESPAK = sandbox.ESPAK;
  assert.strictEqual(ESPAK.config.payloads.length, 0);
  var l = ESPAK.load();
  assert.strictEqual(l.ok, true);
  assert.strictEqual(l.mode, 'native');
  assert.strictEqual(l.lib.getVersion(), 'stub 1.0.0');
  assert.ok(existsSync(join(root, 'espack', 'ESB64Native_v1.dll')), 'accel extracted to shared dir');
});

test('loader: accel native failure falls back to the JSX lane', function () {
  var root = mkdtempSync(join(TMP, 'sandbox-'));
  var r = buildOnce({ dllName: 'FakeDll.dll', name: 'bundle12', dllVersion: '1', accel: true });
  var sandbox = makeSandbox(root, { env: { LOCALAPPDATA: root }, accelNativeFails: true });
  runBundle(sandbox, r);
  var ESPAK = sandbox.ESPAK;
  var e = ESPAK.extract(0);
  assert.strictEqual(e.ok, true, 'extract still succeeds');
  assert.strictEqual(e.lane, 'jsx', 'fell back to JSX lane');
  var extracted = readFileSync(join(root, 'bundle12', 'FakeDll_v1.dll'));
  assert.ok(extracted.equals(Buffer.from(r.payloads[0].b64, 'base64')), 'payload byte-exact via fallback');
  assert.ok(ESPAK.lastError().indexOf('native extraction failed') >= 0, 'reason surfaced');
});

test('loader: accel version mismatch re-extracts (new file, GC old)', function () {
  var root = mkdtempSync(join(TMP, 'sandbox-'));
  var accelPath = writeDll(mkdtempSync(join(TMP, 'acc-')), 'ESB64Native.dll', DLL_2);
  var r1 = buildOnce({ dllName: 'FakeDll.dll', name: 'bundle13', dllVersion: '1', accel: true, accelPath: accelPath });
  var sandbox = makeSandbox(root, { env: { LOCALAPPDATA: root } });
  runBundle(sandbox, r1);
  sandbox.ESPAK.load(0);
  var v1 = join(root, 'espack', 'ESB64Native_v1.dll');
  assert.ok(existsSync(v1), 'v1 accel extracted');
  // bump BOTH the payload and the accel versions so extraction is triggered
  var r2 = buildOnce({ dllName: 'FakeDll.dll', name: 'bundle13', dllVersion: '2', accel: true, accelPath: accelPath, accelVersion: '2' });
  runBundle(sandbox, r2);
  var ESPAK = sandbox.ESPAK;
  var l = ESPAK.load(0);
  assert.strictEqual(l.ok, true);
  assert.ok(existsSync(join(root, 'espack', 'ESB64Native_v2.dll')), 'v2 accel extracted (was not on the system)');
  assert.ok(ESPAK.accelExtractMs() >= 0, 'v2 extracted (was not on the system)');
  assert.ok(!existsSync(v1), 'v1 accel GC\'d (not locked)');
  assert.ok(existsSync(join(root, 'bundle13', 'FakeDll_v2.dll')), 'payload v2 extracted natively');
});

test('loader: multi-payload bundle - load by index and name', function () {
  var root = mkdtempSync(join(TMP, 'sandbox-'));
  var dir = mkdtempSync(join(TMP, 'multi-'));
  var p1 = writeDll(dir, 'LibA.dll', DLL_1);
  var p2 = writeDll(dir, 'LibB.dll', DLL_2);
  var out = join(dir, 'out.jsx');
  var r = build({ embed: [p1, p2], out: out, name: 'multi', accel: false });
  var sandbox = makeSandbox(root, { env: { LOCALAPPDATA: root } });
  runBundle(sandbox, r);
  var ESPAK = sandbox.ESPAK;
  assert.strictEqual(ESPAK.config.payloads.length, 2);
  var l0 = ESPAK.load(0);
  var l1 = ESPAK.load(1);
  var lA = ESPAK.load('LibA');
  assert.strictEqual(l0.ok, true);
  assert.strictEqual(l1.ok, true);
  assert.strictEqual(lA.ok, true);
  assert.notStrictEqual(l0.lib, l1.lib, 'different payloads -> different libs');
  assert.strictEqual(lA.lib, l0.lib, 'load by name resolves to index 0');
  assert.ok(existsSync(join(root, 'multi', 'LibA_v1.dll')));
  assert.ok(existsSync(join(root, 'multi', 'LibB_v1.dll')));
  var bad = ESPAK.load('Nope');
  assert.strictEqual(bad.ok, false);
  assert.ok(/unknown payload/.test(bad.error));
});

run();
