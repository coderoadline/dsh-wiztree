/**
 * Python runtime discovery for the wiztree tools.
 *
 * The Desktop app ships a bundled CPython with pandas/numpy
 * (`<DSH_HOME>/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe`,
 * described by `runtime.json`), so the tools work with no configuration. A
 * fallback interpreter on `PATH` is accepted only when the probe proves it can
 * import pandas and numpy; otherwise the tool call fails with one actionable
 * message instead of a pandas traceback.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Absolute path of the environment probe script. */
export const PROBE_SCRIPT = join(HERE, 'scripts', '_env_probe.py')

/** Interpreter candidate that ran successfully, cached per process. */
let cached

/**
 * Read a runtime.json next to a candidate interpreter.
 * @param {string} runtimeJson - Path of the runtime manifest.
 * @returns {{ python?: string } | undefined} Parsed manifest.
 */
function readRuntimeManifest(runtimeJson) {
  if (!existsSync(runtimeJson)) return undefined
  try {
    return JSON.parse(readFileSync(runtimeJson, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Every interpreter worth probing, most specific first.
 * @param {string | undefined} configured - `pythonPath` from plugin config.
 * @returns {string[]} Absolute paths and bare command names.
 */
export function candidates(configured) {
  const found = []
  const push = value => {
    if (typeof value === 'string' && value.trim().length > 0 && !found.includes(value)) found.push(value)
  }
  push(configured)

  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home.length > 0) {
    const runtimeDir = join(home, 'dsh-runtimes', 'dsh-primary-runtime')
    push(join(runtimeDir, 'dependencies', 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3'))
    const manifest = readRuntimeManifest(join(runtimeDir, 'runtime.json'))
    if (manifest !== undefined) push(manifest.python)
  }
  if (process.platform === 'win32') {
    push('python.exe')
    push('python3.exe')
  } else {
    push('python3')
    push('python')
  }
  return found
}

/**
 * Run the environment probe with one candidate interpreter.
 * @param {(argv: string[]) => Promise<{ code: number | null, stdout: string, stderr: string }>} run - Process runner bound to one interpreter.
 * @param {string} command - Interpreter command being probed (for reporting).
 * @returns {Promise<{ ok: true, path: string, probe: object } | { ok: false, command: string, reason: string }>} Probe outcome.
 */
async function probeWith(run, command) {
  let outcome
  try {
    outcome = await run([PROBE_SCRIPT])
  } catch (error) {
    return { ok: false, command, reason: error instanceof Error ? error.message : String(error) }
  }
  const stdout = outcome.stdout.trim()
  const stderr = outcome.stderr.trim()
  if (stdout.length === 0) {
    return { ok: false, command, reason: stderr.split('\n').at(-1) ?? `exit ${outcome.code}` }
  }
  let parsed
  try {
    parsed = JSON.parse(stdout.split('\n').at(-1))
  } catch {
    return { ok: false, command, reason: `probe produced no JSON (${stdout.slice(0, 200) || stderr.slice(0, 200)})` }
  }
  if (Array.isArray(parsed.missing) && parsed.missing.length > 0) {
    return {
      ok: false,
      command,
      reason: `missing Python module(s): ${parsed.missing.join(', ')}${parsed.error === null || parsed.error === undefined ? '' : ` (${parsed.error})`}`,
    }
  }
  return { ok: true, path: command, probe: parsed }
}

/**
 * Resolve a usable Python interpreter, caching the first candidate that can
 * import pandas and numpy.
 * @param {{ pythonPath?: string, cwd?: string, spawn: Function, refresh?: boolean }} options - Config, spawn binding, and cache control.
 * @returns {Promise<{ ok: true, path: string, probe: object } | { ok: false, message: string }>} The interpreter, or an actionable failure.
 */
export async function resolvePython(options) {
  const { pythonPath, cwd, spawn } = options
  if (cached !== undefined && options.refresh !== true && (pythonPath === undefined || cached.requested === pythonPath)) {
    return { ok: true, path: cached.path, probe: cached.probe }
  }
  const tried = []
  for (const command of candidates(pythonPath)) {
    const run = argv => spawn(command, argv, cwd)
    const outcome = await probeWith(run, command)
    if (outcome.ok) {
      cached = { requested: pythonPath, path: outcome.path, probe: outcome.probe }
      return { ok: true, path: cached.path, probe: cached.probe }
    }
    tried.push(`${command} -> ${outcome.reason}`)
  }
  return {
    ok: false,
    message: [
      'No Python interpreter with pandas + numpy is available for the wiztree tools.',
      '',
      'Tried:',
      ...tried.map(line => `  - ${line}`),
      '',
      'Fix one of these and retry:',
      '  1. Run the tools through DSH Desktop, whose bundled runtime already carries pandas/numpy',
      '     (<DSH_HOME>/dsh-runtimes/dsh-primary-runtime/dependencies/python).',
      '  2. Point the plugin at an interpreter directly, in the profile patch:',
      '       - id: wiztree',
      '         name: dsh-wiztree',
      '         config:',
      '           pythonPath: C:\\path\\to\\python.exe',
      `  3. Or install the dependencies for the interpreter on PATH: ${process.platform === 'win32' ? 'python -m pip install pandas numpy' : 'python3 -m pip install pandas numpy'}`,
    ].join('\n'),
  }
}

/**
 * Drop the cached interpreter; used by tests and after a config change.
 * @returns {void}
 */
export function resetPythonCache() {
  cached = undefined
}
