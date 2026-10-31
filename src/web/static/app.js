/*
 * 网页管理台前端：原生 JS，无构建链、无第三方依赖。
 *
 * 安全约定：
 * - 所有动态文本只经 textContent 写入，绝不用 innerHTML。
 * - token 不写 localStorage/sessionStorage，登录后立即从输入框清空。
 * - 所有写请求带 X-Uuharness-Console: 1（CSRF 双保险之一）。
 * - 密钥输入框一律 type="password"；永不预填密钥，留空表示保持原值，
 *   勾选「清除密钥」后发送 null。
 */
'use strict';

const loginView = document.getElementById('login-view');
const statusView = document.getElementById('status-view');
const loginForm = document.getElementById('login-form');
const tokenInput = document.getElementById('token');
const loginMessage = document.getElementById('login-message');
const healthOut = document.getElementById('health');
const stateOut = document.getElementById('state');
const logoutButton = document.getElementById('logout');
const refreshButton = document.getElementById('refresh');

const tabStatus = document.getElementById('tab-status');
const tabChat = document.getElementById('tab-chat');
const tabModels = document.getElementById('tab-models');
const tabConversations = document.getElementById('tab-conversations');
const tabPlan = document.getElementById('tab-plan');
const tabArchitecture = document.getElementById('tab-architecture');
const tabControl = document.getElementById('tab-control');
const statusSection = document.getElementById('status-section');
const chatSection = document.getElementById('chat-section');
const chatList = document.getElementById('chat-list');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const chatMessage = document.getElementById('chat-message');
const modelsSection = document.getElementById('models-section');
const conversationsSection = document.getElementById('conversations-section');
const planSection = document.getElementById('plan-section');
const architectureSection = document.getElementById('architecture-section');
const controlSection = document.getElementById('control-section');
const endpointRows = document.getElementById('endpoint-rows');
const addEndpointButton = document.getElementById('add-endpoint');
const saveModelsButton = document.getElementById('save-models');
const modelsMessage = document.getElementById('models-message');
const serviceSections = document.getElementById('service-sections');
const testButtons = document.getElementById('test-buttons');
const testResults = document.getElementById('test-results');
const convChannel = document.getElementById('conv-channel');
const convDirection = document.getElementById('conv-direction');
const convLimit = document.getElementById('conv-limit');
const convRefresh = document.getElementById('conv-refresh');
const convMore = document.getElementById('conv-more');
const convMessage = document.getElementById('conv-message');
const convList = document.getElementById('conv-list');
const planRefresh = document.getElementById('plan-refresh');
const planMessage = document.getElementById('plan-message');
const planContent = document.getElementById('plan-content');
const archRefresh = document.getElementById('arch-refresh');
const archMessage = document.getElementById('arch-message');
const archContent = document.getElementById('arch-content');
const controlRefresh = document.getElementById('control-refresh');
const controlMessage = document.getElementById('control-message');
const controlApprovals = document.getElementById('control-approvals');
const controlGates = document.getElementById('control-gates');
const controlCommandForm = document.getElementById('control-command-form');
const controlCommandInput = document.getElementById('control-command-input');
const controlCommandReply = document.getElementById('control-command-reply');
const tabSettings = document.getElementById('tab-settings');
const settingsSection = document.getElementById('settings-section');
const settingsSections = document.getElementById('settings-sections');
const settingsMessage = document.getElementById('settings-message');
const settingsRefresh = document.getElementById('settings-refresh');
const saveSettingsButton = document.getElementById('save-settings');
// 设置 GET 成功前禁止保存：加载失败时控件是空的，提交出去就是一份全空的
// 文档（服务端会拒绝，但按钮不该给出「可以保存」的暗示）。
saveSettingsButton.disabled = true;

const TABS = {
  status: { tab: tabStatus, section: statusSection },
  chat: { tab: tabChat, section: chatSection },
  settings: { tab: tabSettings, section: settingsSection },
  models: { tab: tabModels, section: modelsSection },
  conversations: { tab: tabConversations, section: conversationsSection },
  plan: { tab: tabPlan, section: planSection },
  architecture: { tab: tabArchitecture, section: architectureSection },
  control: { tab: tabControl, section: controlSection },
};

const SESSION_EXPIRED_MESSAGE = '会话已失效（harness 重启会导致重新登录）';
const TEST_TIERS = ['flash', 'pro', 'embedding', 'rerank', 'tts', 'stt'];
/** 只有回环地址允许空密钥（本地模型服务器）；远程端点清空密钥必然 400。 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function isLoopbackUrl(value) {
  try {
    return LOOPBACK_HOSTS.has(new URL(value).hostname);
  } catch {
    return false;
  }
}

const SERVICE_SECTIONS = [
  { name: 'embedding', title: 'Embedding', extras: [{ key: 'maxDims', label: 'maxDims（留空为默认）', type: 'number' }] },
  { name: 'rerank', title: 'Rerank', extras: [] },
  {
    name: 'tts',
    title: 'TTS',
    extras: [
      { key: 'voice', label: '音色', type: 'text' },
      { key: 'format', label: '格式', type: 'text' },
    ],
  },
  { name: 'stt', title: 'STT', extras: [{ key: 'language', label: '语言', type: 'text' }] },
];

let currentModels = null;
/** 端点行编辑器；重建列表时整体替换。 */
let endpointEditors = [];
/** 服务段编辑器，按 embedding/rerank/tts/stt 固定。 */
const serviceEditors = {};
/** 对话页的翻页游标与已加载条数；刷新时清零，加载更早时累加。 */
let convCursor = null;
let convLoaded = 0;
/** 控制页的 15s 轮询与 1s 倒计时；切走页面时必须清掉。 */
let controlPollTimer = null;
let controlCountdownTimer = null;
/** 当前卡片上的倒计时节点与截止时间；重建列表时整体替换。 */
let controlCountdowns = [];
/** 每次加载递增；过期响应（决策/重置/新轮询之后才返回）直接丢弃。 */
let controlLoadSeq = 0;
/** 决策中的审批 id：双击只发一次请求，并锁住对应按钮。 */
const controlPendingDecisions = new Set();
/** 审批 id → [批准按钮, 拒绝按钮]，用于决策期间禁用。 */
const controlActionButtons = new Map();

const CONTROL_POLL_MS = 15000;
const CONTROL_COUNTDOWN_MS = 1000;

/** 对话页：2s 轮询、按 seq 增量拉取；只有本页可见时定时器才存在。 */
const CHAT_POLL_MS = 2000;
/** 已渲染到的最新 seq：轮询只取比它更新的消息，重复 seq 一律丢弃。 */
let chatLastSeq = 0;
let chatPollTimer = null;
/** 每次加载递增；过期响应（重启重置之后才返回）直接丢弃。 */
let chatLoadSeq = 0;
/** 发送在途标志：双击/回车重复提交只发一次。 */
let chatSending = false;
/** 当前选中的页签；visibilitychange 据此决定是否恢复轮询。 */
let activeTab = 'status';

/** 设置页：GET 返回的掩码配置、路径 → 控件、路径 → 行内错误节点。 */
let currentSettings = null;
/** GET 下发的配置版本令牌；PUT 回传做乐观并发（过期返回 409）。 */
let settingsRevision = null;
let settingsControls = {};
const settingsFieldErrors = new Map();
/** API 给出的「需重启」字段路径；渲染时据此在字段/分区上打标。 */
let settingsRestartFields = new Set();
/** 密钥三态：keep（缺省保持）/ replace（提交新值）/ clear（提交 null）。 */
let settingsTokenMode = 'keep';
let settingsTokenInput = null;
let settingsTokenBadge = null;
/** 每次加载递增；登出后返回的过期响应直接丢弃。 */
let settingsLoadSeq = 0;

function setText(element, text) {
  if (element !== null) element.textContent = text;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className !== undefined && className !== '') node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function input(type, value) {
  const node = document.createElement('input');
  node.type = type;
  if (value !== undefined && value !== null) node.value = String(value);
  return node;
}

function field(labelText, control) {
  const wrap = element('label', 'field');
  wrap.append(element('span', 'field-label', labelText), control);
  return wrap;
}

function secretField(hasApiKey, keyLast4) {
  const wrap = element('div', 'field');
  wrap.append(element('span', 'field-label', 'API Key'));
  const key = input('password');
  key.autocomplete = 'new-password';
  key.spellcheck = false;
  key.placeholder = hasApiKey === true ? '留空保持现有密钥' : '未设置密钥';
  const badge = element(
    'span',
    'badge',
    hasApiKey === true ? `已保存${typeof keyLast4 === 'string' ? ` …${keyLast4}` : ''}` : '未设置密钥',
  );
  const clearLabel = element('label', 'check');
  const clear = input('checkbox');
  clearLabel.append(clear, element('span', '', '清除密钥'));
  wrap.append(key, badge, clearLabel);
  return { wrap, key, clear, clearLabel };
}

function readKey(editor) {
  if (editor.clear.checked) return null;
  return editor.key.value === '' ? undefined : editor.key.value;
}

function createEndpointEditor(entry) {
  const row = element('div', 'endpoint-row');
  const name = input('text', entry.name);
  const provider = input('text', entry.provider);
  const baseUrl = input('text', entry.baseUrl);
  const tier = document.createElement('select');
  for (const value of ['flash', 'pro', 'both']) {
    const option = element('option', '', value);
    option.value = value;
    tier.append(option);
  }
  tier.value = entry.tier === 'flash' || entry.tier === 'pro' ? entry.tier : 'both';
  const flashModel = input('text', entry.flashModel);
  const proModel = input('text', entry.proModel);
  const enabled = input('checkbox');
  enabled.checked = entry.enabled === true;
  const secret = secretField(entry.hasApiKey === true, entry.keyLast4);
  // 远程端点不允许空密钥，勾选「清除密钥」只会换来一个无效字段错误：
  // 非回环地址直接隐藏该选项，避免走进死胡同。
  const syncClear = () => {
    const loopback = isLoopbackUrl(baseUrl.value.trim());
    secret.clearLabel.hidden = !loopback;
    secret.clear.disabled = !loopback;
    if (!loopback && secret.clear.checked) secret.clear.checked = false;
  };
  baseUrl.addEventListener('input', syncClear);
  syncClear();
  const remove = element('button', 'secondary danger', '删除');
  remove.type = 'button';

  const editor = {
    name,
    provider,
    baseUrl,
    tier,
    flashModel,
    proModel,
    enabled,
    key: secret.key,
    clear: secret.clear,
  };
  remove.addEventListener('click', () => {
    row.remove();
    endpointEditors = endpointEditors.filter((candidate) => candidate !== editor);
  });

  row.append(
    field('名称', name),
    field('Provider', provider),
    field('Base URL', baseUrl),
    field('档位', tier),
    field('Flash 模型', flashModel),
    field('Pro 模型', proModel),
    field('启用', enabled),
    secret.wrap,
    remove,
  );
  return { row, editor };
}

function createServiceEditor(spec, section) {
  const card = element('div', 'card');
  const head = element('div', 'panel-head');
  head.append(
    element('h3', '', spec.title),
    element('span', 'badge', section === undefined ? '未配置' : '已配置'),
  );
  card.append(head);

  const grid = element('div', 'endpoint-row');
  const baseUrl = input('text', section?.baseUrl ?? '');
  baseUrl.placeholder = 'https://…';
  const pathValue = input('text', section?.path ?? '');
  pathValue.placeholder = '留空使用默认路径';
  const model = input('text', section?.model ?? '');
  const enabled = input('checkbox');
  enabled.checked = section?.enabled === true;
  const secret = secretField(section?.hasApiKey === true, section?.keyLast4);

  const extras = {};
  grid.append(
    field('Base URL', baseUrl),
    field('路径', pathValue),
    field('模型', model),
    field('启用', enabled),
    secret.wrap,
  );
  for (const extra of spec.extras) {
    const control = input(extra.type, section?.[extra.key] ?? '');
    extras[extra.key] = control;
    grid.append(field(extra.label, control));
  }
  card.append(grid);

  serviceEditors[spec.name] = {
    name: spec.name,
    baseUrl,
    path: pathValue,
    model,
    enabled,
    key: secret.key,
    clear: secret.clear,
    extras,
    wasConfigured: section !== undefined,
  };
  return card;
}

function renderModels(models) {
  currentModels = models !== null && typeof models === 'object' ? models : null;
  endpointEditors = [];
  endpointRows.replaceChildren();
  serviceSections.replaceChildren();
  for (const name of Object.keys(serviceEditors)) delete serviceEditors[name];

  const endpoints = Array.isArray(currentModels?.endpoints) ? currentModels.endpoints : [];
  if (endpoints.length === 0) {
    endpointRows.append(element('p', 'hint', '尚未配置任何 chat 端点。'));
  }
  for (const entry of endpoints) {
    const { row, editor } = createEndpointEditor(entry);
    endpointRows.append(row);
    endpointEditors.push(editor);
  }

  for (const spec of SERVICE_SECTIONS) {
    serviceSections.append(createServiceEditor(spec, currentModels?.[spec.name]));
  }
}

function buildCandidate() {
  const endpoints = endpointEditors.map((editor) => {
    const entry = {
      name: editor.name.value.trim(),
      baseUrl: editor.baseUrl.value.trim(),
      enabled: editor.enabled.checked,
      tier: editor.tier.value,
      flashModel: editor.flashModel.value.trim(),
    };
    // 省略可选字段让 schema 用默认值（provider=unknown、proModel=flashModel）。
    const provider = editor.provider.value.trim();
    if (provider !== '') entry.provider = provider;
    const proModel = editor.proModel.value.trim();
    if (proModel !== '') entry.proModel = proModel;
    const key = readKey(editor);
    if (key !== undefined) entry.apiKey = key;
    return entry;
  });

  const candidate = {
    version: 1,
    importedFromEnv: currentModels?.importedFromEnv === true,
    endpoints,
  };

  for (const spec of SERVICE_SECTIONS) {
    const editor = serviceEditors[spec.name];
    if (editor === undefined) continue;
    const baseUrl = editor.baseUrl.value.trim();
    const model = editor.model.value.trim();
    // 未配置过的服务段在表单仍为空时不写入，避免保存出无效的空段。
    if (!editor.wasConfigured && baseUrl === '' && model === '') continue;
    const section = {
      baseUrl,
      model,
      enabled: editor.enabled.checked,
    };
    const pathValue = editor.path.value.trim();
    if (pathValue !== '') section.path = pathValue;
    const key = readKey(editor);
    if (key !== undefined) section.apiKey = key;
    for (const extra of spec.extras) {
      const control = editor.extras[extra.key];
      const raw = control === undefined ? '' : control.value.trim();
      if (raw === '') continue;
      if (extra.type === 'number') {
        const numeric = Number(raw);
        // 非数字原样提交，让服务端 schema 返回 invalid_field，而不是被 JSON 序列化成 null。
        section[extra.key] = Number.isFinite(numeric) ? numeric : raw;
      } else {
        section[extra.key] = raw;
      }
    }
    candidate[spec.name] = section;
  }

  return candidate;
}

function describeError(body) {
  if (body === null || typeof body !== 'object') return '请求失败';
  const code = typeof body.code === 'string' ? body.code : '请求失败';
  return typeof body.field === 'string' ? `${code} · ${body.field}` : code;
}

async function saveModels() {
  setText(modelsMessage, '保存中…');
  try {
    const response = await api('/api/models', {
      method: 'PUT',
      body: JSON.stringify(buildCandidate()),
    });
    const body = await response.json().catch(() => null);
    if (response.ok && body !== null && body.ok === true) {
      setText(modelsMessage, '已保存并热生效');
      await loadState();
      return;
    }
    setText(modelsMessage, describeError(body));
  } catch (error) {
    if (error.message !== 'unauthorized') setText(modelsMessage, '保存失败');
  }
}

/** 服务档只提交自己的段：端点表单里的空行不应阻塞 embedding/rerank/TTS/STT 测试。 */
function buildServiceDraft(tier) {
  const candidate = buildCandidate();
  const draft = { version: 1 };
  if (candidate[tier] !== undefined) draft[tier] = candidate[tier];
  return draft;
}

function describeProbe(body) {
  const parts = [];
  if (typeof body.errorKind === 'string') parts.push(body.errorKind);
  if (typeof body.code === 'string') parts.push(body.code);
  if (typeof body.field === 'string') parts.push(body.field);
  if (typeof body.status === 'number') parts.push(`HTTP ${body.status}`);
  if (typeof body.latencyMs === 'number') parts.push(`${body.latencyMs}ms`);
  if (typeof body.endpoint === 'string') parts.push(body.endpoint);
  if (typeof body.model === 'string') parts.push(body.model);
  return parts.join(' · ');
}

async function testTier(tier) {
  const out = element('div', 'test-result', `${tier}: 测试中…`);
  testResults.append(out);
  const chatTier = tier === 'flash' || tier === 'pro';
  try {
    const response = await api('/api/models/test', {
      method: 'POST',
      body: JSON.stringify({ tier, draft: chatTier ? buildCandidate() : buildServiceDraft(tier) }),
    });
    const body = await response.json().catch(() => null);
    if (response.ok && body !== null && body.ok === true) {
      out.textContent = `${tier}: ok · ${body.latencyMs}ms · ${body.endpoint}/${body.model}`;
      out.className = 'test-result ok';
      return;
    }
    const details = body === null ? '' : describeProbe(body);
    out.textContent = `${tier}: ${details === '' ? 'failed' : details}`;
    out.className = 'test-result bad';
  } catch (error) {
    out.textContent = `${tier}: 请求失败`;
    out.className = 'test-result bad';
  }
}

function conversationBadge(text) {
  return element('span', 'badge', text);
}

/** 全部字段经 textContent 渲染：对话内容是不可信数据。 */
function conversationRow(record) {
  const row = element('div', 'conv-row');
  const head = element('div', 'conv-head');
  head.append(
    conversationBadge(typeof record.ts === 'string' ? record.ts : ''),
    conversationBadge(record.direction === 'in' ? '入站' : '出站'),
    conversationBadge(typeof record.channel === 'string' ? record.channel : ''),
  );
  if (typeof record.status === 'string') head.append(conversationBadge(record.status));
  if (typeof record.actor === 'string') head.append(conversationBadge(`actor: ${record.actor}`));
  if (typeof record.kind === 'string') head.append(conversationBadge(`kind: ${record.kind}`));
  if (typeof record.importance === 'number') {
    head.append(conversationBadge(`importance: ${record.importance}`));
  }

  let body = '';
  if (typeof record.content === 'string') body = record.content;
  else if (typeof record.text === 'string') body = record.text;
  else if (typeof record.reason === 'string') body = `blocked: ${record.reason}`;

  row.append(head, element('p', 'conv-body', body));
  return row;
}

/**
 * 加载对话：默认重载第一页；`{ append: true }` 用当前游标加载更早的一页
 * 并追加到列表末尾（不替换已有内容）。
 */
async function loadConversations(options) {
  const append = options !== undefined && options.append === true;
  const cursor = append ? convCursor : null;

  const params = new URLSearchParams();
  const limit = convLimit.value.trim();
  if (limit !== '') params.set('limit', limit);
  const channel = convChannel.value.trim();
  if (channel !== '') params.set('channel', channel);
  if (convDirection.value !== '') params.set('direction', convDirection.value);
  if (cursor !== null) params.set('cursor', cursor);
  const query = params.toString();

  setText(convMessage, '加载中…');
  try {
    const response = await api(`/api/conversations${query === '' ? '' : `?${query}`}`);
    const body = await response.json().catch(() => null);
    if (!response.ok || body === null || body.ok !== true) {
      if (!append) {
        convList.replaceChildren();
        convLoaded = 0;
        convCursor = null;
        if (convMore !== null) convMore.hidden = true;
      }
      // 追加失败时保留游标与按钮，让用户可以重试「加载更早」；错误信息照常显示。
      setText(convMessage, describeError(body));
      return;
    }

    const records = Array.isArray(body.records) ? body.records : [];
    if (!append) {
      convList.replaceChildren();
      convLoaded = 0;
    }
    for (const record of records) convList.append(conversationRow(record));
    convLoaded += records.length;
    convCursor = typeof body.nextCursor === 'string' ? body.nextCursor : null;
    if (convMore !== null) convMore.hidden = convCursor === null;

    if (convLoaded === 0) {
      setText(convMessage, '没有记录');
      return;
    }
    setText(convMessage, append ? `已加载 ${convLoaded} 条` : `共 ${records.length} 条`);
  } catch (error) {
    if (error.message !== 'unauthorized') setText(convMessage, '加载失败');
  }
}

function resetConversations() {
  convList.replaceChildren();
  convCursor = null;
  convLoaded = 0;
  if (convMore !== null) convMore.hidden = true;
  setText(convMessage, '');
}

/* ---------------- 计划页：全部字段经 textContent 渲染 ---------------- */

const PLAN_STATUS_LABELS = {
  done: '完成',
  active: '进行中',
  in_progress: '进行中',
  pending: '待开始',
};

function textOf(value, fallback) {
  return typeof value === 'string' && value !== '' ? value : fallback;
}

/**
 * 状态字符串来自服务端，可能是 `constructor`/`__proto__` 这类原型键；
 * 查表必须走 Object.hasOwn，不能直接用下标（会命中 Object.prototype）。
 */
function labelOf(labels, value) {
  return Object.hasOwn(labels, value) ? labels[value] : value;
}

function safeClass(value) {
  return typeof value === 'string' ? value.replace(/[^a-z0-9_-]/gi, '') : 'unknown';
}

function planBadge(status) {
  const known = textOf(status, 'unknown');
  return element(
    'span',
    `badge status-${safeClass(known)}`,
    labelOf(PLAN_STATUS_LABELS, known),
  );
}

function renderPlan(plan) {
  planContent.replaceChildren();
  if (plan === null || typeof plan !== 'object') {
    setText(planMessage, '未提供计划');
    return;
  }
  setText(planMessage, '');

  const head = element('div', 'panel-head');
  head.append(element('h3', '', `当前：${textOf(plan.current, '—')}`));
  if (typeof plan.updatedAt === 'string') head.append(element('span', 'badge', plan.updatedAt));
  planContent.append(head);

  const milestones = Array.isArray(plan.milestones) ? plan.milestones : [];
  for (const milestone of milestones) {
    if (milestone === null || typeof milestone !== 'object') continue;
    const card = element('div', 'card');
    const title = element('div', 'panel-head');
    title.append(
      element('strong', '', `${textOf(milestone.id, '?')} · ${textOf(milestone.title, '')}`),
      planBadge(milestone.status),
    );
    card.append(title);

    const tasks = Array.isArray(milestone.tasks) ? milestone.tasks : [];
    if (tasks.length > 0) {
      const list = element('div', 'rows plan-tasks');
      for (const task of tasks) {
        if (task === null || typeof task !== 'object') continue;
        const row = element('div', 'plan-task');
        row.append(
          element('span', 'plan-task-id', textOf(task.id, '?')),
          element('span', 'plan-task-title', textOf(task.title, '')),
          planBadge(task.status),
        );
        list.append(row);
      }
      card.append(list);
    }
    planContent.append(card);
  }

  const backlog = Array.isArray(plan.backlog) ? plan.backlog : [];
  if (backlog.length > 0) {
    const card = element('div', 'card');
    card.append(element('h3', '', 'Backlog'));
    const list = element('ul', 'plan-backlog');
    for (const item of backlog) list.append(element('li', '', textOf(item, '')));
    card.append(list);
    planContent.append(card);
  }
}

async function loadPlan() {
  setText(planMessage, '加载中…');
  try {
    const response = await api('/api/plan');
    const body = await response.json().catch(() => null);
    if (!response.ok || body === null || body.ok !== true) {
      planContent.replaceChildren();
      setText(planMessage, describeError(body));
      return;
    }
    renderPlan(body.plan === undefined ? null : body.plan);
  } catch (error) {
    if (error.message !== 'unauthorized') setText(planMessage, '加载失败');
  }
}

function resetPlan() {
  planContent.replaceChildren();
  setText(planMessage, '');
}

/* ---------------- 架构页：文本框图 + 状态徽章 ---------------- */

const ARCH_STATE_LABELS = {
  ok: '正常',
  degraded: '降级',
  planned: '计划中',
  unknown: '未知',
};

function renderArchitecture(body) {
  archContent.replaceChildren();
  if (body === null || typeof body !== 'object') {
    setText(archMessage, '架构数据无效');
    return;
  }
  setText(archMessage, '');

  const nodes = Array.isArray(body.nodes) ? body.nodes : [];
  const status = body.status !== null && typeof body.status === 'object' ? body.status : {};
  const layers = new Map();
  for (const node of nodes) {
    if (node === null || typeof node !== 'object') continue;
    const layer = typeof node.layer === 'number' ? node.layer : 0;
    if (!layers.has(layer)) layers.set(layer, []);
    layers.get(layer).push(node);
  }

  const diagram = element('div', 'arch-diagram');
  for (const layer of [...layers.keys()].sort((a, b) => a - b)) {
    const row = element('div', 'arch-layer');
    const boxes = element('div', 'arch-boxes');
    for (const node of layers.get(layer)) {
      const box = element('div', 'arch-box');
      if (node.planned === true) box.classList.add('planned');
      box.append(
        element('div', 'arch-title', textOf(node.label, textOf(node.id, '?'))),
        element('div', 'arch-id', textOf(node.id, '')),
      );
      const nodeStatus = status[node.id];
      if (nodeStatus !== null && typeof nodeStatus === 'object') {
        const state = textOf(nodeStatus.state, 'unknown');
        const detail = textOf(nodeStatus.detail, '');
        box.append(
          element(
            'span',
            `badge arch-status status-${safeClass(state)}`,
            `${labelOf(ARCH_STATE_LABELS, state)}${detail === '' ? '' : ` · ${detail}`}`,
          ),
        );
      }
      boxes.append(box);
    }
    row.append(element('div', 'arch-layer-label', `层 ${layer}`), boxes);
    diagram.append(row);
  }
  archContent.append(diagram);

  const edges = Array.isArray(body.edges) ? body.edges : [];
  if (edges.length > 0) {
    const card = element('div', 'card');
    card.append(element('h3', '', '连接'));
    for (const edge of edges) {
      if (edge === null || typeof edge !== 'object') continue;
      const label = textOf(edge.label, '');
      const planned = edge.planned === true ? ' · 计划' : '';
      card.append(
        element(
          'div',
          'arch-edge',
          `${textOf(edge.from, '?')} → ${textOf(edge.to, '?')}${label === '' ? '' : `（${label}）`}${planned}`,
        ),
      );
    }
    archContent.append(card);
  }
}

async function loadArchitecture() {
  setText(archMessage, '加载中…');
  try {
    const response = await api('/api/architecture');
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      archContent.replaceChildren();
      setText(archMessage, describeError(body));
      return;
    }
    renderArchitecture(body);
  } catch (error) {
    if (error.message !== 'unauthorized') setText(archMessage, '加载失败');
  }
}

function resetArchitecture() {
  archContent.replaceChildren();
  setText(archMessage, '');
}

/* ---------------- 控制页：审批卡片 + 运行闸门 + 指令框 ---------------- */

/** TTL 倒计时；无效日期显示 `—`，到期显示「已过期」。 */
function formatRemaining(expiresAt, now) {
  const deadline = Date.parse(expiresAt);
  if (!Number.isFinite(deadline)) return '—';
  const remaining = deadline - now;
  if (remaining <= 0) return '已过期';
  const totalSeconds = Math.ceil(remaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `剩余 ${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** 运行闸门：全局静默、按群静默、平台派生的观察期分开显示。 */
function renderControlGates(status) {
  controlGates.replaceChildren();
  if (status === null || typeof status !== 'object') {
    controlGates.append(element('p', 'hint', '状态不可用'));
    return;
  }

  const quiet = status.quiet !== null && typeof status.quiet === 'object' ? status.quiet : null;
  controlGates.append(
    element(
      'div',
      'gate-row',
      quiet !== null && quiet.active === true
        ? `全局静默至 ${textOf(quiet.until, '')}`
        : '全局未静默',
    ),
  );

  const groups = Array.isArray(status.groups) ? status.groups : [];
  for (const group of groups) {
    if (group === null || typeof group !== 'object') continue;
    controlGates.append(
      element(
        'div',
        'gate-row',
        `群 ${textOf(group.groupId, '?')} 静默至 ${textOf(group.silencedUntil, '')}`,
      ),
    );
  }

  const observing = Array.isArray(status.observing) ? status.observing : [];
  for (const group of observing) {
    if (group === null || typeof group !== 'object') continue;
    controlGates.append(
      element(
        'div',
        'gate-row',
        `群 ${textOf(group.groupId, '?')} 观察至 ${textOf(group.observingUntil, '')}`,
      ),
    );
  }

  if (groups.length === 0 && observing.length === 0) {
    controlGates.append(element('p', 'hint', '没有处于静默或观察期的群。'));
  }
}

/**
 * 审批卡片。全部字段经 textContent 渲染：标题/摘要/错误文本都来自服务端
 * 投影，但仍是不可信内容。摘要由服务端从 payload 重渲染。
 */
function renderControl(status, records) {
  renderControlGates(status);
  controlApprovals.replaceChildren();
  controlCountdowns = [];
  controlActionButtons.clear();

  const list = Array.isArray(records) ? records : [];
  if (list.length === 0) {
    controlApprovals.append(element('p', 'hint', '没有待审批。'));
    return;
  }

  const now = Date.now();
  for (const record of list) {
    if (record === null || typeof record !== 'object') continue;
    const id = typeof record.id === 'string' ? record.id : '';
    const card = element('div', 'card control-card');

    const head = element('div', 'panel-head');
    head.append(
      element('h3', '', textOf(record.title, '?')),
      element('span', 'badge', textOf(record.kind, '')),
    );

    const countdown = element(
      'span',
      'badge control-countdown',
      formatRemaining(record.expiresAt, now),
    );
    controlCountdowns.push({ node: countdown, expiresAt: record.expiresAt });

    const meta = element('div', 'control-meta');
    meta.append(
      countdown,
      element('span', 'badge', `创建于 ${textOf(record.createdAt, '')}`),
      element('span', 'badge', `来源 ${textOf(record.createdVia, '')}`),
    );

    const actions = element('div', 'button-row');
    const approve = element('button', '', '批准');
    approve.type = 'button';
    approve.addEventListener('click', () => {
      if (id !== '') void decideApproval(id, 'approve');
    });
    const deny = element('button', 'secondary danger', '拒绝');
    deny.type = 'button';
    deny.addEventListener('click', () => {
      if (id !== '') void decideApproval(id, 'deny');
    });
    if (controlPendingDecisions.has(id)) {
      approve.disabled = true;
      deny.disabled = true;
    }
    controlActionButtons.set(id, [approve, deny]);
    actions.append(approve, deny);

    card.append(head, element('p', 'control-summary', textOf(record.summary, '')), meta, actions);
    controlApprovals.append(card);
  }
}

/** 倒计时每秒只改 textContent，不重建卡片。 */
function tickControlCountdowns() {
  const now = Date.now();
  for (const entry of controlCountdowns) {
    setText(entry.node, formatRemaining(entry.expiresAt, now));
  }
}

async function loadControl() {
  const seq = ++controlLoadSeq;
  setText(controlMessage, '加载中…');
  try {
    const [controlResponse, approvalsResponse] = await Promise.all([
      api('/api/control'),
      api('/api/approvals?status=pending&limit=100'),
    ]);
    const controlBody = await controlResponse.json().catch(() => null);
    const approvalsBody = await approvalsResponse.json().catch(() => null);

    // 决策或重置已经发生：这份响应来自旧状态，绝不能覆盖更新的卡片。
    if (seq !== controlLoadSeq) return;

    if (!controlResponse.ok || controlBody === null || controlBody.ok !== true) {
      controlApprovals.replaceChildren();
      controlCountdowns = [];
      renderControlGates(null);
      setText(controlMessage, describeError(controlBody));
      return;
    }

    const records =
      approvalsResponse.ok &&
      approvalsBody !== null &&
      approvalsBody.ok === true &&
      Array.isArray(approvalsBody.records)
        ? approvalsBody.records
        : [];
    renderControl(controlBody.status, records);
    if (!approvalsResponse.ok || approvalsBody === null || approvalsBody.ok !== true) {
      setText(controlMessage, `审批加载失败：${describeError(approvalsBody)}`);
      return;
    }
    const pending =
      approvalsBody !== null && typeof approvalsBody === 'object' ? approvalsBody.pending : null;
    setText(controlMessage, typeof pending === 'number' ? `待审批 ${pending} 条` : '');
  } catch (error) {
    if (error.message !== 'unauthorized') setText(controlMessage, '加载失败');
  }
}

async function decideApproval(id, decision) {
  // 双击/重复点击只发一次请求：第一次的结果（含 not_pending）必须保留。
  if (controlPendingDecisions.has(id)) return;
  controlPendingDecisions.add(id);
  // 决策是本地变更：让所有在途轮询响应失效，避免它们把卡片画回 pending。
  controlLoadSeq += 1;
  const buttons = controlActionButtons.get(id) ?? [];
  for (const button of buttons) button.disabled = true;

  setText(controlMessage, '提交中…');
  try {
    const response = await api('/api/approvals/decide', {
      method: 'POST',
      body: JSON.stringify({ id, decision }),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || body === null || body.ok !== true) {
      // wrong_channel / not_pending 等域错误都是 200 + 稳定错误码。
      setText(controlMessage, describeError(body));
      return;
    }
    setText(controlMessage, decision === 'approve' ? '已批准' : '已拒绝');
    await loadControl();
  } catch (error) {
    if (error.message !== 'unauthorized') setText(controlMessage, '提交失败');
  } finally {
    controlPendingDecisions.delete(id);
    // 失败后允许重试；成功后卡片已被 loadControl 重建，旧按钮自然失效。
    for (const button of buttons) button.disabled = false;
  }
}

async function sendControlCommand() {
  const text = controlCommandInput.value.trim();
  if (text === '') return;
  setText(controlCommandReply, '发送中…');
  try {
    const response = await api('/api/control/command', {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || body === null || body.ok !== true) {
      // 被拒绝的命令带稳定错误码，也带回执文本（例如「未知插件 …」）；
      // 优先显示回执，纯协议错误才退回到错误码。
      const detail =
        body !== null &&
        typeof body === 'object' &&
        typeof body.reply === 'string' &&
        body.reply !== ''
          ? body.reply
          : describeError(body);
      setText(controlCommandReply, detail);
      return;
    }
    controlCommandInput.value = '';
    setText(controlCommandReply, textOf(body.reply, '已执行'));
    await loadControl();
  } catch (error) {
    if (error.message !== 'unauthorized') setText(controlCommandReply, '发送失败');
  }
}

/** 只有控制页可见时才轮询；切走或登出立即清定时器。 */
function startControlPolling() {
  stopControlPolling();
  controlPollTimer = setInterval(() => {
    if (document.visibilityState === 'hidden') return;
    void loadControl();
  }, CONTROL_POLL_MS);
  controlCountdownTimer = setInterval(() => {
    if (document.visibilityState === 'hidden') return;
    tickControlCountdowns();
  }, CONTROL_COUNTDOWN_MS);
}

function stopControlPolling() {
  if (controlPollTimer !== null) {
    clearInterval(controlPollTimer);
    controlPollTimer = null;
  }
  if (controlCountdownTimer !== null) {
    clearInterval(controlCountdownTimer);
    controlCountdownTimer = null;
  }
}

function resetControl() {
  stopControlPolling();
  // 让登出前发起的请求全部失效，不能在登录页把旧卡片画回来。
  controlLoadSeq += 1;
  controlCountdowns = [];
  controlPendingDecisions.clear();
  controlActionButtons.clear();
  controlApprovals.replaceChildren();
  controlGates.replaceChildren();
  setText(controlMessage, '');
  setText(controlCommandReply, '');
  controlCommandInput.value = '';
}

/* ---------------- 对话页：内存缓冲 + 按 seq 增量轮询 ---------------- */

/**
 * 追加消息并返回新增条数。全部字段经 textContent 渲染；`seq` 不大于游标
 * 的条目是重复响应，直接丢弃（轮询与发送后的立即加载会重叠）。
 */
function renderChatMessages(messages) {
  if (!Array.isArray(messages)) return 0;
  let added = 0;
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue;
    const seq = message.seq;
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq <= chatLastSeq) continue;
    chatLastSeq = seq;
    const role = message.role === 'agent' ? 'agent' : 'owner';
    const row = element('div', `chat-row chat-${role}`);
    const head = element('div', 'chat-head');
    head.append(
      element('span', 'badge', role === 'agent' ? '它' : '我'),
      element('span', 'badge', typeof message.ts === 'string' ? message.ts : ''),
    );
    row.append(
      head,
      element('p', 'chat-text', typeof message.text === 'string' ? message.text : ''),
    );
    chatList.append(row);
    added += 1;
  }
  // 假 DOM/测试环境没有布局信息：只在真浏览器里滚到底。
  if (typeof chatList.scrollHeight === 'number') chatList.scrollTop = chatList.scrollHeight;
  return added;
}

/**
 * 加载对话。首次（游标为 0）取最近 200 条；之后只取 after=游标 的增量。
 * 服务重启后 seq 从头开始：服务端 lastSeq 比本地游标小就清空重载。
 */
async function loadChat() {
  const seq = ++chatLoadSeq;
  const query = chatLastSeq > 0 ? `?after=${chatLastSeq}` : '';
  try {
    const response = await api(`/api/chat/messages${query}`);
    const body = await response.json().catch(() => null);
    if (seq !== chatLoadSeq) return;
    if (!response.ok || body === null || body.ok !== true) {
      setText(chatMessage, describeError(body));
      return;
    }

    const lastSeq =
      typeof body.lastSeq === 'number' && Number.isSafeInteger(body.lastSeq) ? body.lastSeq : 0;
    if (lastSeq < chatLastSeq) {
      // 服务重启：旧的 seq 空间已不存在，清空后重新取一页。
      chatLastSeq = 0;
      chatList.replaceChildren();
      await loadChat();
      return;
    }

    renderChatMessages(body.messages);
    if (lastSeq > chatLastSeq) chatLastSeq = lastSeq;
    setText(chatMessage, '');
  } catch (error) {
    if (error.message !== 'unauthorized' && seq === chatLoadSeq) {
      setText(chatMessage, '加载失败');
    }
  }
}

async function sendChat() {
  const text = chatInput.value;
  if (chatSending || text.trim() === '') return;
  chatSending = true;
  setText(chatMessage, '发送中…');
  try {
    const response = await api('/api/chat/messages', {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || body === null || body.ok !== true) {
      // empty / too_long / closed 都带稳定错误码；输入保留，便于修正后重发。
      setText(chatMessage, describeError(body));
      return;
    }
    chatInput.value = '';
    setText(chatMessage, '');
    await loadChat();
  } catch (error) {
    if (error.message !== 'unauthorized') setText(chatMessage, '发送失败');
  } finally {
    chatSending = false;
  }
}

/** 只有对话页可见时才轮询；切走、页面隐藏或登出立即清定时器。 */
function startChatPolling() {
  stopChatPolling();
  chatPollTimer = setInterval(() => {
    if (document.visibilityState === 'hidden') return;
    void loadChat();
  }, CHAT_POLL_MS);
}

function stopChatPolling() {
  if (chatPollTimer !== null) {
    clearInterval(chatPollTimer);
    chatPollTimer = null;
  }
}

function resetChat() {
  stopChatPolling();
  // 让登出前发起的请求全部失效，不能在登录页把旧消息画回来。
  chatLoadSeq += 1;
  chatLastSeq = 0;
  chatSending = false;
  chatList.replaceChildren();
  setText(chatMessage, '');
  chatInput.value = '';
}

/* ---------------- 设置页：分区折叠 + 掩码密钥三态 ---------------- */

/** 该路径（或它的子路径）是否被 API 标记为「需重启」。 */
function settingsRequiresRestart(path) {
  for (const field of settingsRestartFields) {
    if (field === path || field.startsWith(`${path}.`) || path.startsWith(`${field}.`)) {
      return true;
    }
  }
  return false;
}

/** 分区内是否有任何字段需重启：折叠状态下也能看到提示。 */
function settingsSectionNeedsRestart(prefix) {
  for (const field of settingsRestartFields) {
    if (field === prefix || field.startsWith(`${prefix}.`)) return true;
  }
  return false;
}

function settingsControl(path, type, value) {
  const control = input(type, value);
  control.id = `settings-${path.replace(/\./g, '-')}`;
  settingsControls[path] = control;
  return control;
}

/** 字段包装：标签 + 控件 + 行内错误；错误节点按字段路径登记。 */
function settingsField(labelText, control, path) {
  const wrap = element('label', 'field');
  const head = element('span', 'field-label');
  head.append(element('span', '', labelText));
  if (settingsRequiresRestart(path)) {
    head.append(element('span', 'badge restart', '需重启'));
  }
  const error = element('span', 'field-error');
  wrap.append(head, control, error);
  settingsFieldErrors.set(path, error);
  return wrap;
}

function settingsAddText(container, path, label, value) {
  const control = settingsControl(path, 'text', value);
  container.append(settingsField(label, control, path));
  return control;
}

function settingsAddNumber(container, path, label, value) {
  const control = settingsControl(path, 'number', value);
  container.append(settingsField(label, control, path));
  return control;
}

function settingsAddCheckbox(container, path, label, value) {
  const control = settingsControl(path, 'checkbox');
  control.checked = value === true;
  container.append(settingsField(label, control, path));
  return control;
}

/** 名单字段用逗号分隔的文本输入；空项被丢弃。 */
function settingsAddList(container, path, label, value) {
  const joined = Array.isArray(value) ? value.join(', ') : '';
  const control = settingsControl(path, 'text', joined);
  control.placeholder = '逗号分隔';
  container.append(settingsField(label, control, path));
  return control;
}

function settingsGroup(title, description, prefix, body) {
  const details = element('details', 'settings-group');
  const summary = element('summary', 'settings-summary');
  summary.append(element('span', '', title));
  if (settingsSectionNeedsRestart(prefix)) {
    summary.append(element('span', 'badge restart', '需重启生效'));
  }
  details.append(summary);
  if (description !== '') details.append(element('p', 'hint', description));
  details.append(body);
  return details;
}

/**
 * 密钥字段只显示「已设置 · 末四位」；真值永不进 DOM。
 * 「替换」才显示输入框；「清除」提交 null；两者都不动时缺省保持原值。
 */
function settingsSecretField(qq) {
  const wrap = element('div', 'field');
  const head = element('span', 'field-label', 'WebSocket token');
  if (settingsRequiresRestart('qq.wsToken')) {
    head.append(element('span', 'badge restart', '需重启'));
  }

  let badgeText = '未设置';
  if (qq.hasWsToken === true) {
    badgeText =
      typeof qq.wsTokenLast4 === 'string'
        ? `已设置 · 末四位 ${qq.wsTokenLast4}`
        : '已设置';
  }
  const badge = element('span', 'badge', badgeText);

  const tokenInput = input('password');
  tokenInput.id = 'settings-token-input';
  tokenInput.autocomplete = 'new-password';
  tokenInput.spellcheck = false;
  tokenInput.placeholder = '输入新 token';
  tokenInput.hidden = true;

  const replace = element('button', 'secondary', '替换');
  replace.type = 'button';
  replace.id = 'settings-token-replace';
  replace.addEventListener('click', beginTokenReplace);

  const clear = element('button', 'secondary danger', '清除');
  clear.type = 'button';
  clear.id = 'settings-token-clear';
  clear.addEventListener('click', clearToken);

  const actions = element('div', 'button-row');
  actions.append(replace, clear);

  const error = element('span', 'field-error');
  settingsFieldErrors.set('qq.wsToken', error);

  settingsTokenInput = tokenInput;
  settingsTokenBadge = badge;
  wrap.append(head, badge, tokenInput, actions, error);
  return wrap;
}

function beginTokenReplace() {
  settingsTokenMode = 'replace';
  if (settingsTokenInput !== null) {
    settingsTokenInput.hidden = false;
    settingsTokenInput.focus();
  }
  if (settingsTokenBadge !== null) setText(settingsTokenBadge, '输入新 token（保存后生效）');
}

function clearToken() {
  settingsTokenMode = 'clear';
  if (settingsTokenInput !== null) {
    settingsTokenInput.value = '';
    settingsTokenInput.hidden = true;
  }
  if (settingsTokenBadge !== null) setText(settingsTokenBadge, '已设置 · 保存后清除');
}

/** 返回 undefined 表示「不提交该键」，让服务端保留已存 token。 */
function settingsTokenCandidate() {
  if (settingsTokenMode === 'clear') return null;
  if (settingsTokenMode === 'replace') {
    const value = settingsTokenInput === null ? '' : settingsTokenInput.value;
    return value === '' ? undefined : value;
  }
  return undefined;
}

function settingsNumberValue(path) {
  const control = settingsControls[path];
  if (control === undefined) return undefined;
  const raw = control.value.trim();
  if (raw === '') return '';
  const numeric = Number(raw);
  // 非数字原样提交，让服务端 schema 返回 invalid_field，而不是被序列化成 null。
  return Number.isFinite(numeric) ? numeric : raw;
}

function settingsTextValue(path) {
  const control = settingsControls[path];
  return control === undefined ? undefined : control.value.trim();
}

function settingsBoolValue(path) {
  const control = settingsControls[path];
  return control === undefined ? undefined : control.checked === true;
}

function settingsListValue(path) {
  const control = settingsControls[path];
  if (control === undefined) return undefined;
  return control.value
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

function buildSettingsCandidate() {
  const qq = {
    enabled: settingsBoolValue('qq.enabled'),
    wsHost: settingsTextValue('qq.wsHost'),
    wsPort: settingsNumberValue('qq.wsPort'),
    ownerId: settingsTextValue('qq.ownerId'),
    selfId: settingsTextValue('qq.selfId'),
    controlEnabled: settingsBoolValue('qq.controlEnabled'),
    controlNl: settingsBoolValue('qq.controlNl'),
    nlMinConfidence: settingsNumberValue('qq.nlMinConfidence'),
    minReplyGapMs: settingsNumberValue('qq.minReplyGapMs'),
    groupAllowlist: settingsListValue('qq.groupAllowlist'),
    groupDenylist: settingsListValue('qq.groupDenylist'),
    privateAllowlist: settingsListValue('qq.privateAllowlist'),
    privateDenylist: settingsListValue('qq.privateDenylist'),
    privateOpen: settingsBoolValue('qq.privateOpen'),
    proactive: {
      enabled: settingsBoolValue('qq.proactive.enabled'),
      minGapMs: settingsNumberValue('qq.proactive.minGapMs'),
      dailyMax: settingsNumberValue('qq.proactive.dailyMax'),
      quietStart: settingsTextValue('qq.proactive.quietStart'),
      quietEnd: settingsTextValue('qq.proactive.quietEnd'),
      intervalMs: settingsNumberValue('qq.proactive.intervalMs'),
    },
  };
  const token = settingsTokenCandidate();
  if (token !== undefined) qq.wsToken = token;

  return {
    version: 1,
    importedFromEnv: currentSettings?.importedFromEnv === true,
    tick: {
      fastMs: settingsNumberValue('tick.fastMs'),
      slowMs: settingsNumberValue('tick.slowMs'),
      wakeDebounceMs: settingsNumberValue('tick.wakeDebounceMs'),
    },
    http: { timeoutMs: settingsNumberValue('http.timeoutMs') },
    redline: { fallbackText: settingsTextValue('redline.fallbackText') },
    qq,
    capability: { autoActivate: settingsBoolValue('capability.autoActivate') },
  };
}

/** 渲染 GET /api/settings 的响应；掩码字段只进展示，绝不进候选值。 */
function renderSettings(body) {
  const payload = body !== null && typeof body === 'object' ? body : {};
  const config =
    payload.config !== null && typeof payload.config === 'object' ? payload.config : null;

  currentSettings = config;
  settingsRevision = typeof payload.revision === 'string' ? payload.revision : null;
  settingsControls = {};
  settingsFieldErrors.clear();
  settingsRestartFields = new Set(
    Array.isArray(payload.requiresRestart)
      ? payload.requiresRestart.filter((entry) => typeof entry === 'string')
      : [],
  );
  settingsTokenMode = 'keep';
  settingsTokenInput = null;
  settingsTokenBadge = null;
  settingsSections.replaceChildren();

  if (config === null) {
    saveSettingsButton.disabled = true;
    settingsSections.append(element('p', 'hint', '配置尚未加载。'));
    return;
  }

  // 首次导入的说明在加载时就显示，而不是等一次 PUT 之后才出现。
  if (payload.importedFromEnv === true) {
    settingsSections.append(
      element(
        'p',
        'hint',
        '配置由旧环境变量首次导入；现在以 config/harness.json 为准，QQ_* 环境变量不再生效。',
      ),
    );
  }

  // 控件齐了才允许保存；GET 失败时按钮保持禁用（见 loadSettings）。
  saveSettingsButton.disabled = false;

  const tick = config.tick ?? {};
  const tickBody = element('div', 'settings-grid');
  settingsAddNumber(tickBody, 'tick.fastMs', 'fastMs（毫秒）', tick.fastMs);
  settingsAddNumber(tickBody, 'tick.slowMs', 'slowMs（毫秒）', tick.slowMs);
  settingsAddNumber(
    tickBody,
    'tick.wakeDebounceMs',
    'wakeDebounceMs（毫秒）',
    tick.wakeDebounceMs,
  );
  settingsSections.append(
    settingsGroup('心跳', '下一次 tick / 唤醒即读取，无需重启。', 'tick', tickBody),
  );

  const httpConfig = config.http ?? {};
  const httpBody = element('div', 'settings-grid');
  settingsAddNumber(httpBody, 'http.timeoutMs', 'HTTP 超时（毫秒）', httpConfig.timeoutMs);
  settingsSections.append(
    settingsGroup('网络', '下一次模型请求即使用新超时。', 'http', httpBody),
  );

  const redline = config.redline ?? {};
  const redlineBody = element('div', 'settings-grid');
  settingsAddText(redlineBody, 'redline.fallbackText', '兜底话术', redline.fallbackText);
  settingsSections.append(
    settingsGroup('红线', '下一条被拦回复即使用新话术。', 'redline', redlineBody),
  );

  const qq = config.qq ?? {};
  const qqBody = element('div', 'settings-grid');
  settingsAddCheckbox(qqBody, 'qq.enabled', '启用 QQ 渠道', qq.enabled);
  settingsAddCheckbox(qqBody, 'qq.controlEnabled', '控制面启用', qq.controlEnabled);
  settingsAddCheckbox(qqBody, 'qq.controlNl', '自然语言控制', qq.controlNl);
  settingsAddCheckbox(qqBody, 'qq.privateOpen', '私聊开放', qq.privateOpen);
  settingsAddText(qqBody, 'qq.wsHost', 'WebSocket host', qq.wsHost);
  settingsAddNumber(qqBody, 'qq.wsPort', 'WebSocket 端口（0 = 临时）', qq.wsPort);
  settingsAddText(qqBody, 'qq.ownerId', 'owner QQ 号', qq.ownerId);
  settingsAddText(qqBody, 'qq.selfId', 'self QQ 号', qq.selfId);
  settingsAddNumber(qqBody, 'qq.nlMinConfidence', 'NL 最低置信度（0–1）', qq.nlMinConfidence);
  settingsAddNumber(qqBody, 'qq.minReplyGapMs', '最小回复间隔（毫秒）', qq.minReplyGapMs);
  settingsAddList(qqBody, 'qq.groupAllowlist', '群白名单', qq.groupAllowlist);
  settingsAddList(qqBody, 'qq.groupDenylist', '群黑名单', qq.groupDenylist);
  settingsAddList(qqBody, 'qq.privateAllowlist', '私聊白名单', qq.privateAllowlist);
  settingsAddList(qqBody, 'qq.privateDenylist', '私聊黑名单', qq.privateDenylist);
  qqBody.append(settingsSecretField(qq));

  const proactive = qq.proactive ?? {};
  const proactiveBody = element('div', 'settings-grid');
  settingsAddCheckbox(
    proactiveBody,
    'qq.proactive.enabled',
    '启用主动私聊',
    proactive.enabled,
  );
  settingsAddNumber(
    proactiveBody,
    'qq.proactive.minGapMs',
    '最小间隔（毫秒）',
    proactive.minGapMs,
  );
  settingsAddNumber(proactiveBody, 'qq.proactive.dailyMax', '每日上限', proactive.dailyMax);
  settingsAddText(
    proactiveBody,
    'qq.proactive.quietStart',
    '静默开始（HH:MM）',
    proactive.quietStart,
  );
  settingsAddText(
    proactiveBody,
    'qq.proactive.quietEnd',
    '静默结束（HH:MM）',
    proactive.quietEnd,
  );
  settingsAddNumber(
    proactiveBody,
    'qq.proactive.intervalMs',
    '检查周期（毫秒）',
    proactive.intervalMs,
  );

  const qqContent = element('div', '');
  qqContent.append(qqBody, element('h3', '', '主动私聊'), proactiveBody);
  settingsSections.append(
    settingsGroup(
      'QQ',
      '保存后 QQ 渠道会重建（短暂断开）；护栏与审批状态不重置。',
      'qq',
      qqContent,
    ),
  );

  const capability = config.capability ?? {};
  const capabilityBody = element('div', 'settings-grid');
  settingsAddCheckbox(
    capabilityBody,
    'capability.autoActivate',
    '启动时自动激活能力插件',
    capability.autoActivate,
  );
  capabilityBody.append(
    element(
      'p',
      'hint',
      '这一项只在启动时读取：保存不会重建能力注册表，需重启 harness 后生效。',
    ),
  );
  settingsSections.append(
    settingsGroup(
      '能力',
      '自动激活是启动期决策，因此属于「需重启」项。',
      'capability',
      capabilityBody,
    ),
  );
}

function clearSettingsErrors() {
  for (const node of settingsFieldErrors.values()) node.textContent = '';
}

function showSettingsFieldError(path, text) {
  const node = settingsFieldErrors.get(path);
  if (node === undefined) return false;
  node.textContent = text;
  return true;
}

/** 测试与调试用：读取某个字段当前的行内错误。 */
function settingsFieldError(path) {
  const node = settingsFieldErrors.get(path);
  return node === undefined ? '' : node.textContent;
}

/** 测试与调试用：按字段路径取控件（动态节点不经过 document.getElementById）。 */
function settingsControlFor(path) {
  return settingsControls[path];
}

function settingsTokenControl() {
  return settingsTokenInput;
}

async function loadSettings() {
  const seq = ++settingsLoadSeq;
  try {
    const response = await api('/api/settings');
    const body = await response.json().catch(() => null);
    if (seq !== settingsLoadSeq) return;
    if (!response.ok || body === null || body.ok !== true) {
      saveSettingsButton.disabled = true;
      setText(settingsMessage, describeError(body));
      return;
    }
    renderSettings(body);
    setText(settingsMessage, '');
  } catch (error) {
    if (error.message !== 'unauthorized' && seq === settingsLoadSeq) {
      saveSettingsButton.disabled = true;
      setText(settingsMessage, '加载失败');
    }
  }
}

async function saveSettings() {
  // 没有成功加载过配置就没有可信的控件值：提交只会是一份全空文档。
  if (currentSettings === null) {
    setText(settingsMessage, '配置尚未加载，无法保存');
    return;
  }
  clearSettingsErrors();
  setText(settingsMessage, '保存中…');
  try {
    const response = await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ ...buildSettingsCandidate(), revision: settingsRevision }),
    });
    const body = await response.json().catch(() => null);
    if (response.ok && body !== null && body.ok === true) {
      await loadSettings();
      // loadSettings 成功时清空消息；失败时保留它写的错误。
      if (settingsMessage.textContent === '') setText(settingsMessage, '已保存并热生效');
      return;
    }
    // 409：磁盘已被另一标签页或更晚的保存改过。重新加载当前值，绝不覆盖。
    if (
      response.status === 409 ||
      (body !== null && typeof body === 'object' && body.code === 'conflict')
    ) {
      await loadSettings();
      setText(settingsMessage, '配置已被其他页面修改，已重新加载最新值');
      return;
    }
    const description = describeError(body);
    if (body !== null && typeof body === 'object' && typeof body.field === 'string') {
      showSettingsFieldError(body.field, description);
    }
    setText(settingsMessage, description);
  } catch (error) {
    if (error.message !== 'unauthorized') setText(settingsMessage, '保存失败');
  }
}

function resetSettings() {
  settingsLoadSeq += 1;
  currentSettings = null;
  settingsRevision = null;
  settingsControls = {};
  settingsFieldErrors.clear();
  settingsRestartFields = new Set();
  settingsTokenMode = 'keep';
  settingsTokenInput = null;
  settingsTokenBadge = null;
  settingsSections.replaceChildren();
  saveSettingsButton.disabled = true;
  setText(settingsMessage, '');
}

function showTab(name) {
  activeTab = name;
  for (const [key, entry] of Object.entries(TABS)) {
    const active = key === name;
    entry.tab.classList.toggle('active', active);
    entry.section.hidden = !active;
  }
  stopControlPolling();
  stopChatPolling();
  if (name === 'control') {
    void loadControl();
    startControlPolling();
    return;
  }
  if (name === 'chat') {
    void loadChat();
    startChatPolling();
    return;
  }
  if (name === 'settings') {
    void loadSettings();
    return;
  }
  if (name === 'conversations') void loadConversations();
  else if (name === 'plan') void loadPlan();
  else if (name === 'architecture') void loadArchitecture();
}

function resetModels() {
  currentModels = null;
  endpointEditors = [];
  endpointRows.replaceChildren();
  serviceSections.replaceChildren();
  // 编辑器持有旧会话的表单值：不清空的话，登录后的状态拉取失败仍能提交陈旧配置。
  for (const name of Object.keys(serviceEditors)) delete serviceEditors[name];
  testResults.replaceChildren();
  setText(modelsMessage, '');
}

function showLogin(message) {
  setText(loginMessage, message ?? '');
  setText(healthOut, '—');
  setText(stateOut, '—');
  resetModels();
  resetConversations();
  resetPlan();
  resetArchitecture();
  resetControl();
  resetChat();
  resetSettings();
  statusView.hidden = true;
  loginView.hidden = false;
  tokenInput.focus();
}

function showStatus() {
  setText(loginMessage, '');
  loginView.hidden = true;
  statusView.hidden = false;
}

async function api(path, options) {
  const settings = options ?? {};
  const method = settings.method ?? 'GET';
  const headers = { 'x-uuharness-console': '1' };
  if (settings.body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(path, {
    method,
    headers,
    body: settings.body,
    credentials: 'same-origin',
  });

  if (response.status === 401) {
    showLogin(SESSION_EXPIRED_MESSAGE);
    throw new Error('unauthorized');
  }
  return response;
}

async function renderJson(elementNode, response, fallback) {
  try {
    const body = await response.json();
    if (body !== null && typeof body === 'object' && body.code === 'not_implemented') {
      setText(elementNode, '该接口尚未实现');
      return;
    }
    setText(elementNode, JSON.stringify(body, null, 2));
  } catch {
    setText(elementNode, fallback);
  }
}

function renderState(body) {
  setText(stateOut, JSON.stringify(body, null, 2));
  renderModels(body !== null && typeof body === 'object' ? body.models : null);
}

async function loadHealth() {
  try {
    const response = await api('/api/health');
    await renderJson(healthOut, response, '健康检查失败');
  } catch (error) {
    if (error.message !== 'unauthorized') setText(healthOut, '健康检查失败');
  }
}

async function loadState() {
  try {
    const response = await api('/api/state');
    if (!response.ok) {
      setText(stateOut, '状态获取失败');
      return;
    }
    renderState(await response.json());
  } catch (error) {
    if (error.message !== 'unauthorized') setText(stateOut, '状态获取失败');
  }
}

async function loadStatus() {
  await loadHealth();
  await loadState();
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setText(loginMessage, '');

  const token = tokenInput.value;
  tokenInput.value = '';

  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-uuharness-console': '1' },
      body: JSON.stringify({ token }),
      credentials: 'same-origin',
    });

    if (response.status === 429) {
      setText(loginMessage, '尝试次数过多，请稍后再试');
      return;
    }
    if (!response.ok) {
      setText(loginMessage, 'token 无效');
      return;
    }

    showStatus();
    await loadStatus();
  } catch {
    setText(loginMessage, '无法连接服务');
  }
});

logoutButton.addEventListener('click', async () => {
  try {
    // logout 不读请求体：只带 CSRF 头和同源 Origin（fetch 自动附带）。
    await api('/api/logout', { method: 'POST' });
  } catch {
    /* 401 时 api() 已经切回登录页。 */
  }
  showLogin('');
});

refreshButton.addEventListener('click', () => {
  void loadStatus();
});

tabStatus.addEventListener('click', () => showTab('status'));
tabChat.addEventListener('click', () => showTab('chat'));
tabSettings.addEventListener('click', () => showTab('settings'));
tabModels.addEventListener('click', () => showTab('models'));
tabConversations.addEventListener('click', () => showTab('conversations'));
tabPlan.addEventListener('click', () => showTab('plan'));
tabArchitecture.addEventListener('click', () => showTab('architecture'));
tabControl.addEventListener('click', () => showTab('control'));
convRefresh.addEventListener('click', () => void loadConversations());
convMore.addEventListener('click', () => void loadConversations({ append: true }));
planRefresh.addEventListener('click', () => void loadPlan());
archRefresh.addEventListener('click', () => void loadArchitecture());
controlRefresh.addEventListener('click', () => void loadControl());
settingsRefresh.addEventListener('click', () => void loadSettings());
saveSettingsButton.addEventListener('click', () => void saveSettings());
controlCommandForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void sendControlCommand();
});
chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void sendChat();
});
saveModelsButton.addEventListener('click', () => void saveModels());
addEndpointButton.addEventListener('click', () => {
  const { row, editor } = createEndpointEditor({
    name: '',
    provider: '',
    baseUrl: '',
    enabled: true,
    tier: 'both',
    flashModel: '',
    proModel: '',
    hasApiKey: false,
  });
  endpointRows.append(row);
  endpointEditors.push(editor);
});

for (const tier of TEST_TIERS) {
  const button = element('button', 'secondary', `测试 ${tier}`);
  button.type = 'button';
  button.addEventListener('click', () => void testTier(tier));
  testButtons.append(button);
}

// 对话页只在页面可见时轮询：隐藏即清定时器，回到前台再补一次并重启。
// 假 DOM（测试）没有 addEventListener，缺省时跳过。
if (typeof document.addEventListener === 'function') {
  document.addEventListener('visibilitychange', () => {
    if (activeTab !== 'chat') return;
    if (document.visibilityState === 'hidden') {
      stopChatPolling();
      return;
    }
    void loadChat();
    startChatPolling();
  });
}

// 启动：先探活（免鉴权），再尝试读取状态；未登录时安静地显示登录页。
void (async () => {
  await loadHealth();
  try {
    const response = await fetch('/api/state', { credentials: 'same-origin' });
    if (response.status === 401) {
      showLogin('');
      return;
    }
    if (response.ok) {
      showStatus();
      renderState(await response.json());
    }
  } catch {
    showLogin('');
  }
})();
