/**
 * Test helper: run tool output schemas through the harness's REAL gate.
 *
 * `ctx.tools.register()` calls `assertSupportedJsonSchema()` on the output
 * schema before anything else, and it is the only place that can reject a
 * plausible-looking schema. This module extracts that function — plus the
 * shipped `isJsonValue` its annotation check calls — straight out of the
 * installed DSH Desktop `app.asar`, so the suite asserts against the code that
 * will actually load the plugin rather than a re-implementation.
 *
 * Everything degrades to "unavailable" when the app is not installed, so the
 * suite still runs on a machine without DSH Desktop.
 */

import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs'

/** Candidate app.asar locations, most specific first. */
const ARCHIVE_CANDIDATES = [
  'E:/DeepSeek Harnesee Desktop/resources/app.asar',
  'C:/Program Files/DeepSeek Harness/resources/app.asar',
]

/** Tools bundle that owns the gate. */
const TOOLS_ENTRY = 'dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js'

/** Values bundle that owns `isJsonValue`. */
const VALUES_ENTRY = 'dsh/node_modules/@deepseek-ai/dsh-util-values/lib/index.js'

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
 * directory is found by brace-matching from its opening `{`, exactly as the
 * extraction tooling does.
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

/** Internal probe used by the tests to explain why the gate is unavailable. */
export function explainUnavailable() {
  const archive = findArchive()
  if (archive === undefined) return 'no app.asar found'
  const tools = readArchiveFile(archive, TOOLS_ENTRY)
  if (tools === undefined) return `${TOOLS_ENTRY} not readable`
  const values = readArchiveFile(archive, VALUES_ENTRY)
  if (values === undefined) return `${VALUES_ENTRY} not readable`
  const start = tools.indexOf('var JsonSchemaError = class extends HarnessError')
  const end = tools.indexOf('/** Safely test the lossless JSON boundary')
  if (start < 0 || end <= start) return `gate markers not found (start=${start} end=${end})`
  return 'ok'
}

/**
 * Extract `isJsonValue` from the shipped values bundle.
 * @param {string} source - Bundle text.
 * @returns {((value: unknown) => boolean) | undefined} The function, or undefined.
 */
function extractIsJsonValue(source) {
  const valuesStart = source.indexOf('function isJsonValue(value)')
  const helpersStart = source.indexOf('function walkJsonValue(')
  if (valuesStart < 0 || helpersStart < 0 || valuesStart <= helpersStart) return undefined
  const valuesEnd = source.indexOf('\n}', valuesStart)
  if (valuesEnd < 0) return undefined
  const helpers = source.slice(helpersStart, valuesStart)
  const body = source.slice(valuesStart, valuesEnd + 2)
  try {
    return new Function(`${helpers}\n${body}\nreturn isJsonValue;`)()
  } catch {
    return undefined
  }
}

/**
 * Extract the shipped `assertSupportedJsonSchema` into a callable.
 * @returns {{ assertSupportedJsonSchema: (schema: object) => void, hasShippedIsJsonValue: boolean } | undefined} The gate, or undefined when unavailable.
 */
export function loadShippedGate() {
  const archive = findArchive()
  if (archive === undefined) return undefined
  const tools = readArchiveFile(archive, TOOLS_ENTRY)
  const values = readArchiveFile(archive, VALUES_ENTRY)
  if (tools === undefined || values === undefined) return undefined

  // Locate both ends by content so a bundle re-shuffle cannot silently change
  // the extracted range.
  const start = tools.indexOf('var JsonSchemaError = class extends HarnessError')
  const end = tools.indexOf('/** Safely test the lossless JSON boundary')
  if (start < 0 || end < 0 || end <= start) return undefined
  const block = tools.slice(start, end)

  const factory = new Function(`
    class HarnessError extends Error {
      constructor(message, code) { super(message); this.code = code; }
    }
    let isJsonValue = () => true;
    ${block}
    return {
      setJsonValue: (fn) => { isJsonValue = fn; },
      assertSupportedJsonSchema,
    };
  `)
  const gate = factory()
  const shipped = extractIsJsonValue(values)
  if (shipped !== undefined) gate.setJsonValue(shipped)
  return {
    assertSupportedJsonSchema: gate.assertSupportedJsonSchema,
    hasShippedIsJsonValue: shipped !== undefined,
  }
}
