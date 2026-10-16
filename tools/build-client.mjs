#!/usr/bin/env node
/**
 * Generate `lib/client.js` — the browser half the harness serves.
 *
 * The implementation lives in `lib/install.js` as plain ESM (so the pure
 * helpers can be unit-tested in Node), but a plugin bundle must be a single
 * CommonJS factory registered through the shell's module table; the module
 * system serves only `client.js` (plus emitted chunks), so a sibling module
 * would not be reachable at runtime.
 *
 * This script rewrites the ESM source into that factory shape. It is
 * idempotent and is run by `npm run build:client`; `npm run check` fails when
 * the committed `lib/client.js` is stale.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(HERE, '..')
const SOURCE = join(PACKAGE_ROOT, 'lib', 'install.js')
const TARGET = join(PACKAGE_ROOT, 'lib', 'client.js')

/** Named exports the loader and the tests rely on. */
const EXPORTS = ['name', 'inject', 'apply']

/**
 * Strip ESM syntax from the implementation source.
 * @param {string} source - `lib/install.js` contents.
 * @returns {string} A bare script body.
 */
function toScriptBody(source) {
  return source
    // `export function foo` / `export async function foo` / `export const foo`
    .replace(/^export (async )?function /gmu, (_match, async) => `${async ?? ''}function `)
    .replace(/^export const /gmu, 'const ')
    .replace(/^export \{[\s\S]*?\}$/gmu, '')
    .trimEnd()
}

/**
 * Build the complete bundle text.
 * @param {string} body - Bare script body.
 * @param {string} origin - Path recorded in the banner for traceability.
 * @returns {string} The bundle source.
 */
function buildBundle(body, origin) {
  return `// dsh-wiztree — browser half (client plugin bundle). GENERATED FILE.
//
// Source of truth: ${origin}
// Regenerate with \`npm run build:client\`. The harness serves this file at
// /plugins/dsh-wiztree/client.js and executes it through the vendored cordis
// Loader's lazy-CJS module table (window.__ModuleLoader__.load).
//
// What it does: one capture-phase click listener turns local links in a
// transcript into File Explorer controls — \`file:///C:/...\` links (which the
// renderer's URL allowlist drops, leaving an inert href) as well as the bare
// absolute paths the renderer already renders as file-link buttons (which
// would otherwise open a read-only preview tab). A directory is revealed;
// a file is opened by its associated application. External http(s) links,
// images and reference chips are left alone.

(() => {
  const root = typeof globalThis !== "undefined" ? globalThis : undefined;
  if (root === undefined || root.__ModuleLoader__ === undefined || typeof root.__ModuleLoader__.load !== "function") return;
  root.__ModuleLoader__.load({
    id: "dsh-wiztree",
    factory: () => {
      const module = { exports: {} };
      const exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

${body.split('\n').map(line => (line.length === 0 ? '' : `      ${line}`)).join('\n')}

${EXPORTS.map(key => `      exports.${key} = ${key};`).join('\n')}
      return module.exports;
    }
  });
})();
`
}

const source = readFileSync(SOURCE, 'utf8')
const bundle = buildBundle(toScriptBody(source), 'lib/install.js')
const check = process.argv.includes('--check')

let current = ''
try {
  current = readFileSync(TARGET, 'utf8')
} catch {
  current = ''
}

if (current === bundle) {
  console.log('[build-client] lib/client.js is up to date')
  process.exit(0)
}
if (check) {
  console.error('[build-client] lib/client.js is stale; run `npm run build:client`')
  process.exit(1)
}
writeFileSync(TARGET, bundle, 'utf8')
console.log(`[build-client] wrote lib/client.js (${bundle.length} bytes)`)
