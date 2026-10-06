/** Real React mounts and Cordis disposal: editing state must stay with its tab. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { Context } from '@deepseek-ai/cordis'
import TimerService from '@deepseek-ai/cordis-plugin-timer'

const BODY = readFileSync(new URL('../dsh-plugin/src/client.js', import.meta.url), 'utf8')

function makeDocument() {
  const attached = []
  const properties = {}
  const document = {
    documentElement: { style: { setProperty(k, v) { properties[k] = v }, removeProperty(k) { delete properties[k] } } },
    body: { setAttribute() {}, removeAttribute() {} },
    head: {
      appendChild(node) { node.parentNode = this; attached.push(node) },
      removeChild(node) { attached.splice(attached.indexOf(node), 1); node.parentNode = null },
    },
    createElement() { return { textContent: '', setAttribute() {} } },
    querySelectorAll(selector) { return selector === 'textarea' ? [] : attached.slice() },
    addEventListener() {}, removeEventListener() {}, getElementById() { return null },
  }
  return { document, attached }
}

async function boot(t, onCall, { native = false, legacy = true } = {}) {
  const { document, attached } = makeDocument()
  const window = {
    innerWidth: 1600, localStorage: { getItem() { return null }, setItem() {} },
    addEventListener() {}, removeEventListener() {},
  }
  const slots = {
    entries: [],
    inject(key, callback) { return callback() },
    register(spec, component) {
      const entry = { spec, component }
      this.entries.push(entry)
      return () => { this.entries = this.entries.filter(value => value !== entry) }
    },
  }
  const calls = []
  const host = {
    async call(method, args) {
      calls.push({ method, args })
      const custom = onCall?.(method, args)
      if (custom !== undefined) return custom
      if (method === 'list') return { ok: true, running: true, assets: [] }
      if (method === 'open') return { ok: true, url: 'http://127.0.0.1:4317/editor?file=' + encodeURIComponent(args.file) }
      if (method === 'resolve') return { ok: true, isHtml: true, exists: true }
      return {}
    },
  }
  const plugin = new Function('React', 'styles', 'host', 'window', 'document', BODY)(
    React, { insert() {} }, host, window, document,
  )
  const ctx = new Context()
  const disposeSlots = ctx.provide('slots', slots)
  const timer = ctx.plugin(TimerService)
  await timer.inertia
  const fiber = ctx.plugin(plugin)
  await fiber.inertia
  const registered = new Map()
  const nativeRegistered = new Map()
  const sidebar = {
    registerTab(descriptor) {
      assert.equal(nativeRegistered.size, 0, 'native and legacy kinds must not collide')
      registered.set(descriptor.id, descriptor)
      return () => registered.delete(descriptor.id)
    },
  }
  const nativeSidebar = {
    register(descriptor) {
      assert.equal(registered.size, 0, 'release the legacy kind before native registration')
      nativeRegistered.set(descriptor.id, descriptor)
      return () => nativeRegistered.delete(descriptor.id)
    },
  }
  let disposeNative = native ? ctx.provide('sidebarRightTabs', nativeSidebar) : () => {}
  let disposeSidebar = legacy ? ctx.provide('betterSidebar', sidebar) : () => {}
  await new Promise(setImmediate)
  assert.equal(registered.size + nativeRegistered.size, 1, 'exactly one sidebar implementation is active')
  const renderers = new Set()
  t.after(async () => {
    await act(async () => { for (const renderer of renderers) renderer.unmount() })
    await fiber.dispose()
    await disposeSidebar()
    await disposeNative()
    await timer.dispose()
    await disposeSlots()
  })
  const element = (sessionId, tabId, visible) => {
    if (nativeRegistered.size) {
      const { component } = slots.entries.find(entry => entry.spec.name === 'sidebar.right.pane.tab')
      return React.createElement(component, { sessionId, useTabInfo: () => ({ tab: { id: tabId, visible } }) })
    }
    return React.createElement(registered.get('html-workbench').component, {
      scope: { sessionId }, tab: { id: tabId }, visible,
    })
  }
  return {
    calls, attached, registered, nativeRegistered, slots,
    sheet: () => attached.map(node => node.textContent).join('\n'),
    unload: () => fiber.dispose(),
    async removeSidebar() { await disposeSidebar(); await new Promise(setImmediate) },
    async addSidebar() { disposeSidebar = ctx.provide('betterSidebar', sidebar); await new Promise(setImmediate) },
    async addNative() { disposeNative = ctx.provide('sidebarRightTabs', nativeSidebar); await new Promise(setImmediate) },
    async removeNative() { await disposeNative(); await new Promise(setImmediate) },
    async mount(sessionId, tabId, visible = true) {
      let renderer
      await act(async () => { renderer = TestRenderer.create(element(sessionId, tabId, visible)) })
      renderers.add(renderer)
      return renderer
    },
    async update(renderer, sessionId, tabId, visible) {
      await act(async () => { renderer.update(element(sessionId, tabId, visible)) })
    },
    async unmount(renderer) {
      await act(async () => renderer.unmount())
      renderers.delete(renderer)
    },
  }
}

async function typePath(renderer, value) {
  await act(async () => renderer.root.findByType('input').props.onChange({ target: { value } }))
}

async function openFile(renderer, value) {
  await typePath(renderer, value)
  await act(async () => renderer.root.findByType('input').props.onKeyDown({ key: 'Enter' }))
}

test('another session cannot replace a mounted editor, including while its open is pending', async (t) => {
  let finishB
  const app = await boot(t, (method, args) => method === 'open' && args.file === '/tmp/b.html'
    ? new Promise(resolve => { finishB = resolve })
    : undefined)
  const a = await app.mount('session-a', 'workbench')
  const b = await app.mount('session-b', 'workbench', false)
  await openFile(a, '/tmp/a.html')
  const frameA = a.root.findByType('iframe')
  assert.equal(b.root.findAllByType('iframe').length, 0, 'the second session starts with its own empty editor')
  await app.update(a, 'session-a', 'workbench', false)
  await app.update(b, 'session-b', 'workbench', true)
  await openFile(b, '/tmp/b.html')
  assert.equal(a.root.findByType('iframe'), frameA, 'pending open must not unmount the background editor')
  await act(async () => finishB({ ok: true, url: 'http://127.0.0.1:4317/editor?file=b.html' }))
  assert.equal(a.root.findByType('iframe'), frameA, 'unsaved iframe state survives another session opening a file')
  assert.equal(a.root.findByType('input').props.value, '/tmp/a.html')
  assert.match(b.root.findByType('iframe').props.src, /b\.html/)
  await app.update(a, 'session-a', 'workbench', true)
  assert.equal(a.root.findByType('iframe'), frameA, 'returning to the session keeps the same editor')
})

test('two tabs in one session also own independent editors', async (t) => {
  const app = await boot(t)
  const a = await app.mount('session', 'tab-a')
  const b = await app.mount('session', 'tab-b')
  await openFile(a, '/tmp/a.html')
  const frameA = a.root.findByType('iframe')
  await openFile(b, '/tmp/b.html')
  assert.equal(a.root.findByType('iframe'), frameA)
  assert.notEqual(a.root.findByType('iframe').props.src, b.root.findByType('iframe').props.src)
})

test('closing one tab does not cancel another tab path check', async (t) => {
  const app = await boot(t)
  const a = await app.mount('session-a', 'workbench')
  const b = await app.mount('session-b', 'workbench')
  await typePath(a, '/tmp/a.html')
  await typePath(b, '/tmp/b.html')
  await app.unmount(b)
  await act(async () => delay(350))
  assert.deepEqual(app.calls.filter(call => call.method === 'resolve').map(call => call.args.file), ['/tmp/a.html'])
  assert.equal(a.root.findByProps({ className: 'hwb-state' }).props['data-state'], 'exists')
})

test('an older path response cannot replace the latest path result', async (t) => {
  const pending = new Map()
  const app = await boot(t, (method, args) => method === 'resolve'
    ? new Promise(resolve => pending.set(args.file, resolve))
    : undefined)
  const panel = await app.mount('session', 'workbench')
  await typePath(panel, '/tmp/old.html')
  await act(async () => delay(350))
  await typePath(panel, '/tmp/new.html')
  await act(async () => delay(350))
  await act(async () => pending.get('/tmp/new.html')({ ok: true, isHtml: true, exists: true }))
  await act(async () => pending.get('/tmp/old.html')({ ok: true, isHtml: true, exists: false }))
  assert.equal(panel.root.findByProps({ className: 'hwb-state' }).props['data-state'], 'exists')
})

test('removing only the sidebar restores the floating layout', async (t) => {
  const app = await boot(t)
  assert.doesNotMatch(app.sheet(), /margin-right/)
  await app.removeSidebar()
  assert.match(app.sheet(), /margin-right/)
  assert.equal(app.attached.length, 1)
})

test('unloading the workbench does not reinsert floating styles during nested disposal', async (t) => {
  const app = await boot(t)
  assert.equal(app.attached.length, 1)
  await app.unload()
  assert.equal(app.registered.size, 0)
  assert.equal(app.attached.length, 0, 'nested sidebar disposal must not resurrect the removed stylesheet')
})


test('native sidebar preserves independent editors and requests host retention', async (t) => {
  const app = await boot(t, undefined, { native: true, legacy: false })
  assert.equal(app.nativeRegistered.values().next().value.keepMounted, true)
  const a = await app.mount('session-a', 'tab-a')
  const b = await app.mount('session-b', 'tab-b', false)
  await openFile(a, '/tmp/a.html')
  const frameA = a.root.findByType('iframe')
  await app.update(a, 'session-a', 'tab-a', false)
  await app.update(b, 'session-b', 'tab-b', true)
  await openFile(b, '/tmp/b.html')
  assert.equal(a.root.findByType('iframe'), frameA)
  await app.update(a, 'session-a', 'tab-a', true)
  assert.equal(a.root.findByType('iframe'), frameA)
  assert.equal(a.root.findByType('input').props.value, '/tmp/a.html')
})

test('a late native registry takes over the legacy kind and falls back on removal', async (t) => {
  const app = await boot(t)
  await app.addNative()
  assert.equal(app.registered.size, 0)
  assert.equal(app.nativeRegistered.size, 1)
  assert.doesNotMatch(app.sheet(), /margin-right/)
  await app.removeNative()
  assert.equal(app.registered.size, 1)
  assert.equal(app.nativeRegistered.size, 0)
  assert.equal(app.slots.entries.filter(entry => entry.spec.name === 'sidebar.right.pane.tab').length, 0)
  assert.doesNotMatch(app.sheet(), /margin-right/)
  await app.removeSidebar()
  assert.match(app.sheet(), /margin-right/)
})

test('a late legacy registry cannot duplicate a native tab or survive plugin unload', async (t) => {
  const app = await boot(t, undefined, { native: true, legacy: false })
  await app.addSidebar()
  assert.equal(app.registered.size, 0)
  assert.equal(app.nativeRegistered.size, 1)
  await app.unload()
  assert.equal(app.registered.size, 0)
  assert.equal(app.nativeRegistered.size, 0)
  assert.equal(app.attached.length, 0)
  assert.equal(app.slots.entries.filter(entry => entry.spec.name === 'sidebar.right.pane.tab').length, 0)
})
