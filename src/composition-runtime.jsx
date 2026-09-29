/*
 * ESPACK library-composition control plane.
 *
 * This file is appended exactly once by espack-compose.mjs after the normal
 * ESPAK loader. It extends the existing global loader object rather than
 * creating a second loader/runtime authority.
 */
(function () {
  var g = null;
  try { if (typeof $ !== "undefined" && $.global) g = $.global; } catch (e1) {}
  if (!g) { try { g = (function () { return this; })(); } catch (e2) {} }
  if (!g || !g.ESPAK) throw new Error("ESPAK: composition control plane requires the ESPAK loader");

  var control = g.ESPAK;
  /* Later facade code in this same evaluation may reference the lexical ESPACK
     binding emitted by loader.jsx. Rebind it to the authoritative global
     object when an older compatible loader was reused. */
  try { ESPACK = control; } catch (ignoreBinding) {}

  if (control.supportsLibraryComposition === true &&
      typeof control.prepareLibrary === "function" &&
      typeof control.activateLibrary === "function") {
    return;
  }

  function registry() {
    var value = g.__ESPAK_LIBRARIES__;
    if (!value || typeof value.length !== "number") {
      value = [];
      g.__ESPAK_LIBRARIES__ = value;
    }
    return value;
  }

  function specGlobalName(spec) {
    if (spec && spec.activation && typeof spec.activation.global === "string") {
      return spec.activation.global;
    }
    return spec && typeof spec.globalName === "string" ? spec.globalName : "";
  }

  function specSha256(spec) {
    if (spec && spec.artifact && typeof spec.artifact.sha256 === "string") {
      return spec.artifact.sha256;
    }
    return spec && typeof spec.sha256 === "string" ? spec.sha256 : "";
  }

  function findLibrary(id) {
    var list = registry();
    var i;
    for (i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === id) return list[i];
    }
    return null;
  }

  function requireSpec(spec) {
    if (!spec || typeof spec.id !== "string" || spec.id.length === 0) {
      throw new Error("ESPAK: library activation missing id");
    }
    if (typeof spec.version !== "string" || spec.version.length === 0) {
      throw new Error("ESPAK: library activation missing version for " + spec.id);
    }
    if (specSha256(spec).length !== 64) {
      throw new Error("ESPAK: library activation missing sha256 for " + spec.id);
    }
    if (specGlobalName(spec).length === 0) {
      throw new Error("ESPAK: library activation missing globalName for " + spec.id);
    }
  }

  function prepareLibrary(spec) {
    requireSpec(spec);
    var prior = findLibrary(spec.id);
    var digest = specSha256(spec);
    if (!prior) return true;
    if (prior.version === spec.version && prior.sha256 === digest) {
      /* Registry state may survive a deliberately replaced loader/control
         plane or host code clearing a library global. Deduplication is only
         valid while the recorded activation still exists and satisfies its
         contract; a missing global must be deterministically reactivated. */
      var globalName = specGlobalName(spec);
      var value = g[globalName];
      if (value === null || typeof value === "undefined") return true;
      var activation = spec.activation || {};
      if (activation.type && activation.type !== "any" && typeof value !== activation.type) {
        throw new Error(
          "ESPAK: active library state drift for " + spec.id +
          " (" + globalName + " is " + typeof value +
          ", expected " + activation.type + ")"
        );
      }
      verifyContract(spec, value);
      return false;
    }
    throw new Error(
      "ESPAK: active library conflict for " + spec.id +
      " (active " + prior.version + " sha256=" + prior.sha256 +
      ", requested " + spec.version + " sha256=" + digest + ")"
    );
  }

  function verifyContract(spec, value) {
    var activation = spec.activation || {};
    var contract = activation.contract || spec.contract || [];
    var i, row, actual;
    for (i = 0; i < contract.length; i++) {
      row = contract[i];
      if (!row || typeof row.name !== "string") continue;
      actual = typeof value[row.name];
      if (row.type && actual !== row.type) {
        throw new Error(
          "ESPAK: activation contract failed for " + spec.id + "." + row.name +
          " (expected " + row.type + ", got " + actual + ")"
        );
      }
    }
  }

  function activateLibrary(spec) {
    requireSpec(spec);
    var globalName = specGlobalName(spec);
    var value = g[globalName];
    if (value === null || typeof value === "undefined") {
      throw new Error(
        "ESPAK: library " + spec.id + " did not activate $.global[" +
        "\"" + globalName + "\"]"
      );
    }
    var activation = spec.activation || {};
    if (activation.type && activation.type !== "any" && typeof value !== activation.type) {
      throw new Error(
        "ESPAK: library " + spec.id + " activated " + globalName +
        " as " + typeof value + ", expected " + activation.type
      );
    }
    verifyContract(spec, value);
    var list = registry();
    var digest = specSha256(spec);
    var prior = findLibrary(spec.id);
    if (prior && prior.version === spec.version && prior.sha256 === digest) {
      prior.globalName = globalName;
    } else {
      list[list.length] = {
        id: spec.id,
        version: spec.version,
        sha256: digest,
        globalName: globalName
      };
    }
    control.libraries = list;
    return value;
  }

  function libraryInfo(id) {
    var row = findLibrary(id);
    if (!row) return null;
    return {
      id: row.id,
      version: row.version,
      sha256: row.sha256,
      globalName: row.globalName
    };
  }

  function libraryList() {
    var source = registry();
    var out = [];
    var i;
    for (i = 0; i < source.length; i++) {
      if (source[i]) out[out.length] = libraryInfo(source[i].id);
    }
    return out;
  }

  control.supportsLibraryComposition = true;
  control.libraryRegistryVersion = 1;
  control.prepareLibrary = prepareLibrary;
  control.activateLibrary = activateLibrary;
  control.libraryInfo = libraryInfo;
  control.libraryList = libraryList;
  control.libraries = registry();
}());