/**
 * Process plumbing: run one of the bundled analysis scripts through
 * `ctx.subprocess` and read its collected output.
 *
 * Every spawn goes through the harness subprocess seam (argv only, never a
 * shell), so paths containing spaces, quotes, or CJK characters cannot be
 * reinterpreted by a command interpreter.
 */

import { PROBE_SCRIPT, resolvePython } from './python-runtime.js'

/** Default wall-clock budget for one analysis run. */
export const DEFAULT_TIMEOUT_MS = 180_000

/** In-memory stdout cap; analysis reports are text and stay far below this. */
const STDOUT_CAP = 8 * 1024 * 1024

/** In-memory stderr cap. */
const STDERR_CAP = 512 * 1024

/** Grace period handed to the subprocess seam for termination. */
const GRACE_MS = 2_000

/**
 * Combine a caller signal with a deadline.
 * @param {AbortSignal | undefined} signal - Caller lifetime.
 * @param {number} timeoutMs - Deadline in milliseconds.
 * @returns {{ signal: AbortSignal, timedOut: () => boolean, dispose: () => void }} Combined signal and its cleanup.
 */
function withDeadline(signal, timeoutMs) {
  const controller = new AbortController()
  let expired = false
  const forward = () => controller.abort(signal?.reason)
  if (signal !== undefined) {
    if (signal.aborted) forward()
    else signal.addEventListener('abort', forward, { once: true })
  }
  const timer = setTimeout(() => {
    expired = true
    controller.abort(new Error(`timed out after ${timeoutMs} ms`))
  }, timeoutMs)
  timer.unref?.()
  return {
    signal: controller.signal,
    timedOut: () => expired,
    dispose: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', forward)
    },
  }
}

/**
 * Read one collected stream, preferring the in-memory tail.
 * @param {{ readFrom?: (offset: number) => { text: string } } | undefined} reader - Collected reader from the handle.
 * @returns {string} Everything the seam retained.
 */
function drain(reader) {
  if (reader === undefined) return ''
  try {
    return reader.readFrom(0).text
  } catch {
    return ''
  }
}

/**
 * Build the runner used by the tools and by interpreter probing.
 * @param {object} options - Binding options.
 * @param {object} options.subprocess - `ctx.subprocess` service.
 * @param {string} options.cwd - Working directory for child processes.
 * @returns {{
 *   spawn: (command: string, argv: string[], cwd?: string, signal?: AbortSignal, timeoutMs?: number) => Promise<object>,
 *   resolvePython: (config?: { pythonPath?: string, refresh?: boolean }) => Promise<object>,
 *   runScript: (request: object) => Promise<object>,
 *   probeScript: string,
 * }} Bound helpers.
 */
export function createPythonRunner({ subprocess, cwd }) {
  /**
   * Spawn one child and collect its output.
   * @param {string} command - Executable.
   * @param {string[]} argv - Arguments after the executable.
   * @param {string} [runCwd] - Working directory.
   * @param {AbortSignal} [signal] - Caller lifetime.
   * @param {number} [timeoutMs] - Deadline.
   * @returns {Promise<{ ok: boolean, code: number | null, signal: string | null, stdout: string, stderr: string, timedOut: boolean, message: string }>} Collected outcome.
   */
  async function spawn(command, argv, runCwd, signal, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const resolved = typeof subprocess.resolveExecutable === 'function'
      ? await subprocess.resolveExecutable(command, { cwd: runCwd ?? cwd })
      : command
    if (typeof resolved !== 'string' || resolved.length === 0) {
      return {
        ok: false,
        code: null,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        message: `Cannot launch \`${command}\`: the executable was not found. Check the configured \`pythonPath\`, or install Python with pandas and numpy.`,
      }
    }

    const deadline = withDeadline(signal, timeoutMs)
    let handle
    try {
      handle = subprocess.spawn({
        argv: [resolved, ...argv],
        cwd: runCwd ?? cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: STDOUT_CAP },
          stderr: { maxBytes: STDERR_CAP },
        },
        graceMs: GRACE_MS,
        signal: deadline.signal,
      })
    } catch (error) {
      deadline.dispose()
      return {
        ok: false,
        code: null,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        message: `Failed to start \`${command}\`: ${error instanceof Error ? error.message : String(error)}`,
      }
    }

    try {
      const outcome = await handle.done
      const stdout = drain(handle.collected?.stdout)
      const stderr = drain(handle.collected?.stderr)
      return {
        ok: outcome.exitCode === 0,
        code: outcome.exitCode,
        signal: outcome.signal,
        stdout,
        stderr,
        timedOut: deadline.timedOut(),
        message: '',
      }
    } catch (error) {
      return {
        ok: false,
        code: null,
        signal: null,
        stdout: drain(handle.collected?.stdout),
        stderr: drain(handle.collected?.stderr),
        timedOut: deadline.timedOut(),
        message: `\`${command}\` failed to start: ${error instanceof Error ? error.message : String(error)}`,
      }
    } finally {
      deadline.dispose()
    }
  }

  /**
   * Bound interpreter resolution used both by the tools and by probing.
   * @param {{ pythonPath?: string, refresh?: boolean }} [config] - Plugin config subset.
   * @returns {Promise<object>} Resolution outcome.
   */
  function resolve(config = {}) {
    return resolvePython({
      pythonPath: config.pythonPath,
      cwd,
      refresh: config.refresh,
      spawn: (command, argv, runCwd) => spawn(command, argv, runCwd, undefined, 120_000),
    })
  }

  /**
   * Resolve the interpreter, then run one bundled script.
   * @param {{ pythonPath?: string, script: string, args?: string[], timeoutMs?: number, signal?: AbortSignal, json?: boolean }} request - Script request.
   * @returns {Promise<{ ok: boolean, payload?: object, message: string, stdout: string, stderr: string }>} Parsed payload or a failure message.
   */
  async function runScript(request) {
    const wantsJson = request.json !== false
    if (request.signal?.aborted) return { ok: false, message: 'Cancelled.', stdout: '', stderr: '' }

    const python = await resolve({ pythonPath: request.pythonPath })
    if (!python.ok) return { ok: false, message: python.message, stdout: '', stderr: '' }

    const argv = [request.script, ...(request.args ?? [])]
    if (wantsJson) argv.push('--json')
    const outcome = await spawn(python.path, argv, cwd, request.signal, request.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    const stdout = outcome.stdout.trim()
    const stderr = outcome.stderr.trim()

    if (outcome.timedOut) {
      return {
        ok: false,
        message: `The analysis exceeded its ${Math.round((request.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)}s budget and was stopped. Narrow the request (--subtree / --min-mb / --top) and retry.`,
        stdout,
        stderr,
      }
    }
    if (outcome.message.length > 0) return { ok: false, message: outcome.message, stdout, stderr }

    if (!wantsJson) {
      if (!outcome.ok && stdout.length === 0) {
        return { ok: false, message: scriptFailure(outcome), stdout, stderr }
      }
      return { ok: true, payload: { stdout, stderr, code: outcome.code }, message: '', stdout, stderr }
    }

    const lastLine = stdout.split('\n').filter(line => line.trim().length > 0).at(-1)
    if (lastLine !== undefined) {
      try {
        const payload = JSON.parse(lastLine)
        if (payload !== null && typeof payload === 'object') {
          if (typeof payload.error === 'string' && payload.error.length > 0) {
            return { ok: false, message: payload.error, stdout, stderr }
          }
          return { ok: true, payload, message: '', stdout, stderr }
        }
      } catch {
        // Fall through to the diagnostic below.
      }
    }
    return {
      ok: false,
      message: [
        outcome.ok
          ? 'The analysis produced no JSON result.'
          : scriptFailure(outcome),
        stdout.length > 0 ? `stdout tail: ${stdout.slice(-400)}` : 'stdout: (empty)',
        stderr.length > 0 ? `stderr tail: ${stderr.slice(-400)}` : 'stderr: (empty)',
      ].join('\n'),
      stdout,
      stderr,
    }
  }

  /**
   * Render one non-zero script exit with its last stderr lines.
   * @param {{ code: number | null, signal: string | null, stderr: string }} outcome - Spawn outcome.
   * @returns {string} Diagnostic text.
   */
  function scriptFailure(outcome) {
    const reason = outcome.signal === null ? `exit code ${outcome.code}` : `signal ${outcome.signal}`
    const tail = outcome.stderr.trim().split('\n').slice(-10).join('\n')
    return `The analysis script failed (${reason}).${tail.length > 0 ? `\n${tail}` : ''}`
  }

  return {
    spawn,
    resolvePython: resolve,
    runScript,
    probeScript: PROBE_SCRIPT,
  }
}
