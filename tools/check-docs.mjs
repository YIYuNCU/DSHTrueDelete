/**
 * 文档与清单一致性检查。
 *
 * 对齐 DSH 仓库的 package-reference 约定（见安装包里的
 * `dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/`）：
 * README.md 是英文、README.zh.md 是中文，两者共用同一套小节锚点；
 * 卡片文案与图标来自清单，不激活插件也能读。
 *
 *   node tools/check-docs.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const check = (condition, message) => {
  if (!condition) problems.push(message)
}

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const json = (rel) => JSON.parse(read(rel))

// --- 清单 ---
const pkg = json('package.json')
check(typeof pkg.name === 'string' && pkg.name.length > 0, 'package.json: name 缺失')
check(pkg.dsh?.bundle?.patch === './cordis.patch.yml', 'package.json: dsh.bundle.patch 必须指向 cordis.patch.yml')
check(pkg.dsh?.client?.platform === 'web', 'package.json: dsh.client.platform 必须是 web')
check(pkg.main === 'lib/index.js', 'package.json: main 应为 lib/index.js')
check(pkg.exports?.['.'] === './lib/index.js', 'package.json: exports["."] 应指向宿主半边')
check(pkg.exports?.['./client'] === './lib/client.js', 'package.json: exports["./client"] 应指向页面半边')
check(pkg.exports?.['./package.json'] === './package.json', 'package.json: 需要导出 ./package.json')
check(typeof pkg.icon === 'string', 'package.json: 缺少 icon（插件卡片图标）')
check(pkg.exports?.['./locale/*.json'] === './locale/*.json', 'package.json: 需要导出 ./locale/*.json')
for (const required of ['lib', 'locale', 'scripts', 'cordis.patch.yml', 'icon.svg', 'README.md', 'README.zh.md']) {
  check(Array.isArray(pkg.files) && pkg.files.includes(required), `package.json: files 缺少 ${required}`)
}

// --- 发布元数据（按包名安装的前提）---
check(typeof pkg.license === 'string' && pkg.license.length > 0, 'package.json: 缺少 license')
check(/github\.com/.test(pkg.repository?.url ?? ''), 'package.json: repository.url 应指向 GitHub 仓库')
check(pkg.publishConfig?.access === 'public', 'package.json: publishConfig.access 应为 public')
check(
  typeof pkg.peerDependencies?.['@deepseek-ai/dsh'] === 'string',
  'package.json: 需要声明 @deepseek-ai/dsh 的 peer 范围（DSH 兼容性检查读的就是它）',
)
check(typeof pkg.scripts?.prepublishOnly === 'string', 'package.json: 缺少 prepublishOnly（发布前应跑检查）')
check(fs.existsSync(path.join(ROOT, '.github/workflows/publish.yml')), '缺少 .github/workflows/publish.yml')
check(fs.existsSync(path.join(ROOT, 'scripts/enable-bundle.mjs')), '缺少 scripts/enable-bundle.mjs')

// --- 图标 ---
const icon = read('icon.svg')
check(/^<svg[\s>]/.test(icon) && /<\/svg>\s*$/.test(icon), 'icon.svg: 不是完整的 SVG')
check(Buffer.byteLength(icon) <= 256 * 1024, 'icon.svg: 超过 256 KiB 上限')

// --- 卡片文案 ---
for (const [file, label] of [['locale/en.json', '英文'], ['locale/zh.json', '中文']]) {
  const meta = json(file)?.meta
  check(typeof meta?.title === 'string' && meta.title.length > 0, `${file}: ${label} title 缺失`)
  check(typeof meta?.description === 'string' && meta.description.length > 0, `${file}: ${label} description 缺失`)
}

// --- 双语 README：同一套小节锚点 ---
const frontmatter = (text) => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text)
  return match === null ? null : match[1]
}
const anchors = (text) => [...text.matchAll(/<a id="([^"]+)"><\/a>/g)].map((match) => match[1])

const en = read('README.md')
const zh = read('README.zh.md')

for (const [file, text] of [['README.md', en], ['README.zh.md', zh]]) {
  const head = frontmatter(text)
  check(head !== null, `${file}: 缺少 frontmatter`)
  check(head !== null && /^description:\s*"/m.test(head), `${file}: frontmatter 需要 description`)
  check(head !== null && /^kind:\s*"package-reference"/m.test(head), `${file}: frontmatter 需要 kind: "package-reference"`)
  check(/^## Summary$/m.test(text), `${file}: 缺少 ## Summary`)
  check(/^## Table of Contents$/m.test(text), `${file}: 缺少 ## Table of Contents`)
  check(/^## Model Experience$/m.test(text) && /^#### KV Cache effect$/m.test(text), `${file}: 缺少 Model Experience / KV Cache effect`)
  check(/^## Known Limitations and Deferred Work$/m.test(text), `${file}: 缺少 Known Limitations and Deferred Work`)
}

const enAnchors = anchors(en)
const zhAnchors = anchors(zh)
check(enAnchors.length > 0, 'README.md: 没有找到小节锚点')
check(
  JSON.stringify(enAnchors) === JSON.stringify(zhAnchors),
  `双语小节锚点不一致：\n  en: ${enAnchors.join(', ')}\n  zh: ${zhAnchors.join(', ')}`,
)

// 目录里的每个锚点都要在正文出现，反之亦然
for (const [file, text, list] of [['README.md', en, enAnchors], ['README.zh.md', zh, zhAnchors]]) {
  for (const id of list) {
    check(text.includes(`(#${id})`), `${file}: 目录缺少指向 #${id} 的链接`)
  }
}

// --- 源码里不应残留旧名（注释与安装脚本的 LEGACY 迁移常量除外）---
for (const file of ['lib/index.js', 'lib/client.js', 'cordis.patch.yml', 'scripts/enable-bundle.mjs']) {
  const text = read(file)
    .replace(/const LEGACY = \[[^\]]*\]/, 'const LEGACY = []')
    .replace(/^\s*(\/\/|\*|#).*$/gm, '')
    .replace(/([^:])\/\/.*$/gm, '$1')
  check(!text.includes('dsh-archive-cleaner'), `${file}: 残留旧名 dsh-archive-cleaner`)
}

if (problems.length > 0) {
  console.error('❌ 文档/清单检查未通过：')
  for (const problem of problems) console.error('   - ' + problem)
  process.exit(1)
}
console.log(`✅ 文档/清单检查通过（双语锚点 ${enAnchors.length} 个，卡片文案与图标齐备）`)
