const crypto = require('crypto')
const { URL } = require('url')
const cheerio = require('cheerio')
const vm = require('vm')
const { spawn } = require('child_process')
const os = require('os')
const path = require('path')
const fs = require('fs')
const downloader = require('./downloader')
const inquirer = require('inquirer')

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
const HOST = 'https://animepahe.si'
const API_URL = `${HOST}/api`
const REFERER = HOST
function genCookie() { return `__ddg2_=${crypto.randomBytes(12).toString('hex')}` }

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

const HISTORY_PATH = path.join(__dirname, '..', '.streamweb_anime_history.json')
function ensureHistoryFile() {
  try {
    if (!fs.existsSync(HISTORY_PATH)) {
      fs.writeFileSync(HISTORY_PATH, JSON.stringify([], null, 2), 'utf8')
      if (process.platform !== 'win32') {
        try { fs.chmodSync(HISTORY_PATH, 0o600) } catch (e) {}
      }
    }
  } catch (e) {}
}
function readHistory() { try { const txt = fs.readFileSync(HISTORY_PATH, 'utf8'); return JSON.parse(txt) || [] } catch { return [] } }
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

function exportHistory(destPath) {
  const arr = readHistory()
  fs.writeFileSync(destPath, JSON.stringify(arr, null, 2), 'utf8')
}

function clearHistory() {
  try { writeHistory([]) } catch (e) { try { fs.unlinkSync(HISTORY_PATH) } catch (e) {} }
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
      console.log(`Autoplaying next episode (ep ${episodeNum})  with audio: ${btn.audio}, resolution: ${btn.resolution}. (Ctrl+W: stop autoplay and return to menu; Ctrl+O: stop autoplay only)`)
    }

    let sockPath
  if (process.platform === 'win32') sockPath = `\\.\pipe\streamweb-anime-mpv-${process.pid}-${Date.now()}`
  else sockPath = path.join(os.tmpdir(), `streamweb-anime-mpv-${process.pid}-${Date.now()}.sock`)
    const inputConfPath = path.join(CACHE_ROOT, `streamweb-inputconf-${process.pid}-${Date.now()}.conf`)
    try {
      fs.writeFileSync(inputConfPath, `Ctrl+w print-text STREAMWEB:STOP_AUTOPLAY_AND_QUIT\nCtrl+o print-text STREAMWEB:STOP_AUTOPLAY_ONLY\n`, 'utf8')
    } catch (e) {}

    const args = [m3u8, `--input-ipc-server=${sockPath}`, `--input-conf=${inputConfPath}`, '--http-header-fields=Referer: https://kwik.cx/']
    args.push('--fullscreen')
    if (startAt && Number(startAt) > 0) args.push(`--start=${Number(startAt)}`)
    const mpv = spawn('mpv', args, { stdio: ['ignore','pipe','pipe'] })

    let userStopMode = null
    if (mpv.stdout) mpv.stdout.on('data', d => {
      try {
        const txt = d.toString('utf8')
        if (txt.includes('STREAMWEB:STOP_AUTOPLAY_AND_QUIT')) {
          autonext = false
          userStopMode = 'quit'
          console.log('Stop autoplay requested — returning to menu (Ctrl+W)')
          try {
            if (sock) sock.write(JSON.stringify({ command: ['quit'] }) + '\n')
            else mpv.kill()
          } catch (e) {}
        } else if (txt.includes('STREAMWEB:STOP_AUTOPLAY_ONLY')) {
          autonext = false
          userStopMode = 'stop_only'
          console.log('Stop autoplay requested — autoplay disabled (Ctrl+O)')
        }
      } catch (e) {}
    })
    if (mpv.stderr) mpv.stderr.on('data', d => {
      try {
        const txt = d.toString('utf8')
        if (txt.includes('STREAMWEB:STOP_AUTOPLAY_AND_QUIT')) {
          autonext = false
          userStopMode = 'quit'
          console.log('Stop autoplay requested — returning to menu (Ctrl+W)')
          try {
            if (sock) sock.write(JSON.stringify({ command: ['quit'] }) + '\n')
            else mpv.kill()
          } catch (e) {}
        } else if (txt.includes('STREAMWEB:STOP_AUTOPLAY_ONLY')) {
          autonext = false
          userStopMode = 'stop_only'
          console.log('Stop autoplay requested — autoplay disabled (Ctrl+O)')
        }
      } catch (e) {}
    })
    let lastPos = Number(startAt) || 0
    let reqId = 1
    let sock = null
    let closed = false

    const tryConnect = () => new Promise(res => {
      const t0 = Date.now()
      const tryOnce = () => {
        sock = new (require('net').Socket)()
        sock.on('error', () => {
          if (Date.now() - t0 > 5000) return res(false)
          setTimeout(tryOnce, 200)
        })
        try { sock.connect({ path: sockPath }, () => res(true)) } catch (e) { if (Date.now() - t0 > 5000) return res(false); setTimeout(tryOnce, 200) }
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
            if (obj && obj.error === 'success' && obj.data != null) {
              if (typeof obj.data === 'number') lastPos = obj.data
            }
          }
        } catch (e) {}
      })

      const poll = setInterval(() => { try { sock.write(JSON.stringify({ command: ['get_property', 'time-pos'], request_id: String(reqId++) }) + '\n') } catch (e) {} }, 2000)

      await new Promise(resolve => mpv.on('exit', () => { clearInterval(poll); resolve() }))
      closed = true
      try { sock.end(); sock.destroy() } catch {}
    } else {
      await new Promise(resolve => mpv.on('exit', resolve))
    }

    try { fs.unlinkSync(inputConfPath) } catch (e) {}

    addHistoryEntry({ title: title || '', slug, episode: episodeNum, session: ep.session, audio: btn.audio, resolution: btn.resolution, position: Math.round(lastPos || 0) })

    if (!autonext) break
    idx = idx + 1
    playedOne = true
    startAt = 0
    await new Promise(r => setTimeout(r, 400))
  }
}

function absUrl(u, base) { try { if (/^https?:\/\//i.test(u)) return u; if (/^\/\//.test(u)) return 'https:' + u; return new URL(u, base).href } catch { return u } }
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
      if (!line.startsWith('#') && line.trim()) { skipNextImageUri = false; continue }
      out.push(line)
      continue
    }
    if (line.startsWith('#EXT-X-IMAGE-STREAM-INF')) { skipNextImageUri = true; continue }
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

async function main() {
  try {
    const cookie = genCookie()
    ensureHistoryFile()
  const CONFIG_PATH = path.join(__dirname, '..', '.streamweb_anime_config.json')
    function readConfig() { try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {} } catch { return {} } }
    function writeConfig(cfg) { try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8') } catch (e) {} }
    let cfg = readConfig()
    if (typeof cfg.autoplayAll !== 'boolean') cfg.autoplayAll = false
    if (typeof cfg.skipFillers !== 'boolean') cfg.skipFillers = false
    if (typeof cfg.autoTranscode !== 'boolean') cfg.autoTranscode = false

    while (true) {
      const choice = await inquirer.prompt([{ type: 'list', name: 'act', message: 'Anime menu', choices: ['Search & play an anime', 'Download episodes', 'View recently watched', 'Export history', 'Clear history', 'Settings', 'Return to main menu', 'Exit'] }])
      const act = choice.act
      if (act === 'Return to main menu') return
      if (act === 'Exit') process.exit(0)
      if (act === 'Settings') {
        while (true) {
          cfg = readConfig()
          console.log('\nSettings:')
          console.log(`1. Autoplay all: ${cfg.autoplayAll ? 'ON' : 'OFF'}`)
          console.log(`2. Skip all fillers: ${cfg.skipFillers ? 'ON' : 'OFF'}`)
          console.log(`3. Auto-transcode audio on download: ${cfg.autoTranscode ? 'ON' : 'OFF'}`)
          console.log('4. Back to menu')
          const s = await inquirer.prompt([{ name: 's', message: 'Toggle (1-3) or 4 to back:' }])
          const v = (s.s||'').trim()
          if (v === '1') { cfg.autoplayAll = !cfg.autoplayAll; writeConfig(cfg); console.log('Autoplay all set to', cfg.autoplayAll) }
          else if (v === '2') { cfg.skipFillers = !cfg.skipFillers; writeConfig(cfg); console.log('Skip fillers set to', cfg.skipFillers) }
          else if (v === '3') { cfg.autoTranscode = !cfg.autoTranscode; writeConfig(cfg); console.log('Auto-transcode set to', cfg.autoTranscode) }
          else break
        }
        continue
      }
      if (act === 'Export history') {
        const { out } = await inquirer.prompt([{ name: 'out', message: 'Export path (blank for ./anime_history_export.json):' }])
        const outPath = out && out.trim() ? out.trim() : path.join(process.cwd(), 'anime_history_export.json')
        try { exportHistory(outPath); console.log('History exported to', outPath) } catch (e) { console.error('Failed to export history:', e.message) }
        continue
      }
      if (act === 'Clear history') {
        const { confirm } = await inquirer.prompt([{ name: 'confirm', message: 'Are you sure? (y/N):' }])
        if (confirm && ['y','yes'].includes((confirm||'').toLowerCase())) { clearHistory(); console.log('History cleared') } else console.log('Aborted')
        continue
      }
      if (act === 'View recently watched') {
        const hist = readHistory()
        if (!hist.length) { console.log('No recently watched entries.'); continue }
        const bySlug = {}
        for (const h of hist) if (!bySlug[h.slug] || (h.ts || 0) > (bySlug[h.slug].ts || 0)) bySlug[h.slug] = h
        const unique = Object.values(bySlug)
        unique.forEach((h, i) => { const t = new Date(h.ts).toLocaleString(); console.log(`${i+1}. ${h.title} — ep ${h.episode} — ${h.audio||''}/${h.resolution||''} — ${t} — pos ${Math.round(h.position||0)}s`) })
        const pickRaw = await inquirer.prompt([{ name: 'pick', message: 'Select entry to resume by number (or blank to return):' }])
        const pick = pickRaw.pick && String(pickRaw.pick).trim()
        if (!pick) continue
        const n = parseInt(pick, 10)
        if (isNaN(n) || n < 1 || n > unique.length) continue
        const entry = unique[n-1]
        const episodes = await getAllEpisodes(entry.slug, cookie)
        const epIdx = episodes.findIndex(e => Number(e.episode) === Number(entry.episode))
        if (epIdx === -1) { console.log('Episode not found anymore.'); continue }
        const cfg = readConfig()
        await playEpisode({ slug: entry.slug, epIdx, episodes, audio: entry.audio, resolution: entry.resolution, cookie, title: entry.title, startAt: entry.position || 0, autonext: cfg.autoplayAll })
        continue
      }

      if (act === 'Download episodes') {
        const { q } = await inquirer.prompt([{ name: 'q', message: 'Search:' }])
        const query = (q||'').trim()
        if (!query) continue
        const results = await searchAnime(query, cookie)
        if (!results || !results.data || results.data.length === 0) { console.log('No results found.'); continue }
        const choices = results.data.map((a, idx) => ({ name: `${idx+1}. ${a.title}`, value: a }))
        const { anime } = await inquirer.prompt([{ type: 'list', name: 'anime', message: 'Select', choices, pageSize: Math.min(choices.length, cfg.pageSizeDefault || 20) }])
        const slug = anime.session || anime.id || anime.slug
        let episodes = await getAllEpisodes(slug, cookie)
        if (!episodes || !episodes.length) { console.log('No episodes found.'); continue }
        const epChoices = episodes.map((ep, i) => ({ name: `${i+1}. Episode ${ep.episode}${ep.filler ? ' (filler)' : ''}${ep.title ? ` - ${ep.title}` : ''}`, value: ep }))
        const { selectedEp } = await inquirer.prompt([{ type: 'list', name: 'selectedEp', message: 'Select episode to download', choices: epChoices, pageSize: Math.min(epChoices.length, cfg.pageSizeDefault || 20) }])
        const origEpIdx = episodes.findIndex(e => e.episode == selectedEp.episode)
        const playUrl = `${HOST}/play/${encodeURIComponent(slug)}/${selectedEp.session}`
        const html = await httpText(playUrl, { headers: { cookie, Referer: REFERER } })
        const $ = cheerio.load(html)
        const opts = []
        $('button[data-src]').each((_, el) => { const e = $(el); opts.push({ audio: (e.attr('data-audio')||'').toLowerCase(), resolution: e.attr('data-resolution')||'', session: e.attr('data-src')||'' }) })
        const uniq = Array.from(new Map(opts.map(o => [`${o.audio}|${o.resolution}`, o])).values())
        const optChoices = uniq.map((o, i) => ({ name: `${i+1}. Audio: ${o.audio} Resolution: ${o.resolution}`, value: o }))
        const { opt } = await inquirer.prompt([{ type: 'list', name: 'opt', message: 'Select audio/resolution', choices: optChoices, pageSize: Math.min(optChoices.length, cfg.pageSizeDefault || 20) }])
        console.log(`Downloading episode ${selectedEp.episode} with audio: ${opt.audio}, resolution: ${opt.resolution}`)
        const m3u8 = await getEpisodeM3U8({ slug, episode: selectedEp.episode, audio: opt.audio, resolution: opt.resolution, cookie })
        if (!m3u8) { console.log('Could not find stream URL for this episode.'); continue }
        try {
          const dest = path.join(process.cwd(), 'downloads')
          let refer = REFERER
          try { if (/kwik|owocdn|vidcloud|vault|vidcdn|vidstream/i.test(m3u8)) refer = 'https://kwik.cx' } catch (e) {}
          const rawTitle = (anime && anime.title) ? anime.title : slug
          const safeTitle = rawTitle.replace(/\s+/g, '-').replace(/"/g, '').replace(/[^a-zA-Z0-9\-_.]/g, '')
          const fileName = `${safeTitle}_E${String(selectedEp.episode).padStart(2,'0')}`
          await downloader.download(dest, fileName, m3u8, refer, { recodeAudio: cfg.autoTranscode })
          console.log('Download complete — saved as', fileName + '.mp4')
        } catch (e) { console.error('Download failed:', e.message || e) }
        continue
      }
      if (act === 'Search & play an anime') {
        const { q } = await inquirer.prompt([{ name: 'q', message: 'Search:' }])
        const query = (q||'').trim()
        if (!query) continue
        const results = await searchAnime(query, cookie)
        if (!results || !results.data || results.data.length === 0) { console.log('No results found.'); continue }
        const choices = results.data.map((a, idx) => ({ name: `${idx+1}. ${a.title}`, value: a }))
        const { anime } = await inquirer.prompt([{ type: 'list', name: 'anime', message: 'Select', choices, pageSize: Math.min(choices.length, cfg.pageSizeDefault || 20) }])
        const slug = anime.session || anime.id || anime.slug
        let episodes = await getAllEpisodes(slug, cookie)
        if (!episodes || !episodes.length) { console.log('No episodes found.'); continue }
        let displayEpisodes = episodes
        if (cfg.skipFillers) { displayEpisodes = episodes.filter(ep => !ep.filler); if (!displayEpisodes.length) { console.log('No non-filler episodes found.'); continue } }
        const epChoices = displayEpisodes.map((ep, i) => ({ name: `${i+1}. Episode ${ep.episode}${ep.filler ? ' (filler)' : ''}${ep.title ? ` - ${ep.title}` : ''}`, value: ep }))
        const { selectedEp } = await inquirer.prompt([{ type: 'list', name: 'selectedEp', message: 'Select episode', choices: epChoices, pageSize: Math.min(epChoices.length, cfg.pageSizeDefault || 20) }])
        const origEpIdx = episodes.findIndex(e => e.episode == selectedEp.episode)
        const playUrl = `${HOST}/play/${encodeURIComponent(slug)}/${selectedEp.session}`
        const html = await httpText(playUrl, { headers: { cookie, Referer: REFERER } })
        const $ = cheerio.load(html)
        const opts = []
        $('button[data-src]').each((_, el) => { const e = $(el); opts.push({ audio: (e.attr('data-audio')||'').toLowerCase(), resolution: e.attr('data-resolution')||'', session: e.attr('data-src')||'' }) })
        const uniq = Array.from(new Map(opts.map(o => [`${o.audio}|${o.resolution}`, o])).values())
        const optChoices = uniq.map((o, i) => ({ name: `${i+1}. Audio: ${o.audio} Resolution: ${o.resolution}`, value: o }))
        const { opt } = await inquirer.prompt([{ type: 'list', name: 'opt', message: 'Select audio/resolution', choices: optChoices, pageSize: Math.min(optChoices.length, cfg.pageSizeDefault || 20) }])
        console.log(`Playing episode ${selectedEp.episode} with audio: ${opt.audio}, resolution: ${opt.resolution}`)
        await playEpisode({ slug, epIdx: origEpIdx, episodes: cfg.skipFillers ? displayEpisodes : episodes, audio: opt.audio, resolution: opt.resolution, cookie, title: anime.title, startAt: 0, autonext: cfg.autoplayAll })
      }
    }
  } catch (e) { console.error('Anime CLI error:', e.message || e) }
}

module.exports = { main, getEpisodeM3U8, genCookie, ensureHistoryFile, readHistory, exportHistory, clearHistory, searchAnime, getAllEpisodes }
