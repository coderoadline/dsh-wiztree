/**
 * Plugin-level tests for the host half.
 *
 * `apply()` is exercised against a minimal fake Cordis context, which pins the
 * parts that are easy to get wrong without a running harness: the tool catalog
 * itself, the output schema shape the harness validates results with, the
 * `defineTool`-free registration contract, and the two browser routes.
 *
 * The `wiztree_diff` case is a real end-to-end run: it spawns the bundled
 * Python, reads the fixture snapshots, and checks the numbers the report states.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { lstat, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { resetPythonCache } from '../lib/python-runtime.js'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURES = join(PACKAGE_ROOT, 'tests', 'fixtures')

// The Desktop host runs the plugin with DSH_HOME set, which is how the bundled
// Python (pandas + numpy) is discovered. Reproduce that here so the test does
// not depend on whatever interpreter happens to be first on PATH.
process.env.DSH_HOME ??= join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')
resetPythonCache()

/**
 * Minimal `ctx.subprocess` implementation over `node:child_process`.
 * @returns {object} The subprocess service surface the plugin uses.
 */
function fakeSubprocess() {
  const readers = new Map()
  return {
    async resolveExecutable(command) {
      if (command.includes('/') || command.includes('\\')) return existsSync(command) ? command : undefined
      const extensions = process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']
      for (const dir of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
        if (dir.length === 0) continue
        for (const extension of extensions) {
          const candidate = join(dir, command + extension)
          if (existsSync(candidate)) return candidate
        }
      }
      return undefined
    },
    spawn(spec) {
      const child = spawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const collected = { stdout: [], stderr: [] }
      child.stdout.on('data', chunk => collected.stdout.push(chunk))
      child.stderr.on('data', chunk => collected.stderr.push(chunk))
      const done = new Promise((resolveDone, rejectDone) => {
        child.on('error', rejectDone)
        child.on('close', (code, signal) => resolveDone({ exitCode: code, signal }))
      })
      const handle = {
        done,
        collected: {
          stdout: { readFrom: () => ({ text: Buffer.concat(collected.stdout).toString('utf8'), nextOffset: 0, lossy: false }) },
          stderr: { readFrom: () => ({ text: Buffer.concat(collected.stderr).toString('utf8'), nextOffset: 0, lossy: false }) },
        },
        terminate: () => child.kill(),
        async waitForExit() {
          await done
          return true
        },
      }
      readers.set(handle, child)
      return handle
    },
  }
}

/**
 * Minimal `ctx.fs` implementation over `node:fs/promises`.
 * @returns {object} The filesystem surface the plugin uses.
 */
function fakeFs() {
  return {
    async resolve(path) {
      return realpathSync(path)
    },
    async stat(path) {
      try {
        const info = await stat(path)
        const raw = await lstat(path)
        return {
          version: `${info.mtimeMs}-${info.size}`,
          type: raw.isDirectory() ? 'directory' : raw.isFile() ? 'file' : 'other',
          size: raw.isFile() ? info.size : undefined,
        }
      } catch {
        return undefined
      }
    },
    processPath(target) {
      return target
    },
    processPathFromHostPath(path) {
      return path
    },
  }
}

/**
 * Build the fake context and mount the plugin.
 * @returns {{ tools: Map<string, object>, routes: Map<string, Function> }} Captured registrations.
 */
async function mountPlugin() {
  const { apply } = await import('../lib/index.js')
  const tools = new Map()
  const routes = new Map()
  const ctx = {
    tools: { register: definition => tools.set(definition.name, definition) },
    subprocess: fakeSubprocess(),
    fs: fakeFs(),
    webServer: {
      register: route => {
        routes.set(route.path, route.handler)
        return () => {}
      },
    },
    effect: callback => {
      callback()
      return () => {}
    },
    logger: { info() {}, warn() {}, error() {} },
  }
  apply(ctx, {})
  return { tools, routes }
}

test('the plugin registers the expected tool catalog', async () => {
  const { tools } = await mountPlugin()
  assert.deepEqual([...tools.keys()].sort(), ['open_path', 'wiztree_diff', 'wiztree_query', 'wiztree_verify_delete'])
  for (const [name, definition] of tools) {
    assert.equal(typeof definition.description, 'string', `${name} has no description`)
    assert.ok(definition.description.length > 80, `${name} description is too thin`)
    assert.equal(typeof definition.execute, 'function', `${name} has no execute`)
    assert.equal(typeof definition.output?.schema?.type, 'string', `${name} has no output schema`)
    assert.equal(typeof definition.output?.render, 'function', `${name} has no render`)
  }
})

test('required parameters are declared and optional ones are not', async () => {
  const { tools } = await mountPlugin()
  assert.deepEqual(Object.keys(tools.get('wiztree_diff').parameters), [
    'old_snapshot', 'new_snapshot', 'output', 'min_mb', 'top', 'depth', 'root', 'subtree', 'dump_csv',
  ])
  assert.equal(tools.get('wiztree_diff').parameters.old_snapshot.required, true)
  assert.equal(tools.get('wiztree_diff').parameters.min_mb.required, undefined)
  assert.equal(tools.get('wiztree_query').parameters.path.required, true)
  assert.equal(tools.get('wiztree_verify_delete').parameters.paths.required, true)
  assert.equal(tools.get('open_path').parameters.path.required, true)
})

test('wiztree_diff runs the analysis end to end and reports the exact deltas', { timeout: 180_000 }, async () => {
  const { tools } = await mountPlugin()
  const out = mkdtempSync(join(tmpdir(), 'wiztree-test-'))
  const result = await tools.get('wiztree_diff').execute({
    old_snapshot: join(FIXTURES, 'WizTree_20261017010000.csv'),
    new_snapshot: join(FIXTURES, 'WizTree_20261017020000.csv'),
    output: join(out, 'report.md'),
    min_mb: 0.0005,
    top: 20,
  }, {})

  assert.equal(result.reportPath, join(out, 'report.md'))
  assert.ok(existsSync(result.reportPath), 'the Markdown report was written')
  assert.ok(result.reportBytes > 500, 'the report has content')

  // Whole-disk deltas from the fixtures: +1,000,000 bytes, +51 files, +0 folders.
  assert.match(result.summary, /\+51/u)
  assert.match(result.summary, /1,000,000/u)
  assert.match(result.summary, /976\.6 KB/u)

  // The grown folder must be located and linked as a bare local path.
  assert.match(result.reportExcerpt, /c:\\users\\asus\\downloads/iu)
  assert.match(result.reportExcerpt, /976\.6 KB/u)
  assert.match(result.reportExcerpt, /自顶向下定位增长点/u)

  // The renderer turns the artifacts into clickable Markdown links whose
  // destination is a bare local path (what the GUI's file link understands).
  const rendered = tools.get('wiztree_diff').output.render({}, result)
  const text = rendered.map(part => part.text).join('\n')
  assert.equal(rendered[0].type, 'text')
  assert.ok(text.includes(`](${result.reportPath})`), 'the report path is rendered as a Markdown destination')
  assert.match(text, /下面是报告开头/u)
})

test('wiztree_query resolves paths against the live filesystem', { timeout: 180_000 }, async () => {
  const { tools } = await mountPlugin()
  const result = await tools.get('wiztree_query').execute({
    snapshot: join(FIXTURES, 'WizTree_20261017020000.csv'),
    path: 'C:\\Users\\ASUS',
    min_mb: 0,
    top: 10,
  }, {})

  assert.equal(result.versions, false)
  assert.ok(result.rows.length > 0)
  const downloads = result.rows.find(row => /downloads/iu.test(row.path))
  assert.ok(downloads !== undefined, 'the Downloads row is present')
  assert.equal(typeof downloads.exists, 'boolean')
  assert.equal(
    downloads.exists,
    existsSync(downloads.path),
    'the exists flag must agree with the filesystem',
  )
  assert.equal(downloads.size, 3000000)

  const text = tools.get('wiztree_query').output.render({}, result).map(part => part.text).join('\n')
  assert.match(text, /下载|Downloads|downloads/u)
})

test('wiztree_verify_delete refuses to invent a verdict for a missing folder', async () => {
  const { tools } = await mountPlugin()
  const missing = join(tmpdir(), 'wiztree-does-not-exist-0000')
  const result = await tools.get('wiztree_verify_delete').execute({ paths: [missing] }, {})
  assert.equal(result.readOnly, true)
  assert.equal(result.results.length, 1)
  assert.equal(result.results[0].exists, false)
  assert.equal(result.results[0].level, 'n/a')
  assert.match(result.summary, /已不存在/u)
})

test('open_path refuses a path that does not exist', async () => {
  const { tools } = await mountPlugin()
  await assert.rejects(
    () => tools.get('open_path').execute({ path: join(tmpdir(), 'wiztree-nope-0000') }, {}),
    /does not exist/u,
  )
})

test('the browser routes reject malformed requests and answer real paths', async () => {
  const { routes } = await mountPlugin()
  assert.deepEqual([...routes.keys()].sort(), ['/wiztree/open', '/wiztree/stat'])

  /**
   * Drive one route with a JSON body.
   * @param {string} route - Route path.
   * @param {object} body - Request body.
   * @param {string} [method] - HTTP method.
   * @returns {Promise<{ status: number, payload: object }>} Captured response.
   */
  async function call(route, body, method = 'POST') {
    const chunks = [Buffer.from(JSON.stringify(body))]
    const request = {
      method,
      headers: { 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield chunk
      },
    }
    let status = 0
    let text = ''
    const response = {
      set statusCode(value) {
        status = value
      },
      get statusCode() {
        return status
      },
      setHeader() {},
      end(payload) {
        text = payload?.toString?.() ?? ''
      },
    }
    await routes.get(route)(request, response)
    return { status, payload: text.length === 0 ? {} : JSON.parse(text) }
  }

  const bad = await call('/wiztree/stat', {})
  assert.equal(bad.status, 400)
  assert.match(bad.payload.error, /path/u)

  const methodNotAllowed = await call('/wiztree/stat', {}, 'GET')
  assert.equal(methodNotAllowed.status, 405)

  const existing = await call('/wiztree/stat', { path: PACKAGE_ROOT })
  assert.equal(existing.status, 200)
  assert.equal(existing.payload.exists, true)
  assert.equal(existing.payload.type, 'directory')

  const absent = await call('/wiztree/open', { path: join(tmpdir(), 'wiztree-nope-0000') })
  assert.equal(absent.status, 404)
  assert.equal(absent.payload.ok, false)
})

test('the synced scripts match the skill copies byte for byte', () => {
  const skillDir = join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '.', '.dsh'), 'skills', 'wiztree-snapshot-diff', 'scripts')
  for (const name of ['wiztree_snapshot_diff.py', 'wiztree_query.py', 'wiztree_verify_delete.py']) {
    let expected
    try {
      expected = readFileSync(join(skillDir, name), 'utf8')
    } catch {
      continue // The skill is not installed on this machine; nothing to compare.
    }
    const actual = readFileSync(join(PACKAGE_ROOT, 'lib', 'scripts', name), 'utf8')
    assert.equal(actual, expected, `${name} drifted from the skill copy; run npm run sync-skill`)
  }
})

test('readdir sanity: the package ships what the manifest lists', async () => {
  const entries = await readdir(join(PACKAGE_ROOT, 'lib'))
  for (const expected of ['index.js', 'client.js', 'install.js', 'paths.js', 'run-python.js', 'python-runtime.js', 'scripts']) {
    assert.ok(entries.includes(expected), `lib/${expected} is missing`)
  }
  assert.ok(existsSync(join(PACKAGE_ROOT, 'cordis.patch.yml')))
  assert.ok(existsSync(join(PACKAGE_ROOT, 'tools', 'build-client.mjs')))
  assert.ok(existsSync(join(PACKAGE_ROOT, 'tools', 'sync-scripts.mjs')))
})
