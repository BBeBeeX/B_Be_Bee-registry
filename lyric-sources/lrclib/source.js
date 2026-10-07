// LRCLIB lyric source script — the entire `script` body executed by
// plugin-lyric-sources' sandbox. The runner exposes `httpFetch` (host-proxied,
// restricted to allowedHosts) and calls `searchLyrics({ title, artist, duration })`.
//
// Fetch policy: exact match first, fuzzy search as fallback —
//   1. /api/get with track_name + artist_name (+ duration when known),
//      trying the cleaned title and then the raw title; a hit returns
//      synced lyrics, else plain, else the instrumental marker.
//   2. /api/search?q="artist title" — duration-windowed tiers
//      (synced within 3s, then 6s; plain within 4s), then any synced,
//      then any plain.
//   3. /api/search?q=title — title-only last resort.

async function searchLyrics(query) {
  const { title, artist, duration } = query;
  if (!title || typeof title !== 'string') return null;

  const trimmedTitle = title.trim();
  const trimmedArtist = (artist || '').trim();
  const durationSec = duration && duration > 0 ? Math.round(duration / 1000) : 0;

  const headers = {
    'User-Agent': 'BBeBee-MusicPlayer/1.0.0 (https://github.com/BBeBee)',
    'Lrclib-Client': 'BBeBee-MusicPlayer/1.0.0',
  };

  function toQueryString(params) {
    return Object.entries(params)
      .filter(([_, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
      .join('&');
  }

  function cleanTitle(t) {
    if (!t) return '';
    return t
      .replace(/\s*[\(\[](?:(?:19|20)\d\d\s+)?(?:remaster(?:ed)?|live|explicit|deluxe|bonus(?:\s+track)?|anniversary|edit|mix|version|feat\.?.*)(?:\s+(?:19|20)\d\d)?[\)\]]\s*$/i, '')
      .replace(/\s*-\s*(?:(?:19|20)\d\d\s+)?(?:remaster(?:ed)?|live|deluxe|bonus(?:\s+track)?|anniversary|edit|mix|version)(?:\s+(?:19|20)\d\d)?\s*$/i, '')
      .trim();
  }

  async function parseBody(res) {
    if (!res) return null;
    try {
      if (typeof res.json === 'function') return await res.json();
      if (typeof res.body === 'string' && res.body) return JSON.parse(res.body);
    } catch (_) {}
    return null;
  }

  let lastNetworkError = null;

  // 1. Try exact match via /api/get
  if (trimmedTitle && trimmedArtist) {
    const titlesToTry = [trimmedTitle];
    const cleaned = cleanTitle(trimmedTitle);
    if (cleaned && cleaned !== trimmedTitle) {
      titlesToTry.push(cleaned);
    }

    for (const curTitle of titlesToTry) {
      try {
        const getParams = {
          track_name: curTitle,
          artist_name: trimmedArtist,
        };
        if (durationSec > 0) {
          getParams.duration = String(durationSec);
        }

        const res = await httpFetch('https://lrclib.net/api/get?' + toQueryString(getParams), {
          headers,
        });

        if (res && res.status === 200) {
          const data = await parseBody(res);
          if (data) {
            if (data.syncedLyrics && data.syncedLyrics.trim()) {
              return data.syncedLyrics;
            }
            if (data.plainLyrics && data.plainLyrics.trim()) {
              return data.plainLyrics;
            }
            if (data.instrumental) {
              return '[00:00.00]纯音乐，请欣赏';
            }
          }
        }
      } catch (err) {
        lastNetworkError = err;
      }
    }
  }

  // 2. Fallback to /api/search (fuzzy query)
  try {
    const searchTitle = cleanTitle(trimmedTitle) || trimmedTitle;
    const q = trimmedArtist ? `${trimmedArtist} ${searchTitle}` : searchTitle;
    const searchUrl = 'https://lrclib.net/api/search?' + toQueryString({ q });

    const res = await httpFetch(searchUrl, { headers });
    if (res && res.status === 200) {
      const list = await parseBody(res);
      if (Array.isArray(list) && list.length > 0) {
        let match = null;

        if (durationSec > 0) {
          match = list.find((it) => it && it.syncedLyrics && Math.abs((it.duration || 0) - durationSec) <= 3);
          if (!match) {
            match = list.find((it) => it && it.syncedLyrics && Math.abs((it.duration || 0) - durationSec) <= 6);
          }
          if (!match) {
            match = list.find((it) => it && it.plainLyrics && Math.abs((it.duration || 0) - durationSec) <= 4);
          }
        }

        if (!match) {
          match = list.find((it) => it && it.syncedLyrics);
        }
        if (!match) {
          match = list.find((it) => it && it.plainLyrics);
        }

        if (match) {
          if (match.syncedLyrics && match.syncedLyrics.trim()) {
            return match.syncedLyrics;
          }
          if (match.plainLyrics && match.plainLyrics.trim()) {
            return match.plainLyrics;
          }
          if (match.instrumental) {
            return '[00:00.00]纯音乐，请欣赏';
          }
        }
      }
    }
  } catch (err) {
    lastNetworkError = err;
  }

  // 3. Fallback to title-only search if artist+title search returned nothing
  if (trimmedArtist && trimmedTitle) {
    try {
      const res = await httpFetch('https://lrclib.net/api/search?' + toQueryString({ q: trimmedTitle }), { headers });
      if (res && res.status === 200) {
        const list = await parseBody(res);
        if (Array.isArray(list) && list.length > 0) {
          const match = list.find((it) => it && (it.syncedLyrics || it.plainLyrics));
          if (match) {
            return match.syncedLyrics || match.plainLyrics || null;
          }
        }
      }
    } catch (err) {
      lastNetworkError = err;
    }
  }

  if (lastNetworkError) {
    throw lastNetworkError;
  }

  return null;
}
