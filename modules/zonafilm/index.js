// ZonaFilm module for Alcopac/Lampa
// Parses zonafilm.tv via cdnvideohub API

var DEFAULTS = { host: 'https://zonafilm.tv' };
var PLAPI = 'https://plapi.cdnvideohub.com';

function cfg(inv, k) {
  var v = inv.config && inv.config[k];
  return (v === undefined || v === null || v === '') ? DEFAULTS[k] : v;
}

function handle(inv) {
  var host = cfg(inv, 'host');
  var title = (inv.query.title || inv.query.original_title || '').trim();

  console.log('zonafilm: handle called, query=' + JSON.stringify(inv.query) + ' path=' + inv.path);

  if (inv.checksearch) {
    console.log('zonafilm: checksearch mode');
    var r = searchAllQueries(inv, host);
    console.log('zonafilm: checksearch results count=' + r.length);
    var matched = strictMatch(r, inv);
    console.log('zonafilm: checksearch strictMatch=' + matched);
    if (matched && r.length) {
      var best = r[0];
      var year = parseInt(inv.query.year || 0, 10);
      for (var i = 0; i < r.length; i++) {
        if (year && r[i].year === year) { best = r[i]; break; }
      }
      var extId = inv.query.id || inv.query.imdb_id || inv.query.kinopoisk_id || '';
      if (extId) {
        cache.set('idmap:' + extId, best.url, 600);
        console.log('zonafilm: cached idmap ' + extId + ' -> ' + best.url);
      }
    }
    return matched ? { rch: true, type: 'movie', quality: 'FHD' } : { rch: false };
  }

  if (inv.path === '/play') {
    console.log('zonafilm: play mode');
    return playStream(inv, host);
  }

  var rawId = decodeURIComponent((inv.query.id || '').trim());
  var seasonNum = inv.query.s;
  var episodeNum = inv.query.e;

  // Try to resolve external ID (tmdb/kinopoisk) to zonafilm URL
  var id = rawId;
  if (rawId && rawId.indexOf('.html') === -1 && rawId.indexOf('/') !== 0) {
    var mapped = cache.get('idmap:' + rawId);
    if (mapped) {
      console.log('zonafilm: resolved external id ' + rawId + ' -> ' + mapped);
      id = mapped;
    } else {
      console.log('zonafilm: external id ' + rawId + ' not cached, searching by title');
      var fallback = searchAllQueries(inv, host);
      if (fallback.length) {
        var fbBest = fallback[0];
        var year = parseInt(inv.query.year || 0, 10);
        for (var i = 0; i < fallback.length; i++) {
          if (year && fallback[i].year === year) { fbBest = fallback[i]; break; }
        }
        id = fbBest.url;
        console.log('zonafilm: fallback search resolved to ' + id);
      }
    }
  }

  if (seasonNum && id.indexOf('|s=') === -1) id = id + '|s=' + seasonNum;
  if (episodeNum && id.indexOf('|e=') === -1) id = id + '|e=' + episodeNum;

  if (!id || id.indexOf('.html') === -1) {
    console.log('zonafilm: no valid id, searching for title=' + title);
    var results = searchAllQueries(inv, host);
    console.log('zonafilm: search returned ' + results.length + ' results');
    if (!results.length) return { type: 'similar', data: [] };

    if (results.length === 1 || strictMatch(results, inv)) {
      var best = results[0];
      if (strictMatch(results, inv)) {
        var year = parseInt(inv.query.year || 0, 10);
        for (var i = 0; i < results.length; i++) {
          if (year && results[i].year === year) { best = results[i]; break; }
        }
      }
      console.log('zonafilm: auto-drill to ' + best.url);
      return detail(best.url, host, inv);
    }

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

  console.log('zonafilm: detail mode, id=' + id);
  return detail(id, host, inv);
}

function searchAllQueries(inv, host) {
  var tried = {};
  var queries = [
    (inv.query.original_title || '').trim(),
    (inv.query.title || '').trim()
  ];
  for (var i = 0; i < queries.length; i++) {
    var q = queries[i];
    if (!q || tried[q.toLowerCase()]) continue;
    tried[q.toLowerCase()] = true;
    var r = search(q, host);
    if (r && r.length) return r;
  }
  return [];
}

function search(q, host) {
  var cacheKey = 'search:' + q.toLowerCase();
  var cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  var url = host + '/?do=search&subaction=search&story=' + util.urlencode(q);
  console.log('zonafilm: search GET ' + url);
  var r = http.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    }
  });
  console.log('zonafilm: search status=' + r.status + ' ok=' + r.ok);
  if (!r.ok) {
    console.warn('zonafilm: search failed, status=' + r.status);
    return [];
  }

  var html = r.body || '';
  console.log('zonafilm: search html length=' + html.length);

  var results = [];
  var re = /<a href="https:\/\/zonafilm\.tv(\/\d+-[^"]+\.html)"[^>]*title="([^"]+)"[^>]*class="section__carousel-item"/g;
  var m;
  var count = 0;
  while ((m = re.exec(html)) !== null) {
    count++;
    var path = m[1];
    var title = m[2];
    var snippet = html.substring(m.index, m.index + 400);
    var yearMatch = snippet.match(/<span>(\d{4})<\/span>/);
    var year = yearMatch ? parseInt(yearMatch[1], 10) : 0;
    results.push({ title: title, url: path, year: year });
  }
  console.log('zonafilm: parsed ' + count + ' results from html');

  cache.set(cacheKey, results, 300);
  return results;
}

function strictMatch(results, inv) {
  if (!results.length) return false;
  var year = parseInt(inv.query.year || 0, 10);
  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    if (year && r.year === year) return true;
  }
  return false;
}

function detail(id, host, inv) {
  var title = (inv.query.title || inv.query.original_title || '').trim();

  var seasonMatch = id.match(/\|s=(\d+)$/);
  var episodeMatch = id.match(/\|s=(\d+)\|e=(\d+)$/);

  if (episodeMatch) {
    return episodeDetail(id, episodeMatch[1], episodeMatch[2], host, inv);
  }
  if (seasonMatch) {
    return seasonDetail(id, seasonMatch[1], host, inv);
  }

  console.log('zonafilm: detail fetch id=' + id);
  var pageUrl = id.indexOf('http') === 0 ? id : host + id;
  var r = http.get(pageUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Referer': host + '/'
    }
  });
  console.log('zonafilm: detail status=' + r.status + ' ok=' + r.ok);
  if (!r.ok) {
    console.warn('zonafilm: detail fetch failed');
    return { type: 'movie', data: [] };
  }

  var html = r.body || '';
  console.log('zonafilm: detail html length=' + html.length);

  var vpMatch = html.match(/data-title-id="(\d+)"/);
  var isSerialPage = html.indexOf('season-link') !== -1;
  console.log('zonafilm: vpMatch=' + (vpMatch ? vpMatch[1] : null) + ' isSerial=' + isSerialPage);

  if (!vpMatch && isSerialPage) {
    console.log('zonafilm: serial page without title-id, fetching first episode');
    var firstEpMatch = html.match(/href="https:\/\/zonafilm\.tv(\/[^"]+\/\d+-season\/\d+-episode\.html)"/);
    if (firstEpMatch) {
      var epUrl = host + firstEpMatch[1];
      console.log('zonafilm: fetching episode page ' + epUrl);
      var epR = http.get(epUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Referer': pageUrl
        }
      });
      if (epR.ok) {
        var epHtml = epR.body || '';
        vpMatch = epHtml.match(/data-title-id="(\d+)"/);
        console.log('zonafilm: episode page vpMatch=' + (vpMatch ? vpMatch[1] : null));
      } else {
        console.warn('zonafilm: episode page fetch failed, status=' + epR.status);
      }
    }
  }

  if (!vpMatch) {
    console.warn('zonafilm: no data-title-id found');
    return { type: 'movie', data: [] };
  }

  var titleId = vpMatch[1];
  cache.set('titleid:' + id, titleId, 600);
  console.log('zonafilm: titleId=' + titleId);

  var plData = fetchPlaylist(titleId, host, pageUrl);
  if (!plData) {
    console.warn('zonafilm: playlist fetch failed');
    return { type: 'movie', data: [] };
  }

  if (!plData.items || !plData.items.length) {
    console.warn('zonafilm: playlist empty');
    return { type: 'movie', data: [] };
  }

  console.log('zonafilm: playlist items=' + plData.items.length + ' isSerial=' + plData.isSerial);

  if (!plData.isSerial) {
    return buildMovieResult(plData.items, host, pageUrl);
  }

  return buildSerialResult(id, plData.items, host, title);
}

function fetchPlaylist(titleId, host, referer) {
  var cacheKey = 'playlist:' + titleId;
  var cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  var playlistUrl = PLAPI + '/api/v1/player/sv/playlist?pub=25&aggr=kp&id=' + titleId;
  console.log('zonafilm: playlist GET ' + playlistUrl);
  var plR = http.get(playlistUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Referer': referer
    }
  });
  console.log('zonafilm: playlist status=' + plR.status + ' ok=' + plR.ok);
  if (!plR.ok) {
    console.warn('zonafilm: playlist failed, status=' + plR.status);
    return null;
  }

  try {
    var plData = JSON.parse(plR.body || '{}');
    cache.set(cacheKey, plData, 300);
    return plData;
  } catch (e) {
    console.warn('zonafilm: playlist JSON parse error: ' + e.message);
    return null;
  }
}

function buildMovieResult(items, host, referer) {
  var voices = [];
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    console.log('zonafilm: movie voice ' + i + ' vkId=' + item.vkId + ' studio=' + item.voiceStudio);
    var videoInfo = getVideoInfo(item.vkId, host, referer);
    if (videoInfo && videoInfo.url) {
      voices.push({
        method: 'play',
        title: item.voiceStudio + ' (' + item.voiceType + ')',
        url: videoInfo.url,
        stream: videoInfo.url
      });
    }
  }
  console.log('zonafilm: movie voices count=' + voices.length);
  return { type: 'movie', data: voices };
}

function getVideoInfo(vkId, host, referer) {
  var cacheKey = 'video:' + vkId;
  var cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  var videoUrl = PLAPI + '/api/v1/player/sv/video/' + vkId;
  console.log('zonafilm: video GET ' + videoUrl);
  var r = http.get(videoUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Referer': referer
    }
  });
  console.log('zonafilm: video status=' + r.status + ' ok=' + r.ok);
  if (!r.ok) {
    console.warn('zonafilm: video fetch failed, status=' + r.status);
    return null;
  }

  try {
    var data = JSON.parse(r.body || '{}');
    var result = null;
    if (data.sources && data.sources.hlsUrl) {
      result = { url: proxy.urlWithHeaders(data.sources.hlsUrl, { Referer: referer }) };
      console.log('zonafilm: video hls found');
    } else {
      console.warn('zonafilm: no hlsUrl in video response');
    }
    cache.set(cacheKey, result, 300);
    return result;
  } catch (e) {
    console.warn('zonafilm: video JSON parse error: ' + e.message);
    return null;
  }
}

function buildSerialResult(baseId, items, host, title) {
  var seasonsMap = {};
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var s = item.season || 1;
    if (!seasonsMap[s]) seasonsMap[s] = true;
  }

  var seasonNums = Object.keys(seasonsMap).map(Number).sort(function(a, b) { return a - b; });
  var seasons = [];
  for (var i = 0; i < seasonNums.length; i++) {
    var sNum = seasonNums[i];
    seasons.push({
      method: 'link',
      id: sNum,
      url: host + '/lite/zonafilm?id=' + util.urlencode(baseId) + '&title=' + util.urlencode(title) + '&s=' + sNum,
      name: sNum + ' сезон'
    });
  }
  console.log('zonafilm: serial seasons count=' + seasons.length);
  return { type: 'season', data: seasons };
}

function seasonDetail(id, seasonNum, host, inv) {
  var baseId = id.replace(/\|s=\d+$/, '');
  var titleId = cache.get('titleid:' + baseId);
  var title = (inv.query.title || '').trim();

  if (!titleId) {
    console.log('zonafilm: seasonDetail no cached titleId, re-fetching');
    return detail(baseId, host, inv);
  }

  var plData = fetchPlaylist(titleId, host, host + baseId);
  if (!plData || !plData.items) {
    console.warn('zonafilm: seasonDetail no playlist');
    return { type: 'episode', data: [], voice: [] };
  }

  // Group episodes and collect voices
  var episodesMap = {};
  var voicesMap = {};
  for (var i = 0; i < plData.items.length; i++) {
    var item = plData.items[i];
    if (String(item.season) === seasonNum) {
      var e = item.episode || 1;
      if (!episodesMap[e]) episodesMap[e] = [];
      episodesMap[e].push(item);

      var vKey = item.voiceStudio + '|' + item.voiceType;
      if (!voicesMap[vKey]) voicesMap[vKey] = { name: item.voiceStudio + ' (' + item.voiceType + ')', idx: Object.keys(voicesMap).length };
    }
  }

  var voiceList = [];
  for (var vk in voicesMap) {
    if (voicesMap.hasOwnProperty(vk)) {
      voiceList.push({
        name: voicesMap[vk].name,
        active: voicesMap[vk].idx === 0,
        url: host + '/lite/zonafilm?id=' + util.urlencode(baseId) + '&title=' + util.urlencode(title) + '&s=' + seasonNum + '&t=' + voicesMap[vk].idx
      });
    }
  }

  var epNums = Object.keys(episodesMap).map(Number).sort(function(a, b) { return a - b; });
  var episodes = [];
  var t = parseInt(inv.query.t || '0', 10);

  for (var i = 0; i < epNums.length; i++) {
    var eNum = epNums[i];
    var epItems = episodesMap[eNum];
    // Pick item for selected voice, or first available
    var selectedItem = epItems[0];
    if (t > 0 && t < epItems.length) selectedItem = epItems[t];

    episodes.push({
      method: 'call',
      url: host + '/lite/zonafilm/play?ep=' + selectedItem.vkId + '&s=' + seasonNum + '&e=' + eNum + '&title=' + util.urlencode(title),
      name: 'Серия ' + eNum,
      title: title + ' — Сезон ' + seasonNum + ' Серия ' + eNum,
      s: parseInt(seasonNum, 10),
      e: eNum
    });
  }

  console.log('zonafilm: seasonDetail episodes=' + episodes.length + ' voices=' + voiceList.length);
  return { type: 'episode', data: episodes, voice: voiceList };
}

function episodeDetail(id, seasonNum, episodeNum, host, inv) {
  var baseId = id.replace(/\|s=\d+\|e=\d+$/, '');
  var titleId = cache.get('titleid:' + baseId);

  if (!titleId) {
    console.log('zonafilm: episodeDetail no cached titleId, re-fetching');
    return detail(baseId, host, inv);
  }

  var plData = fetchPlaylist(titleId, host, host + baseId);
  if (!plData || !plData.items) {
    console.warn('zonafilm: episodeDetail no playlist');
    return { type: 'movie', data: [] };
  }

  var voices = [];
  for (var i = 0; i < plData.items.length; i++) {
    var item = plData.items[i];
    if (String(item.season) === seasonNum && String(item.episode) === episodeNum) {
      var videoInfo = getVideoInfo(item.vkId, host, host + baseId);
      if (videoInfo && videoInfo.url) {
        voices.push({
          method: 'play',
          title: item.voiceStudio + ' (' + item.voiceType + ')',
          url: videoInfo.url,
          stream: videoInfo.url
        });
      }
    }
  }

  console.log('zonafilm: episodeDetail voices=' + voices.length);
  return { type: 'movie', data: voices };
}

function playStream(inv, host) {
  var vkId = inv.query.ep;
  var title = inv.query.title || '';
  if (!vkId) {
    console.warn('zonafilm: playStream no ep (vkId) provided');
    return { rch: false };
  }

  var referer = host + '/';
  var videoInfo = getVideoInfo(vkId, host, referer);
  if (!videoInfo || !videoInfo.url) {
    console.warn('zonafilm: playStream no stream for vkId=' + vkId);
    return { rch: false };
  }

  console.log('zonafilm: playStream success vkId=' + vkId);
  return {
    method: 'play',
    url: videoInfo.url,
    stream: videoInfo.url,
    title: title
  };
}
