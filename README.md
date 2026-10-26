[简体中文](README.zh-CN.md) | **English**

# pi-plan

A pi extension: Plan mode. While active, only reading and inspection are allowed —
`edit`/`write` are blocked at the call layer, so the agent only outputs a plan.

## Usage

| Action         | Effect                          |
| -------------- | ------------------------------- |
| `Tab`          | Toggle Plan mode (enter / exit) |
| `/plan`        | Enter Plan mode                 |
| `/plan exit`   | Exit Plan mode                  |
| `/plan status` | Show current state              |

While active, each request gets a temporary reminder (`# Plan Mode - System Reminder`)
appended; after exiting it gets `# Exited Plan Mode`. The reminder applies to that one
request only: it is never written to the session and never touches the system prompt.

## Install

From git:

```bash
pi install git:github.com/poenl/pi-plan
```

Try it for one invocation (nothing written to settings):

```bash
pi -e git:github.com/poenl/pi-plan
```

## How it works

| When                 | Action                                                            |
| -------------------- | ----------------------------------------------------------------- |
| `Tab` / `/plan`      | Toggle runtime state, broadcast it to subscribers                 |
| Before each LLM call | `context` event appends the current mode reminder to the messages |
| Tool call            | `tool_call` blocks `edit`/`write` and returns the reason          |
| Session start        | Reset state to off and broadcast once                             |

Design choices:

- **Active tools stay untouched**: `edit`/`write` descriptions remain in context and are
  blocked only at execution time, so toggling never rebuilds the system prompt and the
  cache prefix stays stable.
- **Events only, no UI**: this extension never calls `ctx.ui.setStatus`; footer and editor
  badges are set by subscribers (e.g. pi-kit's `editor-bg`) listening on `pi-plan:mode`.
- **State is not persisted**: it starts off after a reload or in a new session.

## Known limits

- **`bash` is not restricted**: `bash` can still write files. Plan mode relies on the
  reminder, it is not a sandbox.
- **Tab is taken**: the global Tab swallows the editor's Tab completion. Known tradeoff.
- **Interop**: subscribers listen on `pi-plan:mode` with payload `{ enabled: boolean }`.

## Development

```bash
pnpm install
pnpm check   # tsc + eslint
pnpm test    # vitest
pnpm format  # prettier
```
