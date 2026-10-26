import type { AutocompleteItem } from '@earendil-works/pi-tui'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

/**
 * pi-plan — Plan 模式扩展：只读规划，禁止 edit/write 落地。
 *
 * - 进入/退出：/plan（进入）、/plan exit（退出）、/plan status（状态），或 Tab 快捷键切换
 * - 状态只由本扩展在当前运行时管理，不写入会话记录；reload/新会话后从关闭状态开始
 * - active tools 列表保持不变，避免重建 system prompt，保持工具描述与缓存前缀稳定
 * - context 在每次 LLM 调用前临时注入当前模式提醒（provider 无关，追加到消息末尾），不写会话记录、不改 system prompt
 * - 只通过 pi.events 广播状态，不写任何 UI：footer 状态与编辑器徽章由订阅方自行设置
 * - bash 未限制（用户确认，靠提示自律）
 * - 已知 tradeoff：全局 Tab 会吞编辑器 Tab 补全
 */

/**
 * Plan 运行时状态事件通道。独立包自带常量，不依赖任何宿主包的内部模块；
 * 订阅方（如 pi-kit 的 editor-bg）按同一字符串订阅即可同步显示。
 */
export const PLAN_MODE_EVENT = 'pi-plan:mode'

/** 事件负载：只描述 Plan 是否激活，真实状态由本扩展持有。 */
export type PlanModeEvent = { enabled: boolean }

export default function (pi: ExtensionAPI) {
  /** 当前运行时 Plan 状态；对外只通过事件暴露给订阅方作为显示镜像。 */
  let planActive = false

  /** 设置 Plan 状态；不写 session entry、不碰 UI，只发布事件让订阅方刷新显示。 */
  function setPlanMode(enabled: boolean): boolean {
    if (planActive === enabled) return false
    planActive = enabled
    pi.events.emit(PLAN_MODE_EVENT, { enabled: planActive } satisfies PlanModeEvent)
    return true
  }

  pi.registerShortcut('tab', {
    description: '切换 Plan 模式（进入时拦截 edit/write）',
    handler: async (ctx) => {
      const changed = setPlanMode(!planActive)
      if (changed) {
        ctx.ui.notify(planActive ? 'Plan 模式已进入' : 'Plan 模式已退出', 'info')
      }
    }
  })

  pi.registerCommand('plan', {
    description: '进入、退出或查看 Plan 模式状态',
    // 仅为已支持的子命令提供补全，避免把未知参数当成状态切换。
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const items: AutocompleteItem[] = [
        { value: 'exit', label: 'exit' },
        { value: 'status', label: 'status' }
      ]
      const matches = items.filter((item) => item.value.startsWith(prefix))
      return matches.length > 0 ? matches : null
    },
    handler: async (args, ctx) => {
      const command = args.trim()
      if (command === 'status') {
        ctx.ui.notify(planActive ? 'Plan 模式：已激活' : 'Plan 模式：未激活', 'info')
        return
      }
      if (command === 'exit') {
        const changed = setPlanMode(false)
        ctx.ui.notify(changed ? 'Plan 模式已退出' : 'Plan 模式本来就是关闭的', 'info')
        return
      }
      if (command === '') {
        const changed = setPlanMode(true)
        ctx.ui.notify(changed ? 'Plan 模式已进入' : 'Plan 模式已经开启', 'info')
        return
      }
      ctx.ui.notify('用法：/plan、/plan exit、/plan status', 'error')
    }
  })

  // 每次 LLM 调用前按当前状态追加一条临时提醒：context 与 provider 协议无关，
  // Pi 在请求结束后恢复原 transcript，因此不写会话、不碰 system prompt（缓存前缀不变），
  // 请求进行中切换状态对下一条请求即刻生效。
  pi.on('context', (event) => ({
    messages: [
      ...event.messages,
      {
        role: 'user',
        content: planActive ? PLAN_REMINDER : NORMAL_MODE_REMINDER,
        timestamp: Date.now()
      }
    ]
  }))

  // 工具描述保留在上下文中，仅在执行层硬拦截，覆盖请求进行中发生的状态切换。
  pi.on('tool_call', (event) => {
    if (!planActive) return
    if (event.toolName !== 'edit' && event.toolName !== 'write') return
    return {
      block: true,
      reason: 'Plan 模式：请勿调用 edit/write，仅输出计划。'
    }
  })

  // 新运行时不从会话恢复 Plan；直接置为关闭并广播给订阅方 UI。
  pi.on('session_start', () => {
    planActive = false
    pi.events.emit(PLAN_MODE_EVENT, { enabled: false } satisfies PlanModeEvent)
  })
}

/** Plan 激活时注入的提醒（openode plan.txt 同款思路）。 */
export const PLAN_REMINDER = `<system-reminder>
# Plan Mode - System Reminder

Prohibit any file/system modifications; only allow read/inspection. And since the user currently does not require execution, you must not make any edits or changes.

---

## Important

This constraint is absolutely prioritized, with zero exceptions.
</system-reminder>`

/** 非 Plan 模式每次请求临时注入的提醒，不写入模型历史。 */
export const NORMAL_MODE_REMINDER = `<system-reminder>
# Exited Plan Mode

You have exited plan mode. You can now make edits, run tools, and take actions.
</system-reminder>`
