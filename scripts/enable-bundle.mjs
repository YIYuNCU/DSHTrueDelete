/**
 * 安装收尾：把本插件选进 profile 的 `dsh.profile.bundles`。
 *
 * `dsh plugin add`（本质是 pnpm add）只负责把包装进 node_modules，
 * 不会把包选进 profile 的 bundle 列表；DSH 启动时是按这个列表叠加各 bundle 的 patch 的，
 * 少了这一步，插件不会被加载。
 *
 * 顺带清理改名前的旧条目（本插件曾用名 dsh-archive-cleaner）。
 *
 * 用法：
 *   node scripts/enable-bundle.mjs [profile]      # 默认 desktop
 * 环境变量 DSH_HOME 可覆盖 DSH 主目录（默认 ~/.dsh）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const NAME = 'dsh-true-delete'
const LEGACY = ['dsh-archive-cleaner']
const profile = process.argv[2] ?? 'desktop'
const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const file = path.join(home, 'profiles', profile, 'package.json')

if (!fs.existsSync(file)) {
  console.error(`找不到 profile 清单：${file}\n先打开一次 DeepSeek Harness 桌面端，让它初始化 profile。`)
  process.exit(1)
}

const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
doc.dsh ??= {}
doc.dsh.profile ??= {}
doc.dsh.profile.bundles ??= []

const before = [...doc.dsh.profile.bundles]
doc.dsh.profile.bundles = doc.dsh.profile.bundles.filter((name) => !LEGACY.includes(name))
if (!doc.dsh.profile.bundles.includes(NAME)) doc.dsh.profile.bundles.push(NAME)

const removed = before.filter((name) => LEGACY.includes(name))
const changed = removed.length > 0 || !before.includes(NAME)

if (changed) {
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
  if (removed.length > 0) console.log(`已移除旧条目：${removed.join(', ')}`)
  console.log(`已把 ${NAME} 写进 ${file} 的 dsh.profile.bundles`)
} else {
  console.log(`${NAME} 已经在 bundles 列表里，无需改动。`)
}

console.log(`bundles: ${doc.dsh.profile.bundles.join(', ')}`)
