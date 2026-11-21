import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../service/public/workbench.js', import.meta.url), 'utf8')
const template = readFileSync(new URL('../service/public/index.html', import.meta.url), 'utf8')

test('add-to-chat context is read-only and identifies the owning file', () => {
  const start = source.indexOf('async function sendSelectionToChat')
  const end = source.indexOf('function publishContext', start)
  assert.ok(start >= 0 && end > start)
  const body = source.slice(start, end)
  assert.doesNotMatch(body, /\b(?:save|mutate)\s*\(|\/api\/anchor/)
  assert.match(body, /\/api\/context\?file=\$\{encodeURIComponent\(board.file\)\}/)
  assert.match(body, /publishContext\(packet\)/)
  assert.match(template, /aria-label="将选中元素添加到对话上下文"/)
  assert.match(source, /type: 'html-workbench:context'/)
})
