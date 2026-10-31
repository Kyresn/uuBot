# NapCat 接入指南

本目录给 `deploy/docker-compose.yml` 里的 `napcat` 服务提供持久化目录。
NapCat 以 **OneBot 11 反向 WebSocket 客户端** 的身份主动连入 harness，因此
NapCat 不需要向宿主机暴露任何端口。

## 0. 前置：根目录 `.env` 与 harness 的 QQ 配置

`.env` 里只需要 NapCat 登录用的 QQ 号（`deploy/docker-compose.yml` 用它做
`${QQ_ACCOUNT}` 插值）：

```ini
# 登录用的 QQ 号（建议小号，见文末警告）
QQ_ACCOUNT=123456789
```

harness 侧的 QQ 参数**不在 `.env`**，而在 `config/harness.json`（首次启动
自动创建，之后用网页「设置」页编辑、保存即热生效）：

- `qq.wsToken`：harness 与 NapCat 共享的鉴权 token，必填；
- `qq.wsPort`：反向 WS 监听端口，默认 3001；
- `qq.wsHost`：监听地址；docker compose 首次导入时是 `0.0.0.0`；
- `qq.groupAllowlist` / `qq.privateOpen`：群白名单与私聊开关。

> **迁移规则**：首次启动时 `harness.json` 不存在，旧 `.env` 里的 `QQ_*` 会被
> 导入一次；从此以后 `config/harness.json` 是唯一权威，继续改 `.env` 里的
> `QQ_*` **不会生效**（启动日志会明说）。容器里已有 `harness.json` 时，
> compose 注入的 `QQ_WS_HOST=0.0.0.0` 同样被忽略——请在设置页核对 `qq.wsHost`。

`qq.wsToken` 必须与 NapCat WebUI 里填的 token 完全一致（见 §4）。

`qq.privateOpen` 打开后，任何知道机器人 QQ 号的人都能私聊它、唤醒心跳并
消耗模型预算。只建议在专用小号上打开，并用 `qq.privateDenylist` 兜住已知
的骚扰来源。

监听地址由 `qq.wsHost` 决定：`deploy/docker-compose.yml` 的 `QQ_WS_HOST=0.0.0.0`
只在**首次导入**时生效（容器内网可达）；本机直接 `npm run dev` 跑 harness 时
用默认 `127.0.0.1` 即可。已有 `harness.json` 后改 compose 不再生效，请在网页
「设置」页改 `qq.wsHost`。

## 1. 准备持久化目录（Linux 宿主机）

NapCat 容器以 uid/gid 1000 运行（可用 `NAPCAT_UID`/`NAPCAT_GID` 覆盖），
挂载目录需要可写：

```bash
mkdir -p deploy/napcat/data deploy/napcat/qq
sudo chown -R 1000:1000 deploy/napcat/data deploy/napcat/qq
```

Docker Desktop（Windows/macOS）通常不需要这一步。

harness 容器同样以非 root 运行（compose 里 `user: ${HARNESS_UID:-1000}`），
它绑定挂载了三个宿主机目录，都必须对该 uid 可写：

- `plugins/`：能力插件与封禁记录 `bans.json`；
- `config/`：模型配置，网页管理台保存配置的落盘目标；
- `state/`：对话记录等运行期状态。

若宿主机 uid 不是 1000，先导出再启动，否则容器写不了这些目录（表现为控制台
保存配置失败 `write_failed`、对话记录不落盘）：

```bash
export HARNESS_UID=$(id -u) HARNESS_GID=$(id -g)
mkdir -p config state
sudo chown -R "$HARNESS_UID:$HARNESS_GID" plugins config state
```

## 2. 启动

在仓库根目录执行（`--env-file .env` 让 compose 插值读到 `QQ_ACCOUNT`）：

```bash
docker compose --env-file .env -f deploy/docker-compose.yml up -d
docker compose -f deploy/docker-compose.yml ps
```

首次启动 harness 会先建镜像（`npm ci` 需要网络）。确认 harness 日志出现
WS 监听行：

```bash
docker compose -f deploy/docker-compose.yml logs -f harness
# 期望包含：qq: 监听 0.0.0.0:3001，路径 /onebot/v11/ws
```

## 3. 扫码登录 QQ

NapCat 默认把登录二维码打印在容器日志里：

```bash
docker compose -f deploy/docker-compose.yml logs -f napcat
```

日志中出现二维码（终端里是块字符画的 ASCII QR，或一条二维码图片路径/链接）后，
用手机 QQ 扫码并确认登录。若终端显示成乱码或图片路径，可把该图片复制出来查看：

```bash
docker compose -f deploy/docker-compose.yml cp napcat:/app/napcat/cache/qrcode.png ./qrcode.png
```

登录态保存在 `deploy/napcat/qq/`，之后重启容器一般不需要重新扫码。

### 可选：用 WebUI 扫码 / 配置

镜像内置 NapCat WebUI（默认容器内 `6099` 端口），但本编排**没有映射到宿主机**。
需要时临时在 `deploy/docker-compose.yml` 的 `napcat` 服务下加：

```yaml
    ports:
      - "127.0.0.1:6099:6099"
```

重启后用浏览器打开 `http://127.0.0.1:6099`。登录 token 在 NapCat 日志里：

```bash
docker compose -f deploy/docker-compose.yml logs napcat | grep -i token
```

用完建议删掉端口映射。**不要把 6099 暴露到公网。**

## 4. 配置反向 WebSocket

在 WebUI 的「网络配置」页新建一个 **WebSocket 客户端**（反向 WS）连接：

| 字段 | 值 |
|---|---|
| URL | `ws://harness:3001/onebot/v11/ws` |
| 令牌 / Token | 与 `config/harness.json` 的 `qq.wsToken` 完全一致（不是 `.env`；可在网页「设置」页查看末四位/替换） |
| 消息格式 | `string`（harness 读 `raw_message` 的 CQ 码文本） |
| 启用心跳 | 开 |
| 上报自身消息 | 关（harness 也会按 self_id 过滤） |

保存并启用。NapCat 会立即尝试连接；失败时会自动重试，所以 harness 和 NapCat
的启动顺序不影响最终连通。

`ws://harness:3001/...` 里的 `harness` 是 compose 内部的服务名，只能在
`uuharness` 网络内解析——这也是不要改成 `localhost` 的原因。

## 5. 确认接通

```bash
docker compose -f deploy/docker-compose.yml logs -f harness
```

期望看到：

- `qq: 监听 0.0.0.0:3001，路径 /onebot/v11/ws`（harness 已就绪）
- 连接建立后的 `qq: connected`（NapCat 已通过鉴权连入）
- 周期性的 `qq: meta_event heartbeat`（心跳正常）

若看到 `qq: 鉴权失败，关闭连接 (4001)`，说明两边 token 不一致；
若完全没有任何连接日志，检查 NapCat 反向 WS 的 URL 是否写成
`ws://harness:3001/onebot/v11/ws`。

## 6. 找到账号自己的 QQ 号（self_id）

- 你扫码登录用的号就是 `QQ_ACCOUNT`，也就是 `self_id`；WebUI 首页也会显示当前账号。
- harness 会从 `meta_event` / 消息事件的 `self_id` 自动学习，无需手工填写。
- 若配置了 `QQ_GROUP_ALLOWLIST`，把机器人拉进对应群，并在群里发一条消息，
  观察 harness 日志是否出现该群事件。

## ⚠️ 使用专用小号

**不要用主号跑 NapCat。** 第三方协议端登录存在被风控、冻结甚至封号的风险；
用专用小号，即使账号损失也不影响你本人。也不要把 NapCat WebUI / WS 端口暴露到公网。
