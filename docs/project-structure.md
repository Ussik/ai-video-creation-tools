# 项目目录与模块规则

项目使用 npm workspaces。依赖在根目录安装，根目录 `package-lock.json` 是唯一依赖锁文件。

```text
.
├── package.json                全项目开发、构建、测试与检查命令
├── package-lock.json           固定三个工作区的依赖版本
├── scripts/                    工程命令与目录边界检查
├── web/
│   ├── src/
│   │   ├── main.tsx            前端启动与全局样式入口
│   │   ├── app/                应用布局、导航与项目刷新
│   │   ├── features/           canvas、script、storyboard、visuals、assets、
│   │   │                      final-cut、models、skills、jobs、speech、projects
│   │   ├── shared/
│   │   │   ├── api/            浏览器请求封装与 API 类型兼容导出
│   │   │   ├── ui/             通用 Mantine 组件、主题与媒体播放器
│   │   │   └── lib/            通用编辑工具
│   │   └── styles/             全局基础、工作台与主题样式
│   ├── test/                   前端组件与交互回归
│   └── public/                 静态资源
├── backend/
│   ├── src/
│   │   ├── server.ts           监听端口、启动队列和退出清理
│   │   ├── app.ts              应用创建与业务模块注册
│   │   ├── modules/            业务路由、校验和服务
│   │   └── infrastructure/    数据库、HTTP 基础设施、密钥、模型连接与 FFmpeg
│   ├── test/                   临时数据库及模拟接口回归
│   └── scripts/                配置维护工具
├── packages/shared/
│   └── src/                    公共 API 合同和两端共用的纯规则
├── docs/                       架构、工作流与产品文档
├── production/                 制作示例、脚本与验收记录
├── data/                       本地数据库、密钥、技能和素材，不进入 Git
└── exports/                    本地导出媒体，不进入 Git
```

## 模块归属

- 组件、专用 Hook、业务辅助函数与 CSS 就近放入对应 `features/<业务>/`。暂不为每个小模块强制建立 `components/hooks/utils` 子目录；同一目录增大后再按实际职责细分。
- React 组件使用 PascalCase；Hook 使用 `useXxx`；普通 TypeScript、CSS、目录使用 kebab-case。
- `web/src/shared` 只放多个功能复用的基础组件、请求和通用工具，不能反向依赖 `app` 或 `features`。
- 前后端源码通过 `@video-studio/shared/<领域>/<模块>` 使用公共类型和规则，不直接跨目录导入另一个应用的源码。
- 公共 API 数据合同位于 `packages/shared/src/api/contracts.ts`。数据库内部表示保留在后端；密钥密文、文件路径等内部字段不加入公共合同。后端模型响应序列化使用同一公共类型约束。
- 共享包只能包含适用于浏览器和 Node 的纯规则与类型，不依赖数据库、文件系统、前端组件或第三方平台 SDK。
- 后端新功能按业务放在 `modules/<业务>`；外部连接、存储和媒体处理放在 `infrastructure`。新增路由优先提供 `registerXxxRoutes`，在 `app.ts` 中注册。

## 样式与组件

通用交互组件使用 Mantine，已有检查禁止手写基础控件。主题配置位于 `web/src/shared/ui/theme.ts`，全局样式按 `main.tsx` 中的顺序加载。功能 CSS 与组件同目录，通过组件导入。

本次迁移保留原有 CSS 内容和导入顺序；`workspace.css`、`workspace-theme.css` 中的历史业务规则尚未按选择器拆分，后续拆分需要单独验证层叠优先级。不要继续用全局主题文件覆盖新功能的局部样式。

## 工程命令

```bash
npm ci                 # 安装所有工作区依赖
npm run dev            # 编译共享包，然后同时监听共享包、后端与前端
npm run check          # 检查目录边界、共享导入与 UI 组件规则
npm run build          # 按共享包 -> 后端 -> 前端顺序构建
npm test               # 编译共享包并运行工程工具和所有已有业务测试
npm run test:tooling    # 验证开发命令的启动顺序与子进程退出
npm run test:web       # 仅运行前端测试
npm run test:backend   # 仅运行后端测试
npm start              # 启动已编译的后端，并托管 web/dist
```

分别运行开发服务器时，先执行 `npm run build:shared`，再使用 `npm run dev --workspace=backend` 和 `npm run dev --workspace=web`。修改共享规则时，额外运行 `npm run dev --workspace=@video-studio/shared` 或重新构建共享包。

修改依赖使用根目录命令，例如 `npm install <package> --workspace=web`，只更新根锁文件。共享包通过声明文件供 TypeScript 检查，通过编译后的 ESM 供 Node/Vite 使用。

前端组件测试最多并行运行 4 个文件，避免同时启动大量 JSDOM/Mantine 测试进程。后端与共享包的构建先清理各自的 `dist/`，避免目录迁移后遗留已删除模块的编译文件；前端产物由 Vite 清理。

## 数据、记录与后续拆分

数据与静态产物路径统一由 `backend/src/infrastructure/paths.ts` 定位，源码和编译产物保持相同目录深度，不能根据进程工作目录改变数据位置。`VIDEO_STUDIO_DATA_DIR` 继续支持隔离数据目录。

`.planning/` 为本地任务记录，新增记录及媒体不进入 Git；已有受版本控制的历史记录暂时保留。根目录旧的 `task_plan.md`、`findings.md`、`progress.md` 保留原状，避免影响已有任务的恢复。需要长期维护的结论应整理到 `docs/`。

`ProjectCanvas.tsx`、`ScriptDirectorPanel.tsx` 和 `app.ts` 仍有较多历史职责。本次已分离后端启动入口、模型路由/校验/序列化和公共 API 合同；后续进一步提取画布状态、剧本对话与生成服务时，应按职责逐项迁移，保持现有回归用例和接口。
