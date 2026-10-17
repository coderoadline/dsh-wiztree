/**
 * dsh-wiztree — host half.
 *
 * Registers four model-facing tools:
 *
 *   wiztree_diff           compare two WizTree CSV snapshots (health check,
 *                          top-down growth location, minimal responsible
 *                          parent folders, exact new file/folder counts)
 *   wiztree_query          inspect one folder inside a snapshot without
 *                          touching the disk (children, versions, stale dirs)
 *   wiztree_verify_delete  read-only content check of candidate folders, with
 *                          a ✅/⚠️/❌ verdict per folder
 *   open_path              reveal a file or folder in File Explorer (or open it
 *                          with the OS default application)
 *
 * The analysis itself lives in three Python scripts under `lib/scripts/`,
 * synced verbatim from the `wiztree-snapshot-diff` skill. This module is the
 * thin, model-facing contract around them: paths in, JSON out, plus the
 * Markdown report on disk whose every path is a clickable link in the Web GUI.
 *
 * ## Schema contract (read before touching a tool)
 *
 * `ctx.tools.register()` compiles nothing. It validates `output.schema` against
 * the harness's JSON Schema subset and stores `parameters` **verbatim**; the
 * harness then forwards that stored value to the provider as the function's
 * parameter schema. So both schemas are written here as raw JSON Schema, and
 * `parameters` must be object-rooted (`type: 'object'` + `properties` +
 * `required: [...]`). The `{ field: { type, required: true } }` authoring
 * shorthand belongs to `defineTool()`, which this plugin does not use; handing
 * that shorthand to `register()` produces a schema with no object root, and the
 * provider then rejects every request with `invalid function call parameters`
 * (工具定义不合规). `assertParameterSchema()` enforces this at load time.
 *
 * @module dsh-wiztree
 */

import { mkdirSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createPythonRunner } from './run-python.js'
import {
  isAbsolutePath,
  markdownPathLink,
  normalizePath,
  parentDirectory,
  parsePathTarget,
} from './paths.js'

/** Stable loader identity. */
export const name = 'wiztree'

/** Services this plugin consumes. */
export const inject = ['tools', 'subprocess', 'fs', 'webServer']

/** Directory holding the analysis scripts. */
const SCRIPT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'scripts')

/**
 * Lower-cased root of this package. The click gesture must never be able to
 * send the plugin's own source to the Recycle Bin — a transcript is full of
 * references to the code the plugin is made of.
 */
const PLUGIN_ROOT = normalizePath(resolve(dirname(fileURLToPath(import.meta.url)), '..')).toLowerCase()

/** Script entry point (the JSON wrapper around the three analysis scripts). */
const DIFF_SCRIPT = join(SCRIPT_DIR, 'wiztree_tool.py')

/** Default analysis threshold in MB (the skill's own default). */
const DEFAULT_MIN_MB = 1

/** Characters of a generated report echoed back to the model. */
const REPORT_ECHO_CHARS = 6000

// The plugin declares no Schemastery `Config` on purpose: it works with zero
// configuration (the DSH runtime's bundled Python already carries pandas and
// numpy), and the one optional key is read defensively in `apply` so the
// package keeps no dependency beyond the harness primitives it already uses.

/**
 * Render bytes as a human-readable size.
 * @param {number} value - Byte count.
 * @returns {string} Formatted size.
 */
function humanBytes(value) {
  const absolute = Math.abs(value)
  if (absolute >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`
  if (absolute >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(2)} MB`
  if (absolute >= 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${Math.round(value)} B`
}

/**
 * Resolve one tool-supplied path against the session working directory.
 * @param {string} value - Raw path.
 * @param {string} cwd - Session working directory.
 * @returns {string} Absolute path.
 */
function absolutePath(value, cwd) {
  const trimmed = String(value).trim().replace(/^"|"$/gu, '')
  if (trimmed.length === 0) return trimmed
  if (isAbsolute(trimmed)) return normalizePath(trimmed)
  return resolve(cwd, trimmed)
}

/**
 * Create the parent directory of an output path, when it has one.
 * @param {string} target - Absolute output path.
 * @returns {void}
 */
function ensureParent(target) {
  const parent = dirname(target)
  if (parent.length > 0) mkdirSync(parent, { recursive: true })
}

/**
 * Describe an artifact for the tool result.
 * @param {string} path - Absolute path.
 * @param {string} description - Short label.
 * @returns {{ path: string, description: string, bytes: number }} Artifact record.
 */
function artifact(path, description) {
  let bytes = 0
  try {
    bytes = statSync(path).size
  } catch {
    bytes = 0
  }
  return { path, description, bytes }
}

/**
 * Trim a report to the sections a model needs first.
 * @param {string} report - Full Markdown report.
 * @returns {string} Echoed excerpt.
 */
function reportExcerpt(report) {
  if (report.length <= REPORT_ECHO_CHARS) return report
  return `${report.slice(0, REPORT_ECHO_CHARS)}\n\n…（报告已截断；完整报告见上面的报告路径）`
}

/**
 * Render the paths a tool result should advertise as clickable links.
 * @param {Array<{ path: string, description: string, bytes?: number }>} artifacts - Artifact records.
 * @param {Map<string, { path: string }>} [canonical] - Canonical-path lookup, keyed by lower-cased path.
 * @returns {string[]} Markdown link lines.
 */
function artifactLines(artifacts, canonical) {
  return artifacts.map(item => {
    const resolved = canonical?.get(item.path.toLowerCase())?.path ?? item.path
    return `- ${item.description}: ${markdownPathLink(resolved)}`
  })
}

/**
 * Check a tool's `parameters` really is the JSON Schema the harness forwards to
 * the provider, and fail loudly here when it is not.
 *
 * `ctx.tools.register()` validates only `output.schema`; it stores `parameters`
 * **verbatim** and the harness sends that stored value on as the function's
 * parameter schema. The authoring convenience `{ type, required: true }` per
 * property — the form `defineTool()` compiles into a `required` array — is
 * therefore not compiled anywhere on this path, reaches the model as a schema
 * with no object root, and makes the provider reject every request with
 * `invalid function call parameters` (工具定义不合规). That failure is silent
 * here and global there, so it is worth an explicit check at load time.
 * @param {string} name - Tool name, for the diagnostic.
 * @param {object} schema - The authored `parameters` value.
 * @returns {void}
 * @throws {TypeError} When the schema is not an object-root JSON Schema.
 */
export function assertParameterSchema(name, schema) {
  const fail = message => {
    throw new TypeError(`dsh-wiztree: tool "${name}" ${message}`)
  }
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) fail('parameters must be an object')
  if (schema.type !== 'object') fail(`parameters.type must be "object" (got ${JSON.stringify(schema.type)}); ctx.tools.register() does not compile the authoring shorthand`)
  if (schema.required !== undefined && !Array.isArray(schema.required)) fail('parameters.required must be an array of property names')
  const properties = schema.properties
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) fail('parameters.properties must be an object')
  for (const [key, property] of Object.entries(properties)) {
    if (Object.hasOwn(property, 'required')) {
      fail(`parameters.properties.${key} carries "required"; move "${key}" into the top-level required array (the shorthand is never compiled here)`)
    }
    if (typeof property.type !== 'string') fail(`parameters.properties.${key} needs a "type"`)
  }
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(properties, key)) fail(`parameters.required names "${key}", which is not in properties`)
  }
}

/**
 * Register the wiztree tools.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {{ pythonPath?: string }} config - Plugin configuration.
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const cwd = process.cwd()
  const pythonPath = typeof config.pythonPath === 'string' && config.pythonPath.trim().length > 0
    ? config.pythonPath.trim()
    : undefined
  const runner = createPythonRunner({
    subprocess: ctx.subprocess,
    cwd,
  })

  /**
   * Fail one tool call with an actionable message.
   * @param {string} message - Diagnostic.
   * @returns {never} Never returns.
   */
  function fail(message) {
    throw new Error(message)
  }

  /**
   * Shared accessor for the session working directory.
   * @param {object} exec - Tool execution.
   * @returns {string} Working directory.
   */
  function execCwd(exec) {
    return exec?.agent?.session?.header?.cwd ?? cwd
  }

  /**
   * Classify one host path through the composed filesystem.
   * @param {string} target - Absolute path in host syntax.
   * @returns {Promise<{ exists: boolean, type: 'file' | 'directory' | 'other', bytes: number }>} What the path is right now.
   */
  async function statTarget(target) {
    try {
      const resolved = await ctx.fs.resolve(target)
      const info = await ctx.fs.stat(resolved)
      if (info === undefined) return { exists: false, type: 'other', bytes: 0 }
      const bytes = Number(info.size)
      return { exists: true, type: info.type, bytes: Number.isFinite(bytes) && bytes > 0 ? bytes : 0 }
    } catch {
      return { exists: false, type: 'other', bytes: 0 }
    }
  }

  /**
   * Both WizTree exports and this plugin's own row keys are lower-cased, while
   * the paths a user clicks must be real. Ask the filesystem for the canonical
   * absolute path of every path a tool result is about to publish.
   *
   * Only paths that still exist are canonicalised; a stale snapshot entry keeps
   * its reported spelling so the report never invents a path.
   * @param {string[]} targets - Absolute paths to canonicalise.
   * @returns {Promise<Map<string, { path: string, exists: boolean, type: string }>>} Keyed by the lower-cased input.
   */
  async function canonicalize(targets) {
    const unique = [...new Set(targets.filter(item => typeof item === 'string' && item.length > 0))]
    const results = await Promise.all(unique.map(async target => {
      try {
        const resolved = await ctx.fs.resolve(target)
        const info = await ctx.fs.stat(resolved)
        const canonical = ctx.fs.processPath(resolved)
        const mapped = ctx.fs.processPathFromHostPath(canonical)
        if (info === undefined || typeof mapped !== 'string' || mapped.length === 0) {
          // Absent, or in an execution world that cannot reach the host path:
          // keep the reported spelling rather than inventing one.
          return [target.toLowerCase(), { path: normalizePath(target), exists: info !== undefined, type: info?.type ?? 'other' }]
        }
        return [target.toLowerCase(), { path: normalizePath(mapped), exists: true, type: info.type }]
      } catch {
        return [target.toLowerCase(), { path: normalizePath(target), exists: false, type: 'other' }]
      }
    }))
    return new Map(results)
  }

  /**
   * Reveal a path in the platform file manager, or open it with the OS default
   * handler. One implementation serves both the `open_path` tool and the
   * `/wiztree/open` route the browser half calls.
   * @param {{ path: string, action?: 'reveal' | 'open', isDirectory: boolean, signal?: AbortSignal }} request - What to open.
   * @returns {Promise<{ ok: true, opened: string, note?: string } | { ok: false, message: string }>} Launch outcome.
   */
  async function openTarget(request) {
    const target = request.path
    const action = request.action === 'open' ? 'open' : 'reveal'
    const spawn = (command, argv) => runner.spawn(command, argv, cwd, request.signal, 15_000)

    /** @type {{ ok: boolean, message: string } | undefined} */
    let outcome
    let opened = action

    if (process.platform === 'win32') {
      if (action === 'reveal') {
        if (request.isDirectory) {
          outcome = await spawn('explorer.exe', [target])
        } else {
          outcome = await spawn('explorer.exe', [`/select,${target}`])
          if (!outcome.ok) {
            const parent = parentDirectory(target)
            outcome = await spawn('explorer.exe', [parent.length > 0 ? parent : target])
            opened = 'reveal-parent'
          }
        }
      } else {
        outcome = await spawn('cmd.exe', ['/c', 'start', '', target])
      }
    } else if (process.platform === 'darwin') {
      outcome = action === 'reveal' ? await spawn('open', ['-R', target]) : await spawn('open', [target])
    } else {
      const parent = parentDirectory(target)
      const fallback = parent.length > 0 ? parent : target
      outcome = await spawn('xdg-open', [request.isDirectory ? target : fallback])
    }

    if (outcome !== undefined && !outcome.ok && outcome.message.length > 0) {
      return { ok: false, message: outcome.message }
    }
    return {
      ok: true,
      opened,
      ...(opened === 'reveal-parent'
        ? { note: 'File Explorer was opened on the containing folder (selecting the item was not accepted).' }
        : {}),
    }
  }

  // ---------------------------------------------------------------------------
  // Browser bridge: /wiztree/stat and /wiztree/open
  //
  // The client half cannot stat a host path and has no model-facing tool of its
  // own, so these two routes are how a click in the transcript becomes a File
  // Explorer window. Both are read-only on `/stat` and user-gesture-only on
  // `/open` (the browser half only calls it from a deliberate click).
  // ---------------------------------------------------------------------------

  /** Maximum accepted JSON body for the routes below. */
  const MAX_BODY_BYTES = 64 * 1024

  /**
   * Read a bounded JSON body.
   * @param {import('node:http').IncomingMessage} req - Request.
   * @returns {Promise<object>} Parsed body.
   */
  async function readJsonBody(req) {
    const chunks = []
    let total = 0
    for await (const chunk of req) {
      total += chunk.length
      if (total > MAX_BODY_BYTES) throw new Error('request body too large')
      chunks.push(chunk)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }

  /**
   * Send one JSON response.
   * @param {import('node:http').ServerResponse} res - Response.
   * @param {number} status - HTTP status.
   * @param {object} payload - JSON payload.
   * @returns {void}
   */
  function sendJson(res, status, payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('content-length', String(body.length))
    res.setHeader('cache-control', 'no-store')
    res.end(body)
  }

  /**
   * Parse and validate one path-bearing request body.
   * @param {object} body - Parsed body.
   * @returns {string} The absolute path.
   * @throws {Error} When the body carries no usable path.
   */
  function bodyPath(body) {
    const raw = typeof body?.path === 'string' ? body.path.trim() : ''
    if (raw.length === 0) throw new Error('a non-empty "path" is required')
    const target = absolutePath(raw, cwd)
    if (!isAbsolutePath(target)) throw new Error(`"${raw}" is not an absolute path`)
    return target
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/wiztree/stat',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST required' })
        return
      }
      let target
      try {
        target = bodyPath(await readJsonBody(req))
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
        return
      }
      const info = await statTarget(target)
      sendJson(res, 200, { ok: true, path: target, exists: info.exists, type: info.type, bytes: info.bytes })
    },
  }), 'wiztree: POST /wiztree/stat')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/wiztree/open',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST required' })
        return
      }
      let body
      let target
      try {
        body = await readJsonBody(req)
        target = bodyPath(body)
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
        return
      }
      const info = await statTarget(target)
      if (!info.exists) {
        sendJson(res, 404, { ok: false, error: `\`${target}\` no longer exists`, path: target })
        return
      }
      const action = body?.action === 'open' ? 'open' : 'reveal'
      const outcome = await openTarget({ path: target, action, isDirectory: info.type === 'directory' })
      if (!outcome.ok) {
        sendJson(res, 502, { ok: false, error: outcome.message, path: target })
        return
      }
      sendJson(res, 200, { ok: true, path: target, type: info.type, opened: outcome.opened, note: outcome.note })
    },
  }), 'wiztree: POST /wiztree/open')

  // ---------------------------------------------------------------------------
  // Recycle Bin: what a click on a path means
  //
  // A snapshot review ends with a person deciding, and this is the action that
  // decision turns into: move the clicked item to the Recycle Bin, where it
  // stays recoverable. There is deliberately NO permanent-delete path anywhere
  // in this plugin — not a flag, not a fallback — so a mis-click is never final.
  // ---------------------------------------------------------------------------

  /** A UNC share root (`\\server\share`), whose children are that share's contents. */
  const UNC_SHARE_ROOT = /^\\\\[^\\/]+\\[^\\/]+$/u

  /**
   * Refuse the paths a single mis-click must never send to the Recycle Bin.
   *
   * The Recycle Bin is recoverable, but moving a folder takes its whole subtree
   * with it, so the guard is deliberately blunt: volume roots, share roots, the
   * well-known system and user roots, and anything containing this plugin's own
   * working directory.
   * @param {string} target - Path, normalized to host syntax.
   * @returns {string | undefined} Why the path is refused, or undefined when it is allowed.
   */
  function recycleRefusal(target) {
    const normalised = normalizePath(target)
    if (/^[a-zA-Z]:\\?$/u.test(normalised)) return 'a volume root'
    if (UNC_SHARE_ROOT.test(normalised)) return 'a network share root'

    const lower = normalised.toLowerCase()
    const protectedRoots = [
      process.env.SystemRoot,
      process.env.windir,
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
      process.env.ProgramW6432,
      process.env.ProgramData,
      process.env.USERPROFILE,
      process.env.LOCALAPPDATA,
      process.env.APPDATA,
    ]
    for (const root of protectedRoots) {
      if (typeof root !== 'string' || root.trim().length === 0) continue
      if (normalizePath(root).toLowerCase() === lower) return `the protected root \`${root}\``
    }

    // The plugin must never be able to recycle itself: a transcript is full of
    // references to its own source (`lib/index.js`, `src/client.js`).
    if (lower === PLUGIN_ROOT || lower.startsWith(`${PLUGIN_ROOT}\\`)) {
      return "inside this plugin's own package directory"
    }

    // The working directory and every one of its ANCESTORS are off limits: a
    // click there takes the whole tree the plugin is living in. Descendants are
    // deliberately allowed — "this folder inside my project is rubbish" is a
    // legitimate cleanup target.
    const base = normalizePath(cwd).toLowerCase()
    if (lower === base) return 'the working directory this plugin runs in'
    const targetPrefix = lower.endsWith('\\') ? lower : `${lower}\\`
    if (base.startsWith(targetPrefix)) return 'a parent of the working directory this plugin runs in'
    return undefined
  }

  /**
   * Move one path to the Recycle Bin — never a permanent delete.
   *
   * `Microsoft.VisualBasic.FileIO.FileSystem.Delete{File,Directory}` with
   * `SendToRecycleBin` is the supported recoverable-delete entry point. The
   * script travels as `-EncodedCommand` (UTF-16LE, base64) so a path containing
   * quotes, `&`, `$`, a newline, or CJK characters never reaches a command-line
   * parser, and it is spawned through the harness subprocess seam with argv only.
   * @param {string} target - Absolute path to recycle.
   * @param {boolean} isDirectory - Whether the target is a directory.
   * @param {AbortSignal} [signal] - Caller lifetime.
   * @returns {Promise<{ ok: true } | { ok: false, message: string }>} Outcome.
   */
  async function recycleTarget(target, isDirectory, signal) {
    const refusal = recycleRefusal(target)
    if (refusal !== undefined) {
      return { ok: false, message: `拒绝操作：\`${target}\` 是${refusal}，需要的话请手动处理。` }
    }

    const quoted = `'${target.replace(/'/gu, "''")}'`
    const method = isDirectory ? 'DeleteDirectory' : 'DeleteFile'
    const script = [
      "$ErrorActionPreference = 'Stop'",
      'Add-Type -AssemblyName Microsoft.VisualBasic',
      `[Microsoft.VisualBasic.FileIO.FileSystem]::${method}(${quoted}, 'OnlyErrorDialogs', 'SendToRecycleBin')`,
      "Write-Output 'recycled'",
    ].join('\n')
    const encoded = Buffer.from(script, 'utf16le').toString('base64')

    const outcome = await runner.spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      cwd,
      signal,
      120_000,
    )
    if (!outcome.ok) {
      const detail = String(outcome.stderr ?? '').trim()
        .split('\n')
        .filter(line => line.trim().length > 0)
        .slice(-5)
        .join('\n')
      return {
        ok: false,
        message: `\`${target}\` 移入回收站失败${detail.length > 0 ? `：\n${detail}` : `：${outcome.message}`}`,
      }
    }
    return { ok: true }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/wiztree/trash',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST required' })
        return
      }
      let target
      try {
        target = bodyPath(await readJsonBody(req))
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
        return
      }
      const info = await statTarget(target)
      if (!info.exists) {
        sendJson(res, 404, { ok: false, error: `\`${target}\` 已经不存在了`, path: target })
        return
      }
      const outcome = await recycleTarget(target, info.type === 'directory')
      if (!outcome.ok) {
        sendJson(res, 502, { ok: false, error: outcome.message, path: target })
        return
      }
      sendJson(res, 200, { ok: true, path: target, type: info.type, bytes: info.bytes, recycled: true })
    },
  }), 'wiztree: POST /wiztree/trash')

  /**
   * Register one tool, checking the model-facing schema first.
   * @param {object} definition - Tool definition.
   * @returns {void}
   */
  function registerTool(definition) {
    assertParameterSchema(definition.name, definition.parameters)
    ctx.tools.register(definition)
  }

  // ---------------------------------------------------------------------------
  // wiztree_diff
  // ---------------------------------------------------------------------------

  registerTool({
    name: 'wiztree_diff',
    description: [
      'Compare two WizTree CSV snapshots of a Windows drive and locate what grew.',
      '',
      'Use this for the whole "C 盘哪些文件夹变大了 / 帮我清理 C 盘" workflow: it runs the battle-tested',
      '`wiztree_snapshot_diff.py` analysis and writes a Markdown report whose every path is a clickable',
      'link in the Web GUI.',
      '',
      'What it reports, and why it is trustworthy:',
      '- data health check per snapshot (which top-level ranges were actually exported, whether the',
      '  cumulative 大小/文件/文件夹 columns are self-consistent) — always read this section first;',
      '- whole-disk 大小 / 文件 / 文件夹 deltas (exact);',
      '- top-down growth location, marking each folder as ✓ observed (delta exact, drillable),',
      '  🆕 new (really absent before) or ⚠️ boundary (exact but not sub-divisible);',
      '- the minimal responsible parent folders (a parent whose growth its children fully explain is',
      '  dropped, so the list never double counts);',
      '- ranges the OLD snapshot never covered, explicitly excluded from growth (they are NOT new);',
      '- exact new-folder / new-file counts.',
      '',
      'The `大小` / `文件` / `文件夹` columns are subtree totals for folder rows, so a parent already',
      'contains its children: never add a parent and its child deltas together.',
      '',
      'One snapshot only? Do not call this: use `wiztree_query` against that snapshot instead.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['old_snapshot', 'new_snapshot'],
      properties: {
        old_snapshot: { type: 'string', description: 'Path of the OLDER WizTree CSV export (WizTree_YYYYMMDDHHMMSS.csv).' },
        new_snapshot: { type: 'string', description: 'Path of the NEWER WizTree CSV export.' },
        output: { type: 'string', description: 'Where to write the Markdown report. Defaults to <workspace>/wiztree-out/wiztree-diff-report.md.' },
        min_mb: { type: 'number', description: `Smallest growth worth reporting, in MB. Default ${DEFAULT_MIN_MB}; use 10 or more to cut noise on long intervals.` },
        top: { type: 'integer', description: 'Maximum rows per report table. Default 200.' },
        depth: { type: 'integer', description: 'Maximum drill-down depth for the top-down location tree. Default 8.' },
        root: { type: 'string', description: 'Only analyse paths under this prefix, for example "C:\\Users".' },
        subtree: { type: 'string', description: 'Start the top-down drill-down at this subtree (recommended when the boundary sits high up).' },
        dump_csv: { type: 'string', description: 'Optional path for a per-folder delta CSV export.' },
      },
    },
    async execute(args, exec) {
      const sessionCwd = execCwd(exec)
      const oldPath = absolutePath(args.old_snapshot, sessionCwd)
      const newPath = absolutePath(args.new_snapshot, sessionCwd)
      for (const [label, target] of [['old_snapshot', oldPath], ['new_snapshot', newPath]]) {
        try {
          statSync(target)
        } catch {
          fail(`Cannot read ${label}: \`${target}\` does not exist. Ask the user for the real WizTree export path (or list their Downloads folder) and retry.`)
        }
      }

      const reportPath = args.output === undefined || String(args.output).trim().length === 0
        ? join(sessionCwd, 'wiztree-out', 'wiztree-diff-report.md')
        : absolutePath(args.output, sessionCwd)
      ensureParent(reportPath)

      const dumpCsv = args.dump_csv === undefined || String(args.dump_csv).trim().length === 0
        ? undefined
        : absolutePath(args.dump_csv, sessionCwd)
      if (dumpCsv !== undefined) ensureParent(dumpCsv)

      const argv = ['diff', '--report', reportPath]
      if (args.min_mb !== undefined) argv.push('--min-mb', String(args.min_mb))
      if (args.top !== undefined) argv.push('--top', String(args.top))
      if (args.depth !== undefined) argv.push('--depth', String(args.depth))
      if (args.root !== undefined && String(args.root).trim().length > 0) argv.push('--root', String(args.root))
      if (args.subtree !== undefined && String(args.subtree).trim().length > 0) argv.push('--subtree', String(args.subtree))
      if (dumpCsv !== undefined) argv.push('--dump-csv', dumpCsv)
      argv.push(oldPath, newPath)

      const result = await runner.runScript({
        pythonPath,
        script: DIFF_SCRIPT,
        args: argv,
        signal: exec?.signal,
        timeoutMs: 300_000,
      })
      if (!result.ok) fail(result.message)

      const payload = result.payload
      const report = typeof payload.report === 'string' ? payload.report : ''
      const artifacts = [artifact(reportPath, 'Markdown 报告（所有路径可点击）')]
      if (dumpCsv !== undefined) artifacts.push(artifact(dumpCsv, '逐文件夹差值 CSV'))

      return {
        summary: String(payload.console ?? '').trim(),
        reportPath,
        reportBytes: report.length,
        reportExcerpt: reportExcerpt(report),
        artifacts,
        oldSnapshot: oldPath,
        newSnapshot: newPath,
      }
    },
    output: {
      schema: {
         type: "object",
         additionalProperties: false,
         required: [
           "summary",
           "reportPath",
           "reportBytes",
           "reportExcerpt",
           "artifacts",
           "oldSnapshot",
           "newSnapshot"
         ],
         properties: {
           summary: {
             type: "string",
             description: "The analysis console summary (health check, totals, top growth paths)."
           },
           reportPath: {
             type: "string",
             description: "Absolute path of the written Markdown report."
           },
           reportBytes: {
             type: "integer"
           },
           reportExcerpt: {
             type: "string",
             description: "Head of the report; read the full file when you need more."
           },
           artifacts: {
             type: "array",
             items: {
               type: "object",
               additionalProperties: false,
               required: [
                 "path",
                 "description",
                 "bytes"
               ],
               properties: {
                 path: {
                   type: "string"
                 },
                 description: {
                   type: "string"
                 },
                 bytes: {
                   type: "integer"
                 }
               }
             }
           },
           oldSnapshot: {
             type: "string"
           },
           newSnapshot: {
             type: "string"
           }
         }
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          value.summary,
          '',
          '## 产出',
          ...artifactLines(value.artifacts),
          '',
          `报告全文（${value.reportBytes} 字符）见上面路径；下面是报告开头：`,
          '',
          value.reportExcerpt,
        ].join('\n'),
      }],
    },
  })

  // ---------------------------------------------------------------------------
  // wiztree_query
  // ---------------------------------------------------------------------------

  registerTool({
    name: 'wiztree_query',
    description: [
      'Answer a question about ONE folder inside a WizTree snapshot — without scanning any disk.',
      '',
      'Use this after `wiztree_diff` to drill into a specific folder ("这个目录里到底是什么占的"), to list',
      'version pile-ups (`versions: true`), or to find folders untouched for months (`stale_days: 180`).',
      'It also works with a single snapshot, when there is nothing to compare against.',
      '',
      'Every row carries the folder path, its subtree size, file/folder counts and last-modified time',
      'straight from the snapshot. When the export contains only folder rows (every path ends with "\\"),',
      'file names simply do not exist in the data — the result says so in `notice`; never claim to know',
      'file names then.',
      '',
      '`versions: true` groups entries whose names carry a version number, which is the reliable way to',
      'spot old-version leftovers worth deleting. Do NOT conclude a folder is abandoned merely because',
      'a sibling with a newer-looking name exists.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['snapshot', 'path'],
      properties: {
        snapshot: { type: 'string', description: 'Path of the WizTree CSV snapshot to query.' },
        path: { type: 'string', description: 'Folder to inspect, for example "C:\\Users\\ASUS\\AppData\\Local\\Temp".' },
        recursive: { type: 'boolean', description: 'List every descendant instead of only direct children.' },
        min_mb: { type: 'number', description: 'Only list entries at least this large, in MB. Default 0.' },
        top: { type: 'integer', description: 'Maximum entries returned. Default 40.' },
        versions: { type: 'boolean', description: 'Group version-numbered entries under the same name prefix (old-version leftovers).' },
        stale_days: { type: 'integer', description: 'Only entries not written for at least this many days. 180 or more means "3+ months".' },
      },
    },
    async execute(args, exec) {
      const sessionCwd = execCwd(exec)
      const snapshot = absolutePath(args.snapshot, sessionCwd)

      const result = await runner.runScript({
        pythonPath,
        script: DIFF_SCRIPT,
        args: [
          'query',
          '--csv', snapshot,
          '--path', String(args.path),
          ...(args.recursive === true ? ['--recursive'] : []),
          ...(args.min_mb !== undefined ? ['--min-mb', String(args.min_mb)] : []),
          ...(args.top !== undefined ? ['--top', String(args.top)] : []),
          ...(args.versions === true ? ['--versions'] : []),
          ...(args.stale_days !== undefined ? ['--stale-days', String(args.stale_days)] : []),
        ],
        signal: exec?.signal,
        timeoutMs: 180_000,
      })
      if (!result.ok) fail(result.message)

      const payload = result.payload
      const notice = [
        payload.meta?.foldersOnly === true
          ? '快照只有文件夹行：查不到文件名，最小粒度是文件夹。'
          : undefined,
        payload.exactMatch === false
          ? `快照里没有 \`${args.path}\`，下面是前缀匹配的结果。`
          : undefined,
        ...(Array.isArray(payload.notes) ? payload.notes : []),
      ].filter(item => typeof item === 'string' && item.length > 0)

      const rawRows = Array.isArray(payload.rows) ? payload.rows : []
      const rawGroups = Array.isArray(payload.versionGroups) ? payload.versionGroups : []
      // Snapshot row keys are lower-cased; every path a user may click is
      // resolved against the live filesystem so the result carries the real
      // spelling (and tells the model which candidates still exist).
      const canonical = await canonicalize([
        ...rawRows.map(row => row.path),
        ...rawGroups.flatMap(group => group.versions.map(item => item.path)),
      ])
      const rows = rawRows.map(row => {
        const found = canonical.get(String(row.path).toLowerCase())
        return {
          ...row,
          path: found?.path ?? row.path,
          exists: found?.exists ?? false,
        }
      })
      const versionGroups = rawGroups.map(group => ({
        ...group,
        versions: group.versions.map(item => {
          const found = canonical.get(String(item.path).toLowerCase())
          return { ...item, path: found?.path ?? item.path, exists: found?.exists ?? false }
        }),
      }))
      const missing = rows.filter(row => row.exists === false).length
      if (missing > 0) {
        notice.push(`${missing} 个候选在快照之后已被删除或改名（快照数据仍保留它们的体积）。`)
      }

      return {
        folder: String(payload.path ?? args.path),
        snapshot,
        matched: Number(payload.matched ?? 0),
        totalBytes: Number(payload.totalBytes ?? 0),
        versions: Boolean(args.versions),
        notice,
        rows,
        versionGroups,
      }
    },
    output: {
      schema: {
         type: "object",
         additionalProperties: false,
         required: [
           "folder",
           "snapshot",
           "matched",
           "totalBytes",
           "versions",
           "notice",
           "rows",
           "versionGroups"
         ],
         properties: {
           folder: {
             type: "string"
           },
           snapshot: {
             type: "string"
           },
           matched: {
             type: "integer"
           },
           totalBytes: {
             type: "integer"
           },
           versions: {
             type: "boolean"
           },
           notice: {
             type: "array",
             items: {
               type: "string"
             }
           },
           rows: {
             type: "array",
             items: {
               type: "object",
               additionalProperties: false,
               required: [
                 "path",
                 "size",
                 "files",
                 "folders",
                 "mtime",
                 "isDir",
                 "exists"
               ],
               properties: {
                 path: {
                   type: "string"
                 },
                 size: {
                   type: "integer"
                 },
                 files: {
                   type: "integer"
                 },
                 folders: {
                   type: "integer"
                 },
                 mtime: {
                   type: "string"
                 },
                 isDir: {
                   type: "boolean"
                 },
                 exists: {
                   type: "boolean",
                   description: "Whether the folder still exists on disk right now (snapshot data may be stale)."
                 }
               }
             }
           },
           versionGroups: {
             type: "array",
             items: {
               type: "object",
               additionalProperties: false,
               required: [
                 "group",
                 "count",
                 "totalBytes",
                 "versions"
               ],
               properties: {
                 group: {
                   type: "string"
                 },
                 count: {
                   type: "integer"
                 },
                 totalBytes: {
                   type: "integer"
                 },
                 versions: {
                   type: "array",
                   items: {
                     type: "object",
                     additionalProperties: false,
                     required: [
                       "version",
                       "path",
                       "size",
                       "mtime",
                       "exists"
                     ],
                     properties: {
                       version: {
                         type: "string"
                       },
                       path: {
                         type: "string"
                       },
                       size: {
                         type: "integer"
                       },
                       mtime: {
                         type: "string"
                       },
                       exists: {
                         type: "boolean"
                       }
                     }
                   }
                 }
               }
             }
           }
         }
      },
      render: (_args, value) => {
        const lines = [
          `\`${value.folder}\` — 共 ${value.matched} 项，合计 ${humanBytes(value.totalBytes)}`,
          ...value.notice.map(item => `> ${item}`),
          '',
        ]
        const missingTag = item => (item.exists === false ? ' · ⚠️ 已不存在' : '')
        if (value.versionGroups.length > 0) {
          for (const group of value.versionGroups) {
            lines.push(`**${group.group}** — ${group.count} 个版本，合计 ${humanBytes(group.totalBytes)}`)
            for (const item of group.versions) {
              lines.push(`- v${item.version} · ${humanBytes(item.size)} · ${item.mtime}${missingTag(item)} · ${markdownPathLink(item.path)}`)
            }
            lines.push('')
          }
        }
        if (value.rows.length > 0) {
          lines.push('| 大小 | 文件 | 目录 | 修改时间 | 路径 |', '|---:|---:|---:|---|---|')
          for (const row of value.rows) {
            lines.push(`| ${humanBytes(row.size)} | ${row.files} | ${row.folders} | ${row.mtime}${missingTag(row)} | ${markdownPathLink(row.path)} |`)
          }
        } else if (value.versionGroups.length === 0) {
          lines.push('_没有匹配的条目。_')
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
  })

  // ---------------------------------------------------------------------------
  // wiztree_verify_delete
  // ---------------------------------------------------------------------------

  registerTool({
    name: 'wiztree_verify_delete',
    description: [
      'Read-only content check of candidate folders before you recommend deleting them.',
      '',
      'A snapshot only carries folder name + size + timestamp, which cannot prove what a folder holds',
      'or whether it is still used. This tool looks inside the named folders (and only those folders)',
      'and reports: file-type distribution, largest files, and a ✅/⚠️/❌ verdict backed by evidence —',
      'databases/credentials/media/chat data (❌), installers and running executables (⚠️),',
      'regenerable logs and caches (✅).',
      '',
      'It never deletes, moves, or renames anything, and it reports the folder size it measured so a',
      'stale snapshot figure can be corrected.',
      '',
      'What it CANNOT tell you: whether the owning software is still installed or still used — check the',
      'registry / install directories / running processes for that. Combine both before recommending a',
      'deletion.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['paths'],
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Folders to inspect (one or more absolute paths).',
        },
        top: { type: 'integer', description: 'How many largest files to report per folder. Default 15.' },
      },
    },
    async execute(args, exec) {
      const sessionCwd = execCwd(exec)
      const requested = (Array.isArray(args.paths) ? args.paths : [])
        .map(item => absolutePath(item, sessionCwd))
        .filter(item => item.length > 0)
      if (requested.length === 0) fail('wiztree_verify_delete needs at least one folder path.')

      // Resolve every candidate against the live filesystem first: it fixes the
      // character case the snapshot reports, and a folder that is already gone
      // needs no scan at all.
      const canonical = await canonicalize(requested)
      const existing = []
      const missing = []
      for (const target of requested) {
        const found = canonical.get(target.toLowerCase())
        const path = found?.path ?? target
        if (found?.exists === true) existing.push(path)
        else missing.push(path)
      }

      let summary = ''
      let scanned = []
      if (existing.length > 0) {
        const result = await runner.runScript({
          pythonPath,
          script: DIFF_SCRIPT,
          args: [
            'verify',
            ...existing,
            ...(args.top !== undefined ? ['--top', String(args.top)] : []),
          ],
          signal: exec?.signal,
          timeoutMs: 300_000,
        })
        if (!result.ok) fail(result.message)
        summary = String(result.payload.console ?? '').trim()
        scanned = Array.isArray(result.payload.results) ? result.payload.results : []
      }

      const results = [
        ...scanned,
        ...missing.map(path => ({
          path,
          exists: false,
          level: 'n/a',
          reason: '路径当前已不存在（快照数据是旧的）',
          bytes: 0,
          files: 0,
          dirs: 0,
          errors: 0,
          byExt: [],
          byTopDir: [],
          dangerKinds: [],
          dangerBytes: 0,
          warnCount: 0,
          safeCount: 0,
          largest: [],
        })),
      ]
      return {
        summary: missing.length > 0
          ? `${summary}\n\n注意：${missing.length} 个候选目录当前已不存在，无需再核实。`.trim()
          : summary,
        results,
        readOnly: true,
      }
    },
    output: {
      schema: {
         type: "object",
         additionalProperties: false,
         required: [
           "summary",
           "readOnly",
           "results"
         ],
         properties: {
           summary: {
             type: "string",
             description: "Full human-readable analysis (type distribution, largest files, verdict per folder)."
           },
           readOnly: {
             type: "boolean"
           },
           results: {
             type: "array",
             items: {
               type: "object",
               additionalProperties: false,
               required: [
                 "path",
                 "exists",
                 "level",
                 "reason",
                 "bytes",
                 "files",
                 "dirs",
                 "errors",
                 "dangerBytes",
                 "warnCount",
                 "safeCount",
                 "dangerKinds",
                 "byExt",
                 "byTopDir",
                 "largest"
               ],
               properties: {
                 path: {
                   type: "string"
                 },
                 exists: {
                   type: "boolean"
                 },
                 level: {
                   type: "string"
                 },
                 reason: {
                   type: "string"
                 },
                 bytes: {
                   type: "integer"
                 },
                 files: {
                   type: "integer"
                 },
                 dirs: {
                   type: "integer"
                 },
                 errors: {
                   type: "integer"
                 },
                 dangerBytes: {
                   type: "integer"
                 },
                 warnCount: {
                   type: "integer"
                 },
                 safeCount: {
                   type: "integer"
                 },
                 dangerKinds: {
                   type: "array",
                   items: {
                     type: "string"
                   }
                 },
                 byExt: {
                   type: "array",
                   items: {
                     type: "object",
                     additionalProperties: false,
                     required: [
                       "ext",
                       "count",
                       "bytes"
                     ],
                     properties: {
                       ext: {
                         type: "string"
                       },
                       count: {
                         type: "integer"
                       },
                       bytes: {
                         type: "integer"
                       }
                     }
                   }
                 },
                 byTopDir: {
                   type: "array",
                   items: {
                     type: "object",
                     additionalProperties: false,
                     required: [
                       "name",
                       "count",
                       "bytes"
                     ],
                     properties: {
                       name: {
                         type: "string"
                       },
                       count: {
                         type: "integer"
                       },
                       bytes: {
                         type: "integer"
                       }
                     }
                   }
                 },
                 largest: {
                   type: "array",
                   items: {
                     type: "object",
                     additionalProperties: false,
                     required: [
                       "path",
                       "bytes",
                       "mtime"
                     ],
                     properties: {
                       path: {
                         type: "string"
                       },
                       bytes: {
                         type: "integer"
                       },
                       mtime: {
                         type: "string"
                       }
                     }
                   }
                 }
               }
             }
           }
         }
      },
      render: (_args, value) => {
        const lines = ['| 结论 | 实测体积 | 目录 | 依据 |', '|---|---:|---|---|']
        for (const item of value.results) {
          lines.push(`| ${item.level} | ${humanBytes(item.bytes)} | ${markdownPathLink(item.path)} | ${item.reason} |`)
        }
        lines.push('', '—— 下面是逐目录明细（只读，未改动任何文件）——', '', value.summary)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
  })

  // ---------------------------------------------------------------------------
  // open_path
  // ---------------------------------------------------------------------------

  registerTool({
    name: 'open_path',
    description: [
      'Open a local path on the user\'s desktop: reveal it in File Explorer (default) or open it with the',
      'application the operating system associates with it.',
      '',
      'Use it when the user asks you to "打开/定位这个文件夹", or right after you produce a report you want',
      'them to look at. In the Web GUI the user can also just click a path link in the transcript — this',
      'tool exists for the cases where they asked you to open it, so they do not have to click at all.',
      '',
      'The path must exist. Nothing is modified: `reveal` selects the item in its containing folder,',
      '`open` hands it to the OS default handler. Never use it to run a searched-for executable:',
      'pass an absolute path you already know.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'Absolute path of an existing file or folder.' },
        action: {
          type: 'string',
          enum: ['reveal', 'open'],
          description: '"reveal" (default) shows the item in File Explorer; "open" launches it with the OS default application.',
        },
      },
    },
    async execute(args, exec) {
      const sessionCwd = execCwd(exec)
      const target = absolutePath(args.path, sessionCwd)
      if (!isAbsolutePath(target)) fail(`\`${args.path}\` is not an absolute path; open_path needs an absolute path on the host.`)

      let stats
      try {
        stats = statSync(target)
      } catch {
        fail(`\`${target}\` does not exist, so there is nothing to open. Check the path (a stale snapshot entry may already have been deleted) and retry.`)
      }
      const isDirectory = stats.isDirectory()
      const action = args.action === 'open' ? 'open' : 'reveal'
      const outcome = await openTarget({ path: target, action, isDirectory, signal: exec?.signal })
      if (!outcome.ok) fail(outcome.message)
      return {
        path: target,
        action,
        kind: isDirectory ? 'directory' : 'file',
        opened: outcome.opened,
        note: outcome.note,
      }
    },
    output: {
      schema: {
         type: "object",
         additionalProperties: false,
         required: [
           "path",
           "action",
           "kind",
           "opened"
         ],
         properties: {
           path: {
             type: "string"
           },
           action: {
             type: "string"
           },
           kind: {
             type: "string"
           },
           opened: {
             type: "string"
           },
           note: {
             type: "string"
           }
         }
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.note === undefined
          ? `${value.action === 'reveal' ? '已在资源管理器中定位' : '已用默认程序打开'}: ${markdownPathLink(value.path)}`
          : `${value.note}\n${markdownPathLink(value.path)}`,
      }],
    },
  })
}

/**
 * Exported for tests: resolve the path syntax helpers against a working directory.
 * @param {string} value - Link destination.
 * @param {string} cwd - Working directory.
 * @returns {object | undefined} Parsed target.
 */
export function parseLink(value, cwd) {
  return parsePathTarget(value, { cwd })
}
