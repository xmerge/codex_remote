# 状态流转问题分析与修复方案

## 问题总结

### 问题 1：发送状态过早恢复
**位置**: `sendComposerMessage` finally 块 (行 718-724)

**问题**: API 调用返回后立即恢复 `isSending = false`，但 turn 可能还在进行中。

**影响**: 用户可以在 turn 进行中再次发送消息，导致状态混乱。

**修复**: 不应在 finally 中恢复状态，应在 `turn/completed` 事件中恢复。

---

### 问题 2：状态恢复有两个入口
**位置**:
- `sendComposerMessage.finally` (行 718-724)
- `turn/completed` 事件处理 (行 831-835)

**问题**: 两个地方都设置 `state.isSending = false`，可能导致状态不一致。

**修复**: 统一在 `turn/completed` 事件中恢复状态。

---

### 问题 3：activeTurnIdByThread 与 turns 状态不同步
**位置**:
- 乐观更新时设置临时 ID (行 665)
- API 返回后替换真实 ID (行 705)
- turn/completed 时删除 (行 830)

**问题**: 临时 ID 和真实 ID 的切换可能导致 activeTurnIdByThread 与实际 turns 数组不一致。

**修复**: 使用统一的 deriveActiveTurnId 函数获取活跃 turn，不依赖 activeTurnIdByThread。

---

### 问题 4：SSE 错误处理不完善
**位置**: `connectEvents` onerror 处理 (行 960-963)

**问题**: 没有主动重连机制，依赖浏览器自动重连可能失败。

**修复**: 添加指数退避重连机制。

---

## 修复方案

### 方案核心原则

1. **单一状态源**: 使用 `deriveActiveTurnId(thread)` 作为判断 turn 是否活跃的唯一依据
2. **状态恢复时机**: 只在 `turn/completed` 事件中恢复发送状态
3. **乐观更新清理**: 如果 API 失败，需要清理乐观更新的数据
4. **SSE 重连**: 添加可靠的重连机制

### 关键代码修改

#### 1. sendComposerMessage 修改

```javascript
async function sendComposerMessage(event) {
  event.preventDefault();

  // 检查是否有活跃的 turn
  const activeTurnId = deriveActiveTurnId(state.currentThread);
  if (activeTurnId && state.isSending) {
    // 有活跃 turn 且正在发送，不允许重复发送
    return;
  }

  const text = el.composerInput.value.trim();
  if (!text) return;

  // ... 现有的 thread 检查代码 ...

  state.isSending = true;
  el.sendMessageBtn.disabled = true;
  el.composerInput.disabled = true;
  el.sendMessageBtn.textContent = '发送中...';

  // 标记是否是新 turn（用于 finally 判断）
  const wasNewTurn = !activeTurnId;

  // ... 乐观更新代码 ...

  try {
    if (activeTurnId) {
      // Steer 现有 turn
      await api(...);
    } else {
      // 创建新 turn
      const result = await api(...);
      // 更新 turn ID
    }
  } catch (error) {
    // 清理乐观更新的数据
    cleanupOptimisticUpdate(thread.id, tempTurnId, tempMessageId);
    // 只有在错误时才恢复状态
    state.isSending = false;
    el.sendMessageBtn.disabled = false;
    el.composerInput.disabled = false;
    el.sendMessageBtn.textContent = '发送';
  }
  // 注意：没有 finally 块！状态在 turn/completed 中恢复
}
```

#### 2. turn/completed 事件处理修改

```javascript
case 'turn/completed': {
  const turn = msg.params?.turn;
  if (turn?.threadId && state.currentThread?.id === turn.threadId) {
    // ... 现有的 turn 更新代码 ...

    // 检查是否还有活跃的 turn
    const remainingActiveTurn = deriveActiveTurnId(state.currentThread);

    // 只有当没有活跃 turn 时才恢复发送状态
    if (!remainingActiveTurn) {
      state.isSending = false;
      el.sendMessageBtn.disabled = false;
      el.composerInput.disabled = false;
      el.sendMessageBtn.textContent = '发送';
    }

    renderConversation();
    refreshThreadFromServer(turn.threadId).catch(() => {});
  }
  break;
}
```

#### 3. SSE 重连机制

```javascript
function connectEvents() {
  let reconnectAttempts = 0;
  const maxReconnectDelay = 30000;

  const connect = () => {
    if (state.sse) {
      state.sse.close();
    }
    const source = new EventSource('/api/events');
    state.sse = source;

    source.onopen = () => {
      reconnectAttempts = 0;
      // 重连后刷新数据
      Promise.all([loadHealth(), loadThreads()]).catch(() => {});
    };

    source.onerror = () => {
      source.close();
      // 指数退避重连
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), maxReconnectDelay);
      reconnectAttempts++;
      setTimeout(connect, delay);
    };

    // ... 其他处理 ...
  };

  connect();
}
```
