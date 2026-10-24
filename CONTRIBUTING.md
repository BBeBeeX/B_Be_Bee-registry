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
   - 插件：新建 `plugins/<id>.json`（文件名即插件 `id`，见 §2）
   - 主题：新建 `themes/{author}-{name}/theme.json`（主题包文档，见 §4.3；`preview.png` 可选），并运行 `node scripts/build-index.mjs` 重新生成 `themes/index.json` 一并提交
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

- **源与主题的文件名规范**：必须遵循小写英文字母、数字和连字符命名，格式为 `{username}-{name}`（例如 `bbebeex-subsonic.json`）。
- **源的所有权一致性（防冒名与归属检验）**：
  - 音乐源/歌词源文件名中的 `{username}` **必须与 `repo` 字段中的 GitHub owner 一致**（大小写不敏感匹配）。
  - 例如，repo 为 `https://github.com/Alice/my-source`，文件名必须以 `alice-` 开头（如 `music-sources/alice-my-source.json`）。
- **插件的文件名即 `id`**：插件条目文件名为 `plugins/<id>.json`，文件名（去 `.json`）必须与条目 `id` 完全一致，不一致 CI 直接拒绝。插件 id 处于插件命名空间（如 `bbebee-plugin-visualizer-meters`），**不要求**以 GitHub 用户名开头；插件与作者的归属绑定由 npm 内容校验承担（包内 manifest 的 `id` 必须等于条目 `id`，见 §5）。
- **官方条目**：条目是否为"官方"**只看 `repo` 的 owner 是否为 `BBeBeeX`**，与 id 前缀、作者署名无关；客户端的"官方"徽标同样只由此得出。`bbebeex-` 前缀为官方保留：非 BBeBeeX owner 的条目使用该前缀会被 CI 直接拒绝。官方条目（repo owner 为 BBeBeeX 的条目）只能由 BBeBeeX 组织成员（OWNER/MEMBER 关联）通过 PR 提交，CI 会校验 PR 作者与组织的关联；`CODEOWNERS` 亦要求官方条目由 @BBeBeeX 审核。

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
5. **官方条目（`repo` owner 为 `BBeBeeX`）的包必须带 npm 出处证明（provenance）发布**：provenance 是 npm 在发布时依据 GitHub Actions 的 OIDC 环境签发的来源声明（哪个仓库、哪个 workflow 构建了这个版本），事后无法补发。发布方式：在 npmjs.com 为包配置一次 **trusted publisher**（绑定 GitHub 组织 `BBeBeeX`、源仓库与 workflow 文件名，免长期 token），再由该仓库的发布 workflow 以 `id-token: write` 权限执行 `npm publish --provenance`。CI 对官方条目核对钉扎版本的 provenance：**证明存在但来源仓与条目 `repo` 不符 → error**；**暂无证明 → warning**（现行 0.1.0 系本地 staged 发布、无证明；官方包带 provenance 重发后该 warning 转为 error）。客户端安装时执行同一核对：来源不符按防冒充拒绝安装，来源相符在设置页标记"出处已验证"。非官方条目不查 provenance。

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

- 路径：`plugins/<id>.json`（文件名必须等于 `id`）
- 纯指针元数据（schema v2：无 `version` 字段，版本真相在 npm）。

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `id` | ✅ | `string` | 唯一标识符，小写连字符 slug；必须等于文件名（去 `.json`） |
| `name` | ✅ | `string` | 插件显示名称 |
| `repo` | ✅ | `string` | 作者 GitHub 仓库主页，必须为 `https://github.com/<owner>/<repo>` |
| `npm` | ✅ | `string` | npm 包名（客户端从此下载，如 `"@alice/bbebee-plugin-foo"`） |
| `npmUrl` | ✅ | `string` | npm 包的标准地址，必须等于从 `npm` 派生的 packument 地址（`https://registry.npmjs.org/<encodeURIComponent(npm)>`，如 `"https://registry.npmjs.org/%40alice%2Fbbebee-plugin-foo"`）。不含版本（它定位的是包，不是某个发布）也不含哈希（完整性在 packument 的 `dist.integrity` / 钉扎的 `reviewedIntegrity` 里）。它是标准引用地址：客户端下载仍走自身 effective registry（镜像感知），不直接按此地址下载 |
| `author` | ✅ | `string` | 作者署名 |
| `description` | ✅ | `string` | 插件功能说明 |
| `services` | ✅ | `string[]` | 插件运行时必须注入的 **Cordis 服务键** 列表（如 `["player", "store"]`；可为 `[]`——纯事件型插件不注入任何服务。键必须能被满足：核心键以 BBeBee 仓库从插件 manifest 生成的清单为准（本仓库 vendored 副本在 `scripts/lib/service-keys.generated.json`，用 `node scripts/sync-service-keys.mjs` 同步，不要手工改），或由其他插件条目在 `provides` 中声明；无法满足的键会被 CI 拒绝） |
| `provides` | ⚪ | `string[]` | 本插件对外提供的 **Cordis 服务键**（如本插件注册了供别人注入的服务，在此声明；其他条目即可在自己的 `services` 中引用。可为 `[]`，缺省视为不提供）。**门禁**：关键核心键（`audio`、`codec`、`contentRegistry`、`db`、`downloads`、`fs`、`http`、`js`、`library`、`paths`、`player`、`plugin-manager`、`scanner`、`secrets`、`securityAudit`、`settings`、`store`）保留给内置提供者，任何条目不得宣称提供；同一服务键在全注册表中最多只能有一个提供者条目，冲突即拒绝 |
| `platforms` | ✅ | `string[]` | 适配平台（非空，值域 `desktop` / `mobile`） |
| `category` | ✅ | `string` | 插件类别（必须匹配预定义枚举） |
| `dependencies` | ✅ | `string[]` | 依赖的其他插件：`"<registry-id>"` 或 `"<registry-id>@<semver-range>"`（如 `"bob-dsp-pack@^2.0.0"`；无依赖填 `[]`）。id 必须对应已存在的条目；依赖成环会被 CI 拒绝 |
| `compositors` | ✅ | `string[]` | 挂载的原生 UI 插槽列表（必须匹配预定义枚举） |
| `i18n` | ✅ | `string[]` | 插件 UI 支持的语言标签列表（非空，如 `["en", "zh"]`） |
| `minAppVersion` | ⚪ | `string` | 兼容的最低客户端 semver 版本 |
| `screenshot` | ⚪ | `string` | 预览截图 URL（必须以 `https://` 开头） |
| `engines` | ⚪ | `object` | 引擎版本约束对象（如 `{ "bbebee": ">=0.1.0" }`）；每个值必须是合法的 semver 区间字符串 |
| `homepage` | ⚪ | `string` | 项目主页 URL（必须以 `https://` 开头） |
| `reviewedVersion` | ⚪ | `string` | **已审版本钉扎**：注册表已实际审核过的 npm 版本号（semver）。与 `reviewedIntegrity` 必须成对出现 |
| `reviewedIntegrity` | ⚪ | `string` | 已审版本的完整性哈希（`sha512-…` SRI，即 npm packument 中该版本的 `dist.integrity`）。CI 校验钉扎版本仍存在且哈希一致；内容校验对钉扎版本执行，npm 上出现更新的未审 `latest` 只警告不拦截（客户端始终可安装已审版本） |

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

### 4.3 界面主题（`themes/`，主题包格式 v2）

- 路径：`themes/{author}-{name}/theme.json`；`preview.png` 可选（缺失仅警告）。
- 内容在仓内维护，无需 `repo`。
- `theme.json` 是一个**主题包**：一个包内含一至多个变体，用户在应用设置中按包安装、包内切换变体。未知字段一律拒绝（包、变体、旧式三层皆然）。

包字段：

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `id` | ✅ | `string` | 包唯一标识符，小写连字符 slug |
| `name` | ✅ | `string` | 主题包名称 |
| `version` | ✅ | `string` | semver 版本号（如 `1.0.0`） |
| `author` | ✅ | `string` | 设计师/作者署名 |
| `description` | ✅ | `string` | 主题包描述 |
| `variants` | ✅ | `object[]` | 变体数组，至少一个 |

变体字段（每个变体是一套完整的运行时主题）：

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `id` | ✅ | `string` | 变体标识符；包内唯一且**全仓唯一**（客户端变体注册表是全局的） |
| `name` | ✅ | `string` | 变体名称 |
| `isDark` | ✅ | `boolean` | 是否深色变体 |
| `tokens` | ✅ | `object` | 完整的分组运行时 `ColorTokens`（`bg`/`surface`/`brand`/`gradient`/`text`/`border`/`semantic`/`music`/`glow`） |
| `lightTokens` |  | `object` | 可选的浅色配色令牌（结构同 `tokens`） |
| `cssVariables` / `lightCssVariables` |  | `object` | 可选的额外 CSS 变量覆盖 |
| `effects` |  | `object` | 可选效果预设（如 `effects.glass` 玻璃推荐值；仅为预设，用户设置优先） |
| `description` / `version` / `author` |  | `string` | 可选的变体级元数据 |

#### 规范与门禁：
1. 颜色类令牌值必须是合法的 `#hex` 字符串（`#rrggbb`、`#rrggbbaa` 或 `#rgb`）；`gradient`/`glow` 组的值为 CSS 字符串；
2. 每个变体（含 `lightTokens`，若提供）都必须通过 WCAG AA 对比度门禁（运行时 9 对检查集：正文 4.5:1，大字/主要边界 3:1）——任一变体不过门，整包校验失败，客户端安装时同样整包拒绝；
3. 提交后运行 `node scripts/build-index.mjs` 重新生成 `themes/index.json` 并一并提交（校验会重算比对，过期即报错）；
4. **旧式单主题文档仍被接受**：`theme.json` 直接带 `tokens`（内含 `dark` 和/或 `light`，至少一种；`id`/`name`/`version`/`author`/`description` 同上），每个模式同样过 `#hex` 与 AA 门禁。客户端会把旧式文档当作单变体包安装。新提交请优先用包格式。

---

## 5. 版本更新规则

- **源与主题**：任何功能修改、配置变动均必须递增条目中的 `version`（遵循 SemVer：大改升 major，加特性升 minor，修数据升 patch）。客户端依靠版本比对提示用户更新。
- **插件**：注册表条目**不携带 `version`**；版本管理完全走 npm——发布新版即 `npm publish` 递增 `package.json#version`
  （并同步 `BBeBee.plugin.json#version`），客户端通过 npm packument 检查更新。修改注册表条目元数据
  （如改描述、加 `services`）不需要"发版"，直接提 PR 更新条目 JSON 即可。
- `plugins/index.json` 是生成的聚合索引（`node scripts/build-index.mjs`），形态为
  `{ "entries": [...], "blocked": [...] }`；提交条目 PR 时如 CI 报 index 过期，本地运行一次
  该命令重新生成后一起提交（`validate.mjs` 本身也会在内存中重算并比对，过期或被手改的
  索引在校验阶段即报错）。
- **npm 包存在性与内容**：CI 会检查插件条目的 `npm` 字段是否对应 npm 上已发布的**公开**包
  （404 即失败），并拉取该包的 `BBeBee.plugin.json` 与 `package.json`（经 jsDelivr）核对。
  校验版本：条目声明了 `reviewedVersion` 钉扎时对**钉扎版本**校验（且其 `dist.integrity`
  必须与 `reviewedIntegrity` 一致）；未钉扎时对最新版校验。核对内容除 manifest 的 `id`
  等于条目 `id`、`package.json` 的 `name` 等于条目 `npm` 字段外，还包含**声明属实性交叉
  校验**：条目 `provides` 的每个键必须真实出现在包内 manifest 的 `contributes.services`
  中；manifest 若声明 `inject` 数组，条目 `services` 必须与之双向一致。不一致即失败。
  提交注册表 PR 前请先 `npm publish`，包名拼错、私有包、发错包都会被拒绝。
