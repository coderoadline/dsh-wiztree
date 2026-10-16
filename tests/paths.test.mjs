/**
 * Unit tests for the path helpers.
 *
 * `lib/paths.js` is the host-side reference implementation; the browser half
 * re-implements the same grammar in `lib/install.js` (a plugin bundle cannot
 * import host code). The parity block at the end keeps the two honest.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  fileUrlToPath,
  isAbsolutePath,
  joinPath,
  markdownPathLink,
  normalizePath,
  parentDirectory,
  parsePathTarget,
  pathToFileUrl,
  splitLineFragment,
} from '../lib/paths.js'

test('isAbsolutePath accepts the three absolute shapes and rejects schemes', () => {
  assert.equal(isAbsolutePath('C:\\Users\\ASUS'), true)
  assert.equal(isAbsolutePath('c:/Users/ASUS'), true)
  assert.equal(isAbsolutePath('\\\\server\\share'), true)
  assert.equal(isAbsolutePath('/usr/local'), true)
  assert.equal(isAbsolutePath('file:///C:/x'), false)
  assert.equal(isAbsolutePath('https://example.com'), false)
  assert.equal(isAbsolutePath('AppData\\Roaming'), false)
  assert.equal(isAbsolutePath(''), false)
  assert.equal(isAbsolutePath('C:\\bad\u0000name'), false)
})

test('normalizePath unifies separators and drops trailing slashes', () => {
  assert.equal(normalizePath('C:/Users/ASUS/'), 'C:\\Users\\ASUS')
  assert.equal(normalizePath('C:\\'), 'C:\\')
  assert.equal(normalizePath('C:'), 'C:\\')
  assert.equal(normalizePath('  "C:\\Temp"  '), 'C:\\Temp')
  assert.equal(normalizePath('/usr/local/'), '/usr/local')
  assert.equal(normalizePath('\\\\server\\share\\'), '\\\\server\\share')
})

test('pathToFileUrl and fileUrlToPath round-trip, including spaces', () => {
  assert.equal(pathToFileUrl('C:\\Users\\ASUS\\AppData'), 'file:///C:/Users/ASUS/AppData')
  assert.equal(pathToFileUrl('C:\\Program Files\\Foo Bar'), 'file:///C:/Program%20Files/Foo%20Bar')
  assert.equal(fileUrlToPath('file:///C:/Program%20Files/Foo%20Bar'), 'C:\\Program Files\\Foo Bar')
  assert.equal(fileUrlToPath('file:///C:/Users/ASUS/AppData'), 'C:\\Users\\ASUS\\AppData')
  assert.equal(fileUrlToPath('file://server/share/x'), '\\\\server\\share\\x')
  assert.equal(fileUrlToPath('https://example.com'), '')
  assert.equal(pathToFileUrl('AppData\\Roaming'), '')
})

test('pathToFileUrl survives a round trip through the file URL helper', () => {
  for (const path of [
    'C:\\Users\\ASUS\\AppData\\Local\\Temp',
    'C:\\Program Files (x86)\\Microsoft',
    'C:\\用户\\文档\\快照',
    '/usr/local/share/app',
  ]) {
    const url = pathToFileUrl(path)
    assert.notEqual(url, '', `no URL for ${path}`)
    assert.equal(fileUrlToPath(url), normalizePath(path))
  }
})

test('splitLineFragment only understands the renderer fragment grammar', () => {
  assert.deepEqual(splitLineFragment('C:\\a\\b.md#L24'), { target: 'C:\\a\\b.md', line: 24 })
  assert.deepEqual(splitLineFragment('C:\\a\\b.md#L24-L30'), { target: 'C:\\a\\b.md', line: 24 })
  assert.deepEqual(splitLineFragment('C:\\a\\b.md#L0'), { target: 'C:\\a\\b.md#L0' })
  assert.deepEqual(splitLineFragment('C:\\a\\b.md#anchor'), { target: 'C:\\a\\b.md#anchor' })
  assert.deepEqual(splitLineFragment('C:\\a\\b.md#L30-L24'), { target: 'C:\\a\\b.md#L30-L24' })
  assert.deepEqual(splitLineFragment('C:\\a\\b.md'), { target: 'C:\\a\\b.md' })
})

test('parsePathTarget reads absolute paths, file URLs and fragments', () => {
  assert.deepEqual(parsePathTarget('C:\\Users\\ASUS'), { path: 'C:\\Users\\ASUS', wasUrl: false })
  assert.deepEqual(parsePathTarget('C:/Users/ASUS'), { path: 'C:\\Users\\ASUS', wasUrl: false })
  assert.deepEqual(parsePathTarget('file:///C:/Users/ASUS'), { path: 'C:\\Users\\ASUS', wasUrl: true })
  assert.deepEqual(parsePathTarget('C:\\a\\b.md#L24'), { path: 'C:\\a\\b.md', line: 24, wasUrl: false })
  assert.deepEqual(parsePathTarget('file:///C:/Users/ASUS/AppData'), { path: 'C:\\Users\\ASUS\\AppData', wasUrl: true })
})

test('parsePathTarget rejects externals and resolves relatives against cwd', () => {
  assert.equal(parsePathTarget('https://example.com/a'), undefined)
  assert.equal(parsePathTarget('mailto:a@b.c'), undefined)
  assert.equal(parsePathTarget('dsh-resource://file/session/s/x'), undefined)
  assert.equal(parsePathTarget('C:\\a?b=1'), undefined)
  assert.equal(parsePathTarget('AppData\\Roaming'), undefined, 'no cwd means no resolution')
  assert.deepEqual(
    parsePathTarget('AppData\\Roaming', { cwd: 'C:\\Users\\ASUS' }),
    { path: 'C:\\Users\\ASUS\\AppData\\Roaming', wasUrl: false },
  )
  assert.deepEqual(
    parsePathTarget('AppData/Roaming', { cwd: 'C:\\Users\\ASUS\\' }),
    { path: 'C:\\Users\\ASUS\\AppData\\Roaming', wasUrl: false },
  )
})

test('joinPath and parentDirectory agree with the path grammar', () => {
  assert.equal(joinPath('C:\\Users\\ASUS', 'AppData\\Roaming'), 'C:\\Users\\ASUS\\AppData\\Roaming')
  assert.equal(joinPath('C:\\Users\\ASUS\\', '/AppData'), 'C:\\Users\\ASUS\\AppData')
  assert.equal(joinPath('/usr/local', 'share'), '/usr/local/share')
  assert.equal(parentDirectory('C:\\Users\\ASUS'), 'C:\\Users')
  assert.equal(parentDirectory('C:\\Users'), 'C:\\')
  assert.equal(parentDirectory('C:\\'), '')
})

test('markdownPathLink keeps the destination a bare local path', () => {
  assert.equal(markdownPathLink('C:\\Users\\ASUS\\AppData'), '[C:\\Users\\ASUS\\AppData](C:\\Users\\ASUS\\AppData)')
  assert.equal(markdownPathLink('C:\\Program Files\\X', '报告'), '[报告](C:\\Program%20Files\\X)')
  assert.equal(markdownPathLink('C:\\a (b)\\c'), '[C:\\a (b)\\c](C:\\a%20%28b%29\\c)')
})
