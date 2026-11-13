# Langfuse 本机部署与追踪

本项目使用自部署 Langfuse 查看一次 AI 业务中的生成、复核、修复、实际请求和用量。默认配置不启用追踪；本机部署脚本会创建独立的追踪环境及应用配置，不需要注册云端账号。

## 启动本机 Langfuse

先启动 Docker Desktop、OrbStack 或当前 Docker context 对应的容器运行环境。在仓库根目录执行：

```bash
npm run langfuse:local -- setup
npm run langfuse:local -- up
npm run langfuse:local -- status
```

首次启动需要下载镜像并初始化数据库，耗时取决于网络与机器资源。`setup` 只准备本机文件，不启动 Docker；`up` 启动独立 Compose 项目并等待服务健康。完成后打开：

[http://127.0.0.1:3035](http://127.0.0.1:3035)

本地管理员邮箱为 `admin@langfuse.local`。密码保存在仓库根目录 `.env.langfuse.docker.local` 的 `LANGFUSE_INIT_USER_PASSWORD`；用本机编辑器查看并登录，不要把整份文件贴到聊天或提交到 Git。脚本使用 Langfuse 官方 headless 初始化变量，首次自动创建组织、项目、管理员及项目 API Keys，不必在网页重复注册。

部署固定 Langfuse web/worker **v4.79.0**，独立 Compose 名为 `ai-video-studio-langfuse`。只有以下端口映射到本机回环地址：

| 服务 | 地址 | 用途 |
| --- | --- | --- |
| Langfuse web/API | `127.0.0.1:3035` | 浏览记录、写入与读取追踪 |
| 本机对象存储 | `127.0.0.1:9095` | Langfuse 的本机 S3 端点 |

PostgreSQL、ClickHouse、Redis 和 worker 没有映射宿主机端口。部署关闭 Langfuse 与 Next.js telemetry，使用独立命名卷；应用媒体、正式项目和现有数据库不挂载到该环境。

## 本机配置文件

`setup` 使用安全随机数生成凭据，将两个文件设为仅当前用户可读写（`0600`），且都已被 Git 忽略：

| 文件 | 内容 |
| --- | --- |
| `.env.langfuse.docker.local` | 数据库、Redis、对象存储、初始化管理员及项目 API Keys |
| `.env.langfuse.local` | 应用接入本机 Langfuse 的地址、项目公钥/密钥及追踪开关 |

重复运行 `setup` 保留已有值；应用文件丢失时可从现有 Docker 配置恢复匹配的 API Keys。发现两份配置不一致时停止并保留文件，不自动覆盖或轮换凭据。若删除 Docker 配置但保留卷，重新生成的密码不会自动替换已有数据库或管理员密码，因此应一并保留本机配置和数据备份。

生成的应用配置使用：

```dotenv
LANGFUSE_TRACING=true
LANGFUSE_PUBLIC_KEY=由setup在本机生成
LANGFUSE_SECRET_KEY=由setup在本机生成
LANGFUSE_BASE_URL=http://127.0.0.1:3035
LANGFUSE_TRACING_SAMPLING_RATE=1
VIDEO_STUDIO_LANGFUSE_TIMEOUT_MS=3000
VIDEO_STUDIO_LANGFUSE_MAX_PENDING=256
```

共享 `.env.example` 只放空凭据与默认关闭的开关。项目不会自动读取任意 `.env` 文件，命令需要显式加载配置。使用远端自部署时，在独立本机配置中填写该实例提供的 HTTPS 地址和项目 Keys。

## 检查连接并启动应用

在仓库根目录运行本地配置检查：

```bash
npm run langfuse:check -- --config=.env.langfuse.local
```

该命令检查启用条件和配置，不发网络请求，也不输出密钥。随后运行一次合成追踪烟雾检查：

```bash
npm run langfuse:smoke -- --config=.env.langfuse.local
```

烟雾检查写入合成追踪并读取同一记录确认入库，不调用付费模型、不读取或修改正式项目。只有读取验证成功才算接入连通。在 Langfuse 中选择初始化的 **AI Video Studio Local** 项目查看记录。

使用 Node.js 22 或更新版本，从仓库根目录带配置启动开发环境：

```bash
node --env-file=.env.langfuse.local scripts/dev.mjs
```

已有构建产物时可启动后端：

```bash
node --env-file=.env.langfuse.local backend/dist/server.js
```

开发启动器的子进程会继承环境。不要把 `--env-file` 放入 `NODE_OPTIONS`，Node.js 不允许这种用法。接入代码不会自动重启现有应用服务；正在运行的进程只有在按正常启动流程加载新配置后才会启用追踪。

## 停止、再次启动与备份

```bash
npm run langfuse:local -- down
npm run langfuse:local -- up
```

`down` 只停止并移除本项目容器和网络，保留命名卷与本机配置；脚本不提供删除数据卷的选项。`status` 只显示本项目服务名、运行与健康状态，不显示展开的配置或密钥。

备份时保存两份本机配置，以及 `ai-video-studio-langfuse` 项目的 PostgreSQL、ClickHouse、对象存储和 Redis 卷；需要一致性快照时先停止写入与容器，再按容器运行环境的卷备份方式处理。单独复制 Compose 文件不包含追踪数据，也不能恢复丢失的凭据。Langfuse 本地追踪数据与应用原有项目数据分别备份。

## 记录内容与范围

应用使用 OTLP/HTTP 将追踪写入本机 Langfuse，兼容 v4 的事件存储。应用只发送固定阶段、传输和状态枚举、数值诊断及不可逆关联引用。实际生成、复核与修复请求按原业务根记录关联，多任务并发保持隔离。没有实际 token 报告时保留未知，不填零；没有可靠模型价格映射时不虚构成本。

不会发送剧本/原稿、提示词、候选或复核正文、工具参数/结果、错误正文与堆栈、凭据/请求头、模型返回文本、媒体地址/文件路径、base64 或私有推理。自部署也沿用这组数据边界。

Langfuse v4 的观察记录不可变，因此请求只有在收到最终指标时才导出，业务根记录在任务结束后导出；任务进行中不会预先发送未结束的记录。任务结束时尚未结算的请求只计入根记录的 `incomplete_children`，迟到的最终指标仍可补入同一根记录；该计数保留任务结束时的快照。

追踪导出有超时与队列上限，导出失败或队列满允许丢弃追踪，不影响业务成果、不增加模型重试，也不改变原任务的取消、断点与付费请求防重。拥塞或退出时可能缺少根记录或部分请求；追踪的缺失与可见时间不能用来判断业务是否仍在运行，业务状态以应用任务记录为准。采样率按整条记录决定；低于 1 时并非每次操作都有追踪。导出限制不增加剧本创作或原稿分析的请求、token、业务时长或修复轮数上限。

本机合成烟雾检查仅证明追踪写入与读取。实际模型质量、网关稳定性、耗时和计费仍需用临时项目中的代表性业务另行验收，不能从追踪接入通过推断这些指标已改善。

## 官方依据

- [Langfuse v4.79.0 固定版本 Compose](https://github.com/langfuse/langfuse/blob/v4.79.0/docker-compose.yml)
- [本机 Docker Compose 部署](https://langfuse.com/self-hosting/deployment/docker-compose)
- [Headless 初始化组织、项目、管理员和 API Keys](https://langfuse.com/self-hosting/administration/headless-initialization)
