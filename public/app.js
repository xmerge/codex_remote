const state = {
  health: null,
  threads: [],
  threadMap: new Map(),
  activeThreadId: null,
  currentThread: null,
  pendingApprovals: new Map(),
  rawEvents: [],
  latestDiffByTurn: new Map(),
  activeTurnIdByThread: new Map(),
  sse: null,
  isSending: false,
  isLoading: false,
  utilityTab: 'approvals',
  utilityTrayOpen: false,
};

const el = {};

function qs(id) {
  return document.getElementById(id);
}

function fmtTime(epochSeconds) {
  if (!epochSeconds) return '—';
  try {
    return new Date(epochSeconds * 1000).toLocaleString();
  } catch {
    return '—';
  }
}

function fmtCompactTime(epochSeconds) {
  if (!epochSeconds) return '—';
  try {
    return new Date(epochSeconds * 1000).toLocaleString([], {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

function shortId(value, size = 8) {
  return value ? String(value).slice(0, size) : '—';
}

function previewText(value, limit = 140) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function normalizeApprovalPolicy(value) {
  const mapping = {
    unlessTrusted: 'untrusted',
    onRequest: 'on-request',
  };
  return mapping[value] || value || 'untrusted';
}

function isImageLikePart(part) {
  const source = part?.url || part?.image_url || part?.path || '';
  return part?.type === 'image' || /^data:image\//.test(source) || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(source);
}

function renderContentPart(part) {
  if (!part) return '';

  if (part.type === 'text') {
    return `<div class="markdownish">${escapeHtml(part.text || '')}</div>`;
  }

  if (isImageLikePart(part)) {
    const source = part.url || part.image_url || part.path || '';
    const label = part.filename || part.name || '图片附件';
    if (!source) {
      return `
        <div class="attachment-card">
          <div class="attachment-meta">${escapeHtml(label)}</div>
        </div>
      `;
    }
    return `
      <figure class="attachment-card image-attachment">
        <img src="${escapeHtml(source)}" alt="${escapeHtml(label)}" loading="lazy" />
        <figcaption class="attachment-meta">${escapeHtml(label)}</figcaption>
      </figure>
    `;
  }

  const label = [part.type || '附件', part.mimeType || part.mediaType || '', part.filename || part.name || '']
    .filter(Boolean)
    .join(' · ');
  return `
    <div class="attachment-card">
      <div class="attachment-meta">${escapeHtml(label || '附件')}</div>
    </div>
  `;
}

function renderUserContent(parts = []) {
  return parts.map(renderContentPart).join('');
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function api(path, options = {}) {
  const { signal, ...restOptions } = options;
  const response = await fetch(path, {
    ...restOptions,
    signal,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(payload.error || response.statusText);
  }
  return payload;
}

let bannerTimeout = null;

function setBanner(message, kind = 'info') {
  el.statusBanner.textContent = message;
  el.statusBanner.className = `status-banner ${kind === 'error' ? 'error' : ''}`.trim();

  if (bannerTimeout) {
    clearTimeout(bannerTimeout);
  }
  bannerTimeout = setTimeout(() => {
    if (el.statusBanner.textContent === message) {
      el.statusBanner.textContent = '';
      el.statusBanner.className = 'status-banner';
    }
  }, 5000);
}

function addRawEvent(label, data) {
  state.rawEvents.unshift({ label, at: new Date().toLocaleTimeString(), data });
  state.rawEvents = state.rawEvents.slice(0, 80);
  renderEventLog();
}

function renderUtilityTray() {
  if (!el.utilityTray) return;
  el.utilityTray.classList.toggle('is-collapsed', !state.utilityTrayOpen);
  if (el.toggleUtilityBtn) {
    el.toggleUtilityBtn.textContent = state.utilityTrayOpen ? '收起工具栏' : '展开工具栏';
  }

  const tabs = ['approvals', 'diff', 'events'];
  for (const tab of tabs) {
    const button = el[`utilityTab${tab[0].toUpperCase()}${tab.slice(1)}`];
    const panel = el[`utilityPanel${tab[0].toUpperCase()}${tab.slice(1)}`];
    if (button) button.classList.toggle('active', state.utilityTab === tab);
    if (panel) panel.classList.toggle('is-active', state.utilityTab === tab);
  }
}

function setUtilityTab(tab) {
  state.utilityTab = tab;
  renderUtilityTray();
}

function setUtilityTrayOpen(open) {
  state.utilityTrayOpen = open;
  renderUtilityTray();
}

function renderHealth() {
  const health = state.health;
  if (!health) {
    el.healthPanel.innerHTML = '';
    return;
  }

  const tiles = [
    ['模式', health.mode || 'unknown'],
    ['状态', health.status || 'unknown'],
    ['PID', health.pid || '—'],
    ['初始化', health.initialized ? 'yes' : 'no'],
  ];

  el.healthPanel.innerHTML = tiles
    .map(
      ([label, value]) => `
        <div class="health-tile">
          <span class="label">${escapeHtml(label)}</span>
          <span class="value">${escapeHtml(String(value))}</span>
        </div>
      `,
    )
    .join('');

  const lastError = health.lastError ? ` · ${health.lastError}` : '';
  const fallback = health.fallbackReason ? ` · fallback: ${health.fallbackReason}` : '';
  setBanner(`模式 ${health.mode || 'unknown'}，状态 ${health.status || 'unknown'}${lastError}${fallback}`, health.lastError ? 'error' : 'info');
}

function deriveThreadTitle(thread) {
  return thread?.name || thread?.preview || thread?.id || '未命名会话';
}

function deriveActiveTurnId(thread) {
  if (!thread?.turns?.length) return null;
  const active = [...thread.turns].reverse().find((turn) => turn.status === 'inProgress');
  return active?.id || null;
}

function upsertThread(thread) {
  if (!thread?.id) return;
  const existing = state.threadMap.get(thread.id) || {};
  const merged = { ...existing, ...thread };
  state.threadMap.set(thread.id, merged);
}

function syncThreadsFromList(threads) {
  state.threads = threads || [];
  for (const thread of state.threads) {
    upsertThread(thread);
  }
  renderThreadList();
}

function renderThreadList() {
  const list = state.threads;
  if (!list.length) {
    el.threadList.innerHTML = '<div class="muted">还没有会话。</div>';
    return;
  }

  const template = qs('threadItemTemplate');
  el.threadList.innerHTML = '';
  for (const thread of list) {
    const fragment = template.content.cloneNode(true);
    const button = fragment.querySelector('.thread-item');
    button.dataset.threadId = thread.id;
    button.classList.toggle('active', thread.id === state.activeThreadId);
    fragment.querySelector('.thread-item-title').textContent = deriveThreadTitle(thread);
    fragment.querySelector('.thread-item-preview').textContent = thread.preview || '暂无预览';
    const status = thread.status?.type || 'unknown';
    fragment.querySelector('.thread-item-meta').textContent = `${fmtCompactTime(thread.updatedAt)} · ${status}`;
    el.threadList.appendChild(fragment);
  }
}

function renderActiveThreadHeader() {
  const thread = state.currentThread;
  const activeTurnId = deriveActiveTurnId(thread);
  if (!thread) {
    el.activeThreadTitle.textContent = '未选择会话';
    el.activeThreadMeta.textContent = '先从左侧选一个会话，或新建一个。';
    el.resumeThreadBtn.disabled = true;
    el.reloadThreadBtn.disabled = true;
    el.interruptTurnBtn.disabled = true;
    el.sendMessageBtn.disabled = true;
    el.sendMessageBtn.textContent = '发送';
    return;
  }

  const status = thread.status?.type || 'unknown';
  el.activeThreadTitle.textContent = deriveThreadTitle(thread);
  el.activeThreadMeta.textContent = `${status} · 更新于 ${fmtTime(thread.updatedAt)} · 线程 ${shortId(thread.id)}`;
  el.resumeThreadBtn.disabled = false;
  el.reloadThreadBtn.disabled = false;

  // 中断按钮：有活跃 turn 时可用
  el.interruptTurnBtn.disabled = !activeTurnId;

  // 发送按钮：根据发送状态决定
  if (state.isSending) {
    el.sendMessageBtn.disabled = true;
    el.sendMessageBtn.textContent = activeTurnId ? '发送中...' : '创建中...';
  } else {
    el.sendMessageBtn.disabled = false;
    el.sendMessageBtn.textContent = '发送';
  }

  // 输入框状态：发送中禁用
  el.composerInput.disabled = state.isSending;
}

function renderItem(item) {
  if (!item) return '';
  const type = item.type || 'unknown';

  if (type === 'userMessage') {
    return `
      <article class="message-card user">
        <div class="message-head">
          <div class="message-role">用户</div>
          <div class="message-meta">${escapeHtml(shortId(item.id))}</div>
        </div>
        <div class="message-body">${renderUserContent(item.content || []) || '<div class="markdownish muted">空消息</div>'}</div>
      </article>
    `;
  }

  if (type === 'agentMessage') {
    return `
      <article class="message-card agent">
        <div class="message-head">
          <div class="message-role">Codex</div>
          <div class="message-meta">${escapeHtml(item.phase || '')}</div>
        </div>
        <div class="markdownish">${escapeHtml(item.text || '')}</div>
      </article>
    `;
  }

  if (type === 'commandExecution') {
    const command = Array.isArray(item.command) ? item.command.join(' ') : item.command || '';
    const output = item.aggregatedOutput || '';
    return `
      <article class="message-card command">
        <div class="message-head">
          <div class="message-role">命令</div>
          <div class="message-meta">${escapeHtml(item.status || '')}${item.exitCode !== undefined ? ` · exit ${escapeHtml(String(item.exitCode))}` : ''}</div>
        </div>
        <div class="markdownish">${escapeHtml(command || '(无命令内容)')}</div>
        <div class="inline-note">cwd: ${escapeHtml(item.cwd || '—')}</div>
        <details class="inline-details">
          <summary>查看输出</summary>
          <pre class="code-block">${escapeHtml(output) || '(暂无输出)'}</pre>
        </details>
      </article>
    `;
  }

  if (type === 'fileChange') {
    const changes = (item.changes || [])
      .map(
        (change) => `
          <div class="diff-change">
            <div class="diff-path">${escapeHtml(change.path || '')} · ${escapeHtml(change.kind || '')}</div>
            <pre class="code-block">${escapeHtml(change.diff || '') || '(无 diff)'}</pre>
          </div>
        `,
      )
      .join('');
    return `
      <article class="message-card diff">
        <div class="message-head">
          <div class="message-role">文件改动</div>
          <div class="message-meta">${escapeHtml(item.status || '')}</div>
        </div>
        <details class="inline-details">
          <summary>查看变更明细</summary>
          <div class="change-list">${changes || '<div class="muted">无改动内容</div>'}</div>
        </details>
      </article>
    `;
  }

  return `
    <article class="message-card">
      <div class="message-head">
        <div class="message-role">${escapeHtml(type)}</div>
        <div class="message-meta">${escapeHtml(shortId(item.id))}</div>
      </div>
      <details class="inline-details">
        <summary>查看原始数据</summary>
        <pre class="code-block">${escapeHtml(JSON.stringify(item, null, 2))}</pre>
      </details>
    </article>
  `;
}

function renderConversation() {
  const thread = state.currentThread;
  renderActiveThreadHeader();

  if (!thread) {
    el.conversationFeed.innerHTML = '<div class="empty-state">还没有打开的会话</div>';
    renderDiffPreview();
    renderApprovals();
    return;
  }

  const turns = thread.turns || [];
  if (!turns.length) {
    el.conversationFeed.innerHTML = '<div class="empty-state">这个会话还没有 turn，发一条消息试试。</div>';
    renderDiffPreview();
    renderApprovals();
    return;
  }

  el.conversationFeed.innerHTML = turns
    .map((turn) => {
      const statusClass = escapeHtml(turn.status || 'unknown');
      const items = (turn.items || []).map(renderItem).join('');
      return `
        <section class="turn-block" data-turn-id="${escapeHtml(turn.id || '')}">
          <div class="turn-header">
            <div class="turn-title">
              <strong>Turn ${escapeHtml(shortId(turn.id))}</strong>
              <span>${escapeHtml(turn.threadId === thread.id ? '当前线程' : shortId(turn.threadId || ''))}</span>
            </div>
            <span class="turn-status ${statusClass}">${escapeHtml(turn.status || 'unknown')}</span>
          </div>
          <div class="message-list">${items || '<div class="muted">暂无内容</div>'}</div>
        </section>
      `;
    })
    .join('');

  el.conversationFeed.scrollTop = el.conversationFeed.scrollHeight;
  renderDiffPreview();
  renderApprovals();
}

function renderApprovals() {
  const activeThreadId = state.activeThreadId;
  const approvals = [...state.pendingApprovals.values()].filter((entry) => !activeThreadId || entry.params?.threadId === activeThreadId);
  el.approvalCount.textContent = String(approvals.length);
  if (approvals.length) {
    state.utilityTrayOpen = true;
    state.utilityTab = 'approvals';
    renderUtilityTray();
  }

  if (!approvals.length) {
    el.approvalList.innerHTML = '<div class="muted">当前没有待处理审批。</div>';
    return;
  }

  el.approvalList.innerHTML = approvals
    .map((entry) => {
      const command = Array.isArray(entry.params?.command) ? entry.params.command.join(' ') : '';
      const reason = entry.params?.reason || (entry.method.includes('fileChange') ? '文件改动需要确认。' : '命令执行需要确认。');
      const available = entry.params?.availableDecisions || ['accept', 'acceptForSession', 'decline', 'cancel'];
      const buttons = available
        .filter((value) => ['accept', 'acceptForSession', 'decline', 'cancel'].includes(typeof value === 'string' ? value : ''))
        .map((value) => {
          const label = {
            accept: '接受',
            acceptForSession: '本会话都接受',
            decline: '拒绝',
            cancel: '取消',
          }[value] || value;
          const klass = value === 'decline' || value === 'cancel' ? 'danger' : 'ghost';
          return `<button data-request-id="${escapeHtml(entry.requestId)}" data-decision="${escapeHtml(value)}" class="${klass}">${escapeHtml(label)}</button>`;
        })
        .join('');
      return `
        <div class="approval-card">
          <div class="approval-head">
            <div class="approval-title">${escapeHtml(entry.method)}</div>
            <div class="approval-meta">${escapeHtml(shortId(entry.requestId))}</div>
          </div>
          <div class="approval-body">${escapeHtml(reason)}</div>
          ${command ? `<pre class="code-block">${escapeHtml(command)}</pre>` : ''}
          ${entry.params?.cwd ? `<div class="approval-meta">cwd: ${escapeHtml(entry.params.cwd)}</div>` : ''}
          <div class="approval-actions">${buttons}</div>
        </div>
      `;
    })
    .join('');
}

function renderDiffPreview() {
  const thread = state.currentThread;
  if (!thread) {
    el.diffMeta.textContent = '无';
    el.diffPreview.textContent = '暂无 diff';
    return;
  }

  let latestTurn = null;
  let latestDiff = '';
  const turns = [...(thread.turns || [])].reverse();
  for (const turn of turns) {
    const turnDiff = state.latestDiffByTurn.get(turn.id);
    if (turnDiff) {
      latestTurn = turn;
      latestDiff = turnDiff;
      break;
    }
    const fileChange = (turn.items || []).find((item) => item.type === 'fileChange' && item.changes?.length);
    if (fileChange) {
      latestTurn = turn;
      latestDiff = fileChange.changes.map((change) => `# ${change.path}\n${change.diff || ''}`).join('\n\n');
      break;
    }
  }

  if (!latestTurn || !latestDiff) {
    el.diffMeta.textContent = '无';
    el.diffPreview.textContent = '暂无 diff';
    return;
  }

  el.diffMeta.textContent = `Turn ${shortId(latestTurn.id)}`;
  el.diffPreview.textContent = latestDiff;
}

function renderEventLog() {
  if (!state.rawEvents.length) {
    el.eventLog.innerHTML = '<div class="muted">暂无事件。</div>';
    return;
  }

  el.eventLog.innerHTML = state.rawEvents
    .map(
      (entry) => `
        <details class="event-entry">
          <summary>
            <div class="event-summary">
              <span class="event-label">${escapeHtml(entry.label)}</span>
              <span>${escapeHtml(entry.at)} · ${escapeHtml(previewText(entry.data, 72))}</span>
            </div>
          </summary>
          <pre class="code-block">${escapeHtml(typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data, null, 2))}</pre>
        </details>
      `,
    )
    .join('');
}

async function loadHealth() {
  state.health = await api('/api/health');
  renderHealth();
}

async function loadPendingApprovals() {
  const result = await api('/api/approvals/pending');
  state.pendingApprovals.clear();
  for (const entry of result.data || []) {
    state.pendingApprovals.set(String(entry.requestId), entry);
  }
  renderApprovals();
}

async function loadThreads() {
  state.isLoading = true;
  el.threadList.innerHTML = '<div class="muted">加载中...</div>';
  try {
    const result = await api('/api/threads?limit=50&sortKey=updated_at');
    syncThreadsFromList(result.data || []);
    if (!state.activeThreadId && state.threads.length) {
      await openThread(state.threads[0].id, { silent: true });
    }
  } finally {
    state.isLoading = false;
  }
}

async function refreshThreadFromServer(threadId) {
  const result = await api(`/api/threads/${encodeURIComponent(threadId)}`);
  upsertThread(result.thread);
  if (state.activeThreadId === threadId) {
    state.currentThread = result.thread;
    state.activeTurnIdByThread.set(threadId, deriveActiveTurnId(result.thread));
    renderConversation();
  } else {
    renderThreadList();
  }
  return result.thread;
}

async function openThread(threadId, { silent = false } = {}) {
  state.activeThreadId = threadId;
  renderThreadList();
  const thread = await refreshThreadFromServer(threadId);
  if (!silent) {
    setBanner(`已打开 ${deriveThreadTitle(thread)}`);
  }
}

function ensureCurrentThread() {
  if (!state.currentThread?.id) {
    throw new Error('请先选择或创建一个会话');
  }
  return state.currentThread;
}

async function createThreadFromForm() {
  const cwd = el.newThreadCwd.value.trim();
  const model = el.newThreadModel.value.trim() || 'gpt-5.4';
  const approvalPolicy = normalizeApprovalPolicy(el.newThreadApprovalPolicy.value);
  const sandboxType = el.newThreadSandboxType.value;
  const sandboxPolicy = sandboxType === 'workspaceWrite'
    ? { type: 'workspaceWrite', writableRoots: cwd ? [cwd] : [], networkAccess: true }
    : { type: sandboxType };

  el.newThreadBtn.disabled = true;
  el.newThreadBtn.textContent = '创建中...';
  state.isLoading = true;
  try {
    const result = await api('/api/threads', {
      method: 'POST',
      body: JSON.stringify({ model, cwd: cwd || undefined, approvalPolicy, sandboxPolicy }),
    });
    await loadThreads();
    await openThread(result.thread.id);
  } finally {
    el.newThreadBtn.disabled = false;
    el.newThreadBtn.textContent = '新建会话';
    state.isLoading = false;
  }
}

async function ensureThreadReadyForTurn(thread) {
  const status = thread?.status?.type || thread?.status || 'unknown';
  if (status !== 'notLoaded') {
    return thread;
  }

  await api(`/api/threads/${encodeURIComponent(thread.id)}/resume`, {
    method: 'POST',
    body: '{}',
  });
  const result = await api(`/api/threads/${encodeURIComponent(thread.id)}`);
  state.currentThread = result.thread;
  upsertThread(result.thread);
  renderConversation();
  return result.thread;
}

// 兜底超时 ID，用于在 turn/completed 未收到时恢复状态
let fallbackTimeoutId = null;

async function sendComposerMessage(event) {
  event.preventDefault();

  // 检查是否有活跃的 turn（正在进行中的 turn）
  const currentActiveTurnId = deriveActiveTurnId(state.currentThread);

  // 防止重复发送：如果有活跃 turn 且正在发送，不允许
  if (state.isSending && currentActiveTurnId) {
    return;
  }

  const text = el.composerInput.value.trim();
  if (!text) return;

  let thread;
  try {
    thread = ensureCurrentThread();
  } catch (error) {
    setBanner(error.message, 'error');
    return;
  }

  try {
    thread = await ensureThreadReadyForTurn(thread);
  } catch (error) {
    setBanner(`恢复线程失败：${error.message}`, 'error');
    return;
  }

  // 再次获取活跃 turn（确保线程准备好后状态正确）
  const activeTurnId = deriveActiveTurnId(thread);

  // 乐观更新：先创建用户消息并渲染
  const tempMessageId = `temp-user-${Date.now()}`;
  const userMessage = {
    id: tempMessageId,
    type: 'userMessage',
    content: [{ type: 'text', text }],
  };

  // 记录是否是新 turn（用于后续判断）
  let tempTurnId = null;
  let isNewTurn = !activeTurnId;

  if (activeTurnId) {
    // Steer 现有 turn：直接添加到现有 turn
    mergeItemIntoTurn(thread.id, activeTurnId, userMessage);
    renderConversation();
  } else {
    // 新 turn：先创建临时 turn
    tempTurnId = `temp-turn-${Date.now()}`;
    const turns = state.currentThread?.turns || (state.currentThread.turns = []);
    turns.push({ id: tempTurnId, threadId: thread.id, status: 'inProgress', items: [userMessage] });
    renderConversation();
  }

  // 清空输入框
  el.composerInput.value = '';

  // 设置发送状态（不再在 finally 中恢复，而是在 turn/completed 中恢复）
  state.isSending = true;
  el.sendMessageBtn.disabled = true;
  el.composerInput.disabled = true;
  el.sendMessageBtn.textContent = isNewTurn ? '创建中...' : '发送中...';

  // 记录当前发送的线程 ID，用于兜底恢复
  const sendingThreadId = thread.id;

  // 清除之前的兜底超时（如果有）
  if (fallbackTimeoutId) {
    clearTimeout(fallbackTimeoutId);
  }

  // API 超时控制：60秒
  const controller = new AbortController();
  const apiTimeoutId = setTimeout(() => {
    controller.abort();
  }, 60000);

  // 兜底超时：5分钟后强制恢复状态（防止 turn/completed 事件丢失）
  fallbackTimeoutId = setTimeout(() => {
    if (state.isSending) {
      console.warn('[兜底超时] 5分钟未收到 turn/completed，强制恢复状态');
      cleanupSendState();
      setBanner('等待超时，状态已恢复。如需查看结果请刷新。', 'error');
      // 刷新线程数据
      if (state.currentThread?.id === sendingThreadId) {
        refreshThreadFromServer(sendingThreadId).catch(() => {});
      }
    }
  }, 5 * 60 * 1000);

  try {
    if (activeTurnId) {
      await api(`/api/threads/${encodeURIComponent(thread.id)}/turns/${encodeURIComponent(activeTurnId)}/steer`, {
        method: 'POST',
        body: JSON.stringify({ text }),
        signal: controller.signal,
      });
      addRawEvent('turn.steer', { threadId: thread.id, turnId: activeTurnId, text });
      // steer 成功后，不恢复状态，等待 turn/completed 事件
    } else {
      const result = await api(`/api/threads/${encodeURIComponent(thread.id)}/turns`, {
        method: 'POST',
        body: JSON.stringify({ text }),
        signal: controller.signal,
      });
      const newTurnId = result?.turn?.id;
      if (newTurnId) {
        // 用真实 turn ID 替换临时 ID
        const turns = state.currentThread?.turns || [];
        const tempTurn = turns.find((t) => t.id === tempTurnId);
        if (tempTurn) {
          tempTurn.id = newTurnId;
          state.activeTurnIdByThread.set(thread.id, newTurnId);
          renderConversation();
        }
      }
      addRawEvent('turn.start', { threadId: thread.id, text });
      // 新 turn 创建成功，不恢复状态，等待 turn/completed 事件
    }
    clearTimeout(apiTimeoutId);
  } catch (error) {
    clearTimeout(apiTimeoutId);
    if (error.name === 'AbortError') {
      setBanner('请求超时，请稍后刷新查看结果', 'error');
    } else {
      setBanner(`发送失败：${error.message}`, 'error');
      // 发送失败时清理乐观更新的数据
      if (isNewTurn && tempTurnId) {
        cleanupOptimisticTurn(thread.id, tempTurnId);
      } else if (activeTurnId) {
        cleanupOptimisticMessage(thread.id, activeTurnId, tempMessageId);
      }
    }
    // 发送失败时恢复状态并清除兜底超时
    if (fallbackTimeoutId) {
      clearTimeout(fallbackTimeoutId);
      fallbackTimeoutId = null;
    }
    cleanupSendState();
  }
  // 注意：成功时不在 finally 中恢复状态，状态在 turn/completed 中恢复
}

/**
 * 清理发送状态
 */
function cleanupSendState() {
  state.isSending = false;
  el.sendMessageBtn.disabled = false;
  el.composerInput.disabled = false;
  el.sendMessageBtn.textContent = '发送';
}

/**
 * 清理乐观更新的临时 turn
 */
function cleanupOptimisticTurn(threadId, tempTurnId) {
  if (state.currentThread?.id !== threadId) return;
  const turns = state.currentThread.turns || [];
  const index = turns.findIndex((t) => t.id === tempTurnId);
  if (index !== -1) {
    turns.splice(index, 1);
    renderConversation();
  }
}

/**
 * 清理乐观更新的临时消息
 */
function cleanupOptimisticMessage(threadId, turnId, tempMessageId) {
  const thread = state.currentThread;
  if (!thread || thread.id !== threadId) return;
  const turn = (thread.turns || []).find((t) => t.id === turnId);
  if (!turn) return;
  const items = turn.items || [];
  const index = items.findIndex((item) => item.id === tempMessageId);
  if (index !== -1) {
    items.splice(index, 1);
    renderConversation();
  }
}

async function interruptCurrentTurn() {
  try {
    const thread = ensureCurrentThread();
    const turnId = deriveActiveTurnId(thread);
    if (!turnId) {
      setBanner('当前没有 inProgress turn');
      return;
    }
    await api(`/api/threads/${encodeURIComponent(thread.id)}/turns/${encodeURIComponent(turnId)}/interrupt`, {
      method: 'POST',
    });
    addRawEvent('turn.interrupt', { threadId: thread.id, turnId });
  } catch (error) {
    setBanner(`中断失败：${error.message}`, 'error');
  }
}

function mergeItemIntoTurn(threadId, turnId, incomingItem) {
  const thread = state.currentThread && state.currentThread.id === threadId ? state.currentThread : null;
  if (!thread) return;
  const turn = (thread.turns || []).find((candidate) => candidate.id === turnId);
  if (!turn) return;

  const items = turn.items || (turn.items = []);
  const existing = items.find((candidate) => candidate.id === incomingItem.id);
  if (!existing) {
    items.push(incomingItem);
  } else {
    Object.assign(existing, incomingItem);
  }
}

function appendDeltaToItem(threadId, turnId, itemId, delta, targetField = 'text') {
  const thread = state.currentThread && state.currentThread.id === threadId ? state.currentThread : null;
  if (!thread) return;
  const turn = (thread.turns || []).find((candidate) => candidate.id === turnId);
  if (!turn) return;
  const item = (turn.items || []).find((candidate) => candidate.id === itemId);
  if (!item) return;
  item[targetField] = (item[targetField] || '') + delta;
  if (targetField === 'aggregatedOutput') {
    item.aggregatedOutput = item[targetField];
  }
}

function handleJsonRpc(msg) {
  console.log('[SSE]', msg.method, msg.params);
  addRawEvent(msg.method || 'response', msg);

  if (msg.method && Object.prototype.hasOwnProperty.call(msg, 'id')) {
    state.pendingApprovals.set(String(msg.id), {
      requestId: String(msg.id),
      method: msg.method,
      params: msg.params || {},
    });
    renderApprovals();
    return;
  }

  switch (msg.method) {
    case 'thread/started': {
      if (msg.params?.thread) {
        upsertThread(msg.params.thread);
        loadThreads().catch((error) => setBanner(error.message, 'error'));
      }
      break;
    }
    case 'thread/status/changed': {
      const thread = state.threadMap.get(msg.params?.threadId);
      if (thread) thread.status = msg.params.status;
      if (state.currentThread?.id === msg.params?.threadId) {
        state.currentThread.status = msg.params.status;
        renderConversation();
      }
      loadThreads().catch(() => {});
      break;
    }
    case 'turn/started': {
      const turn = msg.params?.turn;
      if (turn?.threadId && state.currentThread?.id === turn.threadId) {
        const turns = state.currentThread.turns || (state.currentThread.turns = []);
        const exists = turns.find((candidate) => candidate.id === turn.id);
        if (!exists) {
          // 检查是否有临时 turn 需要替换
          const tempTurn = turns.find((t) => t.id?.toString().startsWith('temp-turn-'));
          if (tempTurn) {
            // 替换临时 turn
            tempTurn.id = turn.id;
            Object.assign(tempTurn, turn);
            if (!tempTurn.items) tempTurn.items = [];
          } else {
            turns.push({ ...turn, items: [] });
          }
        }
        renderConversation();
      }
      break;
    }
    case 'turn/completed': {
      const turn = msg.params?.turn;
      console.log('[turn/completed] 收到事件:', { turn, currentThreadId: state.currentThread?.id, isSending: state.isSending });

      if (turn) {
        const threadId = turn.threadId;
        const isCurrentThread = state.currentThread?.id === threadId;

        console.log('[turn/completed] 检查条件:', { threadId, isCurrentThread });

        // 关键修复：总是更新 turn 状态，无论是否当前线程
        // 先从 threadMap 中查找并更新
        const thread = state.threadMap.get(threadId);
        if (thread?.turns) {
          const existing = thread.turns.find((candidate) => candidate.id === turn.id);
          if (existing) {
            existing.status = turn.status || 'completed';
            if (turn.items) existing.items = turn.items;
          }
        }

        // 再更新 currentThread（如果匹配）
        if (isCurrentThread && state.currentThread?.turns) {
          const existing = state.currentThread.turns.find((candidate) => candidate.id === turn.id);
          if (existing) {
            existing.status = turn.status || 'completed';
            if (turn.items) existing.items = turn.items;
          }
        }

        // 清除活跃 turn
        if (threadId) {
          state.activeTurnIdByThread.delete(threadId);
        }

        // 恢复发送状态
        if (state.isSending) {
          console.log('[turn/completed] 恢复发送状态');
          // 清除兜底超时
          if (fallbackTimeoutId) {
            clearTimeout(fallbackTimeoutId);
            fallbackTimeoutId = null;
          }
          state.isSending = false;
          el.sendMessageBtn.disabled = false;
          el.composerInput.disabled = false;
          el.sendMessageBtn.textContent = '发送';
        }

        renderConversation();
        renderActiveThreadHeader();
        loadThreads().catch(() => {});
        if (threadId) {
          refreshThreadFromServer(threadId).catch(() => {});
        }
      }
      break;
    }
    case 'turn/diff/updated': {
      if (msg.params?.turnId && msg.params?.diff) {
        state.latestDiffByTurn.set(msg.params.turnId, msg.params.diff);
        if (state.currentThread?.id === msg.params?.threadId) {
          renderDiffPreview();
        }
      }
      break;
    }
    case 'item/started': {
      const threadId = msg.params?.threadId || state.activeThreadId;
      const turnId = msg.params?.turnId;
      const item = msg.params?.item;
      if (threadId && turnId && item) {
        mergeItemIntoTurn(threadId, turnId, item);
        renderConversation();
      }
      break;
    }
    case 'item/completed': {
      const threadId = msg.params?.threadId || state.activeThreadId;
      const turnId = msg.params?.turnId;
      const item = msg.params?.item;
      if (threadId && turnId && item) {
        mergeItemIntoTurn(threadId, turnId, item);
        renderConversation();
      }
      break;
    }
    case 'item/agentMessage/delta': {
      const threadId = msg.params?.threadId || state.activeThreadId;
      if (!threadId) break;
      appendDeltaToItem(threadId, msg.params?.turnId, msg.params?.itemId, msg.params?.delta || '', 'text');
      renderConversation();
      break;
    }
    case 'item/reasoning/textDelta':
    case 'item/reasoning/summaryTextDelta': {
      const threadId = msg.params?.threadId || state.activeThreadId;
      if (!threadId) break;
      appendDeltaToItem(threadId, msg.params?.turnId, msg.params?.itemId, msg.params?.delta || msg.params?.textDelta || '', 'text');
      renderConversation();
      break;
    }
    case 'item/commandExecution/outputDelta': {
      const threadId = msg.params?.threadId || state.activeThreadId;
      if (!threadId) break;
      appendDeltaToItem(threadId, msg.params?.turnId, msg.params?.itemId, msg.params?.delta || msg.params?.output || '', 'aggregatedOutput');
      renderConversation();
      break;
    }
    case 'item/fileChange/outputDelta': {
      const threadId = msg.params?.threadId || state.activeThreadId;
      if (!threadId) break;
      appendDeltaToItem(threadId, msg.params?.turnId, msg.params?.itemId, msg.params?.delta || '', 'output');
      renderConversation();
      break;
    }
    case 'serverRequest/resolved': {
      if (msg.params?.requestId) {
        state.pendingApprovals.delete(String(msg.params.requestId));
        renderApprovals();
      }
      break;
    }
    case 'error': {
      const errorMessage = msg.params?.error?.message || 'Unknown app-server error';
      setBanner(errorMessage, 'error');
      break;
    }
    default:
      break;
  }
}

function connectEvents() {
  // 重连相关变量
  let reconnectAttempts = 0;
  const maxReconnectDelay = 30000;
  const baseReconnectDelay = 1000;
  let reconnectTimer = null;

  const connect = () => {
    const isReconnect = reconnectAttempts > 0;

    if (state.sse) {
      state.sse.close();
      state.sse = null;
    }

    const source = new EventSource('/api/events');
    state.sse = source;

    source.onopen = () => {
      reconnectAttempts = 0; // 重置重连计数
      if (isReconnect) {
        setBanner('SSE 已重新连接');
        addRawEvent('sse.reconnect', { timestamp: new Date().toISOString() });
        // 重连后刷新数据，确保状态同步
        Promise.all([loadHealth(), loadThreads()]).catch(() => {});
      }
    };

    source.onmessage = (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch (parseError) {
        console.error('[SSE] JSON 解析失败:', parseError, event.data);
        addRawEvent('parseError', { error: parseError.message, raw: event.data });
        return;
      }
      if (payload.type === 'connection') {
        state.health = payload.payload;
        renderHealth();
        return;
      }
      if (payload.type === 'jsonrpc') {
        handleJsonRpc(payload.payload);
        return;
      }
      if (payload.type === 'stderr') {
        addRawEvent('stderr', payload.payload.line);
        return;
      }
      if (payload.type === 'parseError') {
        addRawEvent('parseError', payload.payload);
        return;
      }
      addRawEvent(payload.type, payload.payload);
    };

    source.onerror = () => {
      console.error('[SSE] 连接错误');
      source.close();
      state.sse = null;

      // 清除之前的重连定时器
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }

      // 指数退避重连
      const delay = Math.min(baseReconnectDelay * Math.pow(2, reconnectAttempts), maxReconnectDelay);
      reconnectAttempts++;

      setBanner(`SSE 连接断开，${Math.round(delay / 1000)}秒后重连...`, 'error');

      reconnectTimer = setTimeout(() => {
        addRawEvent('sse.reconnecting', { attempt: reconnectAttempts, delay });
        connect();
      }, delay);
    };
  };

  connect();
}

async function initialize() {
  Object.assign(el, {
    healthPanel: qs('healthPanel'),
    statusBanner: qs('statusBanner'),
    refreshHealthBtn: qs('refreshHealthBtn'),
    refreshThreadsBtn: qs('refreshThreadsBtn'),
    threadList: qs('threadList'),
    activeThreadTitle: qs('activeThreadTitle'),
    activeThreadMeta: qs('activeThreadMeta'),
    resumeThreadBtn: qs('resumeThreadBtn'),
    reloadThreadBtn: qs('reloadThreadBtn'),
    interruptTurnBtn: qs('interruptTurnBtn'),
    conversationFeed: qs('conversationFeed'),
    composerForm: qs('composerForm'),
    composerInput: qs('composerInput'),
    sendMessageBtn: qs('sendMessageBtn'),
    approvalCount: qs('approvalCount'),
    approvalList: qs('approvalList'),
    diffMeta: qs('diffMeta'),
    diffPreview: qs('diffPreview'),
    eventLog: qs('eventLog'),
    clearEventsBtn: qs('clearEventsBtn'),
    newThreadBtn: qs('newThreadBtn'),
    newThreadModel: qs('newThreadModel'),
    newThreadCwd: qs('newThreadCwd'),
    newThreadApprovalPolicy: qs('newThreadApprovalPolicy'),
    newThreadSandboxType: qs('newThreadSandboxType'),
    utilityTray: qs('utilityTray'),
    toggleUtilityBtn: qs('toggleUtilityBtn'),
    utilityTabApprovals: qs('utilityTabApprovals'),
    utilityTabDiff: qs('utilityTabDiff'),
    utilityTabEvents: qs('utilityTabEvents'),
    utilityPanelApprovals: qs('utilityPanelApprovals'),
    utilityPanelDiff: qs('utilityPanelDiff'),
    utilityPanelEvents: qs('utilityPanelEvents'),
  });

  el.refreshHealthBtn.addEventListener('click', () => loadHealth().catch((error) => setBanner(error.message, 'error')));
  el.refreshThreadsBtn.addEventListener('click', () => loadThreads().catch((error) => setBanner(error.message, 'error')));
  el.reloadThreadBtn.addEventListener('click', () => state.activeThreadId && openThread(state.activeThreadId).catch((error) => setBanner(error.message, 'error')));
  el.resumeThreadBtn.addEventListener('click', async () => {
    if (!state.activeThreadId) return;
    try {
      await api(`/api/threads/${encodeURIComponent(state.activeThreadId)}/resume`, { method: 'POST', body: '{}' });
      await openThread(state.activeThreadId);
    } catch (error) {
      setBanner(`恢复失败：${error.message}`, 'error');
    }
  });
  el.interruptTurnBtn.addEventListener('click', () => interruptCurrentTurn());
  el.composerForm.addEventListener('submit', sendComposerMessage);
  el.newThreadBtn.addEventListener('click', () => createThreadFromForm().catch((error) => setBanner(`创建失败：${error.message}`, 'error')));
  el.clearEventsBtn.addEventListener('click', () => {
    state.rawEvents = [];
    renderEventLog();
  });
  el.toggleUtilityBtn.addEventListener('click', () => setUtilityTrayOpen(!state.utilityTrayOpen));
  el.utilityTabApprovals.addEventListener('click', () => {
    setUtilityTab('approvals');
    setUtilityTrayOpen(true);
  });
  el.utilityTabDiff.addEventListener('click', () => {
    setUtilityTab('diff');
    setUtilityTrayOpen(true);
  });
  el.utilityTabEvents.addEventListener('click', () => {
    setUtilityTab('events');
    setUtilityTrayOpen(true);
  });

  // 事件委托：线程列表点击
  el.threadList.addEventListener('click', (event) => {
    const button = event.target.closest('.thread-item');
    if (button?.dataset.threadId) {
      openThread(button.dataset.threadId);
    }
  });

  // 事件委托：审批按钮点击
  el.approvalList.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-request-id]');
    if (!button) return;
    const requestId = button.dataset.requestId;
    const decision = button.dataset.decision;
    try {
      await api(`/api/approvals/${encodeURIComponent(requestId)}`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      });
      addRawEvent('approval.response', { requestId, decision });
    } catch (error) {
      setBanner(`审批回包失败：${error.message}`, 'error');
    }
  });

  renderUtilityTray();
  connectEvents();
  state.isLoading = true;
  setBanner('正在初始化...');
  try {
    await Promise.all([loadHealth(), loadPendingApprovals(), loadThreads()]);
    renderConversation();
    renderEventLog();
    renderUtilityTray();
  } finally {
    state.isLoading = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initialize().catch((error) => {
    console.error(error);
    setBanner(error.message, 'error');
  });
});
