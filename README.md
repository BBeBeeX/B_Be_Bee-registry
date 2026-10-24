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
   - 存储路径：`plugins/<id>.json`（文件名即插件 `id`，两者必须一致）
   - **纯元数据指针**：注册表不托管插件代码；条目的 `npm` 字段指向作者发布到 npm 的包，`repo` 指向作者的 GitHub 仓库。一个 npm 包只能支撑一个条目。
   - **版本真相在 npm**：条目不携带 `version` 字段；客户端从 npm packument 解析最新/符合依赖 range 的版本后下载安装。条目另须携带 `npmUrl`：从 `npm` 派生的标准包地址（`https://registry.npmjs.org/<编码后包名>`），不含版本与哈希，供引用与展示；下载 normally 由客户端按自身 registry 解析，镜像下载无效时按条目 npmUrl 回落官方地址。条目可另声明**已审版本钉扎**（`reviewedVersion` + `reviewedIntegrity`）：CI 校验该版本仍在 npm 上且完整性哈希一致，内容校验对钉扎版本执行；出现更新的未审版本只警告。
   - **依赖声明**：`services` 列出插件必须注入的 Cordis 服务键（安装前做服务依赖检查，可为 `[]`），`dependencies` 声明对其他插件的依赖（支持 `"<id>@<semver-range>"`），`platforms` 声明适配平台（`desktop`/`mobile`）。
   - **提供服务（`provides`）**：插件若注册了供其他插件注入的服务键，在此声明；其他条目的 `services` 即可引用这些键——收集时只承认自身校验通过的条目。**门禁**：17 个关键核心键（`player`、`secrets`、`plugin-manager` 等，完整名单见 vendored 产物）保留给内置提供者，任何条目不得宣称提供；同一服务键全注册表最多一个提供者。核心键白名单不在本仓库维护：它由 BBeBee 仓库从插件 manifest 生成（`packages/protocol/service-keys.json`），本仓库只保存 vendored 副本（`scripts/lib/service-keys.generated.json`，用 `node scripts/sync-service-keys.mjs` 同步）。
   - **官方的唯一定义**：条目 `repo` 的 owner 为 `BBeBeeX` 即官方（客户端徽标亦由此得出）；`bbebeex-` 前缀为官方保留，他人占用即被 CI 拒绝，官方条目只能由组织成员提交（CI 校验 PR 作者关联，`CODEOWNERS` 要求 @BBeBeeX 审核）。
   - **先发布，后提交**：CI 还会校验条目的 `npm` 包**已发布到公共 npm**（查 packument，404 即失败），并经 jsDelivr 拉取校验版本（钉扎版本或最新版）的 `BBeBee.plugin.json` 与 `package.json` 核对内容：manifest 的 `id` 与条目 `id`、`package.json` 的 `name` 与条目 `npm` 字段必须一致（防冒充），且条目 `provides` 必须真实出现在 manifest 的 `contributes.services` 中（声明属实性交叉校验）。所以先 `npm publish`，再提条目 PR（详见 [CONTRIBUTING.md](CONTRIBUTING.md)）。此外 CI 每天定时在线 strict 复验一次，合并后的漂移（包被下架、钉扎失效等）会被自动抓出。
   - **聚合索引**：`plugins/index.json` 是由 `scripts/build-index.mjs` 生成的提交文件，形态为 `{ "entries": [...], "blocked": [{ "id", "reason" }] }`，客户端只拉这一个文件做展示；`blocked` 是下架召回通道（数据源为仓库根目录 `blocklist.json`），客户端据此隔离已安装的被封插件。`services` 与插件包内 `BBeBee.plugin.json` 的安全能力 `capabilities`（`fs:`/`net:`/`db:`…）是两个概念，不要混用。
3. **界面主题（Themes）**：
   - 存储路径：`themes/{author}-{name}/`
   - **内容进仓**：`theme.json` 是**主题包**文档（格式 v2）：一个包含一至多个变体（`variants[]`）的包，每个变体是一套完整的运行时颜色 Token。主题直接托管在本仓，无需 `repo`。包内每个变体都必须通过 WCAG AA 对比度门禁与合法 `#hex` 校验；变体 `id` 必须全仓唯一。`preview.png` 可选（缺失仅警告）——浏览卡片由包的预览色绘制。旧式单主题文档（`tokens.dark` / `tokens.light`）仍被接受。
   - **聚合索引**：`themes/index.json` 由 `scripts/build-index.mjs` 生成并提交到仓库，只携带包摘要（名称、版本、变体数、变体清单、预览色），客户端浏览页只拉这一个文件；改主题后需重新生成（CI 做新鲜度门禁）。

> **提示**：本仓库无 `dist/` 编译产物目录；另有两份提交到仓库的聚合索引 `plugins/index.json` 与
> `themes/index.json`（`scripts/build-index.mjs` 生成，CI 做新鲜度门禁），客户端展示插件菜单与
> 主题浏览页时各只拉对应的一个文件。

---

## 目录结构

```
B_Be_Bee-registry/
├── music-sources/
│   └── {username}-{name}.json        # 音乐源元数据指针
├── lyric-sources/
│   └── {username}-{name}.json        # 歌词源元数据指针
├── plugins/
│   ├── <id>.json                     # 插件元数据指针（文件名即 id；schema v2：无 version，有 npm/services/platforms）
│   └── index.json                    # 生成的聚合索引 { entries, blocked }（scripts/build-index.mjs，提交到仓库）
├── themes/
│   ├── {author}-{name}/              # 界面主题包（格式 v2）
│   │   ├── theme.json                # 主题包文档（variants[] 变体；旧式 tokens.dark/light 仍兼容）
│   │   └── preview.png               # 主题预览图（可选）
│   └── index.json                    # 生成的主题包聚合索引（包摘要，scripts/build-index.mjs）
├── scripts/
│   ├── validate.mjs                  # 全量校验门禁与负向测试套件
│   ├── build-index.mjs               # 生成 plugins/index.json 与 themes/index.json
│   ├── sync-service-keys.mjs         # 同步 vendored 服务键白名单（自 BBeBee 生成产物）
│   └── lib/                          # 校验规则与模型
│       ├── schemas.ts                # 四类条目 schema（含插件依赖图、provides 门禁校验）
│       ├── service-keys.ts           # 服务键白名单加载/新鲜度检查（数据在 service-keys.generated.json，vendored 自 BBeBee 生成产物）
│       ├── semver-range.ts           # 手写 semver range 解析器（零依赖）
│       ├── registry-model.ts         # 目录扫描
│       ├── blocklist.ts              # 黑名单（blocklist.json）解析与命中匹配
│       ├── plugin-index.ts           # 聚合索引计算（build-index 与 validate 共用）
│       ├── theme-contrast.ts         # 主题对比度门禁
│       └── theme-index.ts            # 主题包摘要索引计算（build-index 与 validate 共用）
├── blocklist.json                    # 审核黑名单的机器载体（id/包名/账号/仓库 + reason）
├── CODEOWNERS                        # 官方条目与校验机器的必审归属
├── .github/workflows/
│   └── validate.yml                  # CI 自动校验工作流（含每日定时 strict 复验）
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
