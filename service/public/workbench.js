'use strict'

const grapesjs = window.grapesjs
const fileInput = document.querySelector('#file-input')
const fileName = document.querySelector('#file-name')
const status = document.querySelector('#status')
const saveButton = document.querySelector('#save-button')
const canvasArea = document.querySelector('.canvas-area')
const canvasStage = document.querySelector('#canvas-stage')
const viewport = document.querySelector('#canvas-viewport')
const fitButton = document.querySelector('#fit-button')
const fileMenuButton = document.querySelector('#file-menu-button')
const filePopover = document.querySelector('#file-popover')
const controlPanel = document.querySelector('#control-panel')
const closePanelButton = document.querySelector('#close-panel-button')
const pinPanelButton = document.querySelector('#pin-panel-button')
const panelTitle = document.querySelector('#panel-title')
const panelButtons = [...document.querySelectorAll('[data-panel]')]
const panelContents = [...document.querySelectorAll('[data-panel-content]')]
const attributesPanel = document.querySelector('#attributes-panel')
const srcInput = document.querySelector('#src-input')
const altInput = document.querySelector('#alt-input')
const hrefInput = document.querySelector('#href-input')
const workbench = document.querySelector('.workbench')
const modeButtons = [...document.querySelectorAll('[data-mode]')]
const previewFrame = document.querySelector('#preview-frame')
const contextToast = document.querySelector('#context-toast')

let editor
let activeFile = ''
let assetBase = ''
let revision = ''
let bodyScripts = []
let sourceCss = ''
let sourceBodyHtml = ''
let sourceIdentityCache = null
let links = []
let headScripts = []
let htmlAttributes = {}
let bodyAttributes = {}
let appliedHtmlAttributes = new Set()
let appliedBodyAttributes = new Set()
let eventSource
let saveTimer
let applyingDocument = false
let dirty = false
let canvasWidth = 768
let fitCanvas = true
let activePanel = ''
let panelPinned = false
let workbenchMode = 'edit'
let contextSending = false
let contextToastTimer

function setStatus(text, state = 'idle') {
  status.querySelector('b').textContent = text
  status.dataset.state = state
  saveButton.disabled = state === 'saving'
}

function api(route) {
  return `${route}?file=${encodeURIComponent(activeFile)}`
}

function requestError(response, message) {
  const id = response.headers.get('X-Workbench-Request-Id')
  return new Error(id ? `${message}（请求编号 ${id}）` : message)
}

// The HTML/JS assets are re-read from disk on every request, but a long-lived
// service keeps running the Python it was started with. So a new frontend can
// meet an old API, whose missing routes answer 501 with an HTML error page.
// Parsing that as JSON reports "Unexpected token '<'" and buries the real cause,
// so name it explicitly instead.
async function readJson(response) {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch (error) {
    if (response.status === 501 || response.status === 404) {
      throw requestError(response, '本地服务是旧版本，缺少该接口。请重启 Workbench 服务后重试。')
    }
    throw requestError(response, `服务返回了非 JSON 响应（HTTP ${response.status}）。`)
  }
}

function setFilePopover(open) {
  filePopover.hidden = !open
  fileMenuButton.setAttribute('aria-expanded', String(open))
}

function setPanelPinned(pinned) {
  panelPinned = pinned
  pinPanelButton.setAttribute('aria-pressed', String(pinned))
  pinPanelButton.setAttribute('aria-label', pinned ? '取消固定面板' : '固定面板')
  pinPanelButton.title = pinned ? '取消固定' : '固定面板'
  document.querySelector('.workbench').classList.toggle('panel-pinned', pinned && !controlPanel.hidden)
  requestAnimationFrame(updateCanvasScale)
}

function closePanel() {
  controlPanel.hidden = true
  activePanel = ''
  panelButtons.forEach((button) => button.classList.remove('active'))
  setPanelPinned(false)
}

function openPanel(name) {
  if (activePanel === name && !controlPanel.hidden) return closePanel()
  activePanel = name
  controlPanel.hidden = false
  panelTitle.textContent = name === 'styles' ? '调整样式' : '添加内容'
  panelButtons.forEach((button) => button.classList.toggle('active', button.dataset.panel === name))
  panelContents.forEach((content) => { content.hidden = content.dataset.panelContent !== name })
  setPanelPinned(name === 'styles')
  requestAnimationFrame(() => {
    updateCanvasScale()
    editor?.refresh()
  })
}

function escapeAttribute(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function serializeAttributes(attributes = {}) {
  return Object.entries(attributes).map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`).join('')
}

function serializeHeadScript(source) {
  return `<script${serializeAttributes(source.attributes)}>${source.content || ''}</script>`
}

function getBodyHtml() {
  // GrapesJS 的 wrapper 组件 tagName 为 'body'，editor.getHtml() 返回
  // <body>...</body>。服务端校验禁止 bodyHtml 包含 html/head/body/script
  // 标签，预览文档也已有 <body> 包装，因此这里取 wrapper 的 innerHTML。
  const wrapper = editor.getWrapper()
  return wrapper.getInnerHTML ? wrapper.getInnerHTML() : editor.getHtml().replace(/^<body\b[^>]*>/i, '').replace(/<\/body>\s*$/i, '')
}

function buildPreviewDocument() {
  const previewBase = new URL(assetBase, location.origin).href
  const stylesheets = links.map((href) => `<link rel="stylesheet" href="${escapeAttribute(href)}">`).join('\n')
  const scripts = headScripts.map(serializeHeadScript).join('\n')
  const overrideCss = editor.getCss()
  const previewHelpers = `<script>
document.addEventListener('click', function (event) {
  const link = event.target.closest && event.target.closest('a[href^="#"]')
  if (!link) return
  const fragment = link.getAttribute('href').slice(1)
  if (!fragment) return
  const target = document.getElementById(decodeURIComponent(fragment))
  if (!target) return
  event.preventDefault()
  target.scrollIntoView()
}, false)
</script>`
  return `<!doctype html>
<html${serializeAttributes(htmlAttributes)}>
<head>
  <meta charset="utf-8">
  <base href="${escapeAttribute(previewBase)}">
  ${stylesheets}
  <style>${sourceCss}</style>
  <style data-grapesjs-overrides>${overrideCss}</style>
  ${scripts}
</head>
<body${serializeAttributes(bodyAttributes)}>
${getBodyHtml()}
${bodyScripts.join('\n')}
${previewHelpers}
</body>
</html>`
}

function stateSelectorFor(element) {
  const id = element.getAttribute('id')
  if (id) return `#${CSS.escape(id)}`
  const workbenchId = element.getAttribute('data-wb-id')
  if (workbenchId) return `[data-wb-id="${CSS.escape(workbenchId)}"]`
  const mode = element.getAttribute('data-mode')
  if (mode) return `[data-mode="${CSS.escape(mode)}"]`
  return null
}

function syncPreviewStateToEditor() {
  const previewDocument = previewFrame.contentDocument
  const editDocument = editor?.Canvas.getDocument()
  if (!previewDocument || !editDocument) return

  // Preview contains runtime DOM while Edit is GrapesJS's source model. Only
  // copy a narrow, semantic state allowlist for elements with stable identity;
  // arbitrary runtime styles, animations and framework DOM must not leak into
  // the editable source on every mode switch.
  const stateAttributes = ['class', 'hidden', 'aria-selected', 'aria-expanded', 'aria-hidden']
  previewDocument.querySelectorAll('[id], [data-wb-id], [data-mode]').forEach((previewElement) => {
    const selector = stateSelectorFor(previewElement)
    if (!selector) return
    const editElement = editDocument.querySelector(selector)
    const component = componentFromCanvasElement(editElement)
    if (!component) return

    const attributes = { ...component.getAttributes() }
    for (const attribute of stateAttributes) {
      if (previewElement.hasAttribute(attribute)) {
        attributes[attribute] = previewElement.getAttribute(attribute) || ''
      } else {
        delete attributes[attribute]
      }
    }
    component.setAttributes(attributes)
  })
}

function setWorkbenchMode(nextMode) {
  if (!editor || nextMode === workbenchMode || !['edit', 'preview'].includes(nextMode)) return
  workbenchMode = nextMode
  const previewing = workbenchMode === 'preview'
  workbench.dataset.mode = workbenchMode
  modeButtons.forEach((button) => {
    const active = button.dataset.mode === workbenchMode
    button.classList.toggle('active', active)
    button.setAttribute('aria-pressed', String(active))
  })
  if (previewing) {
    closePanel()
    setFilePopover(false)
    editor.select(null)
    previewFrame.srcdoc = buildPreviewDocument()
    previewFrame.hidden = false
  } else {
    syncPreviewStateToEditor()
    previewFrame.hidden = true
    previewFrame.srcdoc = ''
  }
  requestAnimationFrame(() => {
    updateCanvasScale()
    editor.refresh()
  })
}

function updateCanvasScale() {
  if (!canvasArea || !viewport) return
  const styles = getComputedStyle(canvasArea)
  const availableWidth = canvasArea.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight)
  const availableHeight = canvasArea.clientHeight - parseFloat(styles.paddingTop) - parseFloat(styles.paddingBottom)
  const scale = fitCanvas ? Math.min(1, availableWidth / canvasWidth) : 1
  viewport.style.width = `${canvasWidth}px`
  viewport.style.height = `${Math.max(320, availableHeight / scale)}px`
  viewport.style.zoom = String(scale)
  viewport.dataset.scale = scale.toFixed(3)
  canvasStage.style.minHeight = `${Math.max(320, availableHeight)}px`
  requestAnimationFrame(() => editor?.refresh())
}

function applySourceAttributes(element, attributes, appliedNames) {
  for (const name of appliedNames) element.removeAttribute(name)
  const nextNames = new Set()
  for (const [name, value] of Object.entries(attributes || {})) {
    element.setAttribute(name, value)
    nextNames.add(name)
  }
  return nextNames
}

function componentFromCanvasElement(element) {
  const node = element?.closest?.('[data-gjs-type][id]')
  if (!node) return null
  return editor.getWrapper().find(`#${node.id}`)[0] || null
}

async function injectSourceAssets() {
  const document = editor?.Canvas.getDocument()
  if (!document) return
  document.querySelectorAll('[data-source-asset]').forEach((node) => node.remove())
  appliedHtmlAttributes = applySourceAttributes(document.documentElement, htmlAttributes, appliedHtmlAttributes)
  appliedBodyAttributes = applySourceAttributes(document.body, bodyAttributes, appliedBodyAttributes)
  const base = document.createElement('base')
  base.href = new URL(assetBase, location.origin).href
  base.dataset.sourceAsset = 'true'
  document.head.prepend(base)

  for (const source of headScripts) {
    const script = document.createElement('script')
    for (const [name, value] of Object.entries(source.attributes || {})) script.setAttribute(name, value)
    script.dataset.sourceAsset = 'true'
    if (!script.src) {
      script.textContent = source.content || ''
      document.head.append(script)
      continue
    }
    await new Promise((resolve) => {
      script.addEventListener('load', resolve, { once: true })
      script.addEventListener('error', resolve, { once: true })
      document.head.append(script)
    })
  }
  for (const href of links) {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = href
    link.dataset.sourceAsset = 'true'
    document.head.append(link)
  }
  const style = document.createElement('style')
  style.dataset.sourceAsset = 'true'
  style.textContent = sourceCss
  document.head.append(style)
  const interactionStyle = document.createElement('style')
  interactionStyle.dataset.sourceAsset = 'true'
  interactionStyle.textContent = '[data-gjs-type="default"]:empty{pointer-events:none!important}'
  document.head.append(interactionStyle)

  const contextStyle = document.createElement('style')
  contextStyle.dataset.sourceAsset = 'true'
  contextStyle.textContent = CONTEXT_CANVAS_CSS
  document.head.append(contextStyle)

  if (!document.documentElement.dataset.workbenchInteractionBound) {
    document.documentElement.dataset.workbenchInteractionBound = 'true'
    document.addEventListener('click', (event) => {
      if (workbenchMode !== 'edit') return
      const component = componentFromCanvasElement(event.target)
      if (component) editor.select(component)
    }, true)
    document.addEventListener('dblclick', (event) => {
      if (workbenchMode !== 'edit') return
      const component = componentFromCanvasElement(event.target)
      if (!component) return
      editor.select(component)
      if (component.get('editable')) component.trigger('active', event)
    }, true)
  }

}

// ── Visual selection context ────────────────────────────────────────────────
//
// The agent cannot see the page, so a selection is only useful if it can be
// turned into coordinates in the file on disk. This half of the feature does
// exactly one job: describe WHICH node the user picked, in terms the server can
// re-resolve against the source. It deliberately does not try to locate source
// offsets itself — the canvas DOM is GrapesJS's runtime model, not the file.
//
// The descriptor's `path` is the load-bearing part, because most elements have
// no id. It MUST be numbered the same way the server numbers
// `structural_children`: element children only, with `<script>` excluded. The
// server strips body scripts before GrapesJS ever sees the document, so
// counting them here would shift every index after an inline script and the
// selection would silently land on its neighbour.

// The entry point is GrapesJS's own element toolbar: selecting an element in the
// canvas already shows move/copy/delete, so "add to chat" belongs right there
// rather than behind a separate mode the user has to remember to turn on.

const CONTEXT_CANVAS_CSS = `
[data-wb-context-sent] {
  animation: wb-context-flash 900ms ease-out;
}
@keyframes wb-context-flash {
  from { box-shadow: 0 0 0 3px rgba(47, 77, 196, .55); }
  to { box-shadow: 0 0 0 3px rgba(47, 77, 196, 0); }
}
`

// Mirrors the server's `structural_children`: element children with `<script>`
// excluded, because `parse_source` strips body scripts before GrapesJS ever sees
// the document. Counting them would shift every index after an inline script.
function structuralComponents(parent) {
  const children = parent.components?.()
  if (!children) return null
  return children.filter((child) => child.get('tagName') !== 'script' && child.get('type') !== 'script')
}

// The path is computed over GrapesJS's COMPONENT tree, not the canvas DOM.
// GrapesJS injects its own nodes as siblings of the user's content — a `<style>`
// element plus `div.gjs-css-rules` and `div.gjs-js-cont` helpers — so walking the
// live DOM yields `[1, 0, 1]` where the source body only knows `[0, 1]`, and the
// server then resolves a different element or none at all. The component tree
// contains exactly the document that was loaded from disk, so it lines up with
// the server's `structural_children` numbering.
function contextPathFor(element) {
  const wrapper = editor?.getWrapper()
  let component = componentFromCanvasElement(element)
  if (!wrapper || !component) return null
  const path = []
  while (component !== wrapper) {
    const parent = component.parent?.()
    if (!parent) return null
    const structural = structuralComponents(parent)
    if (!structural) return null
    const index = structural.indexOf(component)
    if (index < 0) return null
    path.push(index)
    component = parent
  }
  return path.reverse()
}

// Mirrors the server's IDENTITY_ATTRIBUTES ordering: our own `data-wb-id` is
// preferred because it is readable, whereas a page `id` may be a random token.
const GRAPESJS_ID_PATTERN = /^i[a-z0-9]{4,6}$/

function identityFor(element) {
  for (const name of ['data-wb-id', 'id', 'data-mode']) {
    const value = element.getAttribute(name)
    if (!value) continue
    if (name === 'id') {
      // GrapesJS mints `id` attributes for its own style rules. Those ids do not
      // exist in the source file, so trusting one would make the server look for
      // a node that is not there. Only accept an id the source actually has —
      // and skip the generated-looking ones even then, because an earlier bug may
      // have persisted one and it would make a useless anchor label.
      if (!sourceHasIdentity(name, value)) continue
      if (GRAPESJS_ID_PATTERN.test(value)) continue
    }
    return { name, value }
  }
  return null
}

// GrapesJS-generated ids are absent from the document we loaded from disk, so
// compare against the source body we were given rather than the live canvas.
function sourceHasIdentity(name, value) {
  if (!sourceIdentityCache) {
    const holder = document.implementation.createHTMLDocument('source')
    holder.body.innerHTML = sourceBodyHtml
    sourceIdentityCache = new Set()
    holder.body.querySelectorAll('[id], [data-wb-id], [data-mode]').forEach((node) => {
      for (const attribute of ['id', 'data-wb-id', 'data-mode']) {
        const found = node.getAttribute(attribute)
        if (found) sourceIdentityCache.add(`${attribute}=${found}`)
      }
    })
  }
  return sourceIdentityCache.has(`${name}=${value}`)
}

function describeSelection(element) {
  const path = contextPathFor(element)
  if (!path) return null
  const label = element.getAttribute('data-wb-id')
    || element.getAttribute('id')
    || [...element.classList].slice(0, 2).map((item) => `.${item}`).join('')
    || element.tagName.toLowerCase()
  return {
    key: path.join('-'),
    tag: element.tagName.toLowerCase(),
    path,
    identity: identityFor(element),
    textHint: (element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    label,
    element,
  }
}

function showContextToast(message, state = 'info') {
  contextToast.hidden = false
  contextToast.dataset.state = state
  contextToast.textContent = message
  clearTimeout(contextToastTimer)
  contextToastTimer = setTimeout(() => { contextToast.hidden = true }, state === 'error' ? 6000 : 2600)
}

function flashContextElement(element) {
  if (!element?.isConnected) return
  element.removeAttribute('data-wb-context-sent')
  // Force a reflow so re-adding the attribute restarts the animation even when
  // the same element is sent twice in a row.
  void element.offsetWidth
  element.setAttribute('data-wb-context-sent', '')
  setTimeout(() => element.removeAttribute('data-wb-context-sent'), 1000)
}

// Adds the currently selected element to the chat. One element per click keeps
// the mental model simple: the toolbar acts on exactly what the user just
// clicked, and the accumulating list lives in the composer where they can see
// and remove entries.
async function sendSelectionToChat(element) {
  if (contextSending) return
  const described = describeSelection(element)
  if (!described) return showContextToast('该元素无法定位，请选择它的父级区域。', 'error')

  contextSending = true
  setStatus('正在生成上下文', 'saving')
  try {
    // Adding visual context must be read-only. A structural path plus the
    // verbatim source snippet is already sufficient evidence for the agent;
    // trying to mint `data-wb-id` here turns an otherwise harmless toolbar click
    // into a disk write, which fails for a valid file opened outside DSH's
    // workspace-write sandbox. Durable identities remain an optional future
    // save-time enhancement — never a prerequisite for putting context in chat.
    const selection = {
      tag: described.tag,
      path: described.path,
      identity: described.identity,
      textHint: described.textHint,
    }

    const response = await fetch(api('/api/context'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selections: [selection] }),
    })
    const packet = await readJson(response)
    if (!response.ok) throw requestError(response, packet.message || packet.error)
    publishContext(packet)
    flashContextElement(element)
    showContextToast(`已添加 ${packet.selections[0]?.selector || described.label} 到对话`)
    setStatus('已添加到对话上下文', 'saved')
  } catch (error) {
    console.error('[html-workbench] context failed', error)
    showContextToast(error.message || '生成上下文失败，请重新选择。', 'error')
    setStatus('添加到对话失败', 'error')
  } finally {
    contextSending = false
  }
}

// The workbench runs inside an iframe in the DSH panel. Hand the packet to the
// host when there is one; fall back to the clipboard for a standalone browser.
function publishContext(packet) {
  const first = packet.selections[0] || {}
  const message = {
    type: 'html-workbench:context',
    filePath: packet.filePath,
    fileName: packet.fileName,
    revision: packet.revision,
    // A stable key lets the host de-duplicate: clicking the same element twice
    // should not stack two identical chips in the composer.
    key: first.identity ? `${first.identity.name}=${first.identity.value}` : `path:${(first.path || []).join('-')}`,
    label: first.selector || first.tag || 'element',
    textHint: first.text || '',
    markdown: packet.markdown,
  }
  if (window.parent !== window) {
    window.parent.postMessage(message, '*')
    return
  }
  navigator.clipboard?.writeText(packet.markdown).catch(() => {})
}

function initEditor() {
  editor = grapesjs.init({
    container: '#gjs',
    height: '100%',
    width: 'auto',
    storageManager: false,
    jsInHtml: false,
    panels: { defaults: [] },
    blockManager: {
      appendTo: '#blocks-panel',
      blocks: [
        { id: 'text', label: '文本', category: '基础', content: '<p data-gjs-type="text">双击编辑这段文字</p>' },
        { id: 'section', label: '区块', category: '基础', content: '<section style="padding:32px"><h2>新章节</h2><p>在这里补充内容。</p></section>' },
        { id: 'image', label: '图片', category: '基础', content: { type: 'image' }, select: true, activate: true },
      ],
    },
    styleManager: {
      appendTo: '#styles-panel',
      sectors: [
        { name: '排版', open: true, properties: ['font-family', 'font-size', 'font-weight', 'color', 'line-height', 'letter-spacing', 'text-align'] },
        { name: '空间', open: false, properties: ['margin', 'padding'] },
        { name: '尺寸', open: false, properties: ['width', 'height', 'max-width', 'min-height'] },
        { name: '外观', open: false, properties: ['background-color', 'border', 'border-radius', 'opacity'] },
        { name: '布局', open: false, properties: ['display', 'flex-direction', 'justify-content', 'align-items', 'gap'] },
      ],
    },
    selectorManager: { componentFirst: true },
    canvas: { frameStyle: 'html{background:#f4f4f5}body{min-height:100vh}' },
  })
  window.__GRAPESJS_WORKBENCH__ = { editor }
  editor.Commands.add(CONTEXT_TOOLBAR_COMMAND, {
    run(instance, sender, options = {}) {
      const component = options.component || instance.getSelected()
      const element = component?.getEl?.()
      if (element) void sendSelectionToChat(element)
    },
  })
  editor.on('load', () => void injectSourceAssets())
  editor.on('update', scheduleSave)
  // GrapesJS 的 RTE 文本编辑走 storeData → sync:content（noCount:true）路径，
  // 不触发 editor 的 'update' 事件（changesCount 不增加）。但组件模型的
  // Backbone change 事件不受 noCount 影响，会转发为 component:update，
  // 因此补充监听该事件以覆盖文本内容编辑场景。
  editor.on('component:update', scheduleSaveForContentChange)
  editor.on('component:selected', updateAttributePanel)
  editor.on('component:selected', addContextToolbarItem)
}

// GrapesJS builds a component's toolbar lazily on first selection, so extend it
// here rather than at init: the array already holds move/copy/delete and we only
// prepend one item. Guarded by a marker command name so re-selecting the same
// component never stacks duplicates.
const CONTEXT_TOOLBAR_COMMAND = 'wb-context-add'

function addContextToolbarItem(component) {
  if (!component || typeof component.get !== 'function') return
  const toolbar = component.get('toolbar')
  if (!Array.isArray(toolbar)) return
  if (toolbar.some((item) => item.command === CONTEXT_TOOLBAR_COMMAND)) return
  // `silent` matters: a normal `set` emits `component:update`, which is wired to
  // `scheduleSave`. Without it, merely SELECTING an element would mark the
  // document dirty and write GrapesJS's own minted attributes (e.g. `id="iftsf"`,
  // created for its style rules) into the user's source file.
  component.set('toolbar', [{
    id: CONTEXT_TOOLBAR_COMMAND,
    command: CONTEXT_TOOLBAR_COMMAND,
    attributes: { title: '添加到对话上下文', 'aria-label': '将选中元素添加到对话上下文' },
    // A speech bubble reads as “conversation” at toolbar size; the small plus
    // distinguishes “add this selection to chat” from a generic comment action.
    label: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px"><path d="M20 11.3a7.2 7.2 0 0 1-7.5 7.2 8.2 8.2 0 0 1-3.3-.7L4 20l1.8-4.3A6.8 6.8 0 0 1 5 12a7.2 7.2 0 0 1 7.5-7.2 7.2 7.2 0 0 1 7.5 6.5Z"/><path d="M15.8 7.4v4.2M13.7 9.5h4.2"/></svg>',
  }, ...toolbar], { silent: true })
}

function updateAttributePanel(component) {
  const tag = component?.get('tagName')
  const attributes = component?.getAttributes?.() || {}
  const image = tag === 'img'
  const link = tag === 'a'
  attributesPanel.hidden = !image && !link
  srcInput.parentElement.hidden = !image
  altInput.parentElement.hidden = !image
  hrefInput.parentElement.hidden = !link
  srcInput.value = attributes.src || ''
  altInput.value = attributes.alt || ''
  hrefInput.value = attributes.href || ''
}

// Editor-state properties that GrapesJS stores on the component model but which
// say nothing about the document: `open` is the layer tree's expand state,
// `toolbar`/`status`/`selected` are selection chrome. They fire the same
// `component:update` event as a real content edit, and letting them reach
// autosave means merely CLICKING an element rewrites the user's file — which is
// how GrapesJS's internally-minted `id="i4nxl"` style-rule attributes ended up
// persisted in the source.
const NON_CONTENT_PROPERTIES = new Set(['open', 'status', 'toolbar', 'selected', 'hovered', 'highlightable', 'draggable'])

function scheduleSaveForContentChange(component) {
  const changed = Object.keys(component?.changed || {})
  // An empty `changed` is a bulk/unknown update; be conservative and save.
  if (changed.length && changed.every((key) => NON_CONTENT_PROPERTIES.has(key))) return
  scheduleSave()
}

function scheduleSave() {
  if (applyingDocument || workbenchMode !== 'edit' || !activeFile) return
  dirty = true
  setStatus('等待自动保存', 'dirty')
  clearTimeout(saveTimer)
  saveTimer = setTimeout(save, 500)
}

async function save() {
  if (!editor || !activeFile || !revision || !dirty) return
  clearTimeout(saveTimer)
  setStatus('正在写入磁盘', 'saving')
  try {
    const response = await fetch(api('/api/document'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseRevision: revision,
        bodyHtml: getBodyHtml(),
        css: editor.getCss(),
        bodyScripts,
      }),
    })
    const result = await readJson(response)
    if (response.status === 409) {
      setStatus('磁盘有更新，已停止覆盖', 'conflict')
      dirty = false
      await applyDocument(result.document)
      return
    }
    if (!response.ok) throw requestError(response, result.message || result.error)
    revision = result.revision
    bodyScripts = result.bodyScripts || bodyScripts
    dirty = false
    setStatus('已与磁盘同步', 'saved')
  } catch (error) {
    console.error('[html-workbench] save failed', error)
    setStatus(error.message || '保存失败', 'error')
  }
}

async function applyDocument(document) {
  activeFile = document.filePath
  assetBase = document.assetBase
  revision = document.revision
  bodyScripts = document.bodyScripts || []
  sourceCss = document.sourceCss || ''
  sourceBodyHtml = document.bodyHtml || ''
  sourceIdentityCache = null
  links = document.links || []
  headScripts = document.headScripts || []
  htmlAttributes = document.htmlAttributes || {}
  bodyAttributes = document.bodyAttributes || {}
  fileInput.value = activeFile
  fileName.textContent = document.fileName
  fileName.title = activeFile
  applyingDocument = true
  clearTimeout(saveTimer)
  dirty = false
  editor.setComponents(document.bodyHtml)
  editor.setStyle(document.overrideCss || '')
  await injectSourceAssets()
  requestAnimationFrame(() => editor.refresh())
  setTimeout(() => {
    clearTimeout(saveTimer)
    dirty = false
    applyingDocument = false
  }, 250)
}

async function loadFile(file = activeFile) {
  if (!file) return setStatus('请输入 HTML 文件路径', 'error')
  if (dirty) await save()
  setStatus('正在读取磁盘文件', 'saving')
  try {
    activeFile = file
    const response = await fetch(api('/api/document'))
    const document = await readJson(response)
    if (!response.ok) throw requestError(response, document.message || document.error)
    await applyDocument(document)
    dirty = false
    connectEvents()
    const url = new URL(location.href)
    url.searchParams.set('file', activeFile)
    history.replaceState({}, '', url)
    setFilePopover(false)
    setStatus('已与磁盘同步', 'saved')
  } catch (error) {
    console.error('[html-workbench] load failed', error)
    setStatus(error.message || '加载失败', 'error')
  }
}

function connectEvents() {
  eventSource?.close()
  eventSource = new EventSource(api('/api/events'))
  eventSource.onmessage = async (event) => {
    const update = JSON.parse(event.data)
    if (!update.revision || update.revision === revision) return
    if (dirty) return setStatus('磁盘已更新，请先处理当前编辑', 'conflict')
    await loadFile(activeFile)
  }
  eventSource.onerror = () => setStatus('文件监听暂时断开', 'error')
}

function saveAttribute(name, input) {
  const selected = editor?.getSelected()
  if (!selected) return
  selected.addAttributes({ [name]: input.value })
  scheduleSave()
}

try {
  if (!grapesjs) throw new Error('GrapesJS 未加载。请检查浏览器网络记录和服务日志。')
  initEditor()
} catch (error) {
  console.error('[html-workbench] editor initialization failed', error)
  setStatus(error.message || '编辑器初始化失败', 'error')
  throw error
}
document.querySelector('#open-button').addEventListener('click', () => loadFile(fileInput.value.trim()))
fileInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') loadFile(fileInput.value.trim()) })
fileMenuButton.addEventListener('click', () => setFilePopover(filePopover.hidden))
panelButtons.forEach((button) => button.addEventListener('click', () => openPanel(button.dataset.panel)))
modeButtons.forEach((button) => button.addEventListener('click', () => setWorkbenchMode(button.dataset.mode)))
closePanelButton.addEventListener('click', closePanel)
pinPanelButton.addEventListener('click', () => setPanelPinned(!panelPinned))
document.querySelector('#undo-button').addEventListener('click', () => editor.UndoManager.undo())
document.querySelector('#redo-button').addEventListener('click', () => editor.UndoManager.redo())
saveButton.addEventListener('click', save)
document.querySelector('#replace-image-button').addEventListener('click', () => {
  const selected = editor.getSelected()
  if (!selected || selected.get('tagName') !== 'img') return setStatus('请先选中图片', 'error')
  const next = window.prompt('输入新的图片 URL 或相对路径', selected.getAttributes().src || '')
  if (next == null) return
  selected.addAttributes({ src: next })
  scheduleSave()
})
document.querySelectorAll('[data-width]').forEach((button) => button.addEventListener('click', () => {
  canvasWidth = Number(button.dataset.width)
  document.querySelectorAll('[data-width]').forEach((item) => item.classList.toggle('active', item === button))
  updateCanvasScale()
}))
fitButton.addEventListener('click', () => {
  fitCanvas = !fitCanvas
  fitButton.classList.toggle('active', fitCanvas)
  fitButton.setAttribute('aria-pressed', String(fitCanvas))
  updateCanvasScale()
})
canvasArea.addEventListener('click', (event) => {
  if (event.target === canvasArea || event.target === canvasStage) {
    if (!panelPinned) closePanel()
    setFilePopover(false)
  }
})
document.addEventListener('pointerdown', (event) => {
  if (!filePopover.hidden && !event.target.closest('.file-cluster')) setFilePopover(false)
})
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  setFilePopover(false)
  if (!panelPinned) closePanel()
})
new ResizeObserver(updateCanvasScale).observe(canvasArea)
srcInput.addEventListener('change', () => saveAttribute('src', srcInput))
altInput.addEventListener('change', () => saveAttribute('alt', altInput))
hrefInput.addEventListener('change', () => saveAttribute('href', hrefInput))

const initialFile = new URLSearchParams(location.search).get('file')
if (initialFile) loadFile(initialFile)
else setStatus('输入路径或使用 ?file= 打开 HTML', 'idle')
updateCanvasScale()
