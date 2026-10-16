#!/usr/bin/env node
/**
 * Keep `lib/scripts/` in sync with the skill's authoring copies.
 *
 * The skill `wiztree-snapshot-diff` owns the three analysis scripts; this
 * plugin ships an exact copy so a tool call never depends on the skill being
 * loaded. Point the script at another skill directory (or pass --check in CI)
 * when the skill moves.
 */

import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(HERE, '..')
const DESTINATION = join(PACKAGE_ROOT, 'lib', 'scripts')

/** Scripts owned by the skill and copied verbatim into the plugin. */
const SCRIPTS = [
  'wiztree_snapshot_diff.py',
  'wiztree_query.py',
  'wiztree_verify_delete.py',
]

/**
 * Resolve the skill's `scripts/` directory.
 * @param {string[]} argv - Command-line arguments.
 * @returns {string} Absolute path of the source directory.
 */
function sourceDir(argv) {
  const flag = argv.indexOf('--from')
  if (flag >= 0 && argv[flag + 1] !== undefined) return resolve(argv[flag + 1])
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')
  return join(home, 'skills', 'wiztree-snapshot-diff', 'scripts')
}

const checkOnly = process.argv.includes('--check')
const from = sourceDir(process.argv)
mkdirSync(DESTINATION, { recursive: true })

let drifted = 0
for (const name of SCRIPTS) {
  const source = join(from, name)
  const target = join(DESTINATION, name)
  let sourceText
  try {
    sourceText = readFileSync(source, 'utf8')
  } catch (error) {
    console.error(`[sync-scripts] cannot read ${source}: ${error.message}`)
    process.exitCode = 2
    continue
  }
  let targetText = ''
  try {
    targetText = readFileSync(target, 'utf8')
  } catch {
    targetText = ''
  }
  if (sourceText === targetText) {
    console.log(`[sync-scripts] up to date: ${name}`)
    continue
  }
  drifted += 1
  if (checkOnly) {
    console.error(`[sync-scripts] DRIFT: ${name} differs from ${source}`)
    continue
  }
  copyFileSync(source, target)
  console.log(`[sync-scripts] copied ${name} <- ${source}`)
}

if (checkOnly && drifted > 0) process.exitCode = 1
if (!checkOnly && drifted === 0) console.log('[sync-scripts] nothing to do')
