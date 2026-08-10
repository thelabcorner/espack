#!/usr/bin/env node
// ESPACK manifest/merge tests (plain assert harness, no framework).
import assert from 'node:assert';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, readManifest } from '../espack-build.mjs';
import { merge, mergeManifests } from '../espack-merge.mjs';

var TMP = mkdtempSync(join(tmpdir(), 'espack-merge-test-'));
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

function fakeDll(n, seed) {
  var b = Buffer.alloc(n);
  for (var i = 0; i < n; i++) b[i] = ((i * 11 + 17) * (seed || 1) + (seed || 0)) & 0xff;
  return b;
}

function writeDll(dir, name, bytes) {
  var p = join(dir, name);
  writeFileSync(p, bytes);
  return p;
}

function fixture(name) {
  var dir = mkdtempSync(join(TMP, name + '-'));
  return {
    dir: dir,
    libA: writeDll(dir, 'LibA.dll', fakeDll(4097, 1)),
    libB: writeDll(dir, 'LibB.dll', fakeDll(8195, 2)),
    accel: writeDll(dir, 'ESB64Native.dll', fakeDll(9728, 3))
  };
}

test('manifest: explicit --manifest-out writes schema v1 and no-flag text is byte-identical', function () {
  var f = fixture('manifest');
  var manifestPath = join(f.dir, 'liba.espack.json');
  var withManifest = build({ embed: f.libA, out: join(f.dir, 'with.jsx'), name: 'bundleA', accel: f.accel, manifestOut: manifestPath });
  var withoutManifest = build({ embed: f.libA, out: join(f.dir, 'without.jsx'), name: 'bundleA', accel: f.accel });
  assert.strictEqual(withManifest.text, withoutManifest.text, 'manifest flag must not alter bundle bytes');
  assert.ok(existsSync(manifestPath), 'manifest written only when requested');
  var raw = readFileSync(manifestPath, 'utf8');
  assert.ok(raw.indexOf('"format": "espack-manifest"') >= 0, 'format key');
  assert.ok(raw.indexOf('"version": 1') >= 0, 'schema version key');
  assert.ok(raw.indexOf(f.dir.replace(/\\/g, '/')) < 0, 'manifest does not leak source directory');
  var m = readManifest(manifestPath);
  assert.deepStrictEqual(Object.keys(m), ['format', 'version', 'bundleName', 'cacheDir', 'chunkSize', 'accel', 'payloads']);
  assert.strictEqual(m.bundleName, 'bundleA');
  assert.strictEqual(m.cacheDir, '');
  assert.strictEqual(m.chunkSize, 24576);
  assert.strictEqual(m.payloads.length, 1);
  assert.strictEqual(m.payloads[0].name, 'LibA');
  assert.strictEqual(m.accel.name, 'ESB64Native');
  assert.strictEqual(m.accel.dir, undefined, 'manifest keeps accel machine path out');
});

test('merge: deterministic re-render matches direct multi-payload build', function () {
  var f = fixture('det');
  var m1 = join(f.dir, 'm1.json');
  var m2 = join(f.dir, 'm2.json');
  build({ embed: f.libA, out: join(f.dir, 'a.jsx'), name: 'firstBundle', accel: f.accel, manifestOut: m1 });
  build({ embed: f.libB, out: join(f.dir, 'b.jsx'), name: 'secondBundle', accel: f.accel, manifestOut: m2 });
  var r1 = merge({ manifests: [m1, m2], out: join(f.dir, 'merged1.jsx') });
  var r2 = merge({ manifests: [m1, m2], out: join(f.dir, 'merged2.jsx') });
  assert.strictEqual(r1.text, r2.text, 'same manifests -> byte-identical merged output');
  var direct = build({ embed: [f.libA, f.libB], out: join(f.dir, 'direct.jsx'), name: 'firstBundle', accel: f.accel });
  assert.strictEqual(r1.text, direct.text, 'merged render uses the normal build renderer');
  assert.strictEqual(r1.bundleName, 'firstBundle', 'default bundle name comes from first manifest');
  assert.deepStrictEqual(r1.payloads.map(function (p) { return p.name; }), ['LibA', 'LibB']);
});

test('merge: CLI overrides name cache-dir accel-dir and writes merged manifest', function () {
  var f = fixture('cli');
  var m1 = join(f.dir, 'm1.json');
  var m2 = join(f.dir, 'm2.json');
  var mout = join(f.dir, 'merged.json');
  build({ embed: f.libA, out: join(f.dir, 'a.jsx'), name: 'firstBundle', accel: f.accel, manifestOut: m1 });
  build({ embed: f.libB, out: join(f.dir, 'b.jsx'), name: 'secondBundle', accel: f.accel, manifestOut: m2 });
  var r = merge({ manifests: [m1, m2], out: join(f.dir, 'merged.jsx'), name: 'overrideName', cacheDir: 'C:\\Merged Cache', accelDir: 'C:\\Shared Accel', manifestOut: mout });
  assert.strictEqual(r.bundleName, 'overrideName');
  assert.strictEqual(r.cacheDir, 'C:/Merged Cache');
  assert.ok(r.text.indexOf('var CACHE_DIR_OVERRIDE = "C:/Merged Cache";') >= 0, 'cache override rendered');
  assert.ok(r.text.indexOf('var ACCEL_DIR_OVERRIDE = "C:/Shared Accel";') >= 0, 'accel dir override rendered but not persisted');
  var m = readManifest(mout);
  assert.strictEqual(m.bundleName, 'overrideName');
  assert.strictEqual(m.cacheDir, 'C:/Merged Cache');
  assert.strictEqual(m.accel.dir, undefined);
});

test('merge: collision matrix', function () {
  var f = fixture('collide');
  var aV1 = build({ embed: f.libA + '=1', out: join(f.dir, 'a1.jsx'), name: 'one', accel: f.accel }).manifest;
  var aV1Dup = build({ embed: f.libA + '=1', out: join(f.dir, 'a1dup.jsx'), name: 'two', accel: f.accel }).manifest;
  var aDiff = build({ embed: writeDll(f.dir, 'LibA-other.dll', fakeDll(4097, 8)) + '=1', out: join(f.dir, 'adiff.jsx'), name: 'three', accel: f.accel }).manifest;
  aDiff.payloads[0].name = 'LibA';
  aDiff.payloads[0].fileName = 'LibA_v1.dll';
  var aV2 = build({ embed: f.libA + '=2', out: join(f.dir, 'a2.jsx'), name: 'four', accel: f.accel }).manifest;
  var mergedDedup = mergeManifests([aV1, aV1Dup]);
  assert.strictEqual(mergedDedup.payloads.length, 1, 'same name+version+same b64 dedupes');
  assert.throws(function () { mergeManifests([aV1, aDiff]); }, /payload conflict/);
  var mergedVersion = mergeManifests([aV1, aV2]);
  assert.strictEqual(mergedVersion.payloads.length, 1);
  assert.strictEqual(mergedVersion.payloads[0].version, '2', 'same name keeps higher integer version');
  var nonInt = JSON.parse(JSON.stringify(aV2));
  nonInt.payloads[0].version = 'beta';
  assert.throws(function () { mergeManifests([aV1, nonInt]); }, /non-integer version/);
});

test('merge: accelerator conflicts are hard errors; null accelerators are allowed', function () {
  var f = fixture('accel');
  var m1 = build({ embed: f.libA, out: join(f.dir, 'a.jsx'), name: 'one', accel: f.accel }).manifest;
  var m2 = build({ embed: f.libB, out: join(f.dir, 'b.jsx'), name: 'two', accel: f.accel }).manifest;
  var noAccel = build({ embed: f.libB, out: join(f.dir, 'b-noaccel.jsx'), name: 'three', accel: false }).manifest;
  var conflictAccel = JSON.parse(JSON.stringify(m2));
  conflictAccel.accel.b64 = conflictAccel.accel.b64.substring(0, conflictAccel.accel.b64.length - 4) + 'AAAA';
  assert.throws(function () { mergeManifests([m1, conflictAccel]); }, /accelerator conflict/);
  assert.strictEqual(mergeManifests([noAccel]).accel, null, 'all-null accel yields accel-less merged manifest');
  assert.ok(mergeManifests([m1, noAccel]).accel, 'mixed null/non-null keeps the shared accel');
});

test('merge: multi-payload plus accel fixture renders expected structure and parses', function () {
  var f = fixture('multiaccel');
  var m1 = join(f.dir, 'm1.json');
  var m2 = join(f.dir, 'm2.json');
  build({ embed: f.libA, out: join(f.dir, 'a.jsx'), name: 'multiAccel', accel: f.accel, manifestOut: m1 });
  build({ embed: f.libB, out: join(f.dir, 'b.jsx'), name: 'other', accel: f.accel, manifestOut: m2 });
  var r = merge({ manifests: [m1, m2], out: join(f.dir, 'merged.jsx') });
  assert.strictEqual(r.payloads.length, 2);
  assert.ok(r.accel, 'shared accel retained once');
  assert.ok(r.text.indexOf('var PAYLOADS = [{ name: "LibA"') >= 0);
  assert.ok(r.text.indexOf('{ name: "LibB"') >= 0);
  assert.ok(r.text.indexOf('var ACCEL_B64 = "' + r.accel.b64 + '";') >= 0);
  new Function(r.text);
});

run();
