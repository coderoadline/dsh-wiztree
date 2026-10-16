// dsh-wiztree — browser half (client plugin bundle).
//
// Loaded by dsh-client-modules at /plugins/dsh-wiztree/client.js and executed
// through the vendored cordis Loader's lazy-CJS module table
// (window.__ModuleLoader__.load). The factory body is plain CJS with require()
// resolved against the shell's module table — the same shape the shipped ui-*
// bundles emit.
//
// WHAT THIS FIXES
// ---------------
// In the Web GUI a Markdown link written as `[label](file:///C:/some/folder)`
// renders as an inert <a href="file:///…">: the renderer's URL allowlist covers
// only http/https/mailto, and its local-path branch rejects a `file:` scheme
// outright, so a click does nothing — the exact complaint that motivated this
// plugin.
//
// This bundle installs one capture-phase click listener that turns every local
// link in a transcript into a working control:
//
//   * `file:///C:/path`     -> POST /wiztree/open (reveal a folder, open a file)
//   * `C:\path` / `C:/path` -> the same route, including the file-link buttons
//                              the renderer already builds for local paths
//   * relative paths        -> resolved against the session working directory
//
// A directory is revealed in File Explorer; a file is asked about with
// POST /wiztree/stat and then either opened by its associated application or
// revealed, depending on the plugin's `autoOpen` setting. External http(s)
// links and images are never touched, and a click with Ctrl/Cmd/Shift/Alt or a
// non-primary button keeps its ordinary behaviour.

/**
 * Resolve this bundle's own directory so the implementation module can be
 * imported as a plain sibling ES module.
 * @returns {string} Absolute URL of `install.js`, or an empty string.
 */
function installUrl() {
  if (typeof document === 'undefined') return ''
  const current = document.currentScript
  if (current !== null && typeof current?.src === 'string' && current.src.length > 0) {
    return new URL('./install.js', current.src).href
  }
  // Fallback: the loader's own convention for plugin bundles.
  try {
    return new URL('./install.js', window.location.href.replace(/\/+$/u, '') + '/plugins/dsh-wiztree/client.js').href
  } catch {
    return ''
  }
}

export const name = 'dsh-wiztree'
export const inject = []

/**
 * Cordis client plugin entry.
 * @param {object} ctx - Client root context.
 * @returns {void}
 */
export function apply(ctx) {
  const moduleUrl = installUrl()
  if (moduleUrl.length === 0) {
    ctx.logger?.warn?.('[dsh-wiztree] cannot resolve its own bundle URL; click-to-open is disabled')
    return
  }
  const loading = import(/* @vite-ignore */ moduleUrl)
    .then(module => module.install(ctx))
    .catch(error => {
      ctx.logger?.warn?.(`[dsh-wiztree] click-to-open failed to load: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    })
  // Hold the disposer on the context so a plugin reload removes the listener.
  ctx.effect(() => {
    let dispose
    void loading.then(result => {
      dispose = result
    })
    return () => {
      if (typeof dispose === 'function') dispose()
      else void loading.then(result => result?.())
    }
  }, 'dsh-wiztree: click-to-open')
}

/**
 * The loader executes this bundle immediately; the Cordis client runner reads
 * `name` / `inject` / `apply` from the factory's exports.
 */
export default { name, inject, apply }
