// ZonaFilm module for Alcopac/Lampa
// Parses zonafilm.tv via cdnvideohub API
//
// Flow:
//   1. checksearch   -> quick availability check via search
//   2. play          -> direct stream from vkId
//   3. resolve id    -> map query.id to a page URL (via search if needed)
//   4. get title     -> fetch playlist, build seasons/voices maps
//   5. movie         -> list available voice translations with direct play links
//   6. serial        -> season list -> episodes with voice switcher buttons (HTML)
//
// Serial navigation:
//   - /lite/zonafilm?id=...&title=...                    -> season list
//   - /lite/zonafilm?id=...&title=...&s=1                  -> episodes for season 1
//   - /lite/zonafilm?id=...&title=...&s=1&voice=...        -> episodes with chosen voice
//
// Voice switcher:
//   Voices are rendered as HTML buttons (videos__button selector) above the
//   episode list, exactly like the sakh_tv example. Switching a voice reloads
//   the same season but with a different &voice= parameter.

var DEFAULTS = { host: 'https://zonafilm.tv', proxyStreams: true };
var PLAPI    = 'https://plapi.cdnvideohub.com';
var UA       = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

/**
 * Read a config key from inv.config, falling back to DEFAULTS.
 */
function cfg(inv, k) {
  var v = inv.config && inv.config[k];
  return (v === undefined || v === null || v === '') ? DEFAULTS[k] : v;
}

/**
 * Simple GET helper with common headers.
 */
function httpGet(url, referer) {
  return http.get(url, {
    headers: {
      'User-Agent': UA,
      'Referer': referer || 'https://zonafilm.tv/',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    }
  });
}

/**
 * Main entry point — routes to checksearch, play, movie or serial flow.
 */
function handle(inv) {
  var host  = cfg(inv, 'host');
  var title = (inv.query.title || inv.query.original_title || '').trim();

  // --- 1. checksearch: quick availability probe ---
  if (inv.checksearch) {
    var r = searchAllQueries(inv, host);
    return strictMatch(r, inv)
      ? { rch: true, type: inv.query.serial === '1' ? 'serial' : 'movie', quality: 'FHD' }
      : { rch: false };
  }

  // --- 2. play: direct video stream by vkId ---
  if (inv.path && inv.path.indexOf('play') !== -1) {
    return playStream(inv, host);
  }

  // --- 3. resolve id: turn query.id into a zonafilm page URL ---
  var id = resolveId(inv, host);
  if (!id) {
    var results = searchAllQueries(inv, host);
    if (!results.length) return { type: 'movie', data: [] };

    // Exact match or single result -> pick it
    if (results.length === 1 || strictMatch(results, inv)) {
      id = results[0].url;
    } else {
      // Ambiguous -> show similar titles picker
      return {
        type: 'similar',
        data: results.map(function (r) {
          return {
            title: r.title + (r.year ? ' (' + r.year + ')' : ''),
            url: inv.host + '/lite/zonafilm?id=' + util.urlencode(r.url) + '&title=' + util.urlencode(title)
          };
        })
      };
    }
  }

  // --- 4. get title: fetch playlist, parse seasons & voices ---
  var detail = getTitle(inv, id, host);
  if (!detail) return { type: 'movie', data: [] };

  // --- 5. movie: list voice translations with play links ---
  if (!detail.isSerial) {
    return buildMovieResult(detail.items, host, detail.referer, inv);
  }

  // --- 6. serial: season list -> episodes with voice buttons ---
  return buildSerialResult(inv, detail, id, title);
}

// ═══════════════════════════════════════════════════════════════
//  SERIAL FLOW
// ═══════════════════════════════════════════════════════════════

/**
 * Build the result for a TV series:
 *   - If no season selected yet -> return season list (type: 'season')
 *   - Otherwise -> return HTML with voice buttons + episode list
 */
function buildSerialResult(inv, detail, id, title) {
  var seasons  = detail.seasons || [];
  var baseId   = id.replace(/\|s=\d+\|e=\d+$/, '').replace(/\|s=\d+$/, '');
  var kpParam  = inv.query.kinopoisk_id ? '&kinopoisk_id=' + inv.query.kinopoisk_id : '';
  var s        = (inv.query.s === '' || inv.query.s === undefined) ? -1 : parseInt(inv.query.s, 10);
  var voiceQuery = (inv.query.voice || '').trim();

  // A. No season chosen -> show season list
  if (s === -1 && seasons.length > 1) {
    return {
      type: 'season',
      data: seasons.map(function (se) {
        return {
          method: 'link',
          id: se.number,
          url: inv.host + '/lite/zonafilm?id=' + util.urlencode(baseId) +
               '&title=' + util.urlencode(title) + '&s=' + se.number + kpParam,
          name: se.number + ' сезон'
        };
      })
    };
  }
  if (s === -1) s = (seasons[0] && seasons[0].number) || 1;

  // B. Collect voices for this specific season
  var seasonVoices = [];
  if (detail.voicesBySeason && detail.voicesBySeason[s]) {
    for (var k in detail.voicesBySeason[s]) seasonVoices.push(detail.voicesBySeason[s][k]);
  }
  // Keep stable order so buttons don't jump around when switching
  seasonVoices.sort(function (a, b) { return (a.id || 0) - (b.id || 0); });

  // C. Pick voice: by name from URL, else default to first voice of this season
  var selectedVoiceIndex = 0;
  if (voiceQuery) {
    for (var vi = 0; vi < seasonVoices.length; vi++) {
      if (seasonVoices[vi].name === voiceQuery) { selectedVoiceIndex = vi; break; }
    }
  }
  var selectedVoice = seasonVoices[selectedVoiceIndex] || { name: '', studio: '' };

  // D. Group episodes by number for the selected season
  var episodesMap = {};
  for (var i = 0; i < detail.items.length; i++) {
    var item = detail.items[i];
    if (String(item.season) === String(s)) {
      var e = item.episode || 1;
      if (!episodesMap[e]) episodesMap[e] = [];
      episodesMap[e].push(item);
    }
  }
  var epNums = Object.keys(episodesMap).map(Number).sort(function (a, b) { return a - b; });

  // E. Render voice buttons + episodes as HTML
  var html = '';

  // Voice switcher buttons (videos__button selector)
  if (seasonVoices.length > 1) {
    for (var vi = 0; vi < seasonVoices.length; vi++) {
      var v   = seasonVoices[vi];
      var cls = 'videos__button selector' + (vi === selectedVoiceIndex ? ' active' : '');
      var vUrl = inv.host + '/lite/zonafilm?id=' + util.urlencode(baseId) +
                 '&title=' + util.urlencode(title) + '&s=' + s + '&voice=' + util.urlencode(v.name) + kpParam;
      var vJson = JSON.stringify({ method: 'link', url: vUrl }).replace(/'/g, '&#39;');
      html += '<div class="' + cls + '" data-json=\'' + vJson + '\'>' + v.name + '</div>';
    }
  }

  // Episode list (videos__item selector videos__episode)
  for (var i = 0; i < epNums.length; i++) {
    var eNum     = epNums[i];
    var epItems  = episodesMap[eNum];
    var selectedItem = null;
    // Try to find an item that matches the chosen voice studio
    for (var j = 0; j < epItems.length; j++) {
      if (epItems[j].voiceStudio === selectedVoice.studio) { selectedItem = epItems[j]; break; }
    }
    // Fallback: first available item for this episode
    if (!selectedItem) selectedItem = epItems[0];

    var epUrl = inv.host + '/lite/zonafilm/play?ep=' + selectedItem.vkId +
                '&s=' + s + '&e=' + eNum + '&title=' + util.urlencode(title);
    var epJson = JSON.stringify({ method: 'call', url: epUrl, episode: eNum, season: s })
                 .replace(/'/g, '&#39;');
    html += '<div class="videos__item selector videos__episode" data-json=\'' + epJson + '\'>' +
            '<div class="videos__item-title">' + eNum + '. Серия</div></div>';
  }

  return html;
}

// ═══════════════════════════════════════════════════════════════
//  ID RESOLUTION
// ═══════════════════════════════════════════════════════════════

/**
 * Convert inv.query.id into a zonafilm page URL.
 *   - If it already looks like a path (.html or starts with /) -> use as-is
 *   - Otherwise search by title and cache the best match
 */
function resolveId(inv, host) {
  var rawId = decodeURIComponent((inv.query.id || '').trim());
  if (!rawId) return '';
  if (rawId.indexOf('.html') !== -1 || rawId.indexOf('/') === 0) return rawId;

  var mapped = cache.get('idmap:' + rawId);
  if (mapped) return mapped;

  var results = searchAllQueries(inv, host);
  if (results.length) {
    cache.set('idmap:' + rawId, results[0].url, 600);
    return results[0].url;
  }
  return '';
}

// ═══════════════════════════════════════════════════════════════
//  SEARCH
// ═══════════════════════════════════════════════════════════════

/**
 * Search by both title and original_title, deduplicating by URL.
 */
function searchAllQueries(inv, host) {
  var tried  = {};
  var all    = [];
  var urlMap = {};
  var queries = [(inv.query.title || '').trim(), (inv.query.original_title || '').trim()];

  for (var i = 0; i < queries.length; i++) {
    var q = queries[i];
    if (!q || tried[q.toLowerCase()]) continue;
    tried[q.toLowerCase()] = true;
    var r = search(inv, host, q);
    if (r && r.length) {
      for (var j = 0; j < r.length; j++) {
        if (!urlMap[r[j].url]) { urlMap[r[j].url] = true; all.push(r[j]); }
      }
    }
  }
  return all;
}

/**
 * Single search request against zonafilm.tv search page.
 * Parses the carousel HTML for title links and years.
 */
function search(inv, host, query) {
  var cacheKey = 'search:' + query.toLowerCase();
  var cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  var r = httpGet(host + '/?do=search&subaction=search&story=' + util.urlencode(query), host + '/');
  if (!r.ok) return [];

  var html    = r.body || '';
  var results = [];
  var re      = /<a href="https:\/\/zonafilm\.tv(\/\d+-[^"]+\.html)"[^>]*title="([^"]+)"[^>]*class="section__carousel-item"/g;
  var m;
  while ((m = re.exec(html)) !== null) {
    var snippet   = html.substring(m.index, m.index + 400);
    var yearMatch = snippet.match(/<span>(\d{4})<\/span>/);
    results.push({ title: m[2], url: m[1], year: yearMatch ? parseInt(yearMatch[1], 10) : 0 });
  }

  cache.set(cacheKey, results, 300);
  return results;
}

/**
 * Check if any result matches the requested title + year.
 */
function strictMatch(results, inv) {
  if (!results.length) return false;
  var year = parseInt(inv.query.year || 0, 10);
  var qt   = (inv.query.title || '').trim().toLowerCase();
  var qot  = (inv.query.original_title || '').trim().toLowerCase();
  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    if (year && r.year !== year) continue;
    var rt = r.title.toLowerCase();
    if (qt && (rt.indexOf(qt) !== -1 || qt.indexOf(rt) !== -1)) return true;
    if (qot && (rt.indexOf(qot) !== -1 || qot.indexOf(rt) !== -1)) return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════
//  TITLE DATA (PLAYLIST)
// ═══════════════════════════════════════════════════════════════

/**
 * Fetch the cdnvideohub playlist for a given title, then build:
 *   - seasons[]        : list of season numbers
 *   - voicesBySeason{} : map season -> voice objects (studio, type, name)
 *   - items[]          : raw playlist items (used later for episode lookup)
 *
 * ID resolution order:
 *   1. kinopoisk_id from query
 *   2. /__kp__<id> prefix
 *   3. Parse the zonafilm HTML page for data-title-id
 */
function getTitle(inv, id, host) {
  var baseId   = id.replace(/\|s=\d+\|e=\d+$/, '').replace(/\|s=\d+$/, '');
  var cacheKey = 'title:v2:' + baseId;
  var cached   = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  var titleId = null;
  var referer = host + '/';
  var kpId    = (inv.query.kinopoisk_id || '').trim();

  if (kpId) {
    titleId = kpId;
  } else if (id.indexOf('/__kp__') === 0) {
    titleId = id.replace('/__kp__', '');
  } else {
    var pageUrl = id.indexOf('http') === 0 ? id : host + id;
    referer = pageUrl;
    var r = httpGet(pageUrl, host + '/');
    if (!r.ok) return null;

    var html = r.body || '';
    var vpMatch = html.match(/data-title-id="(\d+)"/);
    // Some serial pages hide the id on the main page — try the first episode page
    if (!vpMatch && html.indexOf('season-link') !== -1) {
      var firstEpMatch = html.match(/href="https:\/\/zonafilm\.tv(\/[^"]+\/\d+-season\/\d+-episode\.html)"/);
      if (firstEpMatch) {
        var epR = httpGet(host + firstEpMatch[1], pageUrl);
        if (epR.ok) vpMatch = (epR.body || '').match(/data-title-id="(\d+)"/);
      }
    }
    if (!vpMatch) return null;
    titleId = vpMatch[1];
  }

  var plData = fetchPlaylist(titleId, host, referer);
  if (!plData || !plData.items || !plData.items.length) return null;

  var seasonsMap     = {};
  var voicesBySeason = {};

  for (var i = 0; i < plData.items.length; i++) {
    var item = plData.items[i];
    var s    = item.season || 1;

    if (!seasonsMap[s]) {
      seasonsMap[s]     = { number: s, episodes: [] };
      voicesBySeason[s] = {};
    }

    var studio = (item.voiceStudio || '').trim();
    var vType  = (item.voiceType  || '').trim();
    var vKey   = studio + '|' + vType;
    if (!voicesBySeason[s][vKey]) {
      voicesBySeason[s][vKey] = {
        id: Object.keys(voicesBySeason[s]).length,
        name: studio ? (vType + ' | ' + studio) : vType,
        studio: studio,
        type: vType
      };
    }
  }

  var seasons = Object.keys(seasonsMap).map(Number).sort(function (a, b) { return a - b; })
    .map(function (n) { return seasonsMap[n]; });

  var result = {
    items: plData.items,
    isSerial: plData.isSerial,
    seasons: seasons,
    voicesBySeason: voicesBySeason,
    referer: referer
  };

  cache.set(cacheKey, result, 1800);
  return result;
}

/**
 * Fetch the raw playlist JSON from cdnvideohub API.
 */
function fetchPlaylist(titleId, host, referer) {
  var cacheKey = 'playlist:' + titleId;
  var cached   = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  var r = httpGet(PLAPI + '/api/v1/player/sv/playlist?pub=25&aggr=kp&id=' + titleId, referer);
  if (!r.ok) return null;

  try {
    var data = JSON.parse(r.body || '{}');
    cache.set(cacheKey, data, 300);
    return data;
  } catch (e) {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
//  MOVIE
// ═══════════════════════════════════════════════════════════════

/**
 * For movies: each voice translation becomes a playable item.
 */
function buildMovieResult(items, host, referer, inv) {
  var voices = [];
  for (var i = 0; i < items.length; i++) {
    var videoInfo = getVideoInfo(items[i].vkId, host, referer);
    if (videoInfo && videoInfo.url) {
      voices.push(makePlayResult(videoInfo, inv, items[i].voiceType + ' | ' + items[i].voiceStudio));
    }
  }
  return { type: 'movie', data: voices };
}

// ═══════════════════════════════════════════════════════════════
//  STREAM HELPERS
// ═══════════════════════════════════════════════════════════════

/**
 * Fetch video stream info (MP4 qualities or HLS) for a given vkId.
 */
function getVideoInfo(vkId, host, referer) {
  var cacheKey = 'video:' + vkId;
  var cached   = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  var r = httpGet(PLAPI + '/api/v1/player/sv/video/' + vkId, referer);
  if (!r.ok) return null;

  try {
    var data   = JSON.parse(r.body || '{}');
    var src    = data.sources || {};
    var result = null;

    var mp4Url = src.mpegFullHdUrl || src.mpegHighUrl || src.mpegQhdUrl || src.mpegMediumUrl || src.mpegLowUrl || '';
    if (mp4Url) {
      result = { url: mp4Url, quality: {} };
      if (src.mpegFullHdUrl) result.quality['1080p'] = src.mpegFullHdUrl;
      if (src.mpegHighUrl)   result.quality['720p']  = src.mpegHighUrl;
      if (src.mpegMediumUrl) result.quality['480p']  = src.mpegMediumUrl;
      if (src.mpegLowUrl)    result.quality['360p']  = src.mpegLowUrl;
    } else if (src.hlsUrl) {
      result = { url: src.hlsUrl };
    }

    cache.set(cacheKey, result, 300);
    return result;
  } catch (e) {
    return null;
  }
}

/**
 * Build a standard { method: 'play', url, stream, title, quality } response.
 * Applies proxy wrapper if proxyStreams is enabled in config.
 */
function makePlayResult(videoInfo, inv, title) {
  var proxied = cfg(inv, 'proxyStreams')
    ? proxy.urlWithHeaders(videoInfo.url, 'zonafilm', {
        'User-Agent': 'LampacProxy/1.0',
        'Referer': 'https://zonafilm.tv/',
        'Accept': '*/*'
      })
    : videoInfo.url;

  var quality = {};
  if (videoInfo.quality) {
    for (var qk in videoInfo.quality) {
      if (videoInfo.quality.hasOwnProperty(qk)) {
        quality[qk] = cfg(inv, 'proxyStreams')
          ? proxy.urlWithHeaders(videoInfo.quality[qk], 'zonafilm', {
              'User-Agent': 'LampacProxy/1.0',
              'Referer': 'https://zonafilm.tv/',
              'Accept': '*/*'
            })
          : videoInfo.quality[qk];
      }
    }
  }

  return { method: 'play', url: proxied, stream: proxied, title: title || '', quality: quality };
}

// ═══════════════════════════════════════════════════════════════
//  PLAY (single episode / movie playback)
// ═══════════════════════════════════════════════════════════════

/**
 * Direct play endpoint: resolve vkId -> stream URL.
 */
function playStream(inv, host) {
  var vkId  = inv.query.ep;
  var title = inv.query.title || '';
  if (!vkId) return { rch: false };

  var videoInfo = getVideoInfo(vkId, host, host + '/');
  if (!videoInfo || !videoInfo.url) return { rch: false };

  return makePlayResult(videoInfo, inv, title);
}
