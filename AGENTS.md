# AGENTS.md

pi 扩展：Plan 模式。进入后只允许读取与检查，`edit`/`write` 在工具调用层被拦截，只输出方案。

## 项目结构

- src/index.ts：`PLAN_MODE_EVENT`（事件通道 `pi-plan:mode`）+ 状态管理 `setPlanMode` +
  `Tab` 快捷键 + `/plan` 命令（`exit`/`status` 子命令与补全）+ `context` 事件注入提醒 +
  `tool_call` 拦截 edit/write + `session_start` 重置 + 两段提醒文案常量
- tests/plan.test.ts：最小 Pi API 替身下的状态、注入、拦截与工具列表不变性用例

## 常用命令

- pnpm check：tsc + eslint（必须全绿）
- pnpm test：vitest（必须全绿）
- pnpm format：prettier 写格式

## 行为要点

- 状态只在当前运行时内存中，不写 session entry，不持久化；reload / 新会话从关闭开始
- `edit`/`write` 保留在 active tools 与上下文中，只在 `tool_call` 层硬拦截：切换模式不重建
  system prompt，缓存前缀稳定；**不要**改成 `setActiveTools`
- 提醒走 `context` 事件追加到消息末尾，不写会话、不改 system prompt，与 provider 协议无关
- 只通过 `pi.events` 广播 `pi-plan:mode`（`{ enabled: boolean }`），不调用 `ctx.ui.setStatus`；
  footer / 编辑器徽章由订阅方（pi-kit 的 `editor-bg`）设置
- bash 未限制，靠提醒自律，不是沙箱
- 全局 Tab 会吞编辑器 Tab 补全（已知取舍）
