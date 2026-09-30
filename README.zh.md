---
description: "一个真正删除已归档会话的 DSH 插件：侧边栏的 … 菜单里多出「删除本地文件…」，先列出到底会删掉什么，确认一次后删除会话日志、投影缓存与子代理会话，并清干净注册表与内存会话，让那一行也从侧边栏消失。"
---

# dsh-true-delete

[English](README.md) | 中文

DSH 能归档会话、改名、再恢复，却没有任何办法把它删掉 —— 已归档的会话会一直占着磁盘。这个插件补上这个缺失的动作，并且把收尾一并做完，所以删掉的会话不会变成一行点不开又赶不走的幽灵记录。

## 目录

- [它做什么](#what-it-does)
- [安装](#install)
- [怎么用](#use-it)
- [会删掉什么](#what-gets-deleted)
- [安全边界](#safety)
- [常见问题](#troubleshooting)
- [卸载](#uninstall)
- [维护者备注](#for-maintainers)
- [许可证](#license)

-----

<a id="what-it-does"></a>
## 它做什么

**已归档**会话的 `…` 菜单里会多出一行 **删除本地文件…**，排在「重命名 / 分叉会话 / 取消归档」下面。点开是一个对话框，逐条列出这台电脑上会被删掉的东西 —— 真实路径、真实体积 —— 在你确认之前什么都不会发生：

- 会话日志目录：各代 `session[.vN].jsonl.zstd`，以及崩溃残留的 `*.tmp`；
- 它的投影缓存记录（派生的标题、统计、待办、计划），以及坏记录留下的 `.bak` 兄弟文件；
- 它名下的每一个子代理会话 —— 那些在侧边栏没有自己的入口，父会话是它们唯一的来路。

删文件只是把事情做了一半。DSH 的会话列表是「存储里的日志」**加上**「内存里活着的会话」，所以只删文件会留下一行既点不开、又删不掉的记录。插件还会把该 id 从工作区注册表里摘掉（归档集合、置顶集合、工作区成员），释放内存里的会话对象，并让页面重新拉一次列表 —— 那一行才会消失。

<a id="install"></a>
## 安装

两件事必须都发生：包装进 profile 的 `node_modules`，包名被选进 `dsh.profile.bundles`。**设置 → 插件** 会一次做完这两步；命令行只负责安装，所以还要再跑一条选择命令。装完重启一次 DSH —— 插件的宿主半边是在启动时加载的。

**按包名安装** —— 常规路径，需要包已在 registry 上：

```bat
"%ProgramFiles%\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add dsh-true-delete
node "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-true-delete\scripts\enable-bundle.mjs" desktop
```

**从 git 仓库安装** —— 发布之前也能用，完全不经过 registry：

```bat
"%ProgramFiles%\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add github:YIYuNCU/DSHTrueDelete
node "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-true-delete\scripts\enable-bundle.mjs" desktop
```

**从本机目录安装** —— 适合自己检出的一份代码，或离线安装：

```bat
"%ProgramFiles%\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add link:G:\Code\DSH\DSH-True-Delete
node G:\Code\DSH\DSH-True-Delete\scripts\enable-bundle.mjs desktop
```

那个脚本读取 `$DSH_HOME`（默认 `%USERPROFILE%\.dsh`），会顺手清掉改名前的旧条目，并且只改 bundle 列表这一处。

<a id="use-it"></a>
## 怎么用

1. 归档这个会话 —— 或者直接挑一条已归档的。这一项只在已归档的行上出现，普通会话不会提供任何删除入口。
2. 打开它的 `…` 菜单，选 **删除本地文件…**。
3. 读一遍对话框：每条路径和它的体积都在里面，还会写明包含多少个子代理会话。此时什么都还没动。
4. 按 **永久删除**。文件被删掉、注册表被清干净，随后弹出一条提示，说明删了多少个文件、多少数据。
5. 页面重新拉取列表后，那一行从侧边栏消失。

中途取消就什么都不会发生 —— 在确认之前，对话框是只读的。

<a id="what-gets-deleted"></a>
## 会删掉什么

| 目标 | 路径 | 说明 |
|---|---|---|
| 会话日志 | `<DSH_HOME>/sessions/<编码后的 cwd>/<sessionId>/` | 整个目录：各代 `session[.vN].jsonl.zstd`，以及 `*.tmp` 崩溃残留 |
| 投影缓存 | `<DSH_HOME>/storages/session_projcache/sessions/<sessionId>.json` | 派生的标题、统计、待办与计划；坏记录的 `.bak.*` 兄弟文件一并清掉 |
| 子代理会话 | 上两行，遍历父会话 `subagentCatalog` 里的每个 `childId` | 子会话在侧边栏没有自己的入口 |

`<DSH_HOME>` 默认是 `%USERPROFILE%\.dsh`，可用环境变量 `DSH_HOME` 覆盖。

文件删完之后还有四步收尾：从工作区注册表里清掉该 id、释放内存里的会话对象、丢掉投影缓存记录，再等四分之一秒把同一批路径复查一遍 —— 这样会话关闭时的收尾写入或缓存的 write-behind 就没法在背后悄悄把日志目录重新建出来。

<a id="safety"></a>
## 安全边界

- **只删已归档的会话。** 未归档的 id 一律拒绝；还在跑活的会话也拒绝 —— 对话框会写明它看到的是哪一类活动，请先停掉再删。归档本身就会停掉会话的工作，所以已归档的行通常是非活动的。
- **共享资源一律不碰。** 附件是内容寻址且跨会话去重的，请求图片缓存是共享的，其他会话不在本插件职责范围内 —— 包括属于旧布局的 legacy `session_projcache.json`。
- **删除范围精确可控。** 每条路径都会先解析并确认落在 `$DSH_HOME` 之内，会话 id 做精确匹配而非模糊匹配，畸形 id 直接拒绝。
- **只有你自己的机器能调用它。** 宿主路由拒绝跨站请求、要求同源，写操作只接受回环来源，并且会一并委托 DSH 自带的浏览器鉴权栅栏。
- **重复删除无害。** 对一个已经删干净的会话再点一次，会提示「没有找到属于该会话的本地文件」，同时仍会清掉注册表里可能残留的引用。

<a id="troubleshooting"></a>
## 常见问题

**按包名安装时报 “declares no dsh.bundle”。** 此刻 registry 把这个名字解析成了占位包，而不是真包 —— 首次发布停在 npm 的暂存区时就会这样：名字指向一个 364 字节、没有任何 `dsh` 字段的 stub。改用 git 仓库或本机目录安装，或者用 `npx npm@11 stage list` 找到条目、`npx npm@11 stage approve <id>` 把它放行。注意：按包名安装失败时，它已经先把原有的安装卸掉了，所以之后要重新装一次。

**菜单里没有这一项。** 确认 `dsh-true-delete` 在 `dsh.profile.bundles` 里（把 `enable-bundle.mjs` 那条命令再跑一次），然后重启 DSH。另外这一项只出现在已归档的行上。

**删完那一行还在。** 你用的是早于 0.2.0 的版本 —— 它只删了文件，没有释放内存里的会话对象。重启一次 DSH，那一行就会消失；或者再点一次删除。

**提示「还有正在运行的工作」。** 说明那个会话确实在跑东西 —— 一轮对话、一个子代理、一个后台任务或一个定时任务。等它结束，或用 DSH 自己的停止按钮处理掉，再删。

**提示 “incompatible with dsh …”。** 本包声明了它支持的 DSH 版本范围。运行时版本不匹配时，宿主会拒绝加载它，而不是让它在运行期出错；确实要冒险的话，可以显式放行：`dsh plugin --profile desktop allow-version dsh-true-delete@<版本> --dsh-version <运行时> --accept-risk`。

**改了插件却没有任何变化。** 页面半边改动后刷新即可生效；宿主半边（`lib/index.js`）必须重启 DSH —— 宿主侧的代码不做热重载。

<a id="uninstall"></a>
## 卸载

在 `%USERPROFILE%\.dsh\profiles\desktop\package.json` 里把 `dsh-true-delete` 从 `dependencies` 与 `dsh.profile.bundles` 中去掉，删掉该 profile 的 `node_modules` 下它的目录或联接，然后重启 DSH。删除会话本身不会留下别的东西：没有配置项、没有后台进程、没有数据库。

-----

<a id="for-maintainers"></a>
## 维护者备注

<details>
<summary>实现、测试与发布 —— 点击展开</summary>

### 目录结构

```
lib/index.js     宿主半边：三个回环路由、文件定位与删除、收尾
lib/client.js    页面半边：菜单行与二次确认对话框（手写 bundle）
cordis.patch.yml bundle 挂载声明（挂载宿主入口）
scripts/         enable-bundle.mjs（把包选进 profile 的 bundle 列表）
locale/          插件管理器卡片上的标题与描述
test/            两个半边的离线测试
tools/           asar 读取器（查看 DSH 安装包）与文档/清单检查
```

`package.json` 按 Harness 的约定同时声明两半：`dsh.bundle.patch` 挂载宿主入口，`dsh.client.platform: 'web'` 让 `exports['./client']` 成为浏览器模块，由模块系统像对待内置插件那样提供并加载；`locale/*.json` 与 `icon` 提供插件管理器卡片；`peerDependencies['@deepseek-ai/dsh']` 就是 DSH 兼容性检查读取的范围。浏览器模块 id 必须等于包名 —— 加载器会把 `<id>/client` 规范化回裸 id。

### 宿主路由与信任栅栏

| 路由 | 作用 |
|---|---|
| `GET /dsh-true-delete/version` | 自检：运行中的进程加载的是宿主文件的第几代、具备哪些能力 |
| `GET /dsh-true-delete/status?sessionId=…` | 只读清单：目标、体积、归档状态、活动状态 |
| `POST /dsh-true-delete/delete` | 执行删除与全部收尾 |

每条路由在进入 handler 之前都过同一道栅栏：`Host` 必须是格式合法的回环地址、不得带 `Sec-Fetch-Site: cross-site`、出现 `Origin` 时必须与 authority 同源、写操作必须是回环来源，并委托部署自带的 `connection.requestRejection`。栅栏 fail-closed。此外每条路径都要过 `underHome()` 与 session id 白名单。

### 那一行为什么本来会留下来

`dsh-session-query` 的 `listSessions` 返回的是持久化记录与 `ctx.sessions.list()` 的**并集**，而归档时若会话还开着，它就会留在 store 里。移除能力只交给 `enter()` 返回的 disposer 所有者，所以插件读取公开的 `liveEntryFor` entry 并调用 `detachEntered` —— 与正常关闭会话走同一条销毁路径，包括它的 `session/disposed` 事件。注册表暴露的是 `list()` 而不是 `workspaces` 访问器；对一个不含该 id 的工作区做 detach 是幂等空操作，因此收尾会遍历每一个工作区。

### 测试

两个半边都是离线验收的，两套测试都不需要 DSH 在运行。

```bat
npm test                          :: 文档 + 宿主 + 页面，全部离线
node tools/check-docs.mjs         :: 双语锚点、中文标题、清单、图标与卡片文案
node test\host.test.mjs           :: KEEP=1 会保留临时的 DSH_HOME 便于排查
node test\client.test.mjs         :: 会从 app.asar 里读取真实的 primitives 构建产物
```

宿主套件把 `lib/index.js` 放进假的 cordis 上下文、跑在假的 `$DSH_HOME` 上：信任栅栏、清单（两层子会话、一个非法 `childId`、一个 `.bak` 兄弟文件、另一个会话、共享附件）、未归档与有活动时的拒绝、真删、注册表收尾、活会话释放、补刀扫到模拟的 write-behind、幂等复检，以及 version 路由。页面套件用假的 `window.__ModuleLoader__` 拆开浏览器 bundle，断言每个 `require` 都是平台种子、每个 `primitives.X` 都存在于已安装的构建里，然后渲染两个注册项并检查请求 URL 没有丢 query。

### 发布

`npm publish` 会先通过 `prepublishOnly` 跑完三套检查。实际发布走 `.github/workflows/publish.yml`：推一个 `v*` 标签或在 Actions 页面手动触发，凭据二选一：

- **可信发布（Trusted Publishing，推荐）** —— 在 npmjs.com 上为本仓库与 `publish.yml` 配置 Trusted Publisher，不需要任何 secret；npm 用工作流的 OIDC 换取短时凭据。npm 正在限制「绕过 2FA 的 token」用于直接发布，这条路才长期可用。
- **`NPM_TOKEN`** —— 仓库 secret 里放一个 npm token。绕过 2FA 的 token 现在可能只是把发布**放进暂存区**；在暂存期间名字解析到 `0.0.0-stage` 那个 stub（见「常见问题」），按包名安装会一直失败，直到该条目被放行或丢弃。

### 文档约定

`README.md` 是英文、`README.zh.md` 是中文，**中文版的标题一律用中文**；两份文档共用同一套 `<a id>` 锚点，保持结构对齐。`tools/check-docs.mjs` 会检查这一点，同时检查清单的 `files`/`exports`/`icon` 与 `locale/` 里的卡片文案。本包有意不提供 `README.i18n.yaml`：那份记录由 monorepo 的 `pnpm run verify-translation-pairing --write` 生成，脱离 monorepo 没有意义。

**Runtime invariant:** 插件只删除解析后位于 `$DSH_HOME` 之内、且由请求 id 推导出的会话级名称所对应的路径；它从不删除共享存储，从不通过文件改写工作区注册表，并在响应里如实汇报某一步降级，而不是让整次删除失败。

</details>

<a id="license"></a>
## 许可证

MIT —— 见 [LICENSE](LICENSE)。
