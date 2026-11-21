/**
 * Test helper: run tool schemas through the harness's REAL gate.
 *
 * `ctx.tools.register()` calls `assertSupportedJsonSchema()` on the output
 * schema, and that is the only place a plausible-looking schema can be
 * rejected — which is exactly how the plugin once shipped a parameter schema
 * the provider refused with `invalid function call parameters`.
 *
 * The gate is taken from the installed DSH Desktop `app.asar` rather than
 * re-implemented, so the suite asserts against the code that will actually load
 * the plugin. Release 0.2.2 split `dsh-tools` into a re-export plus a hashed
 * chunk, so nothing here hardcodes a file name or a comment marker: the chunk
 * is discovered from the entry's own `import` statements, injected whole, and
 * only its two external imports are substituted.
 *
 * Everything degrades to "unavailable" when the app is not installed or the
 * layout is unrecognised, so the suite still runs without DSH Desktop.
 */

import { closeSync, existsSync, openSync, readSync } from 'node:fs'

/** Candidate app.asar locations, most specific first. */
const ARCHIVE_CANDIDATES = [
  'E:/DeepSeek Harnesee Desktop/resources/app.asar',
  'C:/Program Files/DeepSeek Harness/resources/app.asar',
]

/** Tools package directory inside the archive. */
const TOOLS_DIR = 'dsh/node_modules/@deepseek-ai/dsh-tools/lib'

/** Values bundle that owns `isJsonValue` / `assertNever`. */
const VALUES_ENTRY = 'dsh/node_modules/@deepseek-ai/dsh-util-values/lib/index.js'

/** A relative specifier such as `./shared-abc123.js`. */
const RELATIVE_SPECIFIER = /from\s*["'](\.\/[^"']+)["']/gu

/** Any `import ... from "x";` statement, which a bare function body cannot host. */
const IMPORT_STATEMENT = /^import\s[\s\S]*?from\s*["'][^"']+["'];?[^\S\n]*$/gmu

/** An `export { ... };` statement, likewise invalid inside a function body. */
const EXPORT_STATEMENT = /^export\s*\{[\s\S]*?\};?[^\S\n]*$/gmu

/**
 * Locate the installed app.asar.
 * @returns {string | undefined} Absolute path, or undefined when absent.
 */
export function findArchive() {
  return ARCHIVE_CANDIDATES.find(candidate => existsSync(candidate))
}

/**
 * Read the archive's JSON directory.
 *
 * The pickle's declared header size is not reliable across builders, so the
 * directory is found by brace-matching from its opening `{`.
 * @param {number} descriptor - Open file descriptor.
 * @returns {{ header: object, payloadOffset: number }} Directory and payload start.
 */
function readArchiveHeader(descriptor) {
  const sizeBuffer = Buffer.alloc(16)
  readSync(descriptor, sizeBuffer, 0, 16, 0)
  const declared = sizeBuffer.readUInt32LE(4)
  const text = Buffer.alloc(declared + 16)
  readSync(descriptor, text, 0, declared + 16, 16)
  const source = text.toString('utf8')
  const start = source.indexOf('{')
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) {
        const headerSize = index + 1
        return { header: JSON.parse(source.slice(start, headerSize)), payloadOffset: 16 + Math.ceil(headerSize / 4) * 4 }
      }
    }
  }
  throw new Error('unterminated asar header')
}

/**
 * Read one file out of an asar archive.
 * @param {string} archive - Archive path.
 * @param {string} entry - Inner path using forward slashes.
 * @returns {string | undefined} File text, or undefined when missing.
 */
export function readArchiveFile(archive, entry) {
  const descriptor = openSync(archive, 'r')
  try {
    const { header, payloadOffset } = readArchiveHeader(descriptor)
    let node = header.files
    for (const segment of entry.split('/')) {
      // Directory nodes nest their children under `files`; a leaf carries
      // `offset`/`size` directly.
      const children = node?.files ?? node
      node = children?.[segment]
      if (node === undefined) return undefined
    }
    const offset = Number(node.offset)
    const size = Number(node.size)
    if (!Number.isFinite(offset) || !Number.isFinite(size)) return undefined
    const buffer = Buffer.alloc(size)
    const read = readSync(descriptor, buffer, 0, size, payloadOffset + offset)
    if (read !== size) return undefined
    return buffer.toString('utf8')
  } finally {
    closeSync(descriptor)
  }
}

/**
 * Resolve `./x.js` against a directory inside the archive.
 * @param {string} fromDir - Directory of the importing file.
 * @param {string} specifier - Relative specifier.
 * @returns {string} Inner archive path.
 */
function resolveRelative(fromDir, specifier) {
  const parts = fromDir.split('/')
  for (const segment of specifier.split('/')) {
    if (segment === '.' || segment === '') continue
    if (segment === '..') parts.pop()
    else parts.push(segment)
  }
  return parts.join('/')
}

/**
 * Turn a bundled ESM chunk into a body a `new Function` can host: drop its
 * import/export statements, which only a module may carry.
 * @param {string} source - Chunk text.
 * @returns {string} Evaluable body.
 */
function asFunctionBody(source) {
  return source.replace(IMPORT_STATEMENT, '').replace(EXPORT_STATEMENT, '')
}

/**
 * Locate the chunk that actually defines the gate.
 *
 * Release 0.2.2's `dsh-tools/lib/index.js` is a re-export; the implementation
 * sits in a hash-named sibling reachable from that entry's imports. Discovery
 * keeps working when the hash changes.
 * @param {string} archive - Archive path.
 * @returns {{ toolsBody: string, valuesBody: string } | undefined} Chunk bodies.
 */
function collectBodies(archive) {
  const entry = readArchiveFile(archive, `${TOOLS_DIR}/index.js`)
  const values = readArchiveFile(archive, VALUES_ENTRY)
  if (entry === undefined || values === undefined) return undefined

  const candidates = []
  for (const match of entry.matchAll(RELATIVE_SPECIFIER)) {
    const inner = resolveRelative(TOOLS_DIR, match[1])
    const text = readArchiveFile(archive, inner)
    if (text !== undefined) candidates.push(text)
  }
  // The entry itself may carry the gate (the pre-0.2.2 layout).
  candidates.push(entry)

  const toolsBody = candidates
    .map(asFunctionBody)
    .find(body => /function\s+assertSupportedJsonSchema\s*\(/u.test(body))
  if (toolsBody === undefined) return undefined

  return { toolsBody, valuesBody: asFunctionBody(values) }
}

/** Internal probe used by the tests to explain why the gate is unavailable. */
export function explainUnavailable() {
  const archive = findArchive()
  if (archive === undefined) return 'no app.asar found'
  const bodies = collectBodies(archive)
  if (bodies === undefined) return `the gate chunk was not found under ${TOOLS_DIR}`
  for (const [label, body] of [['checkSchemaNode', bodies.toolsBody], ['JsonSchemaError', bodies.toolsBody], ['isJsonValue', bodies.valuesBody]]) {
    if (!new RegExp(`(?:function|class|var|const|let)\\s+${label}\\b`, 'u').test(body)) return `${label} not found in the shipped chunk`
  }
  return 'ok'
}

/**
 * Extract the shipped `assertSupportedJsonSchema` into a callable.
 * @returns {{ assertSupportedJsonSchema: (schema: object) => void, hasShippedIsJsonValue: boolean } | undefined} The gate, or undefined when unavailable.
 */
export function loadShippedGate() {
  const archive = findArchive()
  if (archive === undefined) return undefined
  const bodies = collectBodies(archive)
  if (bodies === undefined) return undefined

  // The chunk imports exactly two names from other packages; everything else is
  // inlined. Substitute those two and supply the harness's own error base.
  const program = [
    bodies.valuesBody,
    'class HarnessError extends Error {',
    '  constructor(message, code) { super(message); this.code = code; this.name = "HarnessError" }',
    '}',
    bodies.toolsBody,
    'return { assertSupportedJsonSchema, isJsonValue }',
  ].join('\n')

  let gate
  try {
    gate = new Function(program)()
  } catch {
    return undefined
  }
  if (typeof gate?.assertSupportedJsonSchema !== 'function') return undefined
  return {
    assertSupportedJsonSchema: gate.assertSupportedJsonSchema,
    hasShippedIsJsonValue: typeof gate.isJsonValue === 'function',
  }
}
