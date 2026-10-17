// dsh-wiztree — browser half (client plugin bundle). GENERATED FILE.
//
// Source of truth: src/client.js
// Regenerate with `npm run build:client`. The harness serves this file at
// /plugins/dsh-wiztree/client.js and executes it through the vendored cordis
// Loader's lazy-CJS module table (window.__ModuleLoader__.load).
//
// What it does: one capture-phase click listener on `document` replaces the
// renderer's local-link gesture. The shipped markdown renderer
// (dsh-client-ui-primitives) resolves a local link to
// `<button type="button" class="_fileMention_… _fileLink_…" title="C:\path">`,
// whose React onClick calls the chat owner's `openFile` — i.e. a read-only
// right-sidebar preview. The listener runs on `document` in the capture phase,
// so it settles before React's root-container listener: a plain click moves the
// path to the Recycle Bin (POST /wiztree/trash — never a permanent delete) and
// reports the outcome in a toast, while Ctrl/Cmd+click reveals it in File
// Explorer instead. External http(s) links, images and reference chips are
// untouched.

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
       * dsh-wiztree — click behaviour for local paths in a transcript.
       *
       * This is the single source of truth for the browser half. It is plain ESM so
       * the pure helpers can be unit-tested in Node, and `tools/build-client.mjs`
       * wraps it into the CommonJS factory shape the harness client loader serves at
       * `/plugins/dsh-wiztree/client.js` (a bundle cannot import a sibling module:
       * the module system serves only `client.js`).
       *
       * ## What a click does
       *
       * The shipped markdown renderer resolves a local link to
       * `<button type="button" class="_fileMention_… _fileLink_…" title="C:\path">`,
       * whose React `onClick` would open a read-only preview in the right sidebar.
       * This plugin runs one capture-phase listener on `document`, which settles
       * before React's root-container listener, and replaces that gesture:
       *
       *   * plain click    -> POST /wiztree/trash — the path moves to the Recycle Bin
       *   * Ctrl/Cmd+click -> POST /wiztree/open  — reveal it in File Explorer
       *
       * A directory is the normal case: a WizTree review lists folders, and the one
       * decision it leads to is "this is rubbish". The Recycle Bin keeps that decision
       * recoverable, which is why this plugin has no permanent-delete path at all.
       *
       * External http(s) links, images, reference chips, Shift/Alt-modified clicks,
       * and clicks that end a text selection are never intercepted.
       */

      /** Endpoint the host half serves for "what is this path?" queries. */
      const STAT_ROUTE = '/wiztree/stat'

      /** Endpoint the host half serves for reveal/open gestures. */
      const OPEN_ROUTE = '/wiztree/open'

      /** Endpoint the host half serves for the Recycle Bin gesture. */
      const TRASH_ROUTE = '/wiztree/trash'

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
        const out = windowsShaped ? trimmed.replace(/\//gu, '\\') : trimmed
        if (/^[a-zA-Z]:\\?$/u.test(out)) return `${out.slice(0, 2)}\\`
        const trimmedSeparators = out.replace(/[\\/]+$/u, '')
        if (/^[a-zA-Z]:$/u.test(trimmedSeparators)) return `${trimmedSeparators}\\`
        return trimmedSeparators.length === 0 ? trimmed : trimmedSeparators
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
       * classes `fileMention` / `fileLink`. Those class names are hashed but keep both
       * base names as substrings (`_fileLink_1ypvv_59`), which is what this matcher
       * reads first; a `title` holding an absolute path is the structural fallback, so
       * a change to the hash cannot silently disable the gesture.
       * @param {unknown} element - Candidate element.
       * @returns {boolean} True for a local-path link control.
       */
      function isFileLinkButton(element) {
        if (element === null || typeof element !== 'object') return false
        if (element.tagName !== 'BUTTON') return false
        const className = typeof element.className === 'string' ? element.className : ''
        if (className.includes('fileLink') || className.includes('fileMention')) return true
        const title = typeof element.getAttribute === 'function' ? element.getAttribute('title') : null
        return typeof title === 'string' && isAbsolutePath(title)
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
       * Render one self-contained toast, so a gesture always reports its outcome
       * without depending on another client plugin's UI.
       * @param {string} message - Plain text; never interpreted as markup.
       * @param {'ok' | 'warn' | 'error'} [kind] - Tone.
       * @returns {void}
       */
      function showToast(message, kind = 'ok') {
        if (typeof document === 'undefined') return
        let host = document.querySelector('[data-dsh-wiztree="toasts"]')
        if (host === null) {
          host = document.createElement('div')
          host.setAttribute('data-dsh-wiztree', 'toasts')
          Object.assign(host.style, {
            position: 'fixed',
            right: '18px',
            bottom: '18px',
            zIndex: '2147483000',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            maxWidth: 'min(520px, 46vw)',
            pointerEvents: 'none',
          })
          document.body.append(host)
        }
        const tone = kind === 'error' ? '#ff6b6b' : kind === 'warn' ? '#f0b429' : '#4ade80'
        const card = document.createElement('div')
        card.setAttribute('data-dsh-wiztree', 'toast')
        Object.assign(card.style, {
          pointerEvents: 'auto',
          background: '#1f2023',
          color: '#f2f3f5',
          border: `1px solid ${tone}`,
          borderLeft: `3px solid ${tone}`,
          borderRadius: '10px',
          padding: '10px 12px',
          font: '12.5px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif',
          boxShadow: '0 12px 32px rgba(0, 0, 0, 0.45)',
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
        })
        card.textContent = message
        host.append(card)
        setTimeout(() => card.remove(), kind === 'error' ? 12_000 : 6_000)
      }

      /**
       * Mark a link whose target just left the filesystem, so a repeat click is
       * obviously pointless and the transcript agrees with what happened.
       * @param {unknown} element - The clicked control.
       * @returns {void}
       */
      function markSpent(element) {
        if (element === null || typeof element !== 'object' || element.style === undefined) return
        element.setAttribute('data-dsh-wiztree-recycled', '')
        element.style.textDecoration = 'line-through'
        element.style.opacity = '0.55'
      }

      /**
       * Install the click interceptor.
       * @param {object} ctx - Client root context.
       * @returns {() => void} Disposer removing the listener.
       */
      function createInterceptor(ctx) {
        /** Paths with a gesture in flight, so a double click cannot act twice. */
        const inFlight = new Set()

        /**
         * Settle one gesture through the host half.
         * @param {{ path: string }} target - Parsed destination.
         * @param {{ open: boolean, element: unknown }} options - Gesture shape.
         * @returns {Promise<void>} Resolves once the gesture settled.
         */
        async function act(target, options) {
          if (inFlight.has(target.path)) return
          inFlight.add(target.path)
          const unreachable = '无法连接 dsh-wiztree 的宿主半部分，没有执行任何操作。'
          try {
            if (options.open) {
              const opened = await postJson(OPEN_ROUTE, { path: target.path, action: 'reveal' })
              if (opened === undefined) ctx?.logger?.warn?.(`[dsh-wiztree] ${unreachable} ${target.path}`)
              else if (opened.ok !== true) showToast(opened.error ?? `打开失败：${target.path}`, 'error')
              return
            }

            // The stat decides file vs directory (the Recycle Bin API differs) and
            // whether there is anything left to move.
            const info = await postJson(STAT_ROUTE, { path: target.path })
            if (info === undefined) {
              showToast(unreachable, 'error')
              ctx?.logger?.warn?.(`[dsh-wiztree] ${unreachable} ${target.path}`)
              return
            }
            if (info.exists !== true) {
              markSpent(options.element)
              showToast(`已经不存在了（快照数据可能已过期）：\n${target.path}`, 'warn')
              return
            }

            const outcome = await postJson(TRASH_ROUTE, { path: target.path })
            if (outcome === undefined) {
              showToast(unreachable, 'error')
              return
            }
            if (outcome.ok !== true) {
              showToast(outcome.error ?? `移入回收站失败：${target.path}`, 'error')
              return
            }
            markSpent(options.element)
            const kind = info.type === 'directory' ? '文件夹' : '文件'
            showToast(`${kind}已移入回收站（可在「回收站」里还原）：\n${target.path}`, 'ok')
            ctx?.logger?.info?.(`[dsh-wiztree] recycled ${target.path}`)
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
          if (event.button !== 0 || event.shiftKey || event.altKey) return
          if (event.defaultPrevented) return
          const view = event.view ?? (typeof window !== 'undefined' ? window : undefined)
          const selection = view?.getSelection?.()
          if (selection !== null && selection !== undefined && selection.type === 'Range' && String(selection).length > 0) return

          const element = gestureElement(event.target)
          if (element === undefined) return
          // Reference chips own their own preview gesture.
          if (element.getAttribute('data-ref-chip') !== null) return
          if (element.getAttribute('data-dsh-wiztree-recycled') !== null) return

          const target = destinationOf(element, sessionCwd(ctx))
          if (target === undefined) return

          // Take the gesture over: the renderer's own handler (which would open a
          // read-only preview tab) must not also run.
          event.preventDefault()
          event.stopPropagation()
          void act(target, { open: event.ctrlKey || event.metaKey, element })
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
        // A page-side marker makes "is the browser half actually loaded?" answerable
        // from the console without instrumenting the harness.
        if (typeof window !== 'undefined') {
          window.__DSH_WIZTREE__ = {
            name,
            routes: { stat: STAT_ROUTE, open: OPEN_ROUTE, trash: TRASH_ROUTE },
            installedAt: new Date().toISOString(),
            dispose,
          }
        }
        ctx?.logger?.info?.('[dsh-wiztree] 已就绪：单击路径 → 移入回收站；Ctrl/⌘+单击 → 在资源管理器中打开')
        return dispose
      }

      exports.name = name;
      exports.inject = inject;
      exports.apply = apply;
      return module.exports;
    }
  });
})();
