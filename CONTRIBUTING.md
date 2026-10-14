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
   - 插件仓库根目录下提交 `index.js` 与 `manifest.json`。
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
| **插件** | `index.js` + `manifest.json` | `index.js` 为插件逻辑执行入口；`manifest.json` 声明插件元数据、所需权限及挂载点配置 |

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
- 纯指针元数据。

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `id` | ✅ | `string` | 唯一标识符，小写连字符 slug |
| `name` | ✅ | `string` | 插件显示名称 |
| `repo` | ✅ | `string` | 作者 GitHub 仓库主页，必须为 `https://github.com/<owner>/<repo>` |
| `author` | ✅ | `string` | 作者署名 |
| `description` | ✅ | `string` | 插件功能说明 |
| `capabilities` | ✅ | `string[]` | 申请的能力权限列表 |
| `category` | ✅ | `string` | 插件类别（必须匹配预定义枚举） |
| `dependencies` | ✅ | `string[]` | 依赖的其他插件 ID 列表（无依赖填写空数组 `[]`） |
| `compositors` | ✅ | `string[]` | 挂载的原生 UI 插槽列表（必须匹配预定义枚举） |
| `i18n` | ✅ | `boolean` | 是否支持国际化多语言 |
| `version` | ✅ | `string` | semver 版本号（如 `1.0.0`） |
| `minAppVersion` | ⚪ | `string` | 兼容的最低客户端 semver 版本 |
| `screenshot` | ⚪ | `string` | 预览截图 URL（必须以 `https://` 开头） |
| `engines` | ⚪ | `object` | 引擎版本约束对象（如 `{ "bbebee": ">=0.1.0" }`） |
| `homepage` | ⚪ | `string` | 项目主页 URL（必须以 `https://` 开头） |

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

任何功能修改、配置变动均必须递增 `version`（遵循 SemVer 规则：大改升 major，加特性升 minor，修数据升 patch）。客户端依靠版本比对提示用户更新。
