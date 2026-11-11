/**
 * HTML Workbench DSH plugin — static host entry.
 *
 * Evaluates the canonical plugin body in `src/host.js` (the very same text
 * passed to `cordis_define` as `code.host`) and re-exports it for the Cordis
 * loader. The bundled Python service ships next to this package
 * (`scripts/workbench.py` + `assets/workbench.html`), so its absolute path is
 * resolved relative to THIS module (`import.meta.url`) — never hard-coded to a
 * specific machine — and handed to the shared body as `config.script`.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const scriptPath = resolve(here, '..', 'scripts', 'workbench.py')
// The panel shows this next to the diagnostics so a pasted report says WHICH
// build produced it — without it, every bug report needs a follow-up question.
const version = JSON.parse(readFileSync(resolve(here, '..', 'package.json'), 'utf8')).version

// Must match RUNTIME_DIR_NAME in scripts/workbench.py, so the host's first guess
// and the service's own in-process fallback land in the SAME folder instead of
// scattering two differently named directories through the user's workspace.
const RUNTIME_DIR_NAME = '.html-workbench'

/**
 * Whether this process can really create files in `dir` (mkdir + write + delete).
 *
 * A writable-looking DACL proves nothing: DSH runs the Python service as a
 * sandboxed child whose restricted token may write only the session workspace and
 * a private temp directory it hands the child through TEMP/TMP — never the
 * ambient %TEMP% root the parent sees. Probing by an actual create is the only
 * test that reflects what a child can do, and the probe must fail fast (see
 * `make_temp_file` in workbench.py for why `tempfile.mkstemp` is unusable here).
 *
 * A successful probe leaves the directory behind, so it is marked ignored right
 * away: the runtime root normally sits in the user's own repository, and probing
 * must not be what dirties their `git status` (see `self_ignore` in workbench.py,
 * which does the same for the directory the service settles on).
 */
const probeWritableDir = (dir) => {
  try {
    mkdirSync(dir, { recursive: true })
    const probe = join(dir, '.wb-write-probe-' + process.pid)
    writeFileSync(probe, '')
    rmSync(probe, { force: true })
    if (!existsSync(join(dir, '.gitignore'))) {
      writeFileSync(join(dir, '.gitignore'), '# Created by html-workbench: disposable logs and cache.\n*\n')
    }
    return true
  } catch (e) {
    return false
  }
}

/**
 * Choose the runtime directory to ASK the service for.
 *
 * The workspace comes first: it is the one tree the sandbox reliably grants and it
 * keeps the re-downloadable GrapesJS cache across restarts. The historical temp
 * location stays as a fallback for deployments with no writable cwd.
 *
 * This is a request, not a guarantee — the probe runs with the parent's rights,
 * which are wider than the child's. The service re-probes in-process, falls back
 * on its own, and reports the directories it really used, so a wrong guess here
 * costs a different folder, never a failed start.
 */
const resolveRuntimeDir = () => {
  const candidates = [
    process.cwd() ? join(process.cwd(), RUNTIME_DIR_NAME) : null,
    join(tmpdir(), RUNTIME_DIR_NAME),
  ]
  for (const candidate of candidates) {
    if (candidate && probeWritableDir(candidate)) return candidate
  }
  return candidates[0] || join(tmpdir(), RUNTIME_DIR_NAME)
}

const runtimeDir = resolveRuntimeDir()

// The body is a `return { ... }` statement; wrap it in a function and call it.
// eslint-disable-next-line no-new-func
const makePlugin = new Function(readFileSync(new URL('./host.js', import.meta.url), 'utf8'))
const plugin = makePlugin()

const LOG_MAX_BYTES = 1024 * 1024
const LOG_BACKUP_COUNT = 2

function createHostLog(directory, port) {
  const logDir = join(directory, 'logs')
  const file = join(logDir, 'dsh-host-' + port + '.log')
  return {
    file,
    append(entry) {
      mkdirSync(logDir, { recursive: true })
      const line = JSON.stringify({ ...entry, at: new Date(entry.at).toISOString(), pid: process.pid }) + '\n'
      const size = statSync(file, { throwIfNoEntry: false })?.size || 0
      if (size + Buffer.byteLength(line) > LOG_MAX_BYTES) {
        for (let i = LOG_BACKUP_COUNT; i >= 1; i -= 1) {
          const from = i === 1 ? file : file + '.' + (i - 1)
          const to = file + '.' + i
          if (existsSync(from)) renameSync(from, to)
        }
      }
      appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 })
    },
  }
}

export const name = 'html-workbench'
export const inject = plugin.inject ?? []
// Inject paths resolved by Node rather than assuming POSIX separators. A
// deployment-provided config may still override every value.
export const apply = (ctx, config) => {
  const options = { script: scriptPath, runtimeDir, version, ...(config || {}) }
  return plugin.apply(ctx, {
    ...options,
    hostLog: createHostLog(options.runtimeDir || runtimeDir, options.port || 4317),
  })
}
