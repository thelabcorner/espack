#!/usr/bin/env node
// ESPACK manifest merge tool: reads espack-manifest-v1 sidecars and re-renders
// one normal ESPACK loader with one shared accelerator and N payload DLLs.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeManifest, readManifest, renderBundle, validateManifest, writeManifest } from './espack-build.mjs';

function usage() {
  console.log('usage: node espack-merge.mjs --merge <m1.json> <m2.json> [more.json ...] --out <bundle.jsx> [--name <name>] [--cache-dir <abs>] [--accel-dir <abs>] [--manifest-out <json>] [--quiet]');
}

function parseArgs(argv) {
  var out = { manifests: [], out: null, name: null, cacheDir: undefined, accelDir: '', manifestOut: null, quiet: false };
  for (var i = 2; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--merge') {
      while (i + 1 < argv.length && argv[i + 1].indexOf('--') !== 0) out.manifests.push(argv[++i]);
    } else if (a === '--out') out.out = argv[++i];
    else if (a === '--name') out.name = argv[++i];
    else if (a === '--cache-dir') out.cacheDir = argv[++i];
    else if (a === '--accel-dir') out.accelDir = argv[++i];
    else if (a === '--manifest-out') out.manifestOut = argv[++i];
    else if (a === '--quiet') out.quiet = true;
    else { console.error('espack-merge: unknown option: ' + a); usage(); process.exit(2); }
  }
  if (!out.out || out.manifests.length === 0) { usage(); process.exit(2); }
  return out;
}

function sanitize(name, fallback) {
  var s = String(name).replace(/[^A-Za-z0-9_.\-]/g, '_');
  return s || fallback;
}

function normalizePathOption(v) {
  return v === undefined || v === null ? '' : String(v).replace(/\\/g, '/');
}

function clonePayload(p) {
  return {
    name: String(p.name),
    version: String(p.version),
    len: Number(p.len),
    b64: String(p.b64),
    fileName: String(p.fileName)
  };
}

function cloneAccel(a) {
  return {
    name: String(a.name),
    version: String(a.version),
    len: Number(a.len),
    b64: String(a.b64),
    fileName: String(a.fileName),
    dir: ''
  };
}

function payloadSameBytes(a, b) {
  return a.name === b.name && a.version === b.version && a.len === b.len && a.b64 === b.b64;
}

function accelSame(a, b) {
  return a.name === b.name && a.version === b.version && a.len === b.len && a.b64 === b.b64;
}

function parseIntegerVersion(v, name) {
  var s = String(v);
  if (!/^\d+$/.test(s)) throw new Error('espack-merge: non-integer version for ' + name + ': ' + s);
  return Number(s);
}

export function mergeManifests(manifests, options) {
  var opts = options || {};
  var list = (manifests || []).map(function (m, i) {
    if (typeof m === 'string') return readManifest(m);
    validateManifest(m, 'manifest #' + i);
    return m;
  });
  if (list.length === 0) throw new Error('espack-merge: at least one manifest is required');

  var payloads = [];
  var byName = Object.create(null);
  var accel = null;
  list.forEach(function (m) {
    if (m.accel) {
      var a = cloneAccel(m.accel);
      if (!accel) accel = a;
      else if (!accelSame(accel, a)) throw new Error('espack-merge: accelerator conflict: ' + accel.fileName + ' vs ' + a.fileName);
    }
    m.payloads.forEach(function (payload) {
      var p = clonePayload(payload);
      var slot = byName[p.name];
      if (slot === undefined) {
        byName[p.name] = payloads.length;
        payloads.push(p);
        return;
      }
      var prev = payloads[slot];
      if (prev.version === p.version) {
        if (!payloadSameBytes(prev, p)) throw new Error('espack-merge: payload conflict for ' + p.name + ' v' + p.version);
        return;
      }
      var prevVersion = parseIntegerVersion(prev.version, prev.name);
      var nextVersion = parseIntegerVersion(p.version, p.name);
      if (nextVersion > prevVersion) payloads[slot] = p;
    });
  });

  var first = list[0];
  var outName = opts.out ? basename(opts.out, extname(opts.out)) : (first.bundleName || 'merged');
  var bundleName = sanitize(opts.name || first.bundleName || outName, outName);
  var cacheDir = opts.cacheDir === undefined ? normalizePathOption(first.cacheDir) : normalizePathOption(opts.cacheDir);
  if (accel && opts.accelDir !== undefined) accel.dir = normalizePathOption(opts.accelDir);
  return makeManifest({ bundleName: bundleName, cacheDir: cacheDir, payloads: payloads, accel: accel });
}

export function merge(options) {
  var opts = options || {};
  if (!opts.out) throw new Error('espack-merge: --out is required');
  var manifest = mergeManifests(opts.manifests || opts.merge || [], opts);
  var accelForRender = manifest.accel ? cloneAccel(manifest.accel) : null;
  if (accelForRender && opts.accelDir !== undefined) accelForRender.dir = normalizePathOption(opts.accelDir);
  var text = renderBundle({
    bundleName: manifest.bundleName,
    cacheDir: manifest.cacheDir,
    payloads: manifest.payloads,
    accel: accelForRender,
    standalone: false
  });
  var outDir = dirname(opts.out);
  if (outDir) mkdirSync(outDir, { recursive: true });
  writeFileSync(opts.out, text, 'utf8');
  if (opts.manifestOut) writeManifest(opts.manifestOut, manifest);
  return {
    outPath: opts.out,
    bundleName: manifest.bundleName,
    cacheDir: manifest.cacheDir,
    payloads: manifest.payloads,
    accel: manifest.accel,
    manifest: manifest,
    manifestPath: opts.manifestOut || null,
    text: text
  };
}

function main() {
  var args = parseArgs(process.argv);
  try {
    var r = merge(args);
    if (!args.quiet) {
      console.log('[espack-merge] payloads: ' + r.payloads.map(function (p) { return p.fileName + ' (' + p.len + ' B)'; }).join(', ') +
        (r.accel ? '  accel: ' + r.accel.fileName + ' (' + r.accel.len + ' B, shared)' : '  accel: none'));
      if (!r.accel) console.log('[espack-merge] warning: merged bundle is accel-less');
      console.log('[espack-merge] -> ' + r.outPath + ' (' + r.text.length + ' bytes)  bundle=' + r.bundleName +
        (r.cacheDir ? ' cache=' + r.cacheDir : ' cache=%LOCALAPPDATA%/' + r.bundleName));
      if (r.manifestPath) console.log('[espack-merge] manifest -> ' + r.manifestPath);
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
