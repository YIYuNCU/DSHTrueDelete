/**
 * dsh-true-delete —— 宿主端（Node 半边）
 *
 * 职责：
 *  1. 只负责“查”和“删”：给定一个 sessionId，列出它在本机的全部文件，并在确认后删除；
 *  2. 删除后把该会话从 DSH 的 workspace 注册表里摘干净（取消归档 / 解除挂载 / 取消置顶），
 *     这样侧边栏里那一行会跟着消失，而不是留下一个点不开的幽灵行；
 *  3. 通过 webServer 暴露两个本机路由给页面半边用。
 *
 * 本机文件布局（0.2.0-rc.2 实测）：
 *   <DSH_HOME>/sessions/<编码后的 cwd>/<sessionId>/session[.vN].jsonl.zstd   —— 会话日志（可能有多代）
 *   <DSH_HOME>/storages/session_projcache/sessions/<sessionId>.json[.bak.*]  —— 投影缓存（标题/统计/待办都在这里）
 *   <DSH_HOME>/storages/workspace.json                                        —— 归档集合与工作区归属（走服务改，不手改）
 *   <DSH_HOME>/attachments/**                                                 —— 内容寻址的共享资源，默认不动
 *
 * 设计取舍：
 *  - 只用公开的 cordis 服务（workspaceRegistry / sessionProjectionCache / sessions / connection），
 *    拿不到就降级（跳过那一步并如实汇报），绝不因为插件而让宿主起不来；
 *  - 一个已归档的主会话，顺带回收它名下的子代理（subagent）会话 —— 那些子会话不会出现在侧边栏，
 *    父会话一删就再也没入口了；
 *  - 所有删除路径都先经过 underHome() 校验，sessionId 走白名单正则，
 *    防止一个被污染的 id 把删除操作带到 DSH_HOME 之外。
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const PLUGIN = 'dsh-true-delete'
/** 本文件的能力版本；改动宿主半边时同步 +1，便于确认运行中的进程是哪一份代码。 */
const VERSION = '0.2.0'
const ROUTE_VERSION = '/dsh-true-delete/version'
const ROUTE_STATUS = '/dsh-true-delete/status'
const ROUTE_DELETE = '/dsh-true-delete/delete'

/** DSH 主目录：与宿主其它组件保持同一个口径。 */
const DSH_HOME = path.resolve(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'))

/** 会话 id 白名单：形如 `session-<uuid>`（主会话）或裸 `<uuid>`（子代理会话）。 */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/

/** 子代理嵌套的最大深度，防脏数据把递归撑爆。 */
const MAX_DEPTH = 4

/** 请求体上限，避免异常请求把内存吃满。 */
const MAX_BODY_BYTES = 64 * 1024

//#region 小工具

const statOrUndefined = async (target) => {
  try {
    return await fsp.stat(target)
  } catch {
    return undefined
  }
}

const listDir = async (target) => {
  try {
    return await fsp.readdir(target, { withFileTypes: true })
  } catch {
    return []
  }
}

/** 目标必须落在 DSH_HOME 之内（含自身）。 */
function underHome(target) {
  const resolved = path.resolve(target)
  return resolved === DSH_HOME || resolved.startsWith(DSH_HOME + path.sep)
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}

const ok = (res, value) => sendJson(res, 200, { ok: true, value })
const fail = (res, status, code, message) => sendJson(res, status, { ok: false, error: { code, message } })

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

//#endregion

//#region 定位「一个会话在本机的文件」

/**
 * 会话日志目录：`<DSH_HOME>/sessions/<编码后的 cwd>/<sessionId>/`。
 * bucket 名按 cwd 编码，所以这里扫一层 bucket 再按 id 精确匹配，
 * 不做模糊匹配 —— 宁可不删，也不删错。
 */
async function sessionLogDirs(sessionId) {
  const root = path.join(DSH_HOME, 'sessions')
  const found = []
  for (const bucket of await listDir(root)) {
    if (!bucket.isDirectory()) continue
    const candidate = path.join(root, bucket.name, sessionId)
    if (!underHome(candidate)) continue
    const stat = await statOrUndefined(candidate)
    if (stat?.isDirectory()) found.push(candidate)
  }
  return found
}

/** 投影缓存：`.../session_projcache/sessions/<id>.json` 以及坏记录留下的 `.bak.*`。 */
async function projectionCacheFiles(sessionId) {
  const dir = path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions')
  const prefix = `${sessionId}.json`
  const found = []
  for (const entry of await listDir(dir)) {
    if (!entry.isFile()) continue
    if (entry.name !== prefix && !entry.name.startsWith(`${prefix}.bak.`)) continue
    const candidate = path.join(dir, entry.name)
    if (underHome(candidate)) found.push(candidate)
  }
  return found
}

/** 展开一个待删目标，给出对话框要展示的清单与体积。 */
async function inventory(target) {
  const stat = await statOrUndefined(target)
  if (stat === undefined) return undefined
  if (stat.isFile()) {
    return { path: target, kind: 'file', bytes: stat.size, files: [{ path: target, bytes: stat.size }] }
  }
  const files = []
  const walk = async (dir) => {
    for (const entry of await listDir(dir)) {
      const child = path.join(dir, entry.name)
      if (!underHome(child)) continue
      if (entry.isDirectory()) await walk(child)
      else {
        const childStat = await statOrUndefined(child)
        if (childStat?.isFile()) files.push({ path: child, bytes: childStat.size })
      }
    }
  }
  await walk(target)
  return {
    path: target,
    kind: 'dir',
    bytes: files.reduce((total, file) => total + file.bytes, 0),
    files,
  }
}

/**
 * 子代理会话：父会话的投影缓存里有一份 subagentCatalog，
 * 里面记着每个子会话的 childId；子会话自己也可能有子会话，于是递归收集。
 * 必须在删除之前读 —— 读的就是马上要删掉的那份缓存。
 */
async function subagentChildren(sessionId) {
  const file = path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
  if (!underHome(file)) return []
  try {
    const doc = JSON.parse(await fsp.readFile(file, 'utf8'))
    const values = doc?.record?.rows?.subagentCatalog?.val?.head?.values
    if (!Array.isArray(values)) return []
    return values.map((value) => value?.childId).filter((id) => typeof id === 'string' && SESSION_ID.test(id))
  } catch {
    return []
  }
}

/** 主会话 + 其名下所有子代理会话的 id（去重、限深）。 */
async function collectSessionIds(sessionId, depth = 0, seen = new Set()) {
  if (seen.has(sessionId) || depth > MAX_DEPTH) return []
  seen.add(sessionId)
  const ids = [sessionId]
  for (const child of await subagentChildren(sessionId)) {
    ids.push(...(await collectSessionIds(child, depth + 1, seen)))
  }
  return ids
}

/** 一组会话 id 在本机的全部待删条目（含清单与体积）。 */
async function itemsForIds(ids) {
  const items = []
  const labeled = async (target, meta) => {
    const item = await inventory(target)
    if (item !== undefined) items.push({ ...item, ...meta })
  }
  for (const [index, id] of ids.entries()) {
    const role = index === 0 ? 'session' : 'child'
    for (const dir of await sessionLogDirs(id)) await labeled(dir, { role, sessionId: id })
    for (const file of await projectionCacheFiles(id)) await labeled(file, { role: 'cache', sessionId: id })
  }
  return items
}

/**
 * 一个会话（含子会话）的全部本地文件。
 * @returns `{ ids, items, children }`；每项带 `role`（session / child / cache）与 `sessionId`，供对话框如实展示。
 */
async function planFor(sessionId) {
  const ids = await collectSessionIds(sessionId)
  return { ids, children: ids.slice(1), items: await itemsForIds(ids) }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 删除后再扫一遍：归档过的会话在内存里往往还挂着一个闲置对象，
 * 它的收尾写入有可能把日志目录重新建出来。这里等一小会儿再确认一次，
 * 冒头就再删一遍 —— 免得侧边栏里过一阵子又长出一行「幽灵会话」。
 */
async function sweep(ids) {
  await sleep(250)
  const reappeared = await itemsForIds(ids)
  const removed = []
  for (const item of reappeared) {
    try {
      await fsp.rm(item.path, { recursive: item.kind === 'dir', force: true })
      removed.push(item.path)
    } catch {
      /* 记不下来就算了：主删除已经完成，这里只是补刀 */
    }
  }
  return removed
}

//#endregion

//#region 宿主状态查询与收尾

/** 该会话是否已归档（读 workspace 注册表的归档集合）。 */
function isArchived(ctx, sessionId) {
  try {
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined) return undefined
    return registry.archivedSessionIds.includes(sessionId)
  } catch {
    return undefined
  }
}

/** 该会话是否还有内存里的活对象（只作提示：归档后常常还挂着一个闲置对象）。 */
function isLive(ctx, sessionId) {
  try {
    return ctx.get('sessions')?.get(sessionId) !== undefined
  } catch {
    return false
  }
}

/**
 * 该会话是否还有正在跑的工作 —— 用 DSH 自己那把尺子：
 * workspaceRegistry 在归档前问的也是这条 `workspace/session-activity` waterfall。
 * 它为空 = 没人在跑这个会话，删文件不会和写日志的句柄打架。
 */
async function sessionActivity(ctx, sessionId) {
  if (typeof ctx.waterfall !== 'function') return []
  try {
    const entries = await ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
    return Array.isArray(entries) ? entries : []
  } catch {
    return []
  }
}

/** 把活动项压成一句给人看的话。 */
function describeActivity(entries) {
  const kinds = entries.map((entry) => String(entry?.kind ?? entry?.type ?? 'unknown'))
  return [...new Set(kinds)].join(', ')
}

/**
 * 删除后把注册表里的引用清掉：取消归档、取消置顶、从每个工作区的成员列表里摘掉。
 * 全部走 workspaceRegistry 的公开方法，因此和界面上的「取消归档」是同一条写链，
 * 状态会照常推给页面。
 *
 * 注意：注册表暴露的是 `list()`（返回实体数组），**没有** `workspaces` 这个访问器 ——
 * 早先按后者遍历会静默地什么都不做（实测：归档位清了，工作区成员却留着）。
 * 对一个本来就没挂这个会话的工作区调用 detachSession 是幂等空操作，所以直接全量遍历。
 */
async function detachFromRegistry(ctx, sessionId) {
  const result = { unarchived: false, unpinned: false, detachedFrom: [] }
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return { ...result, skipped: 'workspaceRegistry 服务不可用' }

  try {
    await registry.unarchiveSession(sessionId)
    result.unarchived = true
  } catch (error) {
    result.unarchiveError = String(error?.message ?? error)
  }
  try {
    if (registry.pinnedSessionIds?.includes(sessionId) === true) {
      await registry.unpinSession(sessionId)
      result.unpinned = true
    }
  } catch (error) {
    result.unpinError = String(error?.message ?? error)
  }
  let entities = []
  try {
    entities = typeof registry.list === 'function' ? registry.list() : (registry.workspaces ?? [])
  } catch (error) {
    result.listError = String(error?.message ?? error)
    entities = []
  }
  for (const entity of entities) {
    try {
      await entity.detachSession(sessionId)
      result.detachedFrom.push(entity.path)
    } catch (error) {
      result.detachError = String(error?.message ?? error)
    }
  }
  return result
}

/**
 * 把还挂在内存里的会话对象摘掉。
 *
 * 为什么必须做：宿主列会话是「存储里的 + 内存里活的」取并集
 * （dsh-session-query 的 listSessions 会把 `ctx.sessions.list()` 全部并进去），
 * 所以文件删干净了、只要内存里还留着这个闲置对象，侧边栏那一行就永远不走 ——
 * 这正是「提示已删除、行却还在」的原因。
 *
 * `enter()` 的所有者才持有 detach 能力，这里用公开的 liveEntryFor + detachEntered
 * 走同一条销毁路径（会发 session/disposed，和正常关闭会话一致）。
 */
function releaseLiveSession(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (sessions === undefined || typeof sessions.liveEntryFor !== 'function') return false
  try {
    const live = sessions.get(sessionId)
    if (live === undefined) return false
    sessions.detachEntered(sessions.liveEntryFor(live))
    return true
  } catch {
    return false
  }
}

/** 投影缓存服务里主会话那条记录（走服务而不是手改 json，避免和写链抢）。 */
async function dropProjectionCacheRecord(ctx, sessionId) {
  const table = ctx.get('sessionProjectionCache')?.table
  if (table === undefined || typeof table.delete !== 'function') return false
  try {
    await table.delete(sessionId)
    return true
  } catch {
    return false
  }
}

//#endregion

//#region 信任栅栏

/**
 * 宿主自带的 requestRejection 优先，插件自己再兜一层：
 * 缺 Host / 畸形 → 拒；`Sec-Fetch-Site: cross-site` → 拒；Origin 与 Host 不同源 → 拒；
 * 非 GET 的写操作必须是回环来源。任何异常都按拒绝处理（fail-closed）。
 */
function makeFence(ctx) {
  const loopback = (hostname) => {
    const host = String(hostname ?? '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
    if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true
    const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
    return parts !== null && Number(parts[1]) === 127 && [parts[2], parts[3], parts[4]].every((x) => Number(x) <= 255)
  }
  return (req) => {
    try {
      const headers = req.headers ?? {}
      let hostUrl
      try {
        hostUrl = new URL('http://' + String(headers.host ?? ''))
      } catch {
        return 403
      }
      if (String(headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return 403
      const origin = headers.origin
      if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
        let originUrl
        try {
          originUrl = new URL(origin)
        } catch {
          return 403
        }
        if (originUrl.host.toLowerCase() !== hostUrl.host.toLowerCase()) return 403
      }
      const connection = ctx.get('connection')
      if (connection !== undefined && typeof connection.requestRejection === 'function') {
        try {
          const rejection = connection.requestRejection(req)
          if (rejection !== undefined && rejection !== null && rejection !== false) {
            return typeof rejection === 'number' ? rejection : 403
          }
        } catch {
          return 403
        }
      }
      if (String(req.method ?? 'GET').toUpperCase() !== 'GET' && !loopback(hostUrl.hostname)) return 403
      return null
    } catch {
      return 403
    }
  }
}

//#endregion

/** 宿主端插件入口：不依赖任何服务就能先挂上路由。 */
export default {
  name: PLUGIN,
  apply(root) {
    root.inject(['webServer'], (ctx) => {
      const fence = makeFence(ctx)

      const guard = (handler) => async (req, res) => {
        const rejection = fence(req)
        if (rejection !== null) {
          sendJson(res, rejection, { ok: false, error: { code: 'forbidden', message: '请求被信任栅栏拒绝' } })
          return
        }
        try {
          await handler(req, res)
        } catch (error) {
          fail(res, 500, 'internal', String(error?.message ?? error))
        }
      }

      // GET /dsh-true-delete/version
      // 只读自检：用来确认「运行中的宿主进程」到底加载了哪一份代码
      // （未鉴权时栅栏会先返回 401，路由不存在则是 404 —— 靠这个就能判断有没有热重载）。
      ctx.effect(
        () =>
          ctx.webServer.register({
            kind: 'exact',
            path: ROUTE_VERSION,
            handler: guard(async (req, res) => {
              ok(res, {
                plugin: PLUGIN,
                version: VERSION,
                home: DSH_HOME,
                capabilities: ['status', 'delete', 'registry-detach', 'live-release', 'sweep', 'activity-guard'],
              })
            }),
          }),
        'dsh-true-delete: version route',
      )

      // GET /dsh-true-delete/status?sessionId=...
      // 只查不改：把「这次会删哪些文件」原样交给对话框。
      ctx.effect(
        () =>
          ctx.webServer.register({
            kind: 'exact',
            path: ROUTE_STATUS,
            handler: guard(async (req, res) => {
              const url = new URL(req.url ?? '/', 'http://localhost')
              const sessionId = url.searchParams.get('sessionId') ?? ''
              if (!SESSION_ID.test(sessionId)) {
                fail(res, 400, 'bad-session-id', '非法的会话 id')
                return
              }
              const plan = await planFor(sessionId)
              ok(res, {
                sessionId,
                archived: isArchived(ctx, sessionId),
                live: isLive(ctx, sessionId),
                activity: (await sessionActivity(ctx, sessionId)).map((entry) => String(entry?.kind ?? entry?.type ?? 'unknown')),
                items: plan.items,
                children: plan.children,
                totalBytes: plan.items.reduce((total, item) => total + item.bytes, 0),
                home: DSH_HOME,
              })
            }),
          }),
        'dsh-true-delete: status route',
      )

      // POST /dsh-true-delete/delete  { sessionId }
      ctx.effect(
        () =>
          ctx.webServer.register({
            kind: 'exact',
            path: ROUTE_DELETE,
            handler: guard(async (req, res) => {
              if (String(req.method ?? '').toUpperCase() !== 'POST') {
                fail(res, 405, 'method-not-allowed', '请用 POST')
                return
              }
              let payload
              try {
                payload = JSON.parse((await readBody(req)) || '{}')
              } catch {
                fail(res, 400, 'bad-json', '请求体不是合法 JSON')
                return
              }
              const sessionId = String(payload?.sessionId ?? '')
              if (!SESSION_ID.test(sessionId)) {
                fail(res, 400, 'bad-session-id', '非法的会话 id')
                return
              }
              // 这个按钮本来就是给已归档内容用的：未归档的一律拒绝，顺带挡住伪造请求。
              if (isArchived(ctx, sessionId) === false && payload?.force !== true) {
                fail(res, 409, 'not-archived', '该会话未归档，已拒绝删除')
                return
              }
              // 有正在跑的工作就别删：文件被删掉后写句柄还在往已删除的 inode 里追加，
              // 那是静默丢数据。没在跑（哪怕内存里还挂着一个闲置对象）就可以删。
              const activity = await sessionActivity(ctx, sessionId)
              if (activity.length > 0 && payload?.force !== true) {
                fail(res, 409, 'session-active', `该会话还有正在运行的工作（${describeActivity(activity)}），请先停止它再删除`)
                return
              }

              const plan = await planFor(sessionId)
              const removed = []
              const failedRemovals = []
              for (const item of plan.items) {
                try {
                  await fsp.rm(item.path, { recursive: item.kind === 'dir', force: true })
                  removed.push(item.path)
                } catch (error) {
                  failedRemovals.push({ path: item.path, message: String(error?.message ?? error) })
                }
              }
              const registry = await detachFromRegistry(ctx, sessionId)
              const cacheDropped = await dropProjectionCacheRecord(ctx, sessionId)

              // 先把内存里挂着的会话对象摘掉（listSessions 会把活会话并进列表），
              // 再补刀 —— 摘对象可能触发一次收尾 flush，把日志目录重新写出来。
              const released = []
              for (const id of plan.ids) {
                if (releaseLiveSession(ctx, id)) released.push(id)
              }
              const swept = await sweep(plan.ids)

              ok(res, {
                sessionId,
                removed,
                failedRemovals,
                swept,
                released,
                bytes: plan.items.reduce((total, item) => total + item.bytes, 0),
                children: plan.children,
                registry,
                cacheDropped,
              })
            }),
          }),
        'dsh-true-delete: delete route',
      )
    })
  },
}
