# direct-url（示例直链源）

一个**直链音频源**：没有搜索、没有浏览，`ruleStream` 直接返回 `sourceUrl` 本身。
它是 BBeBee 主仓测试语料中的"地板"文档——一个源能少到什么程度，以及 UI 在能力
缺失时是否仍然可用（"If a screen breaks with this imported, something is
reading a capability it never checked."）。

同时它也是一个真实可用形态的最小模板：把 `sourceUrl` 换成任何一个稳定的
mp3/ogg 直链，导入即可播放。

## 字段说明

| 字段 | 值 | 说明 |
|---|---|---|
| `sourceUrl` | `https://stream.example.org/live.mp3` | 后端基址，同时是流地址（示例占位，导入后可改） |
| `sourceType` | `radio` | 直链电台形态：无搜索/浏览面 |
| `ruleStream.url` | `={{source.url}}` | 直接引用源变量 `source.url`（即 `sourceUrl`） |
| `ruleStream.mimeType` | `audio/mpeg` | 跳过嗅探 |
| `ruleStream.seekable` | `false` | 直链通常不可跳转 |

## 测试方法

1. 把 `sourceUrl` 改成一个真实可播的音频直链（本地 `http://127.0.0.1:8000/a.mp3`
   也可以，`allowedHosts` 会自动包含 `sourceUrl` 的主机）。
2. BBeBee → 设置 → 音乐源 → 导入：粘贴 `dist/music-sources/direct-url.json`
   的内容（或直接导入该文件）。
3. 播放列表里应出现该源且仅提供一条流；搜索/浏览/歌词面板应显示为不可用，
   而不是报错崩溃。
