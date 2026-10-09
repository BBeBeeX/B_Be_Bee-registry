# LRCLIB 歌词源

BBeBee 的默认歌词源:把 [lrclib.net](https://lrclib.net) 开放 API 的百万级逐行同步 LRC 与纯文本歌词接进歌词源体系。遵循本仓库"源是文档不是插件"的模型——`source.json` 声明元数据,`source.js` 提供被沙盒执行的 `searchLyrics` 脚本,由 `plugin-lyric-sources` 在 QuickJS 沙盒里解释执行,本目录没有任何宿主能力。

## 文件与构建

```
lyric-sources/lrclib/
├── source.json   # LyricSourceDefinition 元数据(不含 script)
├── source.js     # searchLyrics 脚本本体(编译时内联为 doc.script)
└── README.md     # 本文档
```

```bash
# 在 B_Be_Bee-registry 仓库根:
node scripts/compile.mjs       # 编译 + 校验 → dist/lyric-sources/lrclib.json(单文件,script 内联)
node scripts/validate.mjs      # 全量校验

# 在 BBeBee 主仓(源码已迁入注册表仓,主仓经 submodule registry/ 消费):
pnpm build:sources             # registry/lyric-sources → fixtures/lyric-sources/lrclib.json
                               #   并生成 packages/feature/plugin-lyric-sources/src/generated/builtin-lyric-sources.generated.ts
```

## 抓取策略

先精准后模糊,共三级:

| # | 请求 | 说明 |
|---|---|---|
| 1 | `/api/get?track_name&artist_name(&duration)` | 精确匹配:先用 `cleanTitle` 去掉 `(Remastered 2011)` / `- Live` 等后缀后的标题,未命中再用原标题;命中即返回——同步歌词优先,其次纯文本,纯音乐返回「纯音乐，请欣赏」占位行 |
| 2 | `/api/search?q="歌手 标题"` | 模糊搜索,按时长分档匹配:同步歌词 ±3s → ±6s,纯文本 ±4s;窗口全未命中则取任一同步、再取任一纯文本 |
| 3 | `/api/search?q=标题` | 纯标题兜底 |

`duration` 参数由播放器传入(毫秒,脚本内取整为秒),仅第 1 级参与精确匹配、第 2 级参与窗口判断。

## 版本与内置升级

`source.json` 的 `version` 是内置源升级标记:plugin-lyric-sources 初始化时,对 store 里同 id 的旧定义按版本比对,旧版本会被编译产物替换(保留用户的启用状态与排序)。
