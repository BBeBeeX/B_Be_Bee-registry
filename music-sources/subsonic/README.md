# subsonic（Subsonic 兼容服务器源）

对接任何 **Subsonic / Navidrome / Airsonic** 兼容服务器的音乐源。纯 JSON 规则
文档：没有 `source.js`，全部端点用字符串模板 + JSONPath 表达。

## 使用前提

导入后在源变量里填 `username:password`（`variableComment` 有提示）：

```
admin:s3cret
```

Navidrome 用户注意：Subsonic 协议的密码参数是可逆编码而非哈希，BBeBee 走
`f=json` 的 REST 参数携带。请使用服务器为应用单独生成的用户/密码，不要复用
主账号。

## 字段说明（节选）

| 字段 | 值 | 说明 |
|---|---|---|
| `sourceUrl` | `https://music.example.org` | 服务器基址（示例占位） |
| `searchUrl` | `/rest/search3?...` | `songCount=50`，`f=json`，客户端标识 `c=BBeBee` |
| `exploreUrl` | JSON 数组 | 两个栏目：Recently added / Alphabetical |
| `ruleExplore` | `$.subsonic-response.albumList2.album[*]` | 行类型 `=album`，`childUrl` 指向 `getAlbum` |
| `ruleStream.url` | `/rest/stream?id={{track.id}}...` | 服务端转码/原文件流 |
| `ruleLyric.lyric` | `/rest/getLyrics?...` | Subsonic 内置歌词（通常较稀，建议配合 LRCLIB 歌词源） |
| `concurrentRate` | `5/1000` | 每秒 5 个请求 |

## 测试方法

1. 起一个 Navidrome（`docker run -p 4533:4533 navidrome/navidrome`）或指向现有
   Subsonic 服务器，把 `sourceUrl` 改为实际地址。
2. 导入 `dist/music-sources/subsonic.json`，在源变量填 `user:pass`。
3. 验证：搜索出歌；Explore 两个栏目出专辑；点专辑出曲目；播放出声；
   `getLyrics` 有歌词时歌词页显示。

## 已知限制

- 未实现 Subsonic 的 starred/rating/playlist 写操作（`ruleLibrary` 缺席）。
- 服务器必须开启 REST API（Navidrome 默认开启）。
