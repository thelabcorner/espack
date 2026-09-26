#!/usr/bin/env node
// ESPACK vendor-sync guard: the vendored esb64 artifacts (vendor/) must match
// the upstream esb64 build outputs byte-for-byte, or every bundle built from
// them embeds a stale runtime/accelerator. Part of npm test (mirrors the
// esb64 vendor-sync guard convention).
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';

var ROOT = dirname(fileURLToPath(import.meta.url));
var SYNC = join(ROOT, '..', 'espack-vendor-sync.mjs');
var out = execFileSync(process.execPath, [SYNC, '--check', '--quiet'], { encoding: 'utf8' });
console.log('ok   vendor-sync: vendored esb64 runtime + accelerator match upstream');

// Direct ESTC gate on the vendored runtime (independent of the sync helper):
// the shipped atob lane must not carry esbuild module/descriptor helpers or
// persistent polyfill preludes. Skip only when the toolchain is genuinely absent
// (explicit opt-out via ESTC_DISABLE_GATE=1).
if (process.env.ESTC_DISABLE_GATE !== '1') {
  var runtimePath = join(ROOT, '..', 'vendor', 'esb64-runtime.js');
  if (!existsSync(runtimePath)) throw new Error('vendored esb64 runtime missing at ' + runtimePath);
  var require = createRequire(import.meta.url);
  var estcRoot = process.env.ESTC_ROOT || join(ROOT, '..', '..', 'extendscript-toolchain');
  var checkJsxText = require(join(estcRoot, 'src', 'check-jsx.mjs')).checkJsxText;
  var res = checkJsxText(readFileSync(runtimePath, 'utf8'), {
    file: runtimePath,
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
    throw new Error('vendored esb64 runtime failed the ESTC packaging gate:\n' + detail);
  }
  console.log('ok   vendor-sync: vendored esb64 runtime passes the ESTC ExtendScript packaging gate');
}
