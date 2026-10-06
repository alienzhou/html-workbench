/**
 * Seating contracts for the DSH plugin's client half.
 *
 * The panel has two seats: a native or legacy sidebar tab when available,
 * and the plugin's own floating overlay otherwise. Exactly one is
 * live, and the geometry that belongs to the floating seat — the width it takes
 * out of `#root`, the corner trigger's room in the session header — must never
 * reach the document while the sidebar hosts the panel, because that column's
 * width and chrome belong to the sidebar.
 *
 * These tests drive the real `src/client.js` body against stubs (the body is a
 * browser function, so React, the DOM and the Cordis context are all injected),
 * and read the stylesheet and the registrations the loader would install.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT_BODY = readFileSync(resolve(HERE, '..', 'dsh-plugin', 'src', 'client.js'), 'utf8')

// ── Stubs ────────────────────────────────────────────────────────────────────

/** Just enough React for a body whose components are CALLED, never mounted. */
const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (initial) => ({ current: initial }),
}

/** `<style>` management the plugin performs; `head` owns the live elements. */
const makeDocument = () => {
  const attached = []
  const head = {
    appendChild(node) { node.parentNode = head; attached.push(node) },
    removeChild(node) { node.parentNode = null; const i = attached.indexOf(node); if (i >= 0) attached.splice(i, 1) },
  }
  const document = {
    documentElement: { style: { values: {}, setProperty(k, v) { this.values[k] = v }, removeProperty(k) { delete this.values[k] } } },
    body: { attributes: {}, setAttribute(k, v) { this.attributes[k] = v }, removeAttribute(k) { delete this.attributes[k] } },
    head,
    createElement(tag) {
      return { tag, attributes: {}, textContent: '', parentNode: null, setAttribute(k, v) { this.attributes[k] = v } }
    },
    querySelectorAll: () => attached.slice(),
    getElementById: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  return { document, attached }
}

const makeWindow = () => ({
  localStorage: { getItem: () => null, setItem: () => {} },
  innerWidth: 1600,
  addEventListener: () => {},
  removeEventListener: () => {},
})

const stylesShim = { insert: () => () => {} }

/** The slot registry: records each entry together with its component factory. */
const makeSlots = () => {
  const entries = []
  let pending = null
  return {
    entries,
    inject(key, callback) {
      pending = { key, spec: null, component: null }
      callback()
      entries.push(pending)
      pending = null
      return () => {}
    },
    register(spec, component) {
      pending.spec = spec
      pending.component = component
      return () => {}
    },
  }
}

/**
 * A Cordis context stub. `apply` only ever reads `slots`, registers effects, and
 * asks to be told when `betterSidebar` shows up — the last one is handed back so
 * a test can decide whether that plugin is in the profile.
 */
const makeContext = (slots) => {
  const context = {
    slots,
    injection: null,
    injections: new Map(),
    get: (name) => (name === 'slots' ? slots : undefined),
    effect: (fn) => { fn(); return () => {} },
    inject: (deps, callback) => { context.injection = { deps, callback }; context.injections.set(deps[0], callback); return {} },
    interval: () => () => {},
  }
  return context
}

const loadPlugin = ({ document, window }) => new Function('React', 'styles', 'host', 'window', 'document', CLIENT_BODY)(
  React, stylesShim, { call: () => Promise.resolve({}) }, window, document,
)

/** Load the body with a fresh document and context. */
const mount = () => {
  const { document, attached } = makeDocument()
  const slots = makeSlots()
  const context = makeContext(slots)
  const plugin = loadPlugin({ document, window: makeWindow() })
  plugin.apply(context)
  return {
    plugin,
    slots,
    context,
    /** The plugin's stylesheet, as the document holds it right now. */
    sheet: () => attached.map((node) => node.textContent).join('\n'),
    /** The sidebar plugin, as it looks to a consumer of its service. */
    registerSidebar: () => {
      const registered = []
      const sidebar = { registerTab: (descriptor) => { registered.push(descriptor); return () => {} } }
      context.injection.callback({ betterSidebar: sidebar, effect: (fn) => { fn(); return () => {} } })
      return registered
    },
  }
}

/** Render a component element down to the host element it returns. */
const render = (element) => (element && typeof element.type === 'function' ? render(element.type(element.props)) : element)

/** Every element of a tree, flattened (children may be nulls or nesting arrays). */
const elements = (element) => {
  if (Array.isArray(element)) return element.flatMap(elements)
  if (element === null || element === undefined || typeof element !== 'object') return []
  return [element].concat(elements(element.children))
}

/** Every `className` in the tree, so a seat's chrome can be asserted by name. */
const classes = (element) => elements(element)
  .map((node) => node.props.className)
  .filter((name) => typeof name === 'string')

/** How many elements carry this `aria-label`. */
const labelled = (element, label) => elements(element)
  .filter((node) => node.props['aria-label'] === label).length

// ── Contracts ────────────────────────────────────────────────────────────────

test('the body only needs the slot registry to load', () => {
  const app = mount()
  assert.deepEqual(app.plugin.inject, ['timer'])
  assert.equal(typeof app.plugin.apply, 'function')
})

test('without a sidebar service the panel keeps the floating seat', () => {
  const app = mount()

  assert.deepEqual(app.slots.entries.map((entry) => entry.key), ['shell.overlay', 'shell.overlay'])
  assert.deepEqual([...app.context.injections.keys()], ['sidebarRightTabs', 'betterSidebar'])

  const sheet = app.sheet()
  assert.match(sheet, /html #root\s*\{[^}]*margin-right/)
  assert.match(sheet, /\.hwb-panel\[data-seat="sidebar"\]/)
})

test('the floating seat draws its own chrome and closes itself', () => {
  const app = mount()
  const [panelEntry, triggerEntry] = app.slots.entries

  // The corner trigger is what opens the panel, so the seat is exercised through
  // it rather than through private state.
  const trigger = render(triggerEntry.component())
  assert.equal(trigger.type, 'button')
  assert.ok(classes(trigger).includes('hwb-trigger'))
  trigger.props.onClick()

  const panel = render(panelEntry.component())
  assert.equal(panel.props['data-seat'], 'overlay')
  assert.equal(typeof panel.props.style.width, 'string')
  const names = classes(panel)
  assert.ok(names.includes('hwb-resize'), 'the floating panel is resizable')
  assert.equal(labelled(panel, '关闭面板'), 1, 'the floating panel closes itself')
})

test('dsh-better-sidebar takes the panel over as a tab type', () => {
  const app = mount()
  const registered = app.registerSidebar()

  assert.equal(registered.length, 1)
  const descriptor = registered[0]
  assert.equal(descriptor.id, 'html-workbench')
  assert.equal(descriptor.title, 'HTML Workbench')
  assert.equal(descriptor.single, true)
  assert.equal(typeof descriptor.icon, 'function')
  assert.equal(typeof descriptor.component, 'function')
})

test('the sidebar seat drops the floating seat altogether', () => {
  const app = mount()
  app.registerSidebar()

  const sheet = app.sheet()
  assert.doesNotMatch(sheet, /margin-right/, 'the floating width must not be reserved under the sidebar')
  assert.doesNotMatch(sheet, /\.hwb-resize/, 'the sidebar owns the column width')
  assert.doesNotMatch(sheet, /\.hwb-trigger/, 'the sidebar owns the way in')
  assert.match(sheet, /\.hwb-panel\[data-seat="sidebar"\]/)
})

test('the sidebar seat fills the tab body and leaves closing to the sidebar', () => {
  const app = mount()
  const [descriptor] = app.registerSidebar()

  const panel = render(descriptor.component({ visible: true }))
  assert.equal(panel.props['data-seat'], 'sidebar')
  assert.equal(panel.props.style, undefined)
  const names = classes(panel)
  assert.ok(names.includes('hwb-panel'))
  assert.ok(!names.includes('hwb-resize'), 'the sidebar owns the column width')
  assert.equal(labelled(panel, '关闭面板'), 0, 'the sidebar owns closing')
})

test('the floating seat stays closed until its trigger opens it', () => {
  const app = mount()
  assert.equal(render(app.slots.entries[0].component()), null)
})
