#!/usr/bin/env node
import assert from 'node:assert';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { makeManifest, validateManifest } from '../espack-build.mjs';
import { merge, mergeManifests } from '../espack-merge.mjs';
import {
  libraryFromFile,
  renderLibraryPlan,
  resolveLibraries,
  satisfiesRange
} from '../espack-libraries.mjs';

var TMP = mkdtempSync(join(tmpdir(), 'espack-libraries-test-'));
var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

function source(name, text) {
  var p = join(TMP, name);
  writeFileSync(p, text, 'utf8');
  return p;
}

function lib(id, version, globalName, text, requires, optionalRequires) {
  return libraryFromFile({
    id: id,
    version: version,
    global: globalName,
    path: source(id + '-' + version + '-' + Math.random().toString(36).slice(2) + '.jsx', text),
    requires: requires || [],
    optionalRequires: optionalRequires || [],
    provenance: {
      package: id,
      repository: 'https://example.invalid/' + id,
      commit: '0123456789abcdef',
      artifact: 'dist/' + globalName + '.jsx'
    }
  });
}

function manifest(bundleName, libraries, entries) {
  return makeManifest({
    bundleName: bundleName,
    cacheDir: '',
    payloads: [],
    accel: null,
    libraries: libraries,
    entries: entries
  });
}

function mergedText(name, manifests, entries) {
  var paths = [];
  var i;
  for (i = 0; i < manifests.length; i++) {
    var p = join(TMP, name + '-m' + i + '.json');
    writeFileSync(p, JSON.stringify(manifests[i], null, 2));
    paths.push(p);
  }
  var out = join(TMP, name + '.jsx');
  return merge({ manifests: paths, entries: entries, out: out, name: name }).text;
}

test('semver: exact/caret/tilde/comparators/wildcards are deterministic', function () {
  assert.strictEqual(satisfiesRange('1.2.3', '1.2.3'), true);
  assert.strictEqual(satisfiesRange('1.9.0', '^1.2.3'), true);
  assert.strictEqual(satisfiesRange('2.0.0', '^1.2.3'), false);
  assert.strictEqual(satisfiesRange('0.2.9', '^0.2.3'), true);
  assert.strictEqual(satisfiesRange('0.3.0', '^0.2.3'), false);
  assert.strictEqual(satisfiesRange('1.2.9', '~1.2.3'), true);
  assert.strictEqual(satisfiesRange('1.3.0', '~1.2.3'), false);
  assert.strictEqual(satisfiesRange('1.5.0', '>=1.2.0 <2.0.0'), true);
  assert.strictEqual(satisfiesRange('1.8.2', '1.x'), true);
  assert.strictEqual(satisfiesRange('1.8.2', '1.8.x'), true);
});

test('manifest v1 remains byte-shape compatible when no libraries are present', function () {
  var m = makeManifest({ bundleName: 'legacy', cacheDir: '', payloads: [], accel: null });
  assert.strictEqual(m.version, 1);
  assert.deepStrictEqual(Object.keys(m), ['format', 'version', 'bundleName', 'cacheDir', 'chunkSize', 'accel', 'payloads']);
  validateManifest(m, 'legacy');
});

test('manifest v2 carries exact source provenance and explicit entry roots', function () {
  var dep = lib('dep', '1.0.0', 'DEP', '$.global.DEP = { value: 1 };');
  var app = lib('app', '2.0.0', 'APP', '$.global.APP = { value: $.global.DEP.value + 1 };', [
    { id: 'dep', range: '^1.0.0' }
  ]);
  var m = manifest('app-bundle', [dep, app], [{ id: 'app', range: '=2.0.0' }]);
  assert.strictEqual(m.version, 2);
  assert.strictEqual(m.libraries.length, 2);
  assert.strictEqual(m.entries[0].id, 'app');
  assert.strictEqual(m.libraries[0].artifact.sha256.length, 64);
  validateManifest(m, 'v2');
});

test('manifest v2 native capability is explicit and payload/accelerator bytes are sha256-bound', function () {
  var provider = lib('native-lib', '1.0.0', 'NATIVE_LIB', '$.global.NATIVE_LIB = { ok: true };');
  var payloadBytes = Buffer.from('native-payload-bytes');
  var accelBytes = Buffer.from('decode-accelerator-bytes');
  var m = makeManifest({
    bundleName: 'native-lib',
    cacheDir: '',
    payloads: [{
      name: 'NativePayload',
      version: '1',
      len: payloadBytes.length,
      b64: payloadBytes.toString('base64'),
      fileName: 'NativePayload_v1.dll'
    }],
    accel: {
      name: 'DecodeAccel',
      version: '1',
      len: accelBytes.length,
      b64: accelBytes.toString('base64'),
      fileName: 'DecodeAccel_v1.dll'
    },
    libraries: [provider],
    entries: [{ id: 'native-lib', range: '=1.0.0' }],
    capabilities: [{
      id: 'native-lib.native',
      provider: 'native-lib',
      mode: 'optional',
      payloads: ['NativePayload'],
      accel: 'DecodeAccel'
    }]
  });
  assert.strictEqual(m.version, 2);
  assert.strictEqual(m.composer.name, 'espack');
  assert.strictEqual(m.payloads[0].sha256.length, 64);
  assert.strictEqual(m.accel.sha256.length, 64);
  assert.deepStrictEqual(m.capabilities[0], {
    id: 'native-lib.native',
    provider: 'native-lib',
    mode: 'optional',
    payloads: ['NativePayload'],
    accel: 'DecodeAccel'
  });
  validateManifest(m, 'native-v2');
});

test('manifest v2 rejects capability references to missing providers or native artifacts', function () {
  var provider = lib('provider', '1.0.0', 'PROVIDER', '$.global.PROVIDER = {};');
  var missingProvider = makeManifest({
    bundleName: 'bad-provider',
    cacheDir: '',
    payloads: [],
    accel: null,
    libraries: [provider],
    entries: [{ id: 'provider', range: '=1.0.0' }],
    capabilities: [{
      id: 'ghost.native',
      provider: 'ghost',
      mode: 'optional',
      payloads: ['GhostPayload'],
      accel: null
    }]
  });
  assert.throws(function () { validateManifest(missingProvider, 'bad-provider'); }, /provider is not present/);

  var missingPayload = makeManifest({
    bundleName: 'bad-payload',
    cacheDir: '',
    payloads: [],
    accel: null,
    libraries: [provider],
    entries: [{ id: 'provider', range: '=1.0.0' }],
    capabilities: [{
      id: 'provider.native',
      provider: 'provider',
      mode: 'optional',
      payloads: ['MissingPayload'],
      accel: null
    }]
  });
  assert.throws(function () { validateManifest(missingPayload, 'bad-payload'); }, /references missing payload/);
});

test('resolver chooses highest compatible version and activates dependencies first', function () {
  var dep10 = lib('dep', '1.0.0', 'DEP', '$.global.DEP = { version: "1.0.0" };');
  var dep12 = lib('dep', '1.2.0', 'DEP', '$.global.DEP = { version: "1.2.0" };');
  var app = lib('app', '1.0.0', 'APP',
    'if (!$.global.DEP) throw new Error("dep missing"); $.global.APP = { dep: $.global.DEP.version };',
    [{ id: 'dep', range: '^1.0.0' }]);
  var r = resolveLibraries([app, dep10, dep12], [{ id: 'app', range: '1.0.0' }]);
  assert.deepStrictEqual(r.libraries.map(function (x) { return x.id + '@' + x.version; }), ['dep@1.2.0', 'app@1.0.0']);
  var text = mergedText('highest-compatible', [
    manifest('highest-compatible', [app, dep10, dep12], [{ id: 'app', range: '1.0.0' }])
  ], [{ id: 'app', range: '1.0.0' }]);
  var context = { $: { global: {} } };
  vm.runInNewContext(text, context);
  assert.strictEqual(context.$.global.APP.dep, '1.2.0');
  assert.deepStrictEqual(
    Array.from(context.$.global.__ESPAK_LIBRARIES__).map(function (x) { return x.id; }),
    ['dep', 'app']
  );
});

test('transitive closure is self-contained and dedupes identical library records', function () {
  var dep = lib('dep', '1.0.0', 'DEP', '$.global.DEP = { ok: true };');
  var mid = lib('mid', '1.0.0', 'MID', '$.global.MID = { ok: $.global.DEP.ok };', [
    { id: 'dep', range: '^1.0.0' }
  ]);
  var app = lib('app', '1.0.0', 'APP', '$.global.APP = { ok: $.global.MID.ok };', [
    { id: 'mid', range: '^1.0.0' }
  ]);
  var m1 = manifest('mid', [dep, mid], [{ id: 'mid', range: '1.0.0' }]);
  var m2 = manifest('app', [dep, mid, app], [{ id: 'app', range: '1.0.0' }]);
  var merged = mergeManifests([m1, m2], { name: 'flat' });
  assert.strictEqual(merged.version, 2);
  assert.deepStrictEqual(merged.libraries.map(function (x) { return x.id; }), ['dep', 'mid', 'app']);
});

test('same identity/version with different bytes is a hard composition conflict', function () {
  var a = lib('dep', '1.0.0', 'DEP', '$.global.DEP = { value: 1 };');
  var b = lib('dep', '1.0.0', 'DEP', '$.global.DEP = { value: 2 };');
  assert.throws(function () {
    resolveLibraries([a, b], [{ id: 'dep', range: '1.0.0' }]);
  }, /composition conflict/);
});

test('unsatisfied required dependency fails instead of silently omitting it', function () {
  var app = lib('app', '1.0.0', 'APP', '$.global.APP = {};', [
    { id: 'missing', range: '^1.0.0' }
  ]);
  assert.throws(function () {
    resolveLibraries([app], [{ id: 'app', range: '1.0.0' }]);
  }, /no deterministic version solution/);
});

test('optional dependency may be absent without destabilizing the plan', function () {
  var app = lib('app', '1.0.0', 'APP', '$.global.APP = {};', [], [
    { id: 'optional-lib', range: '^1.0.0' }
  ]);
  var r = resolveLibraries([app], [{ id: 'app', range: '1.0.0' }]);
  assert.deepStrictEqual(r.libraries.map(function (x) { return x.id; }), ['app']);
});

test('required cycles fail with the concrete cycle path', function () {
  var a = lib('a', '1.0.0', 'A', '$.global.A = {};', [{ id: 'b', range: '1.0.0' }]);
  var b = lib('b', '1.0.0', 'B', '$.global.B = {};', [{ id: 'a', range: '1.0.0' }]);
  assert.throws(function () {
    resolveLibraries([a, b], [{ id: 'a', range: '1.0.0' }]);
  }, /required library cycle: a -> b -> a|required library cycle: b -> a -> b/);
});

test('runtime registry rejects a different active build before executing its source', function () {
  var a = lib('dep', '1.0.0', 'DEP', '$.global.DEP = { marker: "first" };');
  var b = lib('dep', '1.1.0', 'DEP', '$.global.DEP = { marker: "second" };');
  var context = { $: { global: {} } };
  vm.runInNewContext(mergedText('registry-a', [
    manifest('registry-a', [a], [{ id: 'dep', range: '1.0.0' }])
  ], [{ id: 'dep', range: '1.0.0' }]), context);
  assert.strictEqual(context.$.global.DEP.marker, 'first');
  assert.throws(function () {
    vm.runInNewContext(mergedText('registry-b', [
      manifest('registry-b', [b], [{ id: 'dep', range: '1.1.0' }])
    ], [{ id: 'dep', range: '1.1.0' }]), context);
  }, /active library conflict/);
  assert.strictEqual(context.$.global.DEP.marker, 'first', 'second source must not execute after pre-guard conflict');
});

test('pure-library merge emits exactly one ESPAK loader/control plane and executes as one deterministic flat artifact', function () {
  var dep = lib('dep', '1.0.0', 'DEP', '$.global.DEP = { value: 7 };');
  var app = lib('app', '1.0.0', 'APP', '$.global.APP = { value: $.global.DEP.value + 1 };', [
    { id: 'dep', range: '^1.0.0' }
  ]);
  var mp = join(TMP, 'pure-manifest.json');
  writeFileSync(mp, JSON.stringify(manifest('pure', [dep, app], [{ id: 'app', range: '1.0.0' }]), null, 2));
  var out = join(TMP, 'pure.jsx');
  var r = merge({ manifests: [mp], out: out });
  assert.strictEqual(r.payloads.length, 0);
  assert.strictEqual(r.accel, null);
  assert.strictEqual((r.text.match(/var ESPACK = \(function \(\) \{/g) || []).length, 1, 'exactly one ESPAK loader');
  assert.strictEqual((r.text.match(/supportsLibraryComposition = true/g) || []).length, 1, 'exactly one library control plane');
  assert.ok(r.text.indexOf('deterministic order: dep@1.0.0') >= 0);
  var context = { $: { global: {} } };
  vm.runInNewContext(readFileSync(out, 'utf8'), context);
  assert.strictEqual(context.$.global.APP.value, 8);
});

test('byte-identical library re-evaluation is skipped by the shared control plane', function () {
  var once = lib('once', '1.0.0', 'ONCE',
    '$.global.__ONCE_RUNS__ = ($.global.__ONCE_RUNS__ || 0) + 1; $.global.ONCE = { ok: true };');
  var text = mergedText('once', [
    manifest('once', [once], [{ id: 'once', range: '1.0.0' }])
  ], [{ id: 'once', range: '1.0.0' }]);
  var context = { $: { global: {} } };
  vm.runInNewContext(text, context);
  vm.runInNewContext(text, context);
  assert.strictEqual(context.$.global.__ONCE_RUNS__, 1);
  assert.strictEqual(context.$.global.ESPAK.libraryInfo('once').version, '1.0.0');
});

test('stale registry reactivates a missing global without duplicating the library record', function () {
  var once = lib('once', '1.0.0', 'ONCE',
    '$.global.__ONCE_RUNS__ = ($.global.__ONCE_RUNS__ || 0) + 1; $.global.ONCE = { ok: true };');
  var text = mergedText('once-reactivate', [
    manifest('once-reactivate', [once], [{ id: 'once', range: '1.0.0' }])
  ], [{ id: 'once', range: '1.0.0' }]);
  var context = { $: { global: {} } };
  vm.runInNewContext(text, context);
  assert.strictEqual(context.$.global.__ONCE_RUNS__, 1);
  context.$.global.ONCE = null;
  context.$.global.ESPAK = null;
  vm.runInNewContext(text, context);
  assert.strictEqual(context.$.global.__ONCE_RUNS__, 2, 'missing activation global must execute source again');
  assert.strictEqual(context.$.global.ONCE.ok, true);
  assert.strictEqual(context.$.global.ESPAK.libraryList().length, 1, 'reactivation must reuse the registry row');
  assert.strictEqual(context.$.global.ESPAK.libraryInfo('once').version, '1.0.0');
});

test('optional dependency cycle is dropped deterministically while required order remains valid', function () {
  var a = lib('a', '1.0.0', 'A', '$.global.A = { ok: true };',
    [{ id: 'b', range: '1.0.0' }]);
  var b = lib('b', '1.0.0', 'B', '$.global.B = { ok: true };',
    [], [{ id: 'a', range: '1.0.0' }]);
  var r = resolveLibraries([a, b], [{ id: 'a', range: '1.0.0' }]);
  assert.deepStrictEqual(r.libraries.map(function (x) { return x.id; }), ['b', 'a']);
  assert.ok(r.diagnostics.some(function (d) {
    return d.code === 'optional-cycle-dropped' && d.cycle === 'a -> b -> a';
  }));
});

var failed = 0;
for (var i = 0; i < tests.length; i++) {
  try {
    tests[i].fn();
    console.log('ok   ' + tests[i].name);
  } catch (error) {
    failed++;
    console.log('FAIL ' + tests[i].name + ': ' + (error && error.stack ? error.stack.split('\n').slice(0, 6).join('\n    ') : String(error)));
  }
}
console.log('\n' + (tests.length - failed) + '/' + tests.length + ' passed');
process.exit(failed ? 1 : 0);