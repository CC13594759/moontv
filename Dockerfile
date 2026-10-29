# ---- 第 1 阶段：安装依赖 ----
FROM node:20-alpine AS deps

# 启用 corepack 并激活 pnpm（Node20 默认提供 corepack）
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# 仅复制依赖清单，提高构建缓存利用率
COPY package.json pnpm-lock.yaml ./

# 安装所有依赖（含 devDependencies，后续会裁剪）
RUN pnpm install --frozen-lockfile

# ---- 第 2 阶段：构建项目 ----
FROM node:20-alpine AS builder
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

# 复制依赖
COPY --from=deps /app/node_modules ./node_modules
# 复制全部源代码
COPY . .

# 在构建阶段也显式设置 DOCKER_ENV，
ENV DOCKER_ENV=true

# 文件存储版：NEXT_PUBLIC_* 变量在构建时内联进产物，运行时改环境变量
# 改不了存储类型，所以构建期就定为 file；数据文件路径仍可在运行时
# 用 FILE_DB_PATH 覆盖（默认 /app/data/moontv-data.json）。
ENV NEXT_PUBLIC_STORAGE_TYPE=file

# 生成生产构建
RUN pnpm run build

# ---- 第 3 阶段：生成运行时镜像 ----
FROM node:20-alpine AS runner

# 创建非 root 用户
RUN addgroup -g 1001 -S nodejs && adduser -u 1001 -S nextjs -G nodejs

WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV DOCKER_ENV=true
ENV NEXT_PUBLIC_STORAGE_TYPE=file

# 文件存储的数据目录：必须用卷保存，否则容器删除重建后数据会丢。
# 本版不以 root 运行（用户已明确不要 root 版）：仍用 nextjs 用户，
# 权限问题改由命名卷解决——Docker 创建命名卷时会按镜像里
# /app/data 的属主（nextjs）初始化卷，容器里的 nextjs 就能写，
# 不再依赖宿主机目录是谁建的；不要再用宿主机目录绑定映射，
# 绑定映射的属主以宿主机为准，root 建的目录仍会 EACCES。
RUN mkdir -p /app/data && chown nextjs:nodejs /app/data

# 声明卷：创建容器时若没显式指定 -v，Docker 会自动为
# /app/data 创建一个匿名卷并绑定；显式指定 -v moontv-data:/app/data
# 时则用那个命名卷（推荐，名字固定、升级时 dockerman 会带过去）。
VOLUME /app/data

# 从构建器中复制 standalone 输出
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
# 从构建器中复制 scripts 目录
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts
# 从构建器中复制 start.js
COPY --from=builder --chown=nextjs:nodejs /app/start.js ./start.js
# 从构建器中复制 public 和 .next/static 目录
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# 仍以非特权用户运行（root 版已作废，不要用）。
USER nextjs

EXPOSE 3000

# 使用自定义启动脚本，先预加载配置再启动服务器
CMD ["node", "start.js"] 
