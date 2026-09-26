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
//
// Packaging guard (provenance + compatibility):
//   - The upstream source of the vendored esb64 runtime MUST itself pass the
//     ESTC ExtendScript JSX gate (ESTC_EMBEDDED_GLOBAL_PATCH / ESTC_GLOBAL_PATCH
//     / ESTC_ESBUILD_MODULE_HELPER). An esbuild module/descriptor-helper runtime
//     that mutates shared Adobe engine built-ins must never be vendored.
//   - The vendored copy MUST pass the same gate AND be byte-identical to the
//     upstream source (drift check). This prevents an Illustrator-incompatible
//     esbuild bundle (the stale copy carried a persistent Object.defineProperty
//     / Function.prototype.bind polyfill prelude) from silently re-entering the
//     shipped ESPACK loader via the inlined atob lane.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

var ROOT = dirname(fileURLToPath(import.meta.url));

var SOURCES = {
  'esb64-runtime.js': process.env.ESB64_RUNTIME_SRC || join(ROOT, '..', 'esb64', 'dist', 'vendor-esb64-runtime.js'),
  'ESB64Native.dll': process.env.ESB64_NATIVE_SRC || join(ROOT, '..', 'esb64', 'native', 'bin', 'ESB64Native.dll')
};

// Resolve the ESTC JSX check API once (path is stable relative to the scripts
// root). Falls back to skipping the gate only when the toolchain is genuinely
// absent (explicit opt-out via ESTC_DISABLE_GATE=1), so a missing dependency can
// never silently re-vendor an incompatible runtime.
var estcCheck = null;
if (process.env.ESTC_DISABLE_GATE !== '1') {
  try {
    var require = createRequire(import.meta.url);
    var estcRoot = process.env.ESTC_ROOT || join(ROOT, '..', 'extendscript-toolchain');
    var checkMod = require(join(estcRoot, 'src', 'check-jsx.mjs'));
    estcCheck = checkMod.checkJsxText;
  } catch (e) {
    console.error('[espack-vendor-sync] ESTC gate unavailable: ' + e.message);
    process.exit(1);
  }
}

function assertRuntimeCompatible(label, text) {
  if (!estcCheck) return;
  var res = estcCheck(String(text), {
    file: label,
    mode: 'conservative',
    target: 'illustrator',
    requireTarget: false,
    allowIncludes: false,
    allowJson: false,
    allowedMissingBuiltins: [],
    allowedGlobalPatches: []
  });
  if (!res.ok) {
    var detail = res.diagnostics
      .filter(function (d) { return d.severity === 'error'; })
      .map(function (d) { return '    ' + d.code + ' ' + (d.line || 0) + ':' + (d.column || 0) + ' ' + d.message; })
      .join('\n');
    throw new Error(label + ' failed the ESTC ExtendScript packaging gate:\n' + detail);
  }
}

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
  // The esb64 runtime is the only JS/JSX vendored artifact; gate it for
  // Illustrator-incompatible esbuild module/descriptor helpers before it can be
  // copied into the shipped loader (provenance check on the upstream source).
  if (name === 'esb64-runtime.js') {
    try {
      assertRuntimeCompatible('upstream ' + src, srcBuf);
    } catch (e) {
      failures.push(name + ': ' + e.message);
      return;
    }
  }
  if (checkOnly) {
    var dstExists = existsSync(dst);
    if (!dstExists) { failures.push(name + ': vendored copy missing'); return; }
    var dstBuf = readFileSync(dst);
    if (!srcBuf.equals(dstBuf)) failures.push(name + ': drift from upstream build');
    if (name === 'esb64-runtime.js') {
      try {
        assertRuntimeCompatible('vendored ' + dst, dstBuf);
      } catch (e) {
        failures.push(name + ': ' + e.message);
      }
    }
  } else {
    writeFileSync(dst, srcBuf);
    if (!quiet) console.log('[espack-vendor-sync] ' + name + ' <- ' + src + ' (' + srcBuf.length + ' bytes)');
  }
});

if (failures.length) {
  failures.forEach(function (f) { console.error('[espack-vendor-sync] ' + (checkOnly ? 'CHECK FAIL: ' : 'FAIL: ') + f); });
  process.exit(1);
}
if (checkOnly && !quiet) console.log('[espack-vendor-sync] vendor files match upstream and pass the ESTC packaging gate');
