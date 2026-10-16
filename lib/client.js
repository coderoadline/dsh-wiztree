// dsh-wiztree — browser half (client plugin bundle). GENERATED FILE.
//
// Source of truth: lib/install.js
// Regenerate with `npm run build:client`. The harness serves this file at
// /plugins/dsh-wiztree/client.js and executes it through the vendored cordis
// Loader's lazy-CJS module table (window.__ModuleLoader__.load).
//
// What it does: one capture-phase click listener turns local links in a
// transcript into File Explorer controls — `file:///C:/...` links (which the
// renderer's URL allowlist drops, leaving an inert href) as well as the bare
// absolute paths the renderer already renders as file-link buttons (which
// would otherwise open a read-only preview tab). A directory is revealed;
// a file is opened by its associated application. External http(s) links,
// images and reference chips are left alone.

(() => {
  const root = typeof globalThis !== "undefined" ? globalThis : undefined;
  if (root === undefined || root.__ModuleLoader__ === undefined || typeof root.__ModuleLoader__.load !== "function") return;
  root.__ModuleLoader__.load({
    id: "dsh-wiztree",
    factory: () => {
      const module = { exports: {} };
      const exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

      /**
       * dsh-wiztree — click-to-open implementation.
       *
       * This is the single source of truth for the browser half. It is plain ESM so
       * the pure helpers can be unit-tested in Node, and
       * `tools/build-client.mjs` wraps it into the CommonJS factory shape the
       * harness client loader serves at `/plugins/dsh-wiztree/client.js` (a bundle
       * cannot import a sibling module: the module system serves only `client.js`).
       *
       * Behaviour: one capture-phase click listener on the document turns local
       * links in a transcript into working File Explorer controls.
       *
       *   * `file:///C:/path`     -> POST /wiztree/open (reveal a folder, open a file)
       *   * `C:\path` / `C:/path` -> the same route, including the file-link buttons
       *                              the renderer already builds for local paths
       *   * relative paths        -> resolved against the session working directory
       *
       * A directory is revealed in File Explorer; a file is asked about with
       * POST /wiztree/stat and then either opened by its associated application or
       * revealed. External http(s) links, images and reference chips are never
       * touched, and a click with Ctrl/Cmd/Shift/Alt or a non-primary button keeps
       * its ordinary behaviour.
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
       * local-path grammar (and additionally understanding `file:` URLs).
       * @param {string} value - Raw destination.
       * @param {string | undefined} cwd - Session working directory for relative paths.
       * @returns {{ path: string, line?: number, fromUrl: boolean } | undefined} Parsed target.
       */
      function parseDestination(value, cwd) {
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
       * The renderer's local-path control is a `<button>` carrying the CSS-module
       * class `fileMention` / `fileLink`; the class names are hashed but keep both
       * base names as substrings, which is what this matcher relies on.
       * @param {unknown} element - Candidate element.
       * @returns {boolean} True for a local-path link control.
       */
      function isFileLinkButton(element) {
        if (element === null || typeof element !== 'object') return false
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
       * @returns {unknown} The owning element, or undefined.
       */
      function gestureElement(node) {
        if (typeof Element === 'undefined') return undefined
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
       * @param {object} element - Anchor or button.
       * @param {string | undefined} cwd - Session working directory.
       * @returns {{ path: string, line?: number } | undefined} Target path.
       */
      function destinationOf(element, cwd) {
        if (element.getAttribute === undefined) return undefined
        if (element.tagName === 'A') {
          const href = element.getAttribute('href')
          if (typeof href === 'string' && href.length > 0) return parseDestination(href, cwd)
          // A few controls carry their target in `title` only; fall through to text.
        }
        const title = element.getAttribute('title')
        if (typeof title === 'string' && title.length > 0) {
          const parsed = parseDestination(title, cwd)
          if (parsed !== undefined) return parsed
        }
        const text = String(element.textContent ?? '').trim()
        if (text.length > 0 && text.length < 512) return parseDestination(text, cwd)
        return undefined
      }

      /**
       * Choose the session whose working directory should resolve relative paths.
       * @param {object} ctx - Client context.
       * @returns {string | undefined} Working directory.
       */
      function sessionCwd(ctx) {
        const sessions = ctx?.get?.('sessions')
        const snapshot = sessions?.list?.getSnapshot?.()
        const rows = snapshot?.byId
        if (rows === undefined || rows === null) return undefined
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
      function createInterceptor(ctx) {
        /** Paths with a gesture in flight, so a double click cannot launch twice. */
        const inFlight = new Set()

        /**
         * Reveal or open one path through the host half.
         * @param {{ path: string }} target - Parsed destination.
         * @returns {Promise<void>} Resolves once the gesture settled.
         */
        async function act(target) {
          if (inFlight.has(target.path)) return
          inFlight.add(target.path)
          try {
            const info = await postJson(STAT_ROUTE, { path: target.path })
            const isDirectory = info !== undefined && info.exists === true && info.type === 'directory'
            const outcome = await postJson(OPEN_ROUTE, {
              path: target.path,
              action: isDirectory ? 'reveal' : 'open',
            })
            if (outcome === undefined) {
              ctx?.logger?.warn?.(`[dsh-wiztree] cannot reach the host route for ${target.path}`)
              return
            }
            if (outcome.ok !== true && typeof outcome.error === 'string') {
              ctx?.logger?.warn?.(`[dsh-wiztree] ${outcome.error}`)
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
          const view = event.view ?? (typeof window !== 'undefined' ? window : undefined)
          const selection = view?.getSelection?.()
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
          void act(target)
        }

        document.addEventListener('click', onClick, true)
        return () => document.removeEventListener('click', onClick, true)
      }

      /** Stable plugin identity for the client roster. */
      const name = 'dsh-wiztree'

      /** No client services are required; routes and sessions are looked up defensively. */
      const inject = []

      /**
       * Cordis client plugin entry point.
       * @param {object} ctx - Client root context.
       * @returns {() => void} Disposer.
       */
      function apply(ctx) {
        const dispose = createInterceptor(ctx)
        ctx?.logger?.info?.('[dsh-wiztree] 点击对话里的路径即可在资源管理器中打开')
        return dispose
      }

      exports.name = name;
      exports.inject = inject;
      exports.apply = apply;
      return module.exports;
    }
  });
})();
