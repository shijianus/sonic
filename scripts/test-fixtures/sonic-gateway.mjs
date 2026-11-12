import { createDecipheriv } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';

const sharedTitle = '海阔天空';
const sharedArtist = 'Beyond';
const timedOutQuery = '周杰伦';
const lyric = '[00:01.00]A local verse begins\n[00:03.00]A second fixture line';
const playlistTracks = Array.from({ length: 15 }, (_, index) => ({ id: 200 + index, name: `Fixture track ${index + 1}` }));
const playlists = Array.from({ length: 5 }, (_, index) => ({ id: 100 + index, name: `Fixture playlist ${index + 1}` }));

function neteaseSearch(params, signal) {
  if (params.type === 1) {
    if (params.s === timedOutQuery) return waitForTimeout(signal);
    const title = [sharedTitle, '起风了'].find(value => value === params.s);
    const songs = title ? [{ id: 301, name: title, ar: [{ name: sharedArtist }], dt: 240000 }] : [];
    return Response.json({ code: 200, result: { songs } });
  }
  if (params.type === 1000 && ['热歌', 'Fixture related playlist'].includes(params.s)) {
    return Response.json({ code: 200, result: { playlists } });
  }
  if (params.type === 100 && params.s === '周杰伦') {
    return Response.json({ code: 200, result: { artists: [{ id: 401, name: '周杰伦' }] } });
  }
  if (params.type === 10 && params.s === '范特西') {
    return Response.json({ code: 200, result: { albums: [{ id: 501, name: '范特西' }] } });
  }
}

function neteaseLinuxFixture(init) {
  // Use Node crypto independently of the gateway's pure-TS encoder to check
  // the actual encrypted request and its parameters.
  const eparams = new URLSearchParams(init.body).get('eparams');
  const decipher = createDecipheriv('aes-128-ecb', 'rFgB&h#%2?^eDg:Q', null);
  const { method, url, params } = JSON.parse(decipher.update(eparams, 'hex', 'utf8') + decipher.final('utf8'));
  const target = new URL(url);
  if (method !== 'POST' || target.hostname !== 'music.163.com') return;
  switch (target.pathname) {
    case '/api/cloudsearch/pc':
      return neteaseSearch(params, init.signal);
    case '/api/playlist/highquality/list':
      if (params.limit === 5) return Response.json({ playlists, total: 5, more: false });
      break;
    case '/api/v3/playlist/detail': {
      if (params.id === '3778678') return Response.json({ code: 200, playlist: { id: 3778678, name: 'Fixture related playlist' } });
      if (params.id === '100') return Response.json({ code: 200, playlist: { ...playlists[0], tracks: playlistTracks } });
      break;
    }
    case '/api/v1/artist/list':
      if (params.initial === 90 && params.type === 1 && params.area === 7) {
        return Response.json({ artists: [{ id: 601, name: 'Z Fixture Artist' }] });
      }
      if (params.initial === 0 && params.type === -1 && params.area === -1) {
        return Response.json({ artists: [{ id: 602, name: '# Fixture Artist' }] });
      }
      break;
  }
}

async function waitForTimeout(signal) {
  try {
    await setTimeout(2000, undefined, { signal });
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  }
  throw new Error('Provider request was not aborted by the gateway budget');
}

function qqDesktopFixture(init) {
  const { req } = JSON.parse(init.body);
  if (req.method !== 'DoSearchForQQMusicDesktop') return;
  const { query } = req.param;
  const songs = [sharedTitle, '晴天', '起风了'].includes(query)
    ? [{ mid: 'fixtureQQ1', name: query, singer: [{ name: sharedArtist }], interval: 240 }]
    : [];
  return Response.json({ req: { data: { body: { song: { list: songs } } } } });
}

export function respondToSonicGatewayProvider(url, init) {
  const method = init.method ?? 'GET';
  const route = `${method} ${url.origin}${url.pathname}`;
  const query = url.searchParams;
  switch (route) {
    case 'POST https://music.163.com/api/linux/forward':
      return neteaseLinuxFixture(init);
    case 'GET https://music.163.com/api/song/lyric/v1':
      return query.get('id') === '1293886117' ? Response.json({ lrc: { lyric } }) : undefined;
    case 'GET https://music.163.com/api/v1/resource/comments/A_PL_0_3778678':
      return Response.json({ code: 200, total: 1, comments: [{ commentId: 701, content: 'Fixture comment' }] });
    case 'GET https://api.amll.dev/v1/lyrics/get':
    case 'GET https://api.amll.dev/v1/lyrics/search':
      return new Response(null, { status: 404 });
    case 'GET https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp':
      if (query.get('w') === timedOutQuery) return waitForTimeout(init.signal);
      // Empty H5 response deliberately exercises the desktop search fallback.
      return Response.json({ data: { song: { list: [] } } });
    case 'GET https://c.y.qq.com/soso/fcgi-bin/client_search_cp':
      return Response.json({ data: { song: { list: [] } } });
    case 'POST https://u.y.qq.com/cgi-bin/musicu.fcg':
      return qqDesktopFixture(init);
    case 'GET https://mobilecdn.kugou.com/api/v3/search/song': {
      const keyword = query.get('keyword');
      if (keyword === timedOutQuery) return waitForTimeout(init.signal);
      const info = [sharedTitle, '起风了'].includes(keyword)
        ? [{ hash: 'fixtureKugou1', songname: keyword, singername: sharedArtist, duration: 240 }]
        : [];
      return Response.json({ data: { info } });
    }
    case 'GET https://songsearch.kugou.com/song_search_v2':
      return Response.json({ data: { lists: [] } });
    case 'GET https://lyrics.kugou.com/search':
      return Response.json({ candidates: [] });
    case 'GET http://search.kuwo.cn/r.s': {
      const abslist = query.get('all') === sharedTitle
        ? [{ MUSICRID: 'MUSIC_801', SONGNAME: sharedTitle, ARTIST: sharedArtist, DURATION: '240' }]
        : [];
      return Response.json({ abslist });
    }
    case 'GET https://lrclib.net/api/get':
      return query.get('track_name') === 'Shape of You' && query.get('artist_name') === 'Ed Sheeran'
        ? Response.json({ id: 901, trackName: 'Shape of You', artistName: 'Ed Sheeran', syncedLyrics: lyric })
        : new Response(null, { status: 404 });
  }
}
