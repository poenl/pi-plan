import { describe, expect, test } from 'vitest'

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'

import planExtension, { NORMAL_MODE_REMINDER, PLAN_MODE_EVENT, PLAN_REMINDER } from '../src/index'

type Handler = (...args: unknown[]) => unknown
type EventHandler = (data: unknown) => void

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
    appendedEntries,
    activeTools: () => [...activeTools],
    /** 记录扩展是否重建过 active tools，用于保护缓存稳定性。 */
    setActiveToolsCalls: () => setActiveToolsCalls,
    /** 模拟其他扩展改动活动工具列表。 */
    replaceTools(toolNames: string[]) {
      activeTools = [...toolNames]
    }
  }
}

/** 取 context 事件注入到最后的那条消息内容。 */
async function injectedContext(runtime: ReturnType<typeof createRuntime>): Promise<string> {
  const result = (await runtime.invoke('context', {
    messages: [{ role: 'user', content: 'hi' }]
  })) as { messages: Array<{ content: string }> }
  expect(result.messages).toHaveLength(2)
  return result.messages[1]!.content
}

describe('Plan 模式', () => {
  test('进入、退出按当前状态临时注入提醒，且不写会话记录', async () => {
    const runtime = createRuntime()

    // 非 Plan 模式也注入 Normal 提醒，且不写 session entry。
    expect(await injectedContext(runtime)).toBe(NORMAL_MODE_REMINDER)

    await runtime.command('')
    expect(await injectedContext(runtime)).toBe(PLAN_REMINDER)
    expect(runtime.planEvents).toEqual([true])
    expect(runtime.appendedEntries).toEqual([])

    await runtime.command('exit')
    expect(await injectedContext(runtime)).toBe(NORMAL_MODE_REMINDER)
    expect(runtime.planEvents).toEqual([true, false])
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
  })

  test('新运行时不恢复 Plan 状态', async () => {
    const runtime = createRuntime()
    await runtime.command('')
    await runtime.invoke('session_start', {}, runtime.ctx)

    expect(runtime.planEvents).toEqual([true, false])
    expect(await injectedContext(runtime)).toBe(NORMAL_MODE_REMINDER)
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

  test('status 查询不改状态，未知参数给出用法', async () => {
    const runtime = createRuntime()
    await runtime.command('')
    await runtime.command('status')
    expect(runtime.planEvents).toEqual([true])

    await runtime.command('bogus')
    expect(runtime.planEvents).toEqual([true])
    expect(runtime.notifications.at(-1)).toEqual({
      message: '用法：/plan、/plan exit、/plan status',
      level: 'error'
    })
  })
})
