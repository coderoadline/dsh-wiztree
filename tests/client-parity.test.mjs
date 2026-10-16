/**
 * The browser half re-implements the link-destination grammar (a plugin bundle
 * cannot import host code), so this suite pins the two implementations to the
 * same answers.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseDestination, looksLocal } from '../lib/install.js'
import { parsePathTarget } from '../lib/paths.js'

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

test('looksLocal gates the cheap pre-filter', () => {
  assert.equal(looksLocal('C:\\Users\\ASUS'), true)
  assert.equal(looksLocal('C:/Users/ASUS'), true)
  assert.equal(looksLocal('file:///C:/x'), true)
  assert.equal(looksLocal('AppData\\Roaming'), true)
  assert.equal(looksLocal('https://example.com'), false)
  assert.equal(looksLocal('mailto:a@b.c'), false)
  assert.equal(looksLocal(''), false)
})

test('parseDestination keeps external links out of the host route', () => {
  assert.equal(parseDestination('https://example.com/a', undefined), undefined)
  assert.equal(parseDestination('data:text/plain,hello', undefined), undefined)
  assert.equal(parseDestination('file://server/share/x', undefined).path, '\\\\server\\share\\x')
})
