# syntax=docker/dockerfile:1
#
# uuBot harness 运行镜像。
# 运行时用 tsx 直接解释 TS 源码（tsc 产物不复制 manifest.json），所以
# tsx 必须保留——它在 devDependencies 里，npm ci 不能省略 dev。
FROM node:22-slim

WORKDIR /app

# 依赖层单独缓存：只改源码时不会重跑 npm ci。
COPY package.json package-lock.json ./
RUN npm ci --include=dev

COPY tsconfig.json ./
COPY src ./src
COPY plugins ./plugins
# 计划页的数据源：plan-api 按模块相对路径解析到 /app/docs/plan.json。
COPY docs/plan.json ./docs/plan.json

# 运行期目录（compose 会用绑定挂载覆盖）。预建并归属非 root 用户，让没有挂载的
# 纯 docker run 也能写；使用绑定挂载时宿主机目录必须由部署者 chown 给
# HARNESS_UID:GID（默认 1000:1000），见 deploy/docker-compose.yml 的注释。
# 这里的 1000:1000 是硬编码：HARNESS_UID/GID 不是 1000 且不用绑定挂载时，
# 必须新增构建参数（ARG HARNESS_UID/HARNESS_GID + 对应 chown）并重建镜像，
# 否则 /app/config、/app/state 对运行用户不可写。
RUN mkdir -p /app/config /app/state && chown -R 1000:1000 /app/config /app/state

# .env 绝不入镜像：compose 的 env_file 在运行时注入。
ENV NODE_ENV=production

# 运行时不读 .env 文件本身（容器里没有）。引导项（WEB_* / CONFIG_DIR /
# DATA_DIR）来自环境变量；运行期配置在绑定挂载的 /app/config/harness.json，
# 首次启动时从 env 的 QQ_*/TICK_* 等导入一次，之后以文件为准。
# 直接执行 tsx 二进制而非 npx：npx 作为 PID 1 时 SIGTERM 转发不可靠，
# 会让 docker stop 跳过 src/index.ts 里的优雅退出路径。compose 另设 init: true。
CMD ["node_modules/.bin/tsx", "src/index.ts"]
