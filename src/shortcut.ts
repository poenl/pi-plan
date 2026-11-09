import type { KeyId } from '@earendil-works/pi-tui'

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Plan 模式的快捷键解析。
 *
 * 宿主的 `registerShortcut` 只接受键位字符串，且 `keybindings.json` 只能改写内置动作，
 * 因此键位必须由扩展自己在加载期（工厂期）决定，改配置后需 `/reload` 才能生效。
 *
 * 优先级：环境变量 `PI_PLAN_SHORTCUT`（非空）→ `<agent-dir>/pi-plan.json` 的
 * `shortcut` 字段 → 默认 `tab`。
 */

/** 覆盖快捷键的环境变量名。 */
export const SHORTCUT_ENV_VAR = 'PI_PLAN_SHORTCUT'

/** 未配置时使用的键位，保持与旧版本一致。 */
const DEFAULT_SHORTCUT: KeyId = 'tab'

/** 与 Pi 相同的目录解析规则：`PI_CODING_AGENT_DIR` 优先，否则 `~/.pi/agent`。 */
export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PI_CODING_AGENT_DIR?.trim()
  return override || join(homedir(), '.pi', 'agent')
}

/** 配置文件路径：`<agent-dir>/pi-plan.json`。 */
export function getPlanSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveAgentDir(env), 'pi-plan.json')
}

/**
 * 解析最终使用的键位。
 *
 * 只有「文件不存在」和「缺 `shortcut` 字段」视为未配置并回落默认值；读失败、JSON 解析失败、
 * 值不是非空字符串都直接抛错，避免配置写错被静默掩盖。
 *
 * 不做键位语法校验：pi-tui 的 `parseKeyId` 未导出，且非法键位不会报错，只会永远匹配不到，
 * 因此这里只做类型断言，把字符串原样交给宿主。
 */
export function loadPlanShortcut(
  filePath: string = getPlanSettingsPath(),
  env: NodeJS.ProcessEnv = process.env
): KeyId {
  const fromEnv = env[SHORTCUT_ENV_VAR]?.trim()
  if (fromEnv) return fromEnv as KeyId

  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_SHORTCUT
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to read pi-plan settings at ${filePath}: ${message}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to parse pi-plan settings at ${filePath}: ${message}`)
  }

  // 顶层不是对象等价于没有该配置项。
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return DEFAULT_SHORTCUT
  }

  const { shortcut } = parsed as Record<string, unknown>
  if (shortcut === undefined) return DEFAULT_SHORTCUT
  if (typeof shortcut !== 'string' || shortcut.trim() === '') {
    throw new Error(
      `Invalid "shortcut" in ${filePath}: expected a non-empty string, got ${JSON.stringify(shortcut)}`
    )
  }
  return shortcut.trim() as KeyId
}
