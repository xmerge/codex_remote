const http = require('http');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8788);
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_RECENT_EVENTS = 400;

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function json(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function text(res, statusCode, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function safeJsonParse(line) {
  try {
    return { ok: true, value: JSON.parse(line) };
  } catch (error) {
    return { ok: false, error };
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sendSse(res, event) {
  res.write(`id: ${event.seq}\n`);
  res.write('event: message\n');
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
    const size = chunks.reduce((sum, part) => sum + part.length, 0);
    if (size > 1024 * 1024) {
      throw new Error('Request body too large');
    }
  }
  if (chunks.length === 0) {
    return {};
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) {
    return {};
  }
  return JSON.parse(raw);
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isThreadNotFoundError(error) {
  return /thread not found/i.test(error?.message || '');
}

function isThreadNotMaterializedError(error) {
  return /not materialized yet|includeTurns is unavailable before first user message/i.test(error?.message || '');
}

function normalizeApprovalPolicy(value) {
  const mapping = {
    unlessTrusted: 'untrusted',
    onRequest: 'on-request',
  };
  return mapping[value] || value || 'untrusted';
}

async function withAutoResume(bridge, threadId, operation) {
  try {
    return await operation();
  } catch (error) {
    if (!isThreadNotFoundError(error)) {
      throw error;
    }
    await bridge.resumeThread(threadId, {});
    return operation();
  }
}

class BaseBridge extends EventEmitter {
  constructor() {
    super();
    this.health = {
      mode: 'unknown',
      status: 'starting',
      initialized: false,
      lastError: null,
      command: null,
      pid: null,
      startedAt: new Date().toISOString(),
      fallbackReason: null,
    };
    this.pendingServerRequests = new Map();
    this.activeTurns = new Map();
  }

  _emitEvent(type, payload) {
    this.emit('event', { type, payload });
  }

  _setHealth(patch) {
    this.health = { ...this.health, ...patch };
    this._emitEvent('connection', this.getHealth());
  }

  getHealth() {
    return {
      ...this.health,
      activeTurns: Object.fromEntries(this.activeTurns.entries()),
      pendingServerRequests: this.getPendingServerRequests(),
    };
  }

  getPendingServerRequests() {
    return Array.from(this.pendingServerRequests.values()).map((entry) => deepClone(entry));
  }
}

class RealCodexBridge extends BaseBridge {
  constructor(options = {}) {
    super();
    this.command = options.command || process.env.APP_SERVER_CMD || 'codex';
    this.args = options.args || (process.env.APP_SERVER_ARGS ? process.env.APP_SERVER_ARGS.split(/\s+/).filter(Boolean) : ['app-server']);
    this.clientInfo = {
      name: process.env.CLIENT_NAME || 'codex_remote_web_mvp',
      title: process.env.CLIENT_TITLE || 'Codex Remote Web MVP',
      version: process.env.CLIENT_VERSION || '0.1.0',
    };
    this.proc = null;
    this.nextId = 1;
    this.pendingResponses = new Map();
    this.readyPromise = null;
    this.startPromise = null;
    this.exited = false;
    this.health = {
      ...this.health,
      mode: 'real',
      status: 'starting',
      command: [this.command, ...this.args].join(' '),
    };
  }

  async start() {
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = new Promise((resolve, reject) => {
      let settled = false;
      const proc = spawn(this.command, this.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      });
      this.proc = proc;
      this._setHealth({ status: 'spawned', pid: proc.pid || null });

      const stdoutRl = readline.createInterface({ input: proc.stdout });
      const stderrRl = readline.createInterface({ input: proc.stderr });

      stdoutRl.on('line', (line) => this._handleStdoutLine(line));
      stderrRl.on('line', (line) => {
        this._emitEvent('stderr', { line });
      });

      proc.once('error', (error) => {
        this._setHealth({ status: 'error', lastError: error.message });
        if (!settled) {
          settled = true;
          reject(error);
        }
      });

      proc.once('exit', (code, signal) => {
        this.exited = true;
        const message = `app-server exited${code !== null ? ` with code ${code}` : ''}${signal ? ` (signal ${signal})` : ''}`;
        this._setHealth({ status: 'exited', lastError: message, initialized: false, pid: null });
        for (const pending of this.pendingResponses.values()) {
          pending.reject(new Error(message));
        }
        this.pendingResponses.clear();
      });

      (async () => {
        try {
          await this._initialize();
          if (!settled) {
            settled = true;
            resolve();
          }
        } catch (error) {
          this._setHealth({ status: 'error', lastError: error.message, initialized: false });
          if (!settled) {
            settled = true;
            reject(error);
          }
        }
      })();
    });

    return this.startPromise;
  }

  async _initialize() {
    const result = await this._rpcRaw('initialize', {
      clientInfo: this.clientInfo,
      capabilities: {
        experimentalApi: true,
      },
    }, true);
    this._notifyRaw('initialized', {});
    this._setHealth({ status: 'ready', initialized: true, lastError: null, initializeResult: result || null });
  }

  async _ensureReady() {
    if (!this.startPromise) {
      await this.start();
      return;
    }
    await this.startPromise;
  }

  _writeMessage(message) {
    if (!this.proc || this.exited) {
      throw new Error('codex app-server is not running');
    }
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  _notifyRaw(method, params = {}) {
    this._writeMessage({ method, params });
  }

  _rpcRaw(method, params = {}, allowBeforeReady = false) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (!allowBeforeReady && !this.health.initialized) {
        reject(new Error('codex app-server is not initialized yet'));
        return;
      }
      this.pendingResponses.set(String(id), { resolve, reject });
      try {
        this._writeMessage({ method, id, params });
      } catch (error) {
        this.pendingResponses.delete(String(id));
        reject(error);
      }
    });
  }

  _handleStdoutLine(line) {
    const parsed = safeJsonParse(line);
    if (!parsed.ok) {
      this._emitEvent('parseError', { line, error: parsed.error.message });
      return;
    }
    const message = parsed.value;
    this._emitEvent('jsonrpc', message);

    if (Object.prototype.hasOwnProperty.call(message, 'id') && !Object.prototype.hasOwnProperty.call(message, 'method')) {
      const pending = this.pendingResponses.get(String(message.id));
      if (!pending) {
        return;
      }
      this.pendingResponses.delete(String(message.id));
      if (message.error) {
        pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (Object.prototype.hasOwnProperty.call(message, 'id') && Object.prototype.hasOwnProperty.call(message, 'method')) {
      const requestId = String(message.id);
      const entry = {
        requestId,
        rawId: message.id,
        method: message.method,
        params: message.params || {},
        receivedAt: new Date().toISOString(),
      };
      this.pendingServerRequests.set(requestId, entry);
      return;
    }

    if (message.method === 'turn/started' && message.params?.turn?.id && message.params?.turn?.threadId) {
      this.activeTurns.set(message.params.turn.threadId, message.params.turn.id);
    }
    if (message.method === 'turn/completed' && message.params?.turn?.threadId) {
      this.activeTurns.delete(message.params.turn.threadId);
    }
    if (message.method === 'serverRequest/resolved' && message.params?.requestId) {
      this.pendingServerRequests.delete(String(message.params.requestId));
    }
  }

  async listThreads(params = {}) {
    await this._ensureReady();
    return this._rpcRaw('thread/list', { limit: 50, sortKey: 'updated_at', ...params });
  }

  async readThread(threadId, params = {}) {
    await this._ensureReady();
    const request = { threadId, includeTurns: true, ...params };
    try {
      return await this._rpcRaw('thread/read', request);
    } catch (error) {
      if (!request.includeTurns || !isThreadNotMaterializedError(error)) {
        throw error;
      }
      const fallback = await this._rpcRaw('thread/read', { ...request, includeTurns: false });
      if (fallback?.thread && !Array.isArray(fallback.thread.turns)) {
        fallback.thread.turns = [];
      }
      return fallback;
    }
  }

  async startThread(params = {}) {
    await this._ensureReady();
    return this._rpcRaw('thread/start', {
      ...params,
      approvalPolicy: normalizeApprovalPolicy(params.approvalPolicy),
    });
  }

  async resumeThread(threadId, params = {}) {
    await this._ensureReady();
    return this._rpcRaw('thread/resume', { threadId, ...params });
  }

  async startTurn(threadId, params = {}) {
    await this._ensureReady();
    return this._rpcRaw('turn/start', {
      threadId,
      input: params.input || [],
      ...params,
    });
  }

  async steerTurn(threadId, turnId, params = {}) {
    await this._ensureReady();
    return this._rpcRaw('turn/steer', {
      threadId,
      expectedTurnId: turnId,
      input: params.input || [],
    });
  }

  async interruptTurn(threadId, turnId) {
    await this._ensureReady();
    return this._rpcRaw('turn/interrupt', { threadId, turnId });
  }

  async respondToServerRequest(requestId, payload) {
    await this._ensureReady();
    const entry = this.pendingServerRequests.get(String(requestId));
    if (!entry) {
      throw new Error(`Unknown pending server request: ${requestId}`);
    }
    this._writeMessage({ id: entry.rawId, result: payload });
    return { ok: true };
  }
}

class MockCodexBridge extends BaseBridge {
  constructor(options = {}) {
    super();
    this.mode = options.mode || 'mock';
    this.threads = new Map();
    this.pendingSimulations = new Map();
    this.health = {
      ...this.health,
      mode: this.mode,
      status: 'ready',
      initialized: true,
      command: 'mock-app-server',
      fallbackReason: options.fallbackReason || null,
    };
    this._seed();
  }

  async start() {
    this._emitEvent('connection', this.getHealth());
  }

  _seed() {
    const threadId = this._makeId('thr');
    const turnId = this._makeId('turn');
    const agentItemId = this._makeId('item');
    const cmdItemId = this._makeId('item');
    const fileItemId = this._makeId('item');
    const createdAt = nowUnix() - 120;

    const sampleThread = {
      id: threadId,
      preview: 'Review the login failure and propose a fix',
      name: 'Sample mock thread',
      ephemeral: false,
      modelProvider: 'openai',
      createdAt,
      updatedAt: createdAt + 60,
      status: { type: 'idle' },
      cwd: '/Users/me/project',
      turns: [
        {
          id: turnId,
          threadId,
          status: 'completed',
          error: null,
          items: [
            {
              id: this._makeId('item'),
              type: 'userMessage',
              content: [{ type: 'text', text: 'Review the login failure and propose a fix' }],
            },
            {
              id: agentItemId,
              type: 'agentMessage',
              phase: 'commentary',
              text: 'I inspected the auth flow, ran the failing tests, and prepared a small patch.',
            },
            {
              id: cmdItemId,
              type: 'commandExecution',
              command: ['npm', 'test', '--', 'auth'],
              cwd: '/Users/me/project',
              status: 'completed',
              aggregatedOutput: 'PASS auth/login.test.ts\nPASS auth/session.test.ts\n',
              exitCode: 0,
              durationMs: 912,
            },
            {
              id: fileItemId,
              type: 'fileChange',
              status: 'completed',
              changes: [
                {
                  path: 'src/auth/login.ts',
                  kind: 'modified',
                  diff: '@@ -12,7 +12,7 @@\n- return `Welcome ${user.name}`;\n+ return `Welcome back, ${user.name}`;\n',
                },
              ],
            },
          ],
        },
      ],
    };
    this.threads.set(threadId, sampleThread);
  }

  _makeId(prefix) {
    return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  }

  _sortedThreads() {
    return Array.from(this.threads.values()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  _touchThread(threadId) {
    const thread = this.threads.get(threadId);
    if (!thread) return;
    thread.updatedAt = nowUnix();
  }

  _findTurn(threadId, turnId) {
    const thread = this.threads.get(threadId);
    if (!thread) return null;
    return thread.turns.find((turn) => turn.id === turnId) || null;
  }

  _findItem(threadId, turnId, itemId) {
    const turn = this._findTurn(threadId, turnId);
    if (!turn) return null;
    return turn.items.find((item) => item.id === itemId) || null;
  }

  _emitNotification(method, params) {
    this._emitEvent('jsonrpc', { method, params });
  }

  _registerServerRequest(method, params) {
    const rawId = Math.floor(Math.random() * 1_000_000_000);
    const requestId = String(rawId);
    const entry = {
      requestId,
      rawId,
      method,
      params: deepClone(params),
      receivedAt: new Date().toISOString(),
    };
    this.pendingServerRequests.set(requestId, entry);
    this._emitEvent('jsonrpc', { id: rawId, method, params });
    return entry;
  }

  async listThreads(params = {}) {
    const limit = Number(params.limit || 50);
    return { data: deepClone(this._sortedThreads().slice(0, limit)), nextCursor: null };
  }

  async readThread(threadId, params = {}) {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw new Error(`Thread not found: ${threadId}`);
    }
    const includeTurns = params.includeTurns !== false;
    const payload = deepClone(thread);
    if (!includeTurns) {
      delete payload.turns;
    }
    return { thread: payload };
  }

  async startThread(params = {}) {
    const threadId = this._makeId('thr');
    const thread = {
      id: threadId,
      preview: '',
      name: params.name || null,
      ephemeral: false,
      modelProvider: 'openai',
      createdAt: nowUnix(),
      updatedAt: nowUnix(),
      status: { type: 'idle' },
      cwd: params.cwd || process.cwd(),
      turns: [],
      model: params.model || 'gpt-5.4',
      approvalPolicy: normalizeApprovalPolicy(params.approvalPolicy),
      sandboxPolicy: params.sandboxPolicy || { type: 'workspaceWrite', writableRoots: [params.cwd || process.cwd()], networkAccess: true },
    };
    this.threads.set(threadId, thread);
    this._emitNotification('thread/started', { thread: deepClone(thread) });
    return { thread: deepClone(thread) };
  }

  async resumeThread(threadId, params = {}) {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw new Error(`Thread not found: ${threadId}`);
    }
    if (params.model) thread.model = params.model;
    this._emitNotification('thread/started', { thread: deepClone(thread) });
    return { thread: deepClone(thread) };
  }

  async startTurn(threadId, params = {}) {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw new Error(`Thread not found: ${threadId}`);
    }

    const userText = (params.input || [])
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n\n')
      .trim();

    const turnId = this._makeId('turn');
    const userItemId = this._makeId('item');
    const agentItemId = this._makeId('item');
    const cmdItemId = this._makeId('item');
    const fileItemId = this._makeId('item');

    const turn = {
      id: turnId,
      threadId,
      status: 'inProgress',
      error: null,
      items: [
        {
          id: userItemId,
          type: 'userMessage',
          content: [{ type: 'text', text: userText || 'Hello from mock mode' }],
        },
        {
          id: agentItemId,
          type: 'agentMessage',
          phase: 'commentary',
          text: '',
        },
      ],
    };
    thread.turns.push(turn);
    thread.preview = thread.preview || (userText || 'New thread');
    this._touchThread(threadId);
    this.activeTurns.set(threadId, turnId);

    this._emitNotification('turn/started', { turn: { id: turnId, threadId, status: 'inProgress', items: [], error: null } });
    this._emitNotification('item/started', { threadId, turnId, item: deepClone(turn.items[0]) });
    this._emitNotification('item/started', { threadId, turnId, item: deepClone(turn.items[1]) });

    const scenario = {
      threadId,
      turnId,
      agentItemId,
      cmdItemId,
      fileItemId,
      text: userText,
      canceled: false,
      timeoutIds: [],
    };
    this.pendingSimulations.set(turnId, scenario);

    const step = (delayMs, fn) => {
      const timeoutId = setTimeout(() => {
        if (scenario.canceled) return;
        try {
          fn();
        } catch (error) {
          this._emitEvent('jsonrpc', { method: 'error', params: { error: { message: error.message } } });
        }
      }, delayMs);
      scenario.timeoutIds.push(timeoutId);
    };

    const appendAgentDelta = (delta) => {
      const item = this._findItem(threadId, turnId, agentItemId);
      if (!item) return;
      item.text += delta;
      this._emitNotification('item/agentMessage/delta', { threadId, turnId, itemId: agentItemId, delta });
    };

    step(150, () => appendAgentDelta('I am reviewing the repository and planning the next step. '));
    step(500, () => {
      const turnRef = this._findTurn(threadId, turnId);
      if (!turnRef) return;
      const cmdItem = {
        id: cmdItemId,
        type: 'commandExecution',
        command: ['npm', 'test', '--', 'auth'],
        cwd: thread.cwd || process.cwd(),
        status: 'inProgress',
        aggregatedOutput: '',
        commandActions: [],
      };
      turnRef.items.push(cmdItem);
      this._emitNotification('item/started', { threadId, turnId, item: deepClone(cmdItem) });
      thread.status = { type: 'active', activeFlags: ['waitingOnApproval'] };
      this._emitNotification('thread/status/changed', { threadId, status: deepClone(thread.status) });
      this._registerServerRequest('item/commandExecution/requestApproval', {
        threadId,
        turnId,
        itemId: cmdItemId,
        command: cmdItem.command,
        cwd: cmdItem.cwd,
        reason: 'Mock mode asks for approval before running shell commands.',
        availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
      });
    });

    return { turn: { id: turnId, threadId, status: 'inProgress', items: [], error: null } };
  }

  _continueAfterCommandApproval(threadId, turnId, decision) {
    const thread = this.threads.get(threadId);
    const turn = this._findTurn(threadId, turnId);
    const scenario = this.pendingSimulations.get(turnId);
    if (!thread || !turn || !scenario) return;

    const cmdItem = this._findItem(threadId, turnId, scenario.cmdItemId);
    if (!cmdItem) return;

    if (decision === 'decline' || decision === 'cancel') {
      cmdItem.status = 'declined';
      cmdItem.aggregatedOutput = '';
      this._emitNotification('item/completed', { threadId, turnId, item: deepClone(cmdItem) });
      this._finishTurn(threadId, turnId, 'completed', 'I did not run the command because the approval was declined.');
      return;
    }

    thread.status = { type: 'active', activeFlags: [] };
    this._emitNotification('thread/status/changed', { threadId, status: deepClone(thread.status) });

    const lines = [
      '> npm test -- auth\n',
      'PASS auth/login.test.ts\n',
      'PASS auth/session.test.ts\n',
      '2 passed, 0 failed\n',
    ];

    let delay = 120;
    for (const line of lines) {
      setTimeout(() => {
        if (scenario.canceled) return;
        cmdItem.aggregatedOutput += line;
        this._emitNotification('item/commandExecution/outputDelta', { threadId, turnId, itemId: cmdItem.id, delta: line });
      }, delay);
      delay += 120;
    }

    setTimeout(() => {
      if (scenario.canceled) return;
      cmdItem.status = 'completed';
      cmdItem.exitCode = 0;
      cmdItem.durationMs = 630;
      this._emitNotification('item/completed', { threadId, turnId, item: deepClone(cmdItem) });
      this._startMockFileApproval(threadId, turnId);
    }, delay + 80);
  }

  _startMockFileApproval(threadId, turnId) {
    const thread = this.threads.get(threadId);
    const turn = this._findTurn(threadId, turnId);
    const scenario = this.pendingSimulations.get(turnId);
    if (!thread || !turn || !scenario) return;

    const fileItem = {
      id: scenario.fileItemId,
      type: 'fileChange',
      status: 'inProgress',
      changes: [
        {
          path: 'src/auth/login.ts',
          kind: 'modified',
          diff: '@@ -12,7 +12,7 @@\n- return `Welcome ${user.name}`;\n+ return `Welcome back, ${user.name}`;\n',
        },
      ],
    };
    turn.items.push(fileItem);
    this._emitNotification('item/started', { threadId, turnId, item: deepClone(fileItem) });
    this._emitNotification('turn/diff/updated', {
      threadId,
      turnId,
      diff: 'diff --git a/src/auth/login.ts b/src/auth/login.ts\n@@ -12,7 +12,7 @@\n- return `Welcome ${user.name}`;\n+ return `Welcome back, ${user.name}`;\n',
    });
    thread.status = { type: 'active', activeFlags: ['waitingOnApproval'] };
    this._emitNotification('thread/status/changed', { threadId, status: deepClone(thread.status) });
    this._registerServerRequest('item/fileChange/requestApproval', {
      threadId,
      turnId,
      itemId: fileItem.id,
      reason: 'Mock mode asks for approval before applying file changes.',
      availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
    });
  }

  _finishTurn(threadId, turnId, status, finalMessage) {
    const thread = this.threads.get(threadId);
    const turn = this._findTurn(threadId, turnId);
    const scenario = this.pendingSimulations.get(turnId);
    if (!thread || !turn || !scenario) return;

    const agentItem = this._findItem(threadId, turnId, scenario.agentItemId);
    if (agentItem && finalMessage) {
      const delta = finalMessage;
      agentItem.text += delta;
      this._emitNotification('item/agentMessage/delta', { threadId, turnId, itemId: agentItem.id, delta });
      this._emitNotification('item/completed', { threadId, turnId, item: deepClone(agentItem) });
    }

    turn.status = status;
    thread.status = { type: 'idle' };
    this.activeTurns.delete(threadId);
    this.pendingSimulations.delete(turnId);
    this._touchThread(threadId);

    this._emitNotification('thread/status/changed', { threadId, status: deepClone(thread.status) });
    this._emitNotification('turn/completed', {
      turn: {
        id: turn.id,
        threadId,
        status,
        items: deepClone(turn.items),
        error: null,
      },
    });
  }

  _continueAfterFileApproval(threadId, turnId, decision) {
    const thread = this.threads.get(threadId);
    const turn = this._findTurn(threadId, turnId);
    const scenario = this.pendingSimulations.get(turnId);
    if (!thread || !turn || !scenario) return;

    const fileItem = this._findItem(threadId, turnId, scenario.fileItemId);
    if (!fileItem) return;

    thread.status = { type: 'active', activeFlags: [] };
    this._emitNotification('thread/status/changed', { threadId, status: deepClone(thread.status) });

    if (decision === 'decline' || decision === 'cancel') {
      fileItem.status = 'declined';
      this._emitNotification('item/completed', { threadId, turnId, item: deepClone(fileItem) });
      this._finishTurn(threadId, turnId, 'completed', ' The proposed patch was left unapplied because the approval was declined.');
      return;
    }

    fileItem.status = 'completed';
    this._emitNotification('item/fileChange/outputDelta', { threadId, turnId, itemId: fileItem.id, delta: 'Applied patch to src/auth/login.ts\n' });
    this._emitNotification('item/completed', { threadId, turnId, item: deepClone(fileItem) });
    this._finishTurn(threadId, turnId, 'completed', ' I ran the tests, prepared the patch, and it is ready for you to review.');
  }

  async steerTurn(threadId, turnId, params = {}) {
    const turn = this._findTurn(threadId, turnId);
    if (!turn || turn.status !== 'inProgress') {
      throw new Error('No active turn to steer');
    }
    const steerText = (params.input || [])
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n\n')
      .trim();
    const userItem = {
      id: this._makeId('item'),
      type: 'userMessage',
      content: [{ type: 'text', text: steerText || 'Please continue' }],
    };
    turn.items.push(userItem);
    this._emitNotification('item/started', { threadId, turnId, item: deepClone(userItem) });
    const scenario = this.pendingSimulations.get(turnId);
    if (scenario) {
      const agentItem = this._findItem(threadId, turnId, scenario.agentItemId);
      if (agentItem) {
        agentItem.text += ` Additional user guidance received: ${steerText || 'Please continue'}.`;
        this._emitNotification('item/agentMessage/delta', {
          threadId,
          turnId,
          itemId: agentItem.id,
          delta: ` Additional user guidance received: ${steerText || 'Please continue'}.`,
        });
      }
    }
    return { turnId };
  }

  async interruptTurn(threadId, turnId) {
    const scenario = this.pendingSimulations.get(turnId);
    if (scenario) {
      scenario.canceled = true;
      for (const timeoutId of scenario.timeoutIds) {
        clearTimeout(timeoutId);
      }
      const thread = this.threads.get(threadId);
      const turn = this._findTurn(threadId, turnId);
      if (thread && turn) {
        turn.status = 'interrupted';
        thread.status = { type: 'idle' };
        this.activeTurns.delete(threadId);
        this.pendingSimulations.delete(turnId);
        this._emitNotification('turn/completed', {
          turn: { id: turn.id, threadId, status: 'interrupted', items: deepClone(turn.items), error: null },
        });
      }
    }
    return {};
  }

  async respondToServerRequest(requestId, payload = {}) {
    const entry = this.pendingServerRequests.get(String(requestId));
    if (!entry) {
      throw new Error(`Unknown pending server request: ${requestId}`);
    }
    this.pendingServerRequests.delete(String(requestId));
    this._emitNotification('serverRequest/resolved', { threadId: entry.params.threadId, requestId: entry.requestId });
    const decision = typeof payload.decision === 'string' ? payload.decision : (payload.decision && payload.decision.acceptWithExecpolicyAmendment ? 'accept' : 'accept');
    if (entry.method === 'item/commandExecution/requestApproval') {
      this._continueAfterCommandApproval(entry.params.threadId, entry.params.turnId, decision);
    } else if (entry.method === 'item/fileChange/requestApproval') {
      this._continueAfterFileApproval(entry.params.threadId, entry.params.turnId, decision);
    }
    return { ok: true };
  }
}

async function createBridge() {
  const forceMock = process.env.MOCK_MODE === '1';
  if (forceMock) {
    const bridge = new MockCodexBridge({ mode: 'mock' });
    await bridge.start();
    return bridge;
  }

  const realBridge = new RealCodexBridge();
  try {
    await realBridge.start();
    return realBridge;
  } catch (error) {
    if (process.env.ALLOW_MOCK_FALLBACK === '0') {
      throw error;
    }
    const fallback = new MockCodexBridge({ mode: 'mock-fallback', fallbackReason: error.message });
    await fallback.start();
    return fallback;
  }
}

function serveStatic(req, res, pathname) {
  let filePath = pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, pathname.replace(/^\//, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    text(res, 403, 'Forbidden');
    return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    text(res, 404, 'Not found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
  }[ext] || 'application/octet-stream';

  const body = fs.readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

(async function main() {
  let bridge;
  try {
    bridge = await createBridge();
  } catch (error) {
    console.error('Failed to start bridge:', error);
    process.exit(1);
  }

  let nextSeq = 1;
  const recentEvents = [];
  const sseClients = new Set();

  function publish(type, payload) {
    const event = {
      seq: nextSeq++,
      ts: new Date().toISOString(),
      type,
      payload,
    };
    recentEvents.push(event);
    while (recentEvents.length > MAX_RECENT_EVENTS) {
      recentEvents.shift();
    }
    for (const client of sseClients) {
      sendSse(client, event);
    }
  }

  bridge.on('event', (event) => publish(event.type, event.payload));
  publish('connection', bridge.getHealth());

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const { pathname } = url;

      if (req.method === 'GET' && pathname === '/api/health') {
        return json(res, 200, bridge.getHealth());
      }

      if (req.method === 'GET' && pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        });
        res.write('retry: 3000\n\n');
        sseClients.add(res);
        for (const event of recentEvents.slice(-40)) {
          sendSse(res, event);
        }
        req.on('close', () => sseClients.delete(res));
        return;
      }

      if (req.method === 'GET' && pathname === '/api/approvals/pending') {
        return json(res, 200, { data: bridge.getPendingServerRequests() });
      }

      if (req.method === 'GET' && pathname === '/api/threads') {
        const result = await bridge.listThreads({
          limit: Number(url.searchParams.get('limit') || 50),
          sortKey: url.searchParams.get('sortKey') || 'updated_at',
        });
        return json(res, 200, result);
      }

      const threadReadMatch = pathname.match(/^\/api\/threads\/([^/]+)$/);
      if (req.method === 'GET' && threadReadMatch) {
        const threadId = decodeURIComponent(threadReadMatch[1]);
        const result = await bridge.readThread(threadId, { includeTurns: true });
        return json(res, 200, result);
      }

      if (req.method === 'POST' && pathname === '/api/threads') {
        const body = await readJsonBody(req);
        const result = await bridge.startThread(body);
        return json(res, 200, result);
      }

      const threadResumeMatch = pathname.match(/^\/api\/threads\/([^/]+)\/resume$/);
      if (req.method === 'POST' && threadResumeMatch) {
        const threadId = decodeURIComponent(threadResumeMatch[1]);
        const body = await readJsonBody(req);
        const result = await bridge.resumeThread(threadId, body);
        return json(res, 200, result);
      }

      const turnStartMatch = pathname.match(/^\/api\/threads\/([^/]+)\/turns$/);
      if (req.method === 'POST' && turnStartMatch) {
        const threadId = decodeURIComponent(turnStartMatch[1]);
        const body = await readJsonBody(req);
        const result = await withAutoResume(bridge, threadId, () => bridge.startTurn(threadId, {
          ...body,
          input: [{ type: 'text', text: body.text || '' }],
        }));
        return json(res, 200, result);
      }

      const steerMatch = pathname.match(/^\/api\/threads\/([^/]+)\/turns\/([^/]+)\/steer$/);
      if (req.method === 'POST' && steerMatch) {
        const threadId = decodeURIComponent(steerMatch[1]);
        const turnId = decodeURIComponent(steerMatch[2]);
        const body = await readJsonBody(req);
        const result = await withAutoResume(bridge, threadId, () => bridge.steerTurn(threadId, turnId, {
          input: [{ type: 'text', text: body.text || '' }],
        }));
        return json(res, 200, result);
      }

      const interruptMatch = pathname.match(/^\/api\/threads\/([^/]+)\/turns\/([^/]+)\/interrupt$/);
      if (req.method === 'POST' && interruptMatch) {
        const threadId = decodeURIComponent(interruptMatch[1]);
        const turnId = decodeURIComponent(interruptMatch[2]);
        const result = await bridge.interruptTurn(threadId, turnId);
        return json(res, 200, result);
      }

      const approvalMatch = pathname.match(/^\/api\/approvals\/([^/]+)$/);
      if (req.method === 'POST' && approvalMatch) {
        const requestId = decodeURIComponent(approvalMatch[1]);
        const body = await readJsonBody(req);
        const payload = body && Object.prototype.hasOwnProperty.call(body, 'decision')
          ? { decision: body.decision }
          : body;
        const result = await bridge.respondToServerRequest(requestId, payload);
        return json(res, 200, result);
      }

      if (req.method === 'GET' && (pathname === '/' || pathname.startsWith('/public/') || /\.(css|js|svg|png|ico|html)$/.test(pathname))) {
        return serveStatic(req, res, pathname === '/' ? '/' : pathname.replace(/^\/public/, ''));
      }

      if (req.method === 'GET') {
        return serveStatic(req, res, pathname);
      }

      return text(res, 404, 'Not found');
    } catch (error) {
      console.error(error);
      return json(res, 500, { error: error.message, stack: process.env.NODE_ENV === 'development' ? error.stack : undefined });
    }
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Codex Remote Web MVP listening on http://localhost:${PORT}`);
  });
})();
