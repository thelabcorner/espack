if (typeof Object.defineProperty !== "function") {
  Object.defineProperty = function (obj, prop, desc) {
    if (desc) {
      if (typeof desc.get === "function") {
        if (typeof obj.__defineGetter__ === "function") { obj.__defineGetter__(prop, desc.get); }
        else { obj[prop] = desc.get(); }
      } else if ("value" in desc) {
        obj[prop] = desc.value;
      }
    }
    return obj;
  };
  Object.getOwnPropertyDescriptor = function (obj, prop) {
    return { value: obj[prop], writable: true, enumerable: true, configurable: true };
  };
  Object.getOwnPropertyNames = function (obj) {
    var a = [], k;
    for (k in obj) { if (Object.prototype.hasOwnProperty.call(obj, k)) { a.push(k); } }
    return a;
  };
}
if (typeof Function.prototype.bind !== "function") {
  Function.prototype.bind = function (thisArg) {
    var fn = this;
    var args = Array.prototype.slice.call(arguments, 1);
    return function () {
      return fn.apply(thisArg, args.concat(Array.prototype.slice.call(arguments)));
    };
  };
}

var ESB64 = (function() {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = function(target, all) {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = function(to, from, except, desc) {
    if (from && typeof from === "object" || typeof from === "function")
      for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
        key = keys[i];
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: function(k) {
            return from[k];
          }.bind(null, key), enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
      }
    return to;
  };
  var __toCommonJS = function(mod) {
    return __copyProps(__defProp({}, "__esModule", { value: true }), mod);
  };

  // src/runtime.ts
  var runtime_exports = {};
  __export(runtime_exports, {
    atob: function() {
      return atob;
    },
    btoa: function() {
      return btoa;
    }
  });

  // src/tables.ts
  var INVALID = -1;
  var ALPHA_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  var DEC_TABLE = buildDecTable();
  function buildDecTable() {
    var t = [];
    var i;
    for (i = 0; i < 128; i++) {
      t[i] = INVALID;
    }
    for (i = 0; i < 64; i++) {
      t[ALPHA_CHARS.charCodeAt(i)] = i;
    }
    return t;
  }
  var BYTE_CHARS = buildByteChars();
  function buildByteChars() {
    var t = [];
    var i;
    for (i = 0; i < 256; i++) {
      t[i] = String.fromCharCode(i);
    }
    return t;
  }

  // src/big-memo.ts
  var BIG_MEMO_ENTRIES = 2;
  var BIG_MEMO_MAX_CHARS = 1 << 21;
  function makeBigMemo() {
    return { keys: [], vals: {} };
  }
  function bigMemoKey(lane, raw, n) {
    var h1 = 0;
    var h2 = 0;
    var step = Math.max(1, Math.floor(n / 1024));
    var i;
    var c;
    for (i = 0; i < n; i += step) {
      c = raw.charCodeAt(i);
      h1 = h1 * 31 + c >>> 0;
      h2 = h2 * 17 + c + i >>> 0;
    }
    return lane + ":" + n + ":" + h1 + ":" + h2;
  }
  function bigMemoGet(m, key, raw) {
    var hit = m.vals[key];
    if (hit === void 0 || hit.src !== raw) return void 0;
    return hit;
  }
  function bigMemoSet(m, key, raw, value, isError) {
    if (!Object.prototype.hasOwnProperty.call(m.vals, key)) {
      m.keys[m.keys.length] = key;
    }
    m.vals[key] = { src: raw, err: isError, value: value };
    while (m.keys.length > BIG_MEMO_ENTRIES) {
      delete m.vals[m.keys[0]];
      m.keys.shift();
    }
  }

  // src/encode.ts
  var MEMO_ENTRIES = 8;
  var MEMO_MAX_CHARS = 1 << 15;
  var FLUSH_AT = 128;
  var memoKeys = [];
  var memoVals = {};
  var bigMemo = makeBigMemo();
  var A = buildAlphaTable();
  function buildAlphaTable() {
    var t = [];
    var i;
    for (i = 0; i < 64; i++) {
      t[i] = ALPHA_CHARS.charAt(i);
    }
    return t;
  }
  var NON_LATIN1_RE = /[^\x00-\xff]/;
  function invalidCharacter(msg) {
    var e = new Error(msg);
    try {
      e.name = "InvalidCharacterError";
    } catch (ignore) {
    }
    return e;
  }
  function btoaLane(text) {
    var raw = String(text);
    var n = raw.length;
    if (n === 0) return "";
    if (memoEligible(raw, n) && Object.prototype.hasOwnProperty.call(memoVals, raw)) {
      var hit = memoVals[raw];
      if (hit.err) throw hit.value;
      return hit.value;
    }
    var bk = "";
    if (n > MEMO_MAX_CHARS && n <= BIG_MEMO_MAX_CHARS) {
      bk = bigMemoKey("e", raw, n);
      var bhit = bigMemoGet(bigMemo, bk, raw);
      if (bhit !== void 0) {
        if (bhit.err) throw bhit.value;
        return bhit.value;
      }
    }
    var result;
    var ok = true;
    var err = null;
    try {
      if (NON_LATIN1_RE.test(raw)) {
        failLatin1();
      }
      result = encodeLoop(raw, n);
    } catch (e) {
      ok = false;
      err = e;
      result = "";
    }
    if (n > MEMO_MAX_CHARS && n <= BIG_MEMO_MAX_CHARS) {
      bigMemoSet(bigMemo, bk, raw, ok ? result : err, !ok);
    }
    setMemo(raw, n, ok ? result : err, !ok);
    if (!ok) throw err;
    return result;
  }
  function encodeLoop(raw, n) {
    var out = [];
    var buf = new Array(FLUSH_AT);
    var bi = 0;
    var i = 0;
    var c0;
    var c1;
    var c2;
    var c3;
    var c4;
    var c5;
    var c6;
    var c7;
    var c8;
    var c9;
    var c10;
    var c11;
    var c12;
    var c13;
    var c14;
    var c15;
    var c16;
    var c17;
    var c18;
    var c19;
    var c20;
    var c21;
    var c22;
    var c23;
    while (i + 23 < n) {
      c0 = raw.charCodeAt(i);
      c1 = raw.charCodeAt(i + 1);
      c2 = raw.charCodeAt(i + 2);
      c3 = raw.charCodeAt(i + 3);
      c4 = raw.charCodeAt(i + 4);
      c5 = raw.charCodeAt(i + 5);
      c6 = raw.charCodeAt(i + 6);
      c7 = raw.charCodeAt(i + 7);
      c8 = raw.charCodeAt(i + 8);
      c9 = raw.charCodeAt(i + 9);
      c10 = raw.charCodeAt(i + 10);
      c11 = raw.charCodeAt(i + 11);
      c12 = raw.charCodeAt(i + 12);
      c13 = raw.charCodeAt(i + 13);
      c14 = raw.charCodeAt(i + 14);
      c15 = raw.charCodeAt(i + 15);
      c16 = raw.charCodeAt(i + 16);
      c17 = raw.charCodeAt(i + 17);
      c18 = raw.charCodeAt(i + 18);
      c19 = raw.charCodeAt(i + 19);
      c20 = raw.charCodeAt(i + 20);
      c21 = raw.charCodeAt(i + 21);
      c22 = raw.charCodeAt(i + 22);
      c23 = raw.charCodeAt(i + 23);
      buf[bi++] = A[c0 >> 2] + A[((c0 & 3) << 4) + (c1 >> 4)] + A[((c1 & 15) << 2) + (c2 >> 6)] + A[c2 & 63] + A[c3 >> 2] + A[((c3 & 3) << 4) + (c4 >> 4)] + A[((c4 & 15) << 2) + (c5 >> 6)] + A[c5 & 63] + A[c6 >> 2] + A[((c6 & 3) << 4) + (c7 >> 4)] + A[((c7 & 15) << 2) + (c8 >> 6)] + A[c8 & 63] + A[c9 >> 2] + A[((c9 & 3) << 4) + (c10 >> 4)] + A[((c10 & 15) << 2) + (c11 >> 6)] + A[c11 & 63] + A[c12 >> 2] + A[((c12 & 3) << 4) + (c13 >> 4)] + A[((c13 & 15) << 2) + (c14 >> 6)] + A[c14 & 63] + A[c15 >> 2] + A[((c15 & 3) << 4) + (c16 >> 4)] + A[((c16 & 15) << 2) + (c17 >> 6)] + A[c17 & 63] + A[c18 >> 2] + A[((c18 & 3) << 4) + (c19 >> 4)] + A[((c19 & 15) << 2) + (c20 >> 6)] + A[c20 & 63] + A[c21 >> 2] + A[((c21 & 3) << 4) + (c22 >> 4)] + A[((c22 & 15) << 2) + (c23 >> 6)] + A[c23 & 63];
      if (bi >= FLUSH_AT) {
        out[out.length] = buf.join("");
        bi = 0;
      }
      i += 24;
    }
    while (i < n) {
      c0 = raw.charCodeAt(i);
      c1 = i + 1 < n ? raw.charCodeAt(i + 1) : -1;
      c2 = i + 2 < n ? raw.charCodeAt(i + 2) : -1;
      buf[bi++] = A[c0 >> 2] + A[((c0 & 3) << 4) + (c1 >= 0 ? c1 >> 4 : 0)] + (c1 >= 0 ? A[((c1 & 15) << 2) + (c2 >= 0 ? c2 >> 6 : 0)] : "=") + (c2 >= 0 ? A[c2 & 63] : "=");
      if (bi >= FLUSH_AT) {
        out[out.length] = buf.join("");
        bi = 0;
      }
      i += 3;
    }
    if (bi > 0) {
      buf.length = bi;
      out[out.length] = buf.join("");
    }
    return out.join("");
  }
  function failLatin1() {
    throw invalidCharacter("btoa: the string to be encoded contains characters outside of the Latin1 range");
  }
  function memoEligible(raw, n) {
    if (n > MEMO_MAX_CHARS || raw === "__proto__") return false;
    return raw.indexOf("\0") < 0;
  }
  function setMemo(raw, n, value, isError) {
    if (!memoEligible(raw, n)) return;
    if (!Object.prototype.hasOwnProperty.call(memoVals, raw)) {
      memoKeys[memoKeys.length] = raw;
      if (memoKeys.length > MEMO_ENTRIES) {
        delete memoVals[memoKeys[0]];
        memoKeys.shift();
      }
    }
    memoVals[raw] = { err: isError, value: value };
  }

  // src/decode.ts
  var MEMO_ENTRIES2 = 8;
  var MEMO_MAX_CHARS2 = 1 << 15;
  var FLUSH_AT2 = 128;
  var memoKeys2 = [];
  var memoVals2 = {};
  var CH = BYTE_CHARS;
  var bigMemo2 = makeBigMemo();
  function atobLane(text) {
    var raw = String(text);
    var n = raw.length;
    if (n === 0) return "";
    if (memoEligible2(raw, n) && Object.prototype.hasOwnProperty.call(memoVals2, raw)) {
      var hit = memoVals2[raw];
      if (hit.err) throw hit.value;
      return hit.value;
    }
    var bk = "";
    if (n > MEMO_MAX_CHARS2 && n <= BIG_MEMO_MAX_CHARS) {
      bk = bigMemoKey("d", raw, n);
      var bhit = bigMemoGet(bigMemo2, bk, raw);
      if (bhit !== void 0) {
        if (bhit.err) throw bhit.value;
        return bhit.value;
      }
    }
    var result;
    var ok = true;
    var err = null;
    try {
      if (WS_RE.test(raw)) {
        var stripped = raw.replace(WS_RE_G, "");
        result = decodeFast(stripped, stripped.length);
      } else {
        result = decodeFast(raw, n);
      }
    } catch (e) {
      ok = false;
      err = e;
      result = "";
    }
    if (n > MEMO_MAX_CHARS2 && n <= BIG_MEMO_MAX_CHARS) {
      bigMemoSet(bigMemo2, bk, raw, ok ? result : err, !ok);
    }
    setMemo2(raw, ok ? result : err, !ok);
    if (!ok) throw err;
    return result;
  }
  function fail(raw, msg) {
    throw invalidCharacter(msg);
  }
  var WS_RE = /[ \t\n\f\r]/;
  var WS_RE_G = /[ \t\n\f\r]/g;
  var B64_RE = /^[A-Za-z0-9+\/]*={0,2}$/;
  function decodeFast(raw, n) {
    if ((n & 3) === 1) {
      fail(raw, "atob: the string to be decoded is not correctly encoded");
    }
    if (!B64_RE.test(raw)) {
      fail(raw, "atob: the string to be decoded is not correctly encoded");
    }
    if (n >= 1 && raw.charCodeAt(n - 1) === 61 && (n & 3) !== 0) {
      fail(raw, "atob: the string to be decoded is not correctly encoded");
    }
    var strip = 0;
    if ((n & 3) === 0) {
      if (raw.charCodeAt(n - 1) === 61) {
        strip = n >= 2 && raw.charCodeAt(n - 2) === 61 ? 2 : 1;
      }
    }
    var body = n - strip;
    if ((body & 3) === 1) {
      fail(raw, "atob: the string to be decoded is not correctly encoded");
    }
    var out = [];
    var buf = new Array(FLUSH_AT2);
    var bi = 0;
    var i;
    var p0;
    var p1;
    var p2;
    var p3;
    var p4;
    var p5;
    var p6;
    var p7;
    var p8;
    var p9;
    var p10;
    var p11;
    var p12;
    var p13;
    var p14;
    var p15;
    var q0;
    var q1;
    var q2;
    var q3;
    var q4;
    var q5;
    var q6;
    var q7;
    var q8;
    var q9;
    var q10;
    var q11;
    var q12;
    var q13;
    var q14;
    var q15;
    var main32 = body - 31;
    for (i = 0; i < main32; i += 32) {
      p0 = DEC_TABLE[raw.charCodeAt(i)];
      p1 = DEC_TABLE[raw.charCodeAt(i + 1)];
      p2 = DEC_TABLE[raw.charCodeAt(i + 2)];
      p3 = DEC_TABLE[raw.charCodeAt(i + 3)];
      p4 = DEC_TABLE[raw.charCodeAt(i + 4)];
      p5 = DEC_TABLE[raw.charCodeAt(i + 5)];
      p6 = DEC_TABLE[raw.charCodeAt(i + 6)];
      p7 = DEC_TABLE[raw.charCodeAt(i + 7)];
      p8 = DEC_TABLE[raw.charCodeAt(i + 8)];
      p9 = DEC_TABLE[raw.charCodeAt(i + 9)];
      p10 = DEC_TABLE[raw.charCodeAt(i + 10)];
      p11 = DEC_TABLE[raw.charCodeAt(i + 11)];
      p12 = DEC_TABLE[raw.charCodeAt(i + 12)];
      p13 = DEC_TABLE[raw.charCodeAt(i + 13)];
      p14 = DEC_TABLE[raw.charCodeAt(i + 14)];
      p15 = DEC_TABLE[raw.charCodeAt(i + 15)];
      q0 = DEC_TABLE[raw.charCodeAt(i + 16)];
      q1 = DEC_TABLE[raw.charCodeAt(i + 17)];
      q2 = DEC_TABLE[raw.charCodeAt(i + 18)];
      q3 = DEC_TABLE[raw.charCodeAt(i + 19)];
      q4 = DEC_TABLE[raw.charCodeAt(i + 20)];
      q5 = DEC_TABLE[raw.charCodeAt(i + 21)];
      q6 = DEC_TABLE[raw.charCodeAt(i + 22)];
      q7 = DEC_TABLE[raw.charCodeAt(i + 23)];
      q8 = DEC_TABLE[raw.charCodeAt(i + 24)];
      q9 = DEC_TABLE[raw.charCodeAt(i + 25)];
      q10 = DEC_TABLE[raw.charCodeAt(i + 26)];
      q11 = DEC_TABLE[raw.charCodeAt(i + 27)];
      q12 = DEC_TABLE[raw.charCodeAt(i + 28)];
      q13 = DEC_TABLE[raw.charCodeAt(i + 29)];
      q14 = DEC_TABLE[raw.charCodeAt(i + 30)];
      q15 = DEC_TABLE[raw.charCodeAt(i + 31)];
      buf[bi++] = String.fromCharCode(
        (p0 << 2) + (p1 >> 4),
        ((p1 & 15) << 4) + (p2 >> 2),
        ((p2 & 3) << 6) + p3,
        (p4 << 2) + (p5 >> 4),
        ((p5 & 15) << 4) + (p6 >> 2),
        ((p6 & 3) << 6) + p7,
        (p8 << 2) + (p9 >> 4),
        ((p9 & 15) << 4) + (p10 >> 2),
        ((p10 & 3) << 6) + p11,
        (p12 << 2) + (p13 >> 4),
        ((p13 & 15) << 4) + (p14 >> 2),
        ((p14 & 3) << 6) + p15,
        (q0 << 2) + (q1 >> 4),
        ((q1 & 15) << 4) + (q2 >> 2),
        ((q2 & 3) << 6) + q3,
        (q4 << 2) + (q5 >> 4),
        ((q5 & 15) << 4) + (q6 >> 2),
        ((q6 & 3) << 6) + q7,
        (q8 << 2) + (q9 >> 4),
        ((q9 & 15) << 4) + (q10 >> 2),
        ((q10 & 3) << 6) + q11,
        (q12 << 2) + (q13 >> 4),
        ((q13 & 15) << 4) + (q14 >> 2),
        ((q14 & 3) << 6) + q15
      );
      if (bi >= FLUSH_AT2) {
        out[out.length] = buf.join("");
        bi = 0;
      }
    }
    for (; i + 3 < body; i += 4) {
      p0 = DEC_TABLE[raw.charCodeAt(i)];
      p1 = DEC_TABLE[raw.charCodeAt(i + 1)];
      p2 = DEC_TABLE[raw.charCodeAt(i + 2)];
      p3 = DEC_TABLE[raw.charCodeAt(i + 3)];
      buf[bi++] = CH[(p0 << 2) + (p1 >> 4)] + CH[((p1 & 15) << 4) + (p2 >> 2)] + CH[((p2 & 3) << 6) + p3];
      if (bi >= FLUSH_AT2) {
        out[out.length] = buf.join("");
        bi = 0;
      }
    }
    var rem = body & 3;
    if (rem === 2) {
      p0 = DEC_TABLE[raw.charCodeAt(body - 2)];
      p1 = DEC_TABLE[raw.charCodeAt(body - 1)];
      buf[bi++] = CH[(p0 << 2) + (p1 >> 4)];
    } else if (rem === 3) {
      p0 = DEC_TABLE[raw.charCodeAt(body - 3)];
      p1 = DEC_TABLE[raw.charCodeAt(body - 2)];
      p2 = DEC_TABLE[raw.charCodeAt(body - 1)];
      buf[bi++] = CH[(p0 << 2) + (p1 >> 4)] + CH[((p1 & 15) << 4) + (p2 >> 2)];
    }
    if (bi > 0) {
      buf.length = bi;
      out[out.length] = buf.join("");
    }
    return out.join("");
  }
  function memoEligible2(raw, n) {
    if (n > MEMO_MAX_CHARS2 || raw === "__proto__") return false;
    return raw.indexOf("\0") < 0;
  }
  function setMemo2(raw, value, isError) {
    if (!memoEligible2(raw, raw.length)) return;
    if (!Object.prototype.hasOwnProperty.call(memoVals2, raw)) {
      memoKeys2[memoKeys2.length] = raw;
      if (memoKeys2.length > MEMO_ENTRIES2) {
        delete memoVals2[memoKeys2[0]];
        memoKeys2.shift();
      }
    }
    memoVals2[raw] = { err: isError, value: value };
  }

  // src/runtime.ts
  function btoa(text) {
    return btoaLane(text);
  }
  function atob(text) {
    return atobLane(text);
  }
  return __toCommonJS(runtime_exports);
})();

(function () {
  var g = null;
  try { if (typeof $ !== "undefined" && $.global) { g = $.global; } } catch (e1) {}
  if (!g) { try { g = (function () { return this; })(); } catch (e2) {} }
  if (!g) return;
  if (typeof g.atob !== "function") { g.atob = ESB64.atob; }
  if (typeof g.btoa !== "function") { g.btoa = ESB64.btoa; }
})();
