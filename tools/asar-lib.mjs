/**
 * 极简 asar 读取器（无第三方依赖）。
 *
 * DSH 桌面端的实现代码打包在 `<安装目录>\resources\app.asar` 里，
 * 这个库让仓库里的工具/测试能直接读里面的文件，不必解包整个归档。
 *
 * asar 结构：8 字节 pickle 头 + JSON 目录 + 各文件数据（offset 相对数据区起点）。
 */
import fs from 'node:fs'

/** 读取归档头，返回 `{ header, baseOffset }`（数据区起点）。 */
export function readArchiveHeader(archive) {
  const fd = fs.openSync(archive, 'r')
  try {
    const head = Buffer.alloc(16)
    fs.readSync(fd, head, 0, 16, 0)
    const headerSize = head.readUInt32LE(12)
    const buf = Buffer.alloc(headerSize)
    fs.readSync(fd, buf, 0, headerSize, 16)
    const header = JSON.parse(buf.toString('utf8').replace(/\0+$/, ''))
    return { header, baseOffset: 16 + headerSize }
  } finally {
    fs.closeSync(fd)
  }
}

/** 把归档目录树摊平成 `[{ path, size, offset }]`（unpacked 条目没有 offset）。 */
export function listArchiveEntries(archive) {
  const { header, baseOffset } = readArchiveHeader(archive)
  const out = []
  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const path = prefix === '' ? name : `${prefix}/${name}`
      if (entry.files !== undefined) walk(entry, path)
      else out.push({ path, size: entry.size, offset: Number(entry.offset), baseOffset })
    }
  }
  walk(header, '')
  return out
}

/** 读出归档里的一个文件；不存在或被 unpack 时返回 undefined。 */
export function readArchiveEntry(archive, innerPath) {
  const entry = listArchiveEntries(archive).find((candidate) => candidate.path === innerPath)
  if (entry === undefined || !Number.isFinite(entry.offset)) return undefined
  const fd = fs.openSync(archive, 'r')
  try {
    const buf = Buffer.alloc(entry.size)
    fs.readSync(fd, buf, 0, entry.size, entry.baseOffset + entry.offset)
    return buf
  } finally {
    fs.closeSync(fd)
  }
}

/** 默认的 app.asar 位置；可用环境变量 DSH_APP_ASAR 覆盖。 */
export const DEFAULT_APP_ASAR = process.env.DSH_APP_ASAR ?? 'G:\\DSH\\resources\\app.asar'
