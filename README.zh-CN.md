**简体中文** | [English](README.md)

# pi-plan

pi 扩展：Plan 模式。进入后只允许读取与检查，`edit`/`write` 在调用层被拦截，只输出方案。

## 用法

| 操作           | 作用                          |
| -------------- | ----------------------------- |
| `Tab`          | 切换 Plan 模式（进入 / 退出） |
| `/plan`        | 进入 Plan 模式                |
| `/plan exit`   | 退出 Plan 模式                |
| `/plan status` | 查看当前状态                  |

进入后每次请求都会临时追加一段提醒（`# Plan Mode - System Reminder`），退出后追加
`# Exited Plan Mode`。提醒只作用于当次请求，不写会话记录、不改 system prompt。

## 安装

从 git 仓库安装：

```bash
pi install git:github.com/poenl/pi-plan
```

临时试用（仅当前进程，不写 settings）：

```bash
pi -e git:github.com/poenl/pi-plan
```

## 工作原理

| 时机            | 动作                                          |
| --------------- | --------------------------------------------- |
| `Tab` / `/plan` | 切换运行时状态，通过事件广播给订阅方          |
| 每次 LLM 调用前 | `context` 事件在消息末尾临时追加当前模式提醒  |
| 工具调用        | `tool_call` 拦截 `edit`/`write`，返回拒绝原因 |
| 会话开始        | 状态重置为关闭，并广播一次                    |

设计取舍：

- **不改 active tools**：`edit`/`write` 的工具描述始终留在上下文里，只在执行层拦截。
  切换模式不会重建 system prompt，缓存前缀保持稳定。
- **只广播事件、不设 UI**：本扩展不调用 `ctx.ui.setStatus`；footer 与编辑器徽章由订阅方
  （如 pi-kit 的 `editor-bg`）订阅 `pi-plan:mode` 后自行设置。
- **状态不持久化**：reload 或新会话后从关闭状态开始。

## 已知边界

- **bash 未限制**：`bash` 仍可写文件，Plan 模式靠提示自律，不是强制沙箱。
- **Tab 被占用**：全局 Tab 会吞掉编辑器的 Tab 补全，这是已知取舍。
- **与其他扩展的联动**：订阅方订阅 `pi-plan:mode` 事件，负载为 `{ enabled: boolean }`。

## 开发

```bash
pnpm install
pnpm check   # tsc + eslint
pnpm test    # vitest
pnpm format  # prettier
```
