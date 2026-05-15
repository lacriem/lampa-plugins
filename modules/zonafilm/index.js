var TMDB_KEY = '8c5a232a2a570dfa780613fb54ea9c34';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function cfg(inv, k) {
  var v = inv.config && inv.config[k];
  return (v === undefined || v === null || v === '') ? manifest.config_schema.reduce(function(a, s) { return s.key === k ? s.default : a; }, '') : v;
}

function apiGet(inv, path) {
  var p = path || '';
  if (p.length > 0 && p.indexOf('/') !== 0) p = '/' + p;
  var base = cfg(inv, 'host').replace(/\/+$/, '');
  var url = base + p;
  var res = http.get(url, {
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
      'Referer': base + '/'
    },
    userAgent: UA
  });
  if (!res.ok) {
    console.warn('zonafilm: GET', path, 'status', res.status);
    return null;
  }
  return res.text;
}

function getMeta(html, key) {
  var k = key.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
  var re1 = new RegExp('<meta[^>]+(?:property|name)=["\']' + k + '["\'][^>]*content=["\']([^"\']*)["\']', 'i');
  var m = html.match(re1);
  if (m) return m[1];
  var re2 = new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]+(?:property|name)=["\']' + k + '["\']', 'i');
  m = html.match(re2);
  return m ? m[1] : '';
}

function getOgVideo(html) { return getMeta(html, 'og:video'); }
function getPoster(html) {
  var p = getMeta(html, 'ya:ovs:poster');
  return p || getMeta(html, 'og:image') || '';
}
function getRating(html) {
  var r = getMeta(html, 'ya:ovs:rating');
  return r ? parseFloat(r) : 0;
}
function getTitle(html) {
  var m = html.match(/<h1>([^<]*)<\/h1>/);
  if (m) return m[1].trim();
  return getMeta(html, 'og:title') || getMeta(html, 'twitter:title') || '';
}
function getDescription(html) { return getMeta(html, 'description'); }
function isSerial(html) { return html.indexOf('full_series') !== -1; }

function toRelative(url) {
  if (url.indexOf('http') === 0) return '/' + url.split('/').slice(3).join('/');
  return url;
}

function parseSearchResults(html) {
  var results = [];
  var parts = html.split('<a href="');
  for (var i = 1; i < parts.length; i++) {
    var part = parts[i];
    if (part.indexOf('section__carousel-item') === -1) continue;

    var hrefEnd = part.indexOf('"');
    var href = part.substring(0, hrefEnd);

    var titleMatch = part.match(/title="([^"]*)"/);
    var itemTitle = titleMatch ? titleMatch[1] : '';

    var yearMatch = part.match(/<span>(\d{4})<\/span>/);
    var year = yearMatch ? parseInt(yearMatch[1], 10) : 0;

    var ratingMatch = part.match(/rating-[a-z]+["][^>]*>([^<]*)/);
    var rating = ratingMatch ? parseFloat(ratingMatch[1]) : 0;

    var posterMatch = part.match(/data-src="([^"]*)"/);
    var poster = posterMatch ? posterMatch[1] : '';

    results.push({
      id: toRelative(href),
      title: itemTitle,
      url: toRelative(href),
      poster: poster,
      rating: rating,
      year: year
    });
  }
  return results;
}

function search(inv, query) {
  if (!query) return [];
  var key = 'search:' + query.toLowerCase();
  var cached = cache.get(key);
  if (cached !== undefined) return cached;

  var html = apiGet(inv, '/index.php?do=search&subaction=search&story=' + util.urlencode(query));
  if (!html) { console.log('zonafilm: search empty response for', query); return []; }
  var results = parseSearchResults(html);
  console.log('zonafilm: search for "' + query + '" found ' + results.length + ' results');
  if (results.length === 0) console.log('zonafilm: search HTML sample:', html.substring(0, 300));
  cache.set(key, results, 300);
  return results;
}

function searchAllQueries(inv) {
  var tried = {};
  var queries = [
    (inv.query.title || '').trim(),
    (inv.query.original_title || '').trim()
  ];
  if (inv.query.imdb_id) queries.push(inv.query.imdb_id);
  if (inv.query.kinopoisk_id) queries.push(inv.query.kinopoisk_id);

  var byYear = {};
  var year = parseInt(inv.query.year || 0, 10);
  var best = [];

  for (var i = 0; i < queries.length; i++) {
    var q = queries[i];
    if (!q || tried[q.toLowerCase()]) continue;
    tried[q.toLowerCase()] = true;

    var r = search(inv, q);
    if (!r || !r.length) continue;

    console.log('zonafilm: searchAll "' + q + '" ' + r.length + ' results');

    if (year) {
      for (var j = 0; j < r.length; j++) {
        if (r[j].year === year) {
          var key = r[j].title.toLowerCase();
          if (!byYear[key]) byYear[key] = r[j];
        }
      }
    }
    if (!best.length || r.length < best.length) best = r;
  }

  var byYearArr = [];
  for (var tk in byYear) {
    if (byYear.hasOwnProperty(tk)) byYearArr.push(byYear[tk]);
  }
  if (byYearArr.length) {
    console.log('zonafilm: searchAll found ' + byYearArr.length + ' year-matched results');
    return byYearArr;
  }

  console.log('zonafilm: searchAll returning best=' + best.length + ' results');
  return best;
}

function strictMatch(results, inv) {
  if (!results.length) return false;
  var imdb = (inv.query.imdb_id || '').trim();
  var kpid = (inv.query.kinopoisk_id || '').trim();
  var year = parseInt(inv.query.year || 0, 10);
  var title = (inv.query.original_title || inv.query.title || '').trim().toLowerCase();
  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    if (imdb && r.imdb_id) {
      if (r.imdb_id === imdb) return true;
    }
    if (kpid && r.tmdb_id) {
      if (String(r.tmdb_id) === kpid) return true;
    }
    if (year && r.year === year) return true;
    if (title && r.title.toLowerCase().indexOf(title) !== -1) return true;
    if (title && title.indexOf(r.title.toLowerCase()) !== -1) return true;
  }
  return false;
}

function parseSeasons(html) {
  var seasons = [];
  var re = /<a[^>]*href="([^"]*)"[^>]*class="[^"]*season-link[^"]*"[^>]*data-season="(\d+)"[^>]*>/g;
  var m;
  while ((m = re.exec(html)) !== null) {
    seasons.push({ number: parseInt(m[2], 10), url: toRelative(m[1]) });
  }
  if (!seasons.length) {
    seasons.push({ number: 1, url: '' });
  }
  seasons.sort(function(a, b) { return a.number - b.number; });
  return seasons;
}

function parseEpisodes(html, seasonNum) {
  var episodes = [];
  var blocks = html.split('<div class="season-block"');
  for (var b = 1; b < blocks.length; b++) {
    var block = blocks[b];
    var dsMatch = block.match(/data-season="(\d+)"/);
    if (!dsMatch || parseInt(dsMatch[1], 10) !== seasonNum) continue;

    var epRe = /<a[^>]*class="full_series__item"[^>]*href="([^"]*)"[^>]*>[\s\S]*?data-src="([^"]*)"[\s\S]*?alt="([^"]*)"/g;
    var em;
    while ((em = epRe.exec(block)) !== null) {
      var epNumMatch = em[1].match(/\/(\d+)-episode\.html/);
      episodes.push({
        number: epNumMatch ? parseInt(epNumMatch[1], 10) : 0,
        url: toRelative(em[1]),
        title: em[3],
        poster: em[2]
      });
    }
    break;
  }
  return episodes;
}

function getStreamUrl(inv, pagePath) {
  var html = apiGet(inv, pagePath);
  if (!html) return null;

  var ogVideo = getOgVideo(html);
  if (ogVideo) return ogVideo;

  var iframeMatch = html.match(/<iframe[^>]*src="([^"]*)"[^>]*>/);
  return iframeMatch ? iframeMatch[1] : null;
}

function maybeProxy(inv, url) {
  if (!url) return '';
  return proxy.url(url, manifest.id);
}

function resolveByImdb(inv, imdbId) {
  if (!imdbId) return null;
  var key = 'tmdb_imdb_' + imdbId;
  var cached = cache.get(key);
  if (cached !== undefined) return cached;

  var url = 'https://api.themoviedb.org/3/find/' + encodeURIComponent(String(imdbId)) + '?api_key=' + TMDB_KEY + '&external_source=imdb_id';
  var res = http.get(url, { userAgent: UA });
  if (!res.ok) {
    console.warn('zonafilm: tmdb find by imdb', imdbId, 'status', res.status);
    cache.set(key, null, 1800);
    return null;
  }
  var data = res.json();
  var tvResults = data && data.tv_results;
  if (tvResults && tvResults.length > 0) {
    var tmdbId = tvResults[0].id;
    cache.set(key, tmdbId, 86400);
    return tmdbId;
  }
  cache.set(key, null, 86400);
  return null;
}

function getTmdbEpisodes(inv, tmdbId, seasonNum) {
  if (!tmdbId) return null;
  var key = 'tmdb_s' + tmdbId + '_' + seasonNum;
  var cached = cache.get(key);
  if (cached !== undefined) return cached;

  var url = 'https://api.themoviedb.org/3/tv/' + encodeURIComponent(String(tmdbId)) + '/season/' + seasonNum + '?api_key=' + TMDB_KEY + '&language=ru-RU';
  var res = http.get(url, { userAgent: UA });
  if (!res.ok) {
    console.warn('zonafilm: tmdb season', tmdbId, seasonNum, 'status', res.status);
    cache.set(key, null, 1800);
    return null;
  }
  var data = res.json();
  var episodes = data && data.episodes;
  if (!episodes) {
    cache.set(key, null, 1800);
    return null;
  }
  var result = {};
  for (var i = 0; i < episodes.length; i++) {
    var ep = episodes[i];
    result[ep.episode_number] = ep.name || '';
  }
  cache.set(key, result, 3600);
  return result;
}

function buildUrl(inv, path, params) {
  var base = inv.host + '/lite/' + manifest.id + (path || '');
  var parts = [];
  for (var k in params) {
    if (params.hasOwnProperty(k) && params[k] !== undefined && params[k] !== null && params[k] !== '') {
      parts.push(util.urlencode(k) + '=' + util.urlencode(String(params[k])));
    }
  }
  return parts.length ? base + '?' + parts.join('&') : base;
}

function handle(inv) {
  console.log('zonafilm: handle', JSON.stringify(inv.query), 'path=' + (inv.path || ''));

  if (inv.checksearch) {
    var r = searchAllQueries(inv);
    return strictMatch(r, inv)
      ? { rch: true, type: 'movie', quality: manifest.quality || 'FHD' }
      : { rch: false };
  }

  var title = (inv.query.title || inv.query.original_title || '').trim();
  var id = (inv.query.id || '').trim();

  if (inv.path === '/play') {
    var epUrl = inv.query.ep_url || '';
    if (!epUrl) return { rch: false };

    var streamUrl = getStreamUrl(inv, epUrl);
    if (!streamUrl) return { rch: false };

    var proxied = maybeProxy(inv, streamUrl);
    return {
      method: 'play',
      url: proxied,
      stream: proxied,
      title: inv.query.title || title
    };
  }

  if (id && /^\d+$/.test(id)) id = '';

  if (!id) {
    var results = searchAllQueries(inv);
    if (!results || !results.length) return { type: 'movie', data: [] };

    console.log('zonafilm: drill check ' + results.length + ' results, titles: ' + results.map(function(x){return x.title+'('+x.year+')'}).join(', '));
    var matched = null;

    if (results.length === 1) {
      matched = results[0];
      console.log('zonafilm: auto-drill single match: ' + matched.id);
    } else {
      var imdb = (inv.query.imdb_id || '').trim();
      var kpid = (inv.query.kinopoisk_id || '').trim();
      var year = parseInt(inv.query.year || 0, 10);
      var queries = [
        (inv.query.title || '').trim().toLowerCase(),
        (inv.query.original_title || '').trim().toLowerCase()
      ];

      for (var k = 0; k < results.length; k++) {
        var rk = results[k];
        if (imdb && rk.imdb_id === imdb) { matched = rk; console.log('zonafilm: matched by imdb'); break; }
        if (kpid && String(rk.tmdb_id || '') === kpid) { matched = rk; console.log('zonafilm: matched by tmdb'); break; }
        if (year && rk.year === year) {
          var rkTitle = rk.title.toLowerCase();
          for (var qi = 0; qi < queries.length; qi++) {
            var q = queries[qi];
            if (!q) continue;
            if (rkTitle.indexOf(q) !== -1 || q.indexOf(rkTitle) !== -1) {
              matched = rk; console.log('zonafilm: matched by year+title(q=' + q + ')'); break;
            }
          }
          if (matched) break;
        }
      }
    }

    if (matched) {
      id = matched.id;
      title = title || matched.title;
      console.log('zonafilm: drilling to id=' + id);
    } else {
      return {
        type: 'similar',
        data: results.map(function(r) {
          return {
            title: r.title + (r.year ? ' (' + r.year + ')' : ''),
            poster: r.poster,
            url: buildUrl(inv, '', { id: r.id, title: title || r.title })
          };
        })
      };
    }
  }

  var pageHtml = apiGet(inv, id);
  if (!pageHtml) return { type: 'movie', data: [] };

  var detailTitle = getTitle(pageHtml) || title;
  var poster = getPoster(pageHtml);
  var desc = getDescription(pageHtml);

  if (isSerial(pageHtml)) {
    var s = (inv.query.s === '' || inv.query.s === undefined) ? -1 : parseInt(inv.query.s, 10);
    var t = (inv.query.t === '' || inv.query.t === undefined) ? 0 : parseInt(inv.query.t, 10);

    var seasons = parseSeasons(pageHtml);
    var kpid = inv.query.kinopoisk_id || '';

    if (s === -1 && seasons.length > 1) {
      return {
        type: 'season',
        data: seasons.map(function(se) {
          return {
            method: 'link',
            id: se.number,
            url: buildUrl(inv, '', { id: id, title: detailTitle, s: se.number, kinopoisk_id: kpid || undefined }),
            name: se.number + ' сезон'
          };
        })
      };
    }
    if (s === -1) s = (seasons[0] && seasons[0].number) || 1;

    var episodes = parseEpisodes(pageHtml, s);
    var resolvedTmdbId = resolveByImdb(inv, inv.query.imdb_id);
    if (!resolvedTmdbId && kpid) resolvedTmdbId = kpid;
    if (resolvedTmdbId) console.log('zonafilm: resolved tmdb id=' + resolvedTmdbId);
    var tmdbTitles = getTmdbEpisodes(inv, resolvedTmdbId, s);
    if (tmdbTitles) console.log('zonafilm: tmdb loaded ' + Object.keys(tmdbTitles).length + ' titles');

    return {
      type: 'episode',
      data: episodes.map(function(ep) {
        var epPoster = ep.poster;
        var base = cfg(inv, 'host').replace(/\/+$/, '');
        if (epPoster && epPoster.indexOf('http') !== 0) epPoster = base + epPoster;
        var epTitle = (tmdbTitles && tmdbTitles[ep.number]) || ep.title || (ep.number + ' серия');
        return {
          method: 'call',
          url: buildUrl(inv, '/play', { ep_url: ep.url, title: detailTitle + ' — ' + epTitle }),
          name: epTitle,
          title: epTitle,
          poster: epPoster || poster,
          s: s,
          e: ep.number
        };
      }),
      voice: [
        {
          name: 'Оригинал', active: t === 0,
          url: buildUrl(inv, '', { id: id, title: detailTitle, s: s, t: 0 })
        }
      ]
    };
  }

  var ogVideo = getOgVideo(pageHtml);
  var iframeMatch = pageHtml.match(/<iframe[^>]*src="([^"]*)"[^>]*>/);
  var streamUrl = ogVideo || (iframeMatch ? iframeMatch[1] : null);
  if (!streamUrl) return { type: 'movie', data: [] };

  var proxied = maybeProxy(inv, streamUrl);
  return {
    type: 'movie',
    data: [{
      method: 'play',
      url: proxied,
      stream: proxied,
      name: 'Смотреть',
      title: detailTitle,
      poster: poster,
      description: desc,
      quality: { 'FHD': proxied, 'HD': proxied, 'SD': proxied }
    }]
  };
}
