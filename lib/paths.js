/**
 * Path helpers shared by both halves of `dsh-wiztree`.
 *
 * The browser half deliberately re-implements {@link parsePathTarget} (a plugin
 * bundle cannot import host code), so this module doubles as the reference
 * implementation and the unit under test. Keep the two in sync.
 */

/** Characters that may never appear in a path we hand to the operating system. */
const CONTROL = /[\u0000-\u001f\u007f]/u

/** A Windows drive-absolute path (`C:\...` or `C:/...`). */
const DRIVE = /^[a-zA-Z]:[\\/]/u

/** A UNC share (`\\server\share`). */
const UNC = /^[\\/]{2}[^\\/]/u

/** A POSIX absolute path. */
const POSIX = /^\/(?!\/)/u

/**
 * Whether a string is an absolute local path (drive-absolute, UNC, or POSIX).
 * @param {unknown} value - Candidate string.
 * @returns {boolean} True when the string names an absolute path.
 */
export function isAbsolutePath(value) {
  if (typeof value !== 'string' || value.length === 0) return false
  if (CONTROL.test(value)) return false
  return DRIVE.test(value) || UNC.test(value) || POSIX.test(value)
}

/**
 * Normalize a path for comparison and for handing to the OS: forward slashes
 * become backslashes on Windows-shaped paths and any trailing separator is
 * dropped (except for a bare drive root, which keeps its backslash).
 * @param {string} value - Input path.
 * @returns {string} The normalized path.
 */
export function normalizePath(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim().replace(/^"|"$/gu, '')
  if (trimmed.length === 0) return ''
  const windowsShaped = DRIVE.test(trimmed) || UNC.test(trimmed) || trimmed.includes('\\')
  let out = windowsShaped ? trimmed.replace(/\//gu, '\\') : trimmed
  if (/^[a-zA-Z]:\\?$/u.test(out)) return `${out.slice(0, 2)}\\`
  out = out.replace(/[\\/]+$/u, '')
  if (/^[a-zA-Z]:$/u.test(out)) return `${out}\\`
  return out.length === 0 ? trimmed : out
}

/**
 * Convert an absolute path into a `file:` URL usable in Markdown or in an
 * `<a href>`.
 * @param {string} value - Absolute local path.
 * @returns {string} The equivalent `file:` URL, or an empty string when the input is not an absolute path.
 */
export function pathToFileUrl(value) {
  if (!isAbsolutePath(value)) return ''
  const wantWindows = DRIVE.test(value) || UNC.test(value)
  const normalized = normalizePath(value).replace(/\\/gu, '/')
  const prefixed = wantWindows && !normalized.startsWith('//') ? `/${normalized}` : normalized
  const encoded = prefixed
    .split('/')
    .map(segment => encodeURIComponent(segment).replace(/%3A/giu, ':'))
    .join('/')
  return `file://${encoded}`
}

/**
 * Convert a `file:` URL into a native absolute path.
 * @param {string} value - A `file:` URL (`file:///C:/x`, `file://server/share`).
 * @returns {string} The native path, or an empty string when the input is not a file URL.
 */
export function fileUrlToPath(value) {
  if (typeof value !== 'string') return ''
  let url
  try {
    url = new URL(value)
  } catch {
    return ''
  }
  if (url.protocol !== 'file:') return ''
  let decoded
  try {
    decoded = decodeURIComponent(url.pathname)
  } catch {
    return ''
  }
  if (CONTROL.test(decoded)) return ''
  const host = url.hostname
  if (host !== '') return normalizePath(`//${host}${decoded}`)
  // file:///C:/x -> /C:/x on Windows; keep POSIX paths as authored.
  if (/^\/[a-zA-Z]:[\\/]/u.test(decoded)) return normalizePath(decoded.slice(1))
  return normalizePath(decoded)
}

/**
 * Strip a `#L24` / `#L24-L30` fragment and report the first line it names.
 * Mirrors the renderer's own fragment grammar, which only accepts `L<n>` or
 * `L<n>-L<m>` with `n >= 1`.
 * @param {string} value - Raw link destination, fragment included.
 * @returns {{ target: string, line?: number }} The fragment-free destination and its first line.
 */
export function splitLineFragment(value) {
  const raw = String(value)
  const hash = raw.indexOf('#')
  if (hash < 0) return { target: raw }
  const fragment = raw.slice(hash + 1)
  const match = /^L([1-9]\d*)(?:-L([1-9]\d*))?$/u.exec(fragment)
  if (match === null) return { target: raw }
  const first = Number(match[1])
  const last = match[2] === undefined ? first : Number(match[2])
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last < first) return { target: raw }
  return { target: raw.slice(0, hash), line: first }
}

/**
 * Parse a Markdown link destination the way this plugin wants to read it: a
 * `file:` URL, or a path (absolute, or relative to a supplied working
 * directory), optionally carrying a `#L` line fragment.
 * @param {unknown} value - Raw link destination.
 * @param {{ cwd?: string }} [options] - Base directory for relative paths.
 * @returns {{ path: string, line?: number, wasUrl: boolean } | undefined} The resolved target, or undefined when the destination is not a local path.
 */
export function parsePathTarget(value, options = {}) {
  if (typeof value !== 'string') return undefined
  const raw = value.trim()
  if (raw.length === 0 || CONTROL.test(raw)) return undefined
  const { target, line } = splitLineFragment(raw)
  if (target.length === 0 || target.includes('?') || CONTROL.test(target)) return undefined

  const fromUrl = fileUrlToPath(target)
  if (fromUrl !== '') return { path: fromUrl, ...(line === undefined ? {} : { line }), wasUrl: true }

  let decoded = target
  try {
    decoded = decodeURIComponent(target)
  } catch {
    return undefined
  }
  if (decoded.length === 0 || CONTROL.test(decoded)) return undefined
  // Reject any remaining URL scheme except a Windows drive letter.
  if (/^[a-z][a-z\d+.-]*:/iu.test(decoded) && !DRIVE.test(decoded)) return undefined
  if (UNC.test(decoded)) return { path: normalizePath(decoded), ...(line === undefined ? {} : { line }), wasUrl: false }
  if (isAbsolutePath(decoded)) return { path: normalizePath(decoded), ...(line === undefined ? {} : { line }), wasUrl: false }
  const cwd = typeof options.cwd === 'string' && options.cwd.length > 0 ? options.cwd : undefined
  if (cwd === undefined) return undefined
  return { path: joinPath(cwd, decoded), ...(line === undefined ? {} : { line }), wasUrl: false }
}

/**
 * Join a directory and a relative path with the directory's own separator style.
 * @param {string} directory - Absolute base directory.
 * @param {string} relative - Relative path to append.
 * @returns {string} The joined path.
 */
export function joinPath(directory, relative) {
  const base = normalizePath(directory)
  const tail = relative.replace(/^[\\/]+/u, '')
  if (base.length === 0) return normalizePath(tail)
  const separator = base.includes('\\') || DRIVE.test(base) ? '\\' : '/'
  const head = base.endsWith('\\') || base.endsWith('/') ? base.slice(0, -1) : base
  return `${head}${separator}${tail.replace(/[\\/]+/gu, separator)}`
}

/**
 * The parent directory of a path, or an empty string at a volume root.
 * @param {string} value - Absolute path.
 * @returns {string} The parent directory.
 */
export function parentDirectory(value) {
  const normalized = normalizePath(value)
  if (/^[a-zA-Z]:\\$/u.test(normalized)) return ''
  const cut = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'))
  if (cut <= 0) return ''
  const parent = normalized.slice(0, cut)
  return /^[a-zA-Z]:$/u.test(parent) ? `${parent}\\` : parent
}

/**
 * Render one Markdown link for a path. Kept here so the tool output and the
 * skill's report share one spelling: a plain local path destination (which the
 * GUI turns into a clickable file link), never a `file:` URL.
 * @param {string} path - Absolute path to link.
 * @param {string} [label] - Link text; defaults to the path itself.
 * @returns {string} A Markdown link whose destination is the path.
 */
export function markdownPathLink(path, label) {
  const text = label === undefined || label.length === 0 ? path : label
  // Backslashes survive as-is; spaces and parentheses must be escaped in a
  // bare Markdown destination, so percent-encode the ones that would break it.
  const destination = path.replace(/ /gu, '%20').replace(/\(/gu, '%28').replace(/\)/gu, '%29')
  return `[${text}](${destination})`
}
