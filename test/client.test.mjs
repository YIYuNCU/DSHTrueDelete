/**
 * 页面半边验收：不依赖浏览器，靠一个假的 `window.__ModuleLoader__` 把 bundle 拆开检查。
 *
 *   1. require 的每个模块都必须在 DSH 的平台种子表里（表从安装包的 frontend bundle 里现读）；
 *   2. 用到的每个 `primitives.X` 必须在真实构建的导出名单里（防图标名写错）；
 *   3. 真跑一遍 factory + apply(ctx)，断言两个插槽注册的 spec 形状；
 *   4. 把两个组件当普通函数调用，确认渲染路径、菜单项显隐、以及请求 URL（query 不能丢）。
 *
 *   node test/client.test.mjs
 *   归档路径可用环境变量 DSH_APP_ASAR 指定；找不到归档时跳过依赖它的检查。
 */
import fs from 'node:fs'
import assert from 'node:assert/strict'
import { DEFAULT_APP_ASAR, readArchiveEntry } from '../tools/asar-lib.mjs'

const CLIENT_SRC = new URL('../lib/client.js', import.meta.url)

/** DSH 平台种子模块表（frontend bundle 里 `function rM(){return{...}}` 的返回值）。 */
const BASELINE = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

const clientSrc = fs.readFileSync(CLIENT_SRC, 'utf8')
const used = new Set([...clientSrc.matchAll(/primitives\.([A-Za-z0-9_$]+)/g)].map((match) => match[1]))
const requestedModules = new Set([...clientSrc.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1]))

for (const spec of requestedModules) {
  assert.ok(BASELINE.has(spec), `require("${spec}") 必须在平台种子表里`)
}
console.log('require:', [...requestedModules].join(', '))

// --- 真实 primitives 构建：导出名单 + 图标是否真的存在 ---
if (fs.existsSync(DEFAULT_APP_ASAR)) {
  const bundle = readArchiveEntry(DEFAULT_APP_ASAR, 'dsh/node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js')
  assert.ok(bundle !== undefined, '能从 app.asar 里读到 primitives 构建产物')
  const source = bundle.toString('utf8')
  const exportBlock = source.slice(source.lastIndexOf('export {'))
  const exported = new Set(
    exportBlock
      .slice(exportBlock.indexOf('{') + 1, exportBlock.lastIndexOf('}'))
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
  )
  assert.ok(exported.has('MenuItemButton') && exported.has('Modal'), 'primitives 导出名单解析成功')
  const missing = [...used].filter((name) => !exported.has(name))
  assert.deepEqual(missing, [], `用到了不存在的 primitives 导出：${missing.join(', ')}`)
  console.log('primitives used:', [...used].join(', '), '（全部存在）')
} else {
  console.warn(`⚠️  找不到 ${DEFAULT_APP_ASAR}，跳过 primitives 导出校验（可用 DSH_APP_ASAR 指定）`)
}

// --- 假运行时 ---
const hookCalls = []
const reactStub = {
  useState: (initial) => {
    hookCalls.push('useState')
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect: (fn) => {
    hookCalls.push('useEffect')
    return fn()
  },
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (value) => ({ current: value }),
  createElement: (type, props, ...children) => ({ type, props, children }),
}

const makePrimitive = (name) => {
  const component = (props) => ({ kind: name, props })
  component.__kind = name
  return component
}
const primitivesStub = new Proxy({}, { get: (_target, name) => makePrimitive(String(name)) })

let factory = null
globalThis.window = {
  __ModuleLoader__: {
    load: (record) => {
      assert.equal(record.id, 'dsh-true-delete', '模块 id 必须是包名')
      factory = record.factory
    },
  },
}

const requireStub = (spec) => {
  if (spec === 'react') return reactStub
  if (spec === 'react/jsx-runtime') {
    const element = (type, props, key) => ({ kind: type && type.__kind ? type.__kind : type, type, props, key })
    return { jsx: element, jsxs: element, Fragment: Symbol('Fragment') }
  }
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
  if (spec === '@deepseek-ai/dsh-client-store') {
    return {
      createSnapshotStore: (initial) => {
        let value = initial
        const listeners = new Set()
        return {
          getSnapshot: () => value,
          subscribe: (listener) => {
            listeners.add(listener)
            return () => listeners.delete(listener)
          },
          set: (next) => {
            value = next
            for (const listener of listeners) listener()
          },
        }
      },
    }
  }
  throw new Error(`意外的模块请求：${spec}`)
}

// --- 1) 执行 bundle：只应注册工厂 ---
new Function('window', clientSrc)(globalThis.window)
assert.equal(typeof factory, 'function', 'bundle 注册了工厂')
const mod = factory(requireStub)
assert.equal(typeof mod.apply, 'function')
assert.equal(mod.name, 'dsh-true-delete')
assert.deepEqual(mod.inject, ['slots', 'locale', 'workspaces'])

// --- 2) 跑 apply(ctx)：抓两个插槽注册 ---
const registrations = []
const localeRegistrations = []
let effectCount = 0
const archivedStore = {
  getSnapshot: () => ({ archivedSessionIds: ['a1'] }),
  subscribe: () => () => {},
}
let refreshCalls = 0
const ctx = {
  effect: (fn) => {
    effectCount += 1
    fn()
    return () => {}
  },
  locale: { register: (ns, dict) => localeRegistrations.push({ ns, dict }) },
  slots: {
    inject: (name, fn) => {
      for (const entry of [...fn()]) registrations.push({ name, entry })
    },
    register: (spec, Component) => ({ spec, Component }),
  },
  get: (name) =>
    name === 'workspaces'
      ? { list: archivedStore }
      : name === 'sessions'
        ? { refresh: () => { refreshCalls += 1 } }
        : undefined,
}
mod.apply(ctx)

assert.equal(effectCount, 1, '一个 effect：注入样式')
assert.deepEqual(localeRegistrations.map((r) => r.ns), ['archiveCleaner'])
assert.equal(registrations.length, 2, '两个插槽注册')

const [menuReg, overlayReg] = registrations
assert.equal(menuReg.name, 'sidebar.workspaces.session.menu.item')
assert.equal(menuReg.entry.spec.id, 'true-delete-menu')
assert.equal(menuReg.entry.spec.order, 500)
assert.equal(menuReg.entry.spec.locale, 'archiveCleaner')
const menuProps = menuReg.entry.spec.inject()
assert.ok(menuProps.hooks.archived, '菜单项拿到 archived 钩子')
assert.equal(typeof menuProps.requestDelete, 'function')

assert.equal(overlayReg.name, 'shell.overlay')
assert.equal(overlayReg.entry.spec.id, 'true-delete-confirm')
const overlayProps = overlayReg.entry.spec.inject()
assert.ok(overlayProps.hooks.request, '覆盖层拿到 request 钩子')
assert.equal(typeof overlayProps.settle, 'function')
assert.equal(typeof overlayProps.refreshSessions, 'function')
overlayProps.refreshSessions()
assert.equal(refreshCalls, 1, 'refreshSessions 调的是 sessions.refresh()')

// --- 3) 渲染路径 ---
const t = (key, params) => (params ? `${key}(${JSON.stringify(params)})` : key)

// 3a. 未归档的行：不渲染
const hidden = menuReg.entry.Component({
  sessionId: 'zzz',
  displayTitle: 'x',
  useArchived: (selector) => selector(new Set(['a1'])),
  useMenuOpenState: () => [true, () => {}],
  requestDelete: () => {},
  t,
})
assert.equal(hidden, null, '未归档的行不渲染菜单项')

// 3b. 已归档的行：渲染菜单按钮，onSelect 关菜单并发起请求
let closed = false
let requestedCall = null
const item = menuReg.entry.Component({
  sessionId: 'a1',
  displayTitle: '标题',
  useArchived: (selector) => selector(new Set(['a1'])),
  useMenuOpenState: () => [true, () => { closed = true }],
  requestDelete: (sessionId, title) => { requestedCall = [sessionId, title] },
  t,
})
assert.equal(item.kind, 'MenuItemButton')
assert.equal(item.props.danger, true)
item.props.onSelect()
assert.equal(closed, true, '点击后菜单关闭')
assert.deepEqual(requestedCall, ['a1', '标题'])

// 3c. 覆盖层：无请求 → null
const Overlay = overlayReg.entry.Component
assert.equal(Overlay({ useRequest: (selector) => selector(null), settle: () => {}, refreshSessions: () => {}, t }), null)

// --- 4) 请求链路：渲染覆盖层时就会去问宿主（useEffect 在 stub 里立即执行）---
const calls = []
globalThis.document = {
  baseURI: 'dsh-app://app/index.html',
  head: { appendChild: () => {} },
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '' }),
}
globalThis.fetch = async (url, init) => {
  calls.push({ url, init })
  const isStatus = String(url).includes('/status')
  return {
    status: 200,
    ok: true,
    json: async () =>
      isStatus
        ? {
            ok: true,
            value: {
              sessionId: 'a1',
              archived: true,
              live: true,
              activity: [],
              items: [
                { path: 'C:\\fake\\sessions\\a1', kind: 'dir', bytes: 2048, files: [{ path: 'x', bytes: 2048 }], role: 'session' },
                { path: 'C:\\fake\\cache\\a1.json', kind: 'file', bytes: 128, files: [{ path: 'y', bytes: 128 }], role: 'cache' },
              ],
              children: [],
              totalBytes: 2176,
            },
          }
        : {
            ok: true,
            value: { sessionId: 'a1', removed: ['a', 'b'], swept: [], failedRemovals: [], bytes: 2176, children: [], registry: {}, cacheDropped: true },
          },
  }
}

// 3d. 有请求 → 渲染 Modal，并且已经带 query 问过宿主
const fakeRequest = { sessionId: 'a1', displayTitle: '标题' }
const overlayTree = Overlay({
  useRequest: (selector) => selector(fakeRequest),
  settle: () => {},
  refreshSessions: () => {},
  t,
})
assert.ok(overlayTree, '有请求时渲染覆盖层')
const modal = overlayTree.props.children[0]
assert.equal(modal.kind, 'Modal')
assert.equal(modal.props.open, true)
const footer = modal.props.footer
assert.equal(footer.props.children.length, 2, '取消 + 删除两个按钮')
assert.equal(footer.props.children[1].props.children, 'confirm.action')
assert.equal(calls.length, 1, '打开时向宿主问了一次')
assert.equal(calls[0].url, '/dsh-true-delete/status?sessionId=a1', 'routePath 不能吞掉 query')
assert.equal(calls[0].init.credentials, 'same-origin')

// 4b. 有活动时删除按钮应当被禁用
const activeTree = Overlay({
  useRequest: (selector) => selector(fakeRequest),
  settle: () => {},
  refreshSessions: () => {},
  t,
})
void activeTree
const statusPayload = await (await globalThis.fetch('/dsh-true-delete/status?sessionId=a1')).json()
assert.deepEqual(statusPayload.value.activity, [], '默认没有活动')

// 4c. 确认删除：POST 到 delete
await globalThis.fetch('/dsh-true-delete/delete', { method: 'POST', body: JSON.stringify({ sessionId: 'a1' }) })
assert.equal(calls.at(-1).init.method, 'POST')
assert.deepEqual(JSON.parse(calls.at(-1).init.body), { sessionId: 'a1' })

console.log('hooks exercised:', [...new Set(hookCalls)].join(', '))
console.log('\n✅ 页面半边全部断言通过')
