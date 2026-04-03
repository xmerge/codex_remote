const state = {
  health: null,
  threads: [],
  threadMap: new Map(),
  activeThreadId: null,
  currentThread: null,
  pendingApprovals: new Map(),
  pendingApprovalActions: new Map(),
  rawEvents: [],
  latestDiffByTurn: new Map(),
  sse: null,
  lastEventSeq: 0,
  pendingSend: null,
  isLoading: false,
  appBootstrapped: false,
  utilityTab: 'approvals',
  utilityTrayOpen: false,
  sidebarOpen: false,
  collapsedThreadGroups: new Set(),
  auth: {
    required: true,
    authenticated: false,
    ready: false,
  },
};

const el = {};
const AVAILABLE_MODELS = ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.2', 'gpt-5.2-codex', 'gpt-5.1-codex-max'];

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

function shortPath(value) {
  if (!value) return '—';
  const normalized = String(value).replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (!parts.length) return normalized;
  if (parts.length <= 4) return normalized;
  return `.../${parts.slice(-3).join('/')}`;
}

function normalizeThreadCwd(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .trim();
}

function folderNameFromCwd(value) {
  const normalized = normalizeThreadCwd(value);
  if (!normalized) return '未设置目录';
  const parts = normalized.split('/').filter(Boolean);
  if (!parts.length) return normalized;
  return parts[parts.length - 1];
}

function normalizeApprovalPolicy(value) {
  const mapping = {
    unlessTrusted: 'untrusted',
    onRequest: 'on-request',
  };
  return mapping[value] || value || 'untrusted';
}

function deriveThreadModel(thread) {
  if (!thread) return '';
  return (
    thread.model ||
    thread.modelName ||
    thread.currentModel ||
    thread.configuration?.model ||
    thread.config?.model ||
    thread.metadata?.model ||
    thread.session?.model ||
    ''
  );
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
      'X-Codex-Requested-With': 'codex-remote-web',
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { rawText: text };
    }
  }
  if (!response.ok) {
    const fallbackMessage = typeof payload.rawText === 'string' && payload.rawText.trim() ? payload.rawText.trim() : response.statusText;
    const error = new Error(payload.error || fallbackMessage);
    error.status = response.status;
    error.rawText = payload.rawText || '';
    if (response.status === 401 && !path.startsWith('/api/auth/')) {
      state.auth.required = true;
      state.auth.authenticated = false;
      state.auth.ready = true;
      disconnectLiveUpdates();
      state.appBootstrapped = false;
      renderAuthGate(payload.error || '鉴权已失效，请重新输入访问密钥。');
    }
    throw error;
  }
  return payload;
}

let bannerTimeout = null;

function setBanner(message, kind = 'info', options = {}) {
  const { persistent = false } = options;
  el.statusBanner.textContent = message;
  el.statusBanner.className = `status-banner ${kind === 'error' ? 'error' : ''}`.trim();

  if (bannerTimeout) {
    clearTimeout(bannerTimeout);
    bannerTimeout = null;
  }
  if (persistent) {
    return;
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

function toggleSidebar(open) {
  state.sidebarOpen = typeof open === 'boolean' ? open : !state.sidebarOpen;
  if (el.sidebar) {
    el.sidebar.classList.toggle('is-open', state.sidebarOpen);
  }
  if (el.sidebarOverlay) {
    el.sidebarOverlay.classList.toggle('is-visible', state.sidebarOpen);
  }
  if (state.sidebarOpen) {
    document.body.style.overflow = 'hidden';
  } else {
    document.body.style.overflow = '';
  }
}

function closeSidebar() {
  toggleSidebar(false);
}

function setMobileThreadDetailsOpen(open) {
  if (!el.mobileThreadDetailsModal) return;
  el.mobileThreadDetailsModal.classList.toggle('is-visible', open);
  el.mobileThreadDetailsModal.classList.toggle('is-hidden', !open);
  el.mobileThreadDetailsModal.setAttribute('aria-hidden', open ? 'false' : 'true');
}

function renderMobileThreadDetails() {
  if (!el.mobileThreadDetailsList) return;
  const thread = state.currentThread;
  if (el.mobileThreadInfoBtn) {
    el.mobileThreadInfoBtn.disabled = !thread;
  }
  if (el.mobileThreadModelSelect) {
    el.mobileThreadModelSelect.disabled = !thread;
  }
  if (el.mobileThreadModelApplyBtn) {
    el.mobileThreadModelApplyBtn.disabled = !thread;
    el.mobileThreadModelApplyBtn.textContent = '应用';
  }
  if (!thread) {
    el.mobileThreadDetailsList.innerHTML = '<div class="mobile-thread-detail-row"><div class="label">状态</div><div class="value">当前还没有打开的会话。</div></div>';
    if (el.mobileThreadModelSelect) {
      el.mobileThreadModelSelect.value = AVAILABLE_MODELS[0];
    }
    return;
  }

  const model = deriveThreadModel(thread);
  if (el.mobileThreadModelSelect) {
    const hasOption = model && [...el.mobileThreadModelSelect.options].some((option) => option.value === model);
    if (model && !hasOption) {
      const option = document.createElement('option');
      option.value = model;
      option.textContent = model;
      el.mobileThreadModelSelect.appendChild(option);
    }
    el.mobileThreadModelSelect.value = model || AVAILABLE_MODELS[0];
  }

  const rows = [
    ['标题', deriveThreadTitle(thread)],
    ['线程 ID', thread.id || '—'],
    ['状态', thread.status?.type || 'unknown'],
    ['模型', model || '—'],
    ['工作目录', thread.cwd || '—'],
    ['审批策略', thread.approvalPolicy || '—'],
    ['沙箱', thread.sandboxPolicy?.type || thread.sandboxPolicy || '—'],
    ['更新时间', fmtTime(thread.updatedAt)],
    ['创建时间', fmtTime(thread.createdAt)],
  ];

  el.mobileThreadDetailsList.innerHTML = rows
    .map(
      ([label, value]) => `
        <div class="mobile-thread-detail-row">
          <div class="label">${escapeHtml(label)}</div>
          <div class="value">${escapeHtml(String(value || '—'))}</div>
        </div>
      `,
    )
    .join('');
}

function renderMobileHeader() {
  if (!el.mobileThreadTitle) return;
  const thread = state.currentThread;
  if (thread) {
    el.mobileThreadTitle.textContent = deriveThreadTitle(thread);
  } else {
    el.mobileThreadTitle.textContent = 'Codex Remote';
  }
  renderMobileThreadDetails();
}

function disconnectLiveUpdates() {
  if (state.sse) {
    state.sse.close();
    state.sse = null;
  }
}

function renderAuthGate(message = '') {
  if (!el.authGate) return;
  const shouldShow = state.auth.required && !state.auth.authenticated;
  el.authGate.classList.toggle('is-hidden', !shouldShow);
  if (el.logoutBtn) {
    el.logoutBtn.hidden = shouldShow || !state.auth.required;
  }
  if (el.authMessage) {
    el.authMessage.textContent = message || (shouldShow ? '请输入密钥后继续。' : '已通过鉴权。');
    el.authMessage.className = `status-banner ${message && shouldShow ? 'error' : 'muted'}`.trim();
  }
  if (shouldShow) {
    requestAnimationFrame(() => el.authKeyInput?.focus());
  }
}

async function loadAuthStatus() {
  const auth = await api('/api/auth/status');
  state.auth = {
    required: Boolean(auth.required),
    authenticated: Boolean(auth.authenticated),
    ready: true,
  };
  renderAuthGate();
  return auth;
}

async function bootstrapAuthenticatedApp({ forceReload = false } = {}) {
  if (!state.auth.authenticated) return;
  if (!state.appBootstrapped) {
    connectEvents();
    state.appBootstrapped = true;
  }

  if (forceReload) {
    state.lastEventSeq = 0;
  }

  state.isLoading = true;
  setBanner('正在同步会话数据...');
  try {
    await Promise.all([loadHealth(), loadPendingApprovals(), loadThreads()]);
    renderConversation();
    renderEventLog();
    renderUtilityTray();
  } finally {
    state.isLoading = false;
  }
}

function renderHealth() {
  const health = state.health;
  if (!health) {
    el.healthPanel.innerHTML = '';
    el.statusBanner.textContent = '';
    el.statusBanner.className = 'status-banner is-hidden';
    return;
  }

  const tiles = [
    ['模式', health.mode || 'unknown'],
    ['状态', health.status || 'unknown'],
    ['PID', health.pid || '—'],
  ];

  if (!health.initialized) {
    tiles.push(['初始化', 'no']);
  }

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

  const status = String(health.status || 'unknown').toLowerCase();
  const shouldShowBanner = Boolean(health.lastError || health.fallbackReason || !['ready', 'spawned'].includes(status));
  if (!shouldShowBanner) {
    el.statusBanner.textContent = '';
    el.statusBanner.className = 'status-banner is-hidden';
    return;
  }

  const parts = [`模式 ${health.mode || 'unknown'}`, `状态 ${health.status || 'unknown'}`];
  if (health.lastError) {
    parts.push(health.lastError);
  }
  if (health.fallbackReason) {
    parts.push(`fallback: ${health.fallbackReason}`);
  }
  setBanner(parts.join(' · '), health.lastError ? 'error' : 'info', {
    persistent: true,
  });
}

function deriveThreadTitle(thread) {
  return thread?.name || thread?.preview || thread?.id || '未命名会话';
}

function statusChipClass(status) {
  return `thread-status-chip ${statusToneClass(status)}`;
}

function statusToneClass(status) {
  const value = String(status || 'unknown').toLowerCase();
  if (['active', 'inprogress', 'running'].includes(value)) {
    return 'is-active';
  }
  if (['error', 'failed', 'interrupted'].includes(value)) {
    return 'is-error';
  }
  return 'is-idle';
}

function deriveActiveTurnId(thread) {
  if (!thread?.turns?.length) return null;
  const active = [...thread.turns].reverse().find((turn) => turn.status === 'inProgress');
  return active?.id || null;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function visitThreadInstances(threadId, visitor) {
  const visited = new Set();
  const candidates = [];
  if (state.currentThread?.id === threadId) {
    candidates.push(state.currentThread);
  }
  const mapped = state.threadMap.get(threadId);
  if (mapped) {
    candidates.push(mapped);
  }

  for (const thread of candidates) {
    if (!thread || visited.has(thread)) continue;
    visited.add(thread);
    visitor(thread);
  }
}

function getPendingSendForThread(threadId) {
  return state.pendingSend?.threadId === threadId ? state.pendingSend : null;
}

function getPendingSend() {
  return state.pendingSend;
}

function matchesPendingSendTurn(pendingSend, turn) {
  if (!pendingSend || !turn) return false;
  if (pendingSend.threadId !== turn.threadId) return false;
  return Boolean(
    turn.id &&
      (turn.id === pendingSend.realTurnId ||
        turn.id === pendingSend.tempTurnId ||
        turn.id === pendingSend.expectedTurnId),
  );
}

function findMatchingTurn(thread, pendingSend) {
  if (!thread?.turns?.length || !pendingSend) return null;

  if (pendingSend.realTurnId || pendingSend.expectedTurnId) {
    const exactId = pendingSend.realTurnId || pendingSend.expectedTurnId;
    const exact = thread.turns.find((turn) => turn.id === exactId);
    if (exact) return exact;
  }

  if (pendingSend.mode === 'start' && pendingSend.text) {
    const recentTurns = [...thread.turns].reverse().slice(0, 5);
    return (
      recentTurns.find((turn) =>
        (turn.items || []).some(
          (item) =>
            item.type === 'userMessage' &&
            (item.content || []).some((part) => part.type === 'text' && part.text === pendingSend.text),
        ),
      ) || null
    );
  }

  return null;
}

function normalizeUserMessageContent(content = []) {
  const parts = Array.isArray(content) ? content : [];
  const text = parts
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      if (typeof part.text === 'string') return part.text;
      if (typeof part.input === 'string') return part.input;
      if (typeof part.value === 'string') return part.value;
      return '';
    })
    .filter(Boolean)
    .join('\n');

  return text || JSON.stringify(parts);
}

function findOptimisticUserMessage(items, incomingItem) {
  if (incomingItem?.type !== 'userMessage') return null;
  const normalizedIncoming = normalizeUserMessageContent(incomingItem.content || []);
  return (
    items.find((candidate) => {
      if (candidate?.type !== 'userMessage') return false;
      if (!String(candidate.id || '').startsWith('temp-user-')) return false;
      return normalizeUserMessageContent(candidate.content || []) === normalizedIncoming;
    }) || null
  );
}

function mergeTurnItems(existingItems = [], incomingItems = []) {
  const merged = [...existingItems];
  for (const incomingItem of incomingItems) {
    let existing = merged.find((candidate) => candidate.id === incomingItem.id);
    if (!existing) {
      existing = findOptimisticUserMessage(merged, incomingItem);
      if (existing) {
        existing.id = incomingItem.id;
      }
    }
    if (!existing) {
      merged.push(incomingItem);
      continue;
    }
    Object.assign(existing, incomingItem);
  }
  return merged;
}

function upsertTurnInState(threadId, incomingTurn, { allowPendingReplacement = false } = {}) {
  if (!threadId || !incomingTurn?.id) return;

  visitThreadInstances(threadId, (thread) => {
    const turns = thread.turns || (thread.turns = []);
    let existing = turns.find((candidate) => candidate.id === incomingTurn.id);

    if (!existing && allowPendingReplacement) {
      const pendingSend = getPendingSendForThread(threadId);
      const tempTurnId = pendingSend?.tempTurnId;
      if (tempTurnId) {
        existing = turns.find((candidate) => candidate.id === tempTurnId);
        if (existing) {
          existing.id = incomingTurn.id;
        }
      }
    }

    if (!existing) {
      turns.push({
        ...incomingTurn,
        items: Array.isArray(incomingTurn.items) ? [...incomingTurn.items] : [],
      });
      return;
    }

    existing.status = incomingTurn.status || existing.status;
    existing.error = incomingTurn.error ?? existing.error ?? null;
    if (Array.isArray(incomingTurn.items)) {
      if (incomingTurn.items.length || !(existing.items || []).length) {
        existing.items = mergeTurnItems(existing.items || [], incomingTurn.items);
      }
    }
  });
}

function findTurnForUpdate(thread, threadId, turnId) {
  if (!thread || !turnId) return null;
  const turns = thread.turns || [];
  const exact = turns.find((candidate) => candidate.id === turnId);
  if (exact) return exact;

  const pendingSend = getPendingSendForThread(threadId);
  if (pendingSend?.tempTurnId) {
    return turns.find((candidate) => candidate.id === pendingSend.tempTurnId) || null;
  }

  return null;
}

let fallbackTimeoutId = null;
let threadReloadTimer = null;
let recoveryPromise = null;

function clearPendingSendTimeout() {
  if (fallbackTimeoutId) {
    clearTimeout(fallbackTimeoutId);
    fallbackTimeoutId = null;
  }
}

function setPendingSend(nextPendingSend) {
  state.pendingSend = nextPendingSend;
  renderActiveThreadHeader();
}

function clearPendingSend() {
  clearPendingSendTimeout();
  state.pendingSend = null;
  renderActiveThreadHeader();
}

function schedulePendingSendReconciliation() {
  const pendingSend = state.pendingSend;
  if (!pendingSend) return;
  void reconcilePendingSend({ ...pendingSend });
}

function armPendingSendTimeout(threadId) {
  clearPendingSendTimeout();
  fallbackTimeoutId = setTimeout(() => {
    fallbackTimeoutId = null;
    const pendingSend = getPendingSendForThread(threadId);
    if (!pendingSend) return;
    pendingSend.status = 'uncertain';
    renderActiveThreadHeader();
    setBanner('等待超时，正在向服务端对账…', 'error');
    schedulePendingSendReconciliation();
  }, 5 * 60 * 1000);
}

function scheduleLoadThreads(delay = 160) {
  if (threadReloadTimer) {
    clearTimeout(threadReloadTimer);
  }
  threadReloadTimer = setTimeout(() => {
    threadReloadTimer = null;
    loadThreads().catch((error) => setBanner(error.message, 'error'));
  }, delay);
}

async function recoverClientState(reason = 'reconnect') {
  if (recoveryPromise) {
    return recoveryPromise;
  }

  recoveryPromise = (async () => {
    addRawEvent('state.recover', {
      reason,
      activeThreadId: state.activeThreadId,
      pendingSend: state.pendingSend
        ? {
            threadId: state.pendingSend.threadId,
            mode: state.pendingSend.mode,
            status: state.pendingSend.status,
            realTurnId: state.pendingSend.realTurnId,
          }
        : null,
    });

    await Promise.all([loadHealth(), loadThreads(), loadPendingApprovals()]);

    if (state.activeThreadId) {
      await refreshThreadFromServer(state.activeThreadId);
    }

    if (state.pendingSend) {
      await reconcilePendingSend({ ...state.pendingSend });
    }
  })().finally(() => {
    recoveryPromise = null;
  });

  return recoveryPromise;
}

async function reconcilePendingSend(snapshot = state.pendingSend) {
  if (!snapshot || !state.pendingSend || state.pendingSend.startedAt !== snapshot.startedAt) {
    return;
  }

  const delays = [0, 400, 1000, 2000];
  for (const delay of delays) {
    if (delay) {
      await wait(delay);
    }

    if (!state.pendingSend || state.pendingSend.startedAt !== snapshot.startedAt) {
      return;
    }

    let thread = null;
    try {
      thread = await refreshThreadFromServer(snapshot.threadId);
      await loadPendingApprovals();
    } catch (error) {
      addRawEvent('pendingSend.reconcile.error', { message: error.message, threadId: snapshot.threadId });
      continue;
    }

    const matchedTurn = findMatchingTurn(thread, snapshot);
    if (matchedTurn) {
      state.pendingSend.realTurnId = matchedTurn.id;
      state.pendingSend.status = matchedTurn.status === 'inProgress' ? 'streaming' : 'completed';
      renderActiveThreadHeader();
      if (matchedTurn.status !== 'inProgress') {
        clearPendingSend();
      }
      return;
    }
  }

  cleanupOptimisticTurn(snapshot.threadId, snapshot.tempTurnId);
  cleanupOptimisticMessage(snapshot.threadId, snapshot.realTurnId || snapshot.expectedTurnId, snapshot.tempMessageId);
  clearPendingSend();
  setBanner('请求状态未在服务端确认，已回滚本地占位。', 'error');
}

function upsertThread(thread) {
  if (!thread?.id) return;
  const existing = state.threadMap.get(thread.id) || {};
  // 深拷贝 turns 数组，避免引用问题
  const merged = {
    ...existing,
    ...thread,
    turns: thread.turns ? [...thread.turns] : existing.turns,
  };
  state.threadMap.set(thread.id, merged);
}

function syncThreadsFromList(threads) {
  state.threads = threads || [];
  for (const thread of state.threads) {
    upsertThread(thread);
  }
  renderThreadList();
}

function groupThreadsByCwd(threads = []) {
  const groups = new Map();

  for (const thread of threads) {
    const cwd = normalizeThreadCwd(thread.cwd);
    const key = cwd || '__no_cwd__';
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        cwd,
        title: folderNameFromCwd(cwd),
        threads: [],
        updatedAt: 0,
      };
      groups.set(key, group);
    }
    group.threads.push(thread);
    group.updatedAt = Math.max(group.updatedAt, Number(thread.updatedAt || 0));
  }

  return [...groups.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

function toggleThreadGroup(groupKey) {
  if (!groupKey) return;
  if (state.collapsedThreadGroups.has(groupKey)) {
    state.collapsedThreadGroups.delete(groupKey);
  } else {
    state.collapsedThreadGroups.add(groupKey);
  }
  renderThreadList();
}

function renderThreadList() {
  const list = state.threads;
  if (el.threadCountBadge) {
    el.threadCountBadge.textContent = String(list.length);
  }
  if (!list.length) {
    el.threadList.innerHTML = '<div class="muted">还没有会话。</div>';
    return;
  }

  const template = qs('threadItemTemplate');
  el.threadList.innerHTML = '';
  const groups = groupThreadsByCwd(list);
  for (const group of groups) {
    const section = document.createElement('section');
    section.className = 'thread-group';
    const isCollapsed = state.collapsedThreadGroups.has(group.key);

    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'thread-group-head';
    header.dataset.groupKey = group.key;
    header.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
    header.innerHTML = `
      <span class="thread-group-chevron ${isCollapsed ? 'is-collapsed' : ''}" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="9 18 15 12 9 6"></polyline>
        </svg>
      </span>
      <div class="thread-group-copy">
        <div class="thread-group-title">${escapeHtml(group.title)}</div>
        <div class="thread-group-path">${escapeHtml(group.cwd || '未设置工作目录')}</div>
      </div>
      <span class="thread-group-count">${group.threads.length}</span>
    `;
    section.appendChild(header);

    const items = document.createElement('div');
    items.className = `thread-group-items${isCollapsed ? ' is-collapsed' : ''}`;

    for (const thread of group.threads) {
      const fragment = template.content.cloneNode(true);
      const button = fragment.querySelector('.thread-item');
      button.dataset.threadId = thread.id;
      button.classList.toggle('active', thread.id === state.activeThreadId);
      const status = thread.status?.type || 'unknown';
      fragment.querySelector('.thread-item-title').textContent = deriveThreadTitle(thread);
      fragment.querySelector('.thread-item-status').textContent = status;
      fragment.querySelector('.thread-item-status').className = `thread-item-status ${statusToneClass(status)}`;
      fragment.querySelector('.thread-item-preview').textContent = thread.preview || '暂无预览';
      fragment.querySelector('.thread-item-path').textContent = shortPath(thread.cwd);
      fragment.querySelector('.thread-item-meta').textContent = fmtCompactTime(thread.updatedAt);
      items.appendChild(fragment);
    }

    section.appendChild(items);
    el.threadList.appendChild(section);
  }
}

function renderActiveThreadHeader() {
  const thread = state.currentThread;
  const activeTurnId = deriveActiveTurnId(thread);
  const pendingSend = getPendingSend();
  const pendingSendBlocksCurrentThread = Boolean(pendingSend);
  if (!thread) {
    el.activeThreadTitle.textContent = '未选择会话';
    el.activeThreadMeta.textContent = '先从左侧选一个会话，或新建一个。';
    if (el.activeThreadStatus) {
      el.activeThreadStatus.textContent = 'idle';
      el.activeThreadStatus.className = 'thread-status-chip is-idle';
    }
    if (el.activeThreadPath) el.activeThreadPath.textContent = 'cwd: —';
    el.resumeThreadBtn.hidden = true;
    el.resumeThreadBtn.disabled = true;
    el.reloadThreadBtn.disabled = true;
    el.interruptTurnBtn.disabled = true;
    el.sendMessageBtn.disabled = true;
    el.sendMessageBtn.textContent = '发送';
    renderMobileHeader();
    return;
  }

  const status = thread.status?.type || 'unknown';
  const canResumeThread = status === 'notLoaded';
  el.activeThreadTitle.textContent = deriveThreadTitle(thread);
  if (el.activeThreadStatus) {
    el.activeThreadStatus.textContent = status;
    el.activeThreadStatus.className = statusChipClass(status);
  }
  el.activeThreadMeta.textContent = `更新于 ${fmtTime(thread.updatedAt)} · 线程 ${shortId(thread.id)}`;
  if (el.activeThreadPath) {
    el.activeThreadPath.textContent = `cwd: ${thread.cwd || '—'}`;
    el.activeThreadPath.title = thread.cwd || '—';
  }
  el.resumeThreadBtn.hidden = !canResumeThread;
  el.resumeThreadBtn.disabled = !canResumeThread;
  const resumeLabel = canResumeThread ? '重新连接当前会话' : '当前会话已连接';
  el.resumeThreadBtn.title = resumeLabel;
  el.resumeThreadBtn.setAttribute('aria-label', resumeLabel);
  el.resumeThreadBtn.querySelector('.thread-action-label').textContent = resumeLabel;
  el.reloadThreadBtn.disabled = false;

  // 中断按钮：有活跃 turn 时可用
  el.interruptTurnBtn.disabled = !activeTurnId;

  // 发送按钮：根据发送状态决定
  if (pendingSendBlocksCurrentThread) {
    el.sendMessageBtn.disabled = true;
    if (pendingSend.threadId !== thread.id) {
      el.sendMessageBtn.textContent = '另一会话发送中...';
    } else if (pendingSend.status === 'uncertain') {
      el.sendMessageBtn.textContent = '确认中...';
    } else {
      el.sendMessageBtn.textContent = pendingSend.mode === 'start' && !pendingSend.realTurnId ? '创建中...' : '发送中...';
    }
  } else {
    el.sendMessageBtn.disabled = false;
    el.sendMessageBtn.textContent = '发送';
  }

  // 输入框状态：发送中禁用
  el.composerInput.disabled = pendingSendBlocksCurrentThread;

  // 更新移动端标题
  renderMobileHeader();
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
    const output = item.output || '';
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
        ${
          output
            ? `
              <details class="inline-details">
                <summary>查看应用日志</summary>
                <pre class="code-block">${escapeHtml(output)}</pre>
              </details>
            `
            : ''
        }
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
  const shouldStickToBottom =
    !el.conversationFeed ||
    el.conversationFeed.scrollHeight - el.conversationFeed.scrollTop - el.conversationFeed.clientHeight < 48;
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

  if (shouldStickToBottom) {
    el.conversationFeed.scrollTop = el.conversationFeed.scrollHeight;
  }
  renderDiffPreview();
  renderApprovals();
}

function scrollConversationToBottom() {
  if (!el.conversationFeed) return;
  el.conversationFeed.scrollTop = el.conversationFeed.scrollHeight;
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
      const inFlightDecision = state.pendingApprovalActions.get(String(entry.requestId));
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
          const disabled = inFlightDecision ? 'disabled' : '';
          const text = inFlightDecision === value ? '处理中...' : label;
          return `<button data-request-id="${escapeHtml(entry.requestId)}" data-decision="${escapeHtml(value)}" class="${klass}" ${disabled}>${escapeHtml(text)}</button>`;
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
  const aliveIds = new Set();
  for (const entry of result.data || []) {
    state.pendingApprovals.set(String(entry.requestId), entry);
    aliveIds.add(String(entry.requestId));
  }
  for (const requestId of [...state.pendingApprovalActions.keys()]) {
    if (!aliveIds.has(requestId)) {
      state.pendingApprovalActions.delete(requestId);
    }
  }
  renderApprovals();
}

async function loadThreads() {
  state.isLoading = true;
  if (!state.threads.length) {
    el.threadList.innerHTML = '<div class="muted">加载中...</div>';
  }
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
  scrollConversationToBottom();
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
    setNewThreadPanelOpen(false);
    closeSidebar(); // 创建会话后关闭侧边栏
  } finally {
    el.newThreadBtn.disabled = false;
    el.newThreadBtn.textContent = '新建会话';
    state.isLoading = false;
  }
}

function setNewThreadPanelOpen(open) {
  if (!el.newThreadPanel) return;
  el.newThreadPanel.classList.toggle('is-hidden', !open);
  if (el.toggleNewThreadPanelBtn) {
    el.toggleNewThreadPanelBtn.textContent = open ? '收起' : '新会话';
  }
  if (open) {
    requestAnimationFrame(() => el.newThreadCwd?.focus());
  }
}

async function pickWorkingDirectory() {
  if (!el.pickNewThreadCwdBtn) return;
  const currentLabel = el.pickNewThreadCwdBtn.textContent;
  el.pickNewThreadCwdBtn.disabled = true;
  el.pickNewThreadCwdBtn.textContent = '选择中...';
  try {
    const result = await api('/api/system/pick-directory', {
      method: 'POST',
      body: JSON.stringify({ startPath: el.newThreadCwd?.value?.trim() || undefined }),
    });
    if (result.cancelled || !result.path) {
      return;
    }
    el.newThreadCwd.value = result.path;
    el.newThreadCwd.focus();
  } catch (error) {
    if (error.status === 404) {
      setBanner('目录选择不可用：当前服务端版本过旧，请重启 `npm start` 后再试。', 'error');
    } else {
      setBanner(`目录选择失败：${error.message}`, 'error');
    }
  } finally {
    el.pickNewThreadCwdBtn.disabled = false;
    el.pickNewThreadCwdBtn.textContent = currentLabel;
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

async function sendComposerMessage(event) {
  event.preventDefault();

  if (!state.currentThread?.id) {
    setBanner('请先选择或创建一个会话', 'error');
    return;
  }

  const activePendingSend = getPendingSend();
  if (activePendingSend) {
    if (activePendingSend.threadId !== state.currentThread.id) {
      setBanner('另一个会话正在发送中，请等待当前请求确认后再继续。', 'error');
    }
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

  let tempTurnId = null;
  const isNewTurn = !activeTurnId;

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

  const pendingSend = {
    threadId: thread.id,
    mode: isNewTurn ? 'start' : 'steer',
    tempTurnId,
    realTurnId: isNewTurn ? null : activeTurnId,
    expectedTurnId: isNewTurn ? null : activeTurnId,
    tempMessageId,
    startedAt: Date.now(),
    status: 'awaitingAck',
    text,
  };
  setPendingSend(pendingSend);
  armPendingSendTimeout(thread.id);

  const controller = new AbortController();
  const apiTimeoutId = setTimeout(() => {
    controller.abort();
  }, 60000);

  try {
    if (activeTurnId) {
      await api(`/api/threads/${encodeURIComponent(thread.id)}/turns/${encodeURIComponent(activeTurnId)}/steer`, {
        method: 'POST',
        body: JSON.stringify({ text }),
        signal: controller.signal,
      });
      addRawEvent('turn.steer', { threadId: thread.id, turnId: activeTurnId, text });
      if (state.pendingSend?.startedAt === pendingSend.startedAt) {
        state.pendingSend.status = 'streaming';
        renderActiveThreadHeader();
      }
    } else {
      const result = await api(`/api/threads/${encodeURIComponent(thread.id)}/turns`, {
        method: 'POST',
        body: JSON.stringify({ text }),
        signal: controller.signal,
      });
      const newTurnId = result?.turn?.id;
      if (newTurnId) {
        visitThreadInstances(thread.id, (threadInstance) => {
          const turns = threadInstance.turns || [];
          const tempTurn = turns.find((candidate) => candidate.id === tempTurnId);
          if (tempTurn) {
            tempTurn.id = newTurnId;
          }
        });
        if (state.pendingSend?.startedAt === pendingSend.startedAt) {
          state.pendingSend.realTurnId = newTurnId;
          state.pendingSend.status = 'streaming';
          renderActiveThreadHeader();
        }
        renderConversation();
      }
      addRawEvent('turn.start', { threadId: thread.id, text });
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      if (state.pendingSend?.startedAt === pendingSend.startedAt) {
        state.pendingSend.status = 'uncertain';
        renderActiveThreadHeader();
      }
      setBanner('请求超时，正在和服务端对账…', 'error');
      loadPendingApprovals().catch(() => {});
      schedulePendingSendReconciliation();
    } else {
      setBanner(`发送失败：${error.message}`, 'error');
      if (isNewTurn && tempTurnId) {
        cleanupOptimisticTurn(thread.id, tempTurnId);
      } else if (activeTurnId) {
        cleanupOptimisticMessage(thread.id, activeTurnId, tempMessageId);
      }
      if (state.pendingSend?.startedAt === pendingSend.startedAt) {
        clearPendingSend();
      }
    }
  } finally {
    clearTimeout(apiTimeoutId);
  }
}

/**
 * 清理发送状态
 */
function cleanupSendState() {
  clearPendingSend();
}

/**
 * 清理乐观更新的临时 turn
 */
function cleanupOptimisticTurn(threadId, tempTurnId) {
  if (!threadId || !tempTurnId) return;
  visitThreadInstances(threadId, (thread) => {
    const turns = thread.turns || [];
    const index = turns.findIndex((candidate) => candidate.id === tempTurnId);
    if (index !== -1) {
      turns.splice(index, 1);
    }
  });
  if (state.currentThread?.id === threadId) {
    renderConversation();
  }
}

/**
 * 清理乐观更新的临时消息
 */
function cleanupOptimisticMessage(threadId, turnId, tempMessageId) {
  if (!threadId || !turnId || !tempMessageId) return;
  visitThreadInstances(threadId, (thread) => {
    const turn = (thread.turns || []).find((candidate) => candidate.id === turnId);
    if (!turn) return;
    const items = turn.items || [];
    const index = items.findIndex((item) => item.id === tempMessageId);
    if (index !== -1) {
      items.splice(index, 1);
    }
  });
  if (state.currentThread?.id === threadId) {
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
  if (!threadId || !turnId || !incomingItem) return;
  visitThreadInstances(threadId, (thread) => {
    const turn = findTurnForUpdate(thread, threadId, turnId);
    if (!turn) return;

    const items = turn.items || (turn.items = []);
    let existing = items.find((candidate) => candidate.id === incomingItem.id);
    if (!existing && incomingItem.type === 'userMessage') {
      existing = findOptimisticUserMessage(items, incomingItem);
      if (existing) {
        existing.id = incomingItem.id;
      }
    }
    if (!existing) {
      items.push(incomingItem);
    } else {
      Object.assign(existing, incomingItem);
    }
  });
}

function appendDeltaToItem(threadId, turnId, itemId, delta, targetField = 'text') {
  if (!threadId || !turnId || !itemId) return;
  visitThreadInstances(threadId, (thread) => {
    const turn = findTurnForUpdate(thread, threadId, turnId);
    if (!turn) return;
    const item = (turn.items || []).find((candidate) => candidate.id === itemId);
    if (!item) return;
    item[targetField] = (item[targetField] || '') + delta;
    if (targetField === 'aggregatedOutput') {
      item.aggregatedOutput = item[targetField];
    }
  });
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
        scheduleLoadThreads();
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
      scheduleLoadThreads();
      break;
    }
    case 'turn/started': {
      const turn = msg.params?.turn;
      if (turn?.threadId) {
        upsertTurnInState(turn.threadId, { ...turn, items: Array.isArray(turn.items) ? turn.items : [] }, { allowPendingReplacement: true });
        const pendingSend = getPendingSendForThread(turn.threadId);
        if (pendingSend?.tempTurnId) {
          pendingSend.realTurnId = turn.id;
          pendingSend.status = 'streaming';
          renderActiveThreadHeader();
        }
        if (state.currentThread?.id === turn.threadId) {
          renderConversation();
        }
      }
      break;
    }
    case 'turn/completed': {
      const turn = msg.params?.turn;
      const threadId = turn?.threadId ?? msg.params?.threadId;
      if (!turn || !threadId) {
        if (state.activeThreadId) {
          refreshThreadFromServer(state.activeThreadId).catch(() => {});
        }
        break;
      }

      upsertTurnInState(threadId, turn, { allowPendingReplacement: true });

      const pendingSend = getPendingSendForThread(threadId);
      const currentThread = state.currentThread?.id === threadId ? state.currentThread : null;
      const remainingActiveTurnId = currentThread ? deriveActiveTurnId(currentThread) : null;
      if (pendingSend && (matchesPendingSendTurn(pendingSend, turn) || !remainingActiveTurnId)) {
        clearPendingSend();
      }

      if (currentThread) {
        renderConversation();
      }
      scheduleLoadThreads();
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
        state.pendingApprovalActions.delete(String(msg.params.requestId));
        renderApprovals();
        if (msg.params?.threadId && state.currentThread?.id === msg.params.threadId) {
          refreshThreadFromServer(msg.params.threadId).catch(() => {});
        }
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
  if (!state.auth.authenticated) {
    return;
  }
  // 重连相关变量
  let reconnectAttempts = 0;
  const maxReconnectDelay = 30000;
  const baseReconnectDelay = 1000;
  let reconnectTimer = null;

  const connect = () => {
    if (!state.auth.authenticated) {
      return;
    }
    const isReconnect = reconnectAttempts > 0;

    if (state.sse) {
      state.sse.close();
      state.sse = null;
    }

    const sourceUrl = state.lastEventSeq ? `/api/events?lastEventId=${encodeURIComponent(state.lastEventSeq)}` : '/api/events';
    const source = new EventSource(sourceUrl);
    state.sse = source;

    source.onopen = () => {
      reconnectAttempts = 0;
      if (isReconnect) {
        setBanner('SSE 已重新连接');
        addRawEvent('sse.reconnect', { timestamp: new Date().toISOString() });
        recoverClientState('reconnect').catch((error) => setBanner(error.message, 'error'));
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
      const seq = Number(payload.seq || 0);
      if (seq) {
        if (seq <= state.lastEventSeq) {
          return;
        }
        if (state.lastEventSeq && seq > state.lastEventSeq + 1) {
          addRawEvent('sse.gap', {
            expected: state.lastEventSeq + 1,
            received: seq,
          });
          state.lastEventSeq = seq;
          recoverClientState('event-gap').catch((error) => setBanner(error.message, 'error'));
          return;
        }
        state.lastEventSeq = seq;
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
        if (!state.auth.authenticated) {
          return;
        }
        addRawEvent('sse.reconnecting', { attempt: reconnectAttempts, delay });
        connect();
      }, delay);
    };
  };

  connect();
}

async function initialize() {
  Object.assign(el, {
    authGate: qs('authGate'),
    authForm: qs('authForm'),
    authKeyInput: qs('authKeyInput'),
    authMessage: qs('authMessage'),
    authSubmitBtn: qs('authSubmitBtn'),
    logoutBtn: qs('logoutBtn'),
    healthPanel: qs('healthPanel'),
    statusBanner: qs('statusBanner'),
    refreshHealthBtn: qs('refreshHealthBtn'),
    refreshThreadsBtn: qs('refreshThreadsBtn'),
    threadList: qs('threadList'),
    activeThreadTitle: qs('activeThreadTitle'),
    activeThreadStatus: qs('activeThreadStatus'),
    activeThreadMeta: qs('activeThreadMeta'),
    activeThreadPath: qs('activeThreadPath'),
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
    pickNewThreadCwdBtn: qs('pickNewThreadCwdBtn'),
    newThreadApprovalPolicy: qs('newThreadApprovalPolicy'),
    newThreadSandboxType: qs('newThreadSandboxType'),
    newThreadPanel: qs('newThreadPanel'),
    toggleNewThreadPanelBtn: qs('toggleNewThreadPanelBtn'),
    closeNewThreadPanelBtn: qs('closeNewThreadPanelBtn'),
    threadCountBadge: qs('threadCountBadge'),
    utilityTray: qs('utilityTray'),
    toggleUtilityBtn: qs('toggleUtilityBtn'),
    utilityTabApprovals: qs('utilityTabApprovals'),
    utilityTabDiff: qs('utilityTabDiff'),
    utilityTabEvents: qs('utilityTabEvents'),
    utilityPanelApprovals: qs('utilityPanelApprovals'),
    utilityPanelDiff: qs('utilityPanelDiff'),
    utilityPanelEvents: qs('utilityPanelEvents'),
    // 移动端元素
    sidebar: document.querySelector('.sidebar'),
    sidebarOverlay: qs('sidebarOverlay'),
    menuToggle: qs('menuToggle'),
    mobileThreadTitle: qs('mobileThreadTitle'),
    mobileThreadInfoBtn: qs('mobileThreadInfoBtn'),
    mobileThreadDetailsModal: qs('mobileThreadDetailsModal'),
    mobileThreadDetailsCloseBtn: qs('mobileThreadDetailsCloseBtn'),
    mobileThreadDetailsList: qs('mobileThreadDetailsList'),
    mobileThreadModelSelect: qs('mobileThreadModelSelect'),
    mobileThreadModelApplyBtn: qs('mobileThreadModelApplyBtn'),
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
  if (el.pickNewThreadCwdBtn) {
    el.pickNewThreadCwdBtn.addEventListener('click', () => pickWorkingDirectory());
  }
  if (el.toggleNewThreadPanelBtn) {
    el.toggleNewThreadPanelBtn.addEventListener('click', () => {
      const isHidden = el.newThreadPanel?.classList.contains('is-hidden');
      setNewThreadPanelOpen(Boolean(isHidden));
    });
  }
  if (el.closeNewThreadPanelBtn) {
    el.closeNewThreadPanelBtn.addEventListener('click', () => setNewThreadPanelOpen(false));
  }
  el.authForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const key = el.authKeyInput.value.trim();
    if (!key) {
      renderAuthGate('请输入访问密钥。');
      return;
    }
    el.authSubmitBtn.disabled = true;
    try {
      await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ key }),
      });
      el.authKeyInput.value = '';
      await loadAuthStatus();
      await bootstrapAuthenticatedApp({ forceReload: true });
      renderAuthGate();
    } catch (error) {
      renderAuthGate(error.message || '登录失败');
    } finally {
      el.authSubmitBtn.disabled = false;
    }
  });
  el.logoutBtn.addEventListener('click', async () => {
    try {
      await api('/api/auth/logout', { method: 'POST', body: '{}' });
    } catch {
      // Ignore logout failures and reset locally.
    }
    disconnectLiveUpdates();
    state.appBootstrapped = false;
    state.auth.authenticated = false;
    state.auth.ready = true;
    state.health = null;
    state.threads = [];
    state.threadMap.clear();
    state.activeThreadId = null;
    state.currentThread = null;
    state.collapsedThreadGroups.clear();
    state.pendingApprovals.clear();
    state.latestDiffByTurn.clear();
    state.pendingSend = null;
    state.rawEvents = [];
    renderHealth();
    renderThreadList();
    renderConversation();
    renderApprovals();
    renderDiffPreview();
    renderEventLog();
    renderAuthGate('已退出，请重新输入访问密钥。');
  });
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
    const groupToggle = event.target.closest('.thread-group-head');
    if (groupToggle?.dataset.groupKey) {
      toggleThreadGroup(groupToggle.dataset.groupKey);
      return;
    }

    const button = event.target.closest('.thread-item');
    if (button?.dataset.threadId) {
      const thread = state.threadMap.get(button.dataset.threadId);
      const groupKey = normalizeThreadCwd(thread?.cwd) || '__no_cwd__';
      state.collapsedThreadGroups.delete(groupKey);
      openThread(button.dataset.threadId);
      closeSidebar(); // 移动端选择会话后关闭侧边栏
    }
  });

  // 移动端菜单交互
  if (el.menuToggle) {
    el.menuToggle.addEventListener('click', () => toggleSidebar());
  }
  if (el.sidebarOverlay) {
    el.sidebarOverlay.addEventListener('click', () => closeSidebar());
  }
  if (el.mobileThreadInfoBtn) {
    el.mobileThreadInfoBtn.addEventListener('click', () => {
      renderMobileThreadDetails();
      setMobileThreadDetailsOpen(true);
    });
  }
  if (el.mobileThreadDetailsCloseBtn) {
    el.mobileThreadDetailsCloseBtn.addEventListener('click', () => setMobileThreadDetailsOpen(false));
  }
  if (el.mobileThreadDetailsModal) {
    el.mobileThreadDetailsModal.addEventListener('click', (event) => {
      if (event.target === el.mobileThreadDetailsModal) {
        setMobileThreadDetailsOpen(false);
      }
    });
  }
  if (el.mobileThreadModelApplyBtn) {
    el.mobileThreadModelApplyBtn.addEventListener('click', async () => {
      const thread = state.currentThread;
      const model = el.mobileThreadModelSelect?.value?.trim();
      if (!thread?.id || !model) return;
      el.mobileThreadModelApplyBtn.disabled = true;
      el.mobileThreadModelApplyBtn.textContent = '应用中...';
      try {
        await api(`/api/threads/${encodeURIComponent(thread.id)}/resume`, {
          method: 'POST',
          body: JSON.stringify({ model }),
        });
        await refreshThreadFromServer(thread.id);
        renderMobileThreadDetails();
        setBanner(`已切换模型为 ${model}`);
      } catch (error) {
        setBanner(`模型切换失败：${error.message}`, 'error');
      } finally {
        el.mobileThreadModelApplyBtn.disabled = false;
        el.mobileThreadModelApplyBtn.textContent = '应用';
      }
    });
  }

  // 事件委托：审批按钮点击
  el.approvalList.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-request-id]');
    if (!button) return;
    const requestId = button.dataset.requestId;
    const decision = button.dataset.decision;
    if (state.pendingApprovalActions.has(requestId)) return;
    state.pendingApprovalActions.set(requestId, decision);
    renderApprovals();
    try {
      await api(`/api/approvals/${encodeURIComponent(requestId)}`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      });
      state.pendingApprovals.delete(requestId);
      state.pendingApprovalActions.delete(requestId);
      renderApprovals();
      addRawEvent('approval.response', { requestId, decision });
    } catch (error) {
      state.pendingApprovalActions.delete(requestId);
      renderApprovals();
      setBanner(`审批回包失败：${error.message}`, 'error');
    }
  });

  renderUtilityTray();
  renderAuthGate();
  setBanner('正在检查访问权限...');
  try {
    await loadAuthStatus();
    if (state.auth.authenticated) {
      await bootstrapAuthenticatedApp({ forceReload: true });
    }
  } catch (error) {
    renderAuthGate(error.message || '初始化失败');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initialize().catch((error) => {
    console.error(error);
    setBanner(error.message, 'error');
  });
});
