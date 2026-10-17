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
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
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
 * Every DSH home worth looking inside, most explicit first.
 *
 * The Desktop app keeps its home under `~/.dsh` but does not export `DSH_HOME`
 * into its own process — it sets that variable for the tool subprocesses it
 * spawns. Trusting the variable alone made the bundled interpreter invisible
 * and silently fell back to whatever `python.exe` happened to be on `PATH`,
 * which is exactly how "pandas not found" shipped on a machine that carries
 * pandas.
 * @returns {string[]} Absolute DSH home directories, de-duplicated.
 */
function dshHomes() {
  const homes = []
  const push = value => {
    if (typeof value !== 'string' || value.trim().length === 0) return
    const absolute = resolve(value.trim())
    if (!homes.includes(absolute)) homes.push(absolute)
  }
  push(process.env.DSH_HOME)
  // A profile directory is `<home>/profiles/<name>`, so the home is its grandparent.
  push(process.env.DSH_PROFILE_DIR === undefined ? undefined : resolve(process.env.DSH_PROFILE_DIR, '..', '..'))
  try {
    push(join(homedir(), '.dsh'))
  } catch {
    // A host without a resolvable home simply has no bundled runtime to find.
  }
  return homes
}

/**
 * The interpreter path a standard Desktop install carries, for the diagnostic.
 * @returns {string} Absolute path (or a `<DSH_HOME>` placeholder).
 */
function expectedPython() {
  const [home] = dshHomes()
  return join(home ?? '<DSH_HOME>', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python',
    process.platform === 'win32' ? 'python.exe' : 'bin/python3')
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
  /** Only absolute candidates are checked here; a bare command name is PATH's job. */
  const pushIfPresent = value => {
    if (typeof value === 'string' && value.length > 0 && existsSync(value)) push(value)
  }
  push(configured)

  for (const home of dshHomes()) {
    const runtimeDir = join(home, 'dsh-runtimes', 'dsh-primary-runtime')
    pushIfPresent(join(runtimeDir, 'dependencies', 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3'))
    // `runtime.json` records the interpreter VERSION under `python` ("3.12.14"),
    // not a path — pushing it unconditionally tried to spawn "3.12.14". Accept
    // the field only when a host actually stores a path there.
    const declared = readRuntimeManifest(join(runtimeDir, 'runtime.json'))?.python
    if (typeof declared === 'string' && isAbsolute(declared)) pushIfPresent(declared)
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
      '  1. Run the tools through DSH Desktop, whose bundled runtime already carries pandas/numpy.',
      `     Expected interpreter: ${expectedPython()}`,
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
