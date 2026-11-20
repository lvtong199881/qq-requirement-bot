/**
 * 把服务器地址打成二维码。
 *
 * 为什么放在服务端：手机上手打 trycloudflare 那种域名基本不现实，而 App
 * 的「连接服务器」页已经支持扫码。启动时在日志里把地址和二维码一起打出来，
 * 用户打开 App 扫一下就连上了，不用在手机和电脑之间来回抄。
 *
 * 二维码内容必须是客户端能直接用的 baseUrl：带协议、不带结尾斜杠。
 */
import qrcode from 'qrcode-terminal'
import { pathToFileURL } from 'node:url'

/**
 * 生成二维码文本（不打印）。
 *
 * qrcode-terminal 的 generate 是同步回调，这里把它包成返回值，
 * 方便测试直接比对内容，而不必抓 stdout。
 */
export function qrText(url) {
  let out = ''
  qrcode.generate(url, { small: true }, (q) => {
    out = q
  })
  return out
}

/** 打印地址 + 二维码。log 可注入，测试里用来收文本。 */
export function printQr(url, { log = console.log } = {}) {
  log('')
  log(`  用 App 扫码连接：${url}`)
  log('')
  for (const line of qrText(url).split('\n')) {
    if (line.trim()) log(line)
  }
  log('')
}

// 给运维用：cloudflared 起来之后隧道地址是动态的，
//   node src/ui/qr.js https://xxx.trycloudflare.com
// 就能在终端补打一张二维码，不必重启服务。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.argv[2]
  if (!url) {
    console.error('用法：node src/ui/qr.js <服务器地址>')
    process.exit(1)
  }
  printQr(url)
}
