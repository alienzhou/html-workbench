/**
 * HTML Workbench DSH plugin — Host half (function body).
 *
 * This file is the plain-JavaScript function body consumed by DeepSeek
 * Harness's dynamic Cordis plugin loader: pass this exact text as `code.host`
 * to `cordis_define`. The static host entry `src/index.js` evaluates this same
 * body via `new Function` and re-exports it, so it runs unchanged in both
 * modes. `harness` usage is guarded (`typeof harness !== 'undefined'`) so the
 * body also runs as a static bundle where that symbol does not exist.
 *
 * Responsibilities (runs in the DSH Node.js process):
 *  - Start / reuse the local `html-workbench` Python service on registration
 *    and stop the process it started when the plugin unloads (side-effect
 *    lifecycle via ctx.effect).
 *  - Track HTML files produced by the `write` / `edit` tools via `tools/result`.
 *  - Expose the same three operations through two transports:
 *      * dynamic: `harness.handle` Package-private RPC (Client `host.call`);
 *      * static:  `webServer.register` HTTP routes under `/html-workbench/*`.
 */

return {
  inject: ['shell', 'timer', 'webServer'],
  apply(ctx, config) {
    // 静态/NPM 装载时由 src/index.js 相对插件自身解析 scripts/workbench.py 并注入 config.script；
    // 动态装载（cordis_define）无 config → script 为空，服务不自动拉起（仅注册传输层）。
    // editorRoot 可选：缺省不传 --editor-root，由 workbench.py 自行回退到用户家目录。
    const opts = config || {}
    const PORT = opts.port || 4317
    const SCRIPT = opts.script || null
    const EDITOR_ROOT = opts.editorRoot || null
    const PLATFORM = opts.platform || (typeof process !== 'undefined' ? process.platform : null)
    const IS_WINDOWS = PLATFORM === 'win32'
    // Reported verbatim in the diagnostics. A dynamic (cordis_define) load has no
    // config, so `version` stays null — which is itself the answer to "is this the
    // packaged build or a hot-loaded one?", the first question every report raises.
    const VERSION = opts.version || null
    // Candidates must be a SINGLE executable token: every call site appends its
    // own arguments, so a multi-token entry like `py -3` would place the script
    // path after the launcher's own flags and break argument forwarding. The `py`
    // launcher is still supported — see `expandWindowsLauncher`, which asks it for
    // the interpreter's absolute path and uses that instead.
    const PYTHON_CANDIDATES = opts.pythonCommand
      ? [opts.pythonCommand]
      : (IS_WINDOWS ? ['python3', 'python'] : ['python3'])
    // Static packages inject the runtime directory resolved (and probed) by
    // src/index.js. Dynamic loads use TEMP/TMPDIR or the current workspace.
    // The folder name matches
    // RUNTIME_DIR_NAME in workbench.py so both halves agree on one location.
    const tempRoot = typeof process !== 'undefined' && process.env
      ? (process.env.TEMP || process.env.TMP || process.env.TMPDIR)
      : null
    // Strip a trailing separator from EITHER source: `%TEMP%` and an injected
    // runtimeDir both legitimately end in one, and appending '/logs' to it would
    // yield `C:\Temp\hwb\/logs` — a path Python tolerates but that reads as
    // corruption in every log line and error message a user pastes back.
    const trimSeparator = (value) => String(value).replace(/[\\/]+$/, '')
    const currentDir = typeof process !== 'undefined' && typeof process.cwd === 'function' ? process.cwd() : '.'
    const RUNTIME_DIR = opts.runtimeDir
      ? trimSeparator(opts.runtimeDir)
      : trimSeparator(tempRoot || currentDir) + '/.html-workbench'

    // These are REQUESTS, not guarantees. The service runs as a DSH sandboxed
    // child that may write only the session workspace and a private temp folder
    // the sandbox hands it — the ambient %TEMP% root seen by this parent is
    // denied, so a folder the parent can create is not necessarily one the child
    // can use. workbench.py therefore re-probes in-process, falls back on its
    // own, and advertises the directories it settled on; `adoptResolvedPaths`
    // below surfaces those, so the panel describes where the service really
    // writes instead of echoing the path we merely asked for. Both are disposable
    // cache/log data either way.
    const LOG_DIR = RUNTIME_DIR + '/logs'
    const VENDOR_CACHE = RUNTIME_DIR + '/vendor'
    const hostLog = opts.hostLog || null
    const nodeVersion = typeof process !== 'undefined' ? process.version : null
    const arch = typeof process !== 'undefined' ? process.arch : null
    const mode = typeof harness !== 'undefined' ? 'dynamic' : 'static'
    let hostLogError = null

    // Directories the running service reported; null until it says so.
    let resolvedPaths = null
    let serviceInfo = null
    let startupLogFile

    let assets = []
    let seq = 0
    let ownedProcess = null
    let serviceRunning = false
    let startError = null
    let pythonCommand = null
    // A failed probe must be remembered: `resolve` runs on every keystroke and
    // `health` on a timer, so re-probing would spawn three 5s subprocesses per
    // call and flood the journal with one repeated line. The TTL still lets a
    // user who just installed Python recover without reloading the plugin.
    const PROBE_RETRY_MS = 30000
    let pythonProbeFailedAt = 0
    let pythonProbe = null
    let disposed = false

    const shell = ctx.get('shell')

    // ── Shell API: two shapes, one contract ──────────────────────────────────
    //
    // The ShellExecutor that public kernels ship (`@deepseek-ai/dsh-shell`
    // 0.1.7-rc.2 / 0.2.0-rc.2) exposes `resolve()` + `execute()` only — `run()`
    // and `start()` were never published, so on a stock installation every call
    // below threw (`shell.start is not a function`) and the service could never
    // start. Both shapes are honoured: an executor offering the legacy pair is
    // driven exactly as before, anything else goes through `execute()` —
    // `await execute(spec).result()` IS the old `run()` (the foreground
    // projection whose ShellRunResult/CollectedOutput fields the diagnostics
    // below already read), and the value `execute()` resolves to IS the old
    // `start()` handle (ShellExecution extends ShellProcess: status / exitCode /
    // signal / readOutput() / kill()).
    const runShell = async (spec) =>
      typeof shell.run === 'function' ? shell.run(spec) : (await shell.execute(spec)).result()
    const startShell = async (spec) =>
      // `onExpiry` only in this branch: `resolve()` defaults to `'kill'` with a
      // 60s deadline, which would kill the long-running serve process a minute
      // after start. The legacy branch inherits whatever its executor already
      // did with a background handle.
      typeof shell.start === 'function' ? shell.start(spec) : shell.execute({ ...spec, onExpiry: 'none' })

    // ── Diagnostics journal ──────────────────────────────────────────────────
    //
    // A failed start used to surface as nothing but a red dot: the only signal
    // was `running: false`, while the actual cause (a Python traceback, a busy
    // port, a missing interpreter) stayed inside this Node process. Every
    // subprocess outcome now lands in this ring buffer, which `status` returns
    // and the panel renders, so the failure is readable where it is observed.
    const JOURNAL_LIMIT = 40
    // Errors are the whole point of the journal, yet they are also the rarest
    // entries: a service that fails at start then gets polled by `status` every
    // few seconds would push the original traceback out of a plain ring buffer
    // long before anyone opens the panel. So evict by level — drop the oldest
    // non-error first, and only sacrifice an error when nothing else is left.
    const JOURNAL_ERROR_FLOOR = 12
    let journal = []

    const trimJournal = () => {
      if (journal.length <= JOURNAL_LIMIT) return
      const overflow = journal.length - JOURNAL_LIMIT
      let dropped = 0
      const errors = journal.filter((entry) => entry.level === 'error').length
      const keep = []
      for (let i = 0; i < journal.length; i += 1) {
        const entry = journal[i]
        const isError = entry.level === 'error'
        // Never let noise starve the error history, but do not grow without
        // bound either: past the floor, errors age out like anything else.
        const expendable = !isError || errors - dropped > JOURNAL_ERROR_FLOOR
        if (dropped < overflow && expendable) {
          dropped += 1
          continue
        }
        keep.push(entry)
      }
      // Errors alone can exceed the limit; fall back to a plain tail so the
      // buffer still has a hard ceiling.
      journal = keep.length > JOURNAL_LIMIT ? keep.slice(-JOURNAL_LIMIT) : keep
    }

    const note = (level, message, detail) => {
      const text = String(message || '').slice(0, 2000)
      const raw = detail ? String(detail) : null
      const body = raw && raw.length > 4000 ? raw.slice(0, 1000) + '\n…（中间输出已截断）\n' + raw.slice(-3000) : raw
      const at = Date.now()
      // Retrying a broken start replays the SAME failure verbatim, interleaved
      // with the "restarting" line — so consecutive-only folding would miss it.
      // Match anywhere, then move the entry to the end so its position still
      // agrees with its timestamp when the panel renders newest-first.
      let index = -1
      for (let i = journal.length - 1; i >= 0; i -= 1) {
        const entry = journal[i]
        if (entry.level === level && entry.message === text && entry.detail === body) { index = i; break }
      }
      if (index >= 0) {
        const entry = journal.splice(index, 1)[0]
        entry.at = at
        entry.repeated = (entry.repeated || 1) + 1
        journal.push(entry)
      } else {
        journal.push({ at, firstAt: at, level, message: text, detail: body })
        trimJournal()
      }
      const entry = journal[journal.length - 1]
      if (entry.loggedAt != null && at - entry.loggedAt < 60000) return
      entry.loggedAt = at
      if (hostLog) {
        try {
          hostLog.append({ at, level, message: text, detail: body, port: PORT, version: VERSION,
            firstAt: entry.firstAt, repeated: entry.repeated || 1 })
          hostLogError = null
        } catch (e) {
          const failure = (e && e.message) || String(e)
          if (hostLogError !== failure) console.error('[html-workbench] 无法写入宿主日志', failure)
          hostLogError = failure
        }
      }
      if (level === 'error') console.error('[html-workbench] ' + text, body || '')
    }

    // `CollectedOutput` carries more than text (truncation flags, spill paths);
    // reduce it to the part a human reads, and say so when bytes were dropped.
    const outputText = (collected) => {
      if (!collected) return ''
      const text = typeof collected === 'string' ? collected : (collected.text || '')
      const trimmed = String(text).trim()
      if (collected && collected.truncated) return trimmed + '\n…（输出被截断）'
      return trimmed
    }

    // `shell.resolve({ command })` takes ONE command line, so every embedded path
    // must be quoted for the platform's parser. Naive `'"' + p + '"'` breaks on
    // Windows, where `C:\dir\` ends in a backslash that escapes the closing quote
    // and swallows the rest of the line. Never use JSON.stringify here: it emits
    // JSON escapes (`\\`), which cmd.exe passes through verbatim, so Python
    // receives a path with doubled separators and reports every file as missing.
    const quoteArg = (value) => {
      const raw = String(value == null ? '' : value)
      if (IS_WINDOWS) {
        // Double only the run of backslashes that precedes the closing quote;
        // interior ones are literal to cmd.exe. Inner quotes cannot appear in a
        // Windows path, but strip them rather than emit an unbalanced line.
        const cleaned = raw.replace(/"/g, '')
        const tail = cleaned.match(/\\*$/)[0]
        return '"' + cleaned + tail + '"'
      }
      return "'" + raw.replace(/'/g, "'\\''") + "'"
    }

    pythonCommand = opts.pythonCommand ? quoteArg(opts.pythonCommand) : (IS_WINDOWS ? null : 'python3')

    const describeRun = (result) => {
      if (!result) return 'shell.run threw'
      const parts = []
      if (result.timedOut) parts.push('超时（' + result.timeoutMs + 'ms）')
      if (result.aborted) parts.push('被取消')
      if (result.signal) parts.push('信号 ' + result.signal)
      parts.push('exit=' + String(result.exitCode))
      const streams = [outputText(result.stderr), outputText(result.stdout)].filter(Boolean)
      return parts.join(' ') + (streams.length ? '\n' + streams.join('\n') : '')
    }

    // Windows ships a `py` launcher that resolves versions the PATH may not
    // expose. It is NOT usable as a command prefix (`py -3 script.py` mangles
    // forwarded arguments), so ask it for the interpreter's absolute path and use
    // that as a normal single-token executable.
    const expandWindowsLauncher = async () => {
      if (!IS_WINDOWS || !shell) return null
      const probe = 'py -3 -c ' + quoteArg('import sys; print(sys.executable)')
      try {
        const result = await runShell(shell.resolve({ command: probe, timeoutMs: 5000, stdoutMaxBytes: 4096 }))
        if (!result || result.exitCode !== 0) return { failure: 'py -3: ' + describeRun(result) }
        const executable = outputText(result.stdout).split('\n').pop().trim()
        if (!executable) return { failure: 'py -3: 没有返回解释器路径' }
        return { command: quoteArg(executable) }
      } catch (e) {
        return { failure: 'py -3: ' + ((e && e.message) || String(e)) }
      }
    }

    const resolvePythonCommand = async () => {
      if (pythonCommand) return pythonCommand
      if (!shell) return null
      // Collapse concurrent callers onto one probe: the panel's poll, an `open`
      // and a keystroke-driven `resolve` can all arrive inside the same tick.
      if (pythonProbe) return pythonProbe
      if (pythonProbeFailedAt && Date.now() - pythonProbeFailedAt < PROBE_RETRY_MS) return null
      pythonProbe = (async () => {
        const failures = []
        for (const candidate of PYTHON_CANDIDATES) {
          try {
            const spec = shell.resolve({ command: candidate + ' --version', timeoutMs: 5000, stdoutMaxBytes: 4096 })
            const result = await runShell(spec)
            if (result && result.exitCode === 0) {
              pythonCommand = candidate
              pythonProbeFailedAt = 0
              note('info', '使用 Python 解释器：' + candidate)
              return pythonCommand
            }
            failures.push(candidate + ': ' + describeRun(result))
          } catch (e) {
            failures.push(candidate + ': ' + ((e && e.message) || String(e)))
          }
        }
        const launcher = await expandWindowsLauncher()
        if (launcher && launcher.command) {
          pythonCommand = launcher.command
          pythonProbeFailedAt = 0
          note('info', '使用 Python 解释器（经 py 启动器解析）：' + launcher.command)
          return pythonCommand
        }
        if (launcher && launcher.failure) failures.push(launcher.failure)
        pythonProbeFailedAt = Date.now()
        startError = '找不到可用的 Python 3 解释器（已尝试：'
          + PYTHON_CANDIDATES.join('、') + (IS_WINDOWS ? '、py -3' : '')
          + '）。请安装 Python 3.9+ 并确保它在 PATH 中，然后点「重启服务」。'
        note('error', startError, failures.join('\n'))
        return null
      })()
      try {
        return await pythonProbe
      } finally {
        pythonProbe = null
      }
    }

    const runCli = async (args, timeoutMs) => {
      if (!shell) { note('error', 'shell 服务不可用，无法执行 workbench.py'); return null }
      if (!SCRIPT) { note('error', 'workbench.py 路径未配置'); return null }
      const python = await resolvePythonCommand()
      if (!python) return null
      const command = python + ' ' + quoteArg(SCRIPT) + ' ' + args
      try {
        const spec = shell.resolve({ command: command, timeoutMs: timeoutMs || 15000, stdoutMaxBytes: 64 * 1024 })
        const result = await runShell(spec)
        // A non-zero exit is the interesting case and used to be discarded: the
        // CLI prints a structured `{ok:false,error:{code,message}}` on stdout.
        if (!result || result.exitCode !== 0) note('error', 'workbench.py ' + args.split(' ')[0] + ' 执行失败', describeRun(result))
        return result
      } catch (e) {
        note('error', 'workbench.py ' + args.split(' ')[0] + ' 无法执行', (e && e.message) || String(e))
        return null
      }
    }

    // `health` runs on a timer, so its failures are expected and must not flood
    // the journal — poll quietly and let the caller decide what is worth noting.
    const probeHealth = async () => {
      if (!shell || !SCRIPT) return null
      const python = await resolvePythonCommand()
      if (!python) return null
      try {
        const spec = shell.resolve({
          command: python + ' ' + quoteArg(SCRIPT) + ' health --port ' + PORT,
          timeoutMs: 8000,
          stdoutMaxBytes: 64 * 1024,
        })
        const result = await runShell(spec)
        if (!result || result.exitCode !== 0) return { ok: false, result: result }
        try {
          const payload = JSON.parse(outputText(result.stdout) || '')
          return payload && payload.ok === true ? { ok: true, payload: payload } : { ok: false, result: result }
        } catch (e) {
          return { ok: false, result: result }
        }
      } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) }
      }
    }

    // `/api/health` advertises the directories the service really writes to. The
    // paths it was ASKED for may be exactly what the sandbox refused, so adopting
    // the reported ones is what lets the panel stay truthful — for a service we
    // started and for one we merely reused (a reused service leaves us no startup
    // output to read them from).
    const adoptResolvedPaths = (payload) => {
      if (!payload) return
      serviceInfo = { version: payload.version || null, pythonVersion: payload.pythonVersion || null }
      for (const key of ['platform', 'pid', 'pythonExecutable', 'logging']) {
        if (key in payload) serviceInfo[key] = payload[key]
      }
      if ('logFile' in payload) serviceInfo.logFile = payload.logFile
      const logDir = typeof payload.logDir === 'string' ? payload.logDir : null
      const vendorCache = typeof payload.vendorCache === 'string' ? payload.vendorCache : null
      if (logDir || vendorCache) resolvedPaths = { logDir: logDir, vendorCache: vendorCache }
    }

    const health = async () => {
      const probe = await probeHealth()
      if (!probe || !probe.ok) return null
      adoptResolvedPaths(probe.payload)
      return probe.payload
    }

    // `workbench.py` reports failures as one structured JSON line on stderr. Turn
    // the machine code into the sentence a person can act on; keep the raw line
    // in the detail so nothing is lost when the code is one we do not know.
    const CLI_HINTS = {
      PORT_IN_USE: '端口已被占用。可能有别的进程（或旧版服务）占着它 —— 点「重启服务」会先退役占用者。',
      ASSET_NOT_FOUND: '前端资源缺失，插件安装目录不完整（缺 assets/workbench.html）。',
      PYTHON_TOO_OLD: '需要 Python 3.9 或更高版本。',
      SERVER_OUTDATED: '端口上有旧版服务且无法自动停止，请手动结束该进程。',
      FILE_NOT_FOUND: '找不到文件。',
      VENDOR_DOWNLOAD_FAILED: '首次启动需要联网下载 GrapesJS，下载失败了。',
    }

    const explainOutput = (text) => {
      if (!text) return null
      for (const line of String(text).split('\n')) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('{')) continue
        try {
          const payload = JSON.parse(trimmed)
          if (payload && payload.ok === false && payload.error) {
            if ('logFile' in payload) startupLogFile = payload.logFile
            const hint = CLI_HINTS[payload.error]
            return (hint || payload.message || payload.error) + '（' + payload.error + '）'
          }
        } catch (e) { /* not the JSON line; keep scanning */ }
      }
      return null
    }

    // Everything the started process wrote since the last read. DSH settles a
    // spawn failure as `killed` with the error on stderr, so this is the only
    // place a "python3: command not found" or a traceback can be observed.
    const drain = (proc) => {
      try {
        const read = proc.readOutput()
        if (!read) return ''
        let text = String(read.delta || '').trim()
        if (read.lossy) text += '\n…（部分输出丢失）'
        if (read.stderrSpillPath) text += '\n完整 stderr: ' + read.stderrSpillPath
        return text
      } catch (e) {
        return ''
      }
    }

    const startService = async () => {
      if (disposed) return null
      if (serviceRunning) return health()
      const existing = await health()
      if (existing) {
        serviceRunning = true
        startError = null
        healthConfirmedAt = Date.now()
        // Record the reuse too, so the journal always explains the CURRENT state
        // rather than only the failures.
        note('info', '复用已在运行的服务：版本 ' + (existing.version || '未知') + '，端口 ' + PORT)
        return existing
      }
      if (!shell) { startError = 'shell 服务不可用（DSH 未提供 shell，插件无法拉起本地服务）'; note('error', startError); return null }
      if (!SCRIPT) { startError = 'workbench.py 路径未配置（请用静态装载并随包分发 scripts/workbench.py）'; note('error', startError); return null }
      const python = await resolvePythonCommand()
      if (!python) return null
      startupLogFile = undefined
      let proc = null
      const command = python + ' ' + quoteArg(SCRIPT) + ' serve --port ' + PORT
        + ' --log-dir ' + quoteArg(LOG_DIR)
        + ' --vendor-cache ' + quoteArg(VENDOR_CACHE)
        + (EDITOR_ROOT ? ' --editor-root ' + quoteArg(EDITOR_ROOT) : '')
      try {
        note('info', '启动本地服务：端口 ' + PORT, command)
        proc = await startShell(shell.resolve({ command: command, stdoutMaxBytes: 64 * 1024 }))
        if (disposed) { try { proc.kill() } catch (e) {} return null }
        ownedProcess = proc
        let transcript = ''
        let lastProbe = null
        for (let i = 0; i < 240; i += 1) {
          const chunk = drain(proc)
          if (chunk) transcript = (transcript + '\n' + chunk).trim().slice(-16000)
          const probe = await probeHealth()
          lastProbe = probe
          if (probe && probe.ok) {
            serviceRunning = true
            startError = null
            healthConfirmedAt = Date.now()
            adoptResolvedPaths(probe.payload)
            note('info', '本地服务就绪：版本 ' + (probe.payload.version || '未知') + '，端口 ' + PORT)
            if (probe.payload.logFile === null) {
              const output = drain(proc)
              note('warn', 'Python 服务未能启用文件日志', [transcript, output].filter(Boolean).join('\n'))
            }
            return probe.payload
          }
          // Stop waiting the moment the process is gone. Polling health for the
          // full 60s after `serve` already exited hides the reason and makes a
          // fast, loud failure look like a hang.
          if (proc.status !== 'running') {
            const tail = drain(proc)
            if (tail) transcript += (transcript ? '\n' : '') + tail
            // Lead with the CLI's own diagnosis when it gave one — "端口已被占用"
            // is actionable, "exit=1" is not.
            const explained = explainOutput(transcript)
            const exit = 'serve 进程已退出（exit=' + String(proc.exitCode) + (proc.signal ? ', 信号 ' + proc.signal : '') + '）'
            startError = explained || exit
            note('error', startError, exit + '\n' + (transcript || '进程没有任何输出。命令：' + command))
            ownedProcess = null
            return null
          }
          await ctx.timeout(250)
        }
        startError = '服务在 60 秒内没有就绪（端口 ' + PORT + ' 未通过健康检查）'
        const probeDetail = lastProbe && (lastProbe.error || describeRun(lastProbe.result))
        note('error', startError, [transcript, probeDetail && '最后一次健康检查：' + probeDetail, command].filter(Boolean).join('\n'))
        return null
      } catch (e) {
        startError = 'serve 进程启动失败：' + ((e && e.message) || String(e))
        note('error', startError, [e && e.stack, command].filter(Boolean).join('\n'))
        if (proc) { try { proc.kill() } catch (e2) {} }
        ownedProcess = null
        return null
      }
    }

    // A service that dies AFTER a successful start used to leave the plugin
    // frozen: nothing ever re-checked the process, so the panel kept showing a
    // stale dot while every open failed with no explanation. Reading
    // `ownedProcess.status` costs nothing (no subprocess), so the panel's
    // existing poll can supervise the process for free.
    const superviseOwnedProcess = () => {
      const proc = ownedProcess
      if (!proc || proc.status === 'running') return
      const tail = drain(proc)
      const explained = explainOutput(tail)
      ownedProcess = null
      serviceRunning = false
      startError = explained || ('服务进程已退出（exit=' + String(proc.exitCode) + (proc.signal ? ', 信号 ' + proc.signal : '') + '）')
      note('error', '服务进程意外退出', [startError, tail || '进程没有留下输出。'].join('\n'))
    }

    // Periodically refresh health and log-write status for both owned and reused
    // services. A live process handle alone cannot tell whether logging failed.
    const REVALIDATE_MS = 10000
    let healthConfirmedAt = 0
    let revalidating = false

    const revalidateService = () => {
      if (revalidating || !serviceRunning) return
      if (Date.now() - healthConfirmedAt < REVALIDATE_MS) return
      revalidating = true
      void (async () => {
        try {
          const probe = await probeHealth()
          if (probe && probe.ok) {
            adoptResolvedPaths(probe.payload)
            healthConfirmedAt = Date.now()
            return
          }
          serviceRunning = false
          startError = '本地服务已经不再响应（端口 ' + PORT + '）。'
          note('error', '本地服务失去响应', probe && (probe.error || describeRun(probe.result)))
        } finally {
          revalidating = false
        }
      })()
    }

    // Everything the panel needs to explain a red dot without opening a terminal.
    // Reaping first means a process that died since the last call is reported as
    // dead here, instead of leaving a stale "running" dot behind.
    const diagnosticFacts = () => ({
      version: VERSION,
      mode,
      platform: PLATFORM,
      arch,
      nodeVersion,
      shellAPI: shell ? ['resolve', 'execute', 'run', 'start'].filter(name => typeof shell[name] === 'function') : [],
      port: PORT,
      script: SCRIPT,
      editorRoot: EDITOR_ROOT,
      runtimeDir: RUNTIME_DIR,
      pythonCommand,
      pythonCandidates: PYTHON_CANDIDATES.slice(),
      logDir: (resolvedPaths && resolvedPaths.logDir) || LOG_DIR,
      vendorCache: (resolvedPaths && resolvedPaths.vendorCache) || VENDOR_CACHE,
      hostLogFile: hostLog ? hostLog.file : null,
      hostLogError,
      service: serviceInfo,
      startupLogFile,
      hasShell: !!shell,
      startError,
      journal: journal.slice().reverse(),
    })

    const diagnostics = () => {
      superviseOwnedProcess()
      revalidateService()
      return {
        ...diagnosticFacts(),
        ok: true,
        running: serviceRunning,
        owned: !!ownedProcess,
        processStatus: ownedProcess ? ownedProcess.status : null,
        exitCode: ownedProcess ? ownedProcess.exitCode : null,
      }
    }

    // 生命周期副作用：卸载时停掉本插件自己启动的服务进程。
    ctx.effect(() => () => {
      disposed = true
      const proc = ownedProcess
      ownedProcess = null
      serviceRunning = false
      if (proc) {
        try { proc.kill() } catch (e) { note('error', '卸载插件时无法停止服务', e.stack || e) }
      }
    })

    const recordAsset = (path, kind) => {
      const existing = assets.find((a) => a.path === path)
      if (existing) {
        existing.kind = kind
        existing.at = Date.now()
        existing.seq = ++seq
      } else {
        assets.push({ id: 'w' + (++seq), path: path, kind: kind, at: Date.now(), seq: seq })
        if (assets.length > 500) assets = assets.slice(-500)
      }
    }

    ctx.on('tools/result', (exec, result) => {
      try {
        if (!exec || !result || result.isError === true) return
        if (exec.name !== 'write' && exec.name !== 'edit') return
        const args = exec.arguments || {}
        const path = args.file_path
        if (typeof path !== 'string' || !path) return
        if (!/\.html?$/i.test(path)) return
        recordAsset(path, exec.name === 'write' ? 'create' : 'edit')
      } catch (e) {
        note('error', '记录 HTML 产物时出错', e.stack || e)
      }
    })

    const snapshot = () => assets.slice().sort((a, b) => b.seq - a.seq)

    const openFile = async (file) => {
      if (typeof file !== 'string' || !file) return { ok: false, error: '请填写文件路径' }
      if (!/\.html?$/i.test(file)) return { ok: false, error: '只支持 .html / .htm 文件' }
      if (!SCRIPT) return { ok: false, error: startError || 'workbench.py 路径未配置', diagnostics: diagnostics() }
      const wasUp = await health()
      if (!wasUp) await startService()
      const probe = await probeHealth()
      // Carry the diagnostics WITH the failure: the panel can then show the real
      // cause instead of a generic "unavailable" that sends the user hunting.
      if (!probe || !probe.ok) {
        const detail = probe && (probe.error || describeRun(probe.result))
        note('error', '打开编辑器时健康检查失败', detail || startError)
        return { ok: false, error: startError || '本地服务未就绪', diagnostics: diagnostics() }
      }
      const h = probe.payload
      adoptResolvedPaths(h)
      serviceRunning = true
      startError = null
      healthConfirmedAt = Date.now()
      return {
        ok: true,
        url: 'http://127.0.0.1:' + PORT + '/?file=' + encodeURIComponent(file),
        reused: !!wasUp,
        port: PORT,
        version: h.version || null,
      }
    }

    const restartService = async () => {
      const proc = ownedProcess
      ownedProcess = null
      serviceRunning = false
      startError = null
      if (proc) {
        try { proc.kill() } catch (e) { note('error', '重启前无法停止服务进程', e.stack || e) }
      }
      note('info', '手动重启本地服务')
      // Killing our own handle is not enough when the port is held by a process
      // we do not own (a leftover from a previous DSH run, or an outdated
      // version) — the spawn would then die with PORT_IN_USE. Clear the port
      // first; `stop` is a no-op when nothing is listening.
      const stopped = await runCli('stop --port ' + PORT, 20000)
      if (stopped && stopped.exitCode !== 0) {
        return { ok: false, error: '端口 ' + PORT + ' 上的旧进程无法停止，请手动结束后重试。', diagnostics: diagnostics() }
      }
      const h = await startService()
      return h ? { ok: true, info: h, diagnostics: diagnostics() } : { ok: false, error: startError || '重启失败', diagnostics: diagnostics() }
    }

    // Browser address bars yield file:///… URLs while the CLI expects a native
    // path. Normalize only for the local existence probe; the Python service
    // repeats this normalization authoritatively for every request.
    const normalizeFileReference = (value) => {
      const raw = String(value || '').trim()
      if (!/^file:/i.test(raw)) return raw
      try {
        const url = new URL(raw)
        if (url.protocol !== 'file:' || url.search || url.hash) return raw
        let path = decodeURIComponent(url.pathname)
        if (IS_WINDOWS && /^[\\/][A-Za-z]:\//.test(path)) path = path.slice(1)
        if (IS_WINDOWS && url.hostname && url.hostname !== 'localhost') path = '//' + url.hostname + path
        return path
      } catch (e) {
        return raw
      }
    }

    const resolvePath = async (file) => {
      if (typeof file !== 'string') return { ok: false, error: 'file is required' }
      const trimmed = file.trim()
      if (!trimmed) return { ok: true, empty: true, isHtml: false, exists: false }
      const normalized = normalizeFileReference(trimmed)
      if (!/\.html?$/i.test(normalized)) return { ok: true, isHtml: false, exists: false }
      if (!shell) return { ok: true, isHtml: true, exists: null, normalized: normalized }
      const python = await resolvePythonCommand()
      // Say WHY the check could not run. Returning a bare `exists: null` renders
      // as no indicator at all, which reads as "the field is ignoring me".
      if (!python) {
        return { ok: true, isHtml: true, exists: null, normalized: normalized, error: startError }
      }
      const probe = 'import os,sys; sys.exit(0 if os.path.isfile(sys.argv[1]) else 1)'
      try {
        const spec = shell.resolve({
          command: python + ' -c ' + quoteArg(probe) + ' ' + quoteArg(normalized),
          timeoutMs: 5000,
          stdoutMaxBytes: 1024,
        })
        const r = await runShell(spec)
        if (r && !r.timedOut && !r.aborted && !r.signal && [0, 1].includes(r.exitCode)) {
          return { ok: true, isHtml: true, exists: r.exitCode === 0, normalized: normalized }
        }
        note('error', '文件检查未完成', describeRun(r))
        return { ok: true, isHtml: true, exists: null, normalized, error: '文件检查未完成，请查看诊断日志。' }
      } catch (e) {
        note('error', '文件检查未完成', e.stack || e)
        return { ok: true, isHtml: true, exists: null, normalized: normalized, error: (e && e.message) || String(e) }
      }
    }

    const listPayload = () => {
      const base = diagnostics()
      base.assets = snapshot()
      return base
    }

    const statusPayload = async () => {
      const h = await health()
      const out = diagnostics()
      out.ok = !!h
      out.running = !!h
      out.info = h || null
      return out
    }

    // `diagnostics()` supervises the child process and revalidates the service,
    // so it can itself throw (a dead handle, a shell that rejects). Since it is
    // the payload every error path attaches, it must never be the thing that
    // turns a readable failure back into an opaque one.
    const safeDiagnostics = () => {
      try {
        return diagnostics()
      } catch (error) {
        return {
          ...diagnosticFacts(),
          ok: false,
          degraded: true,
          error: '收集诊断信息时出错：' + ((error && error.message) || String(error)),
        }
      }
    }

    // 动态传输：Package-private RPC（仅动态运行时存在 harness）。
    if (typeof harness !== 'undefined') {
      const handle = (name, handler) => harness.handle(name, async (args) => {
        try {
          return await handler(args)
        } catch (error) {
          const reason = (error && error.stack) || String(error)
          note('error', 'RPC ' + name + ' 处理失败', reason)
          return { ok: false, error: (error && error.message) || String(error), diagnostics: safeDiagnostics() }
        }
      })
      handle('list', listPayload)
      handle('status', statusPayload)
      handle('open', (args) => openFile(args && args.file))
      handle('resolve', (args) => resolvePath(args && args.file))
      handle('diagnostics', safeDiagnostics)
      handle('restart', restartService)
    }

    // 静态传输：HTTP 路由，供静态 client bundle（fetch）与直接浏览器访问使用。
    const webServer = ctx.get('webServer')
    if (webServer) {
      const sendJson = (res, status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(body))
      }
      const parseQuery = (req) => {
        const qs = (req.url || '').split('?')[1] || ''
        const out = {}
        qs.split('&').forEach((pair) => {
          if (!pair) return
          const eq = pair.indexOf('=')
          const k = decodeURIComponent(eq < 0 ? pair : pair.slice(0, eq))
          const v = decodeURIComponent(eq < 0 ? '' : pair.slice(eq + 1))
          out[k] = v
        })
        return out
      }
      // A handler that throws leaves the request hanging until the browser gives
      // up, and `fetch` then rejects with a bare "Failed to fetch" — the exact
      // dead end this plugin's users hit. Always answer, and answer with the
      // reason plus the journal, so the panel can render something actionable.
      const guard = (name, handler) => async (req, res) => {
        try {
          await handler(req, res)
        } catch (error) {
          const reason = (error && error.stack) || (error && error.message) || String(error)
          note('error', '路由 ' + name + ' 处理失败', reason)
          try {
            sendJson(res, 500, {
              ok: false,
              error: '插件内部错误（' + name + '）：' + ((error && error.message) || String(error)),
              detail: reason,
              diagnostics: safeDiagnostics(),
            })
          } catch (_) { /* the socket is already gone; the journal has the reason */ }
        }
      }
      // Registered FIRST and deliberately dependency-free: if anything below
      // fails to register, this route still answers, which is the only way to
      // read the failure without access to the terminal that started DSH.
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/html-workbench/diagnostics',
        handler: guard('diagnostics', (req, res) => sendJson(res, 200, safeDiagnostics())),
      }), 'html-workbench: diagnostics route')
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/html-workbench/list',
        handler: guard('list', (req, res) => sendJson(res, 200, listPayload())),
      }), 'html-workbench: list route')
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/html-workbench/status',
        handler: guard('status', async (req, res) => sendJson(res, 200, await statusPayload())),
      }), 'html-workbench: status route')
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/html-workbench/open',
        handler: guard('open', async (req, res) => {
          const file = parseQuery(req).file
          const out = await openFile(file)
          sendJson(res, out.ok ? 200 : 400, out)
        }),
      }), 'html-workbench: open route')
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/html-workbench/resolve',
        handler: guard('resolve', async (req, res) => {
          const out = await resolvePath(parseQuery(req).file)
          sendJson(res, out.ok ? 200 : 400, out)
        }),
      }), 'html-workbench: resolve route')
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/html-workbench/restart',
        handler: guard('restart', async (req, res) => {
          const out = await restartService()
          sendJson(res, out.ok ? 200 : 500, out)
        }),
      }), 'html-workbench: restart route')
    }

    // 注册时主动拉起服务（异步，不阻塞 apply）。
    // A rejection here must not escape into Cordis: `apply` has already wired up
    // the transports, and losing them would take the diagnostics route down with
    // it — leaving the panel with nothing but "Failed to fetch" again.
    note('info', '插件宿主已加载', JSON.stringify({ mode, platform: PLATFORM, arch, nodeVersion, script: SCRIPT, runtimeDir: RUNTIME_DIR }))
    Promise.resolve().then(startService).catch((error) => {
      startError = '启动本地服务时发生未预期的错误：' + ((error && error.message) || String(error))
      note('error', startError, (error && error.stack) || null)
    })
  },
}
