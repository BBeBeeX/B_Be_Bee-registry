# 贡献指南（CONTRIBUTING）

本指南说明向 BBeBee 内容注册表提交第三方内容的完整流程、命名规范、Schema 字段约束以及作者仓库产物契约。审核标准与冒名处理请阅读 [MODERATION.md](MODERATION.md)。

---

## 1. 提交流程

1. **Fork** 本仓库并基于 `main` 分支创建特性分支：
   ```bash
   git checkout -b add-my-entry
   ```
2. **准备作者仓库产物**（源与插件）：
   - 源仓库根目录下提交 `index.json`；
   - 插件发布到 **npm**（包契约见 §3），注册表条目的 `npm` 字段指向该包。
3. **添加注册表条目**：
   - 音乐源：新建 `music-sources/{username}-{name}.json`
   - 歌词源：新建 `lyric-sources/{username}-{name}.json`
   - 插件：新建 `plugins/{username}-{pluginname}.json`
   - 主题：新建 `themes/{author}-{name}/theme.json` 并附带 `themes/{author}-{name}/preview.png`
4. **本地运行校验门禁**：
   ```bash
   node scripts/validate.mjs
   ```
   若需验证防御性拦截，可运行内置负向测试套件：
   ```bash
   node scripts/validate.mjs --test
   ```
5. **提交 PR**：确保本地输出 `0 errors` 后，推送到自己的 Fork 并发起 PR。CI 会在 PR 中自动运行校验。

---

## 2. 命名规范与所有权一致性

- **文件名规范**：所有条目文件名或主题目录名必须遵循小写英文字母、数字和连字符命名，格式为 `{username}-{name}`（例如 `bbebeex-subsonic.json`）。
- **所有权一致性（防冒名与归属检验）**：
  - 源与插件的文件名中的 `{username}` **必须与 `repo` 字段中的 GitHub owner 一致**（大小写不敏感匹配）。
  - 例如，repo 为 `https://github.com/Alice/my-source`，文件名必须以 `alice-` 开头（如 `music-sources/alice-my-source.json`）。

---

## 3. 作者仓产物契约（Artifact Contracts）

源与插件在注册表中仅登记元数据指针，客户端安装与加载时会按以下契约拉取作者仓库的产物：

| 类型 | 作者仓根目录产物契约 | 说明 |
|---|---|---|
| **音乐源 / 歌词源** | `index.json` | 规则文档定义（包含 sourceUrl、各项 rule 规则配置及可执行函数声明） |
| **插件** | **npm 包**（见下方 npm 发布契约） | 注册表条目不再指向"作者仓根目录文件"，而是指向一个 **npm 包**（`npm` 字段）；客户端从 npm 下载 tarball 安装 |

#### 插件 npm 发布契约：
1. 包根目录必须包含 `BBeBee.plugin.json`（插件清单：id、服务声明、安全能力等），且 `package.json` 的 `files` 必须包含它；
2. `package.json` 的 `name` 必须等于注册表条目的 `npm` 字段，`BBeBee.plugin.json` 的 `id` 必须等于条目的 `id`，否则客户端拒绝安装（防冒充）；
3. **版本号的唯一真相是 npm**：注册表条目不携带 `version` 字段；`package.json#version` 与 `BBeBee.plugin.json#version` 必须一致；
4. v1 仅支持文本文件插件包（JS/JSON/CSS 等 UTF-8 文本）；二进制资源暂不支持。

---

## 4. 条目元数据 Schema 规范

本注册表严格拦截未声明的未知字段（Unknown fields rejected）。

### 4.1 音乐源与歌词源（`music-sources/` & `lyric-sources/`）

- 路径：`music-sources/{username}-{name}.json` 或 `lyric-sources/{username}-{name}.json`
- 纯指针元数据。

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `id` | ✅ | `string` | 唯一标识符，小写字母、数字及单个连字符（slug） |
| `name` | ✅ | `string` | 显示名称 |
| `repo` | ✅ | `string` | 作者 GitHub 仓库主页，必须为 `https://github.com/<owner>/<repo>` |
| `author` | ✅ | `string` | 作者署名 |
| `description` | ✅ | `string` | 功能简要说明 |
| `version` | ✅ | `string` | semver 版本号（如 `1.0.0`） |
| `minAppVersion` | ⚪ | `string` | 兼容的最低客户端 semver 版本号 |
| `params` | ⚪ | `string[]` | 可配置参数键名列表（如 `["sourceurl", "username", "password"]`） |
| `platforms` | ⚪ | `string[]` | 适配平台（值域 `desktop` / `mobile`；缺省=全平台） |

#### `params` 可配置参数与自定义服务器路径说明：
对于需要用户连接自建实例或提供自定义配置的音源（例如 Subsonic、Navidrome、Jellyfin 或 WebDAV 源），可在条目中声明 `params` 字符串数组：
1. **允许用户自定义服务器地址与路径**：
   - 当 `params` 包含 `"sourceurl"`（不区分大小写，如 `"sourceurl"` 或 `"source_url"`）时，BBeBee 客户端会识别该源支持自定义服务实例，允许用户在播放器的源设置弹窗中修改服务器地址与路径（如自建 NAS、内网 IP `http://192.168.1.100:4533`、自建反向代理路径 `https://my-nas.lan/music` 等），覆盖作者默认提供的占位 `sourceUrl`。
2. **沙盒网络白名单动态注入**：
   - 客户端在用户手动修改 `sourceurl` 后，会解析并提取新主机名（Host/IP），将其**动态合并追加到当前音源 QuickJS 沙盒的 `allowedHosts` 网络访问白名单中**，放行后续 API 与媒体流请求，且不覆盖源内原有的静态白名单节点。
3. **松弛匹配与更新状态检测**：
   - 客户端在比对该源的安装与更新状态时，若检测到 `params` 中包含 `sourceurl` 且已被用户自定义配置，将跳过对默认 `entry.sourceUrl` 的强一致性比对，避免用户自定义路径后被错误标记为未安装。
4. **配置示例（`music-sources/bbebeex-subsonic.json`）**：
   ```json
   {
     "id": "subsonic",
     "name": "Subsonic",
     "version": "1.0.0",
     "author": "BBeBee",
     "description": "Subsonic-compatible music source with Navidrome / Airsonic support.",
     "repo": "https://github.com/BBeBeeX/B_Be_Bee-subsonic",
     "params": [
       "sourceurl",
       "username",
       "password"
     ]
   }
   ```

### 4.2 插件（`plugins/`）

- 路径：`plugins/{username}-{pluginname}.json`
- 纯指针元数据（schema v2：无 `version` 字段，版本真相在 npm）。

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `id` | ✅ | `string` | 唯一标识符，小写连字符 slug |
| `name` | ✅ | `string` | 插件显示名称 |
| `repo` | ✅ | `string` | 作者 GitHub 仓库主页，必须为 `https://github.com/<owner>/<repo>` |
| `npm` | ✅ | `string` | npm 包名（客户端从此下载，如 `"@alice/bbebee-plugin-foo"`） |
| `author` | ✅ | `string` | 作者署名 |
| `description` | ✅ | `string` | 插件功能说明 |
| `services` | ✅ | `string[]` | 插件运行时必须注入的 **Cordis 服务键** 列表（如 `["player", "store"]`；可为 `[]`——纯事件型插件不注入任何服务。键必须能被满足：核心键以 BBeBee 仓库从插件 manifest 生成的清单为准（本仓库 vendored 副本在 `scripts/lib/service-keys.generated.json`，用 `node scripts/sync-service-keys.mjs` 同步，不要手工改），或由其他插件条目在 `provides` 中声明；无法满足的键会被 CI 拒绝） |
| `provides` | ⚪ | `string[]` | 本插件对外提供的 **Cordis 服务键**（如本插件注册了供别人注入的服务，在此声明；其他条目即可在自己的 `services` 中引用。可为 `[]`，缺省视为不提供） |
| `platforms` | ✅ | `string[]` | 适配平台（非空，值域 `desktop` / `mobile`） |
| `category` | ✅ | `string` | 插件类别（必须匹配预定义枚举） |
| `dependencies` | ✅ | `string[]` | 依赖的其他插件：`"<registry-id>"` 或 `"<registry-id>@<semver-range>"`（如 `"bob-dsp-pack@^2.0.0"`；无依赖填 `[]`）。id 必须对应已存在的条目；依赖成环会被 CI 拒绝 |
| `compositors` | ✅ | `string[]` | 挂载的原生 UI 插槽列表（必须匹配预定义枚举） |
| `i18n` | ✅ | `string[]` | 插件 UI 支持的语言标签列表（非空，如 `["en", "zh"]`） |
| `minAppVersion` | ⚪ | `string` | 兼容的最低客户端 semver 版本 |
| `screenshot` | ⚪ | `string` | 预览截图 URL（必须以 `https://` 开头） |
| `engines` | ⚪ | `object` | 引擎版本约束对象（如 `{ "bbebee": ">=0.1.0" }`） |
| `homepage` | ⚪ | `string` | 项目主页 URL（必须以 `https://` 开头） |

> ⚠️ **概念区分**：注册表条目的 `services`（本表）声明的是插件**依赖注入哪些 Cordis 服务**
> （运行时 `inject` 的服务键，用于安装前做服务依赖检查）；而插件自身 `BBeBee.plugin.json`
> 里的 `capabilities` 是**安全能力门禁**（`fs:read:own`、`net:host/*`、`db:own`…，定义见 BBeBee
> 仓库 `docs/plugins/capabilities.md`）。两者名字在旧版注册表中撞过，v2 起注册表侧统一叫
> `services`，**不要混用**——注册表条目里写 `capabilities` 会被未知字段拦截直接拒绝。

#### 插件条目示例（v2）：
```json
{
  "id": "alice-visualizer-pro",
  "name": "Visualizer Pro",
  "repo": "https://github.com/alice/bbebee-visualizer-pro",
  "npm": "@alice/bbebee-plugin-visualizer-pro",
  "author": "alice",
  "description": "Spectrum visualizer with custom themes.",
  "services": ["player", "store", "settings"],
  "platforms": ["desktop"],
  "category": "ui-enhancement",
  "dependencies": ["bob-dsp-pack@^2.0.0"],
  "compositors": ["now-playing.visualizer"],
  "i18n": ["en", "zh"],
  "minAppVersion": "0.5.0",
  "screenshot": "https://…/shot.png",
  "homepage": "https://alice.dev/viz-pro"
}
```

#### `category` 允许枚举值：
- `ui-enhancement`（界面美化与增强）
- `notifications-integration`（系统通知与外部联动）
- `development-runtime`（开发工具与调试运行库）
- `security-permissions`（安全与权限管理）
- `remote-mobile`（移动端联动与远程控制）
- `marketplace-management`（扩展市场与分发管理）
- `other`（其他通用功能）

#### `compositors` 允许枚举值（原生 UI 挂载插槽）：
- `now-playing.actions`
- `now-playing.panel`
- `now-playing.visualizer`
- `track.context-menu`
- `album.context-menu`
- `library.sidebar`
- `search.results-section`
- `settings.sources`
- `source.browse`
- `topbar.tray`
- `status-bar`
- `tray`

### 4.3 界面主题（`themes/`）

- 路径：`themes/{author}-{name}/theme.json` 与 `themes/{author}-{name}/preview.png`
- 内容在仓内维护，无需 `repo`。

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `id` | ✅ | `string` | 唯一标识符，小写连字符 slug |
| `name` | ✅ | `string` | 主题名称 |
| `version` | ✅ | `string` | semver 版本号（如 `1.0.0`） |
| `author` | ✅ | `string` | 设计师/作者署名 |
| `description` | ✅ | `string` | 主题描述 |
| `tokens` | ✅ | `object` | 设计 Token 对象，内含 `dark` 和/或 `light` |

#### `tokens` 规范与门禁：
1. `tokens` 必须包含 `dark` 和/或 `light` 模式中的至少一种；
2. 每个模式下的所有颜色值必须是合法的 `#hex` 字符串（`#rrggbb`、`#rrggbbaa` 或 `#rgb`）；
3. 每个模式必须通过 WCAG AA 对比度门禁测试（正文字体 4.5:1，大字/主要边界 3:1）；
4. `preview.png` 必须存在于主题目录下作为渲染预览图。

---

## 5. 版本更新规则

- **源与主题**：任何功能修改、配置变动均必须递增条目中的 `version`（遵循 SemVer：大改升 major，加特性升 minor，修数据升 patch）。客户端依靠版本比对提示用户更新。
- **插件**：注册表条目**不携带 `version`**；版本管理完全走 npm——发布新版即 `npm publish` 递增 `package.json#version`
  （并同步 `BBeBee.plugin.json#version`），客户端通过 npm packument 检查更新。修改注册表条目元数据
  （如改描述、加 `services`）不需要"发版"，直接提 PR 更新条目 JSON 即可。
- `plugins/index.json` 是生成的聚合索引（`node scripts/build-index.mjs`），提交条目 PR 时如
  CI 报 index 过期，本地运行一次该命令重新生成后一起提交。
- **npm 包存在性与内容**：CI 会检查插件条目的 `npm` 字段是否对应 npm 上已发布的**公开**包
  （404 即失败），并拉取该包**最新版**的 `BBeBee.plugin.json` 与 `package.json`（经 jsDelivr）
  核对：manifest 的 `id` 必须等于条目 `id`、`package.json` 的 `name` 必须等于条目 `npm` 字段，
  不一致即失败。提交注册表 PR 前请先 `npm publish`，包名拼错、私有包、发错包都会被拒绝。
