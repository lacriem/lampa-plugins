function handle(inv) {
  var host = (inv.config && inv.config.host) || 'https://zonafilm.tv';
  var plapi = 'https://plapi.cdnvideohub.com';

  if (inv.checksearch) {
    var results = searchAllQueries(inv, host);
    return strictMatch(results, inv) ? { rch: true, type: 'movie', quality: 'FHD' } : { rch: false };
  }

  var id = (inv.query.id || '').trim();
  if (!id) {
    var results = searchAllQueries(inv, host);
    if (!results.length) return { type: 'similar', data: [] };
    if (results.length === 1) return detail(results[0].url, host, plapi, inv);
    return { type: 'similar', data: results };
  }

  return detail(id, host, plapi, inv);
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

  var url = host + '/?do=search&subaction=search&story=' + encodeURIComponent(q);
  var r = http.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
  var html = r.body || '';
  var results = [];
  var re = /<a href="https:\/\/zonafilm\.tv(\/\d+-[^"]+\.html)"[^>]*title="([^"]+)"[^>]*class="section__carousel-item"/g;
  var m;
  while ((m = re.exec(html)) !== null) {
    var path = m[1];
    var title = m[2];
    var snippet = html.substring(m.index, m.index + 400);
    var yearMatch = snippet.match(/<span>(\d{4})<\/span>/);
    var year = yearMatch ? parseInt(yearMatch[1], 10) : 0;
    results.push({ title: title, url: path, year: year });
  }

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

function detail(id, host, plapi, inv) {
  var seasonMatch = id.match(/\|s=(\d+)$/);
  var episodeMatch = id.match(/\|s=(\d+)\|e=(\d+)$/);

  if (episodeMatch) {
    return episodeDetail(id, episodeMatch[1], episodeMatch[2], host, plapi);
  }
  if (seasonMatch) {
    return seasonDetail(id, seasonMatch[1], host, plapi);
  }

  var url = id.indexOf('http') === 0 ? id : host + id;
  var r = http.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
  var html = r.body || '';

  var vpMatch = html.match(/data-title-id="(\d+)"/);
  var isSerialPage = html.match(/class="[^"]*season-link[^"]*"/);

  if (!vpMatch && isSerialPage) {
    var firstEpMatch = html.match(/href="https:\/\/zonafilm\.tv(\/[^"]+\/\d+-season\/\d+-episode\.html)"/);
    if (firstEpMatch) {
      var epUrl = host + firstEpMatch[1];
      var epR = http.get(epUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Referer': url } });
      var epHtml = epR.body || '';
      vpMatch = epHtml.match(/data-title-id="(\d+)"/);
    }
  }

  if (!vpMatch) return { type: 'movie', data: [] };

  var titleId = vpMatch[1];
  var cacheKey = 'titleid:' + id;
  cache.set(cacheKey, titleId, 600);

  var plCacheKey = 'playlist:' + titleId;
  var plData = cache.get(plCacheKey);
  if (!plData) {
    var playlistUrl = plapi + '/api/v1/player/sv/playlist?pub=25&aggr=kp&id=' + titleId;
    var plR = http.get(playlistUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Referer': url } });
    plData = JSON.parse(plR.body || '{}');
    cache.set(plCacheKey, plData, 300);
  }

  if (!plData.items || !plData.items.length) return { type: 'movie', data: [] };

  if (!plData.isSerial) {
    return buildMovieResult(plData.items, plapi, url);
  }

  return buildSerialResult(id, plData.items);
}

function buildMovieResult(items, plapi, referer) {
  var voices = [];
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var videoInfo = getVideoInfo(item.vkId, plapi, referer);
    if (videoInfo && videoInfo.url) {
      voices.push({
        title: item.voiceStudio + ' (' + item.voiceType + ')',
        url: videoInfo.url
      });
    }
  }
  return { type: 'movie', data: voices };
}

function getVideoInfo(vkId, plapi, referer) {
  var cacheKey = 'video:' + vkId;
  var cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  var videoUrl = plapi + '/api/v1/player/sv/video/' + vkId;
  var r = http.get(videoUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Referer': referer } });
  var data = JSON.parse(r.body || '{}');
  var result = null;
  if (data.sources && data.sources.hlsUrl) {
    result = { url: proxy.url(data.sources.hlsUrl, 'zonafilm') };
  }
  cache.set(cacheKey, result, 300);
  return result;
}

function buildSerialResult(baseId, items) {
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
      title: 'Сезон ' + sNum,
      id: baseId + '|s=' + sNum,
      url: ''
    });
  }

  return { type: 'season', data: seasons };
}

function seasonDetail(id, seasonNum, host, plapi) {
  var baseId = id.replace(/\|s=\d+$/, '');
  var titleId = cache.get('titleid:' + baseId);

  if (!titleId) {
    return detail(baseId, host, plapi, {});
  }

  var plData = cache.get('playlist:' + titleId);
  if (!plData) {
    var playlistUrl = plapi + '/api/v1/player/sv/playlist?pub=25&aggr=kp&id=' + titleId;
    var plR = http.get(playlistUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Referer': host + baseId } });
    plData = JSON.parse(plR.body || '{}');
    cache.set('playlist:' + titleId, plData, 300);
  }

  if (!plData.items) return { type: 'episode', data: [] };

  var episodesMap = {};
  for (var i = 0; i < plData.items.length; i++) {
    var item = plData.items[i];
    if (String(item.season) === seasonNum) {
      var e = item.episode || 1;
      if (!episodesMap[e]) episodesMap[e] = true;
    }
  }

  var epNums = Object.keys(episodesMap).map(Number).sort(function(a, b) { return a - b; });
  var episodes = [];
  for (var i = 0; i < epNums.length; i++) {
    var eNum = epNums[i];
    episodes.push({
      title: 'Серия ' + eNum,
      id: baseId + '|s=' + seasonNum + '|e=' + eNum,
      url: ''
    });
  }

  return { type: 'episode', data: episodes };
}

function episodeDetail(id, seasonNum, episodeNum, host, plapi) {
  var baseId = id.replace(/\|s=\d+\|e=\d+$/, '');
  var titleId = cache.get('titleid:' + baseId);

  if (!titleId) {
    return detail(baseId, host, plapi, {});
  }

  var plData = cache.get('playlist:' + titleId);
  if (!plData) {
    var playlistUrl = plapi + '/api/v1/player/sv/playlist?pub=25&aggr=kp&id=' + titleId;
    var plR = http.get(playlistUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Referer': host + baseId } });
    plData = JSON.parse(plR.body || '{}');
    cache.set('playlist:' + titleId, plData, 300);
  }

  if (!plData.items) return { type: 'movie', data: [] };

  var voices = [];
  for (var i = 0; i < plData.items.length; i++) {
    var item = plData.items[i];
    if (String(item.season) === seasonNum && String(item.episode) === episodeNum) {
      var videoInfo = getVideoInfo(item.vkId, plapi, host + baseId);
      if (videoInfo && videoInfo.url) {
        voices.push({
          title: item.voiceStudio + ' (' + item.voiceType + ')',
          url: videoInfo.url
        });
      }
    }
  }

  return { type: 'movie', data: voices };
}
