# 贡献指南（CONTRIBUTING）

本指南覆盖向 BBeBee 内容注册表提交条目的全流程、命名与格式要求、版本规则，以及本仓工具链的出处声明。目录结构与"应用如何消费"见 [README](README.intro.md)（README.md 的介绍部分）；审核标准见 [MODERATION.md](MODERATION.md)。

## 全流程

1. **Fork** 本仓库，从 `main` 切出分支：

   ```bash
   git checkout -b add-my-source
   ```

2. **添加条目目录**：按条目类型在 `music-sources/`、`lyric-sources/`、`themes/` 下新建目录（命名见下节），或在 `plugins/` 下添加元数据文件（格式见下文）。

3. **本地三连**（在仓库根执行，脚本只用 Node 内置模块，无需 `npm install`）：

   ```bash
   node scripts/compile.mjs          # 1) 编译 music/lyric 条目 → dist/（含校验）
   node scripts/generate-index.mjs   # 2) 重新生成 registry.json 与 README.md
   node scripts/validate.mjs         # 3) 全量校验（可读性、dist 一致性、索引新鲜度、链接）
   ```

4. **提交并推送**。注意提交顺序（原因见 [§生成文件警告](#生成文件警告)）：

   - 第一次提交：**内容**（条目目录 + 当时的生成文件）；
   - 然后重新运行 `node scripts/generate-index.mjs`（此时 git 才能算出新条目的 `updatedAt`）；
   - 第二次提交：重新生成的 `registry.json` 与 `README.md`。

   两条提交都在同一个 PR 里即可。

5. **发 PR**。CI（`.github/workflows/validate.yml`）会重新编译、重新生成索引并做 `git diff --exit-code`，再跑一遍全量校验；绿了之后等审核（见 [MODERATION.md](MODERATION.md)）。

> 提示：想检查编译产物长什么样，可以反解单文件产物：
> `node scripts/compile.mjs --unpack dist/music-sources/<目录>.json unpacked/<目录>`（解到仓库根 `unpacked/`，已被 `.gitignore` 忽略；不要解到 `music-sources/` 里面，会被当成条目目录）。

## 命名规范

- **目录名**：`{author}-{name}`，小写字母/数字、单个连字符分隔，例如 `alice-mydreamfm`。正则约束：`^[a-z0-9]+(-[a-z0-9]+)*$` 且必须含连字符。
- **五个种子目录**（`bilibili`、`lrclib`、`direct-url`、`podcast-json-feed`、`subsonic`）是从 BBeBee 主仓迁移过来的**历史名**——主仓把目录名当作 fixture 文件名消费，改名会破坏主仓的对应关系。它们在 `scripts/lib/registry-model.ts` 的 `SEED_DIR_ALLOWLIST` 里豁免；新条目一律使用 `{author}-{name}`，**不要**往豁免名单里加名字（除非确实是一次主仓迁移，并在 PR 里说明理由）。
- **插件元数据文件名**：必须等于 `<id>.json`（`id` 为小写连字符 slug）；预览图（可选）为 `<id>.preview.png`。文件名不符会被校验器直接拒绝。

## 源码可读性（硬性）

`music-sources/` 与 `lyric-sources/` 的 `source.js` 必须是**非加密、非混淆、注释完整、Node 可解析**的源码。这不是风格偏好，而是本注册表的安全模型：

- **审核人只看源码**——`scripts/` 的可读性门禁与人工审核都以源码为对象；
- **应用只消费 dist 编译产物**——`source.js` 编译后内联进 `dist/*.json` 的 `jsLib`（music）或 `script`（lyric）字段，源码本身不会被应用下载。

`scripts/lib/readability.ts` 的具体规则（任一命中即拒绝）：

| 规则 | 含义 |
| --- | --- |
| `parse` | Node（`vm.Script`，只编译不执行）无法解析 |
| `packer` | 命中经典打包器签名 `eval(function(p,a,c,k,e,...))` |
| `hex-identifiers` | 出现 `_0x…` 形态的十六进制标识符（混淆器特征） |
| `eval-atob` | base64 解码后立即执行（`eval(atob…)` / `Function(atob…)`） |
| `string-array-obfuscation` | 大字面量字符串数组 + IIFE 解码器的字符串数组混淆模式 |
| `single-line-blob` | 超过 400 字符却挤在不足 3 行代码里（压缩 blob） |
| `avg-line-length` | 平均行长超过 240 字符（疑似压缩） |
| `long-lines` | 超过 5% 的行长于 1200 字符（疑似机器生成） |
| `hex-escapes` | `\xNN` 转义超过 30 处（字符串编码混淆） |
| `comments` | 全文无注释——每份注册表源码必须带解释性注释 |

压缩/混淆脚本请直接不要提交；确有体积考虑时，提交可读源码，压缩交给分发渠道（那是插件元数据 + Release 模式的职责，不是源码模式的）。

## 版本规则

- **任何内容变更必须 bump `version`**（semver：`major.minor.patch`；行为不兼容/规则语义变化升 major，加功能升 minor，修数据或文案升 patch）。
- 应用的"更新"按钮按 **registry.json 里条目的 `version`** 与用户本地已装版本比较——不 bump 版本等于没有发布：内容改了，用户端也不会提示更新。
- `version` 对所有四类条目都是必填项，缺失或非 semver 会让 `generate-index.mjs` 直接报错。

## 各类条目格式

### 音乐源 / 歌词源（`music-sources/<author>-<name>/`、`lyric-sources/<author>-<name>/`）

目录三件套：

- `source.json` —— 规则文档。music 文档必须含 `sourceUrl`（后端站点）与 `ruleStream`；lyric 文档必须含 `id`、`name`。schema 校验与主仓用同一份 validator（见 [§校验器出处](#校验器出处声明)），不认识的 rule 字段会被拒绝。
- `source.js`（可选，但带逻辑的源必须有）—— 编译时内联：music → `jsLib`，lyric → `script`。必须满足上节的可读性硬性要求。
- `README.md` —— 必须存在。写清功能范围、`allowedHosts` 为什么需要这些域名、变量的含义。

编译产物 = `source.json` 的键 + 内联脚本（`JSON.stringify(doc, null, 2) + '\n'`），写到 `dist/<类目>/<目录名>.json`。注意：**lyric 条目的 registry id 是文档里的 `id`**（例如种子 `builtin-lrclib`），不是目录名。

### 界面主题（`themes/<author>-<name>/`）

- `theme.json` —— 完整的 ThemeDefinition：
  - 必填元数据：`id`（小写连字符 slug）、`name`、`version`、`author`；建议附 `description` 与 `isDark`。
  - `tokens`（深色）**与** `lightTokens`（浅色）都必须包含应用的全部必填 ColorTokens——应用要求深色主题也自带浅色变体。
- **双模式 WCAG AA**：`tokens` 与 `lightTokens` 各自都要通过对比度门禁（正文 4.5:1，大字/边界 3:1；`scripts/lib/theme-contrast.ts` 与应用 ui-tokens 是同一份代码）。任何一对不达标即拒绝。
- `preview.png` —— 必须存在：**1600×900**，**左浅右深拼图**（左边浅色模式、右边深色模式各占一半），文件 **≤ 1MB**。
- `README.md` 可选，建议说明设计意图。

### 插件（`plugins/<id>.json`）

注册表**只存元数据指针**，不托管插件代码。字段表：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | ✅ | 小写连字符 slug，且必须等于文件名（`<id>.json`） |
| `name` | ✅ | 显示名 |
| `version` | ✅ | semver；随插件发布 bump |
| `author` | ✅ | 作者署名 |
| `description` | ✅ | 一句话功能描述 |
| `repo` | ✅ | 插件源码仓库主页（https://） |
| `downloadUrl` | ✅ | 指向作者 Release 中的一个 **bbebee 插件包 JSON**（https://），格式见下 |
| `sha256` | ✅ | 该插件包 JSON **文件本身**的小写十六进制 sha256 |
| `minAppVersion` | 可选 | semver，低于此版本的应用不提示安装 |
| `capabilities` | 可选 | 能力字符串数组（与插件清单的 capabilities 对应） |
| `engines` | 可选 | 对象，如 `{ "bbebee": ">=0.1.0" }` |
| `homepage` | 可选 | 项目主页（https://） |

**bbebee 插件包 JSON**（`downloadUrl` 指向的文件）格式：

```json
{
  "manifest": { "...": "插件清单 PluginManifest，含入口与依赖声明" },
  "files": { "<相对路径>": "<文本内容>", "...": "..." }
}
```

`sha256` 校验的就是这整个 JSON 文件：`sha256sum bbebee-plugin-package.json`。作者更新 Release 后，需同步更新 `downloadUrl`/`sha256` 并 bump `version`。注册表的链接连通性检查（WARN-ONLY）会顺带探测 `repo` 与 `downloadUrl`。

## 生成文件警告

以下内容**由脚本生成，勿手改**——手改或漏跑脚本都会被 `validate.mjs` 以 "generated files are stale" 拒绝，CI 的 `git diff --exit-code` 也会失败：

- `registry.json`（`node scripts/generate-index.mjs`）
- `README.md` 的"条目索引"部分（同上；介绍部分来自 `README.intro.md`，那个是手工维护的）
- `dist/` 全部内容（`node scripts/compile.mjs`）

其中 `generatedAt` **不是墙钟时间**，而是所有条目 `updatedAt`（各自的 git 最后提交时间）的最大值——这样 CI 重新生成才能逐字节复现已提交的文件。也正因如此，`updatedAt` 要等条目被提交过之后才存在，请按 [§全流程](#全流程) 的"先提交内容、再重新生成、再提交生成文件"的顺序操作。另外：合并 PR 时建议维护者使用 merge commit；squash/rebase 会改写提交时间，合并后 main 的 CI 可能需要一次 `chore: regenerate` 提交来自愈。

## 校验器出处声明

`scripts/lib/` 下的三个文件**复制自 BBeBee 主仓 @ ec1ca33（2026-10-07）**，决策是**复用而非重写**：

| 文件 | 主仓出处 | 为什么复用 |
| --- | --- | --- |
| `source-validator.ts` | `scripts/sources/validator.ts` | 音乐/歌词源的 schema 权威在主仓；两套规则会出现"注册表放行、应用拒收"（或反之）的缝隙 |
| `compile.ts` | `scripts/sources/index.ts` | dist 产物必须与主仓 `pnpm build:sources` 的 fixtures 逐字节一致（键序、缩进、内联方式） |
| `theme-contrast.ts` | `packages/ui/ui-tokens/src/{color,index}.ts` | 主题在应用内由同一个对比度门禁把关；注册表必须用同一把尺子，否则"装注册表主题"就成了绕过应用可读性底线的后门 |

**同步责任**：主仓对应文件变更时，请在本仓发起 PR 同步复制，并更新各文件头部的提交号注释。CI 不做跨仓自动比对（两个仓库独立发版），一致性由审核人在 PR 里把关（见 MODERATION.md 的审核清单）。`registry-model.ts`、`readability.ts`、`plugin-meta.ts` 为本仓自有，无跨仓同步问题。
