/**
 * 账号的加密原语：密码哈希 + 会话 token 签名。
 *
 * 全部用 node:crypto 内置实现，不引 bcrypt / jsonwebtoken——
 * 这个项目零第三方运行时依赖，账号系统也不该成为例外。
 *
 * 密码用 scrypt：内存硬，比 pbkdf2 抗 GPU 暴力破解。
 * N=16384 是 Node 默认的成本参数，单次约 50~100ms，登录场景完全够用，
 * 但让离线爆破变贵。
 */
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/** scrypt 参数。写进存储是为了将来调参后旧密码仍能验证 */
const SCRYPT_N = 16384
const SCRYPT_KEYLEN = 64
const SALT_BYTES = 16

/** token 有效期：7 天。团队内部工具，反复登录很烦，但也不能永不过期 */
export const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000

export function newSalt() {
  return randomBytes(SALT_BYTES).toString('hex')
}

/** 生成签名用的密钥。首次启动写盘，之后一直用同一个，重启不掉登录 */
export function newSecret() {
  return randomBytes(32).toString('hex')
}

/**
 * 算密码哈希。
 * @returns {string} hex 编码的 64 字节派生结果
 */
export function hashPassword(password, salt) {
  return scryptSync(String(password), salt, SCRYPT_KEYLEN, { N: SCRYPT_N }).toString('hex')
}

/**
 * 校验密码。用 timingSafeEqual 而不是 ===：
 * 字符串比较会在第一个不同字节就返回，攻击者能靠响应时间逐字节猜出哈希。
 */
export function verifyPassword(password, salt, expectedHex) {
  if (!password || !salt || !expectedHex) return false
  let actual
  try {
    actual = scryptSync(String(password), salt, SCRYPT_KEYLEN, { N: SCRYPT_N })
  } catch {
    return false
  }
  let expected
  try {
    expected = Buffer.from(expectedHex, 'hex')
  } catch {
    return false
  }
  // 长度不同时 timingSafeEqual 会抛错，先挡掉
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}

const b64url = (buf) => Buffer.from(buf).toString('base64url')

/**
 * 签一个 token，形状是简化版 JWT：`header.payload.signature`。
 *
 * 不用真正的 JWT 库，因为只需要「服务端自己签、自己验」，
 * 不需要跨服务互认，HS256 手写三行就够了。
 */
export function signToken(payload, secret, { ttlMs = TOKEN_TTL_MS } = {}) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const now = Date.now()
  const body = b64url(JSON.stringify({ ...payload, iat: now, exp: now + ttlMs }))
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url')
  return `${header}.${body}.${sig}`
}

/**
 * 验签 + 检查过期。
 * @returns {object|null} 载荷；任何异常都返回 null，调用方统一当未登录处理
 */
export function verifyToken(token, secret) {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [header, body, sig] = parts

  const expected = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url')
  // 先比签名再解析：签名不对就不该相信 body 里的任何内容
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  let payload
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null
  return payload
}

/**
 * 密码强度校验。返回错误文案，通过则返回 null。
 *
 * 只要求 6 位：这是团队内部工具，强制复杂密码的结果是大家写在便利贴上。
 * 真正的防线是「地址不公开 + 账号可随时禁用」。
 */
export function checkPassword(password) {
  const p = String(password ?? '')
  if (p.length < 6) return '密码至少 6 位'
  if (p.length > 128) return '密码最长 128 位'
  return null
}

/**
 * 用户名校验。允许中文：团队里用真名当用户名比想一个英文 id 自然得多。
 * 但禁止空白和路径分隔符——username 会进日志和 URL。
 */
export function checkUsername(username) {
  const u = String(username ?? '').trim()
  if (u.length < 2) return '用户名至少 2 个字符'
  if (u.length > 20) return '用户名最长 20 个字符'
  if (!/^[\w\u4e00-\u9fa5.-]+$/.test(u)) return '用户名只能包含中英文、数字、下划线、点和短横线'
  if (/^[.-]|[.-]$/.test(u)) return '用户名不能以点或短横线开头结尾'
  return null
}
