---
description: "给已归档会话一个「真删除」的 DSH 插件：二次确认后删除该会话在本机的日志、投影缓存与子代理会话，并完成注册表与内存会话的收尾，让那一行真正从侧边栏消失；面向归档过会话的 Harness 用户，以及本插件的维护者。"
kind: "package-reference"
---

# dsh-true-delete

[English](README.md) | 中文

## Summary

`dsh-true-delete` 给 Harness Web 侧边栏补上一个官方版本没有的破坏性操作：**已归档**会话行上的「删除本地文件…」。点开时先向宿主问清"到底会删什么"，把真实路径与体积列出来，用户明确确认后才删除该会话的日志目录（各代 `jsonl.zstd` 与崩溃残留）与投影缓存记录，连同它名下的子代理会话一起。随后插件把该 id 从工作区注册表里摘掉（归档集合、置顶集合、工作区成员），释放宿主内存里那个闲置的会话对象 —— 不释放它，宿主会一直把已删会话列在列表里 —— 再让页面重新拉一次会话列表，那一行才会真正离开侧边栏。它是插件而不是分叉：宿主半边是一个普通的 Loader bundle，对外只有三个回环路由；页面半边是手写的 `__ModuleLoader__` bundle，不需要构建步骤。内容寻址的附件、请求图片缓存、其他会话，以及 legacy 的 `session_projcache.json` 一律不碰。

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

把 bundle 装进 `desktop` profile，然后在侧边栏已归档会话的 `…` 菜单里就能看到它。新行排在「重命名 / 分叉会话 / 取消归档」下面，且只在已归档的行上出现；普通会话不会提供这一项。profile 里从未加载过的包名会由 HMR 在运行中的应用里直接生效；替换一个**已经加载过**的包的代码则需要重启进程，原因写在 [Known Limitations](#known-limitations-and-deferred-work)。

### Install

两件事必须都发生：包要落进 profile 的 `node_modules`，包名要被选进 `dsh.profile.bundles`。界面里的 **设置 → 插件** 会一次做完这两步；CLI 只负责安装，所以要配上 `scripts/enable-bundle.mjs`。

**按包名安装** —— 常规路径，需要包已发布到 registry：

```bat
"%ProgramFiles%\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add dsh-true-delete
node "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-true-delete\scripts\enable-bundle.mjs" desktop
```

**从 git 仓库安装** —— 发布之前的同一形态，也是唯一不需要 registry 的"名字式"安装：

```bat
"%ProgramFiles%\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add github:YIYuNCU/DSHTrueDelete
node "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-true-delete\scripts\enable-bundle.mjs" desktop
```

**从本地目录安装** —— 开发与离线使用：

```bat
"%ProgramFiles%\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add link:G:\Code\DSH\DSH-True-Delete
node G:\Code\DSH\DSH-True-Delete\scripts\enable-bundle.mjs desktop
```

**手工安装** —— 不用 pnpm 的同一份契约：把 `node_modules\dsh-true-delete` 目录联接指向一份检出，加进 `dependencies` 与 `dsh.profile.bundles`，然后重启。`scripts/enable-bundle.mjs` 读取 `$DSH_HOME`（默认 `%USERPROFILE%\.dsh`），会顺手清掉改名前的旧条目，且只改 bundle 列表这一处；它随包发布，所以上面两条 `node …` 在按包名安装后同样可用。

git 安装之所以可行，是因为本包没有构建步骤、没有安装脚本：仓库根目录就是发布出去的包。

### Publish

`npm publish` 会先通过 `prepublishOnly` 跑完三套检查。实际发布走 `.github/workflows/publish.yml`：推一个 `v*` 标签（或在 Actions 页面手动触发），凭据二选一：

- **可信发布（Trusted Publishing，推荐）** —— 在 npmjs.com 上为本仓库与 `publish.yml` 配置 Trusted Publisher，不需要任何 secret；npm 用工作流的 OIDC 换取短时凭据。npm 正在限制「绕过 2FA 的 token」用于直接发布，这条路才是长期可用的。
- **`NPM_TOKEN`** —— 仓库 secret 里放一个 npm token。注意绕过 2FA 的 token 现在可能只是把发布**放进暂存区**而不是直接生效，见 [Dev Note](#dev-note)。

本包声明了 DSH 的 peer 范围（`^0.2.0-rc.2`）—— 这正是 DSH 兼容性检查读取的清单字段。运行时版本不匹配时，宿主会带着版本诊断拒绝加载插件，而不是让它在运行期出错；显式豁免的方式是 `dsh plugin --profile desktop allow-version dsh-true-delete@<版本> --dsh-version <运行时> --accept-risk`。

### What you see

菜单项打开的是一个由**只读**宿主调用填充的对话框，所以里面那份路径清单是在陈述"这台电脑上有什么"，而不是在描述功能。确认之后执行删除并回报删掉了什么；页面重新拉取列表后，那一行就离开侧边栏。如果磁盘上已经没有属于该会话的东西，对话框会如实说明，确认仍然会清掉注册表里的引用 —— 删除是幂等的。

### What it deletes

| 目标 | 路径 | 说明 |
|---|---|---|
| 会话日志 | `<DSH_HOME>/sessions/<编码后的 cwd>/<sessionId>/` | 整个目录：`session[.vN].jsonl.zstd` 各代，以及 `*.tmp` 崩溃残留 |
| 投影缓存 | `<DSH_HOME>/storages/session_projcache/sessions/<sessionId>.json` | 派生的标题、统计、待办与计划行；坏记录的 `.bak.*` 兄弟文件一并清掉 |
| 子代理会话 | 上两行，遍历父会话 `subagentCatalog` 里的每个 `childId` | 子会话在侧边栏没有自己的入口，父会话是它们唯一的来路 |

删文件只是一半，另一半才决定那一行走不走：

1. 删掉上表及其嵌套子会话对应的文件；
2. 从 `workspaceRegistry` 里清掉该 id —— 归档集合、置顶集合（若被置顶）、以及每个工作区的成员列表；
3. 释放内存里的会话对象。宿主组合会话列表时取的是「存储里的日志 **加** 内存里活的会话」，一个闲置对象就足以让已删会话继续留在列表里；
4. 让页面重新执行 `sessions.refresh()`，用宿主当前的真实状态重建列表。

在第 1–3 步之后还有一次短扫描：把同一批路径再查一遍，这样会话销毁时的收尾写入或投影缓存的 write-behind 就没法在背后悄悄把日志目录重新建出来。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### 一个包，两个半边

`package.json` 按 Harness 的约定同时声明两半：`dsh.bundle.patch` 通过 `cordis.patch.yml` 挂载宿主入口，`dsh.client.platform: 'web'` 让 `exports['./client']` 成为浏览器模块，由模块系统像对待任何内置插件那样提供并加载。浏览器模块 id 必须等于包名 —— 加载器会把 `<id>/client` 规范化回裸 id。卡片上的文案与图标来自清单本身、无需激活插件：`locale/en.json` 与 `locale/zh.json` 提供 `meta.title` 与 `meta.description`，顶层 `icon` 指向包内的 SVG；两者都登记在 `exports` 与 `files` 里。

### 宿主路由与信任栅栏

`lib/index.js` 在一个注入的 fiber 里向 `webServer` 注册三条 exact 路由，因此它们的生命周期跟着这个 fiber：

| 路由 | 作用 |
|---|---|
| `GET /dsh-true-delete/version` | 自检：运行中的宿主进程实际加载的是这一份代码的第几代、具备哪些能力 |
| `GET /dsh-true-delete/status?sessionId=…` | 只读清单：目标、体积、归档状态、内存状态、正在运行的工作 |
| `POST /dsh-true-delete/delete` | 执行删除与全部收尾 |

每条路由在进入 handler 之前都过同一道栅栏：`Host` 必须是格式合法的回环地址、不得带 `Sec-Fetch-Site: cross-site`、出现 `Origin` 时必须与 authority 同源，写操作还必须是回环来源；部署自带的 `connection.requestRejection` 可用时会一并委托。栅栏是 fail-closed 的：畸形请求或自身抛错都按拒绝处理。此外每条路径都要过针对 `$DSH_HOME` 的 `underHome()` 校验与 session id 白名单，构造出来的 id 无法把删除指向无关文件。

### 如何定位一个会话的文件

日志位于以会话 canoncial cwd 命名的项目目录下，而插件不需要知道这个目录：它扫描 `<DSH_HOME>/sessions/*/<sessionId>` 并对 id 做精确匹配，从不模糊匹配。子代理会话来自父会话的投影缓存记录（`record.rows.subagentCatalog.val.head.values[].childId`），必须在**删除之前**读出来；递归带深度上限与 visited 集合。因此清单里是真实路径与真实字节数，对话框展示的正是它们。

### 那一行为什么本来会留下来

`dsh-session-query` 的 `listSessions` 返回的是持久化记录与 `ctx.sessions.list()` 的并集；归档时若会话还开着，它就会留在 store 里，于是删掉文件对侧边栏毫无影响。会话 store 只把移除能力交给 `enter()` 返回的 disposer 所有者，所以插件读取公开的 `liveEntryFor` entry 并调用 `detachEntered` —— 与正常关闭会话走的是同一条销毁路径，包括它的 `session/disposed` 事件。`workspaceRegistry` 暴露的是 `list()` 而不是 `workspaces` 访问器；对一个不含该 id 的工作区做 detach 是幂等空操作，因此收尾会遍历每一个工作区。

### 页面端注册

`lib/client.js` 是一段普通脚本，用包名调用 `window.__ModuleLoader__.load`。它往 `sidebar.workspaces.session.menu.item` 列表注册一行（order 500），往 `shell.overlay` 注册一个覆盖层。菜单行从公开的 `workspaces` 客户端服务读取归档集合，并投影成一个按快照身份记忆化的快照 —— `useSyncExternalStore` 要求同一份数据返回同一个引用；未归档的行直接返回 `null`。它只依赖平台种子模块（`react`、`react/jsx-runtime`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-primitives`），这也是它不需要构建步骤、不需要打包依赖的原因。

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

先读 Harness 自带的插件开发材料，再读本插件消费的那些包。下面这些都能从安装里解析出来；`node tools/asar.mjs cat <内部路径>` 可以把它们从 `app.asar` 里读出来（`DSH_APP_ASAR` 可覆盖归档路径）。

- `@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development` —— bundle 清单、宿主导出形态、客户端清单与插槽注册，以及本插件形态所遵循的模板。
- `@deepseek-ai/dsh-client-modules/README.md` —— `dsh.client` 如何变成一个被提供的浏览器 bundle，以及浏览器模块 id 为什么等于包名。
- `@deepseek-ai/dsh-client-ui-slots/README.md` —— 注册项、注入的 props、hooks，以及声明感知的 `slots.inject`。
- `@deepseek-ai/dsh-client-ui-workspace/README.md` —— 侧边栏的行、它的菜单列表，以及本插件对应实现的归档动作。
- `@deepseek-ai/dsh-workspace/README.md` —— 被本插件清理归档/置顶/成员状态的那个注册表，以及它"会话删除是缺失能力"的表述。
- `@deepseek-ai/dsh-session-persistence-jsonl/README.md` —— 会话日志的磁盘布局，也就是本插件删除的东西。

-----

<a id="model-experience"></a>
## Model Experience

无。插件不注册任何工具、命令或提示词内容，也从不进入模型请求：宿主半边提供三个回环路由，页面半边渲染一行菜单和一个对话框。

#### KV Cache effect

无；插件既不组装也不发送任何 provider 请求。删除一个会话只是让模型以后不会再被问到那段历史 —— 它不会让当前这一轮仍在复用的缓存失效。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **改宿主半边必须重启进程** —— DSH 宿主侧的 HMR 不监视任何模块根目录，而重建 Loader entry 又会命中 Node 的 ESM 缓存，同一个 specifier 拿回的还是旧模块。只有新进程，或一个 profile 从未加载过的包名，才能带来新的宿主代码。页面半边会自行热重载。
- **有正在运行的工作时是拒绝而不是强制** —— 仍通过 `workspace/session-activity` waterfall 报告活动的会话会被拒绝，对话框里会写明活动类型。归档本身会停止会话的工作，所以已归档的行通常是非活动的。
- **附件与缓存有意不在范围内** —— `attachments/**` 是内容寻址且跨会话去重的，`cache/**` 存的是共享的请求图片，两者在磁盘上都没有按会话的归属信息。
- **悬空 id 可能比删除本身活得更久** —— 被中断的运行在工作区记录里留下的 id 会在读取时被过滤、在下一次工作区写操作时被剪掉，因此它是不可见而非有害的。
- **legacy 的 `session_projcache.json` 永不改写** —— 那些记录属于旧布局，只有在一个 per-record 文档都不存在时，当前存储才会从它重新播种。

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

两个半边都是离线验收的，另有一道检查守着这份文档本身；三者都不需要 DSH 在运行。

```bat
npm test                          :: 文档 + 宿主 + 页面，全部离线
node tools/check-docs.mjs         :: 双语锚点、清单、图标与卡片文案
node test\host.test.mjs           :: KEEP=1 会保留临时的 DSH_HOME 便于排查
node test\client.test.mjs         :: 会从 app.asar 里读取真实的 primitives 构建产物
```

`tools/check-docs.mjs` 守着本文件所遵循的 package-reference 形态：frontmatter、固定的小节、每节一个锚点、双语锚点一一对应，以及清单里的 `files`/`exports`/`icon` 与两个 locale 文件里的卡片文案。

宿主套件把 `lib/index.js` 放进一个假的 cordis 上下文，跑在系统临时目录里的假 `$DSH_HOME` 上：信任栅栏、清单（两层子会话、一个非法 `childId`、一个 `.bak` 兄弟文件、另一个会话、共享附件）、未归档与有活动时的拒绝、真删、注册表收尾、活会话释放、补刀扫到模拟的 write-behind、幂等复检，以及 version 路由。页面套件用假的 `window.__ModuleLoader__` 拆开浏览器 bundle，断言每个 `require` 都是平台种子、每个 `primitives.X` 都存在于已安装的构建里，然后渲染两个注册项并检查请求 URL 没有丢 query。

本包有意不提供 `README.i18n.yaml`：那份记录由 monorepo 的 `pnpm run verify-translation-pairing --write` 生成，脱离 monorepo 没有意义。双语文档本身保留，两个文件共用同一套小节骨架与锚点。

凭据若是「绕过 2FA」的 token，发布可能不会直接生效，而是落进 npm 的**暂存区**。在暂存期间，包名解析到的是 `0.0.0-stage` 这个 stub —— 364 字节、只有 `stub: true` 和一句占位描述、**没有 `dsh` 字段** —— 于是 `dsh plugin --profile desktop add dsh-true-delete` 会报 “declares no dsh.bundle”；而且按包名安装会先把已有的安装卸掉，失败后就什么都不剩。用 `npx npm@11 stage list` 看待处理条目，`stage view <id>` 看详情，`stage approve <id>` 放行（npm 会在这里索要 token 绕过的那次 2FA 验证码），`stage reject <id>` 丢弃。从 git 仓库或本地目录安装完全不经过 registry。

关于样式：类名统一用 `dsh-true-delete__` 前缀，样式标签以 `data-plugin-css` 作键，所以浏览器重载后重新注册是替换而不是叠加。

</details>

**Runtime invariant:** 插件只删除解析后位于 `$DSH_HOME` 之内、且由请求 id 推导出的会话级名称所对应的路径；它从不删除共享存储，从不通过文件改写工作区注册表，并在响应里如实汇报某一步降级，而不是让整次删除失败。
