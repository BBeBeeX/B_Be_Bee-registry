# podcast-json-feed（示例播客源）

把一个以 **JSON Feed 1.1**（[jsonfeed.org](https://jsonfeed.org)）发布的播客
接进 BBeBee：`exploreUrl` 指向 `feed.json`，`ruleExplore` 用 JSONPath 把
`items[*]` 映射成可播放的行，`ruleStream` 取每条 item 的附件 URL。

> RSS/XML 播客需要 `@xpath:` / `@css:` 引擎，当前构建未内置——所以本示例选择
> JSON Feed 这种纯 JSON 形态，全部规则只用 JSONPath 与字符串模板表达。

## 字段说明

| 字段 | 值 | 说明 |
|---|---|---|
| `sourceUrl` | `https://podcast.example.org` | 后端基址（示例占位） |
| `sourceType` | `podcast` | 播客形态 |
| `exploreUrl` | `{{source.url}}/feed.json` | JSON Feed 文档 |
| `ruleExplore.trackList` | `$.items[*]` | 每条 episode 一行 |
| `ruleExplore.durationMs` | `$.attachments[0].duration_in_seconds##$##000` | 秒 → 毫秒 |
| `ruleExplore.streamUrl` | `$.attachments[0].url` | 行内携带流地址 |
| `ruleStream.url` | `={{track.streamUrl}}` | 播放时读取行上的流地址 |
| `allowedHosts` | `cdn.example.org` | 附件 CDN，**安装前请核对** |

## 测试方法

1. 找一个以 JSON Feed 发布的播客（或用 `https://podcast.example.org` 的自建
   静态 feed），把 `sourceUrl` 与 `allowedHosts` 改成实际主机。
2. 导入 `dist/music-sources/podcast-json-feed.json`，浏览页应列出 episodes，
   点开即可播放。
3. 若换用 RSS 播客，本源规则不适用——需要等待 XML 引擎，见主仓
   `rules/sources.md` 的引擎支持表。
