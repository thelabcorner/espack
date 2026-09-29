#!/usr/bin/env node
// Focused live proof for manifest-v2 library composition through COMTool V2.
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createComToolRunner } from '../../extendscript-toolchain/src/comtool-compat.mjs';
import { makeManifest, writeManifest } from '../espack-build.mjs';
import { libraryFromFile } from '../espack-libraries.mjs';
import { merge } from '../espack-merge.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(ROOT, 'dist');
const DEP_SRC = join(DIST, '.compose-live-dep.jsx');
const APP_SRC = join(DIST, '.compose-live-app.jsx');
const DEP_MANIFEST = join(DIST, '.compose-live-dep.json');
const APP_MANIFEST = join(DIST, '.compose-live-app.json');
const OUT = join(DIST, '.compose-live.jsx');
const SUMMARY = join(DIST, '.compose-live.composition.json');
const COM = createComToolRunner();

function clean() {
  for (const file of [DEP_SRC, APP_SRC, DEP_MANIFEST, APP_MANIFEST, OUT, SUMMARY]) {
    try { if (existsSync(file)) rmSync(file, { force: true }); } catch (_) {}
  }
}
function slash(path) { return path.replace(/\\/g, '/').replace(/"/g, '\\"'); }

clean();
try {
  writeFileSync(DEP_SRC,
    '(function(){ $.global.__ESPAK_LIVE_DEP_RUNS__=($.global.__ESPAK_LIVE_DEP_RUNS__||0)+1;' +
    '$.global.ESPACK_LIVE_DEP={ping:function(){return 42;}}; }());\n', 'utf8');
  writeFileSync(APP_SRC,
    '(function(){ if(!$.global.ESPACK_LIVE_DEP||$.global.ESPACK_LIVE_DEP.ping()!==42)' +
    'throw new Error("dependency did not activate first");' +
    '$.global.__ESPAK_LIVE_APP_RUNS__=($.global.__ESPAK_LIVE_APP_RUNS__||0)+1;' +
    '$.global.ESPACK_LIVE_APP={ok:function(){return true;}}; }());\n', 'utf8');

  const depLibrary = libraryFromFile({
    path: DEP_SRC,
    id: 'espack-live-dep',
    version: '1.0.0',
    global: 'ESPACK_LIVE_DEP',
    contract: [{ name: 'ping', type: 'function' }],
    provenance: { producer: 'espack-live-test' }
  });
  const appLibrary = libraryFromFile({
    path: APP_SRC,
    id: 'espack-live-app',
    version: '1.0.0',
    global: 'ESPACK_LIVE_APP',
    requires: [{ id: 'espack-live-dep', range: '^1.0.0' }],
    contract: [{ name: 'ok', type: 'function' }],
    provenance: { producer: 'espack-live-test' }
  });
  const dep = makeManifest({
    bundleName: 'espack-live-dep',
    cacheDir: '',
    payloads: [],
    accel: null,
    libraries: [depLibrary],
    entries: [{ id: 'espack-live-dep', range: '=1.0.0' }]
  });
  const appManifest = makeManifest({
    bundleName: 'espack-live-app',
    cacheDir: '',
    payloads: [],
    accel: null,
    libraries: [appLibrary],
    entries: [{ id: 'espack-live-app', range: '=1.0.0' }]
  });
  writeManifest(DEP_MANIFEST, dep);
  writeManifest(APP_MANIFEST, appManifest);
  const built = merge({
    manifests: [APP_MANIFEST, DEP_MANIFEST],
    entries: [{ id: 'espack-live-app', range: '=1.0.0' }],
    name: 'espack-compose-live',
    out: OUT,
    manifestOut: SUMMARY
  });
  const activationOrder = built.libraries.map(function (lib) { return lib.id; });
  if (activationOrder.join(',') !== 'espack-live-dep,espack-live-app') {
    throw new Error('unexpected activation order: ' + activationOrder.join(','));
  }

  const status = await COM.run(['status']);
  if (!status.ok || !status.result) {
    console.log('[espack-compose-live] SKIP: Illustrator is not reachable through COMTool V2');
    process.exitCode = 2;
  } else {
    const path = slash(OUT);
    const firstCode = [
      '$.global.__ESPAK_LIBRARIES__ = null;',
      '$.global.ESPAK = null;',
      '$.global.ESPACK_LIVE_DEP = null;',
      '$.global.ESPACK_LIVE_APP = null;',
      '$.global.__ESPAK_LIVE_DEP_RUNS__ = 0;',
      '$.global.__ESPAK_LIVE_APP_RUNS__ = 0;',
      '$.evalFile(File("' + path + '"));',
      'return {',
      'host: app.version, engine: $.version,',
      'depRuns: $.global.__ESPAK_LIVE_DEP_RUNS__,',
      'appRuns: $.global.__ESPAK_LIVE_APP_RUNS__,',
      'dep: $.global.ESPACK_LIVE_DEP.ping(),',
      'app: $.global.ESPACK_LIVE_APP.ok(),',
      'control: $.global.ESPAK.supportsLibraryComposition === true,',
      'depVersion: $.global.ESPAK.libraryInfo("espack-live-dep").version,',
      'appVersion: $.global.ESPAK.libraryInfo("espack-live-app").version',
      '};'
    ].join('\n');
    const first = await COM.run(['eval', '--code', firstCode], { timeoutMs: 180000 });
    if (!first.ok || !first.result) throw new Error('first live evaluation failed: ' + JSON.stringify(first));
    const one = first.result;
    const checks = [
      one.depRuns === 1,
      one.appRuns === 1,
      one.dep === 42,
      one.app === true,
      one.control === true,
      one.depVersion === '1.0.0',
      one.appVersion === '1.0.0'
    ];
    if (checks.some(function (x) { return !x; })) {
      throw new Error('first live evaluation mismatch: ' + JSON.stringify(one));
    }

    const second = await COM.run(['eval', '--code',
      '$.evalFile(File("' + path + '")); return {' +
      'host:app.version,engine:$.version,' +
      'depRuns:$.global.__ESPAK_LIVE_DEP_RUNS__,' +
      'appRuns:$.global.__ESPAK_LIVE_APP_RUNS__};'
    ], { timeoutMs: 180000 });
    if (!second.ok || !second.result ||
        second.result.depRuns !== 1 || second.result.appRuns !== 1) {
      throw new Error('cross-evaluation dedup failed: ' + JSON.stringify(second));
    }
    console.log(
      '[espack-compose-live] PASS order+activation+cross-evaluation-dedup on Illustrator ' +
      one.host + ' / ExtendScript ' + one.engine
    );
  }
} finally {
  try {
    await COM.run(['eval', '--code',
      '$.global.ESPACK_LIVE_DEP=null;$.global.ESPACK_LIVE_APP=null;' +
      '$.global.__ESPAK_LIVE_DEP_RUNS__=null;$.global.__ESPAK_LIVE_APP_RUNS__=null;return true;'
    ], { timeoutMs: 30000 });
  } catch (_) {}
  await COM.close().catch(function () {});
  clean();
}