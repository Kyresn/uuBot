# uuBot

一个跑在自己机器上的拟人化自主 agent：有心跳、有记忆、有人格，能自己上网、上 B 站、在 QQ 群里当群友。

> Personified, self-evolving agent harness in TypeScript. Heartbeat-driven autonomy, pluggable channels and capabilities, free LLM endpoints.

## 这是什么

uuBot 不是"收到消息才回复"的聊天机器人。它由**心跳循环**驱动：每隔几分钟自己醒来，看看有没有事要做——回消息、继续手头的事、上网闲逛，或者主动找人说话。消息只是唤醒信号，不是驱动力。

核心设计原则：

- **主动优先于被动**：不找它，它也会自己活动。
- **拟人优先于高效**：宁可慢半拍，也不要像个客服。
- **安全边界是代码不是提示词**：出站内容过代码级红线闸，不可信输入按数据处理。
- **核心小而稳，其余皆插件**：通道与能力可扩展，心跳/大脑/记忆/红线不可插件化。

## 当前状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| M1 | 心跳循环、CLI 渠道、多端点 LLM 故障转移、人格空白种子、代码级红线层 | ✅ 完成 |
| M2 加固 | 唤醒互斥与退避、中文红线、Unicode 规范化、端点健康排序、超时断路器 | ✅ 完成 |
| P1 | 插件宿主 + CLI 迁移为插件 | ✅ 完成 |
| P2 | 能力插件（worker 隔离）+ 工具调用 | ✅ 完成 |
| M2 QQ | NapCat / OneBot 11 接入 | ✅ 已接入 |
| M2.5 网页管理台 | 模型热生效、对话记录、计划页、架构页 | ✅ 完成 |
| M2b 控制面 | owner 私聊/网页指令、审批流水线、能力封禁、notice、红线拒绝改写、主动私聊（默认关闭） | ✅ 完成 |
| M2.6 网页主控制台 | 网页对话、全量配置（含密钥）热生效、设置页、`.env` 瘦身 | ✅ 完成 |
| M3+ | 记忆（Postgres + pgvector）、身体（shell / Playwright / B 站）、技能进化 | 计划中 |

## 快速开始

需要 Node.js 22+。

```bash
npm install
cp .env.example .env      # 至少填 WEB_CONSOLE_TOKEN
npm test                  # 全部测试（当前 1234）
npm run dev               # 启动；浏览器打开 http://127.0.0.1:3080
```

首次启动**不需要**先准备 `config/models.json`：网页会照常起来（「状态」页会提示尚未配置端点），在**模型**页添加一个端点即可，下一次心跳自动使用它。`.env` 只放引导项（`WEB_*`、`CONFIG_DIR`、`DATA_DIR`）；运行期配置在首次启动时创建为 `config/harness.json`，之后在网页「设置」页编辑、保存即热生效；详见下文「网页是主要界面」。

模型端点只来自 `config/models.json`：可以在网页「模型」页添加，或从旧 `.env` 的 `NIM_API_KEYS` / `AGNES_COM_API_KEY` / `AGNES_CN_API_KEY` 首次导入一次。端点走 OpenAI 兼容协议。默认模型 `deepseek-ai/deepseek-v4.1-flash`（NIM）与 `agnes-3.0-flash`（Agnes）。多端点自动故障转移，429 / 额度耗尽 / 超时会降级并退避。

## 网页是主要界面（M2.6）

M2.6 起，网页控制台是日常使用的主界面。CLI 与 QQ 渠道照常并存，但对话与配置都以网页为准。

八页：**状态**、**对话**、**设置**、**模型**、**记录**、**计划**、**架构**、**控制**。

- **对话**：在网页里直接和它说话。消息进同一条感知队列、走同一个心跳、同一道红线闸，回复出现在页面上。对话**只存在内存**（环形 500 条），harness 重启即清空，不写入记忆——持久化属于 M3。页面上也明写了这一点。
- **设置**：心跳、HTTP 超时、红线兜底话术、QQ 全部参数（含 `wsToken` / `ownerId` / 名单）、能力插件自动激活开关都在这里改。保存 = 干跑 → 原子写 → 热生效，失败不落盘，磁盘上永远是上一份合法配置：
  - `tick.*`、`http.timeoutMs`：下一次读取（下一次 tick / 请求）即生效；
  - `redline.fallbackText`：下一条被拦回复生效；
  - `qq.*`：保存后重建 QQ 渠道（NapCat 会短暂重连，重连前事件不产生）；
  - `capability.autoActivate`：下一次启动生效，页面上标「需重启」。打开后启动时会对每个 pending 的能力插件生成审批并**立即通过同一个 `ApprovalService` 批准**（`decidedVia:'system'`，审计照常），随后激活；默认关闭。
- **密钥三态**：`wsToken` 只显示「已设置 · 末四位」；打码值回传 400；缺省保持、`null` 清除、字符串替换。

### `.env` 只放引导项

`.env` 现在只剩网页监听与登录（`WEB_*`）、`CONFIG_DIR`、`DATA_DIR`，外加三个例外：`QQ_ACCOUNT`（只给 compose 的 NapCat 服务插值）与两个仍只从 env 读取的控制面 TTL（`CONTROL_CONFIRM_TTL_MS` / `CONTROL_APPROVAL_TTL_MS`）。其余运行期配置全部在 `config/harness.json`（首次启动自动创建；含 `wsToken`，权限 0600）。

> **迁移后 `QQ_*` 环境变量被忽略。** 首次启动时 `harness.json` 还不存在，旧 `.env` 里的 `QQ_*`、`TICK_*`、`WAKE_DEBOUNCE_MS`、`HTTP_TIMEOUT_MS`、`REDLINE_FALLBACK_TEXT` 会被**导入一次**并写进 `config/harness.json`。从此以后 `config/harness.json` 是唯一权威：继续改 `.env` 里的 `QQ_*` **不会生效**。两处都配时以文件为准，启动日志会打印一行「QQ config comes from harness.json; QQ_* env is ignored」。要改 QQ 参数，用网页「设置」页或直接编辑 `config/harness.json`。
>
> Docker 用户注意：`deploy/docker-compose.yml` 仍会把根目录 `.env` 注入容器，但这只在**首次导入**时有用；容器里已有 `config/harness.json` 后，compose 里的 `QQ_*`（例如 `QQ_WS_HOST=0.0.0.0`）同样被忽略。换部署方式后请在设置页核对 `qq.wsHost`。

### 从旧版本回来会注意到的两个变化（M2b）

- **能力插件不再自动激活**：启动时只为每个 pending 插件生成一条 `capability.activate` 审批（同一插件 + 同一指纹已有 pending 时不重复），批准后才 spawn worker。网页「控制」页能看到并处理。
- **能力插件 worker 不再继承 `process.env`**：worker 以 `env: {}` 启动，拿不到 `QQ_WS_TOKEN`、`WEB_CONSOLE_TOKEN` 与模型密钥；插件需要的一切通过 init 消息显式传入。

## QQ 接入

QQ 渠道通过 [NapCat](https://github.com/NapNeko/NapCatQQ)（OneBot 11 反向 WebSocket）接入。编排文件在 `deploy/`，harness 与 NapCat 只走内部 Docker 网络；NapCat 不映射任何宿主机端口，harness 只把网页管理台发布到宿主机回环地址（`127.0.0.1:${WEB_PORT:-3080}`，见下节）。

```bash
# 1. 在根目录 .env 里填 QQ_ACCOUNT（compose 插值给 NapCat 登录用）。
#    harness 侧的 QQ 参数在 config/harness.json：首次启动会从旧 .env 的 QQ_* 导入一次，
#    之后以文件为准；也可以在网页「设置」页填 qq.wsToken / qq.ownerId。
# 2. 启动（--env-file 让 compose 插值读到 QQ_ACCOUNT）
docker compose --env-file .env -f deploy/docker-compose.yml up -d
# 3. 从日志扫码登录，并按 deploy/napcat/README.md 配置反向 WS
docker compose -f deploy/docker-compose.yml logs -f napcat
```

- 反向 WS 地址：`ws://harness:3001/onebot/v11/ws`；token 在 NapCat WebUI 的网络配置里填写，值与 `config/harness.json` 的 `qq.wsToken` **完全一致**。`napcat` 服务只从 compose 拿到 `QQ_ACCOUNT`，不接收 harness 的 token——两处（WebUI 与 `harness.json`）改一处就要同步另一处，否则 NapCat 连不上（401/4001）。
- 扫码、WebUI、白名单与排障步骤见 [`deploy/napcat/README.md`](deploy/napcat/README.md)。
- **请使用专用小号**，不要用主号跑第三方协议端。

## 网页管理台

与心跳同进程运行的本地控制台，默认只监听回环地址：

```bash
# 1. 生成访问 token（至少 32 字符），写入 .env 的 WEB_CONSOLE_TOKEN
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
# 2. 启动
npm run dev
# 3. 打开 http://127.0.0.1:3080 并粘贴 token 登录
```

页面：**状态**（健康、端点健康快照、队列/静默轮数）、**对话**（网页聊天，内存缓冲、重启清空）、**设置**（全量配置热生效、密钥打码）、**模型**（编辑 `config/models.json`、热生效、分档连通性测试）、**记录**（`state/transcript.jsonl` 的入站/出站记录）、**计划**（`state/plan.json` 覆盖优先，否则入库的 `docs/plan.json`）、**架构**（静态节点/边 + 实时状态）、**控制**（待审批卡片、静默/观察状态、指令输入框）。

安全默认值：

- `WEB_HOST` 默认 `127.0.0.1`。要绑定非回环地址必须显式 `WEB_ALLOW_REMOTE=1`，否则网页服务拒绝启动（harness 其余部分照常运行）。
- 公网访问必须放在 **TLS 反向代理**之后：设置 `WEB_COOKIE_SECURE=1`，把浏览器看到的域名加入 `WEB_ALLOWED_HOSTS`（反代必须透传原始 `Host`）；只有反代确实覆盖 `X-Forwarded-For` 时才开 `WEB_TRUSTED_PROXY=1`。
- 会话 cookie 为 `HttpOnly` + `SameSite=Strict`；写请求另有自定义头 + Origin 校验。token 不写入浏览器存储。
- `config/models.json`（含 key）、`config/models.json.bak`、`config/harness.json`（含 `wsToken`）、`config/harness.json.bak`、`state/` 全部 gitignored。

Docker 部署时网页管理台只映射到宿主机回环地址（`127.0.0.1:${WEB_PORT:-3080}:${WEB_PORT:-3080}`），容器内监听 `0.0.0.0`。`WEB_PORT` 在容器内外是同一个端口：容器按它监听，宿主按它发布，healthcheck 也按它探活——改端口只需改这一个值。compose 会挂载 `../config` 与 `../state`；非 root 用户必须能写这两个目录：

```bash
mkdir -p config state
sudo chown -R "${HARNESS_UID:-1000}:${HARNESS_GID:-1000}" config state
docker compose --env-file .env -f deploy/docker-compose.yml up -d
```

健康检查用镜像内的 `node -e fetch(...)`（镜像无 curl），探活地址取自容器自己的 `WEB_PORT`。注意：**healthcheck 依赖网页管理台已启用**——`WEB_CONSOLE_TOKEN` 缺失或过弱时网页服务会按设计拒绝启动（harness 其余部分照常运行），此时 `/api/health` 无人监听，容器会一直显示 unhealthy。平台支持：Linux amd64/arm64、Windows amd64/arm64，全部走同一套 Node 22+ 代码路径；POSIX 专属差异只有文件权限位（Windows 忽略）与信号处理。

## 控制面与审批

owner 可以用 QQ 私聊或网页的**控制**页（见上文「网页管理台」）看状态、批/拒待办、封禁与解封能力插件、让某个群或全局安静。控制面默认跟随 `config/harness.json` 的 `qq.ownerId`：配置了 owner 就开启 QQ 控制面；未配置 owner 时 QQ 控制面关闭，但**网页控制面仍然可用**（没有 QQ 的安装也要能批准能力激活）。显式 `qq.controlEnabled: false` 才是总开关：网页控制路由返回 503 `control_disabled`，审批回执也不再私聊。这两个值首次启动时从 `QQ_OWNER_ID` / `QQ_CONTROL_ENABLED` 导入一次，之后以文件为准。

两个控制面 TTL 仍只从 env 读取（不在 `harness.json` 里）：`CONTROL_CONFIRM_TTL_MS`（二次确认窗口，默认 60000）与 `CONTROL_APPROVAL_TTL_MS`（其余人工审批，默认 600000）。

- **指令只来自 owner 私聊**：群消息、notice、转发/引用内容永不进入解析器；控制消息不进感知队列，不会被群 @ 洪泛挤掉。
- **前缀指令**：`#帮助` `#状态` `#审批 [id]` `#同意 <id>` `#拒绝 <id> [理由]` `#封禁 <插件>` `#解封 <插件>` `#安静 [群号] <分钟>` `#恢复 [群号]`。`#安静` 不带群号作用于全局（保留键 `'*'`）。
- **自然语言**（`qq.controlNl: true`）：只有有副作用的意图需要二次确认；确认必须带完整 `ap_` id，裸「确认」不批准任何动作。批准类动作**不可**由自然语言推断。

### 审批模型

`ApprovalService` 是唯一的状态机：`pending → approved → done|failed`，或 `pending → denied|expired|cancelled|stale`。QQ 私聊与网页共用同一个实例与 `DATA_DIR/approvals.json`。

- 文件只存 pending，≤200 条；损坏 = 全部作废（fail closed）。
- 重启后 pending 保留，但截止被压到 `now + 10min`；`approved` 记录只作审计，永不重放。
- 执行前重算能力插件的 manifest + entry 指纹，不符即 `stale`，不激活。
- `control.command`（自然语言二次确认）只能由发起它的那条 QQ 私聊决策；网页决策返回 `wrong_channel`。
- 审计流水写在 `DATA_DIR/control-audit.jsonl`：每条 owner 指令、每次审批决策与执行结果各一行（0600，16 MB 轮转 `.1`）。`approvals.json` 只留 pending，重启后靠它追责。

### 行为变化（M2b）

- **能力插件不再自动激活**：启动时对每个 pending 插件生成一条 `capability.activate` 审批（同一插件 + 同一指纹已有 pending 时不重复），批准后才 spawn worker。
- **封禁文件搬家**：`plugins/capabilities/bans.json` → `DATA_DIR/bans.json`。新路径不存在而旧路径存在时读旧路径一次并立即写新路径，此后只读新路径。**新路径存在但非法/不可读时拒绝激活任何能力插件**（旧实现静默当成「无封禁」，是 fail-open）。
- **worker 环境隔离**：能力插件 worker 以 `env: {}` 启动，不再继承 `QQ_WS_TOKEN`、`WEB_CONSOLE_TOKEN` 与模型密钥；插件需要的一切通过 init 消息显式传入。
- **红线拒绝改写上线**：命中红线后仍先记 `blocked`，再由模型在封闭模板集里选一个模板/语气，由代码拼装并二次过闸；失败用 `redline.fallbackText`（默认「这个我不聊。」）。改写回复只记一行 `dispatched`（`reason:'redline-rewrite'`）。
- **主动私聊默认关闭**（`qq.proactive.enabled: true` 才开启）：过六道闸（开关、owner 已知、QQ 已连接、队列空且无在途且非静默、距上次 ≥ 最小间隔、今日 < 日上限、不在静默时段）后才合成一次 tick；合成事件不写入对话记录，模型回「（不发言）」即静默。

### 安全边界（务必阅读）

1. **`qq.wsToken`（`config/harness.json`，首次从 `QQ_WS_TOKEN` 导入）是身份根**：持有它的人可以顶替 NapCat 连接、伪造 owner 私聊并收到审批回执。当前缓解是「可观测 + 不可逆动作需显式 id + 短 TTL」，不是密码学防护；第二因子留 M6.5。
2. **已激活的能力插件等于已失守**：worker 不是安全沙箱，插件仍可 `import('node:fs')` / `node:net`。`env: {}` 与关闭自动激活只收缩外带面；真正的边界是 M5 沙箱。
3. **`approvals.json` 无签名**：本地可写进程能插入伪造 pending（owner 会看到陌生审批并可拒绝；`approved` 不重放），但被插件 `import` 的其他本地文件改动不会让审批失效。签名与导入图哈希留 M6。
4. **网页单 token 全权**：会话 cookie 被窃即等于审批权，无二次认证、无操作者区分（审计只有 `by:'web'`）。Origin + `SameSite=Strict` + 静态头是唯一防线。

## 架构

```
src/
  core/
    loop.ts        心跳循环：快/慢 tick、消息唤醒、静默退避、在途互斥
    events.ts      感知队列：事件入口，防抖唤醒
    proactive.ts   主动私聊调度：六道闸 + 合成 tick 事件
  approvals/       审批子系统：状态机、TTL、指纹、恰好一次执行
  control/         控制面语义：语法、意图、router、状态快照、状态存储
  brain/
    brain.ts       LLM 调用层：故障转移、推理内容剥离、用量记账
    endpoints.ts   端点池：错误分类、指数退避、健康排序、超时断路器
  persona/
    persona.ts     人格状态：空白种子 + 漂移钳制
    redlines.ts    红线层：冻结规则 + 中英双语模式表
  plugins/         插件宿主（进行中）
    manifest.ts    清单校验
    api.ts         插件 API 类型
    host.ts        进程内通道插件宿主
  util/
    tty.ts         终端输出净化（ANSI/OSC/C1/零宽/双向字符）
```

## 设计要点

**心跳是唯一驱动源。** 消息到达只入感知队列；下一次心跳醒来决定做什么。空队列时绝不调用模型（预算保护）。

**不可信数据隔离。** 网络内容与聊天消息进入上下文时包在带声明的数据块里，其中的指令不被执行。出站内容先规范化再判定，判定与发送使用同一份字符串。

**红线是代码级兜底。** 冻结的规则文本注入每个 system prompt 尾部；同时有代码级模式表拦截（英中双语，NFKC 规范化后匹配）。两者叠加，互不替代。

**人格从空白长出来。** 没有预设人设。数值状态（心情、精力、兴趣、亲密值）由经历推动，单次变动与每日总漂移都有上限，防止突变或塌缩。

**插件按目录分级信任。** `plugins/channels/**` 可信、同进程加载；`plugins/capabilities/**`（agent 自己写的）一律 worker 隔离，只能通过声明的权限调用核心能力。

**审批是能力边界的唯一闸门。** 扩大能力范围的动作（激活能力插件、执行 owner 的自然语言指令）都走 `ApprovalService`：有 TTL、双通道一致、执行恰好一次、执行前复核指纹。存储只作审计，绝不是授权来源。

## 测试

```bash
npm test           # 全部测试
npm run typecheck  # tsc --noEmit
```

测试不访问网络：LLM 调用、定时器、文件系统全部注入或 mock。

## 许可

未指定。使用前请联系作者。
