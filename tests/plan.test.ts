import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'

import planExtension, { NORMAL_MODE_REMINDER, PLAN_MODE_EVENT, PLAN_REMINDER } from '../src/index'
import { SHORTCUT_ENV_VAR } from '../src/shortcut'

type Handler = (...args: unknown[]) => unknown
type EventHandler = (data: unknown) => void

/** 原始环境变量，用于每个用例结束后还原，避免配置污染开发机。 */
const ORIGINAL_ENV = {
  agentDir: process.env.PI_CODING_AGENT_DIR,
  shortcut: process.env[SHORTCUT_ENV_VAR]
}

/** 当前用例使用的临时 agent 目录。 */
let agentDir = ''

beforeEach(() => {
  // 每个用例一个空目录，让快捷键解析的结果只取决于用例自己写入的配置。
  agentDir = mkdtempSync(join(tmpdir(), 'pi-plan-test-'))
  process.env.PI_CODING_AGENT_DIR = agentDir
  delete process.env[SHORTCUT_ENV_VAR]
})

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true })
  restoreEnv('PI_CODING_AGENT_DIR', ORIGINAL_ENV.agentDir)
  restoreEnv(SHORTCUT_ENV_VAR, ORIGINAL_ENV.shortcut)
})

/** 环境变量还原：原本不存在时删除，而不是写成空串。 */
function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

/** 替身工具目录；默认与 Pi 内置工具顺序一致，用于验证工具列表保持不变。 */
const ALL_TOOLS = ['read', 'bash', 'edit', 'write']

/** 用最小 Pi API 替身验证 Plan 运行时状态、工具权限和事件通知。 */
function createRuntime(initialTools: readonly string[] = ALL_TOOLS) {
  const handlers = new Map<string, Handler>()
  const commands = new Map<string, { handler: Handler }>()
  const shortcuts = new Map<string, { handler: Handler }>()
  const eventHandlers = new Map<string, Set<EventHandler>>()
  const planEvents: boolean[] = []
  const appendedEntries: Array<{ customType: string; data: unknown }> = []
  const notifications: Array<{ message: string; level: string }> = []
  const sentUserMessages: string[] = []
  /** 记录每次发消息时指定的排队位置，验证运行中发消息不再被 Pi 拒绝。 */
  const sentUserMessageOptions: Array<{ deliverAs?: string } | undefined> = []
  let activeTools = [...initialTools]
  let setActiveToolsCalls = 0

  const events = {
    on(channel: string, handler: EventHandler) {
      const handlersForChannel = eventHandlers.get(channel) ?? new Set<EventHandler>()
      handlersForChannel.add(handler)
      eventHandlers.set(channel, handlersForChannel)
      return () => handlersForChannel.delete(handler)
    },
    emit(channel: string, data: unknown) {
      for (const handler of eventHandlers.get(channel) ?? []) handler(data)
    }
  }

  // 订阅方：记录 Plan 事件负载，验证真实状态只经事件对外暴露。
  events.on(PLAN_MODE_EVENT, (data) => {
    if (data && typeof data === 'object' && 'enabled' in data) {
      planEvents.push((data as { enabled?: unknown }).enabled === true)
    }
  })

  const pi = {
    events,
    on(event: string, handler: Handler) {
      handlers.set(event, handler)
    },
    registerCommand(name: string, options: { handler: Handler }) {
      commands.set(name, options)
    },
    registerShortcut(name: string, options: { handler: Handler }) {
      shortcuts.set(name, options)
    },
    appendEntry(customType: string, data: unknown) {
      appendedEntries.push({ customType, data })
    },
    sendUserMessage(content: string, options?: { deliverAs?: string }) {
      sentUserMessages.push(content)
      sentUserMessageOptions.push(options)
    },
    setActiveTools(toolNames: string[]) {
      setActiveToolsCalls += 1
      activeTools = [...toolNames]
    }
  } as unknown as ExtensionAPI

  const ctx = {
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level })
      }
    }
  } as unknown as ExtensionContext

  planExtension(pi)

  async function invoke(name: string, ...args: unknown[]): Promise<unknown> {
    const handler = handlers.get(name)
    expect(handler, `未注册事件：${name}`).toBeTruthy()
    return handler!(...args)
  }

  async function command(args: string): Promise<unknown> {
    const commandHandler = commands.get('plan')?.handler
    expect(commandHandler, '未注册 /plan 命令').toBeTruthy()
    return commandHandler!(args, ctx)
  }

  async function shortcut(name = 'tab'): Promise<unknown> {
    const shortcutHandler = shortcuts.get(name)?.handler
    expect(shortcutHandler, `未注册快捷键：${name}`).toBeTruthy()
    return shortcutHandler!(ctx)
  }

  return {
    ctx,
    command,
    invoke,
    shortcut,
    planEvents,
    notifications,
    sentUserMessages,
    sentUserMessageOptions,
    appendedEntries,
    activeTools: () => [...activeTools],
    /** 记录扩展是否重建过 active tools，用于保护缓存稳定性。 */
    setActiveToolsCalls: () => setActiveToolsCalls,
    /** 已注册的快捷键键位，用于验证配置解析结果。 */
    shortcutNames: () => [...shortcuts.keys()],
    /** 模拟其他扩展改动活动工具列表。 */
    replaceTools(toolNames: string[]) {
      activeTools = [...toolNames]
    }
  }
}

/** 取 context 事件注入到最后的那条消息内容；无注入时返回 null。 */
async function injectedContext(runtime: ReturnType<typeof createRuntime>): Promise<string | null> {
  const result = (await runtime.invoke('context', {
    messages: [{ role: 'user', content: 'hi' }]
  })) as { messages?: Array<{ content: string }> } | undefined
  const messages = result?.messages
  if (!messages) return null
  expect(messages).toHaveLength(2)
  return messages[1]!.content
}

describe('快捷键配置', () => {
  /** 写入 pi-plan.json，内容原样保存以便覆盖非法 JSON。 */
  function writeSettings(content: string): void {
    writeFileSync(join(agentDir, 'pi-plan.json'), content, 'utf8')
  }

  test('无配置时注册默认 tab', () => {
    expect(createRuntime().shortcutNames()).toEqual(['tab'])
  })

  test('环境变量优先于配置文件', () => {
    writeSettings(JSON.stringify({ shortcut: 'alt+p' }))
    process.env[SHORTCUT_ENV_VAR] = 'ctrl+shift+p'

    expect(createRuntime().shortcutNames()).toEqual(['ctrl+shift+p'])
  })

  test('配置文件里的键位生效', async () => {
    writeSettings(JSON.stringify({ shortcut: 'alt+p' }))

    const runtime = createRuntime()
    expect(runtime.shortcutNames()).toEqual(['alt+p'])
    // 自定义键位装的仍是同一个切换逻辑。
    await runtime.shortcut('alt+p')
    expect(runtime.planEvents).toEqual([true])
  })

  test('缺 shortcut 字段时回落到 tab', () => {
    writeSettings(JSON.stringify({ other: 1 }))

    expect(createRuntime().shortcutNames()).toEqual(['tab'])
  })

  test('JSON 解析失败直接抛错', () => {
    writeSettings('{ not json')

    expect(() => createRuntime()).toThrow(/Failed to parse pi-plan settings/)
  })

  test('shortcut 不是非空字符串时直接抛错', () => {
    writeSettings(JSON.stringify({ shortcut: '  ' }))

    expect(() => createRuntime()).toThrow(/Invalid "shortcut"/)
  })
})

describe('Plan 模式', () => {
  test('进入、退出按当前状态临时注入提醒，且不写会话记录', async () => {
    const runtime = createRuntime()

    // 全新会话从未进入过 Plan，不注入退出提醒。
    expect(await injectedContext(runtime)).toBeNull()

    await runtime.command('')
    expect(await injectedContext(runtime)).toBe(PLAN_REMINDER)
    expect(runtime.planEvents).toEqual([true])
    expect(runtime.appendedEntries).toEqual([])

    await runtime.command('exit')
    expect(await injectedContext(runtime)).toBe(NORMAL_MODE_REMINDER)
    // 退出提醒只发一次：下一次请求不再追加任何消息。
    expect(await injectedContext(runtime)).toBeNull()
    expect(runtime.planEvents).toEqual([true, false])
  })

  test('每次退出对应一次退出提醒', async () => {
    const runtime = createRuntime()

    await runtime.command('')
    await runtime.command('exit')
    expect(await injectedContext(runtime)).toBe(NORMAL_MODE_REMINDER)
    expect(await injectedContext(runtime)).toBeNull()

    // 再次进入并退出，下一次请求再注入一次。
    await runtime.command('')
    expect(await injectedContext(runtime)).toBe(PLAN_REMINDER)
    await runtime.command('exit')
    expect(await injectedContext(runtime)).toBe(NORMAL_MODE_REMINDER)
    expect(await injectedContext(runtime)).toBeNull()
  })

  test('命令幂等，Tab 负责切换并发布事件', async () => {
    // /plan 只负责进入，避免重复命令把已经开启的模式意外关闭。
    const runtime = createRuntime()

    await runtime.command('')
    await runtime.command('')
    expect(runtime.planEvents).toEqual([true])

    await runtime.shortcut()
    expect(runtime.planEvents).toEqual([true, false])
    await runtime.shortcut()
    expect(runtime.planEvents).toEqual([true, false, true])

    // /plan enter 与 /plan 等价：只进入，重复调用不重复广播。
    await runtime.command('exit')
    runtime.sentUserMessages.length = 0
    await runtime.command('enter')
    await runtime.command('enter')
    expect(runtime.planEvents).toEqual([true, false, true, false, true])
    expect(runtime.sentUserMessages).toEqual([])

    // 带参数的 enter 在进入的同时把参数作为提示词发送。
    await runtime.command('exit')
    runtime.sentUserMessages.length = 0
    await runtime.command('enter 看下构建脚本')
    expect(runtime.planEvents).toEqual([true, false, true, false, true, false, true])
    expect(runtime.sentUserMessages).toEqual(['看下构建脚本'])
  })

  test('新运行时不恢复 Plan 状态', async () => {
    const runtime = createRuntime()
    await runtime.command('')
    await runtime.invoke('session_start', {}, runtime.ctx)

    expect(runtime.planEvents).toEqual([true, false])
    // 重置后从关闭状态开始，未发生过退出动作，无退出提醒。
    expect(await injectedContext(runtime)).toBeNull()
  })

  test('在工具调用层阻止 edit/write，但不拦 bash', async () => {
    const runtime = createRuntime()
    await runtime.command('')

    const blocked = (await runtime.invoke('tool_call', {
      toolName: 'edit',
      input: {}
    })) as { block: boolean; reason: string }
    expect(blocked.block).toBe(true)
    // 拒绝信息直接指导 AI，不要求 AI 执行退出命令。
    expect(blocked.reason).toBe('Plan 模式：请勿调用 edit/write，仅输出计划。')
    expect(await runtime.invoke('tool_call', { toolName: 'write', input: {} })).toMatchObject({
      block: true
    })
    expect(await runtime.invoke('tool_call', { toolName: 'bash', input: {} })).toBeUndefined()

    await runtime.command('exit')
    expect(await runtime.invoke('tool_call', { toolName: 'edit', input: {} })).toBeUndefined()
  })

  test('切换不修改活动工具列表', async () => {
    // 保留工具描述和顺序：进入、退出 Plan 都不重建 active tools。
    const ordered = createRuntime(['read', 'edit', 'bash', 'write', 'grep'])
    await ordered.command('')
    expect(ordered.activeTools()).toEqual(['read', 'edit', 'bash', 'write', 'grep'])
    await ordered.command('exit')
    expect(ordered.activeTools()).toEqual(['read', 'edit', 'bash', 'write', 'grep'])
    expect(ordered.setActiveToolsCalls()).toBe(0)

    // 其他来源已经缩减或扩展的工具列表也保持原样。
    const extended = createRuntime()
    extended.replaceTools([...extended.activeTools(), 'mcp_write'])
    await extended.command('')
    await extended.command('exit')
    expect(extended.activeTools()).toEqual(['read', 'bash', 'edit', 'write', 'mcp_write'])
  })

  test('status 查询不改状态，其余参数当作提示词进入 Plan', async () => {
    const runtime = createRuntime()
    await runtime.command('')
    await runtime.command('status')
    expect(runtime.planEvents).toEqual([true])

    // 任意非子命令参数视为提示词：进入 Plan 并原样发送。
    runtime.sentUserMessages.length = 0
    await runtime.command('改一下这个函数')
    expect(runtime.planEvents).toEqual([true])
    expect(runtime.sentUserMessages).toEqual(['改一下这个函数'])
  })

  test('运行中发送提示词时指定 steering 排队位置', async () => {
    // agent 运行中命令会立即执行，此时发消息缺 deliverAs 会被 Pi 报错拒绝。
    const runtime = createRuntime()
    await runtime.command('enter 看下构建脚本')
    await runtime.command('exit 执行这些改动')
    await runtime.command('改一下这个函数')

    expect(runtime.sentUserMessages).toHaveLength(3)
    expect(runtime.sentUserMessageOptions).toEqual([
      { deliverAs: 'steer' },
      { deliverAs: 'steer' },
      { deliverAs: 'steer' }
    ])
  })

  test('exit 后的文字作为用户消息发送', async () => {
    const runtime = createRuntime()
    await runtime.command('')

    // 退出与发提示词同一次完成，换行不被压平。
    await runtime.command('exit 执行这些改动\n第二行')
    expect(runtime.planEvents).toEqual([true, false])
    expect(runtime.sentUserMessages).toEqual(['执行这些改动\n第二行'])
    // 不带提示词时只退出，不发送任何消息。
    await runtime.command('')
    runtime.sentUserMessages.length = 0
    await runtime.command('exit')
    expect(runtime.sentUserMessages).toEqual([])
  })
})
