# DSH-True-Delete

> 包名 `dsh-true-delete`；仓库目录名 `DSH-True-Delete`（DSH 客户端模块 id 必须等于包名，所以两者不同名）。

给 DSH 桌面端加一个**真正删掉**已归档会话的按钮：在侧边栏**已归档**那一行的 `…` 菜单里，
「重命名 / 分叉会话 / 取消归档」下面多一行 **删除本地文件…**；点开先列出这台电脑上到底会删哪些文件、
共多大，确认之后才真的删，删完弹一个结果提示，那一行随之从侧边栏消失。

- 只对**已归档**的行出现（未归档的行看不到这一项）。
- 宿主端会再校验一次：未归档的 id 一律拒绝；还有正在运行的工作也拒绝。
- 删除范围仅限该会话自己的数据：会话日志目录 + 投影缓存（含它名下不出现在侧边栏里的子代理会话）。
- `~/.dsh/attachments/**`、`~/.dsh/cache/**`、其他会话、legacy 的 `session_projcache.json` 一律不动。

## 它会删掉什么

| 目标 | 路径 | 说明 |
|---|---|---|
| 会话日志 | `<DSH_HOME>/sessions/<编码后的 cwd>/<sessionId>/` | 整个目录：`session[.vN].jsonl.zstd` 各代 + 崩溃残留的 `*.tmp` |
| 投影缓存 | `<DSH_HOME>/storages/session_projcache/sessions/<sessionId>.json` | 标题 / 统计 / 待办等派生数据；坏记录的 `.bak.*` 一并清掉 |
| 子代理会话 | 同上两条，id 来自父会话投影缓存里的 `subagentCatalog` | 子会话不会出现在侧边栏，父会话一删就再也没入口 |

删完之后，插件会**通过 DSH 自己的服务**收尾，缺一件就会出现「提示删了、行还在」：

1. 删文件（会话日志目录 + 投影缓存，含子会话）；
2. `workspaceRegistry` 里取消归档、取消置顶、从每个工作区摘掉该 id；
3. **把内存里还挂着的会话对象摘掉** —— 宿主列会话是「存储里的 + 内存里活的」取并集
   （`dsh-session-query` 的 `listSessions` 会把 `ctx.sessions.list()` 全并进去），
   不摘掉它，文件删干净了那一行也不会走；
4. 通知页面重新拉一次会话列表（`sessions.refresh()`）。

`<DSH_HOME>` 默认是 `%USERPROFILE%\.dsh`，可用环境变量 `DSH_HOME` 覆盖。

## 目录结构

```
DSH-True-Delete/
├─ package.json          # 包清单：dsh.bundle.patch + dsh.client（平台 web）
├─ cordis.patch.yml      # bundle 挂载声明：把自己作为一条 Loader entry 插进 profile
├─ lib/
│  ├─ index.js           # 宿主半边：路由 + 文件定位与删除 + 注册表收尾
│  └─ client.js          # 页面半边：菜单行 + 二次确认弹窗（手写 bundle，无构建步骤）
├─ scripts/
│  └─ enable-bundle.mjs  # 把包名追加进 profile 的 dsh.profile.bundles
├─ test/
│  ├─ host.test.mjs      # 宿主半边：假 cordis ctx + 假 DSH_HOME 全链路断言
│  └─ client.test.mjs    # 页面半边：模块请求 / 插槽注册 / 渲染路径断言
├─ tools/
│  ├─ asar-lib.mjs       # 极简 asar 读取器（无依赖）
│  └─ asar.mjs           # 命令行：ls / cat / grep DSH 安装包里的文件
├─ LICENSE               # MIT
└─ README.md
```

## 安装

桌面端（profile `desktop`）推荐用自带的插件管理器：

1. 打开 **设置 → 插件**（或侧边栏的插件页），选择「从本地目录安装」；
2. 目录填这份包的绝对路径，例如 `G:\Code\DSH\DSH-True-Delete`；
3. 安装完成后按提示重载 / 重启。

命令行等价做法（宿主可以照常开着）：

```bat
"%ProgramFiles%\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add link:G:\Code\DSH\DSH-True-Delete
node G:\Code\DSH\DSH-True-Delete\scripts\enable-bundle.mjs desktop
```

CLI 只装包，不会把包选进 profile 的 bundle 列表，所以第二行补上（插件管理器安装会自动做这一步）。

手工安装（等价，适合离线排查）：

1. 把本目录放到任何位置；
2. 在 `%USERPROFILE%\.dsh\profiles\desktop\node_modules\` 下建一个指向它的目录联接：
   `mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-true-delete" "G:\Code\DSH\DSH-True-Delete"`；
3. `package.json` 的 `dependencies` 加 `"dsh-true-delete": "link:G:\\Code\\DSH\\DSH-True-Delete"`，
   `dsh.profile.bundles` 追加 `"dsh-true-delete"`；
4. 重启 DSH。

## 测试

无需 DSH 运行，全部离线：

```bat
node test\host.test.mjs      :: 或 npm test
node test\client.test.mjs
```

- **宿主半边**跑在系统临时目录里的假 `DSH_HOME` 上，覆盖：信任栅栏、清单（含二层子会话、坏记录备份、
  不碰别人的会话与共享附件）、未归档拒绝、有活动拒绝、真删、注册表收尾、活会话释放、补刀、
  幂等复检、`version` 自检。`KEEP=1` 可保留临时目录便于排查。
- **页面半边**用假的 `window.__ModuleLoader__` 拆开 bundle：require 的模块必须都在平台种子表里，
  用到的 `primitives.X` 必须在真实构建的导出名单里（直接从安装包的 `app.asar` 里现读，
  可用环境变量 `DSH_APP_ASAR` 指定归档路径），并断言插槽注册形状、菜单项显隐与请求 URL 不丢 query。

## 实现要点

宿主半边只用公开服务：`webServer`（挂路由）、`workspaceRegistry`（清归档/置顶/工作区归属）、
`sessionProjectionCache`（丢缓存记录）、`sessions`（释放内存里挂着的会话对象）、
`connection`（宿主自带的信任栅栏）。任何一个缺失都只是降级并如实汇报，不会让宿主起不来。

三个路由，全部先过信任栅栏（回环 Host、同源 Origin、拒绝 `Sec-Fetch-Site: cross-site`，
写操作必须是本机来源，并委托 `connection.requestRejection`，任何异常一律按拒绝处理）：

| 路由 | 作用 |
|---|---|
| `GET /dsh-true-delete/version` | 自检：确认运行中的进程加载了哪一份代码、具备哪些能力 |
| `GET /dsh-true-delete/status?sessionId=…` | 只查不改：返回将删除的清单、体积、归档状态、活动状态 |
| `POST /dsh-true-delete/delete` | 执行删除与全部收尾 |

删除路径全部先过 `underHome()` 校验，`sessionId` 走白名单正则 —— 宁可不删，也不删错。

页面半边不用打包器：DSH 的客户端模块加载器直接吃 `window.__ModuleLoader__.load`，
而 `react` / `react/jsx-runtime` / `@deepseek-ai/dsh-client-store` / `@deepseek-ai/dsh-client-ui-primitives`
都在平台种子模块表里，所以不需要构建步骤。

## 边角情况

- **还有正在运行的工作**：拒绝删除。判据用的是 DSH 自己那把尺子 —— 归档前问的
  `workspace/session-activity` waterfall；对话框里会直接写明是哪一类活动。
- **内存里还挂着一个闲置的会话对象**（归档后很常见）：允许删除；删完会释放它，再等 250ms 扫一遍，
  把这段窗口里被 write-behind 写回来的日志/缓存补删一次，免得过一阵子又长出一行「幽灵会话」。
- **未归档的会话**：拒绝删除（这个按钮就是给已归档内容用的）。
- **子代理会话**：跟着父会话一起删；确认框里会标明「其中包含 N 个子代理会话」。
- **会话日志有多代**（`session.jsonl.zstd` / `session.v3.jsonl.zstd` / …）：整个目录一起删。
- **重复点击 / 残留**：删除是幂等的；如果磁盘上已经什么都没有，确认框会提示「没有找到属于该会话的本地文件」，
  但点确认依然会把注册表里的悬空引用清掉。

## 卸载

从 `dsh.profile.bundles` 和 `dependencies` 里去掉 `dsh-true-delete`，删掉 `node_modules` 下的联接/目录，
重启即可。删除动作本身不会在系统里留下其它痕迹（没有配置、没有后台进程、没有数据库）。

## 开发笔记

- **改了 `lib/client.js`（页面半边）**：不必重启。DSH 的 client-hmr 会轮询 bundle 的
  mtime/ctime/size，命中后走 `clientModules.rebuilt()` 把新 bundle 推给页面。
- **改了 `lib/index.js`（宿主半边）**：**必须重启 DSH**。实测结论（两条都验证过）：
  1. 宿主侧 hmr 的 `root` 是空数组 —— 不监视任何模块文件；
  2. 把插件从 `dsh.profile.bundles` 里摘掉再放回去，配置层确实会就地重载
     （路由先 404、再回来），但 **Node 的 ESM 缓存 + loader 按 specifier 缓存包元数据**，
     重新加载的还是旧模块；连把 `main` 换成一个全新文件名都不行。所以只有重启进程这一条路。
- **怎么确认运行中的进程加载了哪一份代码**：`GET /dsh-true-delete/version`。
  未鉴权时栅栏会先返回 **401**（说明这个路由存在 = 新代码已上线），路由不存在则是 **404**。
- 排查 DSH 安装包内部实现：`node tools/asar.mjs ls|cat|grep`（归档默认 `G:\DSH\resources\app.asar`，
  可用 `DSH_APP_ASAR` 覆盖）。
