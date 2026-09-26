#!/usr/bin/env node
// Cross-repo espack composition test (true dedup validation across all repos).
//
// Composes EVERY espack consumer's manifest sidecar into ONE merged bundle
// through espack-merge (the same path arcfit's build.mjs uses), with
// --defer-b64 (single-base64 policy). Asserts the DRY invariants on the
// merged output:
//   1. exactly ONE loader runtime (2 "ESPAK: unknown payload" error sites)
//   2. no inline base64 runtime ("var __espakB64 = (function" == 0)
//   3. the --defer-b64 shim is present ("deferred base64 lane" >= 1)
//   4. payloads deduped to one per name (ESONJson + ESARRArray + ArcFit_IPC)
//   5. exactly ONE shared accelerator (ESB64Native_v2)
//
// Consumers (sibling repos, built with their npm run build:accel):
//   ../esb64/dist/ESB64.manifest.json   (accel-only "1")
//   ../eson/dist/ESON.manifest.json     (ESONJson.dll payload)
//   ../esarr/dist/ESARR.manifest.json   (ESARRArray.dll payload)
//   ../arcfit/dist/ArcFitIpc.espack.json (ArcFit_IPC.dll payload)
// Skips consumers whose manifest is absent (not built yet) — the invariants
// still hold on whatever subset is present.
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeManifests, merge } from '../espack-merge.mjs';

var ROOT = resolve(dirname(fileURLToPath(import.meta.url))); /* espack/tests */
var SCRIPTS = resolve(ROOT, '..', '..');                     /* Scripts folder */
var MERGED_OUT = join(ROOT, '.consumer-compose.merged.jsx');
process.on('exit', function () {
  try { if (existsSync(MERGED_OUT)) unlinkSync(MERGED_OUT); } catch (ignore) {}
});

var CONSUMERS = [
  { repo: 'esb64', manifest: join(SCRIPTS, 'esb64', 'dist', 'ESB64.manifest.json') },
  { repo: 'eson', manifest: join(SCRIPTS, 'eson', 'dist', 'ESON.manifest.json') },
  { repo: 'esarr', manifest: join(SCRIPTS, 'esarr', 'dist', 'ESARR.manifest.json') },
  { repo: 'arcfit', manifest: join(SCRIPTS, 'arcfit', 'dist', 'ArcFitIpc.espack.json') }
];

function count(text, needle) {
  var i = 0, c = 0;
  while ((i = text.indexOf(needle, i)) >= 0) { c++; i += needle.length; }
  return c;
}

var failures = 0;
function ok(cond, label, detail) {
  if (cond) console.log('ok   ' + label);
  else { failures++; console.log('FAIL ' + label + (detail ? ' — ' + detail : '')); }
}

var present = CONSUMERS.filter(function (c) { return existsSync(c.manifest); });
if (present.length === 0) {
  console.log('espack-consumer-compose: SKIP (no consumer manifests built; run each repo\'s build:accel first)');
  process.exit(0);
}
console.log('espack-consumer-compose: composing ' + present.map(function (c) { return c.repo; }).join(' + '));

// 1. mergeManifests must succeed and dedupe payloads by name / accel by bytes.
var manifests = present.map(function (c) { return c.manifest; });
var mergedManifest = mergeManifests(manifests, {});
var payloadNames = mergedManifest.payloads.map(function (p) { return p.name; }).sort();
ok(mergedManifest.payloads.length === new Set(payloadNames).size,
  'merge: payloads deduped to one per name', payloadNames.join(','));
if (mergedManifest.accel) {
  ok(mergedManifest.accel.name === 'ESB64Native' && mergedManifest.accel.version === '2',
    'merge: single shared accelerator ESB64Native_v2', mergedManifest.accel.fileName);
}

// 2. Render the merged bundle with --defer-b64 (the composer's D.R.Y path).
var out = merge({ manifests: manifests, deferB64: true, out: MERGED_OUT });
var text = out.text;

// 3. Dedup invariants on the merged bundle.
ok(count(text, 'ESPAK: unknown payload') === 2,
  'dedup: exactly ONE loader runtime (2 error sites)', String(count(text, 'ESPAK: unknown payload')));
ok(count(text, 'var __espakB64 = (function') === 0,
  'dedup: no inline base64 runtime', String(count(text, 'var __espakB64 = (function')));
ok(count(text, 'deferred base64 lane') >= 1, 'dedup: defer-b64 shim present');
ok(count(text, 'registerPayloadsFront') >= 1, 'dedup: idempotent loader API present');
ok(count(text, 'ESB64Native_v2.dll') === 1, 'dedup: accel spec appears once', String(count(text, 'ESB64Native_v2.dll')));

// 4. Parse the merged bundle (syntax check) — the composer emits ES3.
try {
  new Function(text);
  ok(true, 'merged bundle parses as JS');
} catch (e) {
  ok(false, 'merged bundle parses as JS', String(e));
}

// 5. Payload count matches the composed consumer set.
ok(out.payloads.length === mergedManifest.payloads.length,
  'merge: rendered payload count matches manifest', out.payloads.length + ' vs ' + mergedManifest.payloads.length);

console.log(failures === 0 ? '\nespack-consumer-compose: PASS' : '\nespack-consumer-compose: FAIL (' + failures + ')');
process.exit(failures ? 1 : 0);
