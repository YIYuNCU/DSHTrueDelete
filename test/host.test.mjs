/**
 * 宿主半边验收：把 lib/index.js 塞进假的 cordis ctx + 假的 DSH_HOME 里跑一遍，
 * 确认「查文件 → 列清单 → 守卫 → 删除 → 注册表收尾 → 活会话释放 → 补刀」这条链子是对的。
 *
 * 全程只碰临时目录，不动真实的 ~/.dsh。
 *   node test/host.test.mjs        （KEEP=1 时保留临时目录便于排查）
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const ROOT = path.join(os.tmpdir(), 'dsh-true-delete-host-test')
const HOME = path.join(ROOT, 'fake-home')
const ROOT_ID = 'session-test-0001-0002-0003-000000000001'
const CHILD_ID = 'aaaaaaaa-1111-2222-3333-444444444444'
const CHILD2_ID = 'bbbbbbbb-1111-2222-3333-444444444444'
const OTHER_ID = 'session-other-9999-0000-0000-000000000000'
const ROUTE = '/dsh-true-delete'

/** 造一棵假的家目录：一个主会话 + 一层子会话 + 一层孙会话 + 别人的会话 + 共享附件。 */
async function seed() {
  await fsp.rm(ROOT, { recursive: true, force: true })
  const bucket = path.join(HOME, 'sessions', '--G-Code-Fake--')
  const write = async (file, body) => {
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(file, body)
  }
  const json = (value) => JSON.stringify(value)

  await write(path.join(bucket, ROOT_ID, 'session.v4.jsonl.zstd'), Buffer.alloc(4096, 1))
  await write(path.join(bucket, ROOT_ID, 'session.v3.jsonl.zstd'), Buffer.alloc(1024, 2))
  await write(path.join(bucket, ROOT_ID, 'session.v4.jsonl.zstd.deadbeef1234.tmp'), Buffer.alloc(10, 3))
  await write(path.join(bucket, CHILD_ID, 'session.v4.jsonl.zstd'), Buffer.alloc(2048, 4))
  await write(path.join(bucket, CHILD2_ID, 'session.v4.jsonl.zstd'), Buffer.alloc(512, 5))
  await write(
    path.join(HOME, 'storages', 'session_projcache', 'sessions', `${ROOT_ID}.json`),
    json({
      version: 7,
      record: { rows: { title: { val: '假会话' }, subagentCatalog: { val: { head: { values: [{ childId: CHILD_ID }, { childId: 'bad id!' }] } } } } },
    }),
  )
  await write(
    path.join(HOME, 'storages', 'session_projcache', 'sessions', `${CHILD_ID}.json`),
    json({ version: 7, record: { rows: { subagentCatalog: { val: { head: { values: [{ childId: CHILD2_ID }] } } } } } }),
  )
  await write(path.join(HOME, 'storages', 'session_projcache', 'sessions', `${CHILD_ID}.json.bak.20260101`), '{}')
  await write(path.join(HOME, 'storages', 'session_projcache', 'sessions', `${CHILD2_ID}.json`), json({ version: 7, record: { rows: {} } }))
  await write(path.join(HOME, 'storages', 'session_projcache.json'), json({ unit: { name: 'session_projcache', version: 3 } }))
  await write(
    path.join(HOME, 'storages', 'workspace.json'),
    json({
      unit: { name: 'workspace', version: 2 },
      global: { archivedSessionIds: [ROOT_ID], pinnedSessionIds: [ROOT_ID] },
      tables: { workspaces: { w1: { path: 'G:\\Code\\Fake', sessionIds: [ROOT_ID, 'other'] } } },
    }),
  )
  // 别人的东西，必须原样保留
  await write(path.join(bucket, OTHER_ID, 'session.v4.jsonl.zstd'), Buffer.alloc(777, 6))
  await write(path.join(HOME, 'attachments', 'v1', 'objects', 'aa', 'deadbeef'), Buffer.alloc(99, 7))
  return bucket
}

/** 假的 cordis ctx：只实现插件真正用到的那几个服务。 */
function makeCtx() {
  const routes = new Map()
  const calls = { unarchive: [], unpin: [], detach: [], cacheDelete: [], detachedLive: [] }

  const entity = {
    path: 'G:\\Code\\Fake',
    sessionIds: [ROOT_ID, 'other'],
    detachSession: async (id) => {
      calls.detach.push(id)
      entity.sessionIds = entity.sessionIds.filter((x) => x !== id)
    },
  }
  const registry = {
    archivedSessionIds: [ROOT_ID],
    pinnedSessionIds: [ROOT_ID],
    // 真实注册表暴露的是 list()，没有 workspaces 访问器
    list: () => [entity],
    unarchiveSession: async (id) => {
      calls.unarchive.push(id)
      registry.archivedSessionIds = registry.archivedSessionIds.filter((x) => x !== id)
    },
    unpinSession: async (id) => {
      calls.unpin.push(id)
      registry.pinnedSessionIds = registry.pinnedSessionIds.filter((x) => x !== id)
    },
  }

  // 模拟宿主会话 store：ROOT_ID 在内存里还挂着一个闲置对象
  const liveStore = new Map([[ROOT_ID, { id: ROOT_ID, session: { id: ROOT_ID } }]])
  const sessions = {
    get: (id) => liveStore.get(id)?.session,
    liveEntryFor: (session) => {
      const entry = liveStore.get(session.id)
      if (entry === undefined) throw new Error('not live')
      return entry
    },
    detachEntered: (entry) => {
      calls.detachedLive.push(entry.id)
      liveStore.delete(entry.id)
    },
  }

  const sessionProjectionCache = {
    table: {
      delete: async (id) => {
        calls.cacheDelete.push(id)
        // 模拟投影缓存的 write-behind：删完之后文件又被写回来
        if (id === ROOT_ID) {
          const file = path.join(HOME, 'storages', 'session_projcache', 'sessions', `${id}.json`)
          await fsp.mkdir(path.dirname(file), { recursive: true })
          await fsp.writeFile(file, '{"version":7,"record":{"rows":{}}}')
          calls.recreated = (calls.recreated ?? 0) + 1
        }
      },
    },
  }

  const services = {
    webServer: { register: (route) => routes.set(route.path, route) },
    workspaceRegistry: registry,
    sessions,
    sessionProjectionCache,
  }
  const ctx = {
    ...services,
    get: (name) => services[name],
    waterfall: async (_name, _args, fallback) => fallback(),
    // 模拟 cordis 的 ctx.effect(fn) → 立刻执行，返回的 disposer 由 fiber 持有
    effect: (fn) => {
      const disposer = fn()
      return () => disposer?.()
    },
  }
  return { ctx, routes, calls, registry, entity }
}

const makeRes = () => ({
  statusCode: 0,
  body: '',
  setHeader() {},
  end(text) {
    this.body = text
  },
})

/** 假请求：body 通过微任务喂进去（handler 里是流式读的）。 */
function makeReq(method, url, body) {
  const listeners = {}
  const req = {
    method,
    url,
    headers: { host: '127.0.0.1:19387', 'sec-fetch-site': 'same-origin' },
    on(event, fn) {
      listeners[event] = fn
      return req
    },
    destroy() {},
  }
  queueMicrotask(() => {
    if (body !== undefined) listeners.data?.(Buffer.from(body))
    listeners.end?.()
  })
  return req
}

const json = (res) => JSON.parse(res.body)
const call = (routes, routePath, req) => {
  const res = makeRes()
  return routes.get(routePath).handler(req, res).then(() => res)
}

async function main() {
  const bucket = await seed()
  process.env.DSH_HOME = HOME

  const mod = await import(new URL('../lib/index.js', import.meta.url).href)
  const { ctx, routes, calls, registry, entity } = makeCtx()
  // 模拟 root.inject(['webServer'], cb)
  mod.default.apply({ inject: (_deps, cb) => cb(ctx) })

  assert.ok(routes.has(`${ROUTE}/version`), 'version 路由已注册')
  assert.ok(routes.has(`${ROUTE}/status`), 'status 路由已注册')
  assert.ok(routes.has(`${ROUTE}/delete`), 'delete 路由已注册')

  // --- 1. 信任栅栏 ---
  {
    const res = await call(routes, `${ROUTE}/status`, {
      method: 'GET',
      url: `${ROUTE}/status?sessionId=${ROOT_ID}`,
      headers: { host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site' },
      on() {},
    })
    assert.equal(res.statusCode, 403, 'cross-site 被拒')

    const res2 = await call(routes, `${ROUTE}/delete`, {
      method: 'POST',
      url: `${ROUTE}/delete`,
      headers: { host: 'evil.example.com', origin: 'http://evil.example.com' },
      on() {},
    })
    assert.equal(res2.statusCode, 403, '非回环 Host 的写请求被拒')

    const res3 = await call(routes, `${ROUTE}/status`, makeReq('GET', `${ROUTE}/status?sessionId=..%2F..%2Fetc`))
    assert.equal(res3.statusCode, 400, '非法 id 被拒')
  }

  // --- 2. 清单 ---
  let plan
  {
    const res = await call(routes, `${ROUTE}/status`, makeReq('GET', `${ROUTE}/status?sessionId=${ROOT_ID}`))
    assert.equal(res.statusCode, 200)
    plan = json(res).value
    assert.equal(plan.archived, true)
    assert.equal(plan.live, true, '内存里挂着的闲置对象只作提示，不再是拒绝理由')
    assert.deepEqual(plan.children, [CHILD_ID, CHILD2_ID], '一层 + 二层子会话都被收集，非法 id 被丢')
    assert.deepEqual(plan.activity, [], '没有正在运行的工作')

    const paths = plan.items.map((item) => item.path)
    assert.ok(paths.includes(path.join(bucket, ROOT_ID)), '主会话目录在清单里')
    assert.ok(paths.includes(path.join(bucket, CHILD_ID)), '子会话目录在清单里')
    assert.ok(paths.includes(path.join(HOME, 'storages', 'session_projcache', 'sessions', `${ROOT_ID}.json`)), '投影缓存在清单里')
    assert.ok(
      paths.includes(path.join(HOME, 'storages', 'session_projcache', 'sessions', `${CHILD_ID}.json.bak.20260101`)),
      '坏记录备份也在清单里',
    )
    assert.ok(!paths.includes(path.join(bucket, OTHER_ID)), '不含别人的会话')
    assert.ok(!paths.some((p) => p.includes('attachments')), '不含共享附件')

    const cacheBytes = plan.items.filter((item) => item.role === 'cache').reduce((total, item) => total + item.bytes, 0)
    assert.equal(plan.totalBytes, 4096 + 1024 + 10 + 2048 + 512 + cacheBytes)
    console.log('清单：\n      ' + plan.items.map((item) => `${item.role} ${item.path} (${item.bytes}B)`).join('\n      '))
  }

  // --- 3. 未归档时拒绝 ---
  {
    const res = await call(routes, `${ROUTE}/delete`, makeReq('POST', `${ROUTE}/delete`, JSON.stringify({ sessionId: OTHER_ID })))
    assert.equal(res.statusCode, 409, '未归档的会话拒绝删除')
  }

  // --- 4. 有活动时拒绝 ---
  {
    ctx.waterfall = async () => [{ kind: 'turn' }]
    const res = await call(routes, `${ROUTE}/delete`, makeReq('POST', `${ROUTE}/delete`, JSON.stringify({ sessionId: ROOT_ID })))
    assert.equal(res.statusCode, 409, '有正在运行的工作时拒绝删除')
    assert.match(json(res).error.message, /turn/, '错误里写明活动类型')
    ctx.waterfall = async (_name, _args, fallback) => fallback()
  }

  // --- 5. 真删 ---
  {
    const res = await call(routes, `${ROUTE}/delete`, makeReq('POST', `${ROUTE}/delete`, JSON.stringify({ sessionId: ROOT_ID })))
    assert.equal(res.statusCode, 200)
    const result = json(res).value
    assert.equal(result.failedRemovals.length, 0, '没有删除失败项')
    assert.equal(calls.recreated, 1, '模拟的 write-behind 确实把缓存写回来了')
    assert.equal(result.swept.length, 1, '补刀扫到了被写回来的缓存')
    assert.ok(result.swept[0].endsWith(`${ROOT_ID}.json`), '补刀删的就是那个文件')
    assert.deepEqual(calls.unarchive, [ROOT_ID])
    assert.deepEqual(calls.unpin, [ROOT_ID])
    assert.deepEqual(calls.detach, [ROOT_ID], '工作区成员被摘掉')
    assert.deepEqual(calls.cacheDelete, [ROOT_ID])
    assert.deepEqual(calls.detachedLive, [ROOT_ID], '内存里挂着的会话对象被摘掉')
    assert.deepEqual(result.released, [ROOT_ID])
    assert.deepEqual(result.registry.detachedFrom, ['G:\\Code\\Fake'], 'detachFrom 记录了工作区路径')
  }

  // --- 6. 盘上结果 ---
  const gone = async (target) => {
    try {
      await fsp.stat(target)
      return false
    } catch {
      return true
    }
  }
  assert.ok(await gone(path.join(bucket, ROOT_ID)), '主会话目录已删')
  assert.ok(await gone(path.join(bucket, CHILD_ID)), '子会话目录已删')
  assert.ok(await gone(path.join(bucket, CHILD2_ID)), '孙会话目录已删')
  assert.ok(await gone(path.join(HOME, 'storages', 'session_projcache', 'sessions', `${ROOT_ID}.json`)), '投影缓存已删')
  assert.ok(await gone(path.join(HOME, 'storages', 'session_projcache', 'sessions', `${CHILD_ID}.json.bak.20260101`)), '坏记录备份已删')
  assert.ok(!(await gone(path.join(bucket, OTHER_ID))), '别人的会话还在')
  assert.ok(!(await gone(path.join(HOME, 'storages', 'session_projcache.json'))), 'legacy 投影缓存文件还在')
  assert.ok(!(await gone(path.join(HOME, 'attachments', 'v1', 'objects', 'aa', 'deadbeef'))), 'attachments 还在')
  assert.deepEqual(registry.archivedSessionIds, [], '归档集合已清')
  assert.deepEqual(registry.pinnedSessionIds, [], '置顶集合已清')
  assert.deepEqual(entity.sessionIds, ['other'], '工作区成员已摘')

  // --- 7. 幂等：再查一次应该是空清单 ---
  {
    const res = await call(routes, `${ROUTE}/status`, makeReq('GET', `${ROUTE}/status?sessionId=${ROOT_ID}`))
    const again = json(res).value
    assert.equal(again.items.length, 0, '再查一次没有残留')
    assert.equal(again.archived, false, '已不在归档集合里')
    assert.equal(again.live, false, '内存里的对象也摘干净了')
  }

  // --- 8. version 自检 ---
  {
    const res = await call(routes, `${ROUTE}/version`, makeReq('GET', `${ROUTE}/version`))
    const value = json(res).value
    assert.equal(value.plugin, 'dsh-true-delete')
    assert.ok(value.capabilities.includes('live-release'), '能力清单里有 live-release')
  }

  if (process.env.KEEP !== '1') await fsp.rm(ROOT, { recursive: true, force: true })
  console.log('\n✅ 宿主半边全部断言通过')
}

main().catch((error) => {
  console.error('❌ 宿主半边失败：', error)
  process.exitCode = 1
})
