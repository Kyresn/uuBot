import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * app.js 是没有构建链的浏览器脚本：顶层直接摸 document，无法 import。
 * 在 vm 里用最小 DOM 桩执行整份脚本，随后调用它声明的纯函数
 * （顶层 function 声明会成为 vm 全局属性），验证标签查表不会命中原型。
 */

const APP_PATH = fileURLToPath(new URL('../../src/web/static/app.js', import.meta.url));
const INDEX_PATH = fileURLToPath(new URL('../../src/web/static/index.html', import.meta.url));

interface FakeElement {
  tagName: string;
  textContent: string;
  className: string;
  hidden: boolean;
  value: string;
  checked: boolean;
  type: string;
  placeholder: string;
  autocomplete: string;
  spellcheck: boolean;
  disabled: boolean;
  children: FakeElement[];
  classList: { add(): void; toggle(): void; contains(): boolean };
  append(...nodes: FakeElement[]): void;
  replaceChildren(...nodes: FakeElement[]): void;
  addEventListener(): void;
  remove(): void;
  focus(): void;
}

function makeElement(tagName = ''): FakeElement {
  const node: FakeElement = {
    tagName,
    textContent: '',
    className: '',
    hidden: false,
    value: '',
    checked: false,
    type: '',
    placeholder: '',
    autocomplete: '',
    spellcheck: false,
    disabled: false,
    children: [],
    classList: { add: () => {}, toggle: () => {}, contains: () => false },
    append(...nodes: FakeElement[]): void {
      node.children.push(...nodes);
    },
    replaceChildren(...nodes: FakeElement[]): void {
      node.children = nodes;
    },
    addEventListener: () => {},
    remove: () => {},
    focus: () => {},
  };
  return node;
}

interface FakeTimers {
  intervals: Array<{ id: number; fn: () => void; ms: number }>;
  cleared: number[];
}

async function loadApp(
  fetchImpl: (
    input: unknown,
    init?: { method?: string; body?: string },
  ) => Promise<unknown> = () => Promise.reject(new Error('offline')),
): Promise<Record<string, unknown>> {
  const source = await readFile(APP_PATH, 'utf8');
  const byId = new Map<string, FakeElement>();
  const timers: FakeTimers = { intervals: [], cleared: [] };
  let nextTimerId = 1;
  const context = vm.createContext({
    document: {
      visibilityState: 'visible',
      getElementById(id: string): FakeElement {
        let node = byId.get(id);
        if (node === undefined) {
          node = makeElement(id);
          byId.set(id, node);
        }
        return node;
      },
      createElement: (tag: string): FakeElement => makeElement(tag),
    },
    // 脚本末尾的启动探活：默认让所有网络调用失败，走完静默回退路径。
    fetch: fetchImpl,
    URL,
    URLSearchParams,
    setInterval: (fn: () => void, ms: number): number => {
      const id = nextTimerId++;
      timers.intervals.push({ id, fn, ms });
      return id;
    },
    clearInterval: (id: number): void => {
      timers.cleared.push(id);
    },
    __timers: timers,
  });
  new vm.Script(source, { filename: 'app.js' }).runInContext(context);
  return context as unknown as Record<string, unknown>;
}

/** 把假 DOM 子树里的 textContent 拼起来，方便断言卡片内容。 */
function textOf(node: FakeElement): string {
  return [node.textContent, ...node.children.map((child) => textOf(child))].join(' ');
}

function findById(app: Record<string, unknown>, id: string): FakeElement {
  const doc = app['document'] as { getElementById(id: string): FakeElement };
  return doc.getElementById(id);
}

/** 收集子树里的按钮，用于断言决策期间按钮被禁用。 */
function collectButtons(node: FakeElement): FakeElement[] {
  const found = node.tagName === 'button' ? [node] : [];
  for (const child of node.children) found.push(...collectButtons(child));
  return found;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}


describe('app.js label lookup', () => {
  it('returns the raw status for unknown keys instead of a prototype member', async () => {
    const app = await loadApp();
    const labelOf = app['labelOf'] as (labels: Record<string, string>, value: string) => string;

    expect(typeof labelOf).toBe('function');
    expect(labelOf({ done: '完成' }, 'done')).toBe('完成');
    expect(labelOf({ done: '完成' }, 'constructor')).toBe('constructor');
    expect(labelOf({ done: '完成' }, 'toString')).toBe('toString');
    expect(labelOf({}, '__proto__')).toBe('__proto__');
  });

  it('renders a hostile plan status without touching the prototype', async () => {
    const app = await loadApp();
    const planBadge = app['planBadge'] as (status: string) => FakeElement;

    const badge = planBadge('constructor');
    expect(badge.textContent).toBe('constructor');
    expect(badge.className).toBe('badge status-constructor');
  });
});

describe('login form markup', () => {
  it('submits with POST so a no-JS submit cannot put the token in the URL', async () => {
    const html = await readFile(INDEX_PATH, 'utf8');
    const form = /<form\b[^>]*id="login-form"[^>]*>/.exec(html)?.[0] ?? '';
    expect(form).toContain('method="post"');
    expect(form).toContain('action="#"');
  });
});

describe('conversations paging control', () => {
  it('keeps the load-older button visible after a failed append so it can be retried', async () => {
    const fetchImpl = (input: unknown): Promise<unknown> => {
      if (String(input).startsWith('/api/conversations')) {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: async () => ({ ok: false, code: 'internal' }),
        });
      }
      return Promise.reject(new Error('offline'));
    };
    const app = await loadApp(fetchImpl);
    // 脚本末尾的启动探活会异步重置对话页：先让它跑完再模拟用户操作。
    await new Promise((resolve) => setTimeout(resolve, 0));

    const doc = app['document'] as { getElementById(id: string): FakeElement };
    const more = doc.getElementById('conv-more');
    const message = doc.getElementById('conv-message');
    const loadConversations = app['loadConversations'] as (options?: {
      append?: boolean;
    }) => Promise<void>;

    // 已经有一页结果、按钮可见；追加失败不能把按钮永久藏掉。
    more.hidden = false;
    await loadConversations({ append: true });

    expect(more.hidden).toBe(false);
    expect(message.textContent).toBe('internal');
  });
});

/* ---------------- 控制页（T5b） ---------------- */

const CONTROL_STATUS = {
  quiet: { until: '2026-01-01T00:10:00.000Z', active: true },
  groups: [{ groupId: '123', silencedUntil: '2026-01-01T00:10:00.000Z', active: true }],
  observing: [{ groupId: '456', observingUntil: '2026-01-02T00:00:00.000Z', active: true }],
  approvals: { pending: 1, oldestPendingAt: '2026-01-01T00:00:00.000Z' },
  channels: [],
  plugins: [],
  capabilities: [],
  heartbeat: { silentRounds: 0, inFlight: false, nextFastMs: 1000 },
  queueSize: 0,
  endpoints: [],
};

const CONTROL_RECORD = {
  id: `ap_${'a'.repeat(32)}`,
  kind: 'capability.activate',
  status: 'pending',
  tier: 'human',
  title: '激活能力插件 echo',
  summary: '版本 0.1.0；声明权限：无；工具：echo',
  createdAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-01T00:30:00.000Z',
  createdVia: 'system',
  createdBy: 'startup',
};

describe('control tab', () => {
  it('ships the tab markup and never uses innerHTML', async () => {
    const html = await readFile(INDEX_PATH, 'utf8');
    expect(html).toContain('id="tab-control"');
    expect(html).toContain('id="control-section"');
    expect(html).toContain('id="control-approvals"');
    expect(html).toContain('id="control-command-input"');

    const source = await readFile(APP_PATH, 'utf8');
    expect(source).not.toMatch(/\.innerHTML\b/);
  });

  it('renders pending approval cards, gates, and a countdown with textContent', async () => {
    const app = await loadApp();
    const renderControl = app['renderControl'] as (
      status: typeof CONTROL_STATUS,
      records: Array<typeof CONTROL_RECORD>,
    ) => void;

    renderControl(CONTROL_STATUS, [CONTROL_RECORD]);

    const list = findById(app, 'control-approvals');
    expect(list.children).toHaveLength(1);
    const card = textOf(list.children[0] as FakeElement);
    expect(card).toContain('激活能力插件 echo');
    expect(card).toContain('版本 0.1.0');
    expect(card).toContain('批准');
    expect(card).toContain('拒绝');

    const gates = textOf(findById(app, 'control-gates'));
    expect(gates).toContain('全局静默至');
    expect(gates).toContain('群 123 静默至');
    expect(gates).toContain('群 456 观察至');
  });

  it('formats the TTL countdown defensively', async () => {
    const app = await loadApp();
    const formatRemaining = app['formatRemaining'] as (expiresAt: string, now: number) => string;

    expect(formatRemaining('2026-01-01T00:02:05.000Z', Date.parse('2026-01-01T00:00:00.000Z'))).toBe(
      '剩余 2:05',
    );
    expect(formatRemaining('2026-01-01T00:00:00.000Z', Date.parse('2026-01-01T00:00:01.000Z'))).toBe(
      '已过期',
    );
    expect(formatRemaining('not-a-date', Date.now())).toBe('—');
  });

  it('polls every 15s while the control tab is visible and stops when switching away', async () => {
    const fetchImpl = (input: unknown): Promise<unknown> => {
      const path = String(input);
      if (path.startsWith('/api/control')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ ok: true, status: CONTROL_STATUS, approvals: CONTROL_STATUS.approvals }),
        });
      }
      if (path.startsWith('/api/approvals')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ ok: true, records: [], pending: 0 }),
        });
      }
      return Promise.reject(new Error('offline'));
    };
    const app = await loadApp(fetchImpl);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const timers = app['__timers'] as FakeTimers;
    const showTab = app['showTab'] as (name: string) => void;

    showTab('control');
    const poll = timers.intervals.find((entry) => entry.ms === 15_000);
    expect(poll).toBeDefined();

    showTab('status');
    expect(timers.cleared).toContain(poll?.id);
  });

  it('shows an approvals error without losing the gates', async () => {
    const fetchImpl = (input: unknown): Promise<unknown> => {
      const path = String(input);
      if (path.startsWith('/api/control')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ ok: true, status: CONTROL_STATUS, approvals: CONTROL_STATUS.approvals }),
        });
      }
      if (path.startsWith('/api/approvals')) {
        return Promise.resolve({
          ok: false,
          status: 503,
          json: async () => ({ ok: false, code: 'control_unavailable' }),
        });
      }
      return Promise.reject(new Error('offline'));
    };
    const app = await loadApp(fetchImpl);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const loadControl = app['loadControl'] as () => Promise<void>;
    await loadControl();

    expect(findById(app, 'control-message').textContent).toContain('审批加载失败');
    expect(textOf(findById(app, 'control-gates'))).toContain('全局静默至');
  });

  it('posts a decision to the POST-only decision route', async () => {
    const calls: Array<{ input: unknown; init?: { method?: string; body?: string } }> = [];
    const fetchImpl = (input: unknown, init?: { method?: string; body?: string }): Promise<unknown> => {
      calls.push({ input, init });
      if (String(input) === '/api/approvals/decide') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ ok: true, record: { ...CONTROL_RECORD, status: 'approved' } }),
        });
      }
      if (String(input).startsWith('/api/approvals')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, records: [] }) });
      }
      return Promise.reject(new Error('offline'));
    };
    const app = await loadApp(fetchImpl);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const decideApproval = app['decideApproval'] as (id: string, decision: string) => Promise<void>;
    await decideApproval(CONTROL_RECORD.id, 'approve');

    const call = calls.find((entry) => entry.input === '/api/approvals/decide');
    expect(call?.init?.method).toBe('POST');
    expect(JSON.parse(call?.init?.body ?? '{}')).toEqual({
      id: CONTROL_RECORD.id,
      decision: 'approve',
    });
  });

  it('sends a command and shows the reply', async () => {
    const calls: Array<{ input: unknown; init?: { method?: string; body?: string } }> = [];
    const fetchImpl = (input: unknown, init?: { method?: string; body?: string }): Promise<unknown> => {
      calls.push({ input, init });
      if (String(input) === '/api/control/command') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            reply: '已全局静默 30 分钟。',
            intent: 'group.silence',
            changed: true,
          }),
        });
      }
      if (String(input).startsWith('/api/control')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ ok: true, status: CONTROL_STATUS, approvals: CONTROL_STATUS.approvals }),
        });
      }
      if (String(input).startsWith('/api/approvals')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, records: [] }) });
      }
      return Promise.reject(new Error('offline'));
    };
    const app = await loadApp(fetchImpl);
    await new Promise((resolve) => setTimeout(resolve, 0));

    findById(app, 'control-command-input').value = '#安静 30';
    const sendControlCommand = app['sendControlCommand'] as () => Promise<void>;
    await sendControlCommand();

    const call = calls.find((entry) => entry.input === '/api/control/command');
    expect(call?.init?.method).toBe('POST');
    expect(JSON.parse(call?.init?.body ?? '{}')).toEqual({ text: '#安静 30' });
    expect(findById(app, 'control-command-reply').textContent).toContain('已全局静默');
  });

  it('ignores a double click and locks the buttons while a decision is in flight', async () => {
    const pending = deferred<unknown>();
    let decideCalls = 0;
    const fetchImpl = (input: unknown): Promise<unknown> => {
      const path = String(input);
      if (path === '/api/approvals/decide') {
        decideCalls += 1;
        return pending.promise;
      }
      if (path.startsWith('/api/control')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ ok: true, status: CONTROL_STATUS, approvals: CONTROL_STATUS.approvals }),
        });
      }
      if (path.startsWith('/api/approvals')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, records: [] }) });
      }
      return Promise.reject(new Error('offline'));
    };
    const app = await loadApp(fetchImpl);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const renderControl = app['renderControl'] as (
      status: typeof CONTROL_STATUS,
      records: Array<typeof CONTROL_RECORD>,
    ) => void;
    renderControl(CONTROL_STATUS, [CONTROL_RECORD]);

    const decideApproval = app['decideApproval'] as (id: string, decision: string) => Promise<void>;
    const first = decideApproval(CONTROL_RECORD.id, 'approve');
    const second = decideApproval(CONTROL_RECORD.id, 'approve');

    expect(decideCalls).toBe(1);
    const buttons = collectButtons(findById(app, 'control-approvals'));
    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => button.disabled)).toBe(true);

    pending.resolve({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, record: { ...CONTROL_RECORD, status: 'approved' } }),
    });
    await Promise.all([first, second]);
    expect(decideCalls).toBe(1);
  });

  it('drops a poll response that started before a decision mutation', async () => {
    const staleControl = deferred<unknown>();
    let controlCalls = 0;
    const fetchImpl = (input: unknown): Promise<unknown> => {
      const path = String(input);
      if (path.startsWith('/api/control')) {
        controlCalls += 1;
        if (controlCalls === 1) return staleControl.promise;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ ok: true, status: CONTROL_STATUS, approvals: CONTROL_STATUS.approvals }),
        });
      }
      if (path === '/api/approvals/decide') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ ok: false, code: 'not_pending' }),
        });
      }
      if (path.startsWith('/api/approvals')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ ok: true, records: [CONTROL_RECORD], pending: 1 }),
        });
      }
      return Promise.reject(new Error('offline'));
    };
    const app = await loadApp(fetchImpl);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const loadControl = app['loadControl'] as () => Promise<void>;
    const decideApproval = app['decideApproval'] as (id: string, decision: string) => Promise<void>;

    const stale = loadControl();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await decideApproval(CONTROL_RECORD.id, 'approve');

    // 旧轮询现在才返回 pending 列表；它必须被丢弃，不能把卡片画回来。
    staleControl.resolve({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, status: CONTROL_STATUS, approvals: CONTROL_STATUS.approvals }),
    });
    await stale;

    expect(findById(app, 'control-approvals').children).toHaveLength(0);
  });

  it('clears the cards and timers on reset (logout/login)', async () => {
    const app = await loadApp();
    const showTab = app['showTab'] as (name: string) => void;
    const resetControl = app['resetControl'] as () => void;
    const timers = app['__timers'] as FakeTimers;

    showTab('control');
    const ids = timers.intervals.map((entry) => entry.id);
    resetControl();

    expect(findById(app, 'control-approvals').children).toHaveLength(0);
    expect(findById(app, 'control-message').textContent).toBe('');
    expect(timers.cleared).toEqual(expect.arrayContaining(ids));
  });
});

/* ---------------- 对话页（T3） ---------------- */

describe('chat tab', () => {
  it('ships the tab markup and states that the conversation is memory-only', async () => {
    const html = await readFile(INDEX_PATH, 'utf8');
    expect(html).toContain('id="tab-chat"');
    expect(html).toContain('id="chat-section"');
    expect(html).toContain('id="chat-list"');
    expect(html).toContain('id="chat-input"');
    expect(html).toContain('id="chat-form"');
    // 页面必须明写：只存内存、重启清空。
    expect(html).toContain('内存');
    expect(html).toContain('重启');

    const source = await readFile(APP_PATH, 'utf8');
    expect(source).not.toMatch(/\.innerHTML\b/);
  });

  it('renders owner and agent messages with textContent and de-duplicates by seq', async () => {
    const app = await loadApp();
    const renderChatMessages = app['renderChatMessages'] as (
      messages: unknown[],
    ) => number;

    expect(
      renderChatMessages([
        { seq: 1, ts: '2026-01-01T00:00:00.000Z', role: 'owner', text: '<b>你好</b>' },
        { seq: 2, ts: '2026-01-01T00:00:01.000Z', role: 'agent', text: '收到' },
      ]),
    ).toBe(2);

    const list = findById(app, 'chat-list');
    expect(list.children).toHaveLength(2);
    const owner = list.children[0] as FakeElement;
    // 内容只进 textContent：尖括号必须原样保留，不能变成标记。
    expect(textOf(owner)).toContain('<b>你好</b>');
    expect(owner.className).toContain('chat-owner');
    expect((list.children[1] as FakeElement).className).toContain('chat-agent');

    // 重复的 seq 被忽略，新 seq 继续追加。
    expect(
      renderChatMessages([
        { seq: 2, role: 'agent', text: '收到' },
        { seq: 3, role: 'owner', text: '再来' },
      ]),
    ).toBe(1);
    expect(list.children).toHaveLength(3);
  });

  it('posts the input text and clears it on success', async () => {
    const calls: Array<{ input: unknown; init?: { method?: string; body?: string } }> = [];
    const fetchImpl = (
      input: unknown,
      init?: { method?: string; body?: string },
    ): Promise<unknown> => {
      calls.push({ input, init });
      if (String(input) === '/api/chat/messages' && init?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ ok: true, seq: 1 }),
        });
      }
      if (String(input).startsWith('/api/chat/messages')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ ok: true, messages: [], lastSeq: 0 }),
        });
      }
      return Promise.reject(new Error('offline'));
    };
    const app = await loadApp(fetchImpl);
    await new Promise((resolve) => setTimeout(resolve, 0));

    findById(app, 'chat-input').value = '你好';
    const sendChat = app['sendChat'] as () => Promise<void>;
    await sendChat();

    const call = calls.find((entry) => entry.init?.method === 'POST');
    expect(call?.input).toBe('/api/chat/messages');
    expect(JSON.parse(call?.init?.body ?? '{}')).toEqual({ text: '你好' });
    expect(findById(app, 'chat-input').value).toBe('');
  });

  it('polls every 2s only while the chat tab is visible and clears on switch', async () => {
    const calls: unknown[] = [];
    const fetchImpl = (input: unknown): Promise<unknown> => {
      calls.push(input);
      if (String(input).startsWith('/api/chat/messages')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ ok: true, messages: [], lastSeq: 0 }),
        });
      }
      return Promise.reject(new Error('offline'));
    };
    const app = await loadApp(fetchImpl);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const timers = app['__timers'] as FakeTimers;
    const showTab = app['showTab'] as (name: string) => void;
    const doc = app['document'] as { visibilityState: string };

    showTab('chat');
    const poll = timers.intervals.find((entry) => entry.ms === 2000);
    expect(poll).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // 页面不可见时轮询函数直接返回，不发请求。
    doc.visibilityState = 'hidden';
    const before = calls.length;
    poll?.fn();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.length).toBe(before);

    // 切走页面：定时器必须被清掉。
    doc.visibilityState = 'visible';
    showTab('status');
    expect(timers.cleared).toContain(poll?.id);
  });
});



/* ---------------- 设置页（T4） ---------------- */

function settingsBody(): Record<string, unknown> {
  return {
    ok: true,
    importedFromEnv: true,
    revision: 'rev-1',
    requiresRestart: ['capability.autoActivate'],
    config: {
      version: 1,
      importedFromEnv: true,
      tick: { fastMs: 300000, slowMs: 3600000, wakeDebounceMs: 3000 },
      http: { timeoutMs: 120000 },
      redline: { fallbackText: '这个我不聊。' },
      qq: {
        enabled: true,
        hasWsToken: true,
        wsTokenLast4: 'wxyz',
        wsHost: '127.0.0.1',
        wsPort: 3001,
        ownerId: '10001',
        selfId: '',
        controlEnabled: true,
        controlNl: false,
        nlMinConfidence: 0.75,
        minReplyGapMs: 90000,
        groupAllowlist: ['123', '456'],
        groupDenylist: [],
        privateAllowlist: [],
        privateDenylist: [],
        privateOpen: false,
        proactive: {
          enabled: false,
          minGapMs: 21600000,
          dailyMax: 2,
          quietStart: '23:00',
          quietEnd: '08:00',
          intervalMs: 1800000,
        },
      },
      capability: { autoActivate: false },
    },
  };
}

describe('settings tab', () => {
  it('ships the tab markup, the five sections, and never uses innerHTML', async () => {
    const html = await readFile(INDEX_PATH, 'utf8');
    expect(html).toContain('id="tab-settings"');
    expect(html).toContain('id="settings-section"');
    expect(html).toContain('id="settings-sections"');
    expect(html).toContain('id="save-settings"');

    const source = await readFile(APP_PATH, 'utf8');
    expect(source).not.toMatch(/\.innerHTML\b/);

    const app = await loadApp();
    const renderSettings = app['renderSettings'] as (body: unknown) => void;
    renderSettings(settingsBody());
    const text = textOf(findById(app, 'settings-sections'));
    for (const title of ['心跳', '网络', '红线', 'QQ', '能力']) {
      expect(text).toContain(title);
    }
  });

  it('shows only the masked secret and never round-trips the placeholder', async () => {
    const app = await loadApp();
    const renderSettings = app['renderSettings'] as (body: unknown) => void;
    const buildSettingsCandidate = app['buildSettingsCandidate'] as () => {
      qq: Record<string, unknown>;
    };

    renderSettings(settingsBody());

    const text = textOf(findById(app, 'settings-sections'));
    expect(text).toContain('已设置');
    expect(text).toContain('末四位');
    expect(text).toContain('wxyz');

    const candidate = buildSettingsCandidate();
    const serialized = JSON.stringify(candidate);
    expect(serialized).not.toContain('hasWsToken');
    expect(serialized).not.toContain('wsTokenLast4');
    expect(serialized).not.toContain('wxyz');
    expect(Object.prototype.hasOwnProperty.call(candidate.qq, 'wsToken')).toBe(false);
  });

  it('replaces or clears the secret through explicit actions', async () => {
    const app = await loadApp();
    const renderSettings = app['renderSettings'] as (body: unknown) => void;
    const buildSettingsCandidate = app['buildSettingsCandidate'] as () => {
      qq: Record<string, unknown>;
    };
    const beginTokenReplace = app['beginTokenReplace'] as () => void;
    const clearToken = app['clearToken'] as () => void;

    renderSettings(settingsBody());

    beginTokenReplace();
    const input = (app['settingsTokenControl'] as () => FakeElement)();
    expect(input.hidden).toBe(false);
    input.value = 'brand-new-token';
    expect(buildSettingsCandidate().qq['wsToken']).toBe('brand-new-token');

    clearToken();
    expect(buildSettingsCandidate().qq['wsToken']).toBeNull();
    expect(input.hidden).toBe(true);
    expect(input.value).toBe('');
  });

  it('marks restart-only fields from the API list', async () => {
    const app = await loadApp();
    const renderSettings = app['renderSettings'] as (body: unknown) => void;
    const settingsRequiresRestart = app['settingsRequiresRestart'] as (path: string) => boolean;

    renderSettings(settingsBody());

    expect(settingsRequiresRestart('capability.autoActivate')).toBe(true);
    expect(settingsRequiresRestart('tick.fastMs')).toBe(false);
    expect(textOf(findById(app, 'settings-sections'))).toContain('需重启');
  });

  it('saves the full candidate with PUT and shows a field error inline', async () => {
    const calls: Array<{ input: unknown; init?: { method?: string; body?: string } }> = [];
    const fetchImpl = (
      input: unknown,
      init?: { method?: string; body?: string },
    ): Promise<unknown> => {
      calls.push({ input, init });
      if (String(input) === '/api/settings' && init?.method === 'PUT') {
        return Promise.resolve({
          ok: false,
          status: 400,
          json: async () => ({ ok: false, code: 'invalid_field', field: 'tick.fastMs' }),
        });
      }
      return Promise.reject(new Error('offline'));
    };
    const app = await loadApp(fetchImpl);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const renderSettings = app['renderSettings'] as (body: unknown) => void;
    const saveSettings = app['saveSettings'] as () => Promise<void>;
    const settingsFieldError = app['settingsFieldError'] as (path: string) => string;
    const settingsControlFor = app['settingsControlFor'] as (path: string) => FakeElement;

    renderSettings(settingsBody());
    settingsControlFor('tick.fastMs').value = '60000';
    await saveSettings();

    const call = calls.find((entry) => entry.input === '/api/settings');
    expect(call?.init?.method).toBe('PUT');
    const body = JSON.parse(call?.init?.body ?? '{}') as { tick: { fastMs: number } };
    expect(body.tick.fastMs).toBe(60000);

    // 错误按 `field` 定位到对应输入框旁边，而不是只出现在页面顶部。
    expect(settingsFieldError('tick.fastMs')).toContain('invalid_field');
    expect(settingsFieldError('tick.slowMs')).toBe('');
    expect(findById(app, 'settings-message').textContent).toContain('invalid_field');
  });

  it('shows the import notice at load time, not only after a save', async () => {
    const app = await loadApp();
    const renderSettings = app['renderSettings'] as (body: unknown) => void;

    renderSettings(settingsBody());

    const text = textOf(findById(app, 'settings-sections'));
    expect(text).toContain('环境变量');
    expect(text).toContain('导入');
  });

  it('keeps save disabled until the settings GET succeeds', async () => {
    const app = await loadApp(() => Promise.reject(new Error('offline')));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const save = findById(app, 'save-settings');
    const loadSettings = app['loadSettings'] as () => Promise<void>;
    const renderSettings = app['renderSettings'] as (body: unknown) => void;
    const resetSettings = app['resetSettings'] as () => void;

    // 初始禁用；GET 失败仍然禁用——空控件绝不能提交成一份全空文档。
    expect(save.disabled).toBe(true);
    await loadSettings();
    expect(save.disabled).toBe(true);

    renderSettings(settingsBody());
    expect(save.disabled).toBe(false);

    resetSettings();
    expect(save.disabled).toBe(true);
  });

  it('sends the revision back and reloads on 409 instead of overwriting', async () => {
    const calls: Array<{ input: unknown; init?: { method?: string; body?: string } }> = [];
    const fetchImpl = (
      input: unknown,
      init?: { method?: string; body?: string },
    ): Promise<unknown> => {
      calls.push({ input, init });
      if (String(input) === '/api/settings' && init?.method === 'PUT') {
        return Promise.resolve({
          ok: false,
          status: 409,
          json: async () => ({ ok: false, code: 'conflict' }),
        });
      }
      if (String(input) === '/api/settings') {
        return Promise.resolve({ ok: true, status: 200, json: async () => settingsBody() });
      }
      return Promise.reject(new Error('offline'));
    };
    const app = await loadApp(fetchImpl);

    const renderSettings = app['renderSettings'] as (body: unknown) => void;
    const saveSettings = app['saveSettings'] as () => Promise<void>;

    renderSettings(settingsBody());
    await saveSettings();

    const putCall = calls.find((entry) => entry.init?.method === 'PUT');
    const body = JSON.parse(putCall?.init?.body ?? '{}') as { revision?: string };
    expect(body.revision).toBe('rev-1');

    // 409 后必须重新 GET 当前值，并明确告诉用户发生了什么。
    expect(
      calls.some(
        (entry) => String(entry.input) === '/api/settings' && entry.init?.method !== 'PUT',
      ),
    ).toBe(true);
    expect(findById(app, 'settings-message').textContent).toContain('已重新加载');
  });

  it('refuses to save when no settings were loaded', async () => {
    const calls: Array<{ input: unknown; init?: { method?: string; body?: string } }> = [];
    const app = await loadApp((input, init) => {
      calls.push({ input, init });
      return Promise.reject(new Error('offline'));
    });

    const resetSettings = app['resetSettings'] as () => void;
    const saveSettings = app['saveSettings'] as () => Promise<void>;

    resetSettings();
    await saveSettings();

    expect(calls.some((entry) => entry.init?.method === 'PUT')).toBe(false);
    expect(findById(app, 'settings-message').textContent).toContain('尚未加载');
  });

  it('clears the form and errors on logout/login', async () => {
    const app = await loadApp();
    const renderSettings = app['renderSettings'] as (body: unknown) => void;
    const showLogin = app['showLogin'] as (message: string) => void;

    renderSettings(settingsBody());
    expect(findById(app, 'settings-sections').children.length).toBeGreaterThan(0);

    showLogin('');
    expect(findById(app, 'settings-sections').children).toHaveLength(0);
    expect(findById(app, 'settings-message').textContent).toBe('');
  });
});
