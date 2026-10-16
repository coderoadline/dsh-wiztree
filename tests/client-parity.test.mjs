/**
 * The browser half re-implements the link-destination grammar (the host half
 * lives in `lib/paths.js`, which a plugin bundle cannot import), so this suite
 * pins the two implementations to the same answers, and checks the generated
 * bundle really is loadable through the shell's module table.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { parseDestination, fileUrlToPath, isAbsolutePath, isFileLinkButton } from '../lib/install.js'
import { parsePathTarget } from '../lib/paths.js'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const CASES = [
  'C:\\Users\\ASUS',
  'C:/Users/ASUS',
  'file:///C:/Users/ASUS/AppData',
  'file:///C:/Program%20Files/Foo%20Bar',
  'C:\\a\\b.md#L24',
  'C:\\a\\b.md#L24-L30',
  'C:\\a\\b.md#L0',
  'https://example.com/a',
  'mailto:a@b.c',
  'dsh-resource://file/session/s/x',
  'AppData\\Roaming',
  'C:/用户/文档',
]

test('host and browser link parsers agree', () => {
  for (const value of CASES) {
    const host = parsePathTarget(value, { cwd: 'C:\\Users\\ASUS' })
    const browser = parseDestination(value, 'C:\\Users\\ASUS')
    if (host === undefined || browser === undefined) {
      assert.equal(host, browser, `disagreement for ${value}`)
      continue
    }
    assert.equal(browser.path, host.path, `path disagreement for ${value}`)
    assert.equal(browser.line, host.line, `line disagreement for ${value}`)
  }
})

test('parseDestination keeps external links out of the host route', () => {
  assert.equal(parseDestination('https://example.com/a', undefined), undefined)
  assert.equal(parseDestination('data:text/plain,hello', undefined), undefined)
  assert.equal(parseDestination('file://server/share/x', undefined).path, '\\\\server\\share\\x')
  assert.equal(parseDestination('', undefined), undefined)
  assert.equal(parseDestination('C:\\a?b=1', undefined), undefined)
})

test('fileUrlToPath only accepts file URLs', () => {
  assert.equal(fileUrlToPath('file:///C:/x'), 'C:\\x')
  assert.equal(fileUrlToPath('https://example.com/x'), '')
  assert.equal(fileUrlToPath('not a url'), '')
  assert.equal(isAbsolutePath('C:\\x'), true)
  assert.equal(isAbsolutePath('https://example.com'), false)
})

test('isFileLinkButton recognises the renderer local-path control', () => {
  assert.equal(isFileLinkButton({ tagName: 'BUTTON', className: 'x1_fileLink_abc y' }), true)
  assert.equal(isFileLinkButton({ tagName: 'BUTTON', className: 'x1_fileMention_abc' }), true)
  assert.equal(isFileLinkButton({ tagName: 'BUTTON', className: 'plain' }), false)
  assert.equal(isFileLinkButton({ tagName: 'A', className: 'x1_fileLink_abc' }), false)
  assert.equal(isFileLinkButton(null), false)
})

test('the generated bundle registers one lazy-CJS factory with the plugin surface', () => {
  const bundle = readFileSync(join(PACKAGE_ROOT, 'lib', 'client.js'), 'utf8')
  const registered = []
  const root = {
    __ModuleLoader__: {
      load(record) {
        registered.push(record)
      },
    },
  }
  // The bundle is an IIFE over globalThis; evaluate it with a stubbed loader.
  const run = new Function('globalThis', bundle)
  run(root)

  assert.equal(registered.length, 1)
  assert.equal(registered[0].id, 'dsh-wiztree')
  const exports = registered[0].factory()
  assert.equal(typeof exports.apply, 'function')
  assert.equal(exports.name, 'dsh-wiztree')
  assert.deepEqual([...exports.inject], [])
})

test('the generated bundle is not stale', () => {
  const result = execFileSync(process.execPath, [join(PACKAGE_ROOT, 'tools', 'build-client.mjs'), '--check'], {
    encoding: 'utf8',
  })
  assert.match(result, /up to date/u)
})
