/**
 * asar 命令行工具：查看/导出 DSH 安装包里的文件。
 *
 * 用法：
 *   node tools/asar.mjs ls   [归档] [正则]            # 列出条目（可过滤）
 *   node tools/asar.mjs cat  [归档] <内部路径> [输出] # 导出单个文件
 *   node tools/asar.mjs grep [归档] <子串>            # 按内容找文件（只看 lib 下的 js）
 *
 * 归档默认取环境变量 DSH_APP_ASAR，否则用 G:\DSH\resources\app.asar。
 */
import fs from 'node:fs'
import { DEFAULT_APP_ASAR, listArchiveEntries, readArchiveEntry } from './asar-lib.mjs'

const [, , cmd, ...rest] = process.argv
// 第一个参数只有以 .asar 结尾时才当归档路径，其余情况一律用默认归档
const args = rest[0] !== undefined && rest[0].endsWith('.asar') ? rest.slice(1) : rest
const archive = rest[0] !== undefined && rest[0].endsWith('.asar') ? rest[0] : DEFAULT_APP_ASAR

if (cmd === 'ls') {
  const pattern = args[0] === undefined ? undefined : new RegExp(args[0])
  for (const entry of listArchiveEntries(archive)) {
    if (pattern === undefined || pattern.test(entry.path)) console.log(`${entry.size}\t${entry.path}`)
  }
} else if (cmd === 'cat') {
  const innerPath = args[0]
  if (innerPath === undefined) {
    console.error('usage: node tools/asar.mjs cat [archive] <innerPath> [outFile]')
    process.exit(2)
  }
  const data = readArchiveEntry(archive, innerPath)
  if (data === undefined) {
    console.error(`not found: ${innerPath}`)
    process.exit(2)
  }
  const outFile = args[1]
  if (outFile === undefined) process.stdout.write(data)
  else {
    fs.writeFileSync(outFile, data)
    console.log(`wrote ${data.length} bytes -> ${outFile}`)
  }
} else if (cmd === 'grep') {
  const needle = args[0]
  if (needle === undefined) {
    console.error('usage: node tools/asar.mjs grep [archive] <substring>')
    process.exit(2)
  }
  const bytes = Buffer.from(needle)
  for (const entry of listArchiveEntries(archive)) {
    if (!/^dsh\/node_modules\/@deepseek-ai\/[^/]+\/lib\/.*\.js$/.test(entry.path)) continue
    if (entry.size > 900_000 || !Number.isFinite(entry.offset)) continue
    const data = readArchiveEntry(archive, entry.path)
    if (data !== undefined && data.includes(bytes)) console.log(entry.path)
  }
} else {
  console.error('usage: node tools/asar.mjs ls|cat|grep ...')
  process.exit(1)
}
