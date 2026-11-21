'use strict'

const qs = (selector) => document.querySelector(selector)
const workbench = qs('.workbench')
const world = qs('#canvas-stage')
const canvas = qs('.canvas-area')
const strip = qs('#board-strip')
const layers = qs('#layer-tree')
const inspector = qs('#inspector-panel')
const control = qs('#control-panel')
const status = qs('#status')
const narrow = matchMedia('(max-width: 680px)')
const params = new URLSearchParams(location.search)
const boards = new Map()
const backgroundBoards = new Map()
const allBoards = () => [...boards.values(), ...backgroundBoards.values()]
const findBoard = (file) => boards.get(file) || backgroundBoards.get(file)
const selection = new Set()
const undoStack = []
const redoStack = []
const closedBranches = new WeakSet()
const visibleLayer = (node) => !node.matches('script, style, link, template, noscript, meta')
const children = (node) => [...node.children].filter(visibleLayer)
const pathname = (file) => file.split(/[\\/]/).at(-1)

let directory = params.get('directory') || ''
let layout = readLayout()
let active
let mode = 'edit'
let spaceDown = false
let movingLayer
let hover
let measuring = false
let dragHints
let editingText
let saveTimer
let writing
let restoring = false
let browsing = false
let polling = false
let draggingCanvas = false
let toastTimer
let view = layout.view || { x: 32, y: 64, scale: 1 }

function readLayout() {
  try {
    const stored = JSON.parse(localStorage.getItem(`html-workbench:${directory}`) || '{}')
    if (stored.version === 2) return stored
    return { files: stored.files }
  } catch {
    return {}
  }
}

function rememberLayout() {
  layout.files = [...boards.values()].map(({ file, label }) => ({ path: file, relativePath: label }))
  layout.boards = Object.fromEntries([...boards.values()].map(({ file, x, y, width }) => [file, { x, y, width }]))
  layout.view = view
  layout.version = 2
  localStorage.setItem(`html-workbench:${directory}`, JSON.stringify(layout))
}

function draftKey(file) {
  return 'html-workbench:draft:' + file
}

function readDraft(file) {
  try { return JSON.parse(sessionStorage.getItem(draftKey(file)) || 'null') }
  catch { return null }
}

function rememberDraft(board) {
  try {
    if (board.current === board.disk) {
      sessionStorage.removeItem(draftKey(board.file))
      return
    }
    sessionStorage.setItem(draftKey(board.file), JSON.stringify({
      revision: board.revision, html: board.current,
      prefix: board.prefix, suffix: board.suffix, headStart: board.headStart,
    }))
  } catch { /* Save errors and beforeunload still report unsaved edits if storage is unavailable. */ }
}

function clearDocumentHistory(board) {
  for (const stack of [undoStack, redoStack]) {
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      if (stack[index].changes.some((entry) => entry.board === board)) stack.splice(index, 1)
    }
  }
}

function offerConflict(board) {
  const notice = qs('#save-conflict')
  notice.replaceChildren()
  notice.hidden = !board
  if (!board) return
  const download = button('下载当前编辑', () => {
    const url = URL.createObjectURL(new Blob([board.current], { type: 'text/html;charset=utf-8' }))
    const link = element('a')
    link.href = url
    link.download = '待保存-' + pathname(board.file)
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  })
  const reload = button('使用磁盘版本', async () => {
    if (writing || restoring || !confirm('放弃此文件的未保存编辑，加载磁盘版本？')) return
    try {
      const data = await request(documentRoute(board.file))
      await paint(board, data.html, data.locations)
      board.current = data.html
      board.disk = data.html
      board.revision = data.revision
      board.conflict = false
      rememberDraft(board)
      clearDocumentHistory(board)
      for (const node of [...selection]) if (!owner(node)) selection.delete(node)
      updateSelection()
      queueSave()
    } catch (error) { notify(error.message, true) }
  })
  notice.append(element('span', '', board.label + ' 在磁盘上已更新。'), download, reload)
}

function setStatus(message, state = 'idle') {
  status.dataset.state = state
  status.title = message
  status.querySelector('b').textContent = message
}

function notify(message, error = false) {
  const output = qs('#context-toast')
  output.hidden = false
  output.dataset.state = error ? 'error' : 'info'
  output.textContent = message
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { output.hidden = true }, 3600)
}

async function request(route, options) {
  const response = await fetch(route, options)
  const result = await response.json()
  if (!response.ok) {
    const error = new Error(result.message || result.error)
    error.code = result.error
    error.file = result.file
    throw error
  }
  return result
}

const documentRoute = (file) => `/api/document?file=${encodeURIComponent(file)}`

function jsonRequest(method, data) {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }
}

function element(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

function button(label, action, className) {
  const node = element('button', className, label)
  node.type = 'button'
  node.addEventListener('click', action)
  return node
}

function iconButton(name, label, action, className) {
  const node = button('', action, className || 'icon-button')
  node.title = label
  node.setAttribute('aria-label', label)
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('aria-hidden', 'true')
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use')
  use.setAttribute('href', '#wb-' + name)
  svg.append(use)
  node.append(svg)
  return node
}

function activate(board) {
  active = board
  for (const item of boards.values()) item.card.classList.toggle('active', item === board)
  qs('#file-name').textContent = board?.label || '未打开文件'
  qs('#file-input').value = board?.file || ''
  for (const control of document.querySelectorAll('[data-width]')) {
    control.classList.toggle('active', Number(control.dataset.width) === board?.width)
  }
  const url = new URL(location.href)
  if (board) url.searchParams.set('file', board.file)
  else url.searchParams.delete('file')
  if (directory) url.searchParams.set('directory', directory)
  history.replaceState({}, '', url)
}

function transform() {
  world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`
  world.style.setProperty('--title-scale', String(Math.max(1, Math.min(2.5, 1 / view.scale))))
  world.style.setProperty('--guide-scale', String(1 / view.scale))
  qs('#fit-button').textContent = `${Math.round(view.scale * 100)}%`
}

function boardGeometry(board) {
  Object.assign(board.card.style, { left: `${board.x}px`, top: `${board.y}px`, width: `${board.width}px` })
}

function fit(items = [...boards.values()]) {
  if (!items.length) return
  fitBounds(items.map((board) => ({ left: board.x, right: board.x + board.width, top: board.y, bottom: board.y + board.card.offsetHeight })))
}

function fitBounds(items) {
  const left = Math.min(...items.map((rect) => rect.left))
  const right = Math.max(...items.map((rect) => rect.right))
  const top = Math.min(...items.map((rect) => rect.top))
  const bottom = Math.max(...items.map((rect) => rect.bottom))
  const scale = Math.min(1, Math.max(.04, Math.min((canvas.clientWidth - 64) / (right - left), (canvas.clientHeight - 64) / (bottom - top))))
  view = { x: (canvas.clientWidth - (right - left) * scale) / 2 - left * scale, y: (canvas.clientHeight - (bottom - top) * scale) / 2 - top * scale, scale }
  transform()
  rememberLayout()
}

function focusSelection() {
  const bounds = [...selection].flatMap((node) => {
    const board = owner(node)
    const rect = node.getBoundingClientRect()
    if (!board || !rect.width || !rect.height) return []
    const origin = board.surface.offsetTop
    return [{ left: board.x + rect.left, right: board.x + rect.right, top: board.y + origin + rect.top, bottom: board.y + origin + rect.bottom }]
  })
  if (bounds.length) fitBounds(bounds)
  else if (active) fit([active])
}

function pointerDrag(target, event, move, end) {
  const { pointerId, clientX, clientY } = event
  target.setPointerCapture(pointerId)
  const track = (next) => move(next.clientX - clientX, next.clientY - clientY)
  const stop = (next) => {
    target.removeEventListener('pointermove', track)
    target.removeEventListener('pointerup', stop)
    target.removeEventListener('pointercancel', stop)
    end?.(next)
  }
  target.addEventListener('pointermove', track)
  target.addEventListener('pointerup', stop)
  target.addEventListener('pointercancel', stop)
}

const hiddenRule = '[data-wb-hidden]{display:none!important}'

function frameSource(board, source) {
  // Insert the editor base ahead of relative resources without serializing the original head.
  const base = `<base href="${new URL(board.assetBase, location.origin).href}">`
  return source.slice(0, board.headStart) + base + source.slice(board.headStart)
}

function indexOffset(source, offset) {
  return Array.from(source).slice(0, offset).join('').length
}

function trackPageHeight(doc, report) {
  const win = doc.defaultView
  const root = doc.documentElement
  const body = doc.body
  const viewportHeight = 660
  const rules = new WeakMap()
  const inline = new Map()
  let pending
  let lastHeight
  let lastViewport
  let lastWidth
  let stopped = false

  // The iframe grows for canvas rendering. Keep vh-based styles calculated
  // against its device viewport so full-screen sections do not grow with it.
  function stabilize(style, originals) {
    for (const property of Array.from(style)) {
      const value = style.getPropertyValue(property)
      if (originals.get(property)?.rendered === value) continue
      const adjusted = value.replace(/url\([^)]*\)|"[^"]*"|'[^']*'|(?<![\w-])(-?(?:\d+\.?\d*|\.\d+))(?:d|s|l)?vh\b/gi, (match, amount) =>
        amount === undefined ? match : Number((Number(amount) * viewportHeight / 100).toFixed(4)) + 'px')
      if (adjusted === value) {
        originals.delete(property)
        continue
      }
      const priority = style.getPropertyPriority(property)
      style.setProperty(property, adjusted, priority)
      originals.set(property, { value, rendered: style.getPropertyValue(property), priority })
    }
  }

  function stabilizeRules(list) {
    for (const rule of list) {
      if (rule.style) {
        if (!rules.has(rule)) rules.set(rule, new Map())
        stabilize(rule.style, rules.get(rule))
      }
      if (rule.cssRules) stabilizeRules(rule.cssRules)
      if (rule.styleSheet) {
        try { stabilizeRules(rule.styleSheet.cssRules) } catch { /* Browser-managed cross-origin CSS. */ }
      }
    }
  }

  function measure() {
    pending = undefined
    if (stopped || !root.clientWidth) return
    for (const sheet of doc.styleSheets) {
      try { stabilizeRules(sheet.cssRules) } catch { /* Browser-managed cross-origin CSS. */ }
    }
    for (const node of body.querySelectorAll('[style]')) {
      if (!inline.has(node)) inline.set(node, new Map())
      stabilize(node.style, inline.get(node))
      if (!inline.get(node).size) inline.delete(node)
    }
    for (const node of inline.keys()) if (!body.contains(node)) inline.delete(node)
    const bounds = body.getBoundingClientRect()
    const viewport = win.innerHeight
    const overflow = root.scrollHeight > viewport ? root.scrollHeight : 0
    const bodyEnd = win.scrollY + Math.max(bounds.bottom, bounds.top + body.scrollHeight)
    const margin = parseFloat(win.getComputedStyle(body).marginBottom) || 0
    const height = Math.ceil(Math.max(viewportHeight, overflow, bodyEnd + margin))
    lastWidth = root.clientWidth
    if (height !== lastHeight) {
      lastHeight = height
      lastViewport = viewport
      report(height)
    }
  }

  function schedule() {
    if (!stopped && pending === undefined) pending = win.requestAnimationFrame(measure)
  }

  const observer = new win.ResizeObserver(() => {
    if (lastViewport !== undefined && lastViewport !== win.innerHeight) {
      // A host height change alone must not trigger another expansion.
      lastViewport = win.innerHeight
      if (win.innerHeight >= lastHeight && root.clientWidth === lastWidth) return
    }
    schedule()
  })
  observer.observe(root)
  observer.observe(body)
  const mutations = new win.MutationObserver(schedule)
  mutations.observe(root, { subtree: true, childList: true, attributes: true, characterData: true })
  doc.addEventListener('load', schedule, true)
  doc.fonts?.ready.then(schedule)
  measure()

  return {
    schedule,
    authorStyle(node, copy) {
      for (const [property, { value, rendered, priority }] of inline.get(node) || []) {
        if (copy.style.getPropertyValue(property) === rendered) copy.style.setProperty(property, value, priority)
      }
    },
    authorCss(rule) {
      const originals = rules.get(rule)
      if (!originals?.size) return rule.style.cssText
      const style = doc.createElement('div').style
      style.cssText = rule.style.cssText
      for (const [property, { value, rendered, priority }] of originals) {
        if (style.getPropertyValue(property) === rendered) style.setProperty(property, value, priority)
      }
      return style.cssText
    },
    bodyHtml() {
      if (!inline.size) return body.innerHTML
      const copy = body.cloneNode(true)
      const original = body.querySelectorAll('[style]')
      const clones = copy.querySelectorAll('[style]')
      original.forEach((node, index) => this.authorStyle(node, clones[index]))
      return copy.innerHTML
    },
    disconnect() {
      stopped = true
      observer.disconnect()
      mutations.disconnect()
      if (pending !== undefined) win.cancelAnimationFrame(pending)
      doc.removeEventListener('load', schedule, true)
    },
  }
}

// Forward board scrolling to the canvas unless a scrollable region inside the
// page can consume it. The page itself is laid out at full height.
function canScrollInside(event) {
  for (let node = event.target; node?.parentElement; node = node.parentElement) {
    const doc = node.ownerDocument
    if (node === doc.body) break
    const style = doc.defaultView.getComputedStyle(node)
    if (event.deltaY && /auto|scroll/.test(style.overflowY) &&
        (event.deltaY > 0 ? node.scrollTop + node.clientHeight < node.scrollHeight - 1 : node.scrollTop > 0)) return true
    if (event.deltaX && /auto|scroll/.test(style.overflowX) &&
        (event.deltaX > 0 ? node.scrollLeft + node.clientWidth < node.scrollWidth - 1 : node.scrollLeft > 0)) return true
  }
  return false
}

function setBoardHeight(board, height, preview = false) {
  if (!Number.isFinite(height) || height < 1) return
  if (preview) board.previewHeight = height
  else board.height = height
  board.surface.style.height = (mode === 'preview' ? board.previewHeight ?? board.height : board.height) + 'px'
  if (mode === 'edit') drawBoardSelection(board)
}

function panCanvas(dx, dy) {
  view = { ...view, x: view.x - dx, y: view.y - dy }
  transform()
  rememberLayout()
}

async function paint(board, source, locations) {
  if (locations) {
    board.prefix = source.slice(0, indexOffset(source, locations.bodyStart))
    board.suffix = source.slice(indexOffset(source, locations.bodyEnd))
    board.headStart = Number.isInteger(locations.headStart)
      ? indexOffset(source, locations.headStart)
      : (/<head\b[^>]*>/i.exec(board.prefix)?.index ?? 0) + (/<head\b[^>]*>/i.exec(board.prefix)?.[0].length ?? 0)
  }
  board.heightTracker?.disconnect()
  const ready = new Promise((resolve) => { board.frame.onload = resolve })
  board.frame.srcdoc = frameSource(board, source)
  await ready
  board.frame.onload = null
  const frameDocument = board.frame.contentDocument
  if (!frameDocument?.body) throw new Error(`无法加载画板：${board.label}`)
  board.doc = frameDocument
  const chrome = frameDocument.createElement('style')
  chrome.textContent = hiddenRule + 'body{user-select:none}[contenteditable]{user-select:text}'
  frameDocument.head.append(chrome)
  connectFrame(board)
  board.heightTracker = trackPageHeight(board.doc, (height) => setBoardHeight(board, height))
  drawBoardSelection(board)
}

async function loadBoardSource(board, data) {
  const draft = readDraft(board.file)
  if (!draft || draft.html === data.html) {
    sessionStorage.removeItem(draftKey(board.file))
    await paint(board, data.html, data.locations)
    return
  }
  board.current = draft.html
  board.revision = draft.revision
  board.prefix = draft.prefix
  board.suffix = draft.suffix
  board.headStart = draft.headStart
  board.conflict = draft.revision !== data.revision
  await paint(board, draft.html)
}

function makeBoard(data, label, background = false) {
  const position = layout.boards?.[data.filePath]
  const board = {
    file: data.filePath, label: label || data.fileName, revision: data.revision,
    disk: data.html, current: data.html, locations: data.locations, assetBase: data.assetBase,
    x: position?.x ?? Math.max(0, ...[...boards.values()].map((item) => item.x + item.width + 72)),
    y: position?.y ?? 0, width: position?.width ?? 768, height: 660,
  }
  board.card = element('article', 'board-card')
  board.card.dataset.file = board.file
  const title = element('header', 'board-title')
  title.append(element('span', '', board.label))
  title.title = board.file
  const remove = iconButton('x', '从画布移除', async (event) => {
    event.stopPropagation()
    await removeBoard(board)
  })
  title.append(remove)
  title.addEventListener('pointerdown', (event) => {
    if (remove.contains(event.target) || event.button !== 0 || spaceDown) return
    activate(board)
    const { x, y } = board
    pointerDrag(title, event, (dx, dy) => {
      board.x = x + dx / view.scale
      board.y = y + dy / view.scale
      boardGeometry(board)
    }, rememberLayout)
  })
  board.surface = element('div', 'board-surface')
  board.frame = element('iframe', 'board-edit')
  board.frame.title = board.label
  board.frame.setAttribute('sandbox', 'allow-same-origin')
  board.preview = element('iframe', 'board-preview')
  board.preview.title = `${board.label} 预览`
  board.preview.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals')
  board.preview.hidden = true
  board.overlay = element('div', 'board-overlay')
  board.surface.append(board.frame, board.preview, board.overlay)
  board.card.append(title, board.surface)
  boardGeometry(board)
  strip.append(board.card)
  board.card.hidden = background
  ;(background ? backgroundBoards : boards).set(board.file, board)
  return board
}

async function openFiles(files, preferred) {
  if (!files.length || browsing) return
  browsing = true
  setStatus('正在读取 HTML', 'saving')
  const first = !boards.size
  try {
    const results = await Promise.allSettled(files.map(async ({ path, relativePath }) => {
      if (boards.has(path)) {
        const board = boards.get(path)
        if (relativePath) {
          board.label = relativePath
          board.card.querySelector('.board-title span').textContent = relativePath
          board.frame.title = relativePath
        }
        return board
      }
      const data = await request(documentRoute(path))
      if (!directory) {
        directory = data.directory
        layout = readLayout()
        view = layout.view || view
      }
      if (boards.has(data.filePath)) return boards.get(data.filePath)
      if (backgroundBoards.has(data.filePath)) {
        const restored = backgroundBoards.get(data.filePath)
        backgroundBoards.delete(data.filePath)
        restored.card.hidden = false
        restored.heightTracker?.schedule()
        const last = Math.max(0, ...[...boards.values()].map((item) => item.x + item.width + 72))
        restored.x = last
        boardGeometry(restored)
        boards.set(restored.file, restored)
        return restored
      }
      const board = makeBoard(data, relativePath)
      try {
        await loadBoardSource(board, data)
        if (mode === 'preview') previewBoard(board)
      } catch (error) {
        boards.delete(board.file)
        board.card.remove()
        throw error
      }
      return board
    }))
    const opened = results.filter((result) => result.status === 'fulfilled').map((result) => result.value)
    const failed = results.filter((result) => result.status === 'rejected')
    if (opened.length) {
      activate(opened.find((board) => board.file === preferred) || active || opened[0])
      renderLayers()
      renderTokens()
      if (first && !layout.view) fit()
      else if (!first && opened.length > 1) fit()
      transform()
      rememberLayout()
    }
    if (failed.length) notify(failed[0].reason.message, true)
    updateSaveStatus()
    if (opened.some((board) => !board.conflict && board.current !== board.disk)) queueSave()
  } finally {
    browsing = false
  }
}

async function removeBoard(board) {
  if (board.current !== board.disk) {
    await save()
    if (board.current !== board.disk) return
  }
  for (const node of selection) if (node.ownerDocument === board.doc) selection.delete(node)
  board.card.hidden = true
  boards.delete(board.file)
  backgroundBoards.set(board.file, board)
  if (active === board) activate(boards.values().next().value)
  rememberLayout()
  updateSelection()
}

function owner(node) {
  return allBoards().find((board) => board.doc === node.ownerDocument)
}

function nameOf(node) {
  const label = node.dataset?.wbName || node.getAttribute('aria-label') || node.getAttribute('alt')
  if (label) return label
  if (!children(node).length) {
    const text = node.textContent.trim().replace(/\s+/g, ' ')
    if (text) return text.length > 36 ? `${text.slice(0, 35)}…` : text
  }
  return node.id ? `${node.localName}#${node.id}` : node.localName
}

function locked(node) {
  return Boolean(node.closest('[data-wb-locked]'))
}

function layerPath(node) {
  const path = []
  while (node !== node.ownerDocument.body) {
    const parent = node.parentElement
    if (!parent) return null
    path.unshift([...parent.children].filter((child) => child.localName !== 'script').indexOf(node))
    node = parent
  }
  return path
}

function deepTarget(target, deep) {
  if (deep) return target
  let node = target
  const body = target.ownerDocument.body
  while (node.parentElement !== body && node.parentElement && !selection.has(node.parentElement)) node = node.parentElement
  return node
}

function setPanels(left, right) {
  control.hidden = !left
  inspector.hidden = !right
  workbench.classList.toggle('left-panel-open', Boolean(left))
  workbench.classList.toggle('inspector-open', right)
  if (left) {
    qs('#panel-title').textContent = left === 'layers' ? '图层' : '添加内容'
    for (const content of control.querySelectorAll('[data-panel-content]')) content.hidden = content.dataset.panelContent !== left
  }
  for (const toggle of document.querySelectorAll('[data-panel]')) {
    toggle.setAttribute('aria-expanded', String(toggle.dataset.panel === 'styles' ? right : toggle.dataset.panel === left))
  }
}

function leftPanel() {
  return control.hidden ? '' : control.querySelector('[data-panel-content]:not([hidden])').dataset.panelContent
}

function revealSelectionPanels() {
  if (mode === 'edit' && selection.size) setPanels(narrow.matches ? '' : 'layers', true)
}

function select(node, extend = false) {
  if (locked(node)) return
  if (!extend) selection.clear()
  if (extend && selection.has(node)) selection.delete(node)
  else selection.add(node)
  activate(owner(node))
  revealSelectionPanels()
  updateSelection()
}

function updateSelection() {
  for (const board of boards.values()) drawBoardSelection(board)
  renderLayers()
  renderInspector()
  renderTokens()
}

const guideAxes = [
  { key: 'x', start: 'left', end: 'right', crossStart: 'top', crossEnd: 'bottom' },
  { key: 'y', start: 'top', end: 'bottom', crossStart: 'left', crossEnd: 'right' },
]

function boxOf(nodes) {
  const rects = nodes.map((node) => node.getBoundingClientRect())
  return {
    left: Math.min(...rects.map((rect) => rect.left)), right: Math.max(...rects.map((rect) => rect.right)),
    top: Math.min(...rects.map((rect) => rect.top)), bottom: Math.max(...rects.map((rect) => rect.bottom)),
  }
}

function peerBoxes(board, nodes) {
  const { innerWidth, innerHeight } = board.doc.defaultView
  return [...board.doc.body.querySelectorAll('*')].flatMap((node) => {
    if (!visibleLayer(node) || nodes.some((item) => item.contains(node) || node.contains(item))) return []
    const rect = node.getBoundingClientRect()
    if (!rect.width || !rect.height || rect.right < 0 || rect.left > innerWidth || rect.bottom < 0 || rect.top > innerHeight) return []
    return [rect]
  })
}

function coordinates(rect, { start, end }) {
  return [rect[start], (rect[start] + rect[end]) / 2, rect[end]]
}

function snapAxis(box, peers, axis) {
  const { crossStart, crossEnd } = axis
  const points = coordinates(box, axis)
  let match
  for (const peer of peers) {
    const gap = Math.max(0, box[crossStart] - peer[crossEnd], peer[crossStart] - box[crossEnd])
    if (gap > 160 / view.scale) continue
    const references = coordinates(peer, axis)
    for (const [index, source] of points.entries()) {
      const choices = index === 1 ? [references[1]] : [references[index], references[2 - index]]
      for (const at of choices) {
        const delta = at - source
        if (Math.abs(delta) * view.scale > 5) continue
        if (match && (Math.abs(delta) > Math.abs(match.delta) || (Math.abs(delta) === Math.abs(match.delta) && gap >= match.gap))) continue
        match = { axis: axis.key, at, delta, gap, start: Math.min(box[crossStart], peer[crossStart]), end: Math.max(box[crossEnd], peer[crossEnd]) }
      }
    }
  }
  return match
}

function gapLines(box, peer, inset = false) {
  return guideAxes.flatMap(({ key, start, end, crossStart, crossEnd }) => {
    const low = Math.max(box[crossStart], peer[crossStart])
    const high = Math.min(box[crossEnd], peer[crossEnd])
    if (low >= high) return []
    const at = (low + high) / 2
    if (peer[end] < box[start]) return [{ axis: key, at, start: peer[end], end: box[start], side: start }]
    if (peer[start] > box[end]) return [{ axis: key, at, start: box[end], end: peer[start], side: end }]
    if (!inset) return []
    return [
      { axis: key, at, start: Math.min(peer[start], box[start]), end: Math.max(peer[start], box[start]), side: start },
      { axis: key, at, start: Math.min(peer[end], box[end]), end: Math.max(peer[end], box[end]), side: end },
    ]
  })
}

function nearestGaps(box, peers) {
  const nearest = new Map()
  for (const peer of peers) {
    for (const line of gapLines(box, peer)) {
      const length = line.end - line.start
      if (length * view.scale > 160 || (nearest.has(line.side) && length >= nearest.get(line.side).length)) continue
      nearest.set(line.side, { ...line, length })
    }
  }
  return [...nearest.values()]
}

function drawHint(overlay, { axis, start, end, at }, distance) {
  const length = end - start
  if (length <= 0) return
  const horizontal = distance ? axis === 'x' : axis === 'y'
  const node = element('div', (distance ? 'distance-line' : 'alignment-guide') + (horizontal ? ' horizontal' : ' vertical'))
  node.style.left = (horizontal ? start : at) + 'px'
  node.style.top = (horizontal ? at : start) + 'px'
  node.style.setProperty('--hint-length', length + 'px')
  if (distance) node.append(element('span', '', Number(length.toFixed(1)) + ' px'))
  overlay.append(node)
}

function showBoardHints(board, nodes) {
  if (dragHints?.board === board) {
    for (const line of dragHints.guides) if (line) drawHint(board.overlay, line, false)
    for (const line of dragHints.gaps) drawHint(board.overlay, line, true)
    return
  }
  if (!measuring || draggingCanvas || !nodes.length || hover?.ownerDocument !== board.doc || selection.has(hover)) return
  const box = boxOf(nodes)
  const peer = hover.getBoundingClientRect()
  const inset = nodes.length === 1 && (nodes[0].contains(hover) || hover.contains(nodes[0]))
  for (const line of gapLines(box, peer, inset)) drawHint(board.overlay, line, true)
}

function setHover(node) {
  if (hover === node) return
  const previous = hover && owner(hover)
  hover = node
  if (previous) drawBoardSelection(previous)
  const current = node && owner(node)
  if (current && current !== previous) drawBoardSelection(current)
}

function setMeasuring(on) {
  if (measuring === on) return
  measuring = on
  const board = hover && owner(hover)
  if (board) drawBoardSelection(board)
}

function movableSelection(nodes) {
  const visible = nodes.filter((node) => !locked(node) && node.getClientRects().length)
  return visible.filter((node) => !visible.some((other) => other !== node && other.contains(node)))
}

const alignActions = [
  ['align-horizontal-justify-start', '左对齐', 0, 0],
  ['align-horizontal-justify-center', '水平居中', 0, 1],
  ['align-horizontal-justify-end', '右对齐', 0, 2],
  ['align-vertical-justify-start', '顶部对齐', 1, 0],
  ['align-vertical-justify-center', '垂直居中', 1, 1],
  ['align-vertical-justify-end', '底部对齐', 1, 2],
]

function alignmentControls(selected) {
  const byBoard = new Map()
  for (const node of movableSelection(selected)) {
    const board = owner(node)
    if (!byBoard.has(board)) byBoard.set(board, [])
    byBoard.get(board).push(node)
  }
  const groups = [...byBoard.values()].filter((nodes) => nodes.length > 1)
  if (!groups.length) return null
  const bar = element('div', 'alignment-controls')
  bar.setAttribute('role', 'group')
  bar.setAttribute('aria-label', '对齐图层')
  for (const [icon, label, axis, index] of alignActions) {
    bar.append(iconButton(icon, label, () => {
      const movements = groups.flatMap((nodes) => {
        const at = coordinates(boxOf(nodes), guideAxes[axis])[index]
        return nodes.map((node) => ({ node, delta: at - coordinates(node.getBoundingClientRect(), guideAxes[axis])[index] }))
      }).filter(({ delta }) => Math.abs(delta) >= .01)
      mutate(movements.map(({ node }) => node), () => {
        for (const { node, delta } of movements) movableLayer(node).move(axis ? 0 : delta, axis ? delta : 0)
      })
    }))
  }
  return bar
}

function drawBoardSelection(board) {
  board.overlay.replaceChildren()
  if (mode !== 'edit' || !board.doc) return
  const nodes = [...selection].filter((node) => node.ownerDocument === board.doc)
  const hovered = !draggingCanvas && hover?.ownerDocument === board.doc && !selection.has(hover) ? [hover] : []
  for (const node of [...nodes, ...hovered]) {
    const rect = node.getBoundingClientRect()
    if (!rect.width && !rect.height) continue
    const outline = element('div', node === hover && !selection.has(node) ? 'hover-outline' : 'selection-outline')
    Object.assign(outline.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` })
    board.overlay.append(outline)
  }
  showBoardHints(board, nodes)
}

function offsetValue(value, delta) {
  if (!delta) return value
  if (value === 'auto' || !value) return delta + 'px'
  if (/^-?[\d.]+px$/.test(value)) return (parseFloat(value) + delta) + 'px'
  return 'calc(' + value + ' + ' + delta + 'px)'
}

function movableLayer(node) {
  const original = node.getAttribute('style')
  const computed = node.ownerDocument.defaultView.getComputedStyle(node)
  const position = computed.position
  const offset = (near, far) => {
    const side = computed.getPropertyValue(near) === 'auto' && computed.getPropertyValue(far) !== 'auto' ? far : near
    const value = node.style.getPropertyValue(side) || computed.getPropertyValue(side)
    return (delta) => node.style.setProperty(side, offsetValue(value, side === far ? -delta : delta), 'important')
  }
  const x = offset('left', 'right')
  const y = offset('top', 'bottom')
  const [tx = '0px', ty = '0px', tz] = splitCss(computed.translate === 'none' ? '' : computed.translate, (char) => /\s/.test(char))
  return {
    node,
    move(dx, dy) {
      if (position === 'static') node.style.setProperty('position', 'relative', 'important')
      if (position === 'static' || position === 'relative') {
        if (dx) x(dx)
        if (dy) y(dy)
      } else {
        node.style.setProperty('translate', [offsetValue(tx, dx), offsetValue(ty, dy), tz].filter(Boolean).join(' '), 'important')
      }
    },
    restore() {
      if (original === null) node.removeAttribute('style')
      else node.setAttribute('style', original)
    },
  }
}

function bindLayerDrag(board) {
  const doc = board.doc
  let dragged = false
  doc.addEventListener('dragstart', (event) => {
    if (!editingText?.contains(event.target)) event.preventDefault()
  }, true)
  doc.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary) return
    dragged = false
    if (mode !== 'edit' || event.button !== 0 || spaceDown || restoring || editingText) return
    const target = event.target.closest?.('svg') || event.target
    if (!target?.style || target.matches('html,body') || locked(target)) return
    const { pointerId, clientX, clientY } = event
    let items = []
    let localNodes, peers, dx, dy
    const move = (next) => {
      if (next.pointerId !== pointerId) return
      dx = Math.round(next.clientX - clientX)
      dy = Math.round(next.clientY - clientY)
      if (!dragged) {
        if (Math.hypot(dx, dy) * view.scale < 4) return
        const nodes = movableSelection(selection.has(target) ? [...selection] : [target])
        items = nodes.map(movableLayer)
        localNodes = nodes.filter((node) => node.ownerDocument === doc)
        peers = peerBoxes(board, localNodes)
        const changedSelection = !selection.has(target)
        if (changedSelection) {
          selection.clear()
          selection.add(target)
          activate(board)
        }
        dragged = draggingCanvas = true
        target.setPointerCapture(pointerId)
        if (changedSelection) updateSelection()
      }
      next.preventDefault()
      for (const item of items) { item.restore(); item.move(dx, dy) }
      const box = boxOf(localNodes)
      const guides = next.altKey ? [] : guideAxes.map((axis) => snapAxis(box, peers, axis))
      dx += guides[0]?.delta || 0
      dy += guides[1]?.delta || 0
      if (guides.some((guide) => guide?.delta)) {
        for (const item of items) { item.restore(); item.move(dx, dy) }
      }
      dragHints = { board, guides, gaps: nearestGaps(boxOf(localNodes), peers) }
      for (const item of boards.values()) drawBoardSelection(item)
    }
    const stop = (next) => {
      if (next.pointerId !== pointerId) return
      doc.removeEventListener('pointermove', move)
      doc.removeEventListener('pointerup', stop, true)
      doc.removeEventListener('pointercancel', stop)
      target.removeEventListener('lostpointercapture', stop)
      if (!dragged) return
      draggingCanvas = false
      dragHints = null
      for (const item of items) item.restore()
      revealSelectionPanels()
      if (next.type === 'pointerup' && (dx || dy)) {
        mutate(items.map(({ node }) => node), () => {
          for (const item of items) item.move(dx, dy)
        })
      }
      updateSelection()
    }
    doc.addEventListener('pointermove', move)
    doc.addEventListener('pointerup', stop, true)
    doc.addEventListener('pointercancel', stop)
    target.addEventListener('lostpointercapture', stop)
  }, true)
  return () => dragged
}

function connectFrame(board) {
  const doc = board.doc
  const dragged = bindLayerDrag(board)
  doc.addEventListener('pointermove', (event) => {
    if (mode !== 'edit' || draggingCanvas || event.pointerType === 'touch') return
    setMeasuring(event.altKey)
    const target = event.target.closest?.('svg') || event.target
    setHover(target?.matches?.('html,body') ? null : target)
  })
  board.frame.addEventListener('pointerleave', () => { if (hover?.ownerDocument === doc) setHover(null) })
  doc.documentElement.addEventListener('pointerleave', () => { if (hover?.ownerDocument === doc) setHover(null) })
  doc.addEventListener('click', (event) => {
    if (editingText?.contains(event.target)) return
    event.preventDefault()
    if (dragged()) return
    const target = event.target
    if (!(target?.parentElement) || target.matches('body,html')) {
      activate(board)
      if (!event.shiftKey) selection.clear()
      updateSelection()
      return
    }
    select(deepTarget(target, event.metaKey || event.ctrlKey), event.shiftKey)
  }, true)
  doc.addEventListener('dblclick', (event) => {
    const target = event.target
    if (dragged() || locked(target) || target.matches('body,html')) return
    event.preventDefault()
    select(target)
    if (children(target).length || !target.textContent.trim()) return
    const before = board.current
    const editable = target.getAttribute('contenteditable')
    editingText = target
    target.contentEditable = 'plaintext-only'
    target.focus()
    target.addEventListener('blur', () => {
      if (editable === null) target.removeAttribute('contenteditable')
      else target.setAttribute('contenteditable', editable)
      editingText = null
      finishChange(new Map([[board, before]]))
    }, { once: true })
  })
  doc.addEventListener('scroll', () => drawBoardSelection(board), true)
  doc.addEventListener('wheel', (event) => {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault()
      const rect = board.frame.getBoundingClientRect()
      zoomAt(rect.left + event.clientX * view.scale, rect.top + event.clientY * view.scale, event.deltaY)
    } else if (!canScrollInside(event)) {
      event.preventDefault()
      panCanvas(event.deltaX, event.deltaY)
    }
  }, { passive: false })
  doc.addEventListener('keydown', shortcuts)
  doc.addEventListener('keyup', releaseSpace)
}

function renderLayers() {
  const term = qs('#layer-search').value.trim().toLocaleLowerCase()
  layers.replaceChildren()
  for (const board of boards.values()) {
    const root = element('section', 'layer-board')
    const title = button(board.label, () => {
      activate(board)
      fit([board])
    }, 'layer-board-title')
    title.addEventListener('dragover', (event) => { if (movingLayer) event.preventDefault() })
    title.addEventListener('drop', (event) => {
      event.preventDefault()
      if (board.doc?.body) dropLayer(movingLayer, board.doc.body, 'inside')
      movingLayer = null
    })
    root.append(title)
    if (board.doc) {
      for (const node of children(board.doc.body)) {
        const branch = layerBranch(node, 0, term)
        if (branch) root.append(branch)
      }
    }
    layers.append(root)
  }
}


function relativeResource(value, origin, destination) {
  if (!value || /^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(value)) return value
  const base = new URL(origin.assetBase, location.origin)
  const url = new URL(value, base)
  const assetRoot = base.pathname.split('/~/')[0] + '/~/'
  if (!url.pathname.startsWith(assetRoot)) throw new Error('无法解析相对资源 ' + value)
  const target = url.pathname.slice(assetRoot.length).split('/')
  const from = new URL(destination.assetBase, location.origin).pathname.split('/~/')[1].split('/').filter(Boolean)
  while (target.length && from.length && target[0] === from[0]) { target.shift(); from.shift() }
  return ('../'.repeat(from.length) + target.join('/') || './') + url.search + url.hash
}

function rewriteCssUrls(value, origin, destination) {
  return value.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi, (_, quoted, single, plain) => {
    const url = quoted ?? single ?? plain
    if (url.includes('\\')) throw new Error('CSS 资源地址包含转义字符：' + url)
    return 'url(' + JSON.stringify(relativeResource(url, origin, destination)) + ')'
  })
}

const referenceAttributes = ['for', 'list', 'form', 'headers', 'aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-details', 'aria-owns', 'aria-activedescendant']

function derivedReferences(node) {
  const references = referenceAttributes.flatMap((name) => (node.getAttribute(name) || '').split(/\s+/).filter(Boolean))
  for (const name of ['href', 'xlink:href']) {
    const href = node.getAttribute(name)
    if (href?.startsWith('#') && href.length > 1) references.push(href.slice(1))
  }
  return references
}

function safeMatch(node, selector) {
  try { return node.matches(selector) } catch { return false }
}

function ensureTransferVariables(css, label) {
  const known = new Set(tokenList().map(({ key }) => key))
  const variables = [...css.matchAll(/var\(\s*(--[^\s,)]+)/g)]
  if (variables.some(([, key]) => !known.has(key))) throw new Error('样式依赖源 CSS 变量：' + label)
}

function transferredRules(doc, sourceNodes, clonedNodes, origin, destination, scope, renamed) {
  function rulesCss(rules) {
    const result = []
    for (const rule of rules) {
      if (rule.type === 3) throw new Error('源页面通过 @import 加载样式表。')
      if (rule.type === 4 || rule.type === 12) {
        const nested = rulesCss(rule.cssRules)
        if (nested) result.push(rule.cssText.slice(0, rule.cssText.indexOf('{')) + '{' + nested + '}')
        continue
      }
      if (!rule.selectorText) {
        if (rule.cssRules || rule.type === 5 || rule.type === 7) throw new Error('源样式包含需要一并迁移的规则：' + rule.cssText.split('{')[0])
        continue
      }
      const selectors = splitCss(rule.selectorText, (char) => char === ',')
      for (const selector of selectors) {
        const matchable = selector.replace(/::[\w-]+(?:\([^)]*\))?$/g, '').replace(/:(?:hover|active|focus(?:-visible|-within)?|visited)\b/g, '')
        if (!matchable || !sourceNodes.some((node) => safeMatch(node, matchable))) continue
        if (sourceNodes.some((node, index) => safeMatch(node, matchable) && !safeMatch(clonedNodes[index], matchable))) {
          throw new Error('样式依赖源页面的父级或顺序：' + selector)
        }
        const declarations = origin.heightTracker?.authorCss(rule) ?? rule.style.cssText
        ensureTransferVariables(declarations, selector)
        const rewritten = selector.replace(/#[-\w]+/g, (id) => renamed.has(id.slice(1)) ? '#' + CSS.escape(renamed.get(id.slice(1))) : id)
        const pseudo = rewritten.match(/::[\w-]+(?:\([^)]*\))?$/)?.[0] || ''
        const scopedSelector = pseudo ? rewritten.slice(0, -pseudo.length) : rewritten
        if (!scopedSelector) throw new Error('无法确定伪元素样式的作用范围：' + selector)
        const css = rewriteCssUrls(declarations, origin, destination)
        result.push(scope + ':is(' + scopedSelector + ')' + pseudo + ', ' + scope + ' :is(' + scopedSelector + ')' + pseudo + ' {' + css + '}')
      }
    }
    return result.join('\n')
  }
  return [...doc.styleSheets].map((sheet) => rulesCss(sheet.cssRules)).filter(Boolean).join('\n')
}

function prepareLayerTransfer(source, destination) {
  const origin = owner(source)
  const doc = origin.doc
  if (doc.querySelector('script:not([type]),script[type="module"],script[type*="javascript"],script[type*="ecmascript"]')) {
    throw new Error('源页面包含脚本，无法确认该图层的交互依赖。')
  }
  if (doc.querySelector('link[rel~="stylesheet"]')) throw new Error('源页面包含外部样式表。')
  const original = [source, ...source.querySelectorAll('*')]
  if (original.some((node) => node.matches('style,base,link,iframe,script') || [...node.attributes].some(({ name }) => /^on/i.test(name)))) {
    throw new Error('图层包含脚本、嵌套页面或局部样式。')
  }
  const ids = new Set(original.map((node) => node.id).filter(Boolean))
  const references = [...doc.body.querySelectorAll('*')].filter((node) => !source.contains(node))
  if (references.some((node) => derivedReferences(node).some((id) => ids.has(id)))) {
    throw new Error('源页中的其他元素引用了此图层内的 ID。')
  }
  if (original.some((node) => derivedReferences(node).some((id) => !ids.has(id) && doc.getElementById(id)))) {
    throw new Error('图层引用了源页中的其他元素。')
  }
  const clone = destination.doc.importNode(source, true)
  const copies = [clone, ...clone.querySelectorAll('*')]
  const renamed = new Map()
  const occupied = new Set([...destination.doc.querySelectorAll('[id]')].map((node) => node.id))
  ids.forEach((id) => {
    if (!occupied.has(id)) return
    let index = 2
    while (occupied.has(id + '-' + index) || ids.has(id + '-' + index)) index += 1
    renamed.set(id, id + '-' + index)
    occupied.add(id + '-' + index)
  })
  const scope = 'data-wb-transfer-' + crypto.randomUUID()
  const css = transferredRules(doc, original, copies, origin, destination, '[' + scope + ']', renamed)
  for (const [index, node] of copies.entries()) {
    origin.heightTracker?.authorStyle(original[index], node)
    if (renamed.has(node.id)) node.id = renamed.get(node.id)
    for (const name of ['src', 'href', 'poster', 'action', 'formaction', 'cite', 'data', 'xlink:href']) {
      const value = node.getAttribute(name)
      if (!value) continue
      node.setAttribute(name, value.startsWith('#') && renamed.has(value.slice(1))
        ? '#' + renamed.get(value.slice(1)) : relativeResource(value, origin, destination))
    }
    for (const name of referenceAttributes) {
      if (node.hasAttribute(name)) node.setAttribute(name, node.getAttribute(name).replace(/\S+/g, (id) => renamed.get(id) || id))
    }
    if (node.hasAttribute('srcset')) {
      const value = node.getAttribute('srcset')
      if (/data:/i.test(value)) throw new Error('图层的 srcset 包含内嵌资源，无法确定候选地址边界。')
      node.setAttribute('srcset', value.split(',').map((part) => part.trim().replace(/^\S+/g, (url) => relativeResource(url, origin, destination))).join(', '))
    }
    if (node.hasAttribute('style')) {
      const style = node.getAttribute('style')
      ensureTransferVariables(style, nameOf(source))
      node.setAttribute('style', rewriteCssUrls(style, origin, destination))
    }
  }
  const stylesheet = destination.doc.createElement('style')
  if (css) {
    if (/<\/style/i.test(css)) throw new Error('迁移样式包含无法安全保存的文本。')
    clone.setAttribute(scope, '')
    stylesheet.setAttribute('data-wb-transfer-style', scope)
    stylesheet.textContent = css
  }
  return { clone, stylesheet }
}

function dropLayer(source, target, position) {
  if (!source || source.contains(target) || locked(source) || locked(target)) return
  const destination = owner(target)
  if (!destination) return
  const place = (node) => {
    if (position === 'before') target.before(node)
    else if (position === 'after') target.after(node)
    else target.append(node)
  }
  if (source.ownerDocument === target.ownerDocument) {
    mutate([source], () => place(source))
    return
  }
  try {
    const { clone, stylesheet } = prepareLayerTransfer(source, destination)
    const inherited = ['color', 'font-family', 'font-size', 'font-style', 'font-weight', 'line-height', 'letter-spacing', 'text-align']
    const inheritedBefore = inherited.map((property) => [property, styleValue(source, property)])
    mutate([source, target], () => {
      place(clone)
      if (stylesheet.textContent) destination.doc.body.append(stylesheet)
      for (const [property, value] of inheritedBefore) {
        if (value && !clone.style.getPropertyValue(property) && styleValue(clone, property) !== value) {
          clone.style.setProperty(property, value)
        }
      }
      source.remove()
      selection.clear()
      selection.add(clone)
      activate(destination)
    })
  } catch (error) {
    notify(error.message, true)
  }
}

function layerBranch(node, depth, term) {
  const nested = children(node)
  const branch = element('div', 'layer-branch')
  const row = element('div', 'layer-row')
  row.classList.toggle('selected', selection.has(node))
  row.classList.toggle('locked', locked(node))
  row.style.paddingInlineStart = `${8 + depth * 14}px`
  branch.append(row)
  let matches = !term || `${nameOf(node)} ${node.localName}`.toLocaleLowerCase().includes(term)
  if (!closedBranches.has(node) || term) {
    for (const child of nested) {
      const sub = layerBranch(child, depth + 1, term)
      if (sub) {
        matches = true
        branch.append(sub)
      }
    }
  }
  if (!matches) return null
  const disclosure = iconButton(closedBranches.has(node) ? 'chevron-right' : 'chevron-down', closedBranches.has(node) ? '展开' : '折叠', () => {
    if (closedBranches.has(node)) closedBranches.delete(node)
    else closedBranches.add(node)
    renderLayers()
  }, 'layer-disclosure')
  disclosure.style.visibility = nested.length ? 'visible' : 'hidden'
  const label = button(nameOf(node), (event) => {
    select(node, event.shiftKey || event.metaKey || event.ctrlKey)
    if (node.getBoundingClientRect().bottom > node.ownerDocument.documentElement.clientHeight) node.scrollIntoView({ block: 'nearest' })
  }, 'layer-label')
  label.addEventListener('dblclick', () => renameLayer(node))
  row.addEventListener('mouseenter', () => setHover(node))
  row.addEventListener('mouseleave', () => setHover(null))
  const visibility = iconButton(node.hasAttribute('data-wb-hidden') ? 'eye-off' : 'eye', node.hasAttribute('data-wb-hidden') ? '显示' : '隐藏', () => {
    mutate([node], () => node.toggleAttribute('data-wb-hidden'))
  }, 'layer-action')
  const lock = iconButton(node.hasAttribute('data-wb-locked') ? 'lock' : 'lock-open', node.hasAttribute('data-wb-locked') ? '解锁' : '锁定', () => {
    mutate([node], () => {
      if (node.toggleAttribute('data-wb-locked')) {
        for (const item of selection) if (node.contains(item)) selection.delete(item)
      }
    })
  }, 'layer-action')
  row.append(disclosure, label, visibility, lock)
  row.draggable = !locked(node)
  row.addEventListener('dragstart', (event) => {
    movingLayer = node
    event.dataTransfer.setData('text/plain', nameOf(node))
    event.dataTransfer.effectAllowed = 'move'
  })
  row.addEventListener('dragend', () => { movingLayer = null })
  row.addEventListener('dragover', (event) => {
    if (movingLayer && !movingLayer.contains(node) && !locked(node)) event.preventDefault()
  })
  row.addEventListener('drop', (event) => {
    event.preventDefault()
    const source = movingLayer
    movingLayer = null
    if (!source || source.contains(node) || locked(node)) return
    const rect = row.getBoundingClientRect()
    const ratio = (event.clientY - rect.top) / rect.height
    const position = ratio < .3 ? 'before' : ratio > .7 || node.matches('img,input,hr,br,video,svg') ? 'after' : 'inside'
    dropLayer(source, node, position)
  })
  return branch
}

function renameLayer(node) {
  if (locked(node)) return
  const next = prompt('图层名称', nameOf(node))
  if (next === null) return
  mutate([node], () => {
    if (next.trim()) node.setAttribute('data-wb-name', next.trim())
    else node.removeAttribute('data-wb-name')
  })
}

function serializeBoard(board) {
  updateTokenStyles(board)
  const body = board.doc.body
  if (body.querySelector('[data-wb-hidden]') && !body.querySelector('style[data-wb-layer-visibility]')) {
    const rule = board.doc.createElement('style')
    rule.setAttribute('data-wb-layer-visibility', '')
    rule.textContent = hiddenRule
    body.append(rule)
  }
  return board.prefix + (board.heightTracker?.bodyHtml() ?? body.innerHTML) + board.suffix
}

function mutate(nodes, action) {
  if (!nodes.length || restoring || mode !== 'edit') return
  const before = new Map(nodes.map((node) => owner(node)).filter(Boolean).map((board) => [board, board.current]))
  action()
  finishChange(before)
}

function finishChange(before, tokenChange) {
  const changes = []
  for (const [board, original] of before) {
    const next = serializeBoard(board)
    if (next === original) continue
    board.current = next
    rememberDraft(board)
    changes.push({ board, before: original, after: next })
  }
  if (!changes.length && !tokenChange) return
  if (tokenChange) {
    tokenChange.after = structuredClone(tokenList())
    rememberLayout()
  }
  undoStack.push({ changes, tokens: tokenChange })
  if (undoStack.length > 100) undoStack.shift()
  redoStack.length = 0
  if (!tokenChange && layout.tokens?.length) rememberLayout()
  updateSelection()
  queueSave()
}

async function historyStep(from, to, key) {
  if (restoring || !from.length || editingText || mode !== 'edit') return
  restoring = true
  setStatus('正在恢复修改', 'saving')
  const entry = from.pop()
  try {
    selection.clear()
    await Promise.all(entry.changes.map(async ({ board, [key]: source }) => {
      await paint(board, source)
      board.current = source
      rememberDraft(board)
    }))
    if (entry.tokens) layout.tokens = structuredClone(entry.tokens[key])
    to.push(entry)
    rememberLayout()
    updateSelection()
    queueSave()
  } catch (error) {
    from.push(entry)
    notify(error.message, true)
  } finally {
    restoring = false
  }
}

function updateSaveStatus() {
  const items = allBoards()
  const conflict = items.find((board) => board.conflict)
  offerConflict(conflict)
  if (conflict) setStatus(`磁盘已更新，编辑仍保留：${conflict.label}`, 'conflict')
  else if (items.some((board) => board.current !== board.disk)) setStatus('等待保存', 'dirty')
  else setStatus(items.length ? '已与磁盘同步' : '等待打开文件', items.length ? 'saved' : 'idle')
}

function queueSave() {
  updateSaveStatus()
  clearTimeout(saveTimer)
  saveTimer = setTimeout(save, 500)
}

async function save() {
  clearTimeout(saveTimer)
  if (writing) return writing
  const changed = allBoards().filter((board) => board.current !== board.disk)
  if (!changed.length) return
  const changes = changed.map((board) => ({ file: board.file, baseRevision: board.revision, html: board.current }))
  setStatus('保存中', 'saving')
  writing = (async () => {
    try {
      const result = await request('/api/batch', jsonRequest('PUT', { changes }))
      for (const data of result.documents) {
        const board = findBoard(data.filePath)
        if (!board) continue
        board.revision = data.revision
        board.disk = data.html
        board.conflict = false
        rememberDraft(board)
      }
      updateSaveStatus()
      if (allBoards().some((board) => board.current !== board.disk)) queueSave()
    } catch (error) {
      const board = findBoard(error.file)
      if (board && error.code === 'REVISION_CONFLICT') {
        board.conflict = true
        offerConflict(board)
      }
      setStatus(error.message, error.code === 'REVISION_CONFLICT' ? 'conflict' : 'error')
      notify(error.message, true)
    }
  })()
  try {
    await writing
  } finally {
    writing = null
  }
}

const colorFields = [
  ['background-color', '填充颜色'],
  ['color', '文字颜色'],
  ['border-color', '描边颜色'],
]
const tokenList = () => layout.tokens || []
const tokenPattern = /var\(\s*(--wb-color-[\w-]+)/g

function plainColor(value) {
  const raw = value.trim()
  if (!raw || /^(?:inherit|currentcolor|revert(?:-layer)?|initial|unset)$/i.test(raw) || raw.includes('var(')) return ''
  if (!CSS.supports('color', raw)) return ''
  const context = plainColor.context ||= document.createElement('canvas').getContext('2d')
  context.fillStyle = '#000000'
  context.fillStyle = raw
  return context.fillStyle
}

function updateTokenStyles(board) {
  const body = board.doc.body
  let style = body.querySelector('style[data-wb-color-tokens]')
  const references = new Set([...body.innerHTML.matchAll(tokenPattern)].map((match) => match[1]))
  const existing = new Map()
  if (style?.sheet) for (const rule of style.sheet.cssRules) {
    if (!rule.style) continue
    for (const key of Array.from(rule.style)) existing.set(key, rule.style.getPropertyValue(key).trim())
  }
  const tokens = new Map(tokenList().map((token) => [token.key, token]))
  const declarations = []
  for (const key of references) {
    const token = tokens.get(key)
    const color = token?.value || existing.get(key)
    if (!color) continue
    declarations.push(key + ': ' + color + ';')
    if (token && !token.files?.includes(board.file)) token.files = [...(token.files || []), board.file]
  }
  if (!declarations.length) {
    style?.remove()
    return
  }
  if (!style) {
    style = board.doc.createElement('style')
    style.setAttribute('data-wb-color-tokens', '')
    body.append(style)
  }
  style.textContent = ':root { ' + declarations.join(' ') + ' }'
}

function shadowColor(value) {
  return splitCss(value, (char) => /\s/.test(char)).find((part) => plainColor(part) || part.startsWith('var(') || part.toLowerCase() === 'currentcolor')
}

function rgbaChannels(value) {
  const color = plainColor(value)
  if (/^#[\da-f]{6}$/i.test(color)) {
    return [1, 3, 5].map((index) => parseInt(color.slice(index, index + 2), 16)).concat(1)
  }
  return color.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/)?.slice(1).map((item) => Number(item ?? 1))
}

function tokenFor(value) {
  const key = value?.match(/^var\(\s*(--wb-color-[\w-]+)/)?.[1]
  return tokenList().find((token) => token.key === key)
}

function applyColorBinding(usages, token) {
  if (!usages.length || restoring || mode !== 'edit') return
  const previous = structuredClone(tokenList())
  const nodes = [...new Set(usages.map(({ node }) => node))].filter((node) => !locked(node))
  const before = new Map(nodes.map((node) => owner(node)).filter(Boolean).map((board) => [board, board.current]))
  const byNode = new Map()
  for (const usage of usages) {
    if (!before.has(owner(usage.node)) || locked(usage.node)) continue
    const node = usage.node
    const raw = usage.shadow === undefined ? styleValue(node, usage.property) : usage.color
    const value = token ? 'var(' + token.key + ')' : tokenFor(raw)?.value
    if (!value) continue
    if (usage.shadow === undefined) node.style.setProperty(usage.property, value, node.style.getPropertyPriority(usage.property))
    else {
      if (!byNode.has(node)) byNode.set(node, shadowRows(node))
      const row = byNode.get(node)[usage.shadow]
      if (!row) continue
      row.value = usage.color ? row.value.replace(usage.color, value) : row.value + ' ' + value
    }
  }
  for (const [node, rows] of byNode) setShadowRows(node, rows)
  finishChange(before, { before: previous, after: tokenList() })
}

function tokenMenu(label, usages, value) {
  const field = element('select', 'token-select')
  field.setAttribute('aria-label', '绑定' + label)
  const bound = tokenFor(value)
  field.append(new Option(bound?.name || '选择颜色 token', ''))
  if (bound) field.append(new Option('解除绑定', 'unlink'))
  for (const token of tokenList()) field.append(new Option(token.name, token.key))
  field.onchange = () => {
    const token = tokenList().find((item) => item.key === field.value)
    if (token || field.value === 'unlink') applyColorBinding(usages, token)
  }
  return field
}

function colorUsages(color) {
  const match = plainColor(color)
  const usages = []
  for (const board of boards.values()) {
    if (!board.doc) continue
    for (const node of board.doc.body.querySelectorAll('*')) {
      if (!visibleLayer(node) || locked(node) || !node.style) continue
      for (const [property, label] of colorFields) {
        if (property === 'border-color' && node.ownerDocument.defaultView.getComputedStyle(node).borderStyle === 'none') continue
        if (plainColor(styleValue(node, property)) === match) usages.push({ board, node, property, label })
      }
      shadowRows(node).forEach(({ value }, shadow) => {
        const color = shadowColor(value)
        if (plainColor(color || '') === match) usages.push({ board, node, shadow, color, label: '阴影 ' + (shadow + 1) })
      })
    }
  }
  return usages
}

function pickColorUsages(token) {
  const usages = colorUsages(token.value)
  const dialog = element('dialog', 'token-dialog')
  dialog.append(element('h2', '', token.name), element('p', '', '选择要使用此颜色 token 的位置'))
  const list = element('div', 'usage-list')
  const controls = usages.map((usage) => {
    const check = element('input')
    check.type = 'checkbox'
    const label = element('label')
    label.append(check, document.createTextNode([usage.board.label, nameOf(usage.node), usage.label].join(' / ')))
    list.append(label)
    return { usage, check }
  })
  if (!controls.length) list.append(element('p', '', '没有匹配的颜色用量'))
  const actions = element('div', 'dialog-actions')
  const confirm = button('绑定所选', () => {
    const checked = controls.filter(({ check }) => check.checked).map(({ usage }) => usage)
    applyColorBinding(checked, token)
    dialog.close()
  })
  confirm.disabled = true
  list.onchange = () => { confirm.disabled = !controls.some(({ check }) => check.checked) }
  actions.append(button('取消', () => dialog.close()), confirm)
  dialog.append(list, actions)
  dialog.addEventListener('close', () => dialog.remove(), { once: true })
  document.body.append(dialog)
  dialog.showModal()
}

async function openBackground(file) {
  const existing = findBoard(file)
  if (existing) return existing
  const data = await request(documentRoute(file))
  if (findBoard(data.filePath)) return findBoard(data.filePath)
  const board = makeBoard(data, data.fileName, true)
  try {
    await loadBoardSource(board, data)
    return board
  } catch (error) {
    board.card.remove()
    backgroundBoards.delete(board.file)
    throw error
  }
}

let changingToken = false
async function changeTokenColor(token, input) {
  const value = plainColor(input.value)
  if (!value) return notify('请输入有效的 CSS 颜色。', true)
  if (value === token.value || changingToken) return
  changingToken = true
  const openingDirectory = directory
  try {
    const files = new Set([...(token.files || []), ...allBoards().filter((board) => board.current.includes(token.key)).map(({ file }) => file)])
    const loaded = await Promise.all([...files].map(openBackground))
    if (directory !== openingDirectory) return
    const affected = loaded.filter((board) => board.current.includes(token.key))
    const previous = structuredClone(tokenList())
    token.value = value
    finishChange(new Map(affected.map((board) => [board, board.current])), { before: previous, after: tokenList() })
  } catch (error) {
    input.value = token.value
    notify(error.message, true)
  } finally {
    changingToken = false
  }
}

function renderTokens() {
  const panel = qs('#token-panel')
  if (panel.hidden) return
  panel.replaceChildren()
  const create = element('form', 'token-create')
  const name = element('input')
  name.placeholder = '品牌 / 主色'
  name.setAttribute('aria-label', 'Token 名称')
  name.required = true
  const color = element('input')
  color.value = '#087c61'
  color.setAttribute('aria-label', '新 Token 色值')
  const add = element('button', '', '新建')
  create.append(name, color, add)
  create.onsubmit = (event) => {
    event.preventDefault()
    const value = plainColor(color.value)
    const title = name.value.trim()
    if (!value || !title) return notify('填写名称和有效的 CSS 颜色。', true)
    if (tokenList().some((token) => token.name === title)) return notify('已存在同名颜色 token。', true)
    const previous = structuredClone(tokenList())
    layout.tokens = [...tokenList(), { key: '--wb-color-' + crypto.randomUUID(), name: title, value, files: [] }]
    finishChange(new Map(), { before: previous, after: tokenList() })
  }
  panel.append(create)
  for (const token of tokenList()) {
    const row = element('div', 'token-row')
    const title = element('strong', '', token.name)
    const swatch = element('span', 'color-swatch')
    swatch.style.background = token.value
    const value = element('input')
    value.value = token.value
    value.setAttribute('aria-label', token.name + ' 色值')
    value.onchange = () => { void changeTokenColor(token, value) }
    value.onkeydown = (event) => { if (event.key === 'Enter') value.blur() }
    const usage = button('查看用量', () => pickColorUsages(token))
    usage.setAttribute('aria-label', token.name + ' 查看用量')
    row.append(title, swatch, value, usage)
    panel.append(row)
  }
}

const DESIGN_GROUPS = [
  ['位置与尺寸', [['left', 'X'], ['top', 'Y'], ['width', '宽'], ['height', '高']]],
  ['布局', [['display', '显示'], ['position', '定位'], ['gap', '间距'], ['padding', '内距'], ['margin', '外距']]],
  ['外观', [['opacity', '不透明度'], ['border-radius', '圆角']]],
  ['排版', [['font-weight', '字重'], ['font-size', '字号'], ['line-height', '行高'], ['letter-spacing', '字距'], ['text-align', '对齐'], ['color', '文字颜色']]],
  ['填充与描边', [['background-color', '填充颜色'], ['border-color', '描边颜色'], ['border-width', '描边宽度'], ['border-style', '描边类型']]],
]

function splitCss(value, separator) {
  const parts = []
  let start = 0
  let depth = 0
  let quote = ''
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (char === '\\') { index += 1; continue }
    if (quote) {
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === '(') depth += 1
    else if (char === ')') depth -= 1
    else if (!depth && separator(char)) {
      const part = value.slice(start, index).trim()
      if (part) parts.push(part)
      start = index + 1
    }
  }
  const last = value.slice(start).trim()
  if (last) parts.push(last)
  return parts
}

function shadowRows(node) {
  if (node.hasAttribute('data-wb-shadows')) {
    try {
      const stored = JSON.parse(node.getAttribute('data-wb-shadows'))
      if (Array.isArray(stored) && stored.every((row) => typeof row?.value === 'string')) return stored
    } catch { /* Use the CSS declarations if metadata was edited externally. */ }
  }
  const computed = styleValue(node, 'box-shadow').trim()
  const current = authoredShadow(node, computed)
  return current === 'none' ? [] : splitCss(current, (char) => char === ',').map((value) => ({ value, enabled: true }))
}

function authoredShadow(node, computed) {
  if (node.style.getPropertyValue('box-shadow') || computed === 'none') return computed
  const view = node.ownerDocument.defaultView
  const candidates = []
  function collect(rules) {
    for (const rule of rules) {
      if (rule.type === 4 && !view.matchMedia(rule.conditionText).matches) continue
      if (rule.type === 12 && !CSS.supports(rule.conditionText)) continue
      if (rule.selectorText && safeMatch(node, rule.selectorText)) {
        const value = rule.style.getPropertyValue('box-shadow')
        if (value) candidates.push(value)
      }
      if (rule.cssRules) collect(rule.cssRules)
    }
  }
  for (const sheet of node.ownerDocument.styleSheets) {
    try { collect(sheet.cssRules) } catch { /* Cross-origin stylesheets expose computed values only. */ }
  }
  const attribute = node.getAttribute('style')
  try {
    for (const value of candidates.reverse()) {
      node.style.setProperty('box-shadow', value, 'important')
      if (view.getComputedStyle(node).boxShadow === computed) return value
    }
  } finally {
    if (attribute === null) node.removeAttribute('style')
    else node.setAttribute('style', attribute)
  }
  return computed
}

function setShadowRows(node, rows) {
  if (rows.some((row) => !row.enabled)) node.setAttribute('data-wb-shadows', JSON.stringify(rows))
  else node.removeAttribute('data-wb-shadows')
  const value = rows.filter((row) => row.enabled).map((row) => row.value).join(', ') || 'none'
  node.style.setProperty('box-shadow', value, node.style.getPropertyPriority('box-shadow'))
}

function writeShadows(nodes, rows) {
  const value = rows.filter((row) => row.enabled).map((row) => row.value).join(', ') || 'none'
  if (!CSS.supports('box-shadow', value)) return notify('无法使用这个阴影值。', true)
  mutate(nodes, () => {
    for (const node of nodes) {
      setShadowRows(node, rows)
    }
  })
}

let expandedEffect = -1
function renderEffects(nodes) {
  const panel = qs('#effects-panel')
  panel.replaceChildren()
  if (!nodes.length) return
  const group = element('section', 'design-group effect-group')
  const header = element('div', 'effect-header')
  const rows = shadowRows(nodes[0])
  const mixed = nodes.slice(1).some((node) => JSON.stringify(shadowRows(node)) !== JSON.stringify(rows))
  const add = iconButton('plus', '添加阴影', () => {
    const value = '0px 4px 12px 0px rgb(0 0 0 / 25%)'
    if (mixed) {
      mutate(nodes, () => {
        for (const node of nodes) {
          const list = [...shadowRows(node), { value, enabled: true }]
          setShadowRows(node, list)
        }
      })
      return
    }
    expandedEffect = rows.length
    writeShadows(nodes, [...rows, { value, enabled: true }])
  })
  header.append(element('h3', '', '效果'), add)
  group.append(header)
  panel.append(group)
  if (mixed) {
    group.append(element('p', 'section-label', '混合'))
    return
  }
  rows.forEach((row, index) => {
    const item = element('div', 'effect-item')
    const edit = button(/\binset\b/i.test(row.value) ? '内阴影' : '投影', () => {
      expandedEffect = expandedEffect === index ? -1 : index
      renderInspector()
    })
    edit.setAttribute('aria-expanded', String(expandedEffect === index))
    const toggle = iconButton(row.enabled ? 'eye' : 'eye-off', row.enabled ? '隐藏阴影' : '显示阴影', () => {
      row.enabled = !row.enabled
      writeShadows(nodes, rows)
    })
    const up = iconButton('arrow-up', '上移阴影', () => {
      ;[rows[index - 1], rows[index]] = [row, rows[index - 1]]
      expandedEffect = index - 1
      writeShadows(nodes, rows)
    })
    up.disabled = index === 0
    const remove = iconButton('x', '删除阴影', () => {
      expandedEffect = -1
      writeShadows(nodes, rows.filter((_, position) => position !== index))
    })
    item.append(edit, toggle, up, remove)
    group.append(item)
    if (expandedEffect !== index) return
    const panel = element('div', 'effect-options')
    const parts = splitCss(row.value, (char) => /\s/.test(char))
    const inset = parts.includes('inset')
    const lengths = parts.filter((part) => /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[a-z]+|%)?$/i.test(part))
    const colors = parts.filter((part) => part !== 'inset' && !lengths.includes(part))
    const input = element('input')
    input.value = row.value
    input.setAttribute('aria-label', '阴影 CSS')
    input.onchange = () => {
      row.value = input.value.trim()
      writeShadows(nodes, rows)
    }
    if (lengths.length >= 2 && colors.length <= 1) {
      const type = element('select')
      type.setAttribute('aria-label', '阴影类型')
      type.append(new Option('投影', 'outer'), new Option('内阴影', 'inner'))
      type.value = inset ? 'inner' : 'outer'
      const grid = element('div', 'design-grid')
      const fields = ['X', 'Y', '模糊', '扩展'].map((label, position) => {
        const field = element('label', 'design-field')
        const value = element('input')
        value.value = lengths[position] ?? '0px'
        value.setAttribute('aria-label', '阴影 ' + label)
        field.append(element('span', '', label), value)
        grid.append(field)
        return value
      })
      const color = element('input')
      color.value = colors[0] || 'currentColor'
      color.setAttribute('aria-label', '阴影颜色与透明度')
      const alpha = element('input')
      alpha.type = 'number'
      alpha.min = '0'
      alpha.max = '100'
      alpha.setAttribute('aria-label', '阴影透明度')
      const channels = rgbaChannels(color.value)
      alpha.value = channels ? String(Math.round(channels[3] * 100)) : ''
      alpha.disabled = !channels
      const commit = () => {
        const values = fields.map(({ value }) => /^-?\d+(?:\.\d+)?$/.test(value) ? value + 'px' : value)
        row.value = [...(type.value === 'inner' ? ['inset'] : []), ...values, color.value].join(' ')
        writeShadows(nodes, rows)
      }
      for (const control of [type, ...fields, color]) control.onchange = commit
      alpha.onchange = () => {
        const next = Math.max(0, Math.min(100, Number(alpha.value))) / 100
        color.value = 'rgba(' + [...channels.slice(0, 3), next].join(', ') + ')'
        commit()
      }
      const opacity = element('label', 'design-field')
      opacity.append(element('span', '', '透明度 %'), alpha)
      panel.append(type, grid, color, opacity)
      if (tokenList().length) {
        const usages = nodes.map((node) => ({ node, shadow: index, color: shadowColor(row.value) }))
        panel.append(tokenMenu('阴影颜色', usages, color.value))
      }
    }
    panel.append(input)
    group.append(panel)
  })
}

function styleValue(node, property) {
  return node.style.getPropertyValue(property) || node.ownerDocument.defaultView.getComputedStyle(node).getPropertyValue(property)
}

function commonValue(nodes, property) {
  const values = new Set(nodes.map((node) => styleValue(node, property)))
  return values.size === 1 ? [...values][0] : ''
}

function applyStyle(property, value) {
  const nodes = [...selection].filter((node) => !locked(node))
  if (value && !CSS.supports(property, value)) return notify(`无法使用该样式值：${value}`, true)
  mutate(nodes, () => {
    for (const node of nodes) {
      if (value && (property === 'left' || property === 'top') && styleValue(node, 'position') === 'static') {
        node.style.setProperty('position', 'relative')
      }
      node.style.setProperty(property, value, node.style.getPropertyPriority(property))
    }
  })
}

let localFamilies = []

const genericFonts = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'emoji', 'math', 'fangsong'])

function familyName(value) {
  return splitCss(value, (char) => char === ',')[0]?.trim().replace(/^['"]|['"]$/g, '') || ''
}

function findFontFamily(name) {
  const search = name.toLocaleLowerCase()
  return localFamilies.find((font) => [font.family, ...(font.aliases || [])].some((value) => value.toLocaleLowerCase() === search))
}

function namedWeight(name) {
  const style = name.toLowerCase().replace(/[- ]/g, '')
  const weights = [
    [/thin|hairline/, 100], [/extra-light|extralight|ultralight/, 200], [/light/, 300],
    [/medium/, 500], [/demibold|semibold|demi/, 600], [/extrabold|ultrabold/, 800],
    [/ultrablack|extrablack/, 950], [/black|heavy/, 900], [/bold/, 700],
  ]
  return weights.find(([pattern]) => pattern.test(style))?.[1] || 400
}

function browserFontFamilies(fonts) {
  const families = new Map()
  for (const { family, style } of fonts) {
    const group = families.get(family) || { family, aliases: [], variants: [] }
    const name = style || 'Regular'
    if (!group.variants.some((variant) => variant.name === name)) group.variants.push({ name, weight: namedWeight(name) })
    families.set(family, group)
  }
  return [...families.values()]
}

function useFontVariants(nodes) {
  const family = findFontFamily(familyName(commonValue(nodes, 'font-family')))
  const select = qs('#font-variant')
  qs('#font-variant-label').hidden = !family?.variants?.length
  select.replaceChildren(new Option('选择字重', ''))
  if (!family) return
  const weight = Number(commonValue(nodes, 'font-weight'))
  const style = commonValue(nodes, 'font-style')
  for (const [index, variant] of family.variants.entries()) {
    const italic = /italic|oblique|斜/i.test(variant.name)
    select.append(new Option(variant.name + ' · ' + variant.weight, String(index), false, variant.weight === weight && italic === /italic|oblique/i.test(style)))
  }
  select.onchange = () => {
    const variant = select.value !== '' && family.variants[Number(select.value)]
    if (!variant) return
    mutate(nodes, () => {
      for (const node of nodes) {
        node.style.setProperty('font-weight', variant.weight, node.style.getPropertyPriority('font-weight'))
        node.style.setProperty('font-style', /italic|斜/i.test(variant.name) ? 'italic' : /oblique/i.test(variant.name) ? 'oblique' : 'normal', node.style.getPropertyPriority('font-style'))
      }
    })
  }
}

async function loadLocalFonts() {
  try {
    const browser = typeof window.queryLocalFonts === 'function'
      ? browserFontFamilies(await window.queryLocalFonts()) : []
    let service = []
    try { service = (await request('/api/fonts')).families || [] } catch (error) { if (!browser.length) throw error }
    const families = new Map(browser.map((family) => [family.family, family]))
    for (const family of service) families.set(family.family, family)
    localFamilies = [...families.values()].sort((a, b) => a.family.localeCompare(b.family))
    qs('#font-options').replaceChildren(...localFamilies.flatMap(({ family, aliases }) => [
      new Option(aliases.join(' / '), family), ...aliases.map((alias) => new Option(family, alias)),
    ]))
    useFontVariants([...selection])
    notify('已读取 ' + localFamilies.length + ' 个字体家族')
  } catch {
    notify('可直接输入本地字体名称。')
  }
}

function renderInspector() {
  const panel = inspector.querySelector('.panel-content')
  const top = panel.scrollTop
  renderInspectorFields()
  panel.scrollTop = top
}

function renderInspectorFields() {
  const selected = [...selection]
  const first = selected[0]
  const list = qs('#styles-panel')
  list.replaceChildren()
  renderEffects(selected)
  qs('[data-panel-content="styles"] > p').textContent = selected.length > 1 ? `已选 ${selected.length} 个图层` : first ? nameOf(first) : '未选择图层'
  qs('.font-picker').hidden = !first
  qs('#context-button').hidden = !first
  qs('#attributes-panel').hidden = !first || selected.length !== 1 || !first.matches('img,a')
  for (const [field, attribute] of [['#src-input', 'src'], ['#alt-input', 'alt'], ['#href-input', 'href']]) {
    const input = qs(field)
    input.parentElement.hidden = first?.matches('img') ? attribute === 'href' : attribute !== 'href'
    input.value = first?.getAttribute(attribute) || ''
  }
  if (!first) return
  const font = qs('#font-family-input')
  const family = commonValue(selected, 'font-family')
  font.value = familyName(family)
  font.placeholder = family ? '输入字体名称' : '混合'
  useFontVariants(selected)
  for (const [title, fields] of DESIGN_GROUPS) {
    const group = element('section', 'design-group')
    group.append(element('h3', '', title))
    if (title === '位置与尺寸') {
      const controls = alignmentControls(selected)
      if (controls) group.append(controls)
    }
    const grid = element('div', 'design-grid')
    for (const [property, label] of fields) {
      const field = element('label', 'design-field')
      const input = element('input')
      input.value = commonValue(selected, property)
      input.placeholder = '混合'
      input.setAttribute('aria-label', label)
      input.dataset.property = property
      input.addEventListener('change', () => {
        let value = input.value.trim()
        if (/^(?:-?\d+(?:\.\d+)?)$/.test(value) && !CSS.supports(property, value) && CSS.supports(property, value + 'px')) value += 'px'
        applyStyle(property, value)
      })
      input.addEventListener('keydown', (event) => { if (event.key === 'Enter') input.blur() })
      field.append(element('span', '', label), input)
      if (colorFields.some(([key]) => key === property)) {
        field.classList.add('color-field')
        if (tokenList().length) {
          const usages = selected.map((node) => ({ node, property }))
          field.append(tokenMenu(label, usages, input.value))
        }
      }
      grid.append(field)
    }
    group.append(grid)
    list.append(group)
  }
}

async function sendSelectionToChat(node) {
  const board = owner(node)
  if (!board) return
  const path = layerPath(node)
  const identity = ['data-wb-id', 'id', 'data-mode'].map((name) => ({ name, value: node.getAttribute(name) })).find(({ value }) => value)
  try {
    const packet = await request(`/api/context?file=${encodeURIComponent(board.file)}`, jsonRequest('POST', {
      selections: [{ tag: node.localName, path, identity, textHint: node.textContent.trim().slice(0, 80) }],
    }))
    publishContext(packet)
    notify('已添加到对话上下文')
  } catch (error) {
    notify(error.message, true)
  }
}

// The workbench runs inside an iframe in the DSH panel.
function publishContext(packet) {
  const first = packet.selections[0] || {}
  const message = {
    type: 'html-workbench:context',
    filePath: packet.filePath,
    fileName: packet.fileName,
    revision: packet.revision,
    key: first.identity ? `${first.identity.name}=${first.identity.value}` : `path:${(first.path || []).join('-')}`,
    label: first.selector || first.tag || 'element',
    textHint: first.text || '',
    markdown: packet.markdown,
  }
  if (window.parent !== window) window.parent.postMessage(message, '*')
  else navigator.clipboard?.writeText(packet.markdown).catch(() => {})
}

const previewBridge = `<script>
(() => {
const send = (kind, data) => parent.postMessage({ type: 'html-workbench:preview', kind, ...data }, '*')
;${trackPageHeight.toString()}
;${canScrollInside.toString()}
trackPageHeight(document, (height) => send('height', { height }))
document.addEventListener('wheel', (event) => {
  if (canScrollInside(event)) return
  event.preventDefault()
  send('pan', { x: event.deltaX, y: event.deltaY })
}, { passive: false })
document.addEventListener('click', (event) => {
  const fragment = event.target.closest?.('a[href^="#"]')?.getAttribute('href')
  if (event.defaultPrevented || !fragment || fragment.length < 2) return
  let id
  try { id = decodeURIComponent(fragment.slice(1)) } catch { return }
  const target = document.getElementById(id)
  if (target) {
    event.preventDefault()
    send('anchor', { top: target.getBoundingClientRect().top + scrollY })
  }
})
})()
</script>`

window.addEventListener('message', ({ source, data }) => {
  if (mode !== 'preview' || data?.type !== 'html-workbench:preview') return
  const board = [...boards.values()].find((item) => item.preview.contentWindow === source)
  if (!board) return
  if (data.kind === 'height') setBoardHeight(board, data.height, true)
  if (data.kind === 'pan' && Number.isFinite(data.x) && Number.isFinite(data.y)) panCanvas(data.x, data.y)
  if (data.kind === 'anchor' && Number.isFinite(data.top)) {
    view = { ...view, y: 24 - (board.y + board.surface.offsetTop + data.top) * view.scale }
    transform()
    rememberLayout()
  }
})

function previewBoard(board) {
  board.preview.hidden = mode !== 'preview'
  board.frame.hidden = mode === 'preview'
  board.overlay.hidden = mode === 'preview'
  board.surface.style.height = board.height + 'px'
  if (mode === 'preview') {
    board.previewHeight = undefined
    board.preview.srcdoc = frameSource(board, board.current) + previewBridge
  } else {
    board.preview.removeAttribute('srcdoc')
    board.heightTracker?.schedule()
  }
}

function shortcuts(event) {
  if (event.key === 'Alt') setMeasuring(true)
  if (event.target?.closest?.('input,textarea,select,[contenteditable]')) return
  const command = event.metaKey || event.ctrlKey
  const key = event.key.toLowerCase()
  if (event.code === 'Space' && mode === 'edit') {
    spaceDown = true
    canvas.dataset.panning = 'true'
    event.preventDefault()
  }
  if (command && key === 'z') {
    event.preventDefault()
    if (event.shiftKey) void historyStep(redoStack, undoStack, 'after')
    else void historyStep(undoStack, redoStack, 'before')
  }
  if (command && key === 's') { event.preventDefault(); void save() }
  if (key === 'escape') { selection.clear(); updateSelection(); toggleFiles(false) }
  if (event.shiftKey && event.code === 'Digit1') fit()
  if (event.shiftKey && event.code === 'Digit2') focusSelection()
  if (key === 'enter' && selection.size === 1) {
    const node = [...selection][0]
    const target = event.shiftKey ? node.parentElement : children(node)[0]
    if (target && !target.matches('body,html')) select(target)
  }
}

function releaseSpace(event) {
  if (!event || event.key === 'Alt') setMeasuring(false)
  if (!event || event.code === 'Space') {
    spaceDown = false
    delete canvas.dataset.panning
  }
}

function toggleFiles(show) {
  qs('#file-popover').hidden = !show
  qs('#file-menu-button').setAttribute('aria-expanded', String(show))
}

async function browseDirectory() {
  const path = qs('#directory-input').value.trim()
  if (!path) return
  try {
    const result = await request(`/api/files?directory=${encodeURIComponent(path)}`)
    const list = qs('#file-list')
    const search = element('input')
    search.type = 'search'
    search.placeholder = '搜索 HTML'
    search.setAttribute('aria-label', '搜索 HTML')
    const rows = result.files.map((file) => {
      const label = element('label')
      const check = element('input')
      check.type = 'checkbox'
      check.checked = boards.has(file.path)
      label.append(check, file.relativePath)
      return { file, label, check }
    })
    search.addEventListener('input', () => {
      for (const { label, file } of rows) label.hidden = !file.relativePath.toLowerCase().includes(search.value.trim().toLowerCase())
    })
    list.replaceChildren(search, ...rows.map(({ label }) => label), button('添加选中 HTML 到画布', async () => {
      const chosen = rows.filter(({ check }) => check.checked).map(({ file }) => file)
      if (!chosen.length) return
      let restored = []
      if (directory !== result.directory) {
        await save()
        if (allBoards().some((board) => board.current !== board.disk)) return
        rememberLayout()
        for (const board of [...boards.values()]) {
          if (!result.files.some((file) => file.path === board.file)) {
            board.card.remove()
            boards.delete(board.file)
          }
        }
        backgroundBoards.forEach((board) => board.card.remove())
        backgroundBoards.clear()
        selection.clear()
        undoStack.length = 0
        redoStack.length = 0
        if (active && !boards.has(active.file)) active = undefined
        directory = result.directory
        layout = readLayout()
        restored = result.files.filter((file) => (layout.files || []).some((saved) => (saved.path || saved) === file.path))
      }
      await openFiles([...new Map([...chosen, ...restored].map((file) => [file.path, file])).values()])
      fit()
      toggleFiles(false)
    }))
    list.hidden = false
  } catch (error) {
    notify(error.message, true)
  }
}

function zoomAt(x, y, delta) {
  const rect = canvas.getBoundingClientRect()
  const point = { x: x - rect.left, y: y - rect.top }
  const scale = Math.max(.04, Math.min(4, view.scale * Math.exp(-delta * .005)))
  const ratio = scale / view.scale
  view = { x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio, scale }
  transform()
  rememberLayout()
}

function bindCanvas() {
  canvas.addEventListener('wheel', (event) => {
    if (!event.ctrlKey && !event.metaKey && mode !== 'edit') return
    event.preventDefault()
    if (event.ctrlKey || event.metaKey) {
      zoomAt(event.clientX, event.clientY, event.deltaY)
      return
    }
    panCanvas(event.deltaX, event.deltaY)
  }, { passive: false })
  canvas.addEventListener('pointerdown', (event) => {
    if (spaceDown || event.button === 1) {
      event.preventDefault()
      const { x, y } = view
      pointerDrag(canvas, event, (dx, dy) => { view = { ...view, x: x + dx, y: y + dy }; transform() }, rememberLayout)
      return
    }
    if (event.button || mode !== 'edit' || event.target.closest('.board-card')) return
    const marquee = qs('#canvas-marquee')
    const canvasBounds = canvas.getBoundingClientRect()
    const x = event.clientX - canvasBounds.left
    const y = event.clientY - canvasBounds.top
    const previous = event.shiftKey ? [...selection] : []
    let box
    pointerDrag(canvas, event, (dx, dy) => {
      box = { left: Math.min(x, x + dx), top: Math.min(y, y + dy), width: Math.abs(dx), height: Math.abs(dy) }
      marquee.hidden = false
      for (const [key, value] of Object.entries(box)) marquee.style[key] = `${value}px`
    }, () => {
      marquee.hidden = true
      selection.clear()
      previous.forEach((node) => selection.add(node))
      if (box?.width > 3 && box.height > 3) {
        for (const board of boards.values()) {
          if (!board.doc) continue
          const bounds = board.frame.getBoundingClientRect()
          for (const node of children(board.doc.body)) {
            const rect = node.getBoundingClientRect()
            const left = bounds.left - canvasBounds.left + rect.x * view.scale
            const top = bounds.top - canvasBounds.top + rect.y * view.scale
            if (!locked(node) && rect.width && rect.height && left < box.left + box.width &&
                top < box.top + box.height && left + rect.width * view.scale > box.left &&
                top + rect.height * view.scale > box.top) selection.add(node)
          }
        }
      }
      if (box?.width > 3 && box.height > 3) revealSelectionPanels()
      updateSelection()
    })
  })
}

async function keepFilesInSync() {
  if (writing || restoring || browsing || polling || draggingCanvas || !boards.size) return
  polling = true
  await Promise.all([...boards.values()].map(async (board) => {
    try {
      const known = board.revision
      const data = await request(documentRoute(board.file))
      if (writing || restoring || browsing || draggingCanvas || !boards.has(board.file) || board.revision !== known || data.revision === known) return
      if (board.current !== board.disk || editingText?.ownerDocument === board.doc) {
        board.conflict = true
        updateSaveStatus()
        return
      }
      clearDocumentHistory(board)
      for (const node of selection) if (node.ownerDocument === board.doc) selection.delete(node)
      board.revision = data.revision
      board.disk = data.html
      board.current = data.html
      await paint(board, data.html, data.locations)
      previewBoard(board)
      updateSelection()
    } catch {
      // A later poll retries transient reads.
    }
  })).finally(() => { polling = false })
}

const blockContainers = 'body,main,section,article,div,header,footer,aside,li,td,th,blockquote,form'

function insertBlock(markup) {
  if (!active?.doc || mode !== 'edit') return
  const doc = active.doc
  const selected = [...selection].reverse().find((node) => node.ownerDocument === doc && !locked(node))
  const template = doc.createElement('template')
  template.innerHTML = markup
  const added = template.content.firstElementChild
  const defaultContainer = doc.querySelector('main') || doc.body
  const container = selected?.closest(blockContainers) || defaultContainer
  if (locked(container)) return
  mutate([container], () => {
    if (!selected || selected === container) {
      container.prepend(added)
    } else {
      let anchor = selected
      while (anchor.parentElement !== container) anchor = anchor.parentElement
      anchor.after(added)
    }
    selection.clear()
    selection.add(added)
    revealSelectionPanels()
    const bounds = canvas.getBoundingClientRect()
    const frame = active.frame.getBoundingClientRect()
    const box = added.getBoundingClientRect()
    if (frame.top + box.bottom * view.scale < bounds.top ||
        frame.top + box.top * view.scale > bounds.bottom ||
        frame.left + box.right * view.scale < bounds.left ||
        frame.left + box.left * view.scale > bounds.right) focusSelection()
  })
}

function bindControls() {
  qs('#directory-input').value = directory
  qs('#file-menu-button').onclick = () => toggleFiles(qs('#file-popover').hidden)
  qs('#browse-button').onclick = browseDirectory
  qs('#directory-input').onkeydown = (event) => { if (event.key === 'Enter') void browseDirectory() }
  const open = async () => {
    const path = qs('#file-input').value.trim()
    if (path) await openFiles([{ path }], path)
    toggleFiles(false)
  }
  qs('#open-button').onclick = open
  qs('#file-input').onkeydown = (event) => { if (event.key === 'Enter') void open() }
  qs('#layer-search').oninput = renderLayers
  qs('#close-panel-button').onclick = () => setPanels('', !inspector.hidden)
  qs('#close-inspector-button').onclick = () => setPanels(leftPanel(), false)
  qs('#pin-panel-button').hidden = true
  qs('#token-button').onclick = () => {
    qs('#token-panel').hidden = !qs('#token-panel').hidden
    renderTokens()
  }
  for (const toggle of document.querySelectorAll('[data-panel]')) toggle.onclick = () => {
    const panel = toggle.dataset.panel
    if (panel === 'styles') {
      setPanels(narrow.matches ? '' : leftPanel(), inspector.hidden)
    } else {
      setPanels(leftPanel() === panel ? '' : panel, !narrow.matches && !inspector.hidden)
    }
  }
  for (const control of document.querySelectorAll('.mode-button')) control.onclick = () => {
    mode = control.dataset.mode
    setHover(null)
    setMeasuring(false)
    workbench.dataset.mode = mode
    for (const item of document.querySelectorAll('.mode-button')) {
      item.classList.toggle('active', item === control)
      item.setAttribute('aria-pressed', String(item === control))
    }
    for (const board of boards.values()) {
      previewBoard(board)
      if (mode === 'edit') drawBoardSelection(board)
    }
  }
  for (const control of document.querySelectorAll('[data-width]')) control.onclick = () => {
    if (!active) return
    active.width = Number(control.dataset.width)
    boardGeometry(active)
    active.heightTracker?.schedule()
    activate(active)
    rememberLayout()
  }
  qs('#fit-button').onclick = () => fit()
  qs('#fit-button').title = '适应全部画板（Shift+1）'
  qs('#save-button').onclick = save
  qs('#undo-button').onclick = () => historyStep(undoStack, redoStack, 'before')
  qs('#redo-button').onclick = () => historyStep(redoStack, undoStack, 'after')
  qs('#context-button').onclick = () => {
    const first = [...selection][0]
    if (first) void sendSelectionToChat(first)
  }
  qs('#replace-image-button').onclick = () => {
    const first = [...selection][0]
    if (!first?.matches('img')) return notify('请先选中图片。', true)
    const src = prompt('图片地址', first.getAttribute('src') || '')
    if (src !== null) mutate([first], () => first.setAttribute('src', src))
  }
  for (const attribute of ['src', 'alt', 'href']) {
    const input = qs(`#${attribute}-input`)
    input.onchange = () => {
      const first = [...selection][0]
      if (first) mutate([first], () => first.setAttribute(attribute, input.value))
    }
  }
  qs('#font-family-input').onchange = (event) => {
    const name = event.target.value.trim()
    if (!name) return
    const family = findFontFamily(name)?.family || name
    const generic = genericFonts.has(family.toLowerCase())
    const current = commonValue([...selection], 'font-family')
    const fallbacks = splitCss(current, (char) => char === ',').slice(1)
    applyStyle('font-family', generic ? family : [JSON.stringify(family), ...(fallbacks.length ? fallbacks : ['sans-serif'])].join(', '))
  }
  qs('#font-load-button').onclick = loadLocalFonts
  const blocks = [['文本', '<p>双击编辑文字</p>'], ['区块', '<section><h2>新章节</h2><p>输入正文</p></section>'], ['图片', '<img alt="" width="240" height="160">']]
  for (const [label, markup] of blocks) qs('#blocks-panel').append(button(label, () => insertBlock(markup)))
  document.addEventListener('keydown', shortcuts)
  document.addEventListener('keyup', releaseSpace)
  window.addEventListener('blur', () => releaseSpace())
  window.addEventListener('beforeunload', (event) => {
    if (allBoards().some((board) => board.current !== board.disk)) event.preventDefault()
  })
}

bindControls()
bindCanvas()
setPanels(narrow.matches ? '' : 'layers', !narrow.matches)
renderInspector()
const initial = params.get('file')
async function start() {
  if (initial && !directory) {
    try {
      const data = await request(documentRoute(initial))
      directory = data.directory
      layout = readLayout()
      view = layout.view || view
      qs('#directory-input').value = directory
    } catch (error) { notify(error.message, true) }
  }
  const restored = (layout.files || []).map((file) => typeof file === 'string' ? { path: file } : file)
  const files = initial && !restored.some(({ path }) => path === initial) ? [{ path: initial }, ...restored] : restored
  await openFiles(files, initial)
  transform()
  setInterval(keepFilesInSync, 2500)
}
void start()
