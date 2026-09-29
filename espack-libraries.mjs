#!/usr/bin/env node
// ESPACK library-composition primitives.
//
// Manifest v1 remains the native/file payload contract. Manifest v2 keeps that
// contract intact and adds a build-time-resolved, flat library graph. Library
// source bytes live in the manifest so transitive composition is portable,
// byte-verifiable, and never depends on callers preloading sibling JSX files.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

function fail(message) {
  throw new Error('espack-libraries: ' + message);
}

function cleanId(value, label) {
  var id = String(value || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id)) {
    fail((label || 'library id') + ' must match [A-Za-z0-9][A-Za-z0-9_.-]*: ' + id);
  }
  return id;
}

function cleanGlobal(value, label) {
  var name = String(value || '');
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
    fail((label || 'global') + ' is not a portable identifier: ' + name);
  }
  return name;
}

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseSemver(value, label) {
  var raw = String(value || '').replace(/^v/, '');
  var m = /^(\d+)\.(\d+)\.(\d+)$/.exec(raw);
  if (!m) fail((label || 'version') + ' must be stable SemVer x.y.z: ' + String(value));
  return { raw: raw, major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function compareSemver(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function comparatorSatisfied(version, token) {
  var t = String(token || '').trim();
  if (!t || t === '*') return true;
  var wild = /^(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/.exec(t);
  if (wild && (wild[2] === undefined || wild[2] === 'x' || wild[2] === '*' ||
      wild[3] === undefined || wild[3] === 'x' || wild[3] === '*')) {
    if (version.major !== Number(wild[1])) return false;
    if (wild[2] !== undefined && wild[2] !== 'x' && wild[2] !== '*' &&
        version.minor !== Number(wild[2])) return false;
    if (wild[3] !== undefined && wild[3] !== 'x' && wild[3] !== '*' &&
        version.patch !== Number(wild[3])) return false;
    return true;
  }
  var prefix = '';
  var body = t;
  var cm = /^(>=|<=|>|<|=|\^|~)(.+)$/.exec(t);
  if (cm) { prefix = cm[1]; body = cm[2]; }
  var wanted = parseSemver(body, 'range token');
  var cmp = compareSemver(version, wanted);
  if (prefix === '>') return cmp > 0;
  if (prefix === '>=') return cmp >= 0;
  if (prefix === '<') return cmp < 0;
  if (prefix === '<=') return cmp <= 0;
  if (prefix === '^') {
    if (cmp < 0) return false;
    if (wanted.major > 0) return version.major === wanted.major;
    if (wanted.minor > 0) return version.major === 0 && version.minor === wanted.minor;
    return version.major === 0 && version.minor === 0 && version.patch === wanted.patch;
  }
  if (prefix === '~') {
    return cmp >= 0 && version.major === wanted.major && version.minor === wanted.minor;
  }
  return cmp === 0;
}

export function satisfiesRange(versionValue, rangeValue) {
  var version = parseSemver(versionValue, 'library version');
  var range = String(rangeValue === undefined || rangeValue === null ? '*' : rangeValue).trim();
  if (!range || range === '*') return true;
  var ors = range.split(/\s*\|\|\s*/);
  for (var i = 0; i < ors.length; i++) {
    var tokens = ors[i].trim().split(/\s+/).filter(Boolean);
    var ok = true;
    for (var j = 0; j < tokens.length; j++) {
      if (!comparatorSatisfied(version, tokens[j])) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

function normalizeRequirement(req, label, optionalDefault) {
  if (typeof req === 'string') {
    return { id: cleanId(req, label), range: '*', optional: optionalDefault === true };
  }
  if (!req || typeof req !== 'object') fail(label + ' must be an object or library id string');
  return {
    id: cleanId(req.id, label + '.id'),
    range: String(req.range === undefined || req.range === null ? '*' : req.range),
    optional: req.optional === true || optionalDefault === true
  };
}

function normalizeRequirements(list, label, optionalDefault) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) fail(label + ' must be an array');
  return list.map(function (req, i) {
    return normalizeRequirement(req, label + '[' + i + ']', optionalDefault);
  }).sort(function (a, b) {
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    if (a.range !== b.range) return a.range < b.range ? -1 : 1;
    return Number(a.optional) - Number(b.optional);
  });
}

function normalizeContract(list, label) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) fail(label + ' must be an array');
  return list.map(function (row, i) {
    if (!row || typeof row !== 'object') fail(label + '[' + i + '] must be an object');
    var name = String(row.name || '');
    if (!name) fail(label + '[' + i + '] missing name');
    var type = String(row.type || '');
    if (type && ['function', 'object', 'string', 'number', 'boolean'].indexOf(type) < 0) {
      fail(label + '[' + i + '] has unsupported type: ' + type);
    }
    return { name: name, type: type };
  }).sort(function (a, b) {
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return a.type < b.type ? -1 : a.type > b.type ? 1 : 0;
  });
}

function normalizeProvenance(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) fail('provenance must be an object');
  var out = {};
  ['package', 'repository', 'commit', 'tag', 'artifact'].forEach(function (key) {
    if (value[key] !== undefined && value[key] !== null && value[key] !== '') {
      out[key] = String(value[key]);
    }
  });
  return out;
}

export function libraryFromFile(options) {
  var opts = options || {};
  if (!opts.path) fail('libraryFromFile requires path');
  var bytes = readFileSync(opts.path);
  var id = cleanId(opts.id, 'library id');
  var version = parseSemver(opts.version, id + ' version').raw;
  var globalName = cleanGlobal(opts.global, id + ' global');
  return {
    id: id,
    version: version,
    activation: {
      global: globalName,
      type: String(opts.type || 'object'),
      contract: normalizeContract(opts.contract, id + '.activation.contract')
    },
    requires: normalizeRequirements(opts.requires, id + '.requires', false),
    optionalRequires: normalizeRequirements(opts.optionalRequires, id + '.optionalRequires', true),
    artifact: {
      fileName: String(opts.fileName || basename(opts.path)),
      encoding: 'utf8-base64',
      len: bytes.length,
      sha256: sha256Bytes(bytes),
      b64: bytes.toString('base64')
    },
    provenance: normalizeProvenance(opts.provenance)
  };
}

export function cloneLibrary(lib) {
  validateLibrary(lib, String(lib && lib.id || 'library'));
  return {
    id: String(lib.id),
    version: String(lib.version),
    activation: {
      global: String(lib.activation.global),
      type: String(lib.activation.type || 'object'),
      contract: normalizeContract(lib.activation.contract, lib.id + '.activation.contract')
    },
    requires: normalizeRequirements(lib.requires, lib.id + '.requires', false),
    optionalRequires: normalizeRequirements(lib.optionalRequires, lib.id + '.optionalRequires', true),
    artifact: {
      fileName: String(lib.artifact.fileName),
      encoding: String(lib.artifact.encoding),
      len: Number(lib.artifact.len),
      sha256: String(lib.artifact.sha256),
      b64: String(lib.artifact.b64)
    },
    provenance: normalizeProvenance(lib.provenance)
  };
}

export function cloneLibraries(libraries) {
  return (libraries || []).map(function (lib) { return cloneLibrary(lib); });
}

export function validateLibrary(lib, label) {
  if (!lib || typeof lib !== 'object') fail(label + ' is not an object');
  var id = cleanId(lib.id, label + '.id');
  parseSemver(lib.version, id + ' version');
  if (!lib.activation || typeof lib.activation !== 'object') fail(id + ' missing activation');
  cleanGlobal(lib.activation.global, id + ' activation.global');
  var type = String(lib.activation.type || 'object');
  if (type !== 'object' && type !== 'function' && type !== 'any') {
    fail(id + ' activation.type must be object, function, or any');
  }
  normalizeContract(lib.activation.contract, id + '.activation.contract');
  normalizeRequirements(lib.requires, id + '.requires', false);
  normalizeRequirements(lib.optionalRequires, id + '.optionalRequires', true);
  var a = lib.artifact;
  if (!a || typeof a !== 'object') fail(id + ' missing artifact');
  if (a.encoding !== 'utf8-base64') fail(id + ' unsupported artifact encoding: ' + String(a.encoding));
  if (!a.fileName) fail(id + ' artifact missing fileName');
  if (!(Number(a.len) >= 0)) fail(id + ' artifact len is invalid');
  if (!/^[0-9a-f]{64}$/.test(String(a.sha256 || ''))) fail(id + ' artifact sha256 is invalid');
  if (typeof a.b64 !== 'string') fail(id + ' artifact b64 is missing');
  var bytes = Buffer.from(a.b64, 'base64');
  if (bytes.length !== Number(a.len)) fail(id + ' artifact length mismatch: declared ' + a.len + ', decoded ' + bytes.length);
  var digest = sha256Bytes(bytes);
  if (digest !== a.sha256) fail(id + ' artifact sha256 mismatch: declared ' + a.sha256 + ', actual ' + digest);
  // Fail closed on invalid UTF-8. Re-encoding the decoded text must reproduce
  // the exact artifact bytes used to compute provenance.
  var text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) fail(id + ' artifact is not canonical UTF-8');
  normalizeProvenance(lib.provenance);
}

export function validateLibraryManifestFields(manifest, label) {
  if (!Array.isArray(manifest.libraries)) fail(label + ' libraries must be an array');
  if (!Array.isArray(manifest.entries)) fail(label + ' entries must be an array');
  manifest.libraries.forEach(function (lib, i) {
    validateLibrary(lib, label + '.libraries[' + i + ']');
  });
  manifest.entries.forEach(function (entry, i) {
    normalizeRequirement(entry, label + '.entries[' + i + ']', false);
  });
}

export function cloneCapabilities(capabilities) {
  if (capabilities === undefined || capabilities === null) return [];
  if (!Array.isArray(capabilities)) fail('capabilities must be an array');
  return capabilities.map(function (cap, i) {
    if (!cap || typeof cap !== 'object') fail('capabilities[' + i + '] must be an object');
    var id = cleanId(cap.id, 'capabilities[' + i + '].id');
    var provider = cleanId(cap.provider, id + '.provider');
    var mode = String(cap.mode || 'optional');
    if (mode !== 'optional' && mode !== 'required') fail(id + '.mode must be optional or required');
    var payloads = cap.payloads === undefined || cap.payloads === null ? [] : cap.payloads;
    if (!Array.isArray(payloads)) fail(id + '.payloads must be an array');
    return {
      id: id,
      provider: provider,
      mode: mode,
      payloads: payloads.map(function (name) { return String(name); }),
      accel: cap.accel === undefined || cap.accel === null || cap.accel === '' ? null : String(cap.accel)
    };
  });
}

export function validateCapabilities(capabilities, label) {
  cloneCapabilities(capabilities).forEach(function (cap) {
    if (!cap.payloads.length && !cap.accel) {
      fail(label + ' capability ' + cap.id + ' must name at least one payload or accelerator');
    }
  });
}

function candidatesById(libraries) {
  var map = Object.create(null);
  for (var i = 0; i < libraries.length; i++) {
    var lib = cloneLibrary(libraries[i]);
    var list = map[lib.id];
    if (!list) list = map[lib.id] = [];
    var duplicate = null;
    for (var j = 0; j < list.length; j++) {
      if (list[j].version === lib.version) { duplicate = list[j]; break; }
    }
    if (duplicate) {
      if (JSON.stringify(duplicate) !== JSON.stringify(lib)) {
        fail('composition conflict for ' + lib.id + '@' + lib.version +
          ': same identity/version has different bytes, activation, dependency metadata, or provenance');
      }
      continue;
    }
    list.push(lib);
    list.sort(function (a, b) {
      return compareSemver(parseSemver(b.version), parseSemver(a.version));
    });
  }
  return map;
}

function cloneConstraints(constraints) {
  var out = Object.create(null);
  Object.keys(constraints).forEach(function (id) { out[id] = constraints[id].slice(0); });
  return out;
}

function cloneSelected(selected) {
  var out = Object.create(null);
  Object.keys(selected).forEach(function (id) { out[id] = selected[id]; });
  return out;
}

function addConstraint(constraints, req) {
  if (!constraints[req.id]) constraints[req.id] = [];
  if (constraints[req.id].indexOf(req.range) < 0) constraints[req.id].push(req.range);
}

function allRangesSatisfied(lib, ranges) {
  for (var i = 0; i < ranges.length; i++) {
    if (!satisfiesRange(lib.version, ranges[i])) return false;
  }
  return true;
}

function solve(candidates, selected, constraints, pending) {
  if (pending.length === 0) return { selected: selected, constraints: constraints };
  var req = pending[0];
  var rest = pending.slice(1);
  var pool = candidates[req.id] || [];
  if (req.optional && pool.length === 0) return solve(candidates, selected, constraints, rest);

  var nextConstraints = cloneConstraints(constraints);
  addConstraint(nextConstraints, req);
  var ranges = nextConstraints[req.id];
  var current = selected[req.id];
  if (current) {
    if (!allRangesSatisfied(current, ranges)) {
      if (req.optional) return solve(candidates, selected, constraints, rest);
      return null;
    }
    return solve(candidates, selected, nextConstraints, rest);
  }

  var viable = pool.filter(function (lib) { return allRangesSatisfied(lib, ranges); });
  if (viable.length === 0) {
    if (req.optional) return solve(candidates, selected, constraints, rest);
    return null;
  }
  for (var i = 0; i < viable.length; i++) {
    var lib = viable[i];
    var nextSelected = cloneSelected(selected);
    nextSelected[lib.id] = lib;
    var deps = [];
    for (var j = 0; j < lib.requires.length; j++) deps.push(lib.requires[j]);
    for (var k = 0; k < lib.optionalRequires.length; k++) deps.push(lib.optionalRequires[k]);
    var result = solve(candidates, nextSelected, nextConstraints, deps.concat(rest));
    if (result) return result;
  }
  return null;
}

function cycleAndOrder(selected) {
  var state = Object.create(null);
  var order = [];
  var stack = [];
  var diagnostics = [];
  function visit(id, optionalEdge, fromId) {
    if (state[id] === 2) return;
    if (state[id] === 1) {
      var at = stack.indexOf(id);
      var cycle = stack.slice(at >= 0 ? at : 0).concat([id]);
      if (optionalEdge) {
        diagnostics.push({
          code: 'optional-cycle-dropped',
          library: fromId || '',
          dependency: id,
          cycle: cycle.join(' -> ')
        });
        return;
      }
      fail('required library cycle: ' + cycle.join(' -> '));
    }
    state[id] = 1;
    stack.push(id);
    var lib = selected[id];
    var required = lib.requires.slice(0);
    required.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
    for (var i = 0; i < required.length; i++) {
      if (!selected[required[i].id]) fail(lib.id + ' resolved without required dependency ' + required[i].id);
      visit(required[i].id, false, lib.id);
    }
    var optional = lib.optionalRequires.slice(0);
    optional.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
    for (var oi = 0; oi < optional.length; oi++) {
      var opt = optional[oi];
      if (selected[opt.id] && satisfiesRange(selected[opt.id].version, opt.range)) {
        visit(opt.id, true, lib.id);
      }
    }
    stack.pop();
    state[id] = 2;
    order.push(lib);
  }
  Object.keys(selected).sort().forEach(function (id) { visit(id, false, ''); });
  return { order: order, diagnostics: diagnostics };
}

export function resolveLibraries(libraries, entries) {
  var all = cloneLibraries(libraries || []);
  var roots = normalizeRequirements(entries || [], 'entries', false);
  if (all.length && roots.length === 0) fail('manifest contains libraries but no entry requirements');
  if (!all.length) return { libraries: [], entries: roots, constraints: {}, diagnostics: [] };
  var candidates = candidatesById(all);
  var result = solve(candidates, Object.create(null), Object.create(null), roots);
  if (!result) {
    var wanted = roots.map(function (r) { return r.id + '@' + r.range; }).join(', ');
    fail('no deterministic version solution satisfies composition roots: ' + wanted);
  }
  var ordered = cycleAndOrder(result.selected);
  var constraints = {};
  Object.keys(result.constraints).sort().forEach(function (id) {
    constraints[id] = result.constraints[id].slice(0).sort();
  });
  return {
    libraries: ordered.order,
    entries: roots,
    constraints: constraints,
    diagnostics: ordered.diagnostics
  };
}

export function decodeLibrarySource(lib) {
  validateLibrary(lib, String(lib && lib.id || 'library'));
  return Buffer.from(lib.artifact.b64, 'base64').toString('utf8');
}

function runtimeGlobalExpr() {
  return [
    'var g = null;',
    'try { if (typeof $ !== "undefined" && $.global) g = $.global; } catch (ignoreGlobal) {}',
    'if (!g) { try { g = (function () { return this; }()); } catch (ignoreFallback) {} }',
    'if (!g) throw new Error("ESPAK composition: global object unavailable");'
  ].join('\n');
}

function runtimeSpec(lib) {
  return {
    id: lib.id,
    version: lib.version,
    activation: {
      global: lib.activation.global,
      type: lib.activation.type,
      contract: lib.activation.contract || []
    },
    artifact: {
      sha256: lib.artifact.sha256
    }
  };
}

export function renderLibraryPlan(resolved) {
  var list = resolved && resolved.libraries ? resolved.libraries : [];
  if (!list.length) return '';
  var out = [
    '/* ESPACK library composition v2',
    '   deterministic order: ' + list.map(function (lib) {
      return lib.id + '@' + lib.version + '#' + lib.artifact.sha256.slice(0, 12);
    }).join(' -> '),
    '*/'
  ];
  for (var i = 0; i < list.length; i++) {
    var lib = list[i];
    out.push('(function () {');
    out.push(runtimeGlobalExpr());
    out.push('var control = g.ESPAK;');
    out.push('if (!control || control.supportsLibraryComposition !== true || typeof control.prepareLibrary !== "function") ' +
      'throw new Error("ESPAK composition: shared library control plane unavailable for ' + lib.id.replace(/"/g, '\\"') + '");');
    out.push('var spec = ' + JSON.stringify(runtimeSpec(lib)) + ';');
    out.push('if (control.prepareLibrary(spec)) {');
    out.push('/* ESPACK library ' + lib.id + '@' + lib.version + ' source=' + lib.artifact.fileName +
      ' sha256=' + lib.artifact.sha256 + ' */');
    out.push(decodeLibrarySource(lib));
    out.push('control.activateLibrary(spec);');
    out.push('}');
    out.push('}());');
  }
  return out.join('\n') + '\n';
}