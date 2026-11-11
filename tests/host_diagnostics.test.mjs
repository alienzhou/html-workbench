/**
 * Host diagnostics — regression tests for observable start failures.
 *
 * The bug these pin: a service that failed to start showed up as nothing but a
 * red dot. The cause (a Python traceback, a busy port, a missing interpreter)
 * lived inside the DSH Node process and was never read, because `shell.start()`
 * output was discarded and a dead process was still polled for the full 60s.
 *
 * These tests drive the real `src/host.js` body against a stubbed `shell`, so
 * they assert on the exact payload the panel renders.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOST_BODY = readFileSync(resolve(HERE, '..', 'dsh-plugin', 'src', 'host.js'), 'utf8')

// The body is a bare `return { ... }`; wrap and call it exactly like the loader.
const loadPlugin = () => new Function(HOST_BODY)()

const collected = (text) => ({ text, truncated: false })

/** A Cordis-ish context that records the routes the plugin registers. */
const makeContext = (shell, { assumePython = true } = {}) => {
  if (shell && assumePython) {
    const version = { exitCode: 0, stdout: collected('Python 3.12.0') }
    const isVersionProbe = (spec) => spec.command === 'python3 --version'
    const executor = shell
    shell = { ...executor }
    if (executor.run) shell.run = (spec) => isVersionProbe(spec) ? version : executor.run(spec)
    if (executor.execute) {
      shell.execute = (spec) => isVersionProbe(spec) ? { result: () => version } : executor.execute(spec)
    }
  }
  const routes = new Map()
  const webServer = { register: ({ path, handler }) => (routes.set(path, handler), () => routes.delete(path)) }
  return {
    routes,
    get: (name) => (name === 'shell' ? shell : name === 'webServer' ? webServer : undefined),
    on: () => {},
    effect: (fn) => fn(),
    timeout: (ms) => new Promise((done) => setTimeout(done, Math.min(ms, 1))),
    interval: () => () => {},
  }
}

const callRoute = async (ctx, path) => {
  const handler = ctx.routes.get(path.split('?')[0])
  assert.ok(handler, `route not registered: ${path}`)
  let body = null
  await handler({ url: path }, { writeHead() {}, end(payload) { body = JSON.parse(payload) } })
  return body
}

/** A shell whose `serve` dies immediately, reporting `output` once. */
const dyingShell = (output, exitCode = 1) => ({
  resolve: (spec) => spec,
  run: async () => ({ exitCode: 1, signal: null, timedOut: false, aborted: false, timeoutMs: 8000, stdout: collected(''), stderr: collected('') }),
  start: () => {
    let drained = false
    return {
      status: 'completed',
      exitCode,
      signal: null,
      readOutput: () => (drained ? { delta: '', lossy: false } : ((drained = true), { delta: output, lossy: false })),
      kill: () => true,
    }
  },
})

const healthyShell = (version = '2.1.0') => ({
  resolve: (spec) => spec,
  run: async () => ({ exitCode: 0, stdout: collected(JSON.stringify({ ok: true, service: 'html-workbench', version })), stderr: collected('') }),
  start: () => ({ status: 'running', exitCode: null, signal: null, readOutput: () => ({ delta: '' }), kill: () => true }),
})

const boot = async (shell, config) => {
  const ctx = makeContext(shell, { assumePython: config?.platform !== 'win32' })
  loadPlugin().apply(ctx, { script: '/tmp/fake/workbench.py', ...config })
  // `apply` kicks off startService without awaiting; give it room to settle.
  await new Promise((done) => setTimeout(done, 150))
  return ctx
}

// Silence the deliberate console.error from failure paths under test.
const quiet = (fn) => async () => {
  const original = console.error
  console.error = () => {}
  try { await fn() } finally { console.error = original }
}

test('a Python traceback reaches the diagnostics payload verbatim', quiet(async () => {
  const traceback = 'Traceback (most recent call last):\n  File "workbench.py", line 1\n  ModuleNotFoundError: No module named \'http\''
  const ctx = await boot(dyingShell(traceback), { port: 4901 })
  const diag = await callRoute(ctx, '/html-workbench/diagnostics')

  assert.equal(diag.running, false)
  assert.match(diag.startError, /serve 进程已退出/)
  const detail = diag.journal.map((entry) => entry.detail || '').join('\n')
  assert.ok(detail.includes("No module named 'http'"), 'the traceback must be readable in the journal')
}))

test('static host logs rotate and keep startup failures across plugin reloads', quiet(async () => {
  const { apply } = await import('../dsh-plugin/src/index.js')
  const runtimeDir = mkdtempSync(join(tmpdir(), 'hwb-host-test-'))
  try {
    const logFile = join(runtimeDir, 'logs', 'dsh-host-4950.log')
    mkdirSync(dirname(logFile))
    writeFileSync(logFile, 'x'.repeat(1024 * 1024))
    const first = makeContext(dyingShell('Traceback: failed to import Python module'))
    apply(first, { port: 4950, runtimeDir })
    await new Promise(resolve => setImmediate(resolve))

    const next = makeContext(healthyShell())
    apply(next, { port: 4950, runtimeDir })
    await new Promise(resolve => setImmediate(resolve))

    const report = await callRoute(next, '/html-workbench/diagnostics')
    assert.equal(report.hostLogFile, logFile)
    assert.equal(report.hostLogError, null)
    assert.ok(readFileSync(logFile + '.1').length >= 1024 * 1024)
    const entries = readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(entries.filter(entry => entry.message === '插件宿主已加载').length, 2)
    assert.ok(entries.some(entry => entry.detail?.includes('Traceback: failed to import Python module')))
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true })
  }
}))

test('a missing host log leaves the journal and service usable', quiet(async () => {
  const ctx = await boot(healthyShell(), { hostLog: {
    file: '/unwritable/dsh-host.log',
    append() { throw new Error('EACCES: log file denied') },
  } })
  const report = await callRoute(ctx, '/html-workbench/diagnostics')
  assert.equal(report.running, true)
  assert.match(report.hostLogError, /EACCES/)
  assert.ok(report.journal.length > 0)
}))

test('repeated failures stay counted without flooding the host log', quiet(async () => {
  const entries = []
  const ctx = await boot(dyingShell('same failure'), {
    hostLog: { file: 'host.log', append(entry) { entries.push(entry) } },
  })
  for (let i = 0; i < 10; i += 1) await callRoute(ctx, '/html-workbench/restart')
  const diag = await callRoute(ctx, '/html-workbench/diagnostics')
  const failures = entries.filter(entry => entry.message.includes('serve 进程已退出'))
  assert.equal(failures.length, 1)
  assert.ok(diag.journal.some(entry => entry.repeated >= 10))
}))

test('an owned live process refreshes its log-write failure status', async () => {
  let started = false
  let logError = null
  const shell = healthyShell()
  shell.run = async () => started
    ? { exitCode: 0, stdout: collected(JSON.stringify({ ok: true, service: 'html-workbench',
      logging: { error: logError, droppedRecords: logError ? 3 : 0 } })) }
    : { exitCode: 1 }
  const start = shell.start
  shell.start = () => { started = true; return start() }
  const ctx = await boot(shell)
  assert.equal((await callRoute(ctx, '/html-workbench/diagnostics')).owned, true)
  logError = 'disk full'
  const now = Date.now
  Date.now = () => now() + 11000
  try {
    await callRoute(ctx, '/html-workbench/diagnostics')
    await new Promise(resolve => setImmediate(resolve))
    const report = await callRoute(ctx, '/html-workbench/diagnostics')
    assert.equal(report.service.logging.error, 'disk full')
    assert.equal(report.service.logging.droppedRecords, 3)
  } finally {
    Date.now = now
  }
})

for (const platform of ['win32', 'linux', 'darwin']) {
  test(platform + ' quotes configured Python paths with spaces and Unicode', async () => {
    const commands = []
    const shell = healthyShell()
    const run = shell.run
    shell.run = spec => spec.command.endsWith(' --version')
      ? { exitCode: 0, stdout: collected('Python 3.12.0') } : run(spec)
    shell.resolve = spec => { commands.push(spec.command); return spec }
    const executable = platform === 'win32' ? 'C:\\测试 Tools\\Python\\python.exe' : '/tmp/测试 Tools/python3'
    const ctx = await boot(shell, { platform, pythonCommand: executable })
    assert.equal((await callRoute(ctx, '/html-workbench/diagnostics')).running, true)
    assert.ok(commands.some(command => command.endsWith(' --version')))
    assert.ok(commands.some(command => command.includes(' health --port ')))
    assert.ok(commands.some(command => command.startsWith(
      platform === 'win32' ? '"' + executable + '" ' : "'" + executable + "' ",
    )))
  })
}

test('Windows dynamic fallback uses its workspace when TEMP variables are absent', async () => {
  const ctx = makeContext(healthyShell())
  new Function('process', HOST_BODY)({
    platform: 'win32', env: {}, version: 'test', arch: 'x64',
    cwd: () => 'C:\\测试 Workspace',
  }).apply(ctx, { script: 'C:/plugin/workbench.py', pythonCommand: 'python' })
  await new Promise(resolve => setImmediate(resolve))
  const diag = await callRoute(ctx, '/html-workbench/diagnostics')
  assert.equal(diag.runtimeDir, 'C:\\测试 Workspace/.html-workbench')
  const resolved = await callRoute(ctx, '/html-workbench/resolve?file=' + encodeURIComponent('file:///C:/测试%20Workspace/page.html'))
  assert.equal(resolved.normalized, 'C:/测试 Workspace/page.html')
})

test("the CLI's structured error becomes the headline, raw line kept as detail", quiet(async () => {
  // This is the exact stderr line workbench.py emits when the port is taken.
  const line = '{"ok": false, "error": "PORT_IN_USE", "message": "[Errno 48] Address already in use"}'
  const ctx = await boot(dyingShell(line), { port: 4902 })
  const diag = await callRoute(ctx, '/html-workbench/diagnostics')

  assert.match(diag.startError, /端口已被占用/, 'a person must be able to act on the headline')
  assert.match(diag.startError, /PORT_IN_USE/, 'the machine code stays for searchability')
  const detail = diag.journal.map((entry) => entry.detail || '').join('\n')
  assert.ok(detail.includes('Errno 48'), 'the original line must survive translation')
}))

test('an exited process is not polled for the full timeout', quiet(async () => {
  const started = Date.now()
  const ctx = await boot(dyingShell('boom'), { port: 4903 })
  const diag = await callRoute(ctx, '/html-workbench/diagnostics')

  assert.equal(diag.running, false)
  assert.ok(diag.startError, 'the failure must be recorded, not silently retried')
  // The old code polled 240 times regardless; noticing the exit must be prompt.
  assert.ok(Date.now() - started < 2000, 'a dead process must not look like a hang')
}))

test('diagnostics carry the facts needed to reproduce by hand', quiet(async () => {
  const ctx = await boot(dyingShell('boom'), { port: 4904, editorRoot: '/tmp/root' })
  const diag = await callRoute(ctx, '/html-workbench/diagnostics')

  assert.equal(diag.port, 4904)
  assert.equal(diag.script, '/tmp/fake/workbench.py')
  assert.equal(diag.editorRoot, '/tmp/root')
  assert.equal(diag.hasShell, true)
}))

test('a missing shell service is named, not swallowed', quiet(async () => {
  const ctx = await boot(undefined, { port: 4905 })
  const diag = await callRoute(ctx, '/html-workbench/diagnostics')

  assert.equal(diag.hasShell, false)
  assert.match(diag.startError, /shell 服务不可用/)
}))

test('a failed open carries the diagnostics with it', quiet(async () => {
  const ctx = await boot(dyingShell('boom'), { port: 4906 })
  const body = await callRoute(ctx, '/html-workbench/open?file=%2Ftmp%2Fpage.html')

  assert.equal(body.ok, false)
  assert.ok(body.diagnostics, 'the panel must be able to explain the failure in place')
  assert.ok(body.diagnostics.journal.length > 0)
}))

test('the journal also explains a HEALTHY service, not just failures', async () => {
  const ctx = await boot(healthyShell('2.1.0'), { port: 4907 })
  const diag = await callRoute(ctx, '/html-workbench/diagnostics')

  assert.equal(diag.running, true)
  assert.equal(diag.startError, null)
  assert.ok(diag.journal.length > 0, 'the current state must be traceable too')
  assert.match(diag.journal[0].message, /2\.1\.0/)
})

test('restart clears the port before spawning, and reports success', async () => {
  const commands = []
  let healthy = false
  const shell = {
    resolve: (spec) => spec,
    run: async (spec) => {
      commands.push(spec.command)
      if (spec.command.includes(' stop ')) return { exitCode: 0, stdout: collected('{"ok": true}'), stderr: collected('') }
      if (healthy && spec.command.includes(' health ')) {
        return { exitCode: 0, stdout: collected(JSON.stringify({ ok: true, service: 'html-workbench', version: '2.1.0' })), stderr: collected('') }
      }
      return { exitCode: 1, stdout: collected(''), stderr: collected('') }
    },
    start: () => { healthy = true; return { status: 'running', exitCode: null, signal: null, readOutput: () => ({ delta: '' }), kill: () => true } },
  }
  const ctx = await boot(shell, { port: 4908 })
  const body = await callRoute(ctx, '/html-workbench/restart')

  assert.equal(body.ok, true)
  // Without this, a restart into a port held by a process we do not own would
  // simply fail again with PORT_IN_USE.
  assert.ok(commands.some((c) => c.includes('stop --port 4908')), 'restart must free the port first')
})

test('restart refuses when the port cannot be freed', quiet(async () => {
  const shell = {
    resolve: (spec) => spec,
    run: async (spec) => (spec.command.includes(' stop ')
      ? { exitCode: 1, stdout: collected(''), stderr: collected('{"ok": false, "error": "SERVER_OUTDATED"}') }
      : { exitCode: 1, stdout: collected(''), stderr: collected('') }),
    start: () => { throw new Error('must not spawn while the port is busy') },
  }
  const ctx = await boot(shell, { port: 4909 })
  const body = await callRoute(ctx, '/html-workbench/restart')

  assert.equal(body.ok, false)
  assert.match(body.error, /无法停止/)
}))

test('a service that dies AFTER starting is reported, not left stale', quiet(async () => {
  // The exact state the live plugin got stuck in: it reported a running service
  // while every open failed, because nothing ever re-checked. Covers the reused
  // path (no process handle) — the harder of the two.
  let healthy = true
  const shell = {
    resolve: (spec) => spec,
    run: async () => (healthy
      ? { exitCode: 0, stdout: collected(JSON.stringify({ ok: true, service: 'html-workbench', version: '2.1.0' })), stderr: collected('') }
      : { exitCode: 1, stdout: collected(''), stderr: collected('') }),
    start: () => ({ status: 'running', exitCode: null, signal: null, readOutput: () => ({ delta: '' }), kill: () => true }),
  }
  const ctx = await boot(shell, { port: 4910 })
  assert.equal((await callRoute(ctx, '/html-workbench/diagnostics')).running, true, 'sanity: healthy first')

  // The service dies underneath us. Revalidation is throttled to spare
  // subprocesses, so advance the clock rather than sleeping through the window.
  healthy = false
  const realNow = Date.now
  Date.now = () => realNow() + 11000
  try {
    await callRoute(ctx, '/html-workbench/diagnostics')
    await new Promise((done) => setTimeout(done, 80))
  } finally {
    Date.now = realNow
  }
  const after = await callRoute(ctx, '/html-workbench/diagnostics')

  assert.equal(after.running, false, 'the dot must go red on its own')
  assert.ok(after.startError, 'the death must be explained')
  assert.ok(
    after.journal.some((entry) => entry.message.includes('失去响应')),
    'the loss must be journalled where the user looks',
  )
}))

test('a healthy reused service is not re-checked on every poll', async () => {
  // The panel polls every few seconds; revalidation spawns a subprocess. Without
  // throttling this would fork python3 continuously in the background.
  let healthCalls = 0
  const shell = {
    resolve: (spec) => spec,
    run: async () => {
      healthCalls += 1
      return { exitCode: 0, stdout: collected(JSON.stringify({ ok: true, service: 'html-workbench', version: '2.1.0' })), stderr: collected('') }
    },
    start: () => ({ status: 'running', exitCode: null, signal: null, readOutput: () => ({ delta: '' }), kill: () => true }),
  }
  const ctx = await boot(shell, { port: 4912 })
  const baseline = healthCalls
  for (let i = 0; i < 5; i += 1) await callRoute(ctx, '/html-workbench/diagnostics')
  await new Promise((done) => setTimeout(done, 50))

  assert.equal(healthCalls, baseline, 'five polls inside the window must cost zero subprocesses')
})

test('an owned process that exits is reaped without a subprocess call', quiet(async () => {
  const handle = {
    status: 'running',
    exitCode: null,
    signal: null,
    readOutput: () => ({ delta: handle.status === 'running' ? '' : 'KeyboardInterrupt' }),
    kill: () => true,
  }
  let healthy = false
  const shell = {
    resolve: (spec) => spec,
    run: async () => (healthy
      ? { exitCode: 0, stdout: collected(JSON.stringify({ ok: true, service: 'html-workbench', version: '2.1.0' })), stderr: collected('') }
      : { exitCode: 1, stdout: collected(''), stderr: collected('') }),
    start: () => { healthy = true; return handle },
  }
  const ctx = await boot(shell, { port: 4911 })
  const before = await callRoute(ctx, '/html-workbench/diagnostics')
  assert.equal(before.owned, true, 'sanity: the plugin owns the process')

  handle.status = 'completed'
  handle.exitCode = 1
  const after = await callRoute(ctx, '/html-workbench/diagnostics')

  assert.equal(after.running, false)
  assert.equal(after.owned, false, 'a dead handle must be released')
  assert.ok(after.journal.some((entry) => entry.message.includes('意外退出')))
}))

test('the panel reports the directories the service really uses', async () => {
  // The service re-probes in-process and falls back, because the runtime paths it
  // is handed may be exactly what the sandbox refuses (DSH grants only the
  // workspace and a private temp folder). Echoing the REQUESTED paths afterwards
  // is what made a perfectly healthy service look broken to its own user.
  const shell = {
    resolve: (spec) => spec,
    run: async () => ({
      exitCode: 0,
      stdout: collected(JSON.stringify({
        ok: true,
        service: 'html-workbench',
        version: '2.1.0',
        logDir: 'C:\\ws\\.html-workbench\\logs',
        vendorCache: 'C:\\ws\\.html-workbench\\vendor',
      })),
      stderr: collected(''),
    }),
    start: () => ({ status: 'running', exitCode: null, signal: null, readOutput: () => ({ delta: '' }), kill: () => true }),
  }
  const ctx = await boot(shell, { port: 4913, runtimeDir: 'C:/Temp/.html-workbench' })
  const diag = await callRoute(ctx, '/html-workbench/diagnostics')

  assert.equal(diag.logDir, 'C:\\ws\\.html-workbench\\logs')
  assert.equal(diag.vendorCache, 'C:\\ws\\.html-workbench\\vendor')
})

test('a service that advertises no directories keeps the requested ones', async () => {
  // Backwards compatibility: an already-running 0.3.0-era service cannot report
  // them, and the panel must still say something rather than nothing.
  const ctx = await boot(healthyShell('2.1.0'), { port: 4914, runtimeDir: 'C:/Temp/.html-workbench' })
  const diag = await callRoute(ctx, '/html-workbench/diagnostics')

  assert.equal(diag.logDir, 'C:/Temp/.html-workbench/logs')
  assert.equal(diag.vendorCache, 'C:/Temp/.html-workbench/vendor')
})

test('host and service agree on one runtime folder name', () => {
  // Two different names would scatter two directories through the user's
  // workspace: the host's first guess and the service's own fallback must match.
  const service = readFileSync(resolve(HERE, '..', 'service', 'server', 'workbench.py'), 'utf8')
  const declared = /^RUNTIME_DIR_NAME = "([^"]+)"/m.exec(service)
  assert.ok(declared, 'workbench.py must declare RUNTIME_DIR_NAME')

  for (const name of ['dsh-plugin/src/host.js', 'dsh-plugin/src/index.js']) {
    const source = readFileSync(resolve(HERE, '..', name), 'utf8')
    assert.ok(source.includes(declared[1]), `${name} must reference ${declared[1]}`)
  }
})

test('the host marks the runtime directory it probes as git-ignored', async () => {
  // The probe CREATES the directory, and it usually lands in the user's own
  // repository. Whichever half gets there first must hide it, or simply opening
  // the panel leaves an untracked folder in someone else's `git status`.
  const { mkdtempSync, existsSync, readFileSync: read } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const workspace = mkdtempSync(resolve(tmpdir(), 'hwb-probe-'))
  const previous = process.cwd()
  try {
    process.chdir(workspace)
    // Fresh module registry: `runtimeDir` is resolved once at import time.
    await import(`../dsh-plugin/src/index.js?probe=${Date.now()}`)

    const marker = resolve(workspace, '.html-workbench', '.gitignore')
    assert.ok(existsSync(marker), 'the probed runtime directory must ignore itself')
    assert.match(read(marker, 'utf8'), /^\*$/m)
  } finally {
    process.chdir(previous)
  }
})
test('Windows falls back from python3 to python for every CLI call', async () => {
  const commands = []
  const shell = {
    resolve: (spec) => (commands.push(spec.command), spec),
    run: async (spec) => {
      if (spec.command === 'python3 --version') return { exitCode: 1, stdout: collected(''), stderr: collected('not found') }
      if (spec.command === 'python --version') return { exitCode: 0, stdout: collected('Python 3.12.0'), stderr: collected('') }
      if (spec.command.includes(' health ')) {
        return { exitCode: 0, stdout: collected(JSON.stringify({ ok: true, service: 'html-workbench', version: '2.1.0' })), stderr: collected('') }
      }
      if (spec.command.includes(' -c ')) return { exitCode: 0, stdout: collected(''), stderr: collected('') }
      return { exitCode: 1, stdout: collected(''), stderr: collected('unexpected command') }
    },
    start: () => { throw new Error('healthy service must be reused') },
  }
  const ctx = await boot(shell, { port: 4913, platform: 'win32', runtimeDir: 'C:/Temp/html-workbench-dsh' })
  const resolved = await callRoute(ctx, '/html-workbench/resolve?file=C%3A%2Ftmp%2Fpage.html')
  const diag = await callRoute(ctx, '/html-workbench/diagnostics')

  assert.equal(resolved.exists, true)
  assert.equal(diag.pythonCommand, 'python')
  assert.equal(diag.runtimeDir, 'C:/Temp/html-workbench-dsh')
  assert.ok(commands.includes('python3 --version'))
  assert.ok(commands.includes('python --version'))
  assert.ok(commands.some((command) => command.startsWith('python "/tmp/fake/workbench.py" health ')))
  assert.ok(commands.some((command) => command.startsWith('python -c ')))
  assert.ok(!commands.some((command) => command.startsWith('py -3 ')), 'stop probing after the first working interpreter')
})

// ── Command-line quoting ────────────────────────────────────────────────────
//
// These pin the bug class that survives an interpreter fix: the path reaches the
// subprocess CORRUPTED, so a correct path is reported as missing and the user is
// told their file does not exist.

test('a Windows path with spaces stays intact through the existence probe', async () => {
  const commands = []
  const shell = {
    resolve: (spec) => (commands.push(spec.command), spec),
    run: async (spec) => {
      if (spec.command === 'python3 --version') return { exitCode: 0, stdout: collected('Python 3.12.0'), stderr: collected('') }
      if (spec.command.includes(' health ')) {
        return { exitCode: 0, stdout: collected(JSON.stringify({ ok: true, service: 'html-workbench', version: '2.1.0' })), stderr: collected('') }
      }
      return { exitCode: 0, stdout: collected(''), stderr: collected('') }
    },
    start: () => { throw new Error('healthy service must be reused') },
  }
  const ctx = await boot(shell, { port: 4914, platform: 'win32', runtimeDir: 'C:/Temp/hwb' })
  const target = 'C:\\Users\\Zhou Hongxuan\\Desktop\\page.html'
  await callRoute(ctx, '/html-workbench/resolve?file=' + encodeURIComponent(target))

  const probe = commands.find((command) => command.includes(' -c '))
  assert.ok(probe, 'the existence probe must run')
  // The old code used JSON.stringify, which emits `\\` — cmd.exe forwards those
  // literally and Python then looks for a path that cannot exist.
  assert.ok(!probe.includes('\\\\'), 'JSON escaping must not reach the command line')
  assert.ok(probe.includes('"' + target + '"'), 'the path must arrive verbatim, quoted for spaces')
})

test('a trailing backslash cannot escape its own closing quote', quiet(async () => {
  const commands = []
  const shell = {
    resolve: (spec) => (commands.push(spec.command), spec),
    run: async (spec) => (spec.command.endsWith('--version')
      ? { exitCode: 0, stdout: collected('Python 3.12.0'), stderr: collected('') }
      : { exitCode: 1, stdout: collected(''), stderr: collected('') }),
    start: () => dyingShell('').start(),
  }
  // `%TEMP%` values legitimately end in a separator; `"C:\dir\"` would escape the
  // quote and merge the next argument into the path.
  const ctx = await boot(shell, { port: 4915, platform: 'win32', runtimeDir: 'C:\\Temp\\hwb\\' })
  await callRoute(ctx, '/html-workbench/diagnostics')

  const serve = commands.find((command) => command.includes(' serve '))
  assert.ok(serve, 'serve must be attempted')
  // One quoted token: the separator is normalised away, so nothing turns into
  // `C:\Temp\hwb\/logs`, and no backslash is left escaping the closing quote.
  assert.ok(serve.includes('--log-dir "C:\\Temp\\hwb/logs"'), 'a quoted path must stay one argument')
  assert.ok(!serve.includes('\\/'), 'a trailing separator must not survive concatenation')
  assert.ok(!/[^\\]\\"/.test(serve), 'no closing quote may be left escaped by a backslash')
}))

test('a POSIX path with a quote is escaped, not injected', async () => {
  const commands = []
  const shell = {
    resolve: (spec) => (commands.push(spec.command), spec),
    run: async (spec) => (spec.command.includes(' health ')
      ? { exitCode: 0, stdout: collected(JSON.stringify({ ok: true, service: 'html-workbench', version: '2.1.0' })), stderr: collected('') }
      : { exitCode: 0, stdout: collected(''), stderr: collected('') }),
    start: () => { throw new Error('healthy service must be reused') },
  }
  const ctx = await boot(shell, { port: 4916 })
  await callRoute(ctx, '/html-workbench/resolve?file=' + encodeURIComponent("/tmp/it's here/page.html"))

  const probe = commands.find((command) => command.includes(' -c '))
  assert.ok(probe.includes("'/tmp/it'\\''s here/page.html'"), 'a single quote must be neutralised')
})

// ── Interpreter probe caching ────────────────────────────────────────────────

test('a failed interpreter probe is cached instead of retried per keystroke', quiet(async () => {
  let versionProbes = 0
  const shell = {
    resolve: (spec) => spec,
    run: async (spec) => {
      if (spec.command.endsWith('--version')) versionProbes += 1
      return { exitCode: 1, stdout: collected(''), stderr: collected('command not found') }
    },
    start: () => { throw new Error('must not spawn without an interpreter') },
  }
  const ctx = await boot(shell, { port: 4917, platform: 'win32', runtimeDir: 'C:/Temp/hwb' })
  const afterBoot = versionProbes

  // Five keystrokes in the address bar. Each used to re-probe every candidate at
  // 5s timeout apiece, and each failure overwrote the journal.
  for (let i = 0; i < 5; i += 1) {
    await callRoute(ctx, '/html-workbench/resolve?file=%2Ftmp%2Fpage' + i + '.html')
  }

  assert.equal(versionProbes, afterBoot, 'a known-failed probe must not respawn subprocesses')
  const diag = await callRoute(ctx, '/html-workbench/diagnostics')
  assert.match(diag.startError, /找不到可用的 Python 3 解释器/)
  assert.match(diag.startError, /重启 DSH/, 'the message must say how to recover')
  const misses = diag.journal.filter((entry) => /找不到可用的 Python/.test(entry.message))
  assert.equal(misses.length, 1, 'the journal must not be flooded by one repeated cause')
}))

test('the probe is retried once the cache window expires', quiet(async () => {
  let pythonInstalled = false
  let versionProbes = 0
  const shell = {
    resolve: (spec) => spec,
    run: async (spec) => {
      if (spec.command.endsWith('--version')) {
        versionProbes += 1
        return pythonInstalled
          ? { exitCode: 0, stdout: collected('Python 3.12.0'), stderr: collected('') }
          : { exitCode: 1, stdout: collected(''), stderr: collected('not found') }
      }
      return { exitCode: 1, stdout: collected(''), stderr: collected('') }
    },
    start: () => ({ status: 'running', exitCode: null, signal: null, readOutput: () => ({ delta: '' }), kill: () => true }),
  }
  const ctx = await boot(shell, { port: 4918, platform: 'win32', runtimeDir: 'C:/Temp/hwb' })
  const afterBoot = versionProbes

  // The user installs Python. Without a TTL they would have to reload DSH.
  pythonInstalled = true
  const realNow = Date.now
  Date.now = () => realNow() + 31000
  try {
    await callRoute(ctx, '/html-workbench/resolve?file=%2Ftmp%2Fpage.html')
  } finally {
    Date.now = realNow
  }

  assert.ok(versionProbes > afterBoot, 'the window must expire so recovery needs no reload')
  const diag = await callRoute(ctx, '/html-workbench/diagnostics')
  assert.equal(diag.pythonCommand, 'python3')
}))

test('a missing interpreter is reported on the resolve route, not silently dropped', quiet(async () => {
  const shell = {
    resolve: (spec) => spec,
    run: async () => ({ exitCode: 1, stdout: collected(''), stderr: collected('command not found') }),
    start: () => { throw new Error('must not spawn without an interpreter') },
  }
  const ctx = await boot(shell, { port: 4919, platform: 'win32', runtimeDir: 'C:/Temp/hwb' })
  const resolved = await callRoute(ctx, '/html-workbench/resolve?file=%2Ftmp%2Fpage.html')

  assert.equal(resolved.exists, null, 'the check genuinely could not run')
  // `exists: null` alone renders as no indicator at all — the field looks broken.
  assert.match(resolved.error, /找不到可用的 Python 3 解释器/)
}))

test('the py launcher is expanded to an absolute path, never used as a prefix', async () => {
  const commands = []
  const executable = 'C:\\Users\\Zhou Hongxuan\\AppData\\Local\\Programs\\Python\\Python312\\python.exe'
  const shell = {
    resolve: (spec) => (commands.push(spec.command), spec),
    run: async (spec) => {
      if (spec.command === '"' + executable + '" --version') return { exitCode: 0, stdout: collected('Python 3.12.0') }
      if (spec.command.endsWith('--version')) return { exitCode: 1, stdout: collected(''), stderr: collected('not found') }
      if (spec.command.startsWith('py -3 -c ')) return { exitCode: 0, stdout: collected(executable + '\n'), stderr: collected('') }
      if (spec.command.includes(' health ')) {
        return { exitCode: 0, stdout: collected(JSON.stringify({ ok: true, service: 'html-workbench', version: '2.1.0' })), stderr: collected('') }
      }
      return { exitCode: 0, stdout: collected(''), stderr: collected('') }
    },
    start: () => { throw new Error('healthy service must be reused') },
  }
  const ctx = await boot(shell, { port: 4920, platform: 'win32', runtimeDir: 'C:/Temp/hwb' })
  const diag = await callRoute(ctx, '/html-workbench/diagnostics')

  assert.equal(diag.pythonCommand, '"' + executable + '"')
  // `py -3 script.py` mangles forwarded arguments, so the launcher may only ever
  // appear in the one probe that asks it for sys.executable.
  const launcherUses = commands.filter((command) => command.startsWith('py '))
  assert.equal(launcherUses.length, 1, 'the launcher is a lookup, not a command prefix')
  assert.ok(commands.some((command) => command.startsWith('"' + executable + '" ')), 'the resolved interpreter runs the script')
})


// ── Failure containment ─────────────────────────────────────────────────────

test('a throwing handler answers with the reason instead of hanging the request', quiet(async () => {
  const ctx = await boot(healthyShell(), { port: 4921 })
  // Force the failure the guard exists for: a route whose body blows up. The
  // browser sees an unanswered socket as `TypeError: Failed to fetch`, which is
  // exactly the unactionable string this plugin used to hand its users.
  const handler = ctx.routes.get('/html-workbench/open')
  let status = null
  let body = null
  await handler({ url: '/html-workbench/open' }, {
    writeHead(code) { status = code },
    end(payload) { body = JSON.parse(payload) },
  })
  assert.equal(status, 400, 'a missing file is a normal, answered rejection')
  assert.ok(body && body.error, 'the reason must be in the body')

  const poisoned = ctx.routes.get('/html-workbench/list')
  let guarded = null
  let guardedStatus = null
  let first = true
  await poisoned({ url: '/html-workbench/list' }, {
    writeHead(code) {
      if (first) { first = false; throw new Error('boom inside the handler') }
      guardedStatus = code
    },
    end(payload) { guarded = JSON.parse(payload) },
  })
  assert.equal(guardedStatus, 500, 'the guard must still write a response')
  assert.match(guarded.error, /插件内部错误（list）/)
  assert.match(guarded.detail, /boom inside the handler/)
  assert.ok(guarded.diagnostics, 'the journal must ride along for the report')
}))

test('the diagnostics route is registered before anything that can fail', async () => {
  const order = []
  const shell = healthyShell()
  const ctx = makeContext(shell)
  const originalRegister = ctx.get('webServer').register
  ctx.get('webServer').register = (spec) => (order.push(spec.path), originalRegister(spec))
  loadPlugin().apply(ctx, { script: '/tmp/fake/workbench.py', port: 4922 })
  await new Promise((done) => setTimeout(done, 150))

  assert.equal(order[0], '/html-workbench/diagnostics',
    'the one route that explains a broken plugin must not depend on the rest registering')
})

test('repeated info lines cannot evict the error that explains the failure', quiet(async () => {
  const ctx = await boot(dyingShell('ModuleNotFoundError: No module named \'ssl\''), { port: 4923 })
  // `restart` journals on every call, and a user staring at a red dot clicks it
  // repeatedly. A plain 40-entry ring buffer would push the original traceback
  // out long before they think to read the panel.
  for (let i = 0; i < 60; i += 1) await callRoute(ctx, '/html-workbench/restart')
  const diag = await callRoute(ctx, '/html-workbench/diagnostics')

  const detail = diag.journal.map((entry) => entry.detail || '').join('\n')
  assert.ok(detail.includes("No module named 'ssl'"), 'the root cause must survive the noise')
  assert.ok(diag.journal.length <= 40, 'the buffer still has a hard ceiling')
}))

test('the diagnostics name the build that produced them', async () => {
  const ctx = await boot(healthyShell(), { port: 4924, version: '0.3.0', platform: 'win32', runtimeDir: 'C:/Temp/hwb' })
  const diag = await callRoute(ctx, '/html-workbench/diagnostics')

  // Without these two fields every bug report needs a follow-up question.
  assert.equal(diag.version, '0.3.0')
  assert.equal(diag.platform, 'win32')
})

test('distinct noise cannot evict the startup error either', quiet(async () => {
  const ctx = await boot(dyingShell('ModuleNotFoundError: No module named \'ssl\''), { port: 4925 })
  // Coalescing only folds IDENTICAL lines. Typing in the path box produces one
  // distinct failure per path, which is enough to fill the buffer with lines
  // that are individually useless and evict the one that explains everything.
  for (let i = 0; i < 60; i += 1) {
    await callRoute(ctx, '/html-workbench/resolve?file=%2Ftmp%2Fpage' + i + '.html')
  }
  const diag = await callRoute(ctx, '/html-workbench/diagnostics')

  const detail = diag.journal.map((entry) => entry.detail || '').join('\n')
  assert.ok(detail.includes("No module named 'ssl'"), 'the startup error must outlive per-keystroke noise')
}))

// ── Public ShellExecutor API ─────────────────────────────────────────────────
//
// The stubs above model the executor this plugin was developed against, which
// offers `resolve() + run() + start()`. Every kernel PUBLISHED on npm
// (@deepseek-ai/dsh-shell 0.1.7-rc.2 and 0.2.0-rc.2) offers only
// `resolve() + execute()` — `run()`/`start()` were never shipped, so on a
// stock installation the plugin died with `shell.start is not a function`
// before it could start the service. These stubs model THAT surface, and the
// assertions below pin the two facts the fallback must not get wrong: the
// long-running serve process must not inherit resolve()'s 60s kill deadline,
// and a serve process that dies at once must still surface its output.

/** A shell exposing only the public `resolve() + execute()` surface. */
const publicShell = ({ serve, foreground } = {}) => ({
  resolve: (spec) => spec,
  execute: async (spec) => {
    if (spec.command.includes(' serve ')) return serve(spec)
    return {
      result: async () => (foreground
        ? foreground(spec)
        : { exitCode: 1, signal: null, timedOut: false, aborted: false, timeoutMs: 8000, stdout: collected(''), stderr: collected('') }),
    }
  },
})

test('a public kernel (resolve + execute only) starts and supervises the service', async () => {
  // Like the restart test above: unhealthy at first, so the plugin really goes
  // through the serve spawn (the reuse branch would never touch it).
  let serveSpec = null
  let healthy = false
  const shell = publicShell({
    serve: (spec) => {
      serveSpec = spec
      healthy = true
      return { status: 'running', exitCode: null, signal: null, readOutput: () => ({ delta: '', lossy: false }), kill: () => true }
    },
    foreground: (spec) => (healthy && spec.command.includes(' health ')
      ? {
          exitCode: 0,
          signal: null,
          timedOut: false,
          aborted: false,
          timeoutMs: 8000,
          stdout: collected(JSON.stringify({ ok: true, service: 'html-workbench', version: '2.1.0' })),
          stderr: collected(''),
        }
      : { exitCode: 1, signal: null, timedOut: false, aborted: false, timeoutMs: 8000, stdout: collected(''), stderr: collected('') }),
  })
  const ctx = await boot(shell, { port: 4930 })
  const diag = await callRoute(ctx, '/html-workbench/diagnostics')

  assert.equal(diag.running, true)
  assert.equal(diag.startError, null)
  assert.ok(diag.journal.some((entry) => entry.message.includes('本地服务就绪')), 'the service must reach the ready state')
  assert.ok(serveSpec, 'the plugin must actually spawn through execute() on a public kernel')
  assert.equal(
    serveSpec.onExpiry,
    'none',
    'the long-running service must not inherit resolve()s 60s kill deadline',
  )
})

test('a serve process that dies at once is reported on a public kernel, not polled', quiet(async () => {
  let drained = false
  const shell = publicShell({
    serve: () => ({
      status: 'completed',
      exitCode: 1,
      signal: null,
      readOutput: () => (drained ? { delta: '', lossy: false } : ((drained = true), { delta: '{"ok": false, "error": "PORT_IN_USE"}', lossy: false })),
      kill: () => true,
    }),
  })
  const started = Date.now()
  const ctx = await boot(shell, { port: 4931 })
  const diag = await callRoute(ctx, '/html-workbench/diagnostics')

  assert.equal(diag.running, false)
  // The CLI's structured error still becomes the headline through the
  // execute() path, exactly as it did through start().readOutput().
  assert.match(diag.startError, /端口已被占用/)
  assert.match(diag.startError, /PORT_IN_USE/)
  assert.ok(Date.now() - started < 2000, 'a dead process must not look like a hang')
}))

test('opening multiple files while the public executor is starting shares one process', async () => {
  let releaseSpawn
  const spawnGate = new Promise((resolve) => { releaseSpawn = resolve })
  let starts = 0
  let healthy = false
  const shell = publicShell({
    serve: async () => {
      starts += 1
      await spawnGate
      healthy = true
      return { status: 'running', readOutput: () => ({ delta: '' }), kill: () => true }
    },
    foreground: () => ({
      exitCode: healthy ? 0 : 1,
      stdout: collected(healthy ? JSON.stringify({ ok: true, service: 'html-workbench' }) : ''),
    }),
  })
  const ctx = makeContext(shell)
  loadPlugin().apply(ctx, { script: '/tmp/fake/workbench.py' })
  await new Promise(setImmediate)

  const first = callRoute(ctx, '/html-workbench/open?file=%2Ftmp%2Ffirst.html')
  const second = callRoute(ctx, '/html-workbench/open?file=%2Ftmp%2Fsecond.html')
  await new Promise(setImmediate)
  releaseSpawn()

  const results = await Promise.all([first, second])
  assert.equal(starts, 1)
  assert.deepEqual(results.map(({ url }) => new URL(url).searchParams.get('file')), ['/tmp/first.html', '/tmp/second.html'])
  assert.equal((await callRoute(ctx, '/html-workbench/diagnostics')).owned, true)
})

test('a public executor process that never becomes healthy is stopped at the startup deadline', quiet(async () => {
  let stopped = 0
  const shell = publicShell({
    serve: () => ({
      status: 'running',
      readOutput: () => ({ delta: '' }),
      kill: () => { stopped += 1; return true },
    }),
  })
  const ctx = makeContext(shell)
  const originalNow = Date.now
  let now = originalNow()
  Date.now = () => now
  ctx.timeout = async (ms) => { now += ms }
  try {
    loadPlugin().apply(ctx, { script: '/tmp/fake/workbench.py' })
    const result = await callRoute(ctx, '/html-workbench/open?file=%2Ftmp%2Fpage.html')
    assert.equal(result.ok, false)
    assert.match(result.error, /60 秒内没有就绪/)
    assert.equal(stopped, 1)
    assert.equal(result.diagnostics.owned, false)
  } finally {
    Date.now = originalNow
  }
}))

test('the page can identify missing and outdated Python before opening a Workbench tab', quiet(async () => {
  for (const detectedVersion of [null, 'Python 3.8.20']) {
    let started = false
    let versionProbes = 0
    const shell = publicShell({
      serve: () => { started = true },
      foreground: () => {
        versionProbes += 1
        return { exitCode: detectedVersion ? 0 : 1, stdout: collected(detectedVersion || '') }
      },
    })
    const ctx = makeContext(shell, { assumePython: false })
    loadPlugin().apply(ctx, { script: '/tmp/fake/workbench.py', platform: 'linux' })
    const result = await callRoute(ctx, '/html-workbench/dependencies')
    assert.equal(result.dependencyIssue.code, detectedVersion ? 'PYTHON_TOO_OLD' : 'PYTHON_UNAVAILABLE')
    assert.match(result.dependencyIssue.message, /Python 3\.9/)
    if (detectedVersion) assert.ok(result.dependencyIssue.message.includes(detectedVersion))
    assert.equal(started, false)
    assert.equal(versionProbes, 2, 'page and startup share one interpreter probe')
  }
}))

test('a failed GrapesJS download is reported as a startup dependency issue', quiet(async () => {
  const ctx = await boot(dyingShell('{"ok":false,"error":"VENDOR_DOWNLOAD_FAILED"}'))
  const result = await callRoute(ctx, '/html-workbench/dependencies')
  assert.equal(result.dependencyIssue.code, 'VENDOR_DOWNLOAD_FAILED')
  assert.match(result.dependencyIssue.message, /GrapesJS/)
}))

test('a health probe from before a restart cannot overwrite the new service state', quiet(async () => {
  let running = false
  let deferProbe = false
  let finishProbe
  const shell = healthyShell()
  shell.run = async spec => {
    if (spec.command.includes(' stop --port ')) { running = false; return { exitCode: 0 } }
    if (deferProbe) {
      deferProbe = false
      return new Promise(resolve => { finishProbe = resolve })
    }
    return running ? { exitCode: 0, stdout: collected(JSON.stringify({ ok: true, service: 'html-workbench' })) }
      : { exitCode: 1 }
  }
  shell.start = () => {
    running = true
    return { status: 'running', readOutput: () => ({ delta: '' }), kill: () => { running = false } }
  }
  const ctx = await boot(shell)
  const originalNow = Date.now
  Date.now = () => originalNow() + 11000
  try {
    deferProbe = true
    await callRoute(ctx, '/html-workbench/diagnostics')
    assert.equal(typeof finishProbe, 'function')
    const restarted = await callRoute(ctx, '/html-workbench/restart')
    assert.equal(restarted.ok, true)
    finishProbe({ exitCode: 1, stderr: collected('old service went away') })
    await new Promise(resolve => setImmediate(resolve))
    const report = await callRoute(ctx, '/html-workbench/diagnostics')
    assert.equal(report.running, true)
    assert.equal(report.startError, null)
  } finally {
    Date.now = originalNow
  }
}))
