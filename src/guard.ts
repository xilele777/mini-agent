import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * read_file 与 search_files 共用的路径检查，调用方传入已解析的绝对路径。
 * 检查项目范围、敏感路径及可解析的链接目标；run_bash 不经过这些文件工具检查。
 */

/** 模块加载时记录工作目录，作为文件工具解析相对路径的基准。 */
export const ROOT = process.cwd()

export interface PathCheck {
  ok: true
  /** 调用方传入的词法绝对路径，用于展示及后续 IO。 */
  abs: string
  /** 已验证的真实路径；无法解析时拒绝。 */
  real: string
}

export interface PathReject {
  ok: false
  /** 可直接回填给模型的拒绝原因。 */
  message: string
}

export type PathGuardResult = PathCheck | PathReject

/**
 * 文件读取与搜索共用的敏感路径规则，正则匹配完整路径中的文件或目录名。
 */
export const BLOCKED: { re: RegExp; why: string }[] = [
  { re: /(^|[/\\])\.env($|\.)/i, why: '.env 里通常放着 API key' },
  { re: /(^|[/\\])\.git([/\\]|$)/i, why: '.git 内部对象不该进上下文' },
  { re: /(^|[/\\])node_modules([/\\]|$)/i, why: 'node_modules 会瞬间撑爆上下文' },
  { re: /(^|[/\\])id_rsa|\.(pem|key)$/i, why: '这看起来是私钥' },
  {re: /(^|[/\\])\.mini-agent([/\\]|$)/i, why: '会话内部状态不允许工具直接读写',
},
]

/** 只检查路径字符串，供文件 IO 之前过滤敏感路径。 */
export function isBlocked(abs: string): boolean {
  return BLOCKED.some((b) => b.re.test(abs))
}

/**
 * 用相对路径排除项目外路径，避免把同前缀的兄弟目录误判为项目内。
 * Windows 跨盘时 relative 返回绝对路径；搜索目录可以是 ROOT 自身。
 */
function lexicallyInsideRoot(abs: string, allowRoot = false, root = ROOT): boolean {
  const rel = relative(root, abs)
  return (rel !== '' || allowRoot) && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * 单文件读取检查：先校验词法路径，再对可解析的真实路径重复检查。
 * 链接指向项目外或敏感路径时拒绝，避免只检查表面的文件名。
 * realpath 失败时拒绝，不把词法路径当成已验证真实路径。
 */
export async function guardPathRead(abs: string, allowRoot = false): Promise<PathGuardResult> {
  if (!lexicallyInsideRoot(abs, allowRoot) || relative(ROOT, abs).includes(':')) {
    return {
      ok: false,
      message: `错误:拒绝读取 "${abs}"。它解析后指向项目目录(${ROOT})之外。只能操作项目目录以内的路径。`,
    }
  }

  const hit = BLOCKED.find((b) => b.re.test(abs))
  if (hit) {
    return {
      ok: false,
      message: `错误:拒绝读取 "${abs}" —— ${hit.why}。请换一个文件,不要尝试绕过这条限制。`,
    }
  }

  try {
    const real = await realpath(abs)
    if (!lexicallyInsideRoot(real, allowRoot, await realpath(ROOT))) {
      return {
        ok: false,
        message:
          `错误:拒绝读取 "${abs}" —— 它经由符号链接指向项目目录之外的 "${real}"。` +
          `符号链接不改变真实边界,请操作项目目录以内的真实文件。`,
      }
    }
    const realHit = BLOCKED.find((b) => b.re.test(real))
    if (realHit) {
      return {
        ok: false,
        message:
          `错误:拒绝读取 "${abs}" —— 它经由符号链接指向 ${realHit.why}(${real})。` +
          `请操作项目目录以内的真实文件,不要尝试绕过这条限制。`,
      }
    }
    return { ok: true, abs, real }
  } catch {
    return { ok: false, message: `错误:无法解析真实路径，拒绝操作 "${abs}"。` }
  }
}

/**
 * 校验搜索起点的项目范围；链接解析后仍在项目内时允许继续。
 * 起点允许项目根；目录别名也检查真实敏感路径。
 */
export async function guardDirRead(rootAbs: string): Promise<PathGuardResult> {
  return guardPathRead(rootAbs, true)
}

// Note: 新建与增量编辑共用保守路径检查 — 见 .agents/notes/implemented/feature/2026-09-21-safe-incremental-editing.md
/** 写入拒绝任何链接组件；允许尚不存在的后缀，并检查最近的已有父目录。 */
export async function guardPathWrite(path: string): Promise<string> {
  const abs = resolve(ROOT, path)
  if (!lexicallyInsideRoot(abs) || isBlocked(abs) || relative(ROOT, abs).includes(':')) {
    throw new Error(`拒绝写入项目之外或敏感路径: ${abs}`)
  }
  let current = abs
  for (;;) {
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) throw new Error(`拒绝写入链接路径: ${current}`)
      if (current !== abs && !info.isDirectory()) throw new Error('父路径不是目录')
      if (current === abs && (!info.isFile() || info.nlink > 1)) {
        throw new Error('只允许普通、非硬链接文件')
      }
      const real = await realpath(current)
      if (!lexicallyInsideRoot(real, true, await realpath(ROOT)) || isBlocked(real)) {
        throw new Error('真实路径位于项目之外或敏感目录')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    current = dirname(current)
    if (relative(ROOT, current) === '') break
  }
  return abs
}
