# Bilibili 源说明

BBeBee 的 Bilibili 音乐源:把 B 站的视频、音频榜单、UP 主投稿、收藏夹与合集变成可搜索、可浏览、可播放的音源。遵循本仓库"音乐源是文档不是插件"的模型——`source.json` 声明规则,`source.js` 提供被规则调用的 JS 库,由 `plugin-source-runtime` 在 QuickJS 沙盒里解释执行,本目录没有任何宿主能力。

**调用流程对照 yt-dlp 的 Bilibili extractor(`yt_dlp/extractor/bilibili.py`)实现**:端点、请求参数、分页与错误码处理逐条对齐;接口字段参考 [bilibili-api-collect](https://github.com/bilibili-plugins/bilibili-api-collect),关键响应结构经直连实测核对(2026-09)。

---

## 功能一览

| # | 功能 | 入口 |
|---|---|---|
| 1 | 搜索视频(分页) | `search({ text })` → `SearchResult.tracks` |
| 2 | 搜索用户(UP主,分页) | `search({ text })` → `SearchResult.artists` |
| 3 | 音频榜单·当期/每期 | `browse()` → 音乐热榜/原创音乐榜 × 当期/每期 |
| 4 | UP 主数据 + 全部投稿 | `getArtist(mid)` → 用户卡片、合集、全部视频 |
| 5 | 收藏夹 / 合集 / 系列播放列表 | `getPlaylist(id)` → 分页取全 |
| 6 | 视频信息 / 音频流 / 字幕 | `getTrack` / `resolveStream` / `getLyrics` |
| 7 | 扫码登录 + Cookie 自动刷新 | `auth`(qrcode 流程) |

## 文件与构建

```
music-sources/bilibili/
├── source.json              # 元数据 + 规则(引用 jsLib 中的函数)
├── source.js                # jsLib:全部 @js: 规则落在这里
├── scripts/check-bilibili.mjs  # 推荐合集清单的数据自检脚本
└── README.md                # 本文档
```

```bash
# 在 bbebeex-registry 仓库根:
node scripts/compile.mjs            # 编译 + 校验 → dist/music-sources/bilibili.json(单文件,jsLib 内联)
node scripts/validate.mjs           # 全量校验(源码可读性、dist 一致性、索引新鲜度)
node scripts/compile.mjs --unpack dist/music-sources/bilibili.json unpacked/bilibili   # 反解回双文件

# 在 BBeBee 主仓(源码已迁入注册表仓,主仓经 submodule registry/ 消费):
pnpm build:sources                  # registry/music-sources → fixtures/sources/*.json
```

BBeBee 主仓语料回放测试:`packages/feature/plugin-source-runtime/src/bilibili.test.ts`
(真实 QuickJS 沙盒 + 录制响应)。`scripts/check-bilibili.mjs` 用于离线核对推荐
合集清单与本源实现的一致性。

## 规则块(source.json)

| 块 | 说明 |
|---|---|
| `header` | 顶层请求头规则(浏览器 UA + Referer),覆盖运行时自己发起的抓取(搜索/浏览) |
| `searchUrl` | `{{@js:biliSearchUrl(key, page)}}` — 视频搜索(`x/web-interface/search/type`,yt-dlp 参数集,随机 `buvid3` 引导) |
| `searchArtistUrl` | `{{@js:biliUserSearchUrl(key, page)}}` — 用户搜索(同端点 `search_type=bili_user`) |
| `ruleSearch` | 视频行:`trackId=$.bvid`,标题经 `cleanTitle`(去 `<em class="keyword">` 与实体),`parseDuration("3:33")` → 毫秒 |
| `ruleSearchArtist` | 用户行:`trackId=$.mid`、`title=$.uname`、`artwork=item.upic`,由运行时映射为 `Artist{urn,name,artwork}` |
| `exploreUrl` | `{{@js:biliExploreUrl()}}` — 生成 4 个 browse 栏目(见下;bilibili.py 没有对应流程,为本源自有的浏览面) |
| `ruleExplore` | `trackList=@js:biliExploreRows(result)` — 同一规则处理两种榜单文档(期数列表 / 歌曲列表) |
| `ruleRecommend` | `trackList=@js:biliRecommendRows(result, page)` — 推荐歌单接口:内嵌精选合集清单先随机排序(Fisher–Yates,每 6 小时或缓存失效后重洗),再从前往后每次返回 10 个;每卡片仅 1 个请求(`seasons_archives_list` 取名称/封面/UP 主 mid 并缓存,进行中的相同查询并发去重),UP 主名推迟到点开歌单页时才请求(`ruleAlbum`);卡片即 album 行,带 `childUrl` 供 `getAlbum` 缓存 |
| `ruleAlbum` | 合集元数据:`title/artwork/trackCount` 取 `seasons_archives_list` 的 `data.meta`,`artist=biliSeasonArtist(result)` | 
| `ruleTrackList` | `trackList=@js:biliSeasonTrackRows(result)` — 合集内视频行(`bvid/title/pic/duration`),UP 主名取缓存 |
| `ruleStream` | `url=resolveBiliStream(track, prefs)`;单次 playurl 取回全部音轨后按应用档位选择;`headers=biliStreamHeaders(track)`(视频页 Referer + UA,与 yt-dlp 的 `http_headers` 一致,经桌面 IPC `stream:set-headers` 注册);`seekable=true`(跳过 HEAD 探测);`expiresAt`=2 小时 |
| `ruleLyric` | `getBiliLyrics(track)` → LRC(无签名 `x/player/wbi/v2`) |
| `ruleArtist` | `getBiliArtist(id)` |
| `rulePlaylist` | `getBiliPlaylist(id, page)` |
| `ruleLibrary` | `getBiliLibraryList(kind, page)` — 登录后返回自己的收藏夹(`bili_collect_*`) |
| `loginType=qrcode` | `loginQrJs / loginPollJs / loginRefreshJs / loginCheckJs` |

**榜单浏览结构**(browse 两级:`explore` → `tracks`):

```
浏览根
├── 音乐热榜·当期   → toplist/music_list?list_id=<最新一期>   (直接出歌)
├── 音乐热榜·每期   → toplist/all_period?list_type=1          (期数列表,当期第一)
│     └── 2022年 第29期 → toplist/music_list?list_id=38      (该期歌曲)
├── 原创音乐榜·当期 / 每期                                       (同上,list_type=2)
```

`biliExploreRows(result)` 按文档形态分派:期数文档按 `publish_time` 降序(接口按年升序,须重排才能当期第一),行带 `kind: 'folder'` + `childUrl`;歌曲文档行映射到 `mv_bvid || creation_bvid`(MV/关联稿件视频),无 bvid 的纯音频行跳过(MA id 不是 auid,音频直连接口不可用,详见"已知限制")。

## jsLib 函数参考(source.js)

| 函数 | 作用 |
|---|---|
| `ensureBuvid()` | 风控引导(yt-dlp `_search_results` 方式):jar 中无 `buvid3` 时写入随机 `uuid4 + infoc`。没有 buvid3,搜索返回 -412 |
| `getWbiMixinKey()` | `x/web-interface/nav` 取 `wbi_img` 双 key,按固定置换表取前 32 位;缓存 1h,nav 失败直接报错(不再用硬编码 key 兜底) |
| `signWbiQuery(params)` | WBI 签名:`wts`(秒)入参 → 按 key 排序 → **值过滤 `!'()*`** → `encodeURIComponent` → `w_rid=md5(query+mixinKey)`。漏掉值过滤,服务端复算必不匹配 |
| `dmParams()` | yt-dlp `_dm_params`:空 `dm_img_list`、随机可打印字符 base64 的 `dm_img_str`/`dm_cover_img_str`、按厂商脚本算术生成的紧凑 `dm_img_inter`。playurl 与 arc/search 都携带 |
| `biliSearchUrl / biliUserSearchUrl` | 两个搜索 URL 的构造:同一普通端点,yt-dlp 的完整参数集(`Search_key/keyword/page/context/duration/tids_2/__refresh__/search_type/tids/highlight`) |
| `biliExploreUrl()` | 榜单栏目构造(抓两榜期数,算最新 `ID`;栏目缓存 10 分钟) |
| `biliExploreRows(result)` | 期数/歌曲两种文档 → 统一 browse 行(`kind`、`childUrl`、`durationMs` 取 `creation_duration`) |
| `trackBvid(track) / ensureCid(track)` | 从 `track.bvid || onlineId || id` 取 bvid;`x/player/pagelist` 取第一页 cid(带 `jsonp=jsonp`,yt-dlp 同参),按 bvid 缓存 1h |
| `fetchBiliPlayurl(bvid, cid, query)` | yt-dlp `_download_playinfo`:`x/player/wbi/playurl`,WBI 签名,`fnval=4048` + `dm_*`;未登录带 `try_look=1`,登录后剔除(与 yt-dlp 的 `params.pop('try_look', None)` 一致);错误码归一化为 `code * -1`,`-401/-352` 附 "please wait and try later" |
| `resolveBiliStream(track, prefs)` | 取流,见下节 |
| `biliStreamHeaders(track)` | 流请求头:视频页 `Referer`(bvid 拼出)+ 浏览器 UA;`ruleStream.headers` 渲染它 |
| `getBiliLyrics(track)` | yt-dlp `_get_subtitles`:`x/player/wbi/v2` **不签名**,有 aid 用 `aid+cid`、否则 `bvid+cid`;`need_login_subtitle` 记日志;选字幕(人工中文 > AI 中文 > 第一条)→ JSON 转 LRC(真实换行) |
| `getBiliQrCode / pollBiliQrCode` | 二维码登录:`passport …/qrcode/generate|poll`;轮询码 0=确认(Set-Cookie 自动入 jar)、86090=已扫、86038=过期、86101=未扫 |
| `refreshBiliCookie()` | Cookie 刷新:`cookie/info`(timestamp)→ RSA-OAEP-SHA256(`refresh_<ts>`)hex → `correspond/1/<hex>` 页面抓 `refresh_csrf` → `cookie/refresh` → `confirm/refresh`;新 `refresh_token` 存入 `src.vars` |
| `getBiliUploader(uid)` | yt-dlp `_get_uploader`:抓 `space.bilibili.com/<uid>` 的 `<title>…的个人空间-`;合集/系列响应缺 owner 时的兜底 |
| `fetchBiliSpacePage(uid, pn)` | yt-dlp `BilibiliSpaceVideoIE.fetch_page`:`x/space/wbi/arc/search`,WBI 签名,参数 `keyword/mid/order/order_avoided/platform/pn/ps=30/tid/web_location/special_type/index + dm_*`,Referer/Origin/Accept-Language 齐备;HTTP 412 与 code -401/-352 单独报错 |
| `getBiliArtist(id)` | 用户卡片(`x/web-interface/card`)+ 合集/系列(`seasons_series_list`,id 编码 mid)+ 全部投稿(`fetchBiliSpacePage` 按 `data.page.count` 翻页,上限 40 页);`meta.attribute == 156` 的隐藏合集映射为 album |
| `extractInitialState / getBiliInitialState` | yt-dlp `_search_json(window.__INITIAL_STATE__)` 的等价物:平衡括号提取 + JSON.parse,按 URL 缓存 5 分钟 |
| `parsePlaylistTarget(raw)` | 播放列表 id 归一化,见下节 |
| `fetchBiliMedialist(target, page)` | yt-dlp `BilibiliPlaylistIE`:`window.__INITIAL_STATE__` 判型(type/biz_id/tid/sort_field)后走 `x/v2/medialist/resource/list`,以最后一条的 `id` 作为下一页 `oid` 游标;`error/listError` 的 -400/-403/11010 单独报错 |
| `getBiliPlaylist(id, page)` | 收藏夹 / 合集 / 系列 / 播放器页面(medialist)四分支,`hasMore`+`cursor` 分页 |
| `getBiliLibraryList(kind)` | 登录后:`fav/folder/created/list-all` + `collected/list` → 自建与收藏的收藏夹 |
| `cleanTitle / cleanPic / parseDuration / previewValue` | 文本/图片/时长工具与日志预览 |

## 音频流与音质

`resolveBiliStream` 走 yt-dlp 的取流流程:`x/player/wbi/playurl` 单次请求(WBI 签名,**`fnval` 固定 4048**,WBI 位图不含 Hi-Res 位 4096——它是最常见的 `-400 请求错误` 来源),请求携带 `dm_*` 指纹参数;未登录时额外带 `try_look=1` 预览标志,登录后剔除。

**现代(DASH)视频一次响应就带回全部音轨**(30216/30232/30280,权益够时还有 30250/30251),因此不再按 `qn` 逐档请求:`qn` 与 `QN_SIGNED_OUT_CAP` 只用于下面的 legacy 路径。yt-dlp 把整张 format 列表交给自己的 selector,`ruleStream` 只能返回一个 URL,所以最后一步按应用档位阶梯挑一条,这不改变请求流程。

DASH 音频 id → 应用 `StreamQuality` 档位(对齐 B 站网页播放器给每档的文案,勿凭带宽猜测):

| id | B 站文案 | 应用档位 | 编码 |
|---|---|---|---|
| 30216 | 流畅 64K | `low` | AAC |
| 30232 | 标准 132K | `normal` | AAC |
| 30280 | 高品质 192K | `high` | AAC |
| 30250 | 杜比全景声 | `lossless`(永不选) | E-AC-3 — Chromium 解不了,按带宽排序它会赢,所以用 `undecodable` 标记显式剔除 |
| 30251 | Hi-Res 无损 | `hi-res` | FLAC |

选择按 `prefs.quality` 走档位阶梯(播放器默认 `lossless` → 优先 30251,没有就退到最好的 AAC),再过一遍 `prefs.acceptFormats`;每档内按带宽取最高。未登录时接口只发 30216/30232,阶梯自然落到底。

**Legacy(无 dash)视频**:响应只有 `durl` + `accept_quality` —— yt-dlp 会为每个缺席的 `qn` 重发一次 playurl;本源只发一次,取应用档位映射的 `qn`(`low/normal/high/lossless/hi-res` → `16/32/64/80/127`,未登录上限 64),不在 `accept_quality` 里时取不超过它的最高档。单段 `durl` 直接作为流;多段 `durl` 是 yt-dlp 会拆成多个 entry 的 flv 分片,一个 `ruleStream` URL 无法表达,故报错而不是只播第一段。

**回传实际档位**:所选结果的档位与实际 `bandwidth`(legacy 则由 `durl.size/length` 估算)由 `resolveBiliStream` 写进 `src.cache`(与签名 URL 同为 2 小时窗口),`ruleStream.quality` / `ruleStream.bitrateKbps` 在 `url` 之后读取这份缓存回传应用——应用因此知道"请求的是无损,拿到的是 192K",而不是再发一次 playurl。缓存缺失时返回空串,运行时视为字段缺席。

## 标识与 URN 约定

- 视频 trackId = `bvid`;榜单行同(mv/creation bvid)。URN:`BBeBee:<sourceId>:track:<bvid>`。
- 传给 stream/lyric 规则的 `track` = 存库 payload(原始行 + 规则求值字段)+ `id`(URN id 段),所以 `track.bvid`、`track.aid`(搜索行)、`track.cid`(收藏夹行)都在;歌词请求因此能按 yt-dlp 的规则优先用 `aid+cid`。
- 播放列表 id 接受的输入(`parsePlaylistTarget`,URL 形态对齐 yt-dlp 四个列表 extractor 的 `_VALID_URL`):

| 输入 | 归一化为 |
|---|---|
| `bili_collect_<mlid>` / 裸数字 / `space.bilibili.com/<mid>/favlist?fid=<mlid>` | 收藏夹(`x/v3/fav/resource/list` + `x/v3/fav/resource/ids`) |
| `bili_season_<mid>_<sid>` / `space.bilibili.com/<mid>/channel/collectiondetail?sid=<sid>` / `…/lists/<sid>`(无 `type=series`) | 合集(`seasons_archives_list`,**mid 必需**,实测错 mid 返回 -404) |
| `bili_series_<mid>_<sid>` / `…/channel/seriesdetail?sid=<sid>` / `…/lists/<sid>?type=series` | 系列(`x/series/series` 元数据 + `x/series/archives`) |
| `bilibili.com/list/<mid>?sid=<sid>` / `…/list/ml<id>` / `…/list/watchlater` / `…/medialist/play/<id>` | 播放器页面(yt-dlp `BilibiliPlaylistIE`):抓页面 `window.__INITIAL_STATE__` 判型,再走 `x/v2/medialist/resource/list`,以 `oid` 游标分页 |

收藏夹分支采用 yt-dlp 的两段式:`resource/ids` 一次拿全部条目与总数(缓存 10 分钟,分页在本地切),`resource/list` 取当前页的标题等元数据;`ids` 不可用时退回 `resource/list` 自身的分页。`ids` 不带标题,单纯用它会得到没有标题的行,所以两个接口都要。

## 登录与凭据

二维码登录后 `SESSDATA/bili_jct` 由 Set-Cookie 自动落入源的持久 cookie jar;`refresh_token` 存 `src.vars`(凭证级,登出清除)。`loginCheckJs: result?.code !== -101` 在每次搜索/浏览抓取后校验会话,false 触发 `AuthError` → 运行时自动跑 `loginRefreshJs` 刷新后重试一次。登录状态还解锁高音质(192K 以上 / Hi-Res 需大会员)与收藏夹列表。

## 风控要点

1. **buvid3 必需**——搜索等 web 接口对无该 cookie 的客户端直接 -412;`ensureBuvid` 按 yt-dlp 的方式在缺失时写入随机 `uuid4+infoc`。
2. **浏览器 UA + Referer**——jsLib 每个请求显式带 `BROWSER_HEADERS`;文档顶层 `header` 覆盖运行时自发起的抓取。
3. **dm_* 指纹**——playurl 与 arc/search 都带 `dm_img_*`;缺了它们被 -412 的概率明显上升(yt-dlp 专门为此合成)。
4. **WBI 签名三步缺一不可**——wts、排序、值过滤 `!'()*`;签名正确性由语料测试用文档示例密钥独立复算 `w_rid` 钉死。搜索与字幕接口按 yt-dlp 不签名,签名只用于 playurl 与 arc/search。
5. **CDN 域名会轮换**——playurl 每次可能返回 `cn-*.bilivideo.com`、`upos-*.bilivideo.com` 等不同子域,`allowedHosts` 同时声明裸父域(`bilivideo.com`)与通配(`*.bilivideo.com`)。运行时若报 "did not declare …; add it to allowedHosts and re-import",说明本机库里的旧行还是旧的域名表(或被标为本地修改后重导被拒),重新导入本目录编译出的文档即可——文档内容变化会强制更新该行。
6. `concurrentRate: "5/1000"` 声明限速;搜索一次会发 1–2 个请求(视频 + 用户,后者失败可降级)。

## 已知限制

- **榜单纯音频行不可播**:榜单条目的 `music_id`(MA…)不是旧 auid,`music-service-c` 音频接口对它返回 4511001(实测);这类行(无 mv/creation bvid)被跳过。
- **Legacy 多段 durl 不可播**:B 站旧式 flv 分片(如 `BV1ms411Q7vw`)在 yt-dlp 里是多个 entry,本源一个 URL 表达不了,会报 "legacy Bilibili stream is split into N flv fragments"。
- `load({strategy:'stream'})` 无移动端实现——长视频流播放目前仅桌面可用(仓库级 M2 缺口)。
- Hi-Res/杜比实际下发取决于账号权益;未登录音质上限 132K AAC。
- 用户搜索一次最多返回一页 20 条(接口行为);视频/用户各自分页正常。
- 合集 id 离不开 mid:旧格式 `bili_season_<sid>` 无法换算,会报带指引的错误。但 `seasons_archives_list` 实测**可以不带 mid、仅凭 `season_id` 查询**并返回 `meta`(含 mid)——推荐接口正是用它把裸 sid 解析成规范 `bili_season_<mid>_<sid>` 的。
- 推荐里的失效合集(API 返回 -404)不跳过:占位行显示"当前资源无效"(副标题点名资源),同时 `src.log` 报错带出合集名与 sid;占位计入每页 10 个。
- 隐藏合集(`attribute 156`)在 UP 主页作为 album 出现,专辑 id 由 `meta.id` 与 mid 拼出。
- UP 主投稿一次物化(上限 40 页 × 30 条),yt-dlp 是懒分页;条目极多的 UP 主需要调大 `MAX_ARTIST_PAGES`。

## 使用的接口清单(对照 yt-dlp bilibili.py / bilibili-api-collect)

| 接口 | 用途 | yt-dlp 对应 |
|---|---|---|
| `x/web-interface/search/type` | 视频 / 用户搜索(不签名) | `BiliBiliSearchIE` |
| `x/web-interface/nav` | WBI keys、登录态 | `BilibiliBaseIE._get_wbi_key` |
| `x/player/pagelist` | 分页 cid | `BiliBiliIE._real_extract` |
| `x/player/wbi/playurl` | DASH 音频流(WBI + dm_* + try_look) | `BilibiliBaseIE._download_playinfo` |
| `x/player/wbi/v2` | 字幕列表(不签名) | `BilibiliBaseIE._get_subtitles` |
| `x/space/wbi/arc/search` | UP 主全部投稿(WBI + dm_*) | `BilibiliSpaceVideoIE.fetch_page` |
| `x/polymer/web-space/seasons_series_list` | UP 主合集/系列列表 | `BilibiliCollectionListIE` 等 |
| `x/polymer/web-space/seasons_archives_list` | 合集内容 | `BilibiliCollectionListIE` |
| `x/series/series` / `x/series/archives` | 系列元数据 / 内容 | `BilibiliSeriesListIE` |
| `x/v3/fav/resource/list`、`x/v3/fav/resource/ids` | 收藏夹元数据+分页 / 全量条目 | `BilibiliFavoritesListIE` |
| `www.bilibili.com/list/*`(HTML `__INITIAL_STATE__`)、`x/v2/medialist/resource/list` | 播放器页面播放列表(oid 游标分页) | `BilibiliPlaylistIE` |
| `x/v3/fav/folder/created/list-all`、`collected/list` | 登录后收藏夹列表 | (本源自有,bilibili.py 无) |
| `x/web-interface/card` | 用户数据(头像/名称) | (本源自有) |
| `x/copyright-music-publicity/toplist/*` | 音频榜单 browse | (本源自有,bilibili.py 无) |
| `passport …/qrcode/generate|poll`、`cookie/info|refresh`、`confirm/refresh` | 登录与 Cookie 刷新 | (bilibili.py 为密码登录) |
