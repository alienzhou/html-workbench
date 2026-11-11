/**
 * Build the DSH plugin's distributable artifacts from `src/` and `service/`:
 *
 *   1. lib/client.js          — static client bundle (wraps src/client.js).
 *   2. scripts/workbench.py   — copy of the Python service (self-contained).
 *   3. assets/workbench.html  — the bundled frontend served by that service.
 *
 * Run via `npm run build` (or automatically as `prepublishOnly` before
 * `npm publish`). The service copies come from the sibling `service/` source.
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, chmodSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '..')
const PLUGIN_ID = '@vibe-x/dsh-html-workbench'

// ── 1) client bundle ────────────────────────────────────────────────────────
const body = readFileSync(resolve(here, 'src/client.js'), 'utf8')
const bundle = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(PLUGIN_ID)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    // Closure symbols — the same names the dynamic runner injects.
    const React = require('react');
    // Replace-on-insert (never bail when the id already exists): a stale
    // stylesheet left over from a previous plugin generation would otherwise
    // silently win and break the layout while the JS behaves correctly.
    const styles = {
      insert(css) {
        if (typeof document === 'undefined') return () => {};
        const id = 'html-workbench-dsh-plugin-styles';
        const prev = document.getElementById(id);
        if (prev && prev.parentNode) prev.parentNode.removeChild(prev);
        const el = document.createElement('style');
        el.id = id;
        el.textContent = css;
        document.head.appendChild(el);
        return () => { if (el.parentNode) el.parentNode.removeChild(el); };
      },
    };
    const host = {
      call(method, args) {
        const a = args || {};
        const params = Object.keys(a)
          .filter((k) => a[k] !== undefined && a[k] !== null)
          .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(String(a[k])))
          .join('&');
        const url = '/html-workbench/' + method + (params ? '?' + params : '');
        // A browser client may update before DSH reloads the Node-side host. An
        // old host does not know newer routes (e.g. diagnostics/restart) and
        // falls through to the SPA HTML shell. Never expose that as the useless
        // Do not expose a raw JSON parse error; name the version mismatch and
        // tell the user to restart the DSH host process.
        return fetch(url).then(async (response) => {
          const text = await response.text();
          const contentType = response.headers.get('content-type') || '';
          if (!contentType.includes('application/json')) {
            const staleHost = /<!doctype html|<html[\s>]/i.test(text);
            throw new Error(staleHost
              ? 'HTML Workbench 的界面已更新，但 DSH 后台仍是旧版本，暂不支持「' + method + '」。请完全重启 DSH 后重试。'
              : '本地服务返回了非 JSON 响应（HTTP ' + response.status + '）。');
          }
          try {
            return JSON.parse(text);
          } catch (error) {
            throw new Error('本地服务返回了无法解析的 JSON（HTTP ' + response.status + '）。');
          }
        }, (error) => {
          // fetch REJECTS (rather than resolving with a status) when the request
          // never reached DSH's web server. Left alone, the browser's bare
          // "Failed to fetch" surfaced in the panel — the single least actionable
          // string in this plugin, and the one users reported. It also means the
          // host half never ran, so none of its diagnostics exist yet: the only
          // useful thing to report is WHICH request died and what to check.
          const reason = (error && error.message) || String(error);
          throw new Error(
            '无法连接 HTML Workbench 后台（' + method + '）。请求 /html-workbench/' + method + ' 没有到达 DSH。'
            + '通常说明插件的 Node 半没有加载成功，或 DSH 尚未重启以注册该路由。'
            + '请完全重启 DSH；若仍失败，请在启动 DSH 的终端里查找 [html-workbench] 开头的报错。'
            + '（底层错误：' + reason + '）'
          );
        });
      },
    };

    const plugin = (() => {
      ${body}
    })();

    exports.inject = plugin.inject ?? [];
    exports.apply = plugin.apply;
    return module.exports;
  },
});
`
mkdirSync(resolve(here, 'lib'), { recursive: true })
writeFileSync(resolve(here, 'lib/client.js'), bundle)

// ── 2) copy the Python service ──────────────────────────────────────────────
mkdirSync(resolve(here, 'scripts'), { recursive: true })
copyFileSync(resolve(projectRoot, 'service/server/workbench.py'), resolve(here, 'scripts/workbench.py'))
chmodSync(resolve(here, 'scripts/workbench.py'), 0o755)

// ── 3) bundle the frontend ──────────────────────────────────────────────────
async function bundleFrontend(frontendRoot) {
  const [template, css, js] = await Promise.all([
    readFile(join(frontendRoot, 'index.html'), 'utf8'),
    readFile(join(frontendRoot, 'workbench.css'), 'utf8'),
    readFile(join(frontendRoot, 'workbench.js'), 'utf8'),
  ])
  const shell = template
    .replace('<link rel="stylesheet" href="/workbench.css">', '<!-- WORKBENCH_CSS_BUNDLE -->')
    .replace('<script type="module" src="/workbench.js"></script>', '<!-- WORKBENCH_JS_BUNDLE -->')
  const markers = ['WORKBENCH_CSS_BUNDLE', 'WORKBENCH_JS_BUNDLE']
  if (!markers.every((m) => shell.includes(`<!-- ${m} -->`))) throw new Error('Frontend template is missing a bundle marker')
  return shell
    .replace('<!-- WORKBENCH_CSS_BUNDLE -->', () => `<style data-bundle="workbench">\n${css}\n</style>`)
    .replace('<!-- WORKBENCH_JS_BUNDLE -->', () => `<script type="module" data-bundle="workbench">\n${js.replaceAll(/<\/script/gi, '<\\/script')}\n</script>`)
}

const html = await bundleFrontend(resolve(projectRoot, 'service/public'))
mkdirSync(resolve(here, 'assets'), { recursive: true })
writeFileSync(resolve(here, 'assets/workbench.html'), html)

console.log('built lib/client.js (' + bundle.length + ' bytes), scripts/workbench.py, assets/workbench.html')
