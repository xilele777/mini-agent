import { realpath } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'

/**
 * 共享的文件路径边界。凡是把文件内容读进模型上下文的工具
 * (read_file、search_files)都必须经过这里;以后新增同类工具也一样。
 *
 * 这套规则最初分散在 fs.ts / grep.ts 里,各守各的、互不一致——
 * search_files 能绕过 read_file 的封锁名单,根因就在这里。
 */

/** 项目根目录,统一取一次 */
export const ROOT = process.cwd()

export interface PathCheck {
  ok: true
  /** 词法绝对路径(resolve 结果),展示用 */
  abs: string
  /** 符号链接解析后的真实绝对路径(realpath 结果) */
  real: string
}

export interface PathReject {
  ok: false
  /** 面向模型的解释文本,含具体原因 */
  message: string
}

export type PathGuardResult = PathCheck | PathReject

/**
 * 读到就会进上下文,进了上下文就可能被后续某条命令带出去。
 * 所有工具共用的封锁名单 —— 按文件名正则匹配,命中即拒绝。
 */
export const BLOCKED: { re: RegExp; why: string }[] = [
  { re: /(^|[/\\])\.env($|\.)/i, why: '.env 里通常放着 API key' },
  { re: /(^|[/\\])\.git([/\\]|$)/i, why: '.git 内部对象不该进上下文' },
  { re: /(^|[/\\])node_modules([/\\]|$)/i, why: 'node_modules 会瞬间撑爆上下文' },
  { re: /(^|[/\\])id_rsa|\.(pem|key)$/i, why: '这看起来是私钥' },
]

/** 路径里是否命中封锁名单(只做词法判断,可用在 IO 之前) */
export function isBlocked(abs: string): boolean {
  return BLOCKED.some((b) => b.re.test(abs))
}

/**
 * 判断词法绝对路径是否仍在项目目录内。
 *
 * 为什么不用字符串前缀比较(abs.startsWith(ROOT)):
 * ROOT = /home/me/app 时,/home/me/app-backup 也以它开头,会被误判成"在里面"。
 * relative() 的返回值天然表达包含关系:在里面就是 "src/a.ts",
 * 在外面必然以 ".." 开头(Windows 跨盘符时则返回绝对路径)。
 */
function lexicallyInsideRoot(abs: string): boolean {
  const rel = relative(ROOT, abs)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * 完整路径守卫(词法 + 符号链接),供 read_file 这类单文件工具使用。
 * - path 相对项目根目录解析;
 * - 先做词法检查(insideRoot + BLOCKED),失败立即拒绝,不做无谓 IO;
 * - 再做 realpath:文件若经由 symlink / junction 指向项目外,
 *   词法上看起来"在里面"也照样拒绝。
 *
 * realpath 失败(文件不存在等)时不算越界:词法已通过,说明路径本身在项目内,
 * 交由后续 readFile 报错更诚实,所以这里放行。
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
    // realpath 失败通常是"文件不存在"。词法已通过,把它交给后续 IO 报错
    return { ok: true, abs, real: abs }
  }
}

/**
 * 目录守卫:校验一个"作为递归起点的目录"是否安全。
 * - search_files 的 path 参数必须落在项目目录内;
 * - 目录本身是符号链接(junction)时拒绝,防止把项目外整棵树纳入遍历。
 *
 * 注意:BLOCKED 名单不在这里逐项检查 —— 递归过程里由 isBlocked 对每个文件判断,
 * 因为 walk 看到的"条目"才带链接信息;这里只能防住起点本身是链接的情况。
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
