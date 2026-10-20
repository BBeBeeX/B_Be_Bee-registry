# BBeBee 内容注册表（B_Be_Bee-registry）

BBeBee 音乐播放器的**第三方内容注册表**：社区在这里发布与共享音乐源、歌词源、主题和插件。

## 架构模型

本注册表采用**去中心化元数据指针模型**：

1. **音乐源（Music Sources）与歌词源（Lyric Sources）**：
   - 存储路径：`music-sources/{username}-{name}.json` 与 `lyric-sources/{username}-{name}.json`
   - **纯元数据指针**：注册表仅收录指针元数据，`repo` 字段指向作者的 GitHub 仓库。
   - **作者仓产物契约**：源仓库根目录下必须提供 `index.json` 作为该源的规则文档定义。
   - **自定义服务器路径与参数（`params`）**：支持声明 `params: ["sourceurl", ...]`，允许用户在播放器中自定义修改服务器地址与路径（如自建 NAS/Navidrome 实例），客户端自动将其加入沙盒网络访问白名单。
2. **插件（Plugins）**：
   - 存储路径：`plugins/{username}-{pluginname}.json`
   - **纯元数据指针**：注册表不托管插件代码；条目的 `npm` 字段指向作者发布到 npm 的包，`repo` 指向作者的 GitHub 仓库。
   - **版本真相在 npm**：条目不携带 `version` 字段；客户端从 npm packument 解析最新/符合依赖 range 的版本后下载安装。
   - **依赖声明**：`services` 列出插件必须注入的 Cordis 服务键（安装前做服务依赖检查，可为 `[]`），`dependencies` 声明对其他插件的依赖（支持 `"<id>@<semver-range>"`），`platforms` 声明适配平台（`desktop`/`mobile`）。
   - **提供服务（`provides`）**：插件若注册了供其他插件注入的服务键，在此声明；其他条目的 `services` 即可引用这些键——CI 跨条目两遍校验（核心键白名单 ∪ 全体条目的 `provides`）。核心键白名单不在本仓库维护：它由 BBeBee 仓库从插件 manifest 生成（`packages/protocol/service-keys.json`），本仓库只保存 vendored 副本（`scripts/lib/service-keys.generated.json`，用 `node scripts/sync-service-keys.mjs` 同步）。
   - **先发布，后提交**：CI 还会校验条目的 `npm` 包**已发布到公共 npm**（查 packument，404 即失败），并经 jsDelivr 拉取最新版的 `BBeBee.plugin.json` 与 `package.json` 核对内容（manifest 的 `id` 与条目 `id`、`package.json` 的 `name` 与条目 `npm` 字段必须一致，防冒充）。所以先 `npm publish`，再提条目 PR（详见 [CONTRIBUTING.md](CONTRIBUTING.md)）。
   - **聚合索引**：`plugins/index.json` 是由 `scripts/build-index.mjs` 生成的提交文件，客户端只拉这一个文件做展示；`services` 与插件包内 `BBeBee.plugin.json` 的安全能力 `capabilities`（`fs:`/`net:`/`db:`…）是两个概念，不要混用。
3. **界面主题（Themes）**：
   - 存储路径：`themes/{author}-{name}/`
   - **内容进仓**：包含 `theme.json`（颜色设计 Token 定义）与 `preview.png`（预览图）。主题直接托管在本仓，无需 `repo`。必须通过 WCAG AA 对比度门禁与合法 `#hex` 校验。

> **提示**：本仓库无 `dist/` 编译产物目录；插件另有提交到仓库的聚合索引 `plugins/index.json`
> （`scripts/build-index.mjs` 生成，CI 做新鲜度门禁），客户端展示插件菜单时只拉这一个文件。

---

## 目录结构

```
B_Be_Bee-registry/
├── music-sources/
│   └── {username}-{name}.json        # 音乐源元数据指针
├── lyric-sources/
│   └── {username}-{name}.json        # 歌词源元数据指针
├── plugins/
│   ├── {username}-{pluginname}.json  # 插件元数据指针（schema v2：无 version，有 npm/services/platforms）
│   └── index.json                    # 生成的聚合索引（scripts/build-index.mjs，提交到仓库）
├── themes/
│   └── {author}-{name}/              # 界面主题定义
│       ├── theme.json                # 主题 Token 定义（含 tokens.dark / tokens.light）
│       └── preview.png               # 主题预览图
├── scripts/
│   ├── validate.mjs                  # 全量校验门禁与负向测试套件
│   ├── build-index.mjs               # 生成 plugins/index.json
│   ├── sync-service-keys.mjs         # 同步 vendored 服务键白名单（自 BBeBee 生成产物）
│   └── lib/                          # 校验规则与模型
│       ├── schemas.ts                # 四类条目 schema（含插件依赖图校验）
│       ├── service-keys.ts           # 服务键白名单加载/新鲜度检查（数据在 service-keys.generated.json，vendored 自 BBeBee 生成产物）
│       ├── semver-range.ts           # 手写 semver range 解析器（零依赖）
│       ├── registry-model.ts         # 目录扫描
│       └── theme-contrast.ts         # 主题对比度门禁
├── .github/workflows/
│   └── validate.yml                  # CI 自动校验工作流
├── CONTRIBUTING.md                   # 贡献指南：Schema 规范与提交步骤
├── MODERATION.md                     # 审核标准、冒名处理与下架流程
└── README.md                         # 本说明文件
```

---

## 快速开始与本地校验

向本注册表添加或修改条目后，请在仓库根目录运行校验命令：

```bash
# 运行全量校验（离线或沙箱环境下网络不可达降级为警告）
node scripts/validate.mjs

# 严格模式（任何警告亦视为失败）
node scripts/validate.mjs --strict

# 跳过网络连通性探测（仅做严格语法与 Schema 校验）
node scripts/validate.mjs --skip-network

# 运行内置负向测试套件（验证坏输入拦截有效性）
node scripts/validate.mjs --test
```

所有 PR 在合并前必须确保 `node scripts/validate.mjs` 输出 **0 errors**。

详细提交指南请参考 [CONTRIBUTING.md](CONTRIBUTING.md)；审核规范请参考 [MODERATION.md](MODERATION.md)。

---

## 免责声明

- 本注册表收录的所有第三方内容（音乐源、歌词源、插件、主题）均由社区开发者提交，与 BBeBee 项目及注册表维护团队无关；请在条目元数据中如实署名。
- 插件和源的代码运行在用户本地沙箱环境中，请用户在安装前自行核对源码与作者仓库安全性。
