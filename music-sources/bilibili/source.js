// Bilibili source library — every rule in source.json lands here.
//
// The flow mirrors yt-dlp's Bilibili extractor
// (yt_dlp/extractor/bilibili.py), endpoint for endpoint and parameter for
// parameter:
//
//   search          BiliBiliSearchIE._search_results
//                   GET x/web-interface/search/type with Search_key/keyword/
//                   page/context/duration/tids_2/__refresh__/search_type/
//                   tids/highlight, after bootstrapping a random buvid3.
//   playurl         BilibiliBaseIE._download_playinfo
//                   GET x/player/wbi/playurl, WBI-signed, fnval=4048, the
//                   dm_img_* fingerprint params, and try_look=1 when signed
//                   out (popped when signed in). Error codes are normalised
//                   the way yt-dlp normalises them: code * -1, 401/352
//                   expected, "please wait and try later".
//   legacy streams  BiliBiliIE._real_extract
//                   when the response has no `dash`, the video is pre-DASH:
//                   durl + accept_quality. yt-dlp re-asks every qn; the
//                   source asks once for the qn its tier maps to.
//   subtitles       BilibiliBaseIE._get_subtitles
//                   GET x/player/wbi/v2, unsigned, aid+cid when the aid is
//                   known and bvid+cid otherwise, then the subtitle JSON.
//   artist uploads  BilibiliSpaceVideoIE
//                   GET x/space/wbi/arc/search with keyword/mid/order/
//                   order_avoided/platform/pn/ps/tid/web_location/
//                   special_type/index + dm_*; ps=30; HTTP 412 and code
//                   -401/-352 named; meta.attribute 156 (hidden-mode
//                   collection) becomes an album.
//   favourites      BilibiliFavoritesListIE
//                   GET x/v3/fav/resource/list (metadata + the page's rows)
//                   and GET x/v3/fav/resource/ids (the full entry list).
//   collections     BilibiliCollectionListIE
//                   GET x/polymer/web-space/seasons_archives_list.
//   series          BilibiliSeriesListIE
//                   GET x/series/series (metadata) + x/series/archives.
//
// Deviations the source model forces, all documented in README.md:
//
//   * `ruleStream` must return one URL for one chosen tier, where yt-dlp
//     hands its whole format list to a selector. Candidate collection, the
//     try_look branch and the legacy accept_quality walk are yt-dlp's; the
//     final pick is the app's quality ladder.
//   * `getArtist` materialises the upload pages (bounded) instead of paging
//     lazily, because the artist rule returns one fixed list.
//   * a legacy durl response with more than one fragment is a multi-part flv
//     stream that yt-dlp splits into separate entries; one `ruleStream` URL
//     cannot represent it, so it is refused with a named error instead of
//     playing only the first part silently.
//   * the chart browse tree (`biliExploreUrl`) has no counterpart in
//     bilibili.py; it is kept as the source's browse surface.

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  'Referer': 'https://www.bilibili.com/',
  'Origin': 'https://www.bilibili.com',
};

// Per docs/misc/sign/wbi.md: the first 32 entries index the concatenated
// img_key+sub_key into the mixin key. Fixed by the web client, not secret.
// yt-dlp hard-codes the same table in BilibiliBaseIE._get_wbi_key.
const WBI_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52
];

// DASH audio ids → the app's `StreamQuality` tiers, per the label Bilibili's
// own player shows for each id:
//
//   id     web label       app tier
//   30216  流畅 64K         low
//   30232  标准 132K        normal
//   30280  高品质 192K       high
//   30250  杜比全景声        lossless
//   30251  Hi-Res 无损      hi-res
//
// 30250 is Dolby Atmos (E-AC-3) — Chromium cannot decode it, so it is mapped
// for reporting but never chosen; the ladder walks a decoded tier list
// instead of raw bandwidth, because by bandwidth Dolby wins every sort and
// produces a track that cannot play.
const AUDIO_TIERS = {
  30216: 'low',
  30232: 'normal',
  30280: 'high',
  30250: 'lossless',
  30251: 'hi-res',
};

const AUDIO_LADDER = {
  low: ['low', 'normal', 'high', 'hi-res'],
  normal: ['normal', 'high', 'low', 'hi-res'],
  high: ['high', 'normal', 'low', 'hi-res'],
  // The player asks for 'lossless' by default; FLAC when the response carries
  // it, the best AAC otherwise. Dolby is absent on purpose — see AUDIO_TIERS.
  lossless: ['hi-res', 'high', 'normal', 'low'],
  'hi-res': ['hi-res', 'high', 'normal', 'low'],
};

// `qn` only matters on the legacy (pre-DASH) path now: playurl with fnval
// 4048 answers every DASH audio track at once, so the modern path never asks
// for a quality. When there is no dash, `qn` still selects the muxed durl
// quality, and yt-dlp's `accept_quality` walk is the same knob. The mapping
// is the web player's:
//
//   app tier   qn   label
//   low        16   360P 流畅
//   normal     32   480P 清晰
//   high       64   720P 高清   (WEB default; works signed out)
//   lossless   80   1080P 高清  (TV/APP default; requires login)
//   hi-res     127  8K 超高清   (requires membership)
const QN_FOR_QUALITY = {
  low: 16,
  normal: 32,
  high: 64,
  lossless: 80,
  'hi-res': 127,
};
const QN_SIGNED_OUT_CAP = 64;
// The reverse map, for reporting a legacy durl's actual tier.
const TIER_FOR_QN = {
  16: 'low',
  32: 'normal',
  64: 'high',
  80: 'lossless',
  127: 'hi-res',
};

// yt-dlp's artist/space flow is an InAdvancePagedList with no ceiling; this
// source materialises `topTracks` in one call, so the walk is bounded.
const MAX_ARTIST_PAGES = 40;

// Python's `string.printable`, for the dm_img_str/dm_cover_img_str noise.
const PRINTABLE = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~ \t\n\r\x0b\x0c';

// yt-dlp's BilibiliBaseIE.__screen_dimensions: a weighted pick the fingerprint
// script expects to see from a real browser.
const SCREEN_DIMENSIONS = [
  [[1920, 1080], 18],
  [[1366, 768], 18],
  [[1536, 864], 17],
  [[1280, 720], 8],
  [[2560, 1440], 7],
  [[1440, 900], 5],
  [[1600, 900], 5],
];

// One-line preview of a return value, for src.log. Long strings and objects
// are clipped so a search page full of rows does not flood the log buffer.
function previewValue(v, limit) {
  limit = limit || 240;
  var s;
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v);
  } catch (e) {
    s = String(v);
  }
  if (s === undefined) s = 'undefined';
  if (s.length > limit) s = s.slice(0, limit) + '…(' + s.length + ' chars)';
  return s;
}

function cleanTitle(s) {
  if (!s) return '';
  return String(s)
    .replace(/<em class="keyword">/g, '')
    .replace(/<\/em>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&');
}

function cleanPic(pic) {
  if (!pic) return '';
  return pic.startsWith('http') ? pic : 'https:' + (pic.startsWith('//') ? '' : '//') + pic;
}

function parseDuration(d) {
  if (d == null) return 0;
  if (typeof d === 'number') {
    return Math.round(d * 1000);
  }
  var parts = String(d).trim().split(':').map(p => parseInt(p, 10) || 0);
  if (parts.length === 3) {
    return ((parts[0] * 3600) + (parts[1] * 60) + parts[2]) * 1000;
  }
  if (parts.length === 2) {
    return ((parts[0] * 60) + parts[1]) * 1000;
  }
  return (parts[0] || 0) * 1000;
}

/** A v4-shaped UUID; yt-dlp uses `uuid.uuid4()` for exactly this purpose. */
function randomUuid() {
  const h = src.crypto.randomHex(16);
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-4' + h.slice(13, 16) + '-' +
    ((parseInt(h[16], 16) & 0x3 | 0x8).toString(16)) + h.slice(17, 20) + '-' +
    h.slice(20, 32);
}

/**
 * buvid3, once per realm — BiliBiliSearchIE._search_results' bootstrap.
 *
 * Search (and much of the web API) is behind risk control that answers -412
 * to a cookieless client. yt-dlp sets `{uuid4}infoc` when the cookie is
 * absent; the request below does the same, and the cookie lands in the
 * source's own jar on the bare domain so every later api.bilibili.com call
 * carries it.
 */
async function ensureBuvid() {
  try {
    const existing = await src.cookie.get('buvid3');
    if (existing) return;
    const buvid = randomUuid() + 'infoc';
    // The bare domain, not api.bilibili.com — one jar entry covering every
    // bilibili.com subdomain the document talks to.
    await src.cookie.set('buvid3', buvid, 'https://www.bilibili.com');
    src.log('ensureBuvid → buvid3 ' + previewValue(buvid, 16) + '… set');
  } catch (e) {
    // Search may still work (or the next call retries); not fatal here.
    src.log('ensureBuvid → failed: ' + previewValue(String(e && e.message || e), 120));
  }
}

/**
 * The WBI mixin key, from the nav endpoint.
 *
 * BilibiliBaseIE._get_wbi_key caches it for 30 seconds; the source caches it
 * for an hour because the realm is per source and the keys rarely rotate.
 * A failure to read nav is reported rather than papered over: a wrong mixin
 * key signs a w_rid the server refuses (-403), which is harder to diagnose
 * than a thrown error naming nav.
 */
async function getWbiMixinKey() {
  const cached = src.cache.get('bili_wbi_mixin_key');
  if (cached) {
    src.log('getWbiMixinKey → cached key ' + previewValue(cached, 16) + '…');
    return String(cached);
  }

  const res = await src.get('https://api.bilibili.com/x/web-interface/nav', { headers: BROWSER_HEADERS });
  const json = src.parse.json(res.body);
  const wbi = json && json.data && json.data.wbi_img;
  if (!wbi || !wbi.img_url || !wbi.sub_url) {
    src.log('getWbiMixinKey → nav answered without wbi_img: ' + previewValue(res.body, 160));
    throw new Error('cannot read WBI keys from the nav endpoint');
  }
  const imgKey = wbi.img_url.slice(wbi.img_url.lastIndexOf('/') + 1, wbi.img_url.lastIndexOf('.'));
  const subKey = wbi.sub_url.slice(wbi.sub_url.lastIndexOf('/') + 1, wbi.sub_url.lastIndexOf('.'));
  const rawKey = imgKey + subKey;

  let mixinKey = '';
  for (let i = 0; i < 32; i++) {
    mixinKey += rawKey[WBI_ENC_TAB[i]] || '';
  }
  src.cache.put('bili_wbi_mixin_key', mixinKey, 3600000);
  src.log('getWbiMixinKey → new mixin key ' + previewValue(mixinKey, 16) + '…');
  return mixinKey;
}

/**
 * WBI signing, per docs/misc/sign/wbi.md and BilibiliBaseIE._sign_wbi.
 *
 * The step that is easy to lose: values are stripped of `!'()*` *before*
 * encoding, because that is what the server repeats before hashing — sign
 * the unfiltered value and every request answers -403.
 */
async function signWbiQuery(params) {
  const mixinKey = await getWbiMixinKey();
  const allParams = { ...params, wts: Math.floor(src.time.now() / 1000) };
  const pairs = [];
  for (const k of Object.keys(allParams).sort()) {
    const v = allParams[k];
    if (v === undefined || v === null) continue;
    const filtered = String(v).replace(/[!'()*]/g, '');
    pairs.push(src.url.encode(k) + '=' + src.url.encode(filtered));
  }
  const queryStr = pairs.join('&');
  const signed = queryStr + '&w_rid=' + src.crypto.md5(queryStr + mixinKey);
  src.log('signWbiQuery → ' + previewValue(signed));
  return signed;
}

/**
 * The dm_img_* request fingerprint — BilibiliBaseIE._dm_params.
 *
 * Bilibili's risk control compares these against the browser fingerprint it
 * expects; yt-dlp synthesises them (an empty dm_img_list, random printable
 * base64 noise for the two image strings, and a compact dm_img_inter built
 * from the same arithmetic the vendor script uses). Without them a playurl
 * or space request is materially more likely to be answered with -412.
 */
function dmParams() {
  const rand = (n) => Math.floor(Math.random() * n);
  const noise = (n) => {
    let out = '';
    for (let i = 0; i < n; i++) out += PRINTABLE[rand(PRINTABLE.length)];
    return out;
  };
  const getWh = (width, height) => {
    const rnd = Math.floor(114 * Math.random());
    return [2 * width + 2 * height + 3 * rnd, 4 * width - height + rnd, rnd];
  };
  const getOf = (scrollTop, scrollLeft) => {
    const rnd = Math.floor(514 * Math.random());
    return [3 * scrollTop + 2 * scrollLeft + rnd, 4 * scrollTop - 4 * scrollLeft + 2 * rnd, rnd];
  };
  let total = 0;
  for (const entry of SCREEN_DIMENSIONS) total += entry[1];
  let pick = Math.random() * total;
  let dimensions = SCREEN_DIMENSIONS[0][0];
  for (const entry of SCREEN_DIMENSIONS) {
    pick -= entry[1];
    if (pick < 0) {
      dimensions = entry[0];
      break;
    }
  }
  return {
    dm_img_list: '[]',
    dm_img_str: src.crypto.base64Encode(noise(16 + rand(49))).slice(0, -2),
    dm_cover_img_str: src.crypto.base64Encode(noise(32 + rand(97))).slice(0, -2),
    dm_img_inter: JSON.stringify({
      ds: [],
      wh: getWh(dimensions[0], dimensions[1]),
      of: getOf(rand(101), 0),
    }),
  };
}

/**
 * Video search — BiliBiliSearchIE._search_results.
 *
 * The parameters are yt-dlp's verbatim (Search_key and keyword are the same
 * value; the rest tell the backend this is the web client's own search
 * request). The endpoint is the unsigned one: the buvid3 bootstrap above is
 * what risk control checks, and yt-dlp never WBI-signs search.
 */
async function biliSearchUrl(key, page) {
  await ensureBuvid();
  const params = {
    Search_key: key,
    keyword: key,
    page: page || 1,
    context: '',
    duration: 0,
    tids_2: '',
    __refresh__: 'true',
    search_type: 'video',
    tids: 0,
    highlight: 1,
  };
  const query = Object.keys(params)
    .map((k) => src.url.encode(k) + '=' + src.url.encode(params[k]))
    .join('&');
  const url = 'https://api.bilibili.com/x/web-interface/search/type?' + query;
  src.log('biliSearchUrl("' + previewValue(key) + '", ' + (page || 1) + ') → ' + url);
  return url;
}

/**
 * The user half of search, per docs/search/search_request.md's 分类搜索:
 * same endpoint and the same parameter set, `search_type=bili_user`. Rows are
 * UP主 (mid, uname, upic), which the artist rules map onto the artist page.
 * bilibili.py has no user search; the video half above it does.
 */
async function biliUserSearchUrl(key, page) {
  await ensureBuvid();
  const params = {
    Search_key: key,
    keyword: key,
    page: page || 1,
    context: '',
    duration: 0,
    tids_2: '',
    __refresh__: 'true',
    search_type: 'bili_user',
    tids: 0,
    highlight: 1,
  };
  const query = Object.keys(params)
    .map((k) => src.url.encode(k) + '=' + src.url.encode(params[k]))
    .join('&');
  const url = 'https://api.bilibili.com/x/web-interface/search/type?' + query;
  src.log('biliUserSearchUrl("' + previewValue(key) + '", ' + (page || 1) + ') → ' + url);
  return url;
}

/**
 * The audio-area charts, per docs/audio/rank.md (music.bilibili.com/pc/rank).
 * No counterpart in bilibili.py — kept as the source's browse surface.
 *
 * Browse is two stages deep, so the four sections carry both shapes the
 * toplist API answers with: 当期 sections point straight at the current
 * issue's song list, and 每期 sections point at the period list whose rows
 * descend into the same song list for their own issue. The latest issue id
 * needs a fetch to know, so this runs at browse time (cached briefly), not
 * at import.
 */
async function biliExploreUrl() {
  await ensureBuvid();
  const cached = src.cache.get('bili_explore_sections');
  if (cached) return cached;

  const charts = [
    { listType: 1, name: '音乐热榜' },
    { listType: 2, name: '原创音乐榜' },
  ];
  const sections = [];
  for (const chart of charts) {
    let latestId;
    try {
      const res = await src.get('https://api.bilibili.com/x/copyright-music-publicity/toplist/all_period?list_type=' + chart.listType, { headers: BROWSER_HEADERS });
      const list = src.parse.json(res.body)?.data?.list || {};
      // Years iterate ascending on numeric-like keys; the newest issue is
      // the one with the greatest publish time across all of them.
      let newest = 0;
      for (const year of Object.keys(list)) {
        for (const period of list[year] || []) {
          if ((period.publish_time || 0) >= newest) {
            newest = period.publish_time || 0;
            latestId = period.ID;
          }
        }
      }
    } catch (e) {
      src.log('biliExploreUrl(' + chart.name + ') → all_period failed: ' + previewValue(String(e && e.message || e), 120));
    }
    if (latestId) {
      sections.push({ title: chart.name + '·当期', url: 'https://api.bilibili.com/x/copyright-music-publicity/toplist/music_list?list_id=' + latestId });
    }
    sections.push({ title: chart.name + '·每期', url: 'https://api.bilibili.com/x/copyright-music-publicity/toplist/all_period?list_type=' + chart.listType });
  }

  const out = JSON.stringify(sections);
  src.cache.put('bili_explore_sections', out, 600000);
  src.log('biliExploreUrl → ' + previewValue(out));
  return out;
}

/** The bvid a chart row plays through — its MV, else the video it is known from. */
function biliChartBvid(item) {
  return item.mv_bvid || item.creation_bvid || '';
}

/**
 * Rows for both documents the chart API answers with.
 *
 * `toplist/all_period` returns the issue list as an object keyed by year
 * (ascending on numeric keys, so it is re-sorted newest first — the current
 * issue must be the first row a user sees); `toplist/music_list` returns one
 * issue's songs. Rows without an mv/creation bvid are skipped: the audio
 * behind them has no usable stream without a login-backed entitlement route,
 * and a row that cannot play is worse than a shorter chart.
 */
function biliExploreRows(result) {
  const data = result && result.data ? result.data : {};
  const list = data.list;
  if (Array.isArray(list)) {
    const rows = [];
    for (const item of list) {
      const bvid = biliChartBvid(item);
      if (!bvid) continue;
      rows.push({
        kind: 'track',
        trackId: bvid,
        bvid: bvid,
        title: item.music_title || item.creation_title || bvid,
        artist: item.singer || item.creation_nickname || '',
        album: item.album || '',
        artwork: item.mv_cover || item.creation_cover || '',
        durationMs: item.creation_duration ? item.creation_duration * 1000 : undefined,
      });
    }
    src.log('biliExploreRows → ' + rows.length + ' song row(s) of ' + list.length);
    return rows;
  }

  const periods = [];
  for (const year of Object.keys(list || {})) {
    for (const period of list[year] || []) {
      periods.push({ year: year, period: period });
    }
  }
  periods.sort((a, b) => (b.period.publish_time || 0) - (a.period.publish_time || 0));
  const rows = periods.map(({ year, period }) => ({
    kind: 'folder',
    trackId: 'bili_toplist_' + period.ID,
    title: (year ? year + '年 ' : '') + '第' + period.priod + '期',
    childUrl: 'https://api.bilibili.com/x/copyright-music-publicity/toplist/music_list?list_id=' + period.ID,
  }));
  src.log('biliExploreRows → ' + rows.length + ' issue row(s)');
  return rows;
}

/**
 * The curated recommendation shelf — bilibili 合集 (seasons), one page of
 * ten at a time through `biliRecommendRows`.
 *
 * The ids are bare season ids collected from the web app's own recommendation
 * listings; everything a card shows (name, cover, the UP's mid and name) is
 * resolved per id at read time and cached, because a season id alone carries
 * none of it. Titles are the listing's own with the shared "推荐歌单 " prefix
 * stripped — the live `meta.name` wins whenever the fetch answers.
 */
const BILI_RECOMMEND_SEASONS = [
  { sid: '96979', title: "合集·神州电音" },
  { sid: '332081', title: "合集·外语电影歌曲" },
  { sid: '639664', title: "合集·音乐现场" },
  { sid: '2974446', title: "合集·华语电影配乐" },
  { sid: '1601474', title: "合集·纯音乐" },
  { sid: '323945', title: "合集·外语电影配乐" },
  { sid: '6046274', title: "合集·今日宜开心*（日语歌）" },
  { sid: '6046480', title: "合集·今日宜开心*（纯音乐）" },
  { sid: '8244938', title: "合集·今日宜开心*（英文歌）" },
  { sid: '6046494', title: "合集·今日宜开心*（中文歌）" },
  { sid: '6046513', title: "合集·今日宜开心*（其他）" },
  { sid: '1690393', title: "合集·明日也宜开心*" },
  { sid: '4375028', title: "合集·『酸酸甜甜~橘子不是青柠。』" },
  { sid: '8772625', title: "合集·『就是青柠啊~酸酸甜甜。』" },
  { sid: '7011008', title: "合集·『橘子不是青柠~酸酸甜甜。』" },
  { sid: '4416910', title: "合集·『酸酸~橘子不是青柠~甜甜。』" },
  { sid: '649405', title: "合集·日语歌曲合集" },
  { sid: '672537', title: "合集·英语歌曲合集" },
  { sid: '4390639', title: "合集·英语循环" },
  { sid: '4060742', title: "合集·日语循环" },
  { sid: '4162973', title: "合集·中文歌曲合集" },
  { sid: '4392304', title: "合集·小曲の循环" },
  { sid: '4390627', title: "合集·中文循环" },
  { sid: '672542', title: "合集·纯音乐歌曲合集" },
  { sid: '4803718', title: "合集·一小时循环单曲" },
  { sid: '3876365', title: "合集·日推小众歌单" },
  { sid: '2209498', title: "合集·复古/流行" },
  { sid: '1698063', title: "合集·纯音乐/新世纪/电子" },
  { sid: '1698017', title: "合集·哥特/交响" },
  { sid: '2209438', title: "合集·各种摇滚金属" },
  { sid: '1698068', title: "合集·旋死" },
  { sid: '1698036', title: "合集·桶哥" },
  { sid: '7888554', title: "合集·橙子青提·小众歌单合集" },
  { sid: '1390756', title: "合集·日推宝藏/中文" },
  { sid: '7175888', title: "合集·Playlist歌单" },
  { sid: '3640197', title: "合集·宝藏日语歌单』惊艳你的双耳" },
  { sid: '3350583', title: "合集·『宝藏欧美歌单』拨动你的心弦" },
  { sid: '6313946', title: "合集·主题歌单" },
  { sid: '3621873', title: "合集·『宝藏纯音乐歌单』倾听心动旋律" },
  { sid: '515827', title: "合集·狗粮之歌" },
  { sid: '3600329', title: "合集·音乐 💠 最终幻想14" },
  { sid: '3887187', title: "合集·【 日推 ◈ 舒缓解压】" },
  { sid: '6103697', title: "合集·【𝐏𝐥𝐚𝐲𝐥𝐢𝐬𝐭】" },
  { sid: '3639888', title: "合集·【日推歌单】" },
  { sid: '3793988', title: "合集·【网络 ☁ 歌单】" },
  { sid: '3942332', title: "合集·【日推 ♨ 盲盒】" },
  { sid: '5168035', title: "合集·《星际战甲》游戏原声带合集" },
  { sid: '4860637', title: "合集·《假面骑士》系列音乐合集" },
  { sid: '5328926', title: "合集·《云顶之弈》游戏原声带合集" },
  { sid: '6110632', title: "合集·《战锤40K:暗潮》游戏原声带合集" },
  { sid: '4134881', title: "合集·《刺客信条》游戏原声带合集" },
  { sid: '6791640', title: "合集·《英雄联盟》游戏原声带合集（2025年起）" },
  { sid: '225818', title: "合集·KingGnu MV" },
  { sid: '205152', title: "合集·KingGnu LIVE" },
  { sid: '7608379', title: "合集·英文精选" },
  { sid: '7634375', title: "合集·美景音乐" },
  { sid: '428037', title: "合集·电音" },
  { sid: '432479', title: "合集·影视原声" },
  { sid: '980085', title: "合集·纯音乐" },
  { sid: '980124', title: "合集·史诗｜战歌" },
  { sid: '2209469', title: "合集·误以为是中国的日本纯音乐" },
  { sid: '276748', title: "合集·席琳迪翁" },
  { sid: '274487', title: "合集·肖恩沃德" },
  { sid: '274592', title: "合集·恩雅" },
  { sid: '428024', title: "合集·西城男孩" },
  { sid: '274648', title: "合集·中外翻唱" },
  { sid: '274512', title: "合集·林肯公园" },
  { sid: '8996743', title: "合集·【合集2.0版】Playlist（纯音乐+白噪音）" },
  { sid: '2017771', title: "合集·【合集1.0版】Playlist（背景音乐）" },
  { sid: '3027328', title: "【合集】𝐏𝐥𝐚𝐲𝐥𝐢𝐬𝐭（英文歌单）" },
  { sid: '3349852', title: "合集·【尊享版】𝑷𝒍𝒂𝒚𝒍𝒊𝒔𝒕（纯音乐）" },
  { sid: '1215213', title: "合集·【合集】钢琴爵士乐" },
  { sid: '1524388', title: "合集·最终幻想16官方音乐" },
  { sid: '10580', title: "合集·雅尼Yanni的音乐合集" },
  { sid: '4892161', title: "合集·旅途助眠 | 治愈" },
  { sid: '5045476', title: "合集·旅途专注 | 解压" },
  { sid: '5575138', title: "合集·旅途学习 | 沉浸图书馆" },
  { sid: '5321624', title: "合集·旅途冥想 | 瑜伽" },
  { sid: '2432263', title: "合集·雅尼经典曲目集！！！" },
  { sid: '731984', title: "合集·FF14歌词翻译" },
  { sid: '625271', title: "合集·fripSide II 精选Live合集" },
  { sid: '8436400', title: "合集·FTSC SURROUND AUDIO" },
  { sid: '4456026', title: "合集·古典杜比全景声合集" },
  { sid: '7998243', title: "合集·FANTASONIC Immersive Soundbook by SVRE" },
  { sid: '8296583', title: "合集·IMMERSIVE KARAOKE！" },
  { sid: '8055439', title: "合集·Michael Jackson" },
  { sid: '6407641', title: "合集·FANTASONIC SOUNDBOOK" },
  { sid: '6111931', title: "合集·ワインレッドの心 杜比全景声" },
  { sid: '5334215', title: "合集·映画『リズと青い鳥』オリジナルサウンドトラック「girls,dance,staircase」" },
  { sid: '2163839', title: "合集·DRV PRESENTS" },
  { sid: '2575629', title: "合集·DRV LIVE COLLECTION" },
  { sid: '5517375', title: "合集·One More Time， One More Chance" },
  { sid: '2402511', title: "合集·【Kyoko Sakura】黑胶试听丨童年回忆" },
  { sid: '6512176', title: "合集·Taylor Swift歌单" },
  { sid: '6337656', title: "合集·散步歌单" },
  { sid: '5832289', title: "合集·R&B" },
  { sid: '5832300', title: "合集·Jazz爵士乐" },
  { sid: '6289482', title: "合集·华语歌单" },
  { sid: '5832433', title: "合集·夏日氛围歌单" },
  { sid: '5832234', title: "合集·Lofi音乐" },
  { sid: '6409424', title: "合集·CHAOS LAB能量补给站" },
  { sid: '5832286', title: "合集·日语精选歌单" },
  { sid: '5832413', title: "合集·卧室歌单" },
  { sid: '5832450', title: "合集·纯音乐" },
  { sid: '855193', title: "合集·私藏歌单" },
  { sid: '1221427', title: "合集·只道相思随雨长" },
  { sid: '1221436', title: "合集·万物之频" },
  { sid: '8726432', title: "合集·华语老歌" },
  { sid: '1367065', title: "合集·澤野弘之" },
  { sid: '572226', title: "合集·4K日漫音乐现场" },
  { sid: '1321275', title: "合集·4K日语音乐现场" },
  { sid: '1983842', title: "合集·4K欧美音乐现场" },
  { sid: '4236201', title: "合集·4K粤语音乐现场" },
  { sid: '1321294', title: "合集·4K纯音乐/器乐现场" },
  { sid: '1082061', title: "音乐现场" },
  { sid: '3456912', title: "合集·日韩破亿神曲" },
  { sid: '257515', title: "合集·欧美粉必听,收藏过百万热歌全集" },
  { sid: '1250489', title: "合集·周杰伦—永远的青春" },
  { sid: '874587', title: "合集·世界杯名曲合集" },
  { sid: '230679', title: "合集·王菲：你快乐所以我快乐" },
  { sid: '1134199', title: "合集·影视原声" },
  { sid: '1119082', title: "合集·游戏音乐" },
  { sid: '1326355', title: "合集·ED黄老板" },
  { sid: '3995253', title: "合集·《明日方舟》音乐" },
  { sid: '3994902', title: "合集·《原神》音乐" },
  { sid: '3999786', title: "合集·《绝区零》音乐" },
  { sid: '1096252', title: "合集·私人专享" },
  { sid: '3693597', title: "合集·《黑神话：悟空》合集" },
  { sid: '3995356', title: "合集·《英雄联盟》音乐" },
  { sid: '3999771', title: "合集·主机游戏 音乐" },
  { sid: '1785860', title: "合集·演唱会实录" },
  { sid: '1227331', title: "合集·体育专区" },
  { sid: '2219179', title: "合集·解压必备" },
  { sid: '1578577', title: "合集·上海交响乐团" },
  { sid: '1612755', title: "合集·经典游曲" },
  { sid: '1740963', title: "合集·经典漫曲" },
  { sid: '1519400', title: "合集·高达" },
  { sid: '120812', title: "合集·千禧年之前的经典金曲" },
  { sid: '3866786', title: "合集·Live (2024 From Zero 世界巡演) - 林肯公园" },
  { sid: '4796717', title: "合集·纵贯线" },
  { sid: '1406317', title: "合集·周杰伦" },
  { sid: '4355599', title: "合集·林俊杰" },
  { sid: '1406323', title: "合集·陈奕迅" },
  { sid: '4220383', title: "合集·日语现场" },
  { sid: '3635260', title: "合集·陶喆" },
  { sid: '1406328', title: "合集·许嵩" },
  { sid: '3162072', title: "合集·阿黛尔" },
  { sid: '1477795', title: "合集·迈克尔·杰克逊" },
  { sid: '1406333', title: "合集·酷玩" },
  { sid: '2192336', title: "合集·春节" },
  { sid: '1635413', title: "合集·伍佰" },
  { sid: '1406311', title: "合集·歌神张学友" },
  { sid: '1867441', title: "合集·张宇" },
  { sid: '1892749', title: "合集·李克勤" },
  { sid: '1704616', title: "合集·泰勒" },
  { sid: '1704623', title: "合集·艾薇儿" },
  { sid: '1635426', title: "合集·赵雷" },
  { sid: '417471', title: "合集·艺人合作" },
  { sid: '13325', title: "合集·1989 World Tour" },
  { sid: '1969319', title: "合集·Ayase-YOASOBI·MV" },
  { sid: '2006067', title: "合集·Ayase-YOASOBI·LIVE" },
  { sid: '189745', title: "合集·净慈寺合集" },
  { sid: '71510', title: "合集·雨声合集" },
  { sid: '1363249', title: "合集·番茄学习" },
  { sid: '3568322', title: "合集·助眠音乐" },
  { sid: '3896257', title: "合集·氛围音乐" },
  { sid: '3567922', title: "合集·氛围音乐" },
  { sid: '2047602', title: "合集·羊村助眠" },
  { sid: '2047095', title: "合集·自然环境助眠" },
  { sid: '2083437', title: "合集·猫和老鼠" },
  { sid: '1156187', title: "合集·失眠救星系列" },
  { sid: '747587', title: "合集·咖啡馆与爵士钢琴乐" },
  { sid: '753880', title: "合集·静静听雨" },
  { sid: '742166', title: "合集·蜗居爵士乐" },
  { sid: '745477', title: "合集·千与千寻系列" },
  { sid: '4803179', title: "合集·森林雷雨" },
  { sid: '4803612', title: "合集·城市暴雨" },
  { sid: '4803555', title: "合集·江南烟雨" },
  { sid: '243526', title: "合集·【千禧年电台】1990年至2015年氛围白噪音【二〇〇〇年过去了，我很怀念它】" },
  { sid: '1293012', title: "合集·【四季电台】白日梦想家_工作_学习_助眠_与世隔绝" },
  { sid: '2085272', title: "合集·【爵士电台】唯有爵士乐不可辜负_工作_学习_助眠_与世隔绝" },
  { sid: '243543', title: "合集·【末日电台】地球上最后一个人_避难所/战争/超现实/游戏白噪音" },
  { sid: '243552', title: "合集·【昭和电台】东京夜未眠_工作_学习_助眠_与世隔绝" },
  { sid: '3588091', title: "合集·奇异人生Life is Strange 专注陪伴音乐" },
  { sid: '2332063', title: "合集·《冥想催眠》系列-来自宇宙的声音牵引灵魂走向宁静的深处" },
  { sid: '2468426', title: "合集·《Cozy Ambient Jazz》系列——阅读、放松、发呆、做家务的音乐伴侣" },
  { sid: '2331536', title: "合集·《寺院诵唱》系列-伴随着木鱼声颂钵声纯粹本真吟诵佛经" },
  { sid: '3842790', title: "合集·复古格调·城市漫步" },
  { sid: '2318216', title: "合集·《佛教音乐》系列-经文与音乐构筑的佛音启迪" },
  { sid: '2279134', title: "合集·《艺术共鸣》系列-融合世界名画与疗愈音乐" },
  { sid: '2389253', title: "合集·《星际穿越》系列-跟随音乐和画面穿越时空星际，受撼于赛博末世，一起放空沉浸" },
  { sid: '2340196', title: "合集·《迷失虚妄》系列-跟随Lofi音乐的鼓点和节拍摇摆躯体和灵魂" },
  { sid: '2448672', title: "合集·佛歌曲" },
  { sid: '1499661', title: "合集·醉美禅音" },
  { sid: '4524020', title: "合集·贝多芬交响曲全集" },
  { sid: '4458095', title: "合集·2025年维也纳新年音乐会" },
  { sid: '4211719', title: "合集·齐默尔曼" },
  { sid: '4190729', title: "合集·[中字]【海顿】创世记" },
  { sid: '3917499', title: "合集·德沃夏克第九交响曲 卡拉扬维也纳爱乐乐团" },
  { sid: '3820666', title: "合集·三大男高音（帕瓦罗蒂 多明戈 卡雷拉斯）" },
  { sid: '3789112', title: "合集·【普契尼歌剧】图兰朵 紫禁城版" },
  { sid: '3784103', title: "合集·普契尼歌剧【图兰朵】" },
  { sid: '3764922', title: "合集·柏林森林音乐会" },
  { sid: '3764881', title: "合集·柴可夫斯基《叶甫盖尼·奥涅金》" },
  { sid: '3397644', title: "合集·贝多芬交响曲和序曲" },
  { sid: '3359859', title: "合集·德沃夏克第九交响曲" },
  { sid: '3253566', title: "合集·施特劳斯·拉德斯基进行曲" },
  { sid: '3206291', title: "合集·欧美音乐现场" },
  { sid: '431918', title: "合集·贝多芬" },
  { sid: '876659', title: "合集·穿越星际" },
  { sid: '436932', title: "合集·莫扎特" },
  { sid: '444191', title: "合集·海顿" },
  { sid: '431910', title: "合集·马勒" },
  { sid: '431887', title: "合集·卡拉扬" },
  { sid: '436887', title: "合集·柴可夫斯基" },
  { sid: '436915', title: "合集·巴赫" },
  { sid: '436989', title: "合集·小提琴 | 大提琴 | 钢琴 | 美声 | 交响乐 | 古典音乐" },
  { sid: '3629748', title: "合集·AI修复郭德纲相声" },
  { sid: '3644679', title: "合集·AI修复郭德纲单口相声" },
  { sid: '3629182', title: "合集·郭德纲无唱助眠相声" },
  { sid: '1302800', title: "合集·每天漫步雨雪" },
  { sid: '4553891', title: "合集·马三立相声集" },
  { sid: '4262997', title: "合集·刘宝瑞高清修复助眠相声" },
  { sid: '3329955', title: "合集·侯宝林相声高清修复" },
  { sid: '2947903', title: "合集·侯耀文" },
  { sid: '2948951', title: "合集·相声" },
  { sid: '2940903', title: "合集·冯巩" },
  { sid: '103727', title: "合集·水浒传 修复版" },
  { sid: '2947877', title: "合集·马季" },
  { sid: '2940957', title: "合集·陈佩斯" },
  { sid: '189166', title: "合集·Beyond 黄家驹、黄贯中、黄家强、叶世荣" },
  { sid: '2947924', title: "合集·姜昆" },
  { sid: '114764', title: "合集·张学友（Jacky Cheung）" },
  { sid: '1374170', title: "合集·古典音乐" },
  { sid: '1373124', title: "合集·楼上噪音解决" },
  { sid: '1888349', title: "合集·摇滚音乐" },
  { sid: '1566078', title: "合集·爵士音乐" },
  { sid: '1763356', title: "合集·蔡琴" },
  { sid: '1436167', title: "合集·人声hifi" },
  { sid: '41', title: "合集·BILLBOARD 美国单曲榜" },
  { sid: '9680', title: "合集·每周歌曲推荐" },
  { sid: '266', title: "合集·Official Chart 英国单曲榜" },
  { sid: '443', title: "合集·BILLBOARD 全球单曲榜" },
  { sid: '4256191', title: "合集·Thai Playlist" },
  { sid: '48627', title: "合集·历年华语乐坛经典回顾" },
  { sid: '2122597', title: "合集·2023年各月份热歌排行榜" },
  { sid: '4142178', title: "合集·【Playlist】音乐合集" },
  { sid: '1784187', title: "合集·LOFI环境系列" },
  { sid: '1828749', title: "合集·LOFI街景" },
  { sid: '1975341', title: "合集·像素Lofi" },
  { sid: '2372215', title: "合集·漫步LOFI" },
  { sid: '2074929', title: "合集·【一人学习LOFI合集】" },
  { sid: '2787260', title: "合集·狐狸与少女" },
  { sid: '1647617', title: "合集·LOFI敲代码系列" },
  { sid: '1817781', title: "合集·ET LOFI studio" },
  { sid: '4720896', title: "合集·【轻音乐歌单】| 学习 放松 治愈" },
  { sid: '4092430', title: "合集·【Playlist歌单】| 私藏宝藏歌单" },
  { sid: '2877786', title: "合集·五音療疾" },
  { sid: '1680358', title: "合集·疗愈舒缓" },
  { sid: '4511241', title: "合集·专辑" },
  { sid: '4652973', title: "合集·循环" },
  { sid: '4652954', title: "合集·日推" },
  { sid: '4511239', title: "合集·运动" },
  { sid: '4558738', title: "合集·乐队" },
  { sid: '1739397', title: "合集·中世纪|凯尔特|酒馆等风格合集" },
  { sid: '1739402', title: "合集·游戏音乐合集" },
  { sid: '2209882', title: "合集·吟游诗人合集" },
  { sid: '1755796', title: "合集·北欧维京音乐系列" },
  { sid: '1986805', title: "合集·节日音乐" },
  { sid: '1812732', title: "合集·幻想&魔法&奇幻&史诗音乐合集" },
  { sid: '1739406', title: "合集·单曲合集" },
  { sid: '4216345', title: "合集·小千代の音乐补完计划" },
  { sid: '1855821', title: "合集·进击的巨人音乐盘点合集" },
  { sid: '32658', title: "合集·凯哥学英语" },
  { sid: '2836893', title: "合集·久石让曲目精选" },
  { sid: '2798585', title: "合集·Taylor Swift-THE TORTURED POETS DEPARTMENT" },
  { sid: '1910387', title: "合集·摇滚与流行｜我们的经典，我们的摇滚" },
  { sid: '1847641', title: "合集·1989 (Taylor's Version)歌词MV合集" },
  { sid: '1806326', title: "合集·【Troye Sivan】新专《Something To Give Each Other》" },
  { sid: '1380315', title: "合集·Taylor Swift泰勒·斯威夫特官方MV精选" },
  { sid: '1973224', title: "合集·Taylor Swift \"The Eras Tour\"时代巡回演唱会" },
  { sid: '1616825', title: "合集·嘻哈50年 | 传世经典的自由宣言" },
  { sid: '1625207', title: "合集·Beyond｜40年光辉岁月" },
  { sid: '1358751', title: "合集·环球音乐J-POP精选" },
  { sid: '2623786', title: "合集·张国荣·永远的哥哥风华绝代" },
  { sid: '1449094', title: "合集·Justin Bieber贾斯汀·比伯官方MV精选" },
  { sid: '1380269', title: "合集·陈奕迅官方现场精选" },
  { sid: '1304816', title: "合集·Avicii艾维奇的电音经典" },
  { sid: '1260237', title: "合集·日韩4K修复" },
  { sid: '1255767', title: "合集·欧美4K修复" },
  { sid: '1260240', title: "合集·华语4K修复" },
  { sid: '46418', title: "合集·【4K修复】Nightwish夜愿乐队2005时代终结演唱会" },
  { sid: '103735', title: "合集·【4K修复】枪炮与玫瑰1992东京演唱会" },
  { sid: '215809', title: "合集·【霉霉】泰勒·斯威夫特音乐合集" },
  { sid: '8008', title: "合集·【4K修复】Nightwish夜愿乐队Wacken 2013演唱会" },
  { sid: '1003508', title: "合集·日本歌手合集：中岛美雪、滨崎步、美依礼芽、米津玄师、仓木麻衣、坂井泉水、Wands" },
  { sid: '1282981', title: "合集·那些经典的动漫歌曲" },
  { sid: '2069904', title: "合集·ost歌曲合集" },
  { sid: '4704429', title: "合集·唐宋摇滚" },
  { sid: '1707990', title: "合集·『GUNDAM MUSIC』" },
  { sid: '2852940', title: "合集·『MUSIC LIVE』" },
  { sid: '3095846', title: "合集·『影视原声音乐』" },
  { sid: '4445811', title: "合集·TOKYO ASMR MASSAGE 合集" },
  { sid: '2966', title: "合集·迈克尔·杰克逊超清合集" },
  { sid: '510637', title: "合集·后街男孩超清合集" },
  { sid: '3278', title: "合集·皇后乐队超清合集" },
  { sid: '513550', title: "合集·小甜甜布兰妮超清视频" },
  { sid: '4201012', title: "合集·梶浦由记" },
  { sid: '3654466', title: "合集·动画MV" },
  { sid: '3403831', title: "合集·高达" },
  { sid: '1109355', title: "合集·City-Pop° | 城市流行" },
  { sid: '1109249', title: "合集·Anime BGM | OST Collection Full | 经典动漫音乐歌曲合集" },
  { sid: '269636', title: "合集·吹唢呐是吧？！" },
  { sid: '4733530', title: "合集·邓丽君经典歌曲" },
  { sid: '2062575', title: "合集·「耳机歌单」私藏音乐" },
  { sid: '4934263', title: "合集·全球经典MV(二）" },
  { sid: '1865288', title: "合集·全球经典现场" },
  { sid: '1831934', title: "合集·全球经典MV(一)" },
  { sid: '4246329', title: "合集·理查德·克莱德曼" },
  { sid: '2572058', title: "合集·中华名曲" },
  { sid: '3427065', title: "合集·◢◤A神 Avicii艾维奇作品" },
  { sid: '4208377', title: "合集·Aimer" },
  { sid: '3415202', title: "合集·YOASOBI" },
  { sid: '3634243', title: "合集·LiSA / 织部里沙" },
  { sid: '4208403', title: "合集·米津玄师" },
  { sid: '4078099', title: "合集·澤野弘之/泽野弘之" },
  { sid: '3425395', title: "合集·FF14 BGM循环" },
  { sid: '1342069', title: "合集·【Aimer Live】4K中日双字幕合集" },
  { sid: '4141127', title: "合集·如果你也只是想安静的听会歌" },
  { sid: '3194098', title: "合集·游戏/影视原声大碟 " },
  { sid: '2049406', title: "合集·中国摇滚精品合集" },
  { sid: '1688885', title: "合集·我在B站听窦唯" },
  { sid: '2328688', title: "合集·中岛美雪" },
  { sid: '4499800', title: "合集·A妹" },
  { sid: '1633674', title: "合集·摇滚/乐队" },
  { sid: '1269304', title: "合集·霉霉" },
  { sid: '4512435', title: "合集·嘎" },
  { sid: '4512279', title: "合集·牛" },
  { sid: '4512315', title: "合集·西法德俄..." },
  { sid: '1633578', title: "合集·Hip-hop" },
  { sid: '3203527', title: "合集·OneRepublic" },
  { sid: '1173063', title: "合集·器乐古典" },
  { sid: '3876810', title: "合集·经典R&B" },
  { sid: '3352264', title: "合集·瑞鸣音乐之旅" },
  { sid: '1633398', title: "合集·经典摇滚" },
  { sid: '1717275', title: "合集·音乐剧/歌剧" },
  { sid: '4512705', title: "合集·蹲" },
  { sid: '977181', title: "合集·霸榜盆" },
  { sid: '1422841', title: "合集·电音" },
  { sid: '1199802', title: "合集·绝爵" },
  { sid: '4503168', title: "合集·梨" },
  { sid: '1269724', title: "合集·Adele" },
  { sid: '1337162', title: "合集·City Pop" },
  { sid: '773698', title: "合集·打雷弃曲" },
  { sid: '4512657', title: "合集·果" },
];

/* ── Recommendations ─────────────────────────────────────────────────────
 *
 * The curated `BILI_RECOMMEND_SEASONS` list is the shelf; a card's name,
 * cover and owner mid are resolved per season id at read time, because a
 * bare season id carries none of them. `seasons_archives_list` answers a
 * season id *without* the owner's mid (verified against the live API), and
 * its `data.meta` carries the three — `page_size=1`, only the meta wanted.
 *
 * The UP's *name* is deliberately not asked here: one `x/web-interface/card`
 * call per card would double the shelf's request count for a line of text,
 * so it waits until the playlist page opens (`biliSeasonArtist`, cached).
 *
 * Ten cards per page is the shelf contract; the caller pages by passing
 * `page` (1-based) through the scope.
 */

/**
 * One season's meta, in three states:
 *
 *   ok     `meta` is present and cached (six hours) — the normal case.
 *   gone   the backend says the season does not exist (-404) — a permanent
 *          answer, and the one thing a placeholder may call 无效.
 *   error  everything else — a 412 risk-control page, a 429, a timeout, an
 *          unusual API code. Transient by definition: nothing was cached, so
 *          the next read of the page retries.
 *
 * The split exists because the first draft treated every failure as 无效,
 * and a rate-limited shelf full of "当前资源无效" is a lie told at the
 * user's expense — the request may have been refused, not the resource.
 */
async function biliRecommendMeta(seasonId) {
  const cacheKey = 'bili_recommend_meta_' + seasonId;
  const cached = src.cache.get(cacheKey);
  if (cached) {
    try {
      return { state: 'ok', meta: src.parse.json(cached) };
    } catch (e) {
      // An unreadable cache entry is as good as absent.
      src.cache.put(cacheKey, '', 1);
    }
  }
  try {
    const res = await src.get(
      'https://api.bilibili.com/x/polymer/web-space/seasons_archives_list?season_id=' +
        src.url.encode(String(seasonId)) +
        '&page_num=1&page_size=1',
      { headers: BROWSER_HEADERS },
    );
    const json = src.parse.json(res.body);
    if (json.code === -404) {
      return { state: 'gone', reason: json.message || '-404' };
    }
    if (json.code !== 0 || !json.data || !json.data.meta) {
      return { state: 'error', reason: 'code ' + json.code + ' ' + (json.message || '') };
    }
    const meta = json.data.meta;
    src.cache.put(cacheKey, JSON.stringify(meta), 6 * 3600 * 1000);
    return { state: 'ok', meta: meta };
  } catch (e) {
    return { state: 'error', reason: previewValue(String(e && e.message || e), 160) };
  }
}

/** One mid's UP name, cached a day. Empty string over any failure. */
async function biliRecommendOwner(mid) {
  if (!mid) return '';
  const cacheKey = 'bili_recommend_owner_' + mid;
  const cached = src.cache.get(cacheKey);
  if (cached) return src.parse.json(cached);
  try {
    const res = await src.get('https://api.bilibili.com/x/web-interface/card?mid=' + src.url.encode(String(mid)), { headers: BROWSER_HEADERS });
    const json = src.parse.json(res.body);
    if (json.code !== 0 || !json.data || !json.data.card) return '';
    const name = String(json.data.card.name || '');
    src.cache.put(cacheKey, JSON.stringify(name), 24 * 3600 * 1000);
    return name;
  } catch (e) {
    src.log('biliRecommendOwner(' + mid + ') failed: ' + previewValue(String(e && e.message || e), 120));
    return '';
  }
}

/**
 * The recommendation plan — the curated list shuffled once, then read front
 * to back ten at a time.
 *
 * One shuffle per plan lifetime (six hours, the same cache entry the page
 * cursors live in): re-shuffling per page would shuffle pages the user has
 * already seen, and a feed that repeats itself is worse than a stale order.
 * `ends[page]` marks where each page stopped, so sequential reads (the shelf,
 * then the show-all grid stepping through) resume instead of rescanning; when
 * the plan expires the next read reshuffles and the cursors reset with it —
 * a feed that starts over after a long pause is what "random" means anyway.
 */
function biliRecommendPlan() {
  const cached = src.cache.get('bili_recommend_plan');
  if (cached) {
    try {
      const plan = src.parse.json(cached);
      if (plan && Array.isArray(plan.order) && plan.order.length > 0) return plan;
    } catch (e) {
      src.log('biliRecommendPlan → cached plan unreadable, reshuffling: ' + previewValue(String(e && e.message || e), 120));
    }
  }
  const order = BILI_RECOMMEND_SEASONS.map(function (e) { return e.sid; });
  // Fisher–Yates: one backward pass, uniform over permutations.
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = order[i]; order[i] = order[j]; order[j] = tmp;
  }
  const plan = { order: order, ends: {} };
  src.cache.put('bili_recommend_plan', JSON.stringify(plan), 6 * 3600 * 1000);
  src.log('biliRecommendPlan → reshuffled ' + order.length + ' season(s)');
  return plan;
}

/**
 * One recommendation page as explore rows.
 *
 * Rows are `album` cards carrying the canonical `bili_season_<mid>_<sid>` id
 * and the season document as `childUrl`, so the runtime caches the payload
 * `getAlbum` fetches and the card opens exactly like a browsed album. One
 * request per card — the meta lookup; the UP's name is not asked here, it
 * belongs to the playlist page the card opens.
 *
 * A dead id (a retired season answers -404) is not skipped — its slot becomes
 * a placeholder row (`当前资源无效`, naming the resource) and the failure is
 * logged with the resource named, because an empty-looking slot the user
 * cannot explain is worse than a marked one. The page still fills to ten,
 * placeholders included.
 */
async function biliRecommendRows(result, page) {
  // Risk control: bilibili's web api answers 412 to a client with no buvid3,
  // and the shelf fires a dozen calls back to back. Search and explore
  // bootstrap the cookie; the shelf must too, or its first cold read pays
  // for the omission in placeholders.
  await ensureBuvid();
  const pageNumber = Math.max(1, parseInt(page, 10) || 1);
  const pageSize = 10;
  const plan = biliRecommendPlan();
  const bySid = {};
  for (const e of BILI_RECOMMEND_SEASONS) bySid[e.sid] = e;

  let index;
  if (pageNumber === 1) {
    index = 0;
  } else {
    const marked = plan.ends[pageNumber - 1];
    index = typeof marked === 'number' ? marked : (pageNumber - 1) * pageSize;
  }

  const rows = [];
  while (rows.length < pageSize && index < plan.order.length) {
    const sid = plan.order[index];
    index += 1;
    const entry = bySid[sid] || { sid: sid, title: sid };
    const outcome = await biliRecommendMeta(sid);
    if (outcome.state === 'gone') {
      // The permanent answer: the backend says this season is gone.
      src.log('biliRecommendRows → 推荐合集无效: ' + entry.title + ' (sid ' + sid + '): ' + outcome.reason);
      rows.push({
        kind: 'folder',
        trackId: 'bili_invalid_' + sid,
        title: '当前资源无效',
        artist: entry.title + ' · sid ' + sid,
      });
      continue;
    }
    if (outcome.state === 'error') {
      // Transient — risk control, rate limiting, a timeout. Named on the
      // card and in the log, and nothing cached, so the next read retries.
      src.log('biliRecommendRows → 推荐合集加载失败: ' + entry.title + ' (sid ' + sid + '): ' + outcome.reason);
      rows.push({
        kind: 'folder',
        trackId: 'bili_error_' + sid,
        title: '加载失败',
        artist: entry.title + ' · ' + outcome.reason,
      });
      continue;
    }
    const meta = outcome.meta;
    const mid = String(meta.mid);
    const seasonId = String(meta.season_id || sid);
    // The card carries name + cover only. The UP's name is a second request
    // per card, and it is none of the shelf's business: `ruleAlbum.artist`
    // fetches it (cached) when the playlist page actually opens.
    rows.push({
      kind: 'album',
      trackId: 'bili_season_' + mid + '_' + seasonId,
      title: meta.name || entry.title,
      artwork: cleanPic(meta.cover || ''),
      childUrl:
        'https://api.bilibili.com/x/polymer/web-space/seasons_archives_list?mid=' +
        src.url.encode(mid) +
        '&season_id=' + src.url.encode(seasonId) +
        '&page_num={{page.cursor || 1}}&page_size={{page.limit || 30}}',
    });
  }
  plan.ends[pageNumber] = index;
  src.cache.put('bili_recommend_plan', JSON.stringify(plan), 6 * 3600 * 1000);
  src.log('biliRecommendRows(page ' + pageNumber + ') → ' + rows.length + ' row(s), scanned to ' + index + ' of ' + plan.order.length);
  return rows;
}

/** The season's UP name for `ruleAlbum.artist` — the meta's mid, cached. */
async function biliSeasonArtist(result) {
  const mid = result && result.data && result.data.meta && result.data.meta.mid;
  return biliRecommendOwner(mid);
}

/** The season's own name, for `ruleAlbum` fallbacks and track rows. */
function biliSeasonName(result) {
  return (result && result.data && result.data.meta && result.data.meta.name) || '';
}

/**
 * One page of a season's videos as track rows.
 *
 * The archives response names no owner per row — the season belongs to one
 * UP — so the name comes from the same cached lookup the card and the album
 * header use, and every row of the listing carries it.
 */
async function biliSeasonTrackRows(result) {
  const data = (result && result.data) || {};
  const archives = data.archives || [];
  const owner = await biliRecommendOwner(data.meta && data.meta.mid);
  return archives.map((a) => ({
    kind: 'track',
    trackId: a.bvid,
    bvid: a.bvid,
    title: a.title || '',
    artist: owner,
    album: biliSeasonName(result),
    artwork: cleanPic(a.pic || ''),
    durationMs: parseDuration(a.duration),
  }));
}

/** The URL to fetch for ruleAlbum, based on the album id. */
function biliAlbumUrl(albumId) {
  if (!albumId) return '';
  const cleanId = String(albumId).replace(/^bili_video_/, '');
  const seasonMatch = cleanId.match(/^bili_season_(\d+)_(\d+)$/);
  if (seasonMatch) {
    return 'https://api.bilibili.com/x/polymer/web-space/seasons_archives_list?mid=' + seasonMatch[1] + '&season_id=' + seasonMatch[2] + '&page_num=1&page_size=30';
  }
  const seriesMatch = cleanId.match(/^bili_series_(\d+)_(\d+)$/);
  if (seriesMatch) {
    return 'https://api.bilibili.com/x/series/archives?mid=' + seriesMatch[1] + '&series_id=' + seriesMatch[2] + '&only_normal=true&sort=desc&pn=1&ps=30';
  }
  const bvid = cleanId.split('_')[0];
  return 'https://api.bilibili.com/x/web-interface/view?bvid=' + src.url.encode(bvid);
}

function biliAlbumTitle(result) {
  const data = (result && result.data) || {};
  if (data.meta && data.meta.name) return data.meta.name;
  if (data.title) return cleanTitle(data.title);
  return '';
}

async function biliAlbumArtist(result) {
  const data = (result && result.data) || {};
  if (data.meta) return biliSeasonArtist(result);
  if (data.owner && data.owner.name) return data.owner.name;
  return '';
}

function biliAlbumArtwork(result) {
  const data = (result && result.data) || {};
  if (data.meta && data.meta.cover) return data.meta.cover;
  if (data.pic) return cleanPic(data.pic);
  return '';
}

function biliAlbumTrackCount(result) {
  const data = (result && result.data) || {};
  if (data.meta && data.meta.total != null) return String(data.meta.total);
  if (data.videos != null) return String(data.videos);
  if (data.pages && Array.isArray(data.pages)) return String(data.pages.length);
  return '';
}

/**
 * Tracks for an album: handles both season collections (archives) and multi-P videos (pages).
 */
async function biliAlbumTrackRows(result) {
  const data = (result && result.data) || {};
  if (data.archives && Array.isArray(data.archives)) {
    return biliSeasonTrackRows(result);
  }
  if (data.pages && Array.isArray(data.pages)) {
    const bvid = data.bvid || '';
    const owner = (data.owner && data.owner.name) || '';
    const albumTitle = cleanTitle(data.title || '');
    const pic = cleanPic(data.pic || '');
    const isMulti = data.pages.length > 1;
    return data.pages.map((p) => {
      const partTitle = (p.part && p.part.trim()) ? p.part.trim() : (isMulti ? albumTitle + ' P' + p.page : albumTitle);
      return {
        kind: 'track',
        trackId: isMulti ? bvid + '_p' + p.page : bvid,
        bvid: bvid,
        cid: p.cid,
        page: p.page,
        title: partTitle,
        artist: owner,
        album: albumTitle,
        artwork: pic,
        durationMs: (p.duration || 0) * 1000,
      };
    });
  }
  return [];
}

/** Extracts the bvid and page index (1-based) from a track object. */
function parseTrackBvidAndPage(track) {
  if (!track) return { bvid: '', page: 1 };
  const rawId = String(track.bvid || track.onlineId || track.id || '').replace(/^bili_video_/, '');
  const match = rawId.match(/^([a-zA-Z0-9]+)(?:_p(\d+))?$/);
  const bvid = match ? match[1] : rawId.split('_')[0];
  const page = (track.page && Number(track.page)) || (match && match[2] ? Number(match[2]) : 1);
  return { bvid, page: Math.max(1, page) };
}

/** The bvid, from wherever the row kept it. */
function trackBvid(track) {
  return parseTrackBvidAndPage(track).bvid;
}

/**
 * The cid of a video's page, cached per realm.
 *
 * DASH is per-page and every playurl/lyric call needs one. Pagelist provides
 * all pages at once, so caching the full pagelist allows subsequent multi-P
 * tracks to resolve immediately without repeated round trips.
 */
async function ensureCid(track) {
  if (track && track.cid) return track.cid;
  const { bvid, page } = parseTrackBvidAndPage(track);
  if (!bvid) return undefined;

  const cacheKey = 'bili_cid_' + bvid + '_p' + page;
  const cached = src.cache.get(cacheKey);
  if (cached) return cached;

  const listCacheKey = 'bili_pagelist_' + bvid;
  let pages = null;
  const cachedList = src.cache.get(listCacheKey);
  if (cachedList) {
    try {
      pages = JSON.parse(cachedList);
    } catch (e) {
      pages = null;
    }
  }

  if (!pages) {
    try {
      const res = await src.get(
        'https://api.bilibili.com/x/player/pagelist?bvid=' + src.url.encode(bvid) + '&jsonp=jsonp',
        { headers: BROWSER_HEADERS }
      );
      const json = src.parse.json(res.body);
      if (json && json.data && Array.isArray(json.data) && json.data.length > 0) {
        pages = json.data;
        src.cache.put(listCacheKey, JSON.stringify(pages), 3600000);
        for (let i = 0; i < pages.length; i++) {
          const item = pages[i];
          if (item && item.cid) {
            src.cache.put('bili_cid_' + bvid + '_p' + (item.page || (i + 1)), item.cid, 3600000);
          }
        }
      } else {
        src.log('ensureCid(' + bvid + ') → pagelist answered without data: ' + previewValue(res.body, 160));
      }
    } catch (e) {
      src.log('ensureCid(' + bvid + ') → failed: ' + previewValue(String((e && e.message) || e), 120));
    }
  }

  if (pages && pages.length > 0) {
    const targetItem = pages.find((p) => p.page === page) || pages[page - 1] || pages[0];
    if (targetItem && targetItem.cid) {
      src.cache.put(cacheKey, targetItem.cid, 3600000);
      src.log('ensureCid(' + bvid + ', p' + page + ') → ' + targetItem.cid);
      return targetItem.cid;
    }
  }

  return undefined;
}

/** Whether this realm holds a session — what playurl's try_look turns on. */
async function biliSignedIn() {
  try {
    const sess = await src.cookie.get('SESSDATA');
    return !!(sess && String(sess).trim());
  } catch (e) {
    return false;
  }
}

/**
 * One playurl request — BilibiliBaseIE._download_playinfo.
 *
 * `fnval` is pinned at 4048 exactly as yt-dlp pins it: the standard DASH set
 * (4K, HDR, Dolby, Dolby Vision, AV1) minus Hi-Res' bit 4096, which is what
 * most often makes Bilibili answer `-400 请求错误`. The dm_* fingerprint
 * params ride along, and `try_look=1` (the preview flag) is added by the
 * caller when signed out and dropped here when signed in, mirroring
 * `if self.is_logged_in: params.pop('try_look', None)`.
 *
 * Error codes are normalised as yt-dlp normalises them: the negative Bilibili
 * code times -1, so `-400` reports as 400, `-401`/`-352` are expected
 * ("please wait and try later") and everything else is a plain failure.
 */
async function fetchBiliPlayurl(bvid, cid, query, signedIn) {
  const params = {
    bvid: bvid,
    cid: cid,
    fnval: 4048,
    ...dmParams(),
    ...(query || {}),
  };
  if (signedIn) delete params.try_look;
  const signedQuery = await signWbiQuery(params);
  const res = await src.get('https://api.bilibili.com/x/player/wbi/playurl?' + signedQuery, { headers: BROWSER_HEADERS });
  const json = src.parse.json(res.body);
  const code = Number(json.code) * -1;
  if (code === 0) return json.data;
  let msg = 'Unable to download video info: ' + code + (json.message ? ': ' + json.message : '');
  if (code === 401 || code === 352) msg += ', please wait and try later';
  throw new Error(msg);
}

/**
 * Every DASH audio candidate in the response — BilibiliBaseIE.extract_formats'
 * collection order. `dash.audio` first, then Dolby, then FLAC appended last.
 *
 * `format` is classified from the codecs string; `qTier` from the id's web
 * label (AUDIO_TIERS). Dolby is flagged undecodable because Chromium cannot
 * decode E-AC-3 — it is reported, never selected.
 */
function collectBiliAudios(dash) {
  const audios = [];
  const push = (a, fallbackTier, undecodable) => {
    if (!a) return;
    const id = a.id || a.new_id;
    const codecs = String(a.codecs || '').toLowerCase();
    const format = codecs.includes('flac') ? 'flac' : codecs.includes('ec-3') || codecs.includes('eac3') ? 'eac3' : 'm4a';
    audios.push({ ...a, format, qTier: AUDIO_TIERS[id] || fallbackTier || 'normal', undecodable: undecodable === true });
  };
  for (const a of dash.audio || []) push(a);
  for (const a of (dash.dolby && dash.dolby.audio) || []) push(a, 'lossless', true);
  const flac = dash.flac && dash.flac.audio;
  if (flac) push(flac, 'hi-res');
  return audios;
}

/** The best candidate for the requested tier, decoded formats only. */
function selectBiliAudio(audios, prefs) {
  let candidates = audios.filter((a) => !a.undecodable);
  if (prefs && Array.isArray(prefs.acceptFormats) && prefs.acceptFormats.length > 0) {
    const accepted = candidates.filter((a) => prefs.acceptFormats.some((fmt) => a.format === String(fmt).toLowerCase()));
    if (accepted.length > 0) candidates = accepted;
  }

  const ladder = AUDIO_LADDER[prefs && prefs.quality] || AUDIO_LADDER.high;
  for (const tier of ladder) {
    const chosen = candidates.filter((a) => a.qTier === tier).sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
    if (chosen) return chosen;
  }
  // Nothing on the ladder (an unknown tier set) — fall back to bitrate,
  // still skipping what cannot be decoded.
  return candidates.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
}

/**
 * The audio stream, per BilibiliBaseIE._download_playinfo and BiliBiliIE.
 *
 * yt-dlp reads `window.__playinfo__` from the video page when logged in and
 * only then falls back to the API with `try_look=1`. A source never
 * downloads the page (no HTML metadata step), so the API branch is the whole
 * flow: signed out, the first request carries try_look=1.
 *
 * When the response carries `dash`, every audio track is already in it —
 * across tiers — so the app's tier ladder picks the one `prefs.quality`
 * asked for without a second request. When it does not, the video is
 * pre-DASH: durl is the stream and `accept_quality` is what it could be;
 * yt-dlp re-asks each qn, the source asks once for the qn its tier maps to.
 */
async function resolveBiliStream(track, prefs) {
  const { bvid, page } = parseTrackBvidAndPage(track);
  if (!bvid) {
    src.log('resolveBiliStream → no bvid in track ' + previewValue(track, 160) + ' — throwing');
    throw new Error('cannot resolve a Bilibili stream without a bvid');
  }
  const cid = track.cid || await ensureCid(track);
  if (!cid) {
    src.log('resolveBiliStream: no cid for bvid ' + bvid + ' p' + page + ' — throwing');
    throw new Error('cannot resolve cid for bvid ' + bvid + ' p' + page);
  }

  const streamCacheKey = 'bili_stream_' + bvid + (page > 1 ? '_p' + page : '');
  const signedIn = await biliSignedIn();
  src.log('resolveBiliStream(' + bvid + ' p' + page + ') → ' + (signedIn ? 'signed in' : 'signed out, try_look=1') +
    ', quality=' + (prefs && prefs.quality || 'default'));
  let data = await fetchBiliPlayurl(bvid, cid, signedIn ? {} : { try_look: 1 }, signedIn);

  if (!data.dash) {
    // Legacy (pre-DASH) path. The response's own `quality` is the default
    // ask; move it to this app tier's qn when the video offers it.
    const accept = (data.accept_quality || []).map(Number);
    let qn = QN_FOR_QUALITY[prefs && prefs.quality] || 64;
    if (!signedIn) qn = Math.min(qn, QN_SIGNED_OUT_CAP);
    if (accept.length > 0 && accept.indexOf(qn) < 0) {
      const offered = accept.filter((v) => v <= qn);
      qn = offered.length ? Math.max.apply(null, offered) : Math.max.apply(null, accept);
    }
    if (Number(data.quality) !== qn) {
      data = await fetchBiliPlayurl(bvid, cid, { qn: qn }, signedIn);
    }
    if (!data.dash) {
      const durl = data.durl || [];
      if (durl.length === 0) {
        src.log('resolveBiliStream(' + bvid + ' p' + page + ') → no dash and no durl — throwing');
        throw new Error('No playable audio stream returned from Bilibili');
      }
      if (durl.length > 1) {
        // yt-dlp's `multi_video` workaround: these fragments are the parts of
        // one flv stream, and one ruleStream URL cannot carry all of them.
        throw new Error('legacy Bilibili stream is split into ' + durl.length +
          ' flv fragments, which one stream URL cannot represent');
      }
      const url = durl[0].url;
      const quality = TIER_FOR_QN[Number(data.quality)] || '';
      const bitrateKbps = durl[0].size && durl[0].length ? Math.round(durl[0].size * 8 / durl[0].length) : '';
      src.cache.put(streamCacheKey, JSON.stringify({ quality: quality, bitrateKbps: bitrateKbps }), 7200000);
      src.log('resolveBiliStream(' + bvid + ' p' + page + ') → legacy durl ' + previewValue(url) + ' [' + (quality || '?') + '/' + data.quality + ']');
      return url;
    }
  }

  const chosen = selectBiliAudio(collectBiliAudios(data.dash), prefs);
  const url = chosen && (chosen.baseUrl || chosen.base_url ||
    (chosen.backupUrl && chosen.backupUrl[0]) || (chosen.backup_url && chosen.backup_url[0]));
  if (!url) {
    src.log('resolveBiliStream(' + bvid + ' p' + page + ') → no audio stream in response — throwing');
    throw new Error('No playable audio stream returned from Bilibili');
  }
  // What the app gets to see: the tier this resolve served and its nominal
  // bitrate. Kept in the realm's cache because `ruleStream.quality` and
  // `.bitrateKbps` are rendered as separate rules after the URL, and
  // answering them by re-running playurl would be a second round trip per
  // playback. Same window as the signed URL itself.
  src.cache.put(streamCacheKey, JSON.stringify({
    quality: chosen.qTier,
    bitrateKbps: Math.round((chosen.bandwidth || 0) / 1000),
  }), 7200000);
  src.log('resolveBiliStream(' + bvid + ' p' + page + ') → ' + previewValue(url) + ' [' + (chosen.qTier || '?') + '/' + (chosen.format || '?') + ']');
  return url;
}

/**
 * The tier and bitrate the last resolve chose for a track.
 *
 * `ruleStream.quality` / `.bitrateKbps` are rendered after `ruleStream.url`
 * and cannot re-derive the choice without a second playurl request, so the URL
 * rule leaves its answer in `src.cache`. Empty string means "not resolved in
 * this realm", which the runtime reads as the field being absent.
 */
function lastBiliStream(track) {
  const { bvid, page } = parseTrackBvidAndPage(track);
  const streamCacheKey = 'bili_stream_' + bvid + (page > 1 ? '_p' + page : '');
  const raw = src.cache.get(streamCacheKey) || src.cache.get('bili_stream_' + bvid);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function biliStreamQuality(track) {
  const last = lastBiliStream(track);
  return last && last.quality ? String(last.quality) : '';
}

function biliStreamBitrate(track) {
  const last = lastBiliStream(track);
  return last && last.bitrateKbps ? String(last.bitrateKbps) : '';
}

/**
 * Headers the CDN needs — BiliBiliIE's `http_headers: {'Referer': url}`.
 *
 * yt-dlp's formats carry the *video page* as Referer, not the site root: the
 * CDN's hotlink check compares the referer domain, and the page URL is what
 * the web player itself sends. The browser UA rides along for the same reason
 * it does on every other request.
 */
function biliStreamHeaders(track) {
  const { bvid, page } = parseTrackBvidAndPage(track);
  return JSON.stringify({
    Referer: bvid ? ('https://www.bilibili.com/video/' + bvid + (page > 1 ? '?p=' + page : '')) : 'https://www.bilibili.com/',
    'User-Agent': BROWSER_HEADERS['User-Agent'],
  });
}

/**
 * Subtitles as LRC — BilibiliBaseIE._get_subtitles.
 *
 * The endpoint is `x/player/wbi/v2` and yt-dlp calls it unsigned, with
 * `aid`+`cid` when the aid is known and `bvid`+`cid` otherwise; the source
 * does the same. The response may say `need_login_subtitle` (CC tracks are
 * login-only) and that is logged rather than silently read as "no lyrics".
 */
async function getBiliLyrics(track) {
  const { bvid, page } = parseTrackBvidAndPage(track);
  if (!bvid) {
    src.log('getBiliLyrics → no bvid in track — returning ""');
    return '';
  }
  const cid = track.cid || await ensureCid(track);
  if (!cid) {
    src.log('getBiliLyrics(' + bvid + ' p' + page + ') → "" (no cid)');
    return '';
  }

  const params = track.aid
    ? 'aid=' + src.url.encode(String(track.aid)) + '&cid=' + src.url.encode(String(cid))
    : 'bvid=' + src.url.encode(bvid) + '&cid=' + src.url.encode(String(cid));
  const res = await src.get('https://api.bilibili.com/x/player/wbi/v2?' + params, { headers: BROWSER_HEADERS });
  const json = src.parse.json(res.body);
  if (json.code !== 0) {
    src.log('getBiliLyrics(' + bvid + ') → "" (v2 code ' + json.code + ': ' + previewValue(json.message) + ')');
    return '';
  }
  const videoInfo = json.data || {};
  if (videoInfo.need_login_subtitle) {
    src.log('getBiliLyrics(' + bvid + ') → subtitles need a login; the anonymous list may be empty');
  }
  const subtitles = (videoInfo.subtitle && videoInfo.subtitle.subtitles) || [];
  const usable = subtitles.filter((s) => s && s.subtitle_url && s.lan);
  if (usable.length === 0) {
    src.log('getBiliLyrics(' + bvid + ') → "" (video has no subtitles)');
    return '';
  }

  // A video can carry an uploaded CC track and an AI-generated one for the
  // same language; the uploaded one is the author's text, the AI one a guess.
  const isZh = (s) => String(s.lan || '').toLowerCase().indexOf('zh') === 0;
  const isAi = (s) => /^ai/i.test(String(s.lan || ''));
  const chosen = usable.find((s) => isZh(s) && !isAi(s)) || usable.find(isZh) || usable[0];
  const subUrl = chosen.subtitle_url;
  src.log('getBiliLyrics(' + bvid + ') → subtitle lan=' + previewValue(chosen.lan) + ' of ' + usable.length);

  const fullUrl = subUrl.startsWith('//') ? 'https:' + subUrl : subUrl;
  const contentRes = await src.get(fullUrl, { headers: BROWSER_HEADERS });
  const body = src.parse.json(contentRes.body)?.body;
  if (!Array.isArray(body)) {
    src.log('getBiliLyrics(' + bvid + ') → "" (subtitle body is not a list)');
    return '';
  }

  const lrc = body
    .filter((item) => item && typeof item.from === 'number')
    .map((item) => {
      const mins = Math.floor(item.from / 60).toString().padStart(2, '0');
      const secs = (item.from % 60).toFixed(2).padStart(5, '0');
      return '[' + mins + ':' + secs + ']' + (item.content || '');
    })
    .join('\n');
  src.log('getBiliLyrics(' + bvid + ') → ' + body.length + ' line(s)');
  return lrc;
}

async function getBiliQrCode() {
  const res = await src.get('https://passport.bilibili.com/x/passport-login/web/qrcode/generate', { headers: BROWSER_HEADERS });
  const data = src.parse.json(res.body);
  if (data.code !== 0 || !data.data) {
    src.log('getBiliQrCode → failed: ' + (data.message || data.code));
    throw new Error('Failed to generate Bilibili QR code: ' + (data.message || data.code));
  }
  src.log('getBiliQrCode → qr key ' + previewValue(data.data.qrcode_key));
  return {
    url: data.data.url,
    key: data.data.qrcode_key,
  };
}

async function pollBiliQrCode(key) {
  const res = await src.get('https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=' + encodeURIComponent(key), { headers: BROWSER_HEADERS });
  const json = src.parse.json(res.body);
  const data = json?.data;
  const pollCode = data?.code;
  if (pollCode === 0) {
    // SESSDATA/bili_jct arrive as Set-Cookie on this response and land in the
    // source's jar on their own; only the refresh token needs storing.
    src.log('pollBiliQrCode → confirmed');
    return {
      state: 'confirmed',
      token: data.refresh_token,
      refresh_token: data.refresh_token,
    };
  } else if (pollCode === 86038) {
    src.log('pollBiliQrCode → expired');
    return { state: 'expired' };
  } else if (pollCode === 86090) {
    src.log('pollBiliQrCode → scanned, waiting for confirm');
    return { state: 'scanned' };
  } else {
    src.log('pollBiliQrCode → pending (code ' + pollCode + ')');
    return { state: 'pending' };
  }
}

// Cookie refresh, per docs/login/refresh/Cookie.md. The correspond page's RSA
// key is fixed; OAEP-SHA256 and a hex ciphertext are what the server repeats.
const REFRESH_PUBKEY = [
  '-----BEGIN PUBLIC KEY-----',
  'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDLgd2OAkcGVtoE3ThUREbio0Eg',
  'Uc/prcajMKXvkCKFCWhJYJcLkcM2DKKcSeFpD/j6Boy538YXnR6VhcuUJOhH2x71',
  'nzPjfdTcqMz7djHum0qSZA0AyCBDABUqCrfNgCiJ00Ra7GmRj+YCK1NJEuewlb40',
  'JNrRuoEUXpabUzGB8QIDAQAB',
  '-----END PUBLIC KEY-----',
].join('\n');

async function refreshBiliCookie() {
  const refreshToken = (await src.vars.get('refresh_token')) || (await src.vars.get('bili_refresh_token'));
  if (!refreshToken) {
    src.log('refreshBiliCookie → no refresh_token in vars — throwing');
    throw new Error('No refresh_token found');
  }

  // 1. Is a refresh due, and what timestamp signs the correspond path?
  const infoRes = await src.get('https://passport.bilibili.com/x/passport-login/web/cookie/info', { headers: BROWSER_HEADERS });
  const info = src.parse.json(infoRes.body);
  if (info.code !== 0 || !info.data?.timestamp) {
    src.log('refreshBiliCookie → cookie/info failed: ' + (info.message || info.code));
    throw new Error('cookie/info check failed: ' + (info.message || info.code));
  }

  // 2. correspond_path = RSA-OAEP-SHA256("refresh_" + timestamp), lowercase hex.
  const correspondPath = src.crypto.rsaOaepEncrypt('refresh_' + info.data.timestamp, REFRESH_PUBKEY);

  // 3. The correspond page carries the refresh_csrf for this device.
  const correspondRes = await src.get('https://www.bilibili.com/correspond/1/' + correspondPath, { headers: BROWSER_HEADERS });
  const match = correspondRes.body.match(/<div id="1-name">\s*([\s\S]*?)\s*<\/div>/);
  if (!match) {
    src.log('refreshBiliCookie → refresh_csrf not found in correspond page');
    throw new Error('refresh_csrf not found in correspond page');
  }
  const refreshCsrf = match[1].trim();

  // 4. Refresh. New SESSDATA/bili_jct land in the jar via Set-Cookie; the
  //    response body carries the *new* refresh_token, which the old one is
  //    replaced by.
  const csrf = (await src.cookie.get('bili_jct')) || '';
  const refreshRes = await src.post(
    'https://passport.bilibili.com/x/passport-login/web/cookie/refresh',
    'csrf=' + src.url.encode(csrf) +
      '&refresh_csrf=' + src.url.encode(refreshCsrf) +
      '&source=main_web' +
      '&refresh_token=' + src.url.encode(refreshToken),
    { headers: { ...BROWSER_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' } },
  );
  const refreshed = src.parse.json(refreshRes.body);
  if (refreshed.code !== 0) {
    src.log('refreshBiliCookie → refresh failed: ' + (refreshed.message || refreshed.code));
    throw new Error('Cookie refresh failed: ' + (refreshed.message || refreshed.code));
  }
  const newRefreshToken = refreshed.data?.refresh_token;
  if (newRefreshToken) {
    await src.vars.put('refresh_token', newRefreshToken);
  }

  // 5. Confirm — with the *new* csrf and the *old* refresh token, or the new
  //    cookies stay provisional and the next restart is logged out again.
  const newCsrf = (await src.cookie.get('bili_jct')) || csrf;
  await src.post(
    'https://passport.bilibili.com/x/passport-login/web/confirm/refresh',
    'csrf=' + src.url.encode(newCsrf) + '&refresh_token=' + src.url.encode(refreshToken),
    { headers: { ...BROWSER_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' } },
  );

  src.log('refreshBiliCookie → refreshed' + (newRefreshToken ? ' (new token stored)' : ' (kept existing token)'));
  return {
    token: newRefreshToken || refreshToken,
    refresh_token: newRefreshToken || refreshToken,
  };
}

/**
 * The uploader name off a space page — BilibiliSpaceListBaseIE._get_uploader.
 *
 * HTML, not an API: used only when a collection/series response carries no
 * owner, and fatal=False in yt-dlp — an empty name is better than failing the
 * playlist over a missing title tag.
 */
async function getBiliUploader(uid) {
  try {
    const res = await src.get('https://space.bilibili.com/' + src.url.encode(String(uid)), { headers: BROWSER_HEADERS });
    const match = res.body.match(/<title\b[^>]*>([^<]+)的个人空间-/);
    return match ? match[1].trim() : '';
  } catch (e) {
    return '';
  }
}

/**
 * One page of an upper's uploads — BilibiliSpaceVideoIE's fetch_page.
 *
 * The parameter set is yt-dlp's verbatim (keyword/order_avoided/platform/
 * tid/web_location/special_type/index + dm_*), WBI-signed, with the Referer
 * and Origin of a video list page. The error table is yt-dlp's: HTTP 412 and
 * codes -401/-352 are named as blocked/rejected rather than surfacing as an
 * empty list.
 */
async function fetchBiliSpacePage(uid, pn) {
  const params = {
    keyword: '',
    mid: String(uid),
    order: 'pubdate',
    order_avoided: 'true',
    platform: 'web',
    pn: pn,
    ps: 30,
    tid: 0,
    web_location: '333.1387',
    special_type: '',
    index: 0,
    ...dmParams(),
  };
  const query = await signWbiQuery(params);
  const res = await src.get('https://api.bilibili.com/x/space/wbi/arc/search?' + query, {
    headers: {
      ...BROWSER_HEADERS,
      Referer: 'https://space.bilibili.com/' + uid + '/video',
      Origin: 'https://space.bilibili.com',
      'Accept-Language': 'en,zh-CN;q=0.9,zh;q=0.8',
    },
  });
  if (res.status === 412) {
    throw new Error('Request is blocked by server (412), please wait and try later.');
  }
  const json = src.parse.json(res.body);
  if (json.code === -401) {
    throw new Error('Request is blocked by server (401), please wait and try later.');
  } else if (json.code === -352) {
    throw new Error('Request is rejected by server (352)');
  } else if (json.code !== 0) {
    throw new Error('Request failed (' + json.code + '): ' + (json.message || 'Unknown error'));
  }
  return json.data || {};
}

async function getBiliArtist(id) {
  const uid = String(id);
  let name = uid;
  let face = '';
  let sign = '';
  try {
    const cardRes = await src.get('https://api.bilibili.com/x/web-interface/card?mid=' + src.url.encode(uid), { headers: BROWSER_HEADERS });
    const cardData = src.parse.json(cardRes.body)?.data?.card;
    if (cardData) {
      name = cardData.name || uid;
      face = cleanPic(cardData.face || '');
      sign = cardData.sign || '';
    }
  } catch (e) {}

  let albums = [];
  try {
    const seasonsRes = await src.get('https://api.bilibili.com/x/polymer/web-space/seasons_series_list?mid=' + src.url.encode(uid) + '&page_num=1&page_size=20', { headers: BROWSER_HEADERS });
    const itemsLists = src.parse.json(seasonsRes.body)?.data?.items_lists;
    const seasons = itemsLists?.seasons_list || [];
    const series = itemsLists?.series_list || [];
    for (const s of seasons) {
      const meta = s.meta || s;
      // The mid rides in the id: seasons_archives_list needs the owner's mid
      // alongside the season id, and an id that does not carry it cannot
      // produce a valid playlist call later.
      albums.push({
        id: 'bili_season_' + uid + '_' + (meta.season_id || meta.id),
        title: meta.name || '',
        artwork: cleanPic(meta.cover || ''),
        trackCount: meta.total,
      });
    }
    for (const s of series) {
      const meta = s.meta || s;
      albums.push({
        id: 'bili_series_' + uid + '_' + (meta.series_id || meta.id),
        title: meta.name || '',
        artwork: cleanPic(meta.cover || ''),
        trackCount: meta.total,
      });
    }
  } catch (e) {}

  // The uploads walk — BilibiliSpaceVideoIE. Pages are bounded because the
  // artist rule returns one materialised list; yt-dlp pages lazily instead.
  const topTracks = [];
  try {
    const first = await fetchBiliSpacePage(uid, 1);
    const pageInfo = first.page || {};
    const ps = pageInfo.ps || 30;
    const total = pageInfo.count || 0;
    const pageCount = Math.min(MAX_ARTIST_PAGES, Math.max(1, Math.ceil(total / ps)));
    let vlist = (first.list && first.list.vlist) || [];
    for (let pn = 1; pn <= pageCount && vlist.length > 0; pn++) {
      for (const entry of vlist) {
        if (entry.meta && Number(entry.meta.attribute) === 156) {
          // A hidden-mode collection does not show its videos in uploads;
          // yt-dlp extracts it as a playlist instead, and this source exposes
          // it as an album beside the seasons and series above.
          const meta = entry.meta;
          albums.push({
            id: 'bili_season_' + uid + '_' + meta.id,
            title: cleanTitle(meta.title || entry.title || ''),
            artwork: cleanPic(meta.cover || entry.pic || ''),
            trackCount: meta.total,
          });
          continue;
        }
        if (!entry.bvid) continue;
        topTracks.push({
          id: entry.bvid,
          bvid: entry.bvid,
          title: cleanTitle(entry.title || ''),
          artwork: cleanPic(entry.pic || ''),
          duration: entry.length,
          durationMs: parseDuration(entry.length),
        });
      }
      src.log('getBiliArtist(' + uid + ') → arc/search page ' + pn + '/' + pageCount + ': ' +
        vlist.length + ' row(s), ' + topTracks.length + ' track(s)');
      if (pn < pageCount) {
        const next = await fetchBiliSpacePage(uid, pn + 1);
        vlist = (next.list && next.list.vlist) || [];
      }
    }
  } catch (e) {
    src.log('getBiliArtist(' + uid + ') → arc/search failed: ' + previewValue(String(e && e.message || e), 160));
  }

  const artist = {
    name,
    bio: sign,
    artwork: face,
    albums,
    topTracks,
  };
  src.log('getBiliArtist(' + uid + ') → ' + albums.length + ' album(s), ' + topTracks.length + ' track(s), name=' + previewValue(name));
  return artist;
}

/**
 * The `window.__INITIAL_STATE__` object out of a Bilibili player page.
 *
 * BilibiliBaseIE parses the same object with `_search_json`; the source walks
 * the braces itself (a marker, then balanced braces with string awareness)
 * instead of regex-matching a non-greedy run, because the object nests and a
 * lazy match can cut it mid-value.
 */
function extractInitialState(html) {
  const marker = /window\.__INITIAL_STATE__\s*=\s*/.exec(html);
  if (!marker) return null;
  let start = marker.index + marker[0].length;
  while (start < html.length && /\s/.test(html[start])) start++;
  if (html[start] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch (e) {
          return null;
        }
      }
    }
  }
  return null;
}

/** The initial state of a player page, cached per realm (one playlist walk). */
async function getBiliInitialState(url) {
  const cacheKey = 'bili_initial_' + url;
  const cached = src.cache.get(cacheKey);
  if (cached) return cached;
  const res = await src.get(url, { headers: BROWSER_HEADERS });
  const state = extractInitialState(res.body);
  if (!state) {
    throw new Error('Unable to extract initial state from ' + url);
  }
  src.cache.put(cacheKey, state, 300000);
  return state;
}

/**
 * What a playlist id names, wherever the user got it from.
 *
 * Besides the document's own `bili_*` ids, a fav folder or a collection is
 * often at hand as a bare number (the fav mlid) or as a URL copied from the
 * browser — `favlist?fid=…`, `channel/collectiondetail…sid=…`,
 * `channel/seriesdetail…sid=…`, `/lists/<sid>?type=…`. The URL patterns are
 * yt-dlp's `_VALID_URL` patterns for the four list extractors, and each
 * spelling lands on the flow yt-dlp uses for it.
 *
 * `bilibili.com/list/…` and `medialist/play/…` are BilibiliPlaylistIE: the
 * entity is whatever the page's `__INITIAL_STATE__` says it is, so these are
 * carried as a `medialist` target with the page URL and resolved at fetch
 * time. A bare season id is the one shape that cannot be honoured: the
 * archives call needs the owner's mid alongside it, and a season id alone
 * does not carry one (verified: a mismatched mid answers -404).
 */
function parsePlaylistTarget(raw) {
  const sid = String(raw || '').trim();

  const medialistUrl = sid.match(/(?:www\.)?bilibili\.com\/(?:list|medialist\/play)\/(\w+)/);
  if (medialistUrl) return { kind: 'medialist', url: sid, id: medialistUrl[1] };

  // The canonical id this source hands back for a medialist — `getPlaylist`
  // is called with it on the next page, so it must parse without the URL.
  const medialistId = sid.match(/^bili_medialist_(\d+)_(\d+)$/);
  if (medialistId) return { kind: 'medialist', canonicalId: sid, type: Number(medialistId[1]), id: medialistId[2] };

  const collectMatch = sid.match(/(?:^bili_collect_)(\d+)$/) || sid.match(/^(\d+)$/);
  if (collectMatch) return { kind: 'collect', id: collectMatch[1] };

  const seasonMatch =
    sid.match(/space\.bilibili\.com\/(\d+)\/channel\/collectiondetail\?.*?sid=(\d+)/) ||
    sid.match(/space\.bilibili\.com\/(\d+)\/lists\/(\d+)(?![^#]*\btype=series)/) ||
    sid.match(/^bili_season_(\d+)_(\d+)$/);
  if (seasonMatch) return { kind: 'season', mid: seasonMatch[1], id: seasonMatch[2] };
  if (/^bili_season_\d+$/.test(sid)) {
    throw new Error('season id "' + sid + '" carries no mid — open it again from the artist page, or paste the space.bilibili.com collectiondetail URL');
  }

  const seriesMatch =
    sid.match(/space\.bilibili\.com\/(\d+)\/(?:channel\/)?seriesdetail\?.*?sid=(\d+)/) ||
    sid.match(/space\.bilibili\.com\/(\d+)\/lists\/(\d+)[^#]*\btype=series/) ||
    sid.match(/^bili_series_(\d+)_(\d+)$/);
  if (seriesMatch) return { kind: 'series', mid: seriesMatch[1], id: seriesMatch[2] };

  const favMatch = sid.match(/space\.bilibili\.com\/\d+\/favlist\?.*?fid=(\d+)/);
  if (favMatch) return { kind: 'collect', id: favMatch[1] };

  return null;
}

function seasonPlaylist(mid, seasonId, data, pn, ps) {
  const meta = data.meta || {};
  const archives = data.archives || [];
  const total = (data.page && data.page.total) || archives.length;
  const hasMore = pn * ps < total;
  return {
    id: 'bili_season_' + mid + '_' + seasonId,
    name: meta.name || '',
    artwork: cleanPic(meta.cover || ''),
    description: meta.description || '',
    owner: (meta.owner && meta.owner.name) || (archives[0] && archives[0].owner && archives[0].owner.name) || '',
    items: archives.map((a) => ({
      id: a.bvid,
      bvid: a.bvid,
      title: cleanTitle(a.title || ''),
      duration: a.duration,
      cover: cleanPic(a.pic || ''),
      artist: (a.owner && a.owner.name) || (meta.owner && meta.owner.name) || '',
    })),
    hasMore,
    cursor: hasMore ? String(pn + 1) : undefined,
    trackCount: total,
  };
}

function seriesPlaylist(mid, seriesId, meta, data, pn, ps) {
  const info = meta || data.meta || {};
  const archives = data.archives || [];
  const total = (data.page && data.page.total) || archives.length;
  const hasMore = pn * ps < total;
  return {
    id: 'bili_series_' + mid + '_' + seriesId,
    name: info.name || '',
    artwork: cleanPic(info.cover || ''),
    description: info.description || '',
    owner: (archives[0] && archives[0].owner && archives[0].owner.name) || '',
    items: archives.map((a) => ({
      id: a.bvid,
      bvid: a.bvid,
      title: cleanTitle(a.title || ''),
      duration: a.duration,
      cover: cleanPic(a.pic || ''),
      artist: (a.owner && a.owner.name) || '',
    })),
    hasMore,
    cursor: hasMore ? String(pn + 1) : undefined,
    trackCount: total,
  };
}

async function fetchBiliSeasonPlaylist(mid, seasonId, pn, ps) {
  const referer = 'https://space.bilibili.com/' + mid + '/channel/collectiondetail?sid=' + seasonId;
  const res = await src.get(
    'https://api.bilibili.com/x/polymer/web-space/seasons_archives_list?mid=' + src.url.encode(mid) +
      '&season_id=' + src.url.encode(seasonId) + '&page_num=' + pn + '&page_size=' + ps,
    { headers: { ...BROWSER_HEADERS, Referer: referer } },
  );
  const json = src.parse.json(res.body);
  if (json.code !== 0) {
    throw new Error('collection ' + seasonId + ' failed: ' + (json.message || json.code));
  }
  const result = seasonPlaylist(mid, seasonId, json.data || {}, pn, ps);
  if (!result.owner) {
    result.owner = await getBiliUploader(mid);
  }
  src.log('getBiliPlaylist(season ' + seasonId + ', page ' + pn + ') → ' + result.items.length + ' item(s), hasMore=' + result.hasMore + ', name=' + previewValue(result.name));
  return result;
}

async function fetchBiliSeriesPlaylist(mid, seriesId, pn, ps) {
  // yt-dlp reads the series metadata from its own endpoint before the
  // archives page; the archives response's `meta` is only a fallback.
  let meta;
  try {
    const metaRes = await src.get('https://api.bilibili.com/x/series/series?series_id=' + src.url.encode(seriesId), { headers: BROWSER_HEADERS });
    const metaJson = src.parse.json(metaRes.body);
    if (metaJson.code === 0) meta = metaJson.data && metaJson.data.meta;
  } catch (e) {
    src.log('getBiliPlaylist(series ' + seriesId + ') → x/series/series failed: ' + previewValue(String(e && e.message || e), 120));
  }
  const res = await src.get(
    'https://api.bilibili.com/x/series/archives?mid=' + src.url.encode(mid) +
      '&series_id=' + src.url.encode(seriesId) + '&pn=' + pn + '&ps=' + ps,
    { headers: BROWSER_HEADERS },
  );
  const json = src.parse.json(res.body);
  if (json.code !== 0) {
    throw new Error('series ' + seriesId + ' failed: ' + (json.message || json.code));
  }
  const result = seriesPlaylist(mid, seriesId, meta, json.data || {}, pn, ps);
  if (!result.owner) {
    result.owner = await getBiliUploader(mid);
  }
  src.log('getBiliPlaylist(series ' + seriesId + ', page ' + pn + ') → ' + result.items.length + ' item(s), hasMore=' + result.hasMore + ', name=' + previewValue(result.name));
  return result;
}

/**
 * A player-page playlist — BilibiliPlaylistIE.
 *
 * `bilibili.com/list/<mid>?sid=<sid>`, `…/list/ml<id>` and `…/list/watchlater`
 * are all the medialist API: `x/v2/medialist/resource/list`, paged by the
 * `oid` of the last item rather than by page number. The entity behind the
 * id — series, fav medialist, watchlater — is whatever the page's
 * `__INITIAL_STATE__` says it is, which is why this branch fetches the page
 * where the season/series branches do not.
 *
 * The canonical id (`bili_medialist_<type>_<biz_id>`) is what the runtime
 * hands back on the next page, so the initial state is also cached under it
 * and a cursor call does not need the URL again.
 */
async function fetchBiliMedialist(target, pn, ps, cursor) {
  let state;
  if (target.canonicalId) {
    state = src.cache.get('bili_initial_id_' + target.canonicalId);
    if (!state) {
      throw new Error('playlist session for ' + target.canonicalId + ' expired — open it again from its URL');
    }
  } else {
    state = await getBiliInitialState(target.url);
  }

  // yt-dlp checks both `error` and `listError`, and reads `trueCode` for the
  // real status: -400 watchlater needs login, -403 is private, 11010 gone.
  const error = [state.error, state.listError].find((e) => e && e.code);
  if (error && error.code !== 200) {
    const code = error.trueCode;
    if (code === -400 && String(target.id) === 'watchlater') {
      throw new Error('You need to login to access your watchlater playlist');
    }
    if (code === -403) {
      throw new Error('This is a private playlist. You need to login as its owner');
    }
    if (code === 11010) {
      throw new Error('Playlist is no longer available');
    }
    throw new Error('Could not access playlist: ' + code + ' ' + (error.message || ''));
  }

  const playlist = state.playlist || {};
  const info = state.mediaListInfo || {};
  const canonicalId = target.canonicalId ||
    ('bili_medialist_' + (playlist.type || '?') + '_' + (playlist.id || target.id));
  if (!target.canonicalId) {
    src.cache.put('bili_initial_id_' + canonicalId, state, 300000);
  }

  const params = {
    ps: ps,
    with_current: 'false',
    type: playlist.type,
    biz_id: playlist.id,
    tid: state.tid,
    sort_field: state.sortFiled,
    desc: state.desc,
    oid: cursor,
  };
  const query = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null)
    .map((k) => src.url.encode(k) + '=' + src.url.encode(params[k]))
    .join('&');
  const res = await src.get('https://api.bilibili.com/x/v2/medialist/resource/list?' + query, { headers: BROWSER_HEADERS });
  const json = src.parse.json(res.body);
  if (json.code !== 0) {
    throw new Error('medialist ' + canonicalId + ' failed: ' + (json.message || json.code));
  }
  const data = json.data || {};
  const mediaList = data.media_list || [];
  const last = mediaList[mediaList.length - 1];
  const hasMore = !!data.has_more;

  const result = {
    id: canonicalId,
    name: info.title || '',
    artwork: cleanPic(info.cover || ''),
    description: info.intro || '',
    owner: (info.upper && info.upper.name) || '',
    items: mediaList.map((m) => ({
      id: m.bv_id || String(m.id),
      bvid: m.bv_id,
      title: cleanTitle(m.title || ''),
      duration: m.duration,
      cover: cleanPic(m.cover || ''),
      artist: (m.upper && m.upper.name) || '',
      artistId: m.upper ? String(m.upper.mid) : undefined,
      upper: m.upper ? { id: String(m.upper.mid), name: m.upper.name } : undefined,
      cid: m.pages && m.pages[0] ? m.pages[0].id : undefined,
    })),
    hasMore,
    cursor: hasMore && last ? String(last.id) : undefined,
    trackCount: info.media_count,
  };
  src.log('getBiliPlaylist(medialist ' + canonicalId + ', ' + (cursor ? 'cursor ' + cursor : 'first page') + ') → ' + result.items.length + ' item(s), hasMore=' + hasMore + ', name=' + previewValue(result.name));
  return result;
}

/**
 * A favourites folder — BilibiliFavoritesListIE.
 *
 * yt-dlp fetches the metadata from `x/v3/fav/resource/list` (page 1) and the
 * entry list from `x/v3/fav/resource/ids`, which answers every bvid at once;
 * it never pages the folder itself. The source keeps yt-dlp's two calls and
 * additionally reads the requested page of `resource/list`, because ids carry
 * no titles and a playlist row without one is not a row a user can pick.
 * Pagination is therefore local over the ids list, with the page's rows
 * enriched by the matching `resource/list` page.
 */
async function fetchBiliFavPlaylist(mediaId, pn, ps) {
  const idsUrl = 'https://api.bilibili.com/x/v3/fav/resource/ids?media_id=' + src.url.encode(mediaId);
  let allIds = src.cache.get('bili_fav_ids_' + mediaId);
  if (!Array.isArray(allIds)) {
    try {
      const idsRes = await src.get(idsUrl, { headers: BROWSER_HEADERS });
      const idsJson = src.parse.json(idsRes.body);
      if (idsJson.code === -403) {
        throw new Error('This is a private favorites list. You need to log in as its owner');
      }
      allIds = (idsJson.data || [])
        .map((item) => (item && (item.bvid || item.bv_id)) ? String(item.bvid || item.bv_id) : '')
        .filter(Boolean);
      src.cache.put('bili_fav_ids_' + mediaId, allIds, 600000);
      src.log('getBiliPlaylist(collect ' + mediaId + ') → resource/ids: ' + allIds.length + ' entr(ies)');
    } catch (e) {
      if (String(e && e.message || e).indexOf('private favorites') >= 0) throw e;
      src.log('getBiliPlaylist(collect ' + mediaId + ') → resource/ids failed: ' + previewValue(String(e && e.message || e), 120));
      allIds = [];
    }
  }

  const res = await src.get('https://api.bilibili.com/x/v3/fav/resource/list?media_id=' + src.url.encode(mediaId) + '&pn=' + pn + '&ps=' + ps + '&platform=web', { headers: BROWSER_HEADERS });
  const json = src.parse.json(res.body);
  if (json.code === -403) {
    throw new Error('This is a private favorites list. You need to log in as its owner');
  }
  const data = json.data || {};
  const info = data.info || {};
  const medias = (data.medias || []).filter((m) => m && m.bvid);
  const byBvid = {};
  for (const m of medias) byBvid[m.bvid] = m;

  let rows;
  let total;
  let hasMore;
  if (allIds.length > 0) {
    const pageIds = allIds.slice((pn - 1) * ps, pn * ps);
    rows = pageIds.map((bvid) => byBvid[bvid] || { bvid: bvid });
    total = allIds.length;
    hasMore = pn * ps < total;
  } else {
    rows = medias;
    total = info.media_count || 0;
    hasMore = data.has_more === undefined ? pn * ps < total : !!data.has_more;
  }

  const result = {
    id: 'bili_collect_' + mediaId,
    name: info.title || '',
    artwork: cleanPic(info.cover || ''),
    description: info.intro || '',
    owner: (info.upper && info.upper.name) || '',
    items: rows.map((m) => ({
      id: m.bvid,
      bvid: m.bvid,
      title: cleanTitle(m.title || ''),
      duration: m.duration,
      cover: cleanPic(m.cover || ''),
      artist: (m.upper && m.upper.name) || '',
      artistId: m.upper ? String(m.upper.mid) : undefined,
      upper: m.upper ? { id: String(m.upper.mid), name: m.upper.name } : undefined,
      cid: m.cid,
    })),
    hasMore,
    cursor: hasMore ? String(pn + 1) : undefined,
    trackCount: total,
  };
  src.log('getBiliPlaylist(collect ' + mediaId + ', page ' + pn + ') → ' + result.items.length + ' item(s), hasMore=' + hasMore + ', name=' + previewValue(result.name));
  return result;
}

async function getBiliPlaylist(id, page) {
  const target = parsePlaylistTarget(id);
  const pn = page?.cursor ? parseInt(page.cursor, 10) : 1;
  const ps = page?.limit || 30;
  const sid = String(id);

  if (!target) {
    throw new Error('cannot interpret playlist id ' + sid + ' — a fav id, a bili_collect/season/series id, or a space.bilibili.com / bilibili.com/list URL');
  }

  if (target.kind === 'season') {
    return fetchBiliSeasonPlaylist(target.mid, target.id, pn, ps);
  }

  if (target.kind === 'series') {
    return fetchBiliSeriesPlaylist(target.mid, target.id, pn, ps);
  }

  if (target.kind === 'medialist') {
    return fetchBiliMedialist(target, pn, ps, page?.cursor);
  }

  return fetchBiliFavPlaylist(target.id, pn, ps);
}

async function getBiliLibraryList(kind, page) {
  if (kind !== 'playlist') {
    src.log('getBiliLibraryList(' + kind + ') → 0 item(s) (kind not supported)');
    return { items: [], hasMore: false };
  }

  const navRes = await src.get('https://api.bilibili.com/x/web-interface/nav', { headers: BROWSER_HEADERS });
  const navData = src.parse.json(navRes.body);
  const mid = navData?.data?.mid;
  if (!mid) {
    src.log('getBiliLibraryList(playlist) → 0 item(s) (not signed in, no mid)');
    return { items: [], hasMore: false };
  }

  const items = [];

  try {
    const createdRes = await src.get('https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=' + src.url.encode(String(mid)), { headers: BROWSER_HEADERS });
    const createdData = src.parse.json(createdRes.body)?.data;
    for (const f of createdData?.list || []) {
      items.push({
        id: 'bili_collect_' + f.id,
        addedAt: f.ctime ? f.ctime * 1000 : undefined,
      });
    }
  } catch (e) {}

  try {
    const colRes = await src.get('https://api.bilibili.com/x/v3/fav/folder/collected/list?up_mid=' + src.url.encode(String(mid)) + '&pn=1&ps=50&platform=web', { headers: BROWSER_HEADERS });
    const colData = src.parse.json(colRes.body)?.data;
    for (const f of colData?.list || []) {
      items.push({
        id: 'bili_collect_' + f.id,
        addedAt: f.ctime ? f.ctime * 1000 : undefined,
      });
    }
  } catch (e) {}

  const libraryResult = {
    items,
    hasMore: false,
    total: items.length,
  };
  src.log('getBiliLibraryList(playlist) → ' + items.length + ' list(s) for mid ' + mid);
  return libraryResult;
}
