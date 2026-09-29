#!/usr/bin/env node
// ESPACK manifest merge tool: reads espack-manifest-v1 sidecars and re-renders
// one normal ESPACK loader with one shared accelerator and N payload DLLs.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeManifest, readManifest, renderBundle, validateManifest, writeManifest } from './espack-build.mjs';
import { cloneCapabilities, renderLibraryPlan, resolveLibraries } from './espack-libraries.mjs';

var ROOT = dirname(fileURLToPath(import.meta.url));
var COMPOSITION_RUNTIME = join(ROOT, 'src', 'composition-runtime.jsx');

function usage() {
  console.log('usage: node espack-merge.mjs --merge <m1.json> <m2.json> [more.json ...] --out <bundle.jsx> [--name <name>] [--cache-dir <abs>] [--accel-dir <abs>] [--manifest-out <json>] [--quiet]');
}

function parseArgs(argv) {
  var out = { manifests: [], out: null, name: null, cacheDir: undefined, accelDir: '', manifestOut: null, deferB64: false, quiet: false };
  for (var i = 2; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--merge') {
      while (i + 1 < argv.length && argv[i + 1].indexOf('--') !== 0) out.manifests.push(argv[++i]);
    } else if (a === '--out') out.out = argv[++i];
    else if (a === '--name') out.name = argv[++i];
    else if (a === '--cache-dir') out.cacheDir = argv[++i];
    else if (a === '--accel-dir') out.accelDir = argv[++i];
    else if (a === '--manifest-out') out.manifestOut = argv[++i];
    else if (a === '--defer-b64') out.deferB64 = true;
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
  var libraries = [];
  var entries = [];
  var capabilities = [];
  var capabilityById = Object.create(null);
  list.forEach(function (m) {
    if (m.version === 2) {
      for (var li = 0; li < m.libraries.length; li++) libraries.push(m.libraries[li]);
      var manifestCapabilities = cloneCapabilities(m.capabilities || []);
      for (var ci = 0; ci < manifestCapabilities.length; ci++) {
        var cap = manifestCapabilities[ci];
        var priorCap = capabilityById[cap.id];
        if (priorCap) {
          if (JSON.stringify(priorCap) !== JSON.stringify(cap)) {
            throw new Error('espack-merge: capability conflict for ' + cap.id);
          }
        } else {
          capabilityById[cap.id] = cap;
          capabilities.push(cap);
        }
      }
      for (var ei = 0; ei < m.entries.length; ei++) {
        var entry = m.entries[ei];
        var normalizedEntry = typeof entry === 'string'
          ? { id: String(entry), range: '*' }
          : { id: String(entry.id), range: String(entry.range === undefined || entry.range === null ? '*' : entry.range) };
        var duplicateEntry = false;
        for (var ex = 0; ex < entries.length; ex++) {
          if (entries[ex].id === normalizedEntry.id && entries[ex].range === normalizedEntry.range) {
            duplicateEntry = true;
            break;
          }
        }
        if (!duplicateEntry) entries.push(normalizedEntry);
      }
    }
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
  var requestedEntries = opts.entries === undefined ? entries : opts.entries;
  var resolved = resolveLibraries(libraries, requestedEntries);
  var selectedProviders = Object.create(null);
  resolved.libraries.forEach(function (lib) { selectedProviders[lib.id] = true; });
  var selectedCapabilities = capabilities.filter(function (cap) {
    return selectedProviders[cap.provider] === true;
  });
  return makeManifest({
    bundleName: bundleName,
    cacheDir: cacheDir,
    payloads: payloads,
    accel: accel,
    libraries: resolved.libraries,
    entries: resolved.entries,
    capabilities: selectedCapabilities
  });
}

export function merge(options) {
  var opts = options || {};
  if (!opts.out) throw new Error('espack-merge: --out is required');
  var manifest = mergeManifests(opts.manifests || opts.merge || [], opts);
  var accelForRender = manifest.accel ? cloneAccel(manifest.accel) : null;
  if (accelForRender && opts.accelDir !== undefined) accelForRender.dir = normalizePathOption(opts.accelDir);
  var resolvedLibraries = resolveLibraries(manifest.libraries || [], manifest.entries || []);
  var hasNativePayloads = manifest.payloads.length > 0 || !!accelForRender;
  var hasLibraries = resolvedLibraries.libraries.length > 0;
  var text = '';
  if (hasNativePayloads || hasLibraries) {
    text = renderBundle({
      bundleName: manifest.bundleName,
      cacheDir: manifest.cacheDir,
      payloads: manifest.payloads,
      accel: accelForRender,
      standalone: false,
      /* A pure-JSX composition still gets the one ESPAK control plane but
         never needs a private codec. Native/file compositions preserve the
         caller's existing deferred-vs-inline base64 choice. */
      deferB64: hasNativePayloads ? !!opts.deferB64 : true
    });
  }
  if (hasLibraries) {
    text += '\n' + readFileSync(COMPOSITION_RUNTIME, 'utf8') + '\n';
  }
  var libraryText = renderLibraryPlan(resolvedLibraries);
  if (libraryText) text += (text ? '\n' : '') + libraryText;
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
    libraries: resolvedLibraries.libraries,
    entries: resolvedLibraries.entries,
    diagnostics: resolvedLibraries.diagnostics,
    capabilities: manifest.capabilities || [],
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
        (r.accel ? '  accel: ' + r.accel.fileName + ' (' + r.accel.len + ' B, shared)' : '  accel: none') +
        (r.libraries.length ? '  libraries: ' + r.libraries.map(function (lib) { return lib.id + '@' + lib.version; }).join(' -> ') : '') +
        (args.deferB64 ? '  base64: deferred (host ESB64)' : ''));
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
