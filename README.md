# Codex Remote Web MVP

一个尽量轻量、但已经可用的 **Codex 网页远程客户端**：

- 会话列表：`thread/list`
- 新建会话：`thread/start`
- 恢复会话：`thread/resume`
- 对话：`turn/start`
- 活动 turn 追加输入：`turn/steer`
- 中断：`turn/interrupt`
- 流式文本：`item/agentMessage/delta`
- 命令输出：`item/commandExecution/outputDelta`
- 审批：`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`
- Diff 预览：`turn/diff/updated` + `fileChange.changes[].diff`

## 架构

网页并不直接连接 `codex app-server`。

更稳的链路是：

```text
Browser UI
  ├─ HTTP actions (new thread / send message / approve / interrupt)
  └─ SSE stream (live notifications)

Local daemon (server.js)
  ├─ JSON-RPC over stdio
  ├─ spawns `codex app-server`
  ├─ forwards app-server notifications to browser
  └─ responds to server-initiated approval requests

Codex app-server
```

这样做的好处：

- 不依赖实验性的浏览器直连 WebSocket transport
- 容易做统一鉴权、日志、重连和多前端广播
- 审批请求由本地 daemon 回包，和官方 rich-client 模式更接近

## 为什么这条路能实现

OpenAI 官方把 `codex app-server` 定义成 rich client 的标准接口，支持 conversation history、approvals 和 streamed agent events；推荐本地/IDE 客户端通过长驻子进程 + stdio JSON-RPC 来连接。官方还列出了 `thread/start`、`thread/resume`、`thread/list`、`thread/read`、`turn/start`、`turn/steer`、`turn/interrupt` 以及 `item/agentMessage/delta`、`item/commandExecution/outputDelta`、`turn/diff/updated`、审批请求等事件。citeturn740930view0turn656763view1turn656763view2turn656763view4turn208962view5turn206412view0

官方还说明，Codex Web 本身就是“服务端 worker 保持 app-server 的 source of truth，浏览器通过 HTTP + SSE 看事件流”的架构；网页标签并不适合作为长任务的状态源。这个 MVP 正是沿着这条模式做的本地版。citeturn740930view2

## 目录

```text
codex-remote-web-mvp/
  server.js          # 本地 daemon / bridge
  package.json
  README.md
  public/
    index.html
    styles.css
    app.js
```

## 运行方式

### 真实连接 Codex

前提：本机已安装并可运行 `codex`。

```bash
cd codex-remote-web-mvp
npm start
```

默认会执行：

```bash
codex app-server
```

如果真实连接启动失败，服务现在会继续启动，但 `/api/health` 会保持 `real/error` 状态并在前端显示常驻告警；只有显式设置 `ALLOW_MOCK_FALLBACK=1` 时，才会退回到 `mock-fallback`。

如果需要自定义命令：

```bash
APP_SERVER_CMD=/path/to/codex APP_SERVER_ARGS="app-server" npm start
```

然后打开：

```text
http://localhost:8788
```

### Mock 模式（无 Codex 时先看 UI）

```bash
cd codex-remote-web-mvp
npm run start:mock
```

Mock 模式会模拟：

- 一个示例会话
- 新建会话
- turn 流式文本
- 命令审批
- 命令输出流
- 文件改动审批
- diff 预览

## 已实现的核心交互

### 1. 会话列表

- 左侧展示 `thread/list` 结果
- 支持点击打开 `thread/read`
- 新建/恢复后会自动刷新

### 2. 对话

- 空闲线程走 `turn/start`
- 活动线程自动走 `turn/steer`
- 支持 `turn/interrupt`

### 3. 流式输出

- assistant 文本通过 `item/agentMessage/delta` 累加
- 命令输出通过 `item/commandExecution/outputDelta` 累加
- 文件改动输出通过 `item/fileChange/outputDelta` 累加

### 4. 审批

- 后端能接住 server-initiated JSON-RPC request
- 前端弹出审批卡片
- 点击 Accept / Accept for session / Decline / Cancel 后，后端用同一个 request id 回包

### 5. Diff

- 优先展示 `turn/diff/updated`
- 如果 turn 级 diff 没到，也会回退展示 `fileChange.changes[].diff`

## 局限与建议

### 1. 这是“网页客户端”，不是“完全复刻 Codex.app GUI”

它能复刻大部分核心交互体验，但不会自然继承桌面 GUI 的所有本地状态和每一个 UI 细节。

### 2. 最好把这个网页当作主控客户端

OpenAI 最近一个公开 issue 提到，多客户端同时附着到同一 thread 时，某些 TUI 客户端对“另一个客户端发起的 live turn”刷新并不完整：上下文是共享的，但活跃中的可视进度可能不会完全刷新出来。也就是说，**协议本身能共享 thread，上层 UI 的多端 live 同步仍可能有边角差异**。citeturn469889search6

### 3. 真实部署要补安全层

这个 MVP 主要解决协议和 UI。真正远程发布到公网时，建议至少补：

- 登录鉴权
- HTTPS / 反向代理
- 请求审计
- 细粒度权限控制
- 单会话写入锁（避免多端同时 steer / approve）

## 推荐下一步

如果你继续迭代，我建议按这个顺序补强：

1. 登录与设备配对
2. 单写多读的并发控制
3. 更完整的 turn 历史重建
4. 文件树 / cwd 切换
5. review/start 和更好的 diff UI
6. 移动端布局优化
7. 推送通知

## 备注

为了尽量减少环境门槛，这个 MVP 没有用任何第三方 NPM 依赖：

- 后端：Node.js 标准库（`http`、`child_process`、`readline`）
- 前端：原生 HTML/CSS/JS

所以拿到就能跑，适合先验证交互链路，再决定是否迁移到 React/Next.js 或更复杂的状态管理。
