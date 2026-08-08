#!/usr/bin/env node
// ESPACK optimization microprototype v3 (temp harness - not part of the repo).
// Focused follow-up on the JSX-lane decode after v2 showed the loop dominates:
//   A. unroll/arg-count sweep of the trusted lane: L4 = 64-unroll (48-arg
//      fromCharCode), L5 = L4 + FLUSH 256 - vs L1 (esb64 atob) and L2 (32-unroll fast).
//   B. esb64 memo re-extraction check: does decoding the SAME chunk string twice
//      short-circuit (memoized) - the current lane's hidden re-extraction benefit?
//   C. alternating-round chunked A/B for tight stats (cancel drift).
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, tmpdir } from 'node:path';
import { fileURLToPath } from 'node:url';

var ROOT = dirname(fileURLToPath(import.meta.url));
var OUT = process.env.ESPAK_OPT_OUT || join(tmpdir(), 'espack-opt');
mkdirSync(OUT, { recursive: true });

var SCRIPTS = process.env.ESPAK_DEV_SCRIPTS || 'C:/Program Files/Adobe/Adobe Illustrator 2026/Presets/en_US/Scripts';
var VENDOR = join(ROOT, '..', 'vendor', 'esb64-runtime.js');
var TOOL = process.env.ILLUSTRATOR_COM_TOOL || SCRIPTS + '/agent-skills/illustrator-com-automation-skill/comtool/ILLUSTRATOR_COM_TOOL.py';
var PY = 'python';

if (!existsSync(VENDOR)) { console.error('vendor missing: ' + VENDOR); process.exit(1); }

// deterministic ~99 KB test payload (no external DLL dependency)
var esoBytes = Buffer.alloc(99328);
for (var pi = 0; pi < esoBytes.length; pi++) esoBytes[pi] = (pi * 131 + 7) & 0xff;
var esoB64 = esoBytes.toString('base64');
console.log('test payload: ' + esoBytes.length + ' B -> ' + esoB64.length + ' b64 chars');

function jsStr(s) { return '"' + s + '"'; }

// ---- L2 core (32-unroll, FLUSH 128) + L4 (64-unroll, 48-arg) + L5 (L4, FLUSH 256) ----
var FAST_LANE = [
  'var __esfast = (function () {',
  '  var T = [];',
  '  var i;',
  '  for (i = 0; i < 128; i++) T[i] = -1;',
  '  var ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";',
  '  for (i = 0; i < 64; i++) T[ALPHA.charCodeAt(i)] = i;',
  '  var CH = [];',
  '  for (i = 0; i < 256; i++) CH[i] = String.fromCharCode(i);',
  // ---- 32-unroll / 24-arg / FLUSH 128 (L2) ----
  '  function decode32(s, start, end) {',
  '    var n = end - start, body = n;',
  '    var last = s.charCodeAt(end - 1);',
  '    if (last === 61) { body = n - 1; if (s.charCodeAt(end - 2) === 61) body = n - 2; }',
  '    var out = [], buf = new Array(128), bi = 0;',
  '    var p0, p1, p2, p3, p4, p5, p6, p7, p8, p9, p10, p11, p12, p13, p14, p15;',
  '    var q0, q1, q2, q3, q4, q5, q6, q7, q8, q9, q10, q11, q12, q13, q14, q15;',
  '    var main32 = body - 31, i2 = start, LIM = start + main32;',
  '    while (i2 < LIM) {',
  '      p0 = T[s.charCodeAt(i2)]; p1 = T[s.charCodeAt(i2 + 1)]; p2 = T[s.charCodeAt(i2 + 2)]; p3 = T[s.charCodeAt(i2 + 3)];',
  '      p4 = T[s.charCodeAt(i2 + 4)]; p5 = T[s.charCodeAt(i2 + 5)]; p6 = T[s.charCodeAt(i2 + 6)]; p7 = T[s.charCodeAt(i2 + 7)];',
  '      p8 = T[s.charCodeAt(i2 + 8)]; p9 = T[s.charCodeAt(i2 + 9)]; p10 = T[s.charCodeAt(i2 + 10)]; p11 = T[s.charCodeAt(i2 + 11)];',
  '      p12 = T[s.charCodeAt(i2 + 12)]; p13 = T[s.charCodeAt(i2 + 13)]; p14 = T[s.charCodeAt(i2 + 14)]; p15 = T[s.charCodeAt(i2 + 15)];',
  '      q0 = T[s.charCodeAt(i2 + 16)]; q1 = T[s.charCodeAt(i2 + 17)]; q2 = T[s.charCodeAt(i2 + 18)]; q3 = T[s.charCodeAt(i2 + 19)];',
  '      q4 = T[s.charCodeAt(i2 + 20)]; q5 = T[s.charCodeAt(i2 + 21)]; q6 = T[s.charCodeAt(i2 + 22)]; q7 = T[s.charCodeAt(i2 + 23)];',
  '      q8 = T[s.charCodeAt(i2 + 24)]; q9 = T[s.charCodeAt(i2 + 25)]; q10 = T[s.charCodeAt(i2 + 26)]; q11 = T[s.charCodeAt(i2 + 27)];',
  '      q12 = T[s.charCodeAt(i2 + 28)]; q13 = T[s.charCodeAt(i2 + 29)]; q14 = T[s.charCodeAt(i2 + 30)]; q15 = T[s.charCodeAt(i2 + 31)];',
  '      buf[bi++] = String.fromCharCode(',
  '        (p0 << 2) + (p1 >> 4), ((p1 & 15) << 4) + (p2 >> 2), ((p2 & 3) << 6) + p3,',
  '        (p4 << 2) + (p5 >> 4), ((p5 & 15) << 4) + (p6 >> 2), ((p6 & 3) << 6) + p7,',
  '        (p8 << 2) + (p9 >> 4), ((p9 & 15) << 4) + (p10 >> 2), ((p10 & 3) << 6) + p11,',
  '        (p12 << 2) + (p13 >> 4), ((p13 & 15) << 4) + (p14 >> 2), ((p14 & 3) << 6) + p15,',
  '        (q0 << 2) + (q1 >> 4), ((q1 & 15) << 4) + (q2 >> 2), ((q2 & 3) << 6) + q3,',
  '        (q4 << 2) + (q5 >> 4), ((q5 & 15) << 4) + (q6 >> 2), ((q6 & 3) << 6) + q7,',
  '        (q8 << 2) + (q9 >> 4), ((q9 & 15) << 4) + (q10 >> 2), ((q10 & 3) << 6) + q11,',
  '        (q12 << 2) + (q13 >> 4), ((q13 & 15) << 4) + (q14 >> 2), ((q14 & 3) << 6) + q15',
  '      );',
  '      if (bi >= 128) { out[out.length] = buf.join(""); bi = 0; }',
  '      i2 += 32;',
  '    }',
  '    var endBody = start + body;',
  '    while (i2 + 3 < endBody) {',
  '      p0 = T[s.charCodeAt(i2)]; p1 = T[s.charCodeAt(i2 + 1)]; p2 = T[s.charCodeAt(i2 + 2)]; p3 = T[s.charCodeAt(i2 + 3)];',
  '      buf[bi++] = CH[(p0 << 2) + (p1 >> 4)] + CH[((p1 & 15) << 4) + (p2 >> 2)] + CH[((p2 & 3) << 6) + p3];',
  '      if (bi >= 128) { out[out.length] = buf.join(""); bi = 0; }',
  '      i2 += 4;',
  '    }',
  '    var rem = body & 3;',
  '    if (rem === 2) { p0 = T[s.charCodeAt(endBody - 2)]; p1 = T[s.charCodeAt(endBody - 1)]; buf[bi++] = CH[(p0 << 2) + (p1 >> 4)]; }',
  '    else if (rem === 3) { p0 = T[s.charCodeAt(endBody - 3)]; p1 = T[s.charCodeAt(endBody - 2)]; p2 = T[s.charCodeAt(endBody - 1)]; buf[bi++] = CH[(p0 << 2) + (p1 >> 4)] + CH[((p1 & 15) << 4) + (p2 >> 2)]; }',
  '    if (bi > 0) { buf.length = bi; out[out.length] = buf.join(""); }',
  '    return out.join("");',
  '  }',
  // ---- 64-unroll / 48-arg / FLUSH 256 (L4/L5) ----
  '  function decode64(s, start, end, flush) {',
  '    var n = end - start, body = n;',
  '    var last = s.charCodeAt(end - 1);',
  '    if (last === 61) { body = n - 1; if (s.charCodeAt(end - 2) === 61) body = n - 2; }',
  '    var out = [], buf = new Array(flush), bi = 0;',
  '    var p0, p1, p2, p3, p4, p5, p6, p7, p8, p9, p10, p11, p12, p13, p14, p15;',
  '    var q0, q1, q2, q3, q4, q5, q6, q7, q8, q9, q10, q11, q12, q13, q14, q15;',
  '    var r0, r1, r2, r3, r4, r5, r6, r7, r8, r9, r10, r11, r12, r13, r14, r15;',
  '    var s0, s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11, s12, s13, s14, s15;',
  '    var main64 = body - 63, i2 = start, LIM = start + main64;',
  '    while (i2 < LIM) {',
  '      p0 = T[s.charCodeAt(i2)]; p1 = T[s.charCodeAt(i2 + 1)]; p2 = T[s.charCodeAt(i2 + 2)]; p3 = T[s.charCodeAt(i2 + 3)];',
  '      p4 = T[s.charCodeAt(i2 + 4)]; p5 = T[s.charCodeAt(i2 + 5)]; p6 = T[s.charCodeAt(i2 + 6)]; p7 = T[s.charCodeAt(i2 + 7)];',
  '      p8 = T[s.charCodeAt(i2 + 8)]; p9 = T[s.charCodeAt(i2 + 9)]; p10 = T[s.charCodeAt(i2 + 10)]; p11 = T[s.charCodeAt(i2 + 11)];',
  '      p12 = T[s.charCodeAt(i2 + 12)]; p13 = T[s.charCodeAt(i2 + 13)]; p14 = T[s.charCodeAt(i2 + 14)]; p15 = T[s.charCodeAt(i2 + 15)];',
  '      q0 = T[s.charCodeAt(i2 + 16)]; q1 = T[s.charCodeAt(i2 + 17)]; q2 = T[s.charCodeAt(i2 + 18)]; q3 = T[s.charCodeAt(i2 + 19)];',
  '      q4 = T[s.charCodeAt(i2 + 20)]; q5 = T[s.charCodeAt(i2 + 21)]; q6 = T[s.charCodeAt(i2 + 22)]; q7 = T[s.charCodeAt(i2 + 23)];',
  '      q8 = T[s.charCodeAt(i2 + 24)]; q9 = T[s.charCodeAt(i2 + 25)]; q10 = T[s.charCodeAt(i2 + 26)]; q11 = T[s.charCodeAt(i2 + 27)];',
  '      q12 = T[s.charCodeAt(i2 + 28)]; q13 = T[s.charCodeAt(i2 + 29)]; q14 = T[s.charCodeAt(i2 + 30)]; q15 = T[s.charCodeAt(i2 + 31)];',
  '      r0 = T[s.charCodeAt(i2 + 32)]; r1 = T[s.charCodeAt(i2 + 33)]; r2 = T[s.charCodeAt(i2 + 34)]; r3 = T[s.charCodeAt(i2 + 35)];',
  '      r4 = T[s.charCodeAt(i2 + 36)]; r5 = T[s.charCodeAt(i2 + 37)]; r6 = T[s.charCodeAt(i2 + 38)]; r7 = T[s.charCodeAt(i2 + 39)];',
  '      r8 = T[s.charCodeAt(i2 + 40)]; r9 = T[s.charCodeAt(i2 + 41)]; r10 = T[s.charCodeAt(i2 + 42)]; r11 = T[s.charCodeAt(i2 + 43)];',
  '      r12 = T[s.charCodeAt(i2 + 44)]; r13 = T[s.charCodeAt(i2 + 45)]; r14 = T[s.charCodeAt(i2 + 46)]; r15 = T[s.charCodeAt(i2 + 47)];',
  '      s0 = T[s.charCodeAt(i2 + 48)]; s1 = T[s.charCodeAt(i2 + 49)]; s2 = T[s.charCodeAt(i2 + 50)]; s3 = T[s.charCodeAt(i2 + 51)];',
  '      s4 = T[s.charCodeAt(i2 + 52)]; s5 = T[s.charCodeAt(i2 + 53)]; s6 = T[s.charCodeAt(i2 + 54)]; s7 = T[s.charCodeAt(i2 + 55)];',
  '      s8 = T[s.charCodeAt(i2 + 56)]; s9 = T[s.charCodeAt(i2 + 57)]; s10 = T[s.charCodeAt(i2 + 58)]; s11 = T[s.charCodeAt(i2 + 59)];',
  '      s12 = T[s.charCodeAt(i2 + 60)]; s13 = T[s.charCodeAt(i2 + 61)]; s14 = T[s.charCodeAt(i2 + 62)]; s15 = T[s.charCodeAt(i2 + 63)];',
  '      buf[bi++] = String.fromCharCode(',
  '        (p0 << 2) + (p1 >> 4), ((p1 & 15) << 4) + (p2 >> 2), ((p2 & 3) << 6) + p3,',
  '        (p4 << 2) + (p5 >> 4), ((p5 & 15) << 4) + (p6 >> 2), ((p6 & 3) << 6) + p7,',
  '        (p8 << 2) + (p9 >> 4), ((p9 & 15) << 4) + (p10 >> 2), ((p10 & 3) << 6) + p11,',
  '        (p12 << 2) + (p13 >> 4), ((p13 & 15) << 4) + (p14 >> 2), ((p14 & 3) << 6) + p15,',
  '        (q0 << 2) + (q1 >> 4), ((q1 & 15) << 4) + (q2 >> 2), ((q2 & 3) << 6) + q3,',
  '        (q4 << 2) + (q5 >> 4), ((q5 & 15) << 4) + (q6 >> 2), ((q6 & 3) << 6) + q7,',
  '        (q8 << 2) + (q9 >> 4), ((q9 & 15) << 4) + (q10 >> 2), ((q10 & 3) << 6) + q11,',
  '        (q12 << 2) + (q13 >> 4), ((q13 & 15) << 4) + (q14 >> 2), ((q14 & 3) << 6) + q15,',
  '        (r0 << 2) + (r1 >> 4), ((r1 & 15) << 4) + (r2 >> 2), ((r2 & 3) << 6) + r3,',
  '        (r4 << 2) + (r5 >> 4), ((r5 & 15) << 4) + (r6 >> 2), ((r6 & 3) << 6) + r7,',
  '        (r8 << 2) + (r9 >> 4), ((r9 & 15) << 4) + (r10 >> 2), ((r10 & 3) << 6) + r11,',
  '        (r12 << 2) + (r13 >> 4), ((r13 & 15) << 4) + (r14 >> 2), ((r14 & 3) << 6) + r15,',
  '        (s0 << 2) + (s1 >> 4), ((s1 & 15) << 4) + (s2 >> 2), ((s2 & 3) << 6) + s3,',
  '        (s4 << 2) + (s5 >> 4), ((s5 & 15) << 4) + (s6 >> 2), ((s6 & 3) << 6) + s7,',
  '        (s8 << 2) + (s9 >> 4), ((s9 & 15) << 4) + (s10 >> 2), ((s10 & 3) << 6) + s11,',
  '        (s12 << 2) + (s13 >> 4), ((s13 & 15) << 4) + (s14 >> 2), ((s14 & 3) << 6) + s15',
  '      );',
  '      if (bi >= flush) { out[out.length] = buf.join(""); bi = 0; }',
  '      i2 += 64;',
  '    }',
  '    var endBody = start + body;',
  '    while (i2 + 3 < endBody) {',
  '      p0 = T[s.charCodeAt(i2)]; p1 = T[s.charCodeAt(i2 + 1)]; p2 = T[s.charCodeAt(i2 + 2)]; p3 = T[s.charCodeAt(i2 + 3)];',
  '      buf[bi++] = CH[(p0 << 2) + (p1 >> 4)] + CH[((p1 & 15) << 4) + (p2 >> 2)] + CH[((p2 & 3) << 6) + p3];',
  '      if (bi >= flush) { out[out.length] = buf.join(""); bi = 0; }',
  '      i2 += 4;',
  '    }',
  '    var rem = body & 3;',
  '    if (rem === 2) { p0 = T[s.charCodeAt(endBody - 2)]; p1 = T[s.charCodeAt(endBody - 1)]; buf[bi++] = CH[(p0 << 2) + (p1 >> 4)]; }',
  '    else if (rem === 3) { p0 = T[s.charCodeAt(endBody - 3)]; p1 = T[s.charCodeAt(endBody - 2)]; p2 = T[s.charCodeAt(endBody - 1)]; buf[bi++] = CH[(p0 << 2) + (p1 >> 4)] + CH[((p1 & 15) << 4) + (p2 >> 2)]; }',
  '    if (bi > 0) { buf.length = bi; out[out.length] = buf.join(""); }',
  '    return out.join("");',
  '  }',
  '  return { decode32: decode32, decode64: decode64 };',
  '}());'
].join('\n');

var probe = [
  '#target illustrator',
  '// generated by espack-opt-prep.mjs v3 - do not edit (temp optimization prototype)',
  'var __base = Folder.temp.fsName + "/espack-opt";',
  '(function () {',
  '  function ensureDir(fsPath) {',
  '    var parts = String(fsPath).split("/"), cur = parts[0] + "/" + parts[1], i, f;',
  '    for (i = 2; i < parts.length; i++) { cur += "/" + parts[i]; f = new Folder(cur); if (!f.exists && !f.create()) return false; }',
  '    return true;',
  '  }',
  '  ensureDir(__base);',
  '  function log(msg) { var f = new File(__base + "/opt3.log"); if (f.open("a")) { f.writeln(new Date().getTime() + " " + msg); f.close(); } }',
  '  var t0 = new Date().getTime();',
  '  log("start");',
  '  $.evalFile(File("' + VENDOR + '"));',
  '  log("vendor loaded +" + (new Date().getTime() - t0) + "ms");',
  FAST_LANE,
  '  var ESO = ' + jsStr(esoB64) + ';',
  '  var n = ESO.length;',
  '  var padN = 0;',
  '  if (ESO.charCodeAt(n - 1) === 61) { padN = ESO.charCodeAt(n - 2) === 61 ? 2 : 1; }',
  '  var body = ESO.substring(0, n - padN);',
  '  var tail = ESO.substring(n - padN);',
  '  var CS = 24576;',
  '  var LANES = [',
  '    ["L1", function (rot) { var acc = "", i; for (i = 0; i < n; i += CS) acc += ESB64.atob(rot.substring(i, Math.min(i + CS, n))).length; return acc; }],',
  '    ["L2", function (rot) { var acc = "", i; for (i = 0; i < n; i += CS) acc += __esfast.decode32(rot, i, Math.min(i + CS, n)).length; return acc; }],',
  '    ["L4", function (rot) { var acc = "", i; for (i = 0; i < n; i += CS) acc += __esfast.decode64(rot, i, Math.min(i + CS, n), 256).length; return acc; }]',
  '  ];',
  '  var ROUNDS = 8;',
  '  var out = { ok: true, engine: $.version, chunked: [], memo: {} };',
  '  var r, li;',
  '  log("alternating chunked A/B start");',
  '  for (r = 0; r < ROUNDS; r++) {',
  '    var rot = r === 0 ? ESO : (body.substring(r) + body.substring(0, r) + tail);',
  '    for (li = 0; li < LANES.length; li++) {',
  '      var lane = LANES[li][0], fn = LANES[li][1];',
  '      var t1 = new Date().getTime();',
  '      var sum = fn(rot);',
  '      var t2 = new Date().getTime();',
  '      out.chunked.push({ lane: lane, round: r, ms: t2 - t1, sum: sum });',
  '      log("round " + r + " lane " + lane + ": " + (t2 - t1) + "ms");',
  '    }',
  '  }',
  '  // ---- memo re-extraction check (L1 only): same chunk string decoded again ----',
  '  var chunkStr = ESO.substring(0, CS);',
  '  var t1 = new Date().getTime(); var d1 = ESB64.atob(chunkStr); var t2 = new Date().getTime();',
  '  var coldMs = t2 - t1;',
  '  var t3 = new Date().getTime(); var d2 = ESB64.atob(chunkStr); var t4 = new Date().getTime();',
  '  var hotMs = t4 - t3;',
  '  var t5 = new Date().getTime(); var d3 = __esfast.decode32(chunkStr, 0, CS); var t6 = new Date().getTime();',
  '  out.memo = { coldMs: coldMs, hotMs: hotMs, fastMs: t6 - t5, same: d1 === d2 && d2 === d3 };',
  '  log("memo: cold=" + coldMs + "ms hot=" + hotMs + "ms fast=" + (t6 - t5) + "ms");',
  '  log("complete execMs=" + (new Date().getTime() - t0));',
  '  return out;',
  '}());'
].join('\n');

var probePath = join(OUT.replace(/\//g, '\\'), 'espack-opt-probe3.jsx').replace(/\\/g, '/');
writeFileSync(probePath.replace(/\//g, '\\'), probe);
console.log('probe written: ' + probePath + ' (' + probe.length + ' bytes)');

var t0 = Date.now();
var pyOut;
try {
  pyOut = execFileSync(PY, [TOOL, 'eval', '--file', probePath], { encoding: 'utf8', timeout: 300000 });
} catch (e) {
  console.error('COM tool failed (possible engine wedge): ' + String((e.stdout || e.message) + '').slice(0, 2000));
  process.exit(2);
}
var env;
try { env = JSON.parse(pyOut.trim()); }
catch (e) { console.error('tool output not JSON: ' + pyOut.slice(0, 1000)); process.exit(2); }
if (!env.ok || !env.result || env.result.ok !== true) {
  console.error('tool/engine error: ' + JSON.stringify(env).slice(0, 3000));
  process.exit(2);
}
var report = env.result;
console.log('wallMs=' + (Date.now() - t0) + ' toolElapsed=' + env.elapsed);

// ---- report: alternating A/B, per-lane mean of rounds ---------------------------
var byLane = {};
report.chunked.forEach(function (row) {
  if (!byLane[row.lane]) byLane[row.lane] = [];
  byLane[row.lane].push(row.ms);
});
console.log('engine: ' + report.engine);
console.log('--- chunked full payload (132440 chars, cs=24576, 8 alternating rounds, ms) ---');
var keys = Object.keys(byLane);
keys.forEach(function (k) {
  var a = byLane[k];
  var mean = a.reduce(function (x, y) { return x + y; }, 0) / a.length;
  console.log('  ' + k + ': mean=' + mean.toFixed(1) + 'ms  rounds=' + a.join(','));
});
console.log('--- memo re-extraction (L1, same 24576-char chunk) ---');
console.log(JSON.stringify(report.memo, null, 1));
console.log('done');
