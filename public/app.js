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
  const response = await fetch(path, {
    ...options,
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

function setBanner(message, kind = 'info') {
  el.statusBanner.textContent = message;
  el.statusBanner.className = `status-banner ${kind === 'error' ? 'error' : ''}`.trim();
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
    button.addEventListener('click', () => openThread(thread.id));
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
    return;
  }

  const status = thread.status?.type || 'unknown';
  el.activeThreadTitle.textContent = deriveThreadTitle(thread);
  el.activeThreadMeta.textContent = `${status} · 更新于 ${fmtTime(thread.updatedAt)} · 线程 ${shortId(thread.id)}`;
  el.resumeThreadBtn.disabled = false;
  el.reloadThreadBtn.disabled = false;
  el.interruptTurnBtn.disabled = !activeTurnId;
  el.sendMessageBtn.disabled = false;
  el.sendMessageBtn.textContent = activeTurnId ? 'Steer 当前 Turn' : '发送';
  state.activeTurnIdByThread.set(thread.id, activeTurnId || null);
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

  el.approvalList.querySelectorAll('button[data-request-id]').forEach((button) => {
    button.addEventListener('click', async () => {
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
  });
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
  const result = await api('/api/threads?limit=50&sortKey=updated_at');
  syncThreadsFromList(result.data || []);
  if (!state.activeThreadId && state.threads.length) {
    await openThread(state.threads[0].id, { silent: true });
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

  const result = await api('/api/threads', {
    method: 'POST',
    body: JSON.stringify({ model, cwd: cwd || undefined, approvalPolicy, sandboxPolicy }),
  });
  await loadThreads();
  await openThread(result.thread.id);
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

async function sendComposerMessage(event) {
  event.preventDefault();
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

  const activeTurnId = deriveActiveTurnId(thread);
  state.isSending = true;
  el.sendMessageBtn.disabled = true;

  try {
    if (activeTurnId) {
      await api(`/api/threads/${encodeURIComponent(thread.id)}/turns/${encodeURIComponent(activeTurnId)}/steer`, {
        method: 'POST',
        body: JSON.stringify({ text }),
      });
      addRawEvent('turn.steer', { threadId: thread.id, turnId: activeTurnId, text });
    } else {
      await api(`/api/threads/${encodeURIComponent(thread.id)}/turns`, {
        method: 'POST',
        body: JSON.stringify({ text }),
      });
      addRawEvent('turn.start', { threadId: thread.id, text });
    }
    el.composerInput.value = '';
  } catch (error) {
    setBanner(`发送失败：${error.message}`, 'error');
  } finally {
    state.isSending = false;
    el.sendMessageBtn.disabled = false;
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
        if (!exists) turns.push({ ...turn, items: [] });
        state.activeTurnIdByThread.set(turn.threadId, turn.id);
        renderConversation();
      }
      break;
    }
    case 'turn/completed': {
      const turn = msg.params?.turn;
      if (turn?.threadId && state.currentThread?.id === turn.threadId) {
        const turns = state.currentThread.turns || (state.currentThread.turns = []);
        const existing = turns.find((candidate) => candidate.id === turn.id);
        if (existing) {
          Object.assign(existing, turn);
        } else {
          turns.push(turn);
        }
        state.activeTurnIdByThread.delete(turn.threadId);
        renderConversation();
        refreshThreadFromServer(turn.threadId).catch(() => {});
      }
      loadThreads().catch(() => {});
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
  if (state.sse) {
    state.sse.close();
  }
  const source = new EventSource('/api/events');
  state.sse = source;
  source.onmessage = (event) => {
    const payload = JSON.parse(event.data);
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
  source.onerror = (error) => {
    console.error('[SSE] 连接错误:', error);
    setBanner('SSE 连接暂时断开，浏览器会自动重连。', 'error');
  };
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

  renderUtilityTray();
  connectEvents();
  await Promise.all([loadHealth(), loadPendingApprovals(), loadThreads()]);
  renderConversation();
  renderEventLog();
  renderUtilityTray();
}

document.addEventListener('DOMContentLoaded', () => {
  initialize().catch((error) => {
    console.error(error);
    setBanner(error.message, 'error');
  });
});
