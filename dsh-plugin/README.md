# HTML Workbench DSH Plugin

在 DeepSeek Harness（DSH）的右侧栏预览并可视化编辑 agent 生成的 HTML 文件。它复用（或拉起）HTML Workbench 的本地 Python 服务，把 GrapesJS 编辑器内嵌到页面 iframe 里，直接改文案/样式/图片、切 Preview 验证交互、Save 写回磁盘。

> 只托管源码，不做编译/打包。插件通过 `shell` 服务拉起仓库里**已生成**的 runnable workbench（`skill/html-workbench/scripts/workbench.py`，由根目录 `npm run build` 从 `service/` 生成）。

## 面板席位

面板优先使用 profile 提供的侧栏，入口在右侧栏的「新标签页」列表：

- **有 DSH 原生右侧栏**：直接注册 `html-workbench` 标签，并使用 `keepMounted: true`，切换标签、会话或收起侧栏时保留编辑器与未保存的内容。每个标签的文件路径、加载状态和编辑器相互独立。
- **只有 `dsh-better-sidebar` 服务**：通过它的注册表提供侧栏页面，兼容旧 profile。
- **两种侧栏服务都没有**：保留浮窗和右上角入口，左边缘可拖拽调宽。

两种侧栏席位都由宿主管理宽度、边框和关闭，工作台不再往 `#root` 写右边距。服务通过 `ctx.inject` 动态检测，加载顺序不影响选择；原生侧栏优先，避免重复入口，服务移除时自动回退。

已实测 DSH `0.2.0-rc.2` + `dsh-better-sidebar` `0.24.1`。后者的原生适配层尚未传递 `keepMounted`，所以在当前 DSH 上直接使用官方注册表，以免切换标签时卸载编辑器。旧 profile 的保留行为仍取决于其侧栏宿主。

## 目录结构

```
dsh-plugin/
├── src/
│   ├── host.js      # Host 半函数体（返回 { inject, apply }）——动态与静态共用
│   ├── client.js    # Client 半函数体（返回 { inject, apply }）——动态与静态共用
│   └── index.js     # 静态 Host 入口：读取 host.js 并 re-export
├── dsh.plugin.json  # 插件清单
├── cordis.patch.yml # 静态装载的 profile 补丁（--patch）
├── package.json
└── README.md
```

`src/host.js` 和 `src/client.js` 里的 `return { ... }` 是**唯一事实源**——同一段函数体同时服务两种装载方式。

## 装载方式

### 动态热装载（开发期热调试，当前使用中）

把 `src/host.js` / `src/client.js` 的文本分别作为 `code.host` / `code.client` 提交给 `cordis_define`，再 `cordis_run`。零停机，源码只存在于运行中的 DSH 进程里，进程重启后需重新装载。

`host.js` 默认用本机仓库内的 `skill/html-workbench/scripts/workbench.py` 拉起服务。

### 静态装载（已发布 NPM）

`cordis.patch.yml` + `package.json` 的 `dsh.bundle` 把插件作为一层 profile 装载；Client 半由 `npm run build` 打成 `lib/client.js`（`window.__ModuleLoader__.load`）。`prepublishOnly` 会自动构建，所以 `lib/`、`scripts/`、`assets/` 是构建产物、不入库。

## 服务生命周期（副作用管理）

- **注册时**：`apply` 里异步 `startService()`，先 `health` 探测 `4317`；已在运行则复用（不认领），否则 `shell.start` 后台拉起 `workbench.py serve`。
- **卸载时**：`ctx.effect` 的 disposer `kill()` 掉本插件自己启动的那个进程；复用的服务不误杀。

## 运行时目录（Windows 沙箱）

服务日志与 GrapesJS 缓存写在 `<工作区>/.html-workbench/`（常量 `RUNTIME_DIR_NAME`，Host 与 `workbench.py` 必须一致）。

这些路径是**请求，不是保证**：服务是 DSH 的沙箱子进程，只能写会话工作区和沙箱交给它的私有临时目录，**系统 `%TEMP%` 根一律拒绝**——即使父进程能建出那个文件夹，子进程也写不进去。因此：

- `workbench.py` 在**自身进程内**用一次真实创建探测候选目录，被拒就立刻换下一个（工作区 → 私有临时目录），并把**实际使用**的目录写进 `/api/health` 的 `logDir` / `vendorCache`；
- Host 采纳上报值（`adoptResolvedPaths`），于是面板显示的是真实路径，而不是它请求过的路径；复用别的进程启动的服务时同样如此；
- 探测**不允许重试**：Windows 上 `tempfile.mkstemp` 遇到 `PermissionError` 会用只看 DACL 的 `os.access` 复检、再换随机名重试 10 000 次，会把"1 秒报错"变成"卡住数分钟并烧 CPU"。故改用 `make_temp_file()` 的单次 `O_EXCL` 打开。

日志目录**全部候选都不可写**时，服务挂 `NullHandler` 照常启动：丢一份诊断日志可以接受，端口不 bind 不可以。

工作区通常就是**用户自己的仓库**，所以建出目录的那一半会在运行时根写入内容为 `*` 的 `.gitignore`（`self_ignore()` / `probeWritableDir()`），让整棵树连同该文件一起对 git 隐形——本仓库的 `.gitignore` 只管得住自己的 checkout。判定依据是 `RUNTIME_DIR_NAME` 而非传入目录，否则 `--log-dir .` 会把用户的源码树整个变成被忽略的。

## RPC 接口（Client → Host）

| method   | 入参        | 返回                                   |
| -------- | ----------- | -------------------------------------- |
| `list`   | —           | `{ ok, running, owned, port, assets }` |
| `status` | —           | `{ ok, running, owned, port, info }`   |
| `open`   | `{ file }`  | `{ ok, url, reused, port }`            |

`assets` 来自监听 `tools/result`，收集 `write`/`edit` 工具产出的 `.html` 文件路径。
