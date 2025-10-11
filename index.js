const crypto = require('crypto')
const { URL } = require('url')
const cheerio = require('cheerio')
const { Readable } = require('stream')
const vm = require('vm')
const { spawn } = require('child_process')
const os = require('os')
const path = require('path')
const fs = require('fs')

const CACHE_ROOT = path.join(os.tmpdir(), 'ap-transmux')
fs.mkdirSync(CACHE_ROOT, { recursive: true })

function mergeHeaders(h1 = {}, h2 = {}) { return { ...DEFAULT_HEADERS, ...h1, ...h2 }; }

const DEFAULT_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'accept': '*/*',
  'accept-language': 'en-US,en;q=0.9',
  'cache-control': 'no-cache',
  'pragma': 'no-cache'
};
const HOST = 'https://animepahe.si';
const API_URL = `${HOST}/api`;
const REFERER = HOST;
function genCookie() { return `__ddg2_=${crypto.randomBytes(12).toString('hex')}`; }

const readline = require('readline');
const net = require('net')

async function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
}

async function main() {
  try {
    const cookie = genCookie();
    console.log('1. Search & play an anime')
    console.log('2. View recently watched')
    const menuChoice = await prompt('Choose an option (1-2): ')
    if (menuChoice.trim() === '2') {
      let hist = readHistory()
      if (!hist.length) { console.log('No recently watched entries.'); process.exit(0) }
      // dedupe by slug: keep the latest (highest ts) entry per show
      const bySlug = {}
      for (const h of hist) {
        if (!bySlug[h.slug] || (h.ts || 0) > (bySlug[h.slug].ts || 0)) bySlug[h.slug] = h
      }
      const unique = Object.values(bySlug)
      unique.forEach((h, i) => {
        const t = new Date(h.ts).toLocaleString()
        console.log(`${i + 1}. ${h.title} — ep ${h.episode} — ${h.audio}/${h.resolution} — ${t} — pos ${Math.round(h.position || 0)}s`)
      })
      const pick = parseInt(await prompt('Select entry to resume by number (or blank to exit): '), 10)
      if (!isNaN(pick) && pick >= 1 && pick <= hist.length) {
        const entry = hist[pick - 1]
        const episodes = await getAllEpisodes(entry.slug, cookie)
        const epIdx = episodes.findIndex(e => Number(e.episode) === Number(entry.episode))
        if (epIdx === -1) { console.log('Episode not found anymore.'); process.exit(1) }
        const { audio, resolution } = entry
        await playEpisode({ slug: entry.slug, epIdx, episodes, audio, resolution, cookie, title: entry.title, startAt: entry.position || 0, autonext: false })
        process.exit(0)
      }
      process.exit(0)
    }

    const searchQuery = await prompt('What anime do you want to search for? ');
    const results = await searchAnime(searchQuery, cookie);
    if (!results || !results.data || results.data.length === 0) {
      console.log('No results found.');
      process.exit(0);
    }
    results.data.forEach((anime, idx) => {
      console.log(`${idx + 1}. ${anime.title} (ID: ${anime.session || anime.id || anime.slug})`);
    });
    let animeIdx = parseInt(await prompt('Select an anime by number: '), 10) - 1;
    if (isNaN(animeIdx) || animeIdx < 0 || animeIdx >= results.data.length) {
      console.log('Invalid selection.');
      process.exit(1);
    }
    const anime = results.data[animeIdx];
    const slug = anime.session || anime.id || anime.slug;
    const episodes = await getAllEpisodes(slug, cookie);
    if (!episodes || episodes.length === 0) {
      console.log('No episodes found.');
      process.exit(1);
    }
    episodes.forEach((ep, idx) => {
      console.log(`${idx + 1}. Episode ${ep.episode} - ${ep.title || ''}`);
    });
    let epIdx = parseInt(await prompt('Select episode number: '), 10) - 1;
    if (isNaN(epIdx) || epIdx < 0 || epIdx >= episodes.length) {
      console.log('Invalid episode selection.');
      process.exit(1);
    }
    const episodeNum = episodes[epIdx].episode;
    const playUrl = `${HOST}/play/${encodeURIComponent(slug)}/${episodes[epIdx].session}`;
    const html = await httpText(playUrl, { headers: { cookie, Referer: REFERER } });
    const $ = cheerio.load(html);
    const options = [];
    $('button[data-src]').each((_, el) => {
      const e = $(el);
      const audio = (e.attr('data-audio') || '').toLowerCase();
      const resolution = (e.attr('data-resolution') || '');
      options.push({ audio, resolution });
    });
    const uniqueOptions = Array.from(new Set(options.map(o => `${o.audio}|${o.resolution}`)))
      .map(str => { const [audio, resolution] = str.split('|'); return { audio, resolution }; });
    uniqueOptions.forEach((opt, idx) => {
      console.log(`${idx + 1}. Audio: ${opt.audio}, Resolution: ${opt.resolution}`);
    });
    let optIdx = parseInt(await prompt('Select audio/resolution by number: '), 10) - 1;
    if (isNaN(optIdx) || optIdx < 0 || optIdx >= uniqueOptions.length) {
      console.log('Invalid selection.');
      process.exit(1);
    }
    const { audio, resolution } = uniqueOptions[optIdx];
    const m3u8 = await getEpisodeM3U8({ slug, episode: episodeNum, audio, resolution, cookie });
    if (!m3u8) {
      console.error('Could not find stream URL for this episode.');
      process.exit(1);
    }
    const enableAutonext = (await prompt('Enable autonext for this play session? (y/N): ')).toLowerCase().startsWith('y')
    console.log(`Playing episode ${episodeNum} with audio: ${audio}, resolution: ${resolution}`);
    await playEpisode({ slug, epIdx, episodes, audio, resolution, cookie, title: anime.title, startAt: 0, autonext: enableAutonext })
    process.exit(0)
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

async function httpGet(url, { headers = {}, signal } = {}) {
  const res = await fetch(url, { headers: mergeHeaders(headers), redirect: 'follow', signal })
  if (!res.ok) throw new Error(`GET ${url} ${res.status}`)
  return res
}
async function httpGetRaw(url, { headers = {}, signal } = {}) { return fetch(url, { headers: mergeHeaders(headers), redirect: 'follow', signal }) }
async function httpText(url, opts) { const res = await httpGet(url, opts); return await res.text() }

async function searchAnime(q, cookie) {
  const url = `${API_URL}?m=search&q=${encodeURIComponent(q)}`
  const res = await httpGet(url, { headers: { cookie } })
  return await res.json()
}
async function getReleasePage(slug, page, cookie) {
  const url = `${API_URL}?m=release&id=${encodeURIComponent(slug)}&sort=episode_asc&page=${page}`
  const res = await httpGet(url, { headers: { cookie } })
  return await res.json()
}
async function getAllEpisodes(slug, cookie) {
  const first = await getReleasePage(slug, 1, cookie)
  let data = first.data || []
  const last = first.last_page || 1
  if (last > 1) {
    const tasks = []
    for (let p = 2; p <= last; p++) tasks.push(getReleasePage(slug, p, cookie))
    const pages = await Promise.all(tasks)
    for (const pg of pages) data = data.concat(pg.data || [])
  }
  data.sort((a, b) => Number(a.episode) - Number(b.episode))
  return data
}

function collectButtons($) {
  const seen = new Set()
  const out = []
  $('button[data-src]').each((_, el) => {
    const e = $(el)
    const audio = (e.attr('data-audio') || '').toLowerCase()
    const resolution = e.attr('data-resolution') || ''
    const av1 = e.attr('data-av1') || ''
    const src = e.attr('data-src') || ''
    const key = `${audio}|${resolution}|${av1}|${src}`
    if (src && !seen.has(key)) { seen.add(key); out.push({ audio, resolution, av1, src }) }
  })
  out.sort((a, b) => {
    const av1a = a.av1 === '0' ? 0 : 1
    const av1b = b.av1 === '0' ? 0 : 1
    if (av1a !== av1b) return av1a - av1b
    return Number(b.resolution || 0) - Number(a.resolution || 0)
  })
  return out
}
function pickButton($, pref) {
  const buttons = collectButtons($)
  if (!buttons.length) return null
  let pool = buttons
  if (pref.audio) { const f = pool.filter(x => x.audio === pref.audio.toLowerCase()); pool = f.length ? f : pool }
  if (pref.resolution) { const f = pool.filter(x => x.resolution === String(pref.resolution)); pool = f.length ? f : pool }
  return pool[0] || null
}

function extractEvalScript(html) {
  const $ = cheerio.load(html)
  const scripts = $('script').map((_, s) => $(s).html() || '').get()
  for (const sc of scripts) {
    if (!sc) continue
    if (sc.includes('eval(')) return sc
    if (sc.includes('source=') && sc.includes('.m3u8')) return sc
  }
  return ''
}
function transformEvalScript(sc) { return sc.replace(/document/g, 'process').replace(/window/g, 'globalThis').replace(/querySelector/g, 'exit').replace(/eval\(/g, 'console.log(') }
function parseSourceFromLogs(out) {
  const lines = out.split('\n')
  for (const line of lines) {
    const m = line.match(/(?:var|let|const)\s+source\s*=\s*['"]([^'"]+\.m3u8)['"]/)
    if (m) return m[1]
    const any = line.match(/https?:\/\/[^\s'"]+\.m3u8/)
    if (any) return any[0]
  }
  return ''
}

async function getEpisodeM3U8({ slug, episode, audio, resolution, cookie }) {
  const episodes = await getAllEpisodes(slug, cookie)
  const ep = episodes.find(e => Number(e.episode) === Number(episode))
  if (!ep) return ''
  const playUrl = `${HOST}/play/${encodeURIComponent(slug)}/${ep.session}`
  const html = await httpText(playUrl, { headers: { cookie, Referer: REFERER } })
  const $ = cheerio.load(html)
  const btn = pickButton($, { audio, resolution })
  if (!btn) return ''
  const kwik = btn.src
  const kwikHtml = await httpText(kwik, { headers: { cookie, Referer: REFERER } })
  const raw = extractEvalScript(kwikHtml)
  if (!raw) return ''
  const transformed = transformEvalScript(raw)
  let output = ''
  const context = { console: { log: (...a) => { output += a.join(' ') + '\n' } }, atob: (b) => Buffer.from(b, 'base64').toString('binary'), btoa: (s) => Buffer.from(s, 'binary').toString('base64'), process: {}, globalThis: {}, navigator: { userAgent: DEFAULT_HEADERS['user-agent'] } }
  try { vm.createContext(context); new vm.Script(transformed).runInContext(context, { timeout: 2000 }) } catch {}
  const m3u8 = parseSourceFromLogs(output)
  return m3u8
}

const HISTORY_PATH = path.join(os.homedir(), '.animeweb_history.json')
function readHistory() {
  try { const txt = fs.readFileSync(HISTORY_PATH, 'utf8'); return JSON.parse(txt) || [] } catch { return [] }
}
function writeHistory(arr) { try { fs.writeFileSync(HISTORY_PATH, JSON.stringify(arr, null, 2), 'utf8') } catch (e) {} }
function addHistoryEntry(entry) {
  try {
    const arr = readHistory()
    const key = `${entry.slug}::${entry.episode}`
    const filtered = arr.filter(a => `${a.slug}::${a.episode}` !== key)
    filtered.unshift({ ...entry, ts: Date.now() })
    writeHistory(filtered.slice(0, 100))
  } catch (e) {}
}

async function playEpisode({ slug, epIdx, episodes, audio, resolution, cookie, title, startAt = 0, autonext = false }) {
    let idx = epIdx
    let playedOne = false
  while (idx >= 0 && idx < episodes.length) {
    const ep = episodes[idx]
    const episodeNum = ep.episode
    const playUrl = `${HOST}/play/${encodeURIComponent(slug)}/${ep.session}`
    const html = await httpText(playUrl, { headers: { cookie, Referer: REFERER } })
    const $ = cheerio.load(html)
    const btn = pickButton($, { audio, resolution })
    if (!btn) { console.error('Could not find stream URL for this episode.'); return }
    const m3u8 = await getEpisodeM3U8({ slug, episode: episodeNum, audio: btn.audio, resolution: btn.resolution, cookie })
    if (!m3u8) { console.error('Could not find stream URL for this episode.'); return }

    if (playedOne && autonext) {
      console.log(`Autoplaying next episode (ep ${episodeNum})  with audio: ${btn.audio}, resolution: ${btn.resolution}.`)
    }

    const sockPath = path.join(os.tmpdir(), `animeweb-mpv-${process.pid}-${Date.now()}.sock`)
    const args = [m3u8, `--input-ipc-server=${sockPath}`]
    if (startAt && Number(startAt) > 0) args.push(`--start=${Number(startAt)}`)
    const mpv = spawn('mpv', args, { stdio: ['ignore','ignore','ignore'] })

    let lastPos = Number(startAt) || 0
    let reqId = 1
    let sock = null
    let closed = false

    const tryConnect = () => new Promise(res => {
      const t0 = Date.now()
      const tryOnce = () => {
        sock = new net.Socket()
        sock.on('error', () => {
          if (Date.now() - t0 > 5000) return res(false)
          setTimeout(tryOnce, 200)
        })
        sock.connect({ path: sockPath }, () => res(true))
      }
      tryOnce()
    })

    const connected = await tryConnect()
    if (connected && sock) {
      sock.on('data', d => {
        try {
          const txt = d.toString('utf8')
          for (const line of txt.split('\n').filter(Boolean)) {
            const obj = JSON.parse(line)
            if (obj && obj.request_id && obj.data != null && obj.request_id.startsWith) {
              // noop
            }
            if (obj && obj.error === 'success' && obj.data != null) {
              // response to get_property
              if (typeof obj.data === 'number') lastPos = obj.data
            }
          }
        } catch (e) {}
      })

      const poll = setInterval(() => {
        try { sock.write(JSON.stringify({ command: ['get_property', 'time-pos'], request_id: String(reqId++) }) + '\n') } catch (e) {}
      }, 2000)

      await new Promise(resolve => mpv.on('exit', () => { clearInterval(poll); resolve() }))
      closed = true
      try { sock.end(); sock.destroy() } catch {}
    } else {
      await new Promise(resolve => mpv.on('exit', resolve))
    }

    addHistoryEntry({ title: title || '', slug, episode: episodeNum, session: ep.session, audio: btn.audio, resolution: btn.resolution, position: Math.round(lastPos || 0) })

    if (!autonext) break
    idx = idx + 1
    playedOne = true
    startAt = 0
    await new Promise(r => setTimeout(r, 400))
  }
}


function absUrl(u, base) {
  try {
    if (/^https?:\/\//i.test(u)) return u
    if (/^\/\//.test(u)) return 'https:' + u
    return new URL(u, base).href
  } catch { return u }
}
function shouldProxyAsPlaylist(u) { return /\.m3u8(\?|$)/i.test(u) }

function rewritePlaylist(content, base, token) {
  const lines = content.split('\n')
  const out = []
  let pendingStreamInf = null
  let skipNextImageUri = false
  const isM3U8 = (u) => /\.m3u8(\?|$)/i.test(u)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (skipNextImageUri) {
      if (!line.startsWith('#') && line.trim()) {
        skipNextImageUri = false
        continue
      }
      out.push(line)
      continue
    }

    if (line.startsWith('#EXT-X-IMAGE-STREAM-INF')) {
      skipNextImageUri = true
      continue
    }

    if (line.startsWith('#EXT-X-STREAM-INF')) {
      pendingStreamInf = line
      const lower = line.toLowerCase()
      const isAv1 = lower.includes('codecs="av01') || lower.includes('codecs="av1')
      if (isAv1) pendingStreamInf = { drop: true }
      continue
    }
    if (pendingStreamInf) {
      if (pendingStreamInf.drop) { pendingStreamInf = null; continue }
      const tag = pendingStreamInf
      const url = absUrl(line.trim(), base)
      const prox = `/proxy/playlist?token=${encodeURIComponent(token)}&url=${encodeURIComponent(url)}&ref=${encodeURIComponent(base)}`
      out.push(tag)
      out.push(prox)
      pendingStreamInf = null
      continue
    }

    if (line.startsWith('#EXT-X-I-FRAME-STREAM-INF')) {
      const m = line.match(/URI="([^"]+)"/)
      if (m) {
        const abs = absUrl(m[1], base)
        const prox = `/proxy/playlist?token=${encodeURIComponent(token)}&url=${encodeURIComponent(abs)}&ref=${encodeURIComponent(base)}`
        out.push(line.replace(m[1], prox))
      } else out.push(line)
      continue
    }

    if (line.startsWith('#EXT-X-MAP')) {
      const m = line.match(/URI="([^"]+)"/)
      if (m) {
        const abs = absUrl(m[1], base)
        const prox = `/proxy/segment?token=${encodeURIComponent(token)}&url=${encodeURIComponent(abs)}&ref=${encodeURIComponent(base)}`
        out.push(line.replace(m[1], prox))
      } else out.push(line)
      continue
    }

    if (line.startsWith('#EXT-X-KEY')) {
      const m = line.match(/URI="([^"]+)"/)
      if (m) {
        const abs = absUrl(m[1], base)
        const prox = `/proxy/key?token=${encodeURIComponent(token)}&url=${encodeURIComponent(abs)}&ref=${encodeURIComponent(base)}`
        out.push(line.replace(m[1], prox))
      } else out.push(line)
      continue
    }

    if (line.startsWith('#EXT-X-PART')) {
      const m = line.match(/URI="([^"]+)"/)
      if (m) {
        const abs = absUrl(m[1], base)
        const prox = `/proxy/segment?token=${encodeURIComponent(token)}&url=${encodeURIComponent(abs)}&ref=${encodeURIComponent(base)}`
        out.push(line.replace(m[1], prox))
      } else out.push(line)
      continue
    }

    if (line.startsWith('#EXT-X-PRELOAD-HINT')) {
      const m = line.match(/URI="([^"]+)"/)
      if (m) {
        const abs = absUrl(m[1], base)
        const prox = `/proxy/segment?token=${encodeURIComponent(token)}&url=${encodeURIComponent(abs)}&ref=${encodeURIComponent(base)}`
        out.push(line.replace(m[1], prox))
      } else out.push(line)
      continue
    }

    if (line.startsWith('#EXT-X-RENDITION-REPORT')) {
      const m = line.match(/URI="([^"]+)"/)
      if (m) {
        const abs = absUrl(m[1], base)
        const prox = `/proxy/playlist?token=${encodeURIComponent(token)}&url=${encodeURIComponent(abs)}&ref=${encodeURIComponent(base)}`
        out.push(line.replace(m[1], prox))
      } else out.push(line)
      continue
    }

    if (line.startsWith('#EXT-X-MEDIA')) {
      const m = line.match(/URI="([^"]+)"/)
      if (m) {
        const abs = absUrl(m[1], base)
        const prox = isM3U8(abs)
          ? `/proxy/playlist?token=${encodeURIComponent(token)}&url=${encodeURIComponent(abs)}&ref=${encodeURIComponent(base)}`
          : `/proxy/segment?token=${encodeURIComponent(token)}&url=${encodeURIComponent(abs)}&ref=${encodeURIComponent(base)}`
        out.push(line.replace(m[1], prox))
      } else out.push(line)
      continue
    }

    if (line.startsWith('#')) { out.push(line); continue }
    if (!line.trim()) { out.push(line); continue }

    const abs = absUrl(line.trim(), base)
    if (isM3U8(abs)) {
      out.push(`/proxy/playlist?token=${encodeURIComponent(token)}&url=${encodeURIComponent(abs)}&ref=${encodeURIComponent(base)}`)
    } else {
      out.push(`/proxy/segment?token=${encodeURIComponent(token)}&url=${encodeURIComponent(abs)}&ref=${encodeURIComponent(base)}`)
    }
  }
  return out.join('\n')
}
function pipeFetchResponse(r, res, urlForDebug) {
  const copy = (h) => { const v = r.headers.get(h); if (v) res.setHeader(h, v) }
  res.setHeader('X-Upstream-Status', String(r.status))
  res.setHeader('X-Upstream-URL', urlForDebug || '')
  copy('content-type')
  copy('accept-ranges')
  copy('content-range')
  copy('etag')
  copy('last-modified')
  copy('cache-control')
  copy('content-encoding')
  copy('content-length')
  res.status(r.status)
  if (!r.body) return res.end()
  if (Readable.fromWeb) {
    const s = Readable.fromWeb(r.body)
    s.on('error', () => { try { res.destroy() } catch {} })
    s.pipe(res)
  } else {
    r.arrayBuffer().then(b => res.end(Buffer.from(b))).catch(() => { try { res.destroy() } catch {} })
  }
}

function buildUpstreamHeaders({ cookie, ref, req }) {
  const headers = {}
  if (cookie) headers.cookie = cookie
  if (ref) headers.Referer = ref
  try { if (ref) headers.Origin = new URL(ref).origin } catch {}
  if (req.headers.range) headers.Range = req.headers.range
  if (req.headers['if-range']) headers['If-Range'] = req.headers['if-range']
  if (req.headers['if-modified-since']) headers['If-Modified-Since'] = req.headers['if-modified-since']
  if (req.headers['if-none-match']) headers['If-None-Match'] = req.headers['if-none-match']
  if (req.headers['accept']) headers.Accept = req.headers['accept']
  if (req.headers['accept-language']) headers['Accept-Language'] = req.headers['accept-language']
  return headers
}

function exists(p) { try { return fs.statSync(p).isFile() } catch { return false } }
function waitForFile(p, timeoutMs = 20000, intervalMs = 300) {
  return new Promise(r => {
    const t0 = Date.now()
    const i = setInterval(() => {
      try { if (fs.statSync(p).isFile()) { clearInterval(i); r(true); return } } catch {}
      if (Date.now() - t0 > timeoutMs) { clearInterval(i); r(false) }
    }, intervalMs)
  })
}
function countSegmentsInPlaylist(p) {
  try {
    const txt = fs.readFileSync(p, 'utf8')
    return (txt.match(/#EXTINF:/g) || []).length
  } catch { return 0 }
}
async function waitForSegments(playlistPath, minSeg = Number(process.env.PREPARE_MIN_SEGMENTS || 6), timeoutMs = 20000, intervalMs = 400) {
  const t0 = Date.now()
  return await new Promise(res => {
    const tick = () => {
      const n = countSegmentsInPlaylist(playlistPath)
      if (n >= minSeg) return res(true)
      if (Date.now() - t0 > timeoutMs) return res(false)
      setTimeout(tick, intervalMs)
    }
    tick()
  })
}

function ensureTransmuxStart(m3u8Url, lang, reso) {
  const keyBase = `${m3u8Url}|${lang || ''}|${reso || ''}|event`
  const key = crypto.createHash('md5').update(keyBase).digest('hex')
  const outDir = path.join(CACHE_ROOT, key)
  const outM3U8 = path.join(outDir, 'stream.m3u8')
  const outMaster = path.join(outDir, 'master.m3u8')
  if (!procs.has(key) && !exists(outMaster)) {
    fs.mkdirSync(outDir, { recursive: true })
    const args = [
      '-loglevel','error',
      '-user_agent', DEFAULT_HEADERS['user-agent'],
      '-headers', `Referer: ${m3u8Url}\r\n`,
      '-i', m3u8Url,
      '-map','v:0','-c:v','copy',
      '-map','a:0','-c:a','aac','-profile:a','aac_low','-ac','2','-b:a','128k',
      '-hls_time','3',
      '-hls_list_size','0',
      '-hls_segment_type','fmp4',
      '-hls_flags','append_list+independent_segments+omit_endlist+temp_file+delete_segments',
      '-hls_delete_threshold','1',
      '-hls_playlist_type','event',
      '-hls_segment_filename', path.join(outDir,'seg-%04d.m4s'),
      '-master_pl_name','master.m3u8',
      outM3U8
    ]
    const ff = spawn('ffmpeg', args, { stdio: ['ignore','ignore','inherit'] })
    ff.on('close', () => { procs.delete(key) })
    procs.set(key, ff)
  }
  return { key, url: `/cache/${key}/master.m3u8`, masterPath: outMaster, mediaPath: outM3U8 }
}
async function ensureTransmuxFull(m3u8Url, lang, reso) {
  const keyBase = `${m3u8Url}|${lang || ''}|${reso || ''}|full`
  const key = crypto.createHash('md5').update(keyBase).digest('hex')
  const outDir = path.join(CACHE_ROOT, key)
  const outM3U8 = path.join(outDir, 'stream.m3u8')
  const outMaster = path.join(outDir, 'master.m3u8')
  if (exists(outMaster)) return { key, url: `/cache/${key}/master.m3u8`, masterPath: outMaster, mediaPath: outM3U8 }
  await new Promise((resolve, reject) => {
    fs.mkdirSync(outDir, { recursive: true })
    const args = [
      '-loglevel','error',
      '-user_agent', DEFAULT_HEADERS['user-agent'],
      '-headers', `Referer: ${m3u8Url}\r\n`,
      '-i', m3u8Url,
      '-map','v:0','-c:v','copy',
      '-map','a:0','-c:a','aac','-profile:a','aac_low','-ac','2','-b:a','128k',
      '-hls_time','4',
      '-hls_list_size','0',
      '-hls_segment_type','fmp4',
      '-hls_flags','independent_segments',
      '-hls_playlist_type','vod',
      '-hls_segment_filename', path.join(outDir,'seg-%04d.m4s'),
      '-master_pl_name','master.m3u8',
      outM3U8
    ]
    const ff = spawn('ffmpeg', args, { stdio: ['ignore','pipe','pipe'] })
    let err = ''
    ff.stderr.on('data', d => { err += d.toString() })
    ff.on('close', code => {
      if (code === 0 && exists(outMaster)) resolve()
      else reject(new Error(err || `ffmpeg ${code}`))
    })
  })
  return { key, url: `/cache/${key}/master.m3u8`, masterPath: outMaster, mediaPath: outM3U8 }
}

const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 15 * 60 * 1000)
const CLEAN_INTERVAL_MS = Number(process.env.CLEAN_INTERVAL_MS || 5 * 60 * 1000)
setInterval(() => {
  const now = Date.now()
  for (const [key, meta] of keyMeta) {
    const active = keyRefs.get(key)
    if (!active || active.size === 0) {
      if (now - (meta.lastSeen || 0) > CACHE_TTL_MS) cleanupKey(key)
    }
  }
  for (const [sid, rec] of sessions) {
    if (now - (rec.lastSeen || 0) > CACHE_TTL_MS) endSession(sid)
  }
}, CLEAN_INTERVAL_MS)

