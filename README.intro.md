# BBeBee 内容注册表（bbebeex-registry）

BBeBee 音乐播放器的**第三方内容注册表**：社区在这里发布与共享四类内容——

- **音乐源**（`music-sources/`）—— 一份 JSON 规则文档加一份可读的 JS 库，把任意站点或服务变成 BBeBee 的音源；
- **歌词源**（`lyric-sources/`）—— 接入歌词数据库的沙盒脚本；
- **界面主题**（`themes/`）—— 通过深浅双模式 WCAG AA 对比度门禁的 ThemeDefinition；
- **插件**（`plugins/`）—— 只存指向作者发布的元数据指针。

注册表组织方式参考 dms-plugin-registry 的模式：**源与主题的完整内容进仓**（进入审核流程、由 CI 编译出单文件产物），**插件只存元数据**（`downloadUrl` 指向作者自己的 Release，注册表不托管、不编译插件代码）。

## 应用如何消费

[`registry.json`](registry.json) 是应用消费本仓的**唯一入口**。其中每个条目的 `downloadUrl` 指向本仓 `dist/` 目录下的**编译产物**——源码目录里的 `source.json` + `source.js` 由 CI 内联编译成单文件 JSON（music 内联为 `jsLib`，lyric 内联为 `script`）。

**应用只消费 `dist/` 编译产物；仓库里的源码是给人审的**，不会被应用下载。这意味着：审核人看 `music-sources/<目录>/source.js`，用户装到的是 `dist/<目录>.json`，两者由 CI 的字节比对强制一致。

## 目录结构

```
bbebeex-registry/
├── registry.json              # 应用消费的唯一入口（脚本生成，勿手改）
├── README.md                  # 本文件 + 自动生成的条目索引（脚本生成，勿手改）
├── README.intro.md            # 本文件的介绍部分（手工维护）
├── CONTRIBUTING.md            # 贡献指南：流程、命名、格式、版本规则
├── MODERATION.md              # 审核标准、审核流程、下架流程
├── music-sources/<author>-<name>/
│   ├── source.json            # 规则文档（sourceUrl + 各 rule* 块）
│   ├── source.js              # jsLib：被 @js: 规则调用的可读源码
│   └── README.md              # 人读的功能说明
├── lyric-sources/<author>-<name>/
│   ├── source.json            # 元数据（id/name/version/…）
│   ├── source.js              # 沙盒脚本（编译为 script 字段）
│   └── README.md
├── themes/<author>-<name>/
│   ├── theme.json             # ThemeDefinition（tokens + lightTokens）+ 元数据
│   ├── preview.png            # 1600×900 预览拼图（左浅右深，≤ 1MB）
│   └── README.md
├── plugins/<id>.json          # 插件元数据指针（不存插件代码）
├── dist/                      # 编译产物（脚本生成；应用实际从这里下载）
└── scripts/                   # 编译 / 索引 / 校验工具（纯 Node 内置模块，零 npm 依赖）
```

## 快速开始

1. Fork 本仓库，从 `main` 切出一个分支；
2. 按上面的目录结构添加你的条目目录（命名 `{author}-{name}`）；
3. 在仓库根运行三条命令：

   ```bash
   node scripts/compile.mjs          # 编译 music/lyric 条目 → dist/
   node scripts/generate-index.mjs   # 重新生成 registry.json 与 README.md
   node scripts/validate.mjs         # 本地全量校验（CI 会再跑一遍）
   ```

4. 连同重新生成的 `registry.json`、`README.md`、`dist/` 一起提交，发起 PR。

格式细节、版本规则与提交顺序见 [CONTRIBUTING.md](CONTRIBUTING.md)；审核标准与下架流程见 [MODERATION.md](MODERATION.md)。

## 免责声明

- 本注册表收录的所有第三方内容（音乐源、歌词源、主题、插件）由社区成员提交，**与 BBeBee 及注册表维护者无关**；请在条目元数据中如实署名。
- 每个源声明的 `allowedHosts`（允许访问的域名列表）会在**安装时向用户明示**，经用户确认后才会生效；安装前请核对该列表与作者信息。
- 请只提交你有权分发的内容；抓取第三方站点时请遵守其服务条款与当地法律。
