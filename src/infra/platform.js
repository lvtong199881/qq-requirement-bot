import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 平台适配器：把「构建、测试、装包、找产物」这些和平台相关的东西收在一处。
 *
 * 为什么要这层：编排层不该知道 hvigor 还是 gradle、.hap 还是 .apk。
 * 换一个平台应该是「加一个 adapter 文件」，而不是满项目搜 hvigor 和 hdc。
 * skill 里的命令也统一写成占位符，由 bridge 按平台填。
 */

/** 任务包里给 agent 看的命令片段里，这几个占位符会被替换 */
export const PLACEHOLDERS = ['{artifactId}', '{deviceId}', '{artifact}', '{sdkHome}']

/**
 * 每个平台提供：
 *   id / label
 *   artifactExt        安装包后缀（找产物用）
 *   sdkEnv             需要导出的 SDK 环境变量名（没有就 null）
 *   build / test       { cmd, args, timeoutMs }  ← test 是本地单测
 *                      （上设备的验证属于测试/验收阶段，不在 dev 阶段做）
 *   install / uninstall{ cmd, args }
 *   locateArtifact     (root) => 相对路径数组（按最可能的位置排）
 *   notes              平台特有的坑，原样写进任务包
 */
export const PLATFORMS = {
  harmony: {
    id: 'harmony',
    label: '鸿蒙',
    artifactExt: '.hap',
    sdkEnv: 'DEVECO_SDK_HOME',
    build: {
      cmd: 'node "$OHOS_TOOLCHAIN/node_modules/@ohos/hvigor/bin/hvigor.js"',
      args: ['--mode', 'module', '-p', 'module=entry@default', 'assembleHap', '--no-daemon'],
      timeoutMs: 15 * 60 * 1000,
    },
    test: {
      cmd: 'node "$OHOS_TOOLCHAIN/node_modules/@ohos/hvigor/bin/hvigor.js"',
      args: ['--mode', 'module', '-p', 'module=entry@default', 'test', '--no-daemon'],
      timeoutMs: 15 * 60 * 1000,
    },
    install: { cmd: 'hdc', args: ['-t', '{deviceId}', 'install', '-r', '{artifact}'] },
    uninstall: { cmd: 'hdc', args: ['-t', '{deviceId}', 'uninstall', '{artifactId}'] },
    locateArtifact: [
      'entry/build/default/outputs/default/*.hap',
      'entry/build/**/outputs/**/*.hap',
    ],
    notes: [
      '必须带 --no-daemon：hvigor 的 daemon 在部分机器上会卡死（命令挂起直到超时）。',
      '单测通常几秒到十几秒，超过一分钟没输出基本就是 daemon 的问题。',
      '覆盖安装用 install -r，装不上就先 uninstall，不要为了装上而改 versionCode。',
    ],
  },

  android: {
    id: 'android',
    label: 'Android',
    artifactExt: '.apk',
    sdkEnv: 'ANDROID_HOME',
    build: { cmd: './gradlew', args: ['assembleDebug', '--console=plain'], timeoutMs: 20 * 60 * 1000 },
    test: { cmd: './gradlew', args: ['testDebugUnitTest', '--console=plain'], timeoutMs: 20 * 60 * 1000 },
    install: { cmd: 'adb', args: ['-s', '{deviceId}', 'install', '-r', '-t', '{artifact}'] },
    uninstall: { cmd: 'adb', args: ['-s', '{deviceId}', 'uninstall', '{artifactId}'] },
    locateArtifact: [
      'app/build/outputs/apk/debug/*.apk',
      '**/build/outputs/apk/debug/*.apk',
    ],
    notes: [
      '首次构建要下载依赖，可能几分钟；之后的增量构建快得多。',
      '多设备时必须用 adb -s <deviceId>，否则命令会打到默认设备上。',
      'debug 包带 -t 允许测试包安装；release 包要签名配置齐全。',
    ],
  },

  ios: {
    id: 'ios',
    label: 'iOS',
    artifactExt: '.app',
    sdkEnv: 'DEVELOPER_DIR',
    build: { cmd: 'xcodebuild', args: ['-scheme', 'App', '-configuration', 'Debug', 'build'], timeoutMs: 20 * 60 * 1000 },
    test: { cmd: 'xcodebuild', args: ['test', '-scheme', 'App', '-destination', 'platform=iOS Simulator,id={deviceId}'], timeoutMs: 20 * 60 * 1000 },
    install: { cmd: 'xcrun', args: ['simctl', 'install', '{deviceId}', '{artifact}'] },
    uninstall: { cmd: 'xcrun', args: ['simctl', 'uninstall', '{deviceId}', '{artifactId}'] },
    locateArtifact: ['build/Build/Products/Debug-iphonesimulator/*.app'],
    notes: [
      '模拟器 id 是 UDID，用 xcrun simctl list devices 查。',
      '真机签名需要描述文件和证书，通常只有 CI 才有。',
    ],
  },
}

/**
 * 取平台适配器。参数可以是仓库对象（{platform}）或配置对象。
 * 平台是仓库属性——主仓库决定这个需求用哪套构建和装包命令。
 */
export function platformOf(repoOrConfig) {
  return PLATFORMS[repoOrConfig?.platform] ?? PLATFORMS.harmony
}

/** 填占位符 */
export function fillPlaceholders(template, vars) {
  let out = template
  for (const [k, v] of Object.entries(vars ?? {})) {
    out = out.split(`{${k}}`).join(String(v ?? ''))
  }
  return out
}

/** 把 {cmd, args} 渲染成一行可复制的命令 */
export function renderCommand(spec, vars) {
  if (!spec) return ''
  const args = (spec.args ?? []).map((a) => fillPlaceholders(a, vars))
  return [spec.cmd, ...args].join(' ')
}

/** 找安装包：按 locateArtifact 的候选顺序找第一个命中的 */
export function findArtifact(platform, root) {
  const globSimple = (pattern) => {
    // 只支持 ** 和 * 的简单展开，够找构建产物用了
    const parts = pattern.split('/')
    const walk = (dir, idx) => {
      if (idx >= parts.length) return []
      const seg = parts[idx]
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return []
      }
      const out = []
      for (const e of entries) {
        const full = join(dir, e.name)
        if (seg === '**') {
          if (e.isDirectory()) out.push(...walk(full, idx))
          out.push(...walk(dir, idx + 1))
        } else if (seg === '*') {
          if (e.isFile() && idx === parts.length - 1) out.push(full)
          else if (e.isDirectory()) out.push(...walk(full, idx + 1))
        } else if (e.name === seg || (seg.includes('*') && new RegExp(`^${seg.replace(/\*/g, '.*')}$`).test(e.name))) {
          if (idx === parts.length - 1) out.push(full)
          else if (e.isDirectory()) out.push(...walk(full, idx + 1))
        }
      }
      return out
    }
    return walk(root, 0)
  }

  for (const pattern of platform.locateArtifact ?? []) {
    const hits = globSimple(pattern).filter((f) => {
      try {
        return statSync(f).isFile()
      } catch {
        return false
      }
    })
    if (hits.length) {
      // 取最新的那个
      hits.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
      return hits[0]
    }
  }
  return null
}
