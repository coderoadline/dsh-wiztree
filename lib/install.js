/**
 * dsh-wiztree — click-to-open implementation (plain ES module).
 *
 * Loaded lazily by `client.js` from the same `/plugins/dsh-wiztree/` directory,
 * after the Cordis client runner has created the plugin. Split out so the pure
 * path helpers can be unit-tested in Node while the DOM wiring stays here.
 */

/** Endpoint the host half serves for "what is this path?" queries. */
const STAT_ROUTE = '/wiztree/stat'

/** Endpoint the host half serves for reveal/open gestures. */
const OPEN_ROUTE = '/wiztree/open'

/** Control characters that may never appear in a path. */
const CONTROL = /[\u0000-\u001f\u007f]/u
const DRIVE = /^[a-zA-Z]:[\\/]/u
const UNC = /^[\\/]{2}[^\\/]/u
const POSIX = /^\/(?!\/)/u
const SCHEME = /^[a-z][a-z\d+.-]*:/iu

/**
 * Whether a string is an absolute local path.
 * @param {unknown} value - Candidate.
 * @returns {boolean} True for a drive-absolute, UNC, or POSIX absolute path.
 */
function isAbsolutePath(value) {
  if (typeof value !== 'string' || value.length === 0 || CONTROL.test(value)) return false
  return DRIVE.test(value) || UNC.test(value) || POSIX.test(value)
}

/**
 * Normalize a Windows-shaped or POSIX path for handing to the host.
 * @param {string} value - Input path.
 * @returns {string} Normalized path.
 */
function normalizePath(value) {
  const trimmed = String(value).trim().replace(/^"|"$/gu, '')
  if (trimmed.length === 0) return ''
  const windowsShaped = DRIVE.test(trimmed) || UNC.test(trimmed) || trimmed.includes('\\')
  let out = windowsShaped ? trimmed.replace(/\//gu, '\\') : trimmed
  if (/^[a-zA-Z]:\\?$/u.test(out)) return `${out.slice(0, 2)}\\`
  out = out.replace(/[\\/]+$/u, '')
  if (/^[a-zA-Z]:$/u.test(out)) return `${out}\\`
  return out.length === 0 ? trimmed : out
}

/**
 * Strip a `#L24` / `#L24-L30` fragment.
 * @param {string} value - Raw destination.
 * @returns {{ target: string, line?: number }} Fragment-free destination.
 */
function splitLineFragment(value) {
  const hash = value.indexOf('#')
  if (hash < 0) return { target: value }
  const fragment = value.slice(hash + 1)
  const match = /^L([1-9]\d*)(?:-L([1-9]\d*))?$/u.exec(fragment)
  if (match === null) return { target: value }
  const first = Number(match[1])
  const last = match[2] === undefined ? first : Number(match[2])
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last < first) return { target: value }
  return { target: value.slice(0, hash), line: first }
}

/**
 * Turn a `file:` URL into a native path.
 * @param {string} value - Candidate URL.
 * @returns {string} Native path, or an empty string.
 */
function fileUrlToPath(value) {
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
  if (url.hostname.length > 0) return normalizePath(`//${url.hostname}${decoded}`)
  if (/^\/[a-zA-Z]:[\\/]/u.test(decoded)) return normalizePath(decoded.slice(1))
  return normalizePath(decoded)
}

/**
 * Parse a link destination into a host path, mirroring the renderer's own
 * local-path grammar (which additionally understands `file:` URLs here).
 * @param {string} value - Raw destination.
 * @param {string | undefined} cwd - Session working directory for relative paths.
 * @returns {{ path: string, line?: number, fromUrl: boolean } | undefined} Parsed target.
 */
export function parseDestination(value, cwd) {
  if (typeof value !== 'string') return undefined
  const raw = value.trim()
  if (raw.length === 0 || CONTROL.test(raw)) return undefined
  const { target, line } = splitLineFragment(raw)
  if (target.length === 0 || target.includes('?') || CONTROL.test(target)) return undefined

  const fromUrl = fileUrlToPath(target)
  if (fromUrl.length > 0) {
    return { path: fromUrl, ...(line === undefined ? {} : { line }), fromUrl: true }
  }

  let decoded = target
  try {
    decoded = decodeURIComponent(target)
  } catch {
    return undefined
  }
  if (decoded.length === 0 || CONTROL.test(decoded)) return undefined
  // Any remaining scheme is an external link, never a path (drive letters aside).
  if (SCHEME.test(decoded) && !DRIVE.test(decoded)) return undefined

  if (isAbsolutePath(decoded)) {
    return { path: normalizePath(decoded), ...(line === undefined ? {} : { line }), fromUrl: false }
  }
  if (typeof cwd === 'string' && cwd.length > 0) {
    const base = normalizePath(cwd)
    const separator = base.includes('\\') || DRIVE.test(base) ? '\\' : '/'
    const tail = decoded.replace(/^[\\/]+/u, '')
    return {
      path: `${base}${separator}${tail.replace(/[\\/]+/gu, separator)}`,
      ...(line === undefined ? {} : { line }),
      fromUrl: false,
    }
  }
  return undefined
}

/**
 * Whether a link destination should be treated as a local path in the first
 * place (used to skip inline-code URLs and any external href quickly).
 * @param {string} value - Raw destination.
 * @returns {boolean} True when a local-path parse should be attempted.
 */
export function looksLocal(value) {
  if (typeof value !== 'string') return false
  const raw = value.trim()
  if (raw.length === 0) return false
  if (/^file:/iu.test(raw)) return true
  if (DRIVE.test(raw) || UNC.test(raw)) return true
  // Bare relative paths carry no scheme; anything with one is external.
  return !SCHEME.test(raw)
}

/**
 * The renderer's local-path control is a `<button>` carrying the CSS-module
 * class `fileMention` / `fileLink`; the class names are hashed but keep both
 * base names as substrings, which is what this matcher relies on.
 * @param {Element} element - Candidate element.
 * @returns {boolean} True for a local-path link control.
 */
function isFileLinkButton(element) {
  if (element.tagName !== 'BUTTON') return false
  const className = typeof element.className === 'string' ? element.className : ''
  return className.includes('fileLink') || className.includes('fileMention')
}

/**
 * Walk up from a click target to the element that owns the gesture.
 *
 * Order matters: an image wins (its lightbox owns the click), then an anchor,
 * then the renderer's local-path button. Anything else is not our gesture.
 * @param {unknown} node - `event.target`.
 * @returns {Element | undefined} The owning element, or undefined.
 */
function gestureElement(node) {
  let element = node instanceof Element ? node : node?.parentElement ?? undefined
  let fileLink
  while (element instanceof Element) {
    if (element.tagName === 'IMG') return undefined
    if (element.tagName === 'A') return element
    if (fileLink === undefined && isFileLinkButton(element)) fileLink = element
    if (element.tagName === 'BUTTON' && !isFileLinkButton(element)) return undefined
    element = element.parentElement ?? undefined
  }
  return fileLink
}

/**
 * Extract the path a clicked element stands for.
 * @param {Element} element - Anchor or button.
 * @param {string | undefined} cwd - Session working directory.
 * @returns {{ path: string, line?: number } | undefined} Target path.
 */
function destinationOf(element, cwd) {
  if (element.tagName === 'A') {
    const href = element.getAttribute('href')
    if (typeof href === 'string' && href.length > 0) {
      const parsed = parseDestination(href, cwd)
      if (parsed !== undefined) return parsed
      return undefined
    }
    // Some controls carry their target in a title only; fall through to text.
  }
  const title = element.getAttribute('title')
  if (typeof title === 'string' && title.length > 0) {
    const parsed = parseDestination(title, cwd)
    if (parsed !== undefined) return parsed
  }
  const text = (element.textContent ?? '').trim()
  if (text.length > 0 && text.length < 512) {
    const parsed = parseDestination(text, cwd)
    if (parsed !== undefined) return parsed
  }
  return undefined
}

/**
 * Choose the session whose working directory should resolve relative paths.
 * @param {object} ctx - Client context.
 * @returns {string | undefined} Working directory.
 */
function sessionCwd(ctx) {
  const sessions = ctx.get?.('sessions')
  const snapshot = sessions?.list?.getSnapshot?.()
  const rows = snapshot?.byId
  if (rows === undefined) return undefined
  const candidates = Object.values(rows)
  const main = candidates.find(row => (row?.retainedBy?.mainView ?? 0) > 0)
  return main?.cwd ?? candidates.find(row => typeof row?.cwd === 'string' && row.cwd.length > 0)?.cwd
}

/**
 * POST one JSON body and return the parsed response (or undefined).
 * @param {string} route - Absolute route path.
 * @param {object} body - JSON body.
 * @returns {Promise<object | undefined>} Parsed response.
 */
async function postJson(route, body) {
  try {
    const response = await fetch(route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const text = await response.text()
    if (text.length === 0) return { ok: response.ok }
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : { ok: response.ok }
  } catch {
    return undefined
  }
}

/**
 * Install the click interceptor.
 * @param {object} ctx - Client root context.
 * @returns {() => void} Disposer removing the listener.
 */
export function createInterceptor(ctx) {
  /** Paths with a gesture in flight, so a double click cannot launch twice. */
  const inFlight = new Set()

  /**
   * Reveal or open one path through the host half.
   * @param {{ path: string, line?: number }} target - Parsed destination.
   * @param {boolean} preferOpen - Whether a file should be opened rather than revealed.
   * @returns {Promise<void>} Resolves once the gesture settled.
   */
  async function act(target, preferOpen) {
    if (inFlight.has(target.path)) return
    inFlight.add(target.path)
    try {
      let action = 'reveal'
      if (preferOpen) {
        const info = await postJson(STAT_ROUTE, { path: target.path })
        if (info !== undefined && info.exists === true && info.type === 'directory') action = 'reveal'
        else action = 'open'
      }
      const outcome = await postJson(OPEN_ROUTE, { path: target.path, action })
      if (outcome === undefined) {
        ctx.logger?.warn?.(`[dsh-wiztree] cannot reach the host route for ${target.path}`)
        return
      }
      if (outcome.ok !== true && typeof outcome.error === 'string') {
        ctx.logger?.warn?.(`[dsh-wiztree] ${outcome.error}`)
      }
    } finally {
      inFlight.delete(target.path)
    }
  }

  /**
   * Capture-phase click handler.
   * @param {MouseEvent} event - Click event.
   * @returns {void}
   */
  function onClick(event) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    if (event.defaultPrevented) return
    const selection = event.view?.getSelection?.() ?? window.getSelection?.()
    if (selection !== null && selection !== undefined && selection.type === 'Range' && String(selection).length > 0) return

    const element = gestureElement(event.target)
    if (element === undefined) return
    // Reference chips own their own preview gesture.
    if (element.getAttribute('data-ref-chip') !== null) return

    const target = destinationOf(element, sessionCwd(ctx))
    if (target === undefined) return

    // Take the gesture over: the renderer's own handler (which would open a
    // read-only preview tab) must not also run.
    event.preventDefault()
    event.stopPropagation()
    void act(target, true)
  }

  document.addEventListener('click', onClick, true)
  return () => document.removeEventListener('click', onClick, true)
}

/**
 * Cordis client plugin body, loaded lazily by `client.js`.
 * @param {object} ctx - Client root context.
 * @returns {() => void} Disposer.
 */
export function install(ctx) {
  const dispose = createInterceptor(ctx)
  ctx.logger?.info?.('[dsh-wiztree] 点击路径即可在资源管理器中打开')
  return dispose
}
