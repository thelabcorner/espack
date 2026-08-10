#!/usr/bin/env node
// ESPACK build tool: embeds ExternalObject DLLs as base64 inside a single
// self-extracting .jsx bundle in the "1 + n" model:
//   - n payload DLLs (--embed, repeatable; loaded by index/name at runtime)
//   - 1 shared esb64 accelerator DLL (--accel, auto-discovered by default),
//     unpacked once per system (%LOCALAPPDATA%/espack) via the JSX lane,
//     then used to decode every payload natively (b64decodeToFile).
//
//   node espack-build.mjs --embed <dll>[=<ver>] [--embed <dll2>=<ver> ...] \
//        --out <bundle.jsx> \
//        [--name <bundle-name>] [--dll-version <v>] [--cache-dir <abs>] \
//        [--accel <dll> | --no-accel] [--accel-version <v>] [--accel-dir <abs>] \
//        [--manifest-out <bundle.espack.json>] [--standalone] [--quiet]
//
// The emitted bundle is self-contained: it inlines the esb64 atob lane
// (vendor-esb64-runtime.js from the sibling esb64 repo, or
// $ESB64_RUNTIME_PATH) so nothing is loaded from disk except the DLLs the
// bundle itself materializes at runtime. Output is deterministic.
import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

var VERSION = '0.3.0';
var CHUNK_SIZE = 24576; // measured on Illustrator 30.6.0: atob decode is linear
// (~1 us/base64 char, no engine wedge through 64K passes); 24K is conservative.

var ROOT = dirname(fileURLToPath(import.meta.url));
var TEMPLATE = join(ROOT, 'src', 'loader.jsx');
var DEFAULT_RUNTIME = join(ROOT, 'vendor', 'esb64-runtime.js');
var DEFAULT_ACCEL = join(ROOT, 'vendor', 'ESB64Native.dll');

var TOKENS = [
  '__ESPAK_VERSION__', '__BUNDLE_NAME__', '__CACHE_DIR__', '__CHUNK_SIZE__',
  '__PAYLOADS__', '__PAYLOAD_SUMMARY__',
  '__ACCEL_NAME__', '__ACCEL_VERSION__', '__ACCEL_LEN__', '__ACCEL_B64__',
  '__ACCEL_DIR__', '__ACCEL_SUMMARY__',
  '__ESB64_RUNTIME__'
];

function usage() {
  console.log('usage: node espack-build.mjs --embed <dll>[=<ver>] [--embed ...] --out <bundle.jsx> [--name <name>] [--dll-version <v>] [--cache-dir <abs>] [--accel <dll> | --no-accel] [--accel-version <v>] [--accel-dir <abs>] [--manifest-out <json>] [--standalone] [--quiet]');
}

function parseArgs(argv) {
  var out = { embeds: [], out: null, name: null, dllVersion: '1', cacheDir: undefined, accel: undefined, accelVersion: '1', accelDir: '', manifestOut: null, standalone: false, quiet: false };
  for (var i = 2; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--embed') out.embeds.push(argv[++i]);
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--name') out.name = argv[++i];
    else if (a === '--dll-version') out.dllVersion = argv[++i];
    else if (a === '--cache-dir') out.cacheDir = argv[++i];
    else if (a === '--accel') out.accel = argv[++i];
    else if (a === '--no-accel') out.accel = false;
    else if (a === '--accel-version') out.accelVersion = argv[++i];
    else if (a === '--accel-dir') out.accelDir = argv[++i];
    else if (a === '--manifest-out') out.manifestOut = argv[++i];
    else if (a === '--standalone') out.standalone = true;
    else if (a === '--quiet') out.quiet = true;
    else { console.error('espack: unknown option: ' + a); usage(); process.exit(2); }
  }
  if (!out.out) { usage(); process.exit(2); }
  return out;
}

function sanitize(name, fallback) {
  var s = String(name).replace(/[^A-Za-z0-9_.\-]/g, '_');
  return s || fallback;
}

function resolveEmbedSpec(spec, defaultVersion) {
  var path = String(spec);
  var ver = defaultVersion;
  var eq = path.lastIndexOf('=');
  if (eq > 0 && eq < path.length - 1 && path.indexOf('=', eq + 1) < 0) {
    ver = path.substring(eq + 1);
    path = path.substring(0, eq);
  }
  return { path: path, version: ver };
}

function normalizePathOption(v) {
  return v === undefined || v === null ? '' : String(v).replace(/\\/g, '/');
}

function embedPayload(spec, defaultVersion) {
  var r = resolveEmbedSpec(spec, defaultVersion);
  if (!existsSync(r.path)) throw new Error('espack: DLL not found: ' + r.path);
  var st = statSync(r.path);
  if (!st.isFile()) throw new Error('espack: not a file: ' + r.path);
  var bytes = readFileSync(r.path);
  var name = sanitize(basename(r.path, extname(r.path)), 'payload');
  var version = sanitize(r.version, '1');
  return {
    name: name,
    version: version,
    len: bytes.length,
    b64: bytes.toString('base64'),
    fileName: name + '_v' + version + '.dll'
  };
}

export function makeManifest(opts) {
  return {
    format: 'espack-manifest',
    version: 1,
    bundleName: opts.bundleName,
    cacheDir: opts.cacheDir,
    chunkSize: CHUNK_SIZE,
    accel: opts.accel ? cloneManifestAccel(opts.accel) : null,
    payloads: clonePayloads(opts.payloads || []),
  };
}

function clonePayload(p) {
  return {
    name: String(p.name),
    version: String(p.version),
    len: Number(p.len),
    b64: String(p.b64),
    fileName: String(p.fileName || (p.name + '_v' + p.version + '.dll'))
  };
}

function clonePayloads(payloads) {
  return payloads.map(function (p) { return clonePayload(p); });
}

function cloneAccel(a) {
  return {
    name: String(a.name),
    version: String(a.version),
    len: Number(a.len),
    b64: String(a.b64),
    fileName: String(a.fileName || (a.name + '_v' + a.version + '.dll')),
    dir: normalizePathOption(a.dir)
  };
}

function cloneManifestAccel(a) {
  return {
    name: String(a.name),
    version: String(a.version),
    len: Number(a.len),
    b64: String(a.b64),
    fileName: String(a.fileName || (a.name + '_v' + a.version + '.dll'))
  };
}

export function writeManifest(path, manifest) {
  var outDir = dirname(path);
  if (outDir) mkdirSync(outDir, { recursive: true });
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

export function readManifest(path) {
  var raw = readFileSync(path, 'utf8');
  var m;
  try { m = JSON.parse(raw); } catch (e) { throw new Error('espack: invalid manifest JSON: ' + path + ': ' + e.message); }
  validateManifest(m, path);
  return m;
}

export function validateManifest(m, label) {
  if (!m || typeof m !== 'object') throw new Error('espack: manifest is not an object: ' + label);
  if (m.format !== 'espack-manifest') throw new Error('espack: unsupported manifest format in ' + label + ': ' + String(m.format));
  if (m.version !== 1) throw new Error('espack: unsupported manifest version in ' + label + ': ' + String(m.version));
  if (m.bundleName === undefined || m.bundleName === null || m.bundleName === '') throw new Error('espack: manifest missing bundleName: ' + label);
  if (m.cacheDir === undefined || m.cacheDir === null) throw new Error('espack: manifest missing cacheDir: ' + label);
  if (m.chunkSize !== CHUNK_SIZE) throw new Error('espack: unsupported manifest chunkSize in ' + label + ': ' + String(m.chunkSize));
  if (!Array.isArray(m.payloads)) throw new Error('espack: manifest payloads must be an array: ' + label);
  m.payloads.forEach(function (p, i) {
    if (!p || typeof p !== 'object') throw new Error('espack: invalid payload #' + i + ' in ' + label);
    ['name', 'version', 'len', 'b64', 'fileName'].forEach(function (k) {
      if (p[k] === undefined || p[k] === null || p[k] === '') throw new Error('espack: payload #' + i + ' missing ' + k + ' in ' + label);
    });
  });
  if (m.accel) {
    ['name', 'version', 'len', 'b64', 'fileName'].forEach(function (k) {
      if (m.accel[k] === undefined || m.accel[k] === null || m.accel[k] === '') throw new Error('espack: accel missing ' + k + ' in ' + label);
    });
  }
}

function payloadsLiteral(payloads) {
  return '[' +
    payloads.map(function (p) {
      return '{ name: ' + JSON.stringify(p.name) + ', version: ' + JSON.stringify(p.version) +
        ', len: ' + p.len + ', b64: ' + JSON.stringify(p.b64) + ', fileName: ' + JSON.stringify(p.fileName) + ' }';
    }).join(', ') +
    ']';
}

export function renderBundle(opts) {
  var runtimePath = opts.runtimePath || process.env.ESB64_RUNTIME_PATH || DEFAULT_RUNTIME;
  if (!existsSync(runtimePath)) {
    throw new Error('espack: esb64 runtime not found at ' + runtimePath + ' (build esb64 first or set ESB64_RUNTIME_PATH)');
  }

  var template = readFileSync(TEMPLATE, 'utf8');
  var runtime = readFileSync(runtimePath, 'utf8');
  var payloads = clonePayloads(opts.payloads || []);
  var accel = opts.accel ? cloneAccel(opts.accel) : null;

  // the inlined atob/btoa lane: wrap the vetted esb64 runtime in a local scope
  // and surface the ESB64 exports object as __espakB64 (its internal `var
  // ESB64` becomes function-local; the runtime's own gap-fill footer is inert
  // inside this scope and does not leak).
  var runtimeWrapper = 'var __espakB64 = (function () {\n' + runtime + '\nreturn ESB64;\n}());';

  var payloadSummary = payloads.length
    ? payloads.map(function (p) { return p.name + '_v' + p.version + '.dll (' + p.len + ' B)'; }).join(', ')
    : '(none)';
  var accelSummary = accel ? accel.name + '_v' + accel.version + '.dll (' + accel.len + ' B, shared)' : '(none)';

  var out = template;
  var replacements = {
    __ESPAK_VERSION__: VERSION,
    __BUNDLE_NAME__: opts.bundleName,
    __CACHE_DIR__: opts.cacheDir,
    __CHUNK_SIZE__: String(CHUNK_SIZE),
    __PAYLOADS__: payloadsLiteral(payloads),
    __PAYLOAD_SUMMARY__: payloadSummary,
    __ACCEL_NAME__: accel ? accel.name : '',
    __ACCEL_VERSION__: accel ? accel.version : '1',
    __ACCEL_LEN__: accel ? String(accel.len) : '0',
    __ACCEL_B64__: accel ? accel.b64 : '',
    __ACCEL_DIR__: accel ? accel.dir : '',
    __ACCEL_SUMMARY__: accelSummary,
    __ESB64_RUNTIME__: runtimeWrapper
  };
  TOKENS.forEach(function (tok) {
    out = out.split(tok).join(replacements[tok]);
  });

  // token hygiene: no replacement token may remain (the runtime's own
  // __-prefixed identifiers are fine; only exact token names are checked).
  var leftover = [];
  TOKENS.forEach(function (tok) {
    if (out.indexOf(tok) >= 0) leftover.push(tok);
  });
  if (leftover.length) throw new Error('espack: unreplaced tokens: ' + leftover.join(', '));

  if (opts.standalone) {
    out = '#target illustrator\n' + out;
  }

  return out;
}

export function build(options) {
  var opts = options || {};
  if (!opts.out) throw new Error('espack: --out is required');
  var embedList = [].concat(opts.embed || []);
  if (opts.embeds) embedList = embedList.concat(opts.embeds);
  if (embedList.length === 0 && (opts.accel === undefined || opts.accel === false)) {
    throw new Error('espack: nothing to embed (--embed <dll> or --accel <dll> required)');
  }

  var outName = basename(opts.out, extname(opts.out));
  var bundleName = sanitize(opts.name || outName, outName);
  var cacheDir = normalizePathOption(opts.cacheDir);

  var payloads = [];
  for (var i = 0; i < embedList.length; i++) {
    payloads.push(embedPayload(embedList[i], opts.dllVersion || '1'));
  }

  // Shared accelerator: explicit --accel, auto-discovered sibling, or none.
  var accel = null;
  var accelPath = opts.accel;
  if (accelPath === undefined) {
    var discovered = process.env.ESB64_ACCEL_PATH || DEFAULT_ACCEL;
    if (existsSync(discovered)) accelPath = discovered;
  }
  if (accelPath !== undefined && accelPath !== false) {
    var spec = resolveEmbedSpec(accelPath, opts.accelVersion || '1');
    if (!existsSync(spec.path)) throw new Error('espack: accelerator DLL not found: ' + spec.path);
    var st = statSync(spec.path);
    if (!st.isFile()) throw new Error('espack: not a file: ' + spec.path);
    var bytes = readFileSync(spec.path);
    accel = {
      name: sanitize(basename(spec.path, extname(spec.path)), 'ESB64Native'),
      version: sanitize(spec.version, '1'),
      len: bytes.length,
      b64: bytes.toString('base64'),
      fileName: sanitize(basename(spec.path, extname(spec.path)), 'ESB64Native') + '_v' + sanitize(spec.version, '1') + '.dll',
      dir: normalizePathOption(opts.accelDir)
    };
  }

  var out = renderBundle({ bundleName: bundleName, cacheDir: cacheDir, payloads: payloads, accel: accel, standalone: opts.standalone });

  var outDir = dirname(opts.out);
  if (outDir) mkdirSync(outDir, { recursive: true });
  writeFileSync(opts.out, out, 'utf8');

  var manifest = makeManifest({ bundleName: bundleName, cacheDir: cacheDir, payloads: payloads, accel: accel, standalone: opts.standalone });
  if (opts.manifestOut) writeManifest(opts.manifestOut, manifest);

  return {
    outPath: opts.out,
    bundleName: bundleName,
    cacheDir: cacheDir,
    payloads: payloads,
    accel: accel,
    manifest: manifest,
    manifestPath: opts.manifestOut || null,
    text: out
  };
}

function main() {
  var args = parseArgs(process.argv);
  try {
    var r = build({
      embeds: args.embeds,
      out: args.out,
      name: args.name,
      dllVersion: args.dllVersion,
      cacheDir: args.cacheDir,
      accel: args.accel,
      accelVersion: args.accelVersion,
      accelDir: args.accelDir,
      manifestOut: args.manifestOut,
      standalone: args.standalone
    });
    if (!args.quiet) {
      console.log('[espack-build] payloads: ' + r.payloads.map(function (p) { return p.fileName + ' (' + p.len + ' B)'; }).join(', ') +
        (r.accel ? '  accel: ' + r.accel.fileName + ' (' + r.accel.len + ' B, shared)' : '  accel: none'));
      console.log('[espack-build] -> ' + r.outPath + ' (' + r.text.length + ' bytes)  bundle=' + r.bundleName +
        (r.cacheDir ? ' cache=' + r.cacheDir : ' cache=%LOCALAPPDATA%/' + r.bundleName) +
        ' chunk=' + CHUNK_SIZE + (args.standalone ? ' standalone' : ''));
      if (r.manifestPath) console.log('[espack-build] manifest -> ' + r.manifestPath);
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
