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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { lstat, readdir, stat } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { resetPythonCache } from '../lib/python-runtime.js'
import { loadShippedGate } from './helpers/shipped-gate.mjs'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURES = join(PACKAGE_ROOT, 'tests', 'fixtures')

// Deliberately do NOT set DSH_HOME here. The host process does not carry it —
// the app exports it to the subprocesses it spawns, not to itself — and faking
// it in the suite is precisely what hid a real bug: discovery consulted the
// bundled runtime only when that variable was set, so the tools fell back to a
// PATH Python without pandas while the bundled one sat right there.
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

test('every output schema passes the harness own JSON Schema gate', async (t) => {
  const gate = loadShippedGate()
  if (gate === undefined) {
    t.skip('DSH Desktop app.asar is not installed on this machine')
    return
  }
  assert.equal(gate.hasShippedIsJsonValue, true, 'the shipped isJsonValue must be extractable')
  const { tools } = await mountPlugin()
  for (const [name, definition] of tools) {
    assert.doesNotThrow(
      () => gate.assertSupportedJsonSchema(definition.output.schema),
      `${name}: output.schema is rejected by ctx.tools.register()`,
    )
  }
})

test('the gate rejects the authoring shorthand it must not be given', async (t) => {
  const gate = loadShippedGate()
  if (gate === undefined) {
    t.skip('DSH Desktop app.asar is not installed on this machine')
    return
  }
  // Regression pin: `required: true` per property is the authoring shorthand
  // defineTool() compiles. ctx.tools.register() takes raw JSON Schema, so that
  // shorthand is rejected there — the exact bug that made the plugin's fiber
  // report 启动失败 while its routes were already mounted.
  assert.throws(
    () => gate.assertSupportedJsonSchema({ type: 'object', properties: { a: { type: 'string', required: true } } }),
    /required is not supported/u,
  )
  assert.doesNotThrow(
    () => gate.assertSupportedJsonSchema({ type: 'object', required: ['a'], properties: { a: { type: 'string' } } }),
  )
})

test('every tool parameter schema is the object-root JSON Schema the provider receives', async (t) => {
  const gate = loadShippedGate()
  const { tools } = await mountPlugin()
  for (const [name, definition] of tools) {
    const parameters = definition.parameters
    assert.equal(parameters.type, 'object', `${name}: parameters must be object-rooted`)
    assert.ok(Array.isArray(parameters.required), `${name}: parameters.required must be an array`)
    assert.equal(typeof parameters.properties, 'object', `${name}: parameters.properties must be an object`)
    for (const key of parameters.required) {
      assert.ok(Object.hasOwn(parameters.properties, key), `${name}: required "${key}" is not declared in properties`)
    }
    // ctx.tools.register() stores `parameters` VERBATIM — it compiles neither
    // form. A per-property `required: true` (the shorthand `defineTool()` turns
    // into a `required` array) therefore reaches the provider as a function
    // definition with no object root, and every request fails with
    // `400 invalid function call parameters` / 工具定义不合规.
    for (const [key, property] of Object.entries(parameters.properties)) {
      assert.ok(!Object.hasOwn(property, 'required'), `${name}: parameters.properties.${key} still carries the authoring shorthand`)
    }
    if (gate !== undefined) {
      assert.doesNotThrow(
        () => gate.assertSupportedJsonSchema(parameters),
        `${name}: parameters is outside the harness JSON Schema subset`,
      )
    }
  }
})

test('the load-time guard rejects the authoring shorthand and accepts JSON Schema', async () => {
  const { assertParameterSchema } = await import('../lib/index.js')
  assert.throws(
    () => assertParameterSchema('t', { a: { type: 'string', required: true } }),
    /parameters\.type must be "object"/u,
  )
  assert.throws(
    () => assertParameterSchema('t', { type: 'object', properties: { a: { type: 'string', required: true } } }),
    /carries "required"/u,
  )
  assert.throws(
    () => assertParameterSchema('t', { type: 'object', properties: {}, required: ['a'] }),
    /not in properties/u,
  )
  assert.doesNotThrow(() => assertParameterSchema('t', {
    type: 'object',
    additionalProperties: false,
    required: ['a'],
    properties: { a: { type: 'string' }, b: { type: 'integer' } },
  }))
})

test('required parameters are declared and optional ones are not', async () => {
  const { tools } = await mountPlugin()
  const requiredOf = name => [...tools.get(name).parameters.required].sort()
  assert.deepEqual(requiredOf('wiztree_diff'), ['new_snapshot', 'old_snapshot'])
  assert.deepEqual(requiredOf('wiztree_query'), ['path', 'snapshot'])
  assert.deepEqual(requiredOf('wiztree_verify_delete'), ['paths'])
  assert.deepEqual(requiredOf('open_path'), ['path'])

  assert.deepEqual(Object.keys(tools.get('wiztree_diff').parameters.properties), [
    'old_snapshot', 'new_snapshot', 'output', 'min_mb', 'top', 'depth', 'root', 'subtree', 'dump_csv',
  ])
  const diff = tools.get('wiztree_diff').parameters.properties
  assert.equal(diff.min_mb.type, 'number')
  assert.equal(diff.top.type, 'integer')
  assert.deepEqual(tools.get('wiztree_verify_delete').parameters.properties.paths.items, { type: 'string' })
  assert.deepEqual(tools.get('open_path').parameters.properties.action.enum, ['reveal', 'open'])
})

test('the bundled interpreter is found even when DSH_HOME is not exported', async () => {
  const { candidates } = await import('../lib/python-runtime.js')
  const savedHome = process.env.DSH_HOME
  const savedProfile = process.env.DSH_PROFILE_DIR
  delete process.env.DSH_HOME
  delete process.env.DSH_PROFILE_DIR
  try {
    const found = candidates(undefined)
    // Invariant: every absolute candidate must really exist. This is what
    // catches a manifest field being mistaken for an interpreter path —
    // runtime.json records `"python": "3.12.14"`, a version, not a path.
    for (const candidate of found) {
      if (/[\\/]/u.test(candidate)) assert.ok(existsSync(candidate), `candidate ${candidate} does not exist`)
    }
    const bundled = found.find(candidate => /dsh-runtimes[\\/]dsh-primary-runtime[\\/]dependencies[\\/]python[\\/]/u.test(candidate))
    if (bundled === undefined) {
      assert.ok(true, 'skipped: this machine carries no bundled DSH runtime')
      return
    }
    assert.ok(existsSync(bundled), `the bundled interpreter ${bundled} should exist`)
  } finally {
    if (savedHome !== undefined) process.env.DSH_HOME = savedHome
    if (savedProfile !== undefined) process.env.DSH_PROFILE_DIR = savedProfile
  }
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

/**
 * Drive one registered web route with a JSON body.
 * @param {Map<string, Function>} routes - Handlers captured by `mountPlugin()`.
 * @param {string} route - Route path.
 * @param {object} body - Request body.
 * @param {string} [method] - HTTP method.
 * @returns {Promise<{ status: number, payload: object }>} Captured response.
 */
async function callRoute(routes, route, body, method = 'POST') {
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

test('the browser routes reject malformed requests and answer real paths', async () => {
  const { routes } = await mountPlugin()
  assert.deepEqual([...routes.keys()].sort(), ['/wiztree/open', '/wiztree/stat', '/wiztree/trash'])

  const bad = await callRoute(routes, '/wiztree/stat', {})
  assert.equal(bad.status, 400)
  assert.match(bad.payload.error, /path/u)

  const methodNotAllowed = await callRoute(routes, '/wiztree/stat', {}, 'GET')
  assert.equal(methodNotAllowed.status, 405)

  const existing = await callRoute(routes, '/wiztree/stat', { path: PACKAGE_ROOT })
  assert.equal(existing.status, 200)
  assert.equal(existing.payload.exists, true)
  assert.equal(existing.payload.type, 'directory')

  const absent = await callRoute(routes, '/wiztree/open', { path: join(tmpdir(), 'wiztree-nope-0000') })
  assert.equal(absent.status, 404)
  assert.equal(absent.payload.ok, false)

  const trashMalformed = await callRoute(routes, '/wiztree/trash', {})
  assert.equal(trashMalformed.status, 400)

  const trashMethod = await callRoute(routes, '/wiztree/trash', {}, 'GET')
  assert.equal(trashMethod.status, 405)

  const trashAbsent = await callRoute(routes, '/wiztree/trash', { path: join(tmpdir(), 'wiztree-nope-0000') })
  assert.equal(trashAbsent.status, 404)

  // The guard must refuse a path a mis-click can never be allowed to move,
  // and it must refuse it before anything touches the filesystem.
  const refused = await callRoute(routes, '/wiztree/trash', { path: 'C:\\' })
  assert.equal(refused.status, 502)
  assert.match(refused.payload.error, /拒绝操作/u)
  assert.ok(existsSync('C:\\'), 'the volume root must survive the refused request')
})

test('a click sends a real folder to the Recycle Bin and leaves it recoverable', { timeout: 180_000 }, async () => {
  const { routes } = await mountPlugin()
  const out = mkdtempSync(join(tmpdir(), 'wiztree-trash-'))
  const doomed = join(out, 'doomed-folder')
  mkdirSync(doomed)
  writeFileSync(join(doomed, 'payload.txt'), 'wiztree recycle test')
  assert.ok(existsSync(doomed))

  const result = await callRoute(routes, '/wiztree/trash', { path: doomed })

  assert.equal(result.status, 200, `recycle failed: ${result.payload.error ?? ''}`)
  assert.equal(result.payload.ok, true)
  assert.equal(result.payload.recycled, true)
  assert.equal(result.payload.type, 'directory')
  // Gone from the filesystem — because it moved, not because it was erased:
  // the Windows Recycle Bin still holds it, and undoing this is a shell action.
  assert.equal(existsSync(doomed), false, 'the folder should have left the filesystem')
})

test('the guard protects the working directory and its ancestors, not its children', async () => {
  const { routes } = await mountPlugin()
  // The plugin captures process.cwd() at load time, which is the package root
  // whenever the suite runs the documented way.
  if (resolve(process.cwd()) !== PACKAGE_ROOT) {
    assert.ok(true, 'skipped: the suite was not run from the package root')
    return
  }

  const self = await callRoute(routes, '/wiztree/trash', { path: PACKAGE_ROOT })
  assert.equal(self.status, 502)
  // Either rule may claim it: whenever the suite runs from the package root,
  // that root is both the plugin's own package and the working directory.
  assert.match(self.payload.error, /own package directory|working directory/u)
  assert.ok(existsSync(PACKAGE_ROOT), 'the package root must survive the refused request')

  const ancestor = await callRoute(routes, '/wiztree/trash', { path: dirname(PACKAGE_ROOT) })
  assert.equal(ancestor.status, 502)
  assert.match(ancestor.payload.error, /parent of the working directory/u)
  assert.ok(existsSync(dirname(PACKAGE_ROOT)), 'the parent must survive the refused request')
})

test("the guard never lets a click recycle the plugin's own source", async () => {
  const { routes } = await mountPlugin()
  for (const relative of ['package.json', join('lib', 'index.js'), join('src', 'client.js')]) {
    const source = join(PACKAGE_ROOT, relative)
    assert.ok(existsSync(source), `${relative} should exist before the attempt`)
    const refused = await callRoute(routes, '/wiztree/trash', { path: source })
    assert.equal(refused.status, 502, `${relative} must be refused`)
    assert.match(refused.payload.error, /own package/u)
    assert.ok(existsSync(source), `${relative} must survive the refused request`)
  }
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
  for (const expected of ['index.js', 'client.js', 'paths.js', 'run-python.js', 'python-runtime.js', 'scripts']) {
    assert.ok(entries.includes(expected), `lib/${expected} is missing`)
  }
  assert.ok(existsSync(join(PACKAGE_ROOT, 'src', 'client.js')), 'the browser half source is missing')
  assert.ok(existsSync(join(PACKAGE_ROOT, 'cordis.patch.yml')))
  assert.ok(existsSync(join(PACKAGE_ROOT, 'tools', 'build-client.mjs')))
  assert.ok(existsSync(join(PACKAGE_ROOT, 'tools', 'sync-scripts.mjs')))
})

test('the harness can resolve the Settings metadata through the exports map', async (t) => {
  const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
  assert.equal(manifest.dsh?.manifestVersion, 1, 'dsh.manifestVersion must declare the format the readers expect')
  assert.equal(manifest.dsh?.client?.platform, 'web', 'dsh.client.platform is required for the browser half')
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')

  // app-boot's readPluginMeta() resolves `<pkg>/locale/en.json`, every other
  // `<pkg>/locale/<lang>.json` beside it, and `<pkg>/package.json` as complete
  // module specifiers through Node's resolver — so the package `exports` map
  // decides whether the Settings row has a title and a description at all. A
  // map that hides the locale files downgrades the row silently, which reads as
  // "broken plugin" while the plugin itself works. Resolve for real here
  // instead of matching key shapes, so any working pattern is accepted.
  const profile = process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'desktop')
  const anchor = join(profile, 'package.json')
  if (!existsSync(anchor)) {
    t.skip(`no DSH profile at ${profile}; install the plugin to exercise resolution`)
    return
  }
  const require = createRequire(anchor)
  for (const spec of ['package.json', 'locale/en.json', 'locale/zh.json']) {
    assert.doesNotThrow(
      () => require.resolve(`dsh-wiztree/${spec}`),
      `the harness cannot resolve dsh-wiztree/${spec} from the profile tree`,
    )
  }
})

test('the plugin presents itself in Settings: relative icon and locale metadata', () => {
  const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
  // The settings list reads these three resources; a bare row with no title,
  // description or icon reads as broken even when the plugin works.
  assert.equal(typeof manifest.icon, 'string', 'package.json must declare an icon')
  assert.equal(
    /^[A-Za-z][A-Za-z\d+.-]*:/u.test(manifest.icon) || manifest.icon.startsWith('/'),
    false,
    'the icon must be a relative file path',
  )
  const iconPath = join(PACKAGE_ROOT, manifest.icon)
  assert.ok(existsSync(iconPath), `${manifest.icon} is missing`)
  assert.ok(statSync(iconPath).size < 256 * 1024, 'the icon must stay under the 256 KiB cap')

  for (const language of ['en', 'zh']) {
    const localePath = join(PACKAGE_ROOT, 'locale', `${language}.json`)
    assert.ok(existsSync(localePath), `locale/${language}.json is missing`)
    const dictionary = JSON.parse(readFileSync(localePath, 'utf8'))
    assert.equal(typeof dictionary.meta?.title, 'string', `${language}: meta.title is required`)
    assert.ok(dictionary.meta.title.length > 0)
    assert.equal(typeof dictionary.meta?.description, 'string', `${language}: meta.description is required`)
    assert.ok(dictionary.meta.description.length > 20)
  }
})
