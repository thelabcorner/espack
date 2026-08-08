#!/usr/bin/env node
// ESPACK vendor-sync guard: the vendored esb64 artifacts (vendor/) must match
// the upstream esb64 build outputs byte-for-byte, or every bundle built from
// them embeds a stale runtime/accelerator. Part of npm test (mirrors the
// esb64 vendor-sync guard convention).
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

var ROOT = dirname(fileURLToPath(import.meta.url));
var SYNC = join(ROOT, '..', 'espack-vendor-sync.mjs');
var out = execFileSync(process.execPath, [SYNC, '--check', '--quiet'], { encoding: 'utf8' });
console.log('ok   vendor-sync: vendored esb64 runtime + accelerator match upstream');
