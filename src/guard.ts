import { realpath } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'

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
  /** realpath 成功时的真实路径；解析失败时回退为 abs。 */
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
]

/** 只检查路径字符串，供文件 IO 之前过滤敏感路径。 */
export function isBlocked(abs: string): boolean {
  return BLOCKED.some((b) => b.re.test(abs))
}

/**
 * 用相对路径排除项目外路径，避免把同前缀的兄弟目录误判为项目内。
 * Windows 跨盘时 relative 返回绝对路径；当前实现也拒绝 ROOT 自身。
 */
function lexicallyInsideRoot(abs: string): boolean {
  const rel = relative(ROOT, abs)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * 单文件读取检查：先校验词法路径，再对可解析的真实路径重复检查。
 * 链接指向项目外或敏感路径时拒绝，避免只检查表面的文件名。
 * realpath 失败时按当前策略放行到后续 IO，此分支没有验证链接目标。
 */
export async function guardPathRead(abs: string): Promise<PathGuardResult> {
  if (!lexicallyInsideRoot(abs)) {
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
    if (!lexicallyInsideRoot(real)) {
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
    // 解析失败时保留词法路径，是否可读交由后续文件 IO 判断。
    return { ok: true, abs, real: abs }
  }
}

/**
 * 校验搜索起点的项目范围；链接解析后仍在项目内时允许继续。
 * 起点自身仍受 lexicallyInsideRoot 约束，当前要求使用项目的子目录。
 * 敏感文件过滤及递归条目的链接跳过，由搜索工具在遍历时处理。
 */
export async function guardDirRead(rootAbs: string): Promise<PathGuardResult> {
  if (!lexicallyInsideRoot(rootAbs)) {
    return {
      ok: false,
      message: `错误:"${rootAbs}" 解析到项目目录(${ROOT})之外。只能操作项目目录以内的路径。`,
    }
  }

  try {
    const real = await realpath(rootAbs)
    if (!lexicallyInsideRoot(real)) {
      return {
        ok: false,
        message:
          `错误:"${rootAbs}" 经由符号链接指向项目目录之外的 "${real}"。` +
          `符号链接不改变真实边界,请从项目目录以内的真实目录开始搜索。`,
      }
    }
    return { ok: true, abs: rootAbs, real }
  } catch {
    return { ok: true, abs: rootAbs, real: rootAbs }
  }
}
