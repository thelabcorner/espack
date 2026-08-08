#!/usr/bin/env node
// ESPACK vendor sync: copies the esb64 artifacts into vendor/ so espack is
// self-contained (no sibling-repo dependency at build time). Mirrors the
// eson/json2 vendoring convention; tests/vendor-sync-test.mjs guards drift.
//
//   node espack-vendor-sync.mjs [--check] [--quiet]
//
// Sources (override with env): ESB64_RUNTIME_SRC, ESB64_NATIVE_SRC.
// Defaults: ../esb64/dist/vendor-esb64-runtime.js and
// ../esb64/native/bin/ESB64Native.dll (the upstream build outputs).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

var ROOT = dirname(fileURLToPath(import.meta.url));

var SOURCES = {
  'esb64-runtime.js': process.env.ESB64_RUNTIME_SRC || join(ROOT, '..', 'esb64', 'dist', 'vendor-esb64-runtime.js'),
  'ESB64Native.dll': process.env.ESB64_NATIVE_SRC || join(ROOT, '..', 'esb64', 'native', 'bin', 'ESB64Native.dll')
};

var checkOnly = process.argv.includes('--check');
var quiet = process.argv.includes('--quiet');

var failures = [];
Object.keys(SOURCES).forEach(function (name) {
  var src = SOURCES[name];
  var dst = join(ROOT, 'vendor', name);
  if (!existsSync(src)) {
    failures.push(name + ': source missing at ' + src + ' (build esb64 first or set the ESB64_*_SRC env)');
    return;
  }
  var srcBuf = readFileSync(src);
  if (checkOnly) {
    var dstExists = existsSync(dst);
    if (!dstExists) { failures.push(name + ': vendored copy missing'); return; }
    var dstBuf = readFileSync(dst);
    if (!srcBuf.equals(dstBuf)) failures.push(name + ': drift from upstream build');
  } else {
    writeFileSync(dst, srcBuf);
    if (!quiet) console.log('[espack-vendor-sync] ' + name + ' <- ' + src + ' (' + srcBuf.length + ' bytes)');
  }
});

if (failures.length) {
  failures.forEach(function (f) { console.error('[espack-vendor-sync] ' + (checkOnly ? 'CHECK FAIL: ' : 'FAIL: ') + f); });
  process.exit(1);
}
if (checkOnly && !quiet) console.log('[espack-vendor-sync] vendor files match upstream');
