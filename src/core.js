const axios = require('axios')
const cheerio = require('cheerio')
const inquirer = (require('inquirer') && require('inquirer').default) ? require('inquirer').default : require('inquirer')
const open = require('open')
const { decodeUrl } = require('./utils')
const downloader = require('./downloader')
const player = require('./player')
const os = require('os')
const path = require('path')
const fs = require('fs')

const FLIXHQ_BASE_URL = 'https://flixhq.to'
const FLIXHQ_SEARCH_URL = `${FLIXHQ_BASE_URL}/search`
const FLIXHQ_AJAX_URL = `${FLIXHQ_BASE_URL}/ajax`

let selectedMedia = null
let selectedSubtitles = []
let selectedUrl = null
let contentType = null

const HISTORY_PATH = path.join(__dirname, '..', '.streamweb_history.json')
const CONFIG_PATH = path.join(__dirname, '..', '.streamweb_config.json')

function ensureHistoryFile() {
  try {
    if (!fs.existsSync(HISTORY_PATH)) fs.writeFileSync(HISTORY_PATH, JSON.stringify([], null, 2), 'utf8')
  } catch (e) {}
}

function readHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8')) || [] } catch { return [] }
}

function writeHistory(arr) { try { fs.writeFileSync(HISTORY_PATH, JSON.stringify(arr, null, 2), 'utf8') } catch (e) {} }

function addHistoryEntry(entry) {
  try {
    const arr = readHistory()
    const key = `${entry.url}::${entry.season || ''}::${entry.episode || ''}`
    const filtered = arr.filter(a => `${a.url}::${a.season||''}::${a.episode||''}` !== key)
    filtered.unshift({ ...entry, ts: Date.now() })
    writeHistory(filtered.slice(0, 200))
  } catch (e) {}
}

function exportHistory(destPath) {
  const arr = readHistory()
  fs.writeFileSync(destPath, JSON.stringify(arr, null, 2), 'utf8')
}

function clearHistory() { try { writeHistory([]) } catch (e) { try { fs.unlinkSync(HISTORY_PATH) } catch (e) {} } }

function readConfig() {
  try { const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); return c || {} } catch { return {} }
}

function writeConfig(cfg) { try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8') } catch (e) {} }

try { ensureHistoryFile() } catch (e) {}
const _cfg = readConfig()
if (typeof _cfg.autoplayNext !== 'boolean') _cfg.autoplayNext = false
if (typeof _cfg.autoTranscode !== 'boolean') _cfg.autoTranscode = false
if (typeof _cfg.downloadPath !== 'string') _cfg.downloadPath = ''
if (typeof _cfg.pageSizeDefault !== 'number') _cfg.pageSizeDefault = 20
writeConfig(_cfg)

async function searchContent(query) {
  const params = query.replace(/\s+/g, '-')
  const url = `${FLIXHQ_SEARCH_URL}/${params}`
  const resp = await axios.get(url, { headers: { 'User-Agent': `flix-cli/1.0.0` } })
  const $ = cheerio.load(resp.data)
  const items = $('.flw-item')
  if (!items.length) {
    console.log('No results found')
    return null
  }
  const results = []
  const urls = []
  items.each((i, el) => {
    const poster = $(el).find('.film-poster a')
    const titleElem = $(el).find('.film-detail h2.film-name a')
    const info = $(el).find('.fd-infor span')
    const title = titleElem.attr('title') || titleElem.text() || 'Unknown Title'
    let display = `${i + 1}. ${title}`
    if (info && info.length) display += ` (${$(info[0]).text().trim()})`
    results.push(display)
    urls.push(new URL(poster.attr('href') || '', FLIXHQ_BASE_URL).toString())
  })
  const cfg = readConfig()
  const pageSize = Math.min(results.length, (cfg.pageSizeDefault || 20))
  const choice = await inquirer.prompt([{ type: 'list', name: 'sel', message: 'Select', choices: results, pageSize }])
  const idx = results.indexOf(choice.sel)
  return urls[idx]
}

async function getId(query) {
  const url = await searchContent(query)
  if (!url) {
    console.log('No content selected')
    process.exit(0)
  }
  selectedUrl = url
  if (selectedUrl.includes('/movie/')) contentType = 'movie'
  else if (selectedUrl.includes('/tv/')) contentType = 'series'
  else contentType = 'unknown'
  return selectedUrl
}

async function movie() {
  if (!selectedUrl) throw new Error('No selected URL')
  const m = selectedUrl.match(/\/movie\/[^/]*-(\d+)/)
  if (!m) throw new Error('Could not extract media ID from URL')
  const mediaId = m[1]
  const url = `${FLIXHQ_AJAX_URL}/movie/episodes/${mediaId}`
  const resp = await axios.get(url)
  const content = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data)
  const match = content.match(/href=\"([^\"]*)\"[^>]*title=\"Vidcloud\"/)
  if (match) {
    const moviePage = new URL(match[1], FLIXHQ_BASE_URL).toString()
    const epMatch = moviePage.match(/-(\d+)\.(\d+)$/)
    if (epMatch) {
      const episodeId = epMatch[2]
      const embed = await getEmbedLink(episodeId)
      if (embed) {
        selectedMedia = [{ file: embed, label: 'Movie Stream', type: 'embed' }]
        selectedSubtitles = []
        return
      }
    }
  }
  throw new Error('Could not get movie stream')
}

async function series() {
  const m = selectedUrl.match(/\/tv\/[^/]*-(\d+)/)
  if (!m) throw new Error('Could not extract media ID from URL')
  const mediaId = m[1]
  const seasons = await getTvSeasons(mediaId)
  if (!seasons.length) throw new Error('Could not get seasons')
  
  const seasonChoices = seasons.map((s, i) => ({ name: `${i+1}. ${s.title}`, value: i }))
  const scfg = readConfig()
  const seasonPage = Math.min(seasonChoices.length, (scfg.pageSizeDefault || 20))
  const { seasonIdx } = await inquirer.prompt([{ type: 'list', name: 'seasonIdx', message: 'Select season:', choices: seasonChoices, pageSize: seasonPage }])
  const seasonNum = seasonIdx + 1
  const targetSeasonId = seasons[seasonIdx].id
  const episodes = await getSeasonEpisodes(targetSeasonId)
  if (!episodes.length) throw new Error(`Could not get episodes for season ${seasonNum}`)
  const episodeChoices = episodes.map((ep, i) => ({ name: `${i+1}. ${ep.title || `Episode ${i+1}`}`, value: i }))
  const ecfg = readConfig()
  const epPage = Math.min(episodeChoices.length + 1, (ecfg.pageSizeDefault || 20))
  const { epSelect } = await inquirer.prompt([{ type: 'list', name: 'epSelect', message: 'Select episode (or choose Range)', choices: [...episodeChoices, { name: 'Enter a range (e.g. 5-7)', value: 'range' }], pageSize: epPage }])
  let episode = null
  if (epSelect === 'range') {
    const resp = await inquirer.prompt([{ name: 'episode', message: "Enter episode (e.g., '5' or '5-7')" }])
    episode = resp.episode
  } else {
    
    const epObj = episodes[epSelect]
    episode = String((epObj && epObj.episode) ? epObj.episode : (epSelect + 1))
  }
  const episodeNumbers = parseEpisodeRange(episode)
  if (!episodeNumbers) throw new Error('Invalid episode input')
  const maxEp = episodes.length
  for (const ep of episodeNumbers) if (ep > maxEp) throw new Error(`Episode ${ep} not found (only ${maxEp} available)`)
  const episodeDataList = []
  for (const epNum of episodeNumbers) {
    const target = episodes[epNum - 1]
    const data = await getEpisodeData(target, seasonNum, epNum)
    if (data) episodeDataList.push(data)
  }
  if (!episodeDataList.length) throw new Error('Could not get data for any episodes')
  selectedMedia = episodeDataList
  selectedSubtitles = []
}

function parseEpisodeRange(input) {
  input = input.trim()
  if (input.includes('-')) {
    const [s, e] = input.split('-', 2)
    const si = parseInt(s.trim(), 10)
    const ei = parseInt(e.trim(), 10)
    if (Number.isNaN(si) || Number.isNaN(ei) || si > ei) return null
    const arr = []
    for (let i = si; i <= ei; i++) arr.push(i)
    return arr
  } else {
    const single = parseInt(input, 10)
    if (Number.isNaN(single)) return null
    return [single]
  }
}

async function getTvSeasons(mediaId) {
  const url = `${FLIXHQ_AJAX_URL}/v2/tv/seasons/${mediaId}`
  const resp = await axios.get(url)
  const body = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data)
  const re = /href=\"[^\"]*-(\d+)\"[^>]*>([^<]*)<\/a>/g
  const seasons = []
  let m
  while ((m = re.exec(body))) {
    seasons.push({ id: m[1], title: m[2].trim() })
  }
  return seasons
}

async function getSeasonEpisodes(seasonId) {
  const url = `${FLIXHQ_AJAX_URL}/v2/season/episodes/${seasonId}`
  const resp = await axios.get(url)
  const dataStr = typeof resp.data === 'string' ? resp.data.replace(/\n/g, '') : JSON.stringify(resp.data).replace(/\n/g, '')
  const re = /data-id=\"(\d+)\"[^>]*title=\"([^\"]*)\"/g
  const eps = []
  let m
  while ((m = re.exec(dataStr))) {
    eps.push({ data_id: m[1], title: m[2].trim() })
  }
  return eps
}

async function getEpisodeServers(dataId, preferredProvider = 'Vidcloud') {
  const url = `${FLIXHQ_AJAX_URL}/v2/episode/servers/${dataId}`
  const resp = await axios.get(url)
  const dataStr = typeof resp.data === 'string' ? resp.data.replace(/\n/g, '') : JSON.stringify(resp.data).replace(/\n/g, '')
  const re = /data-id=\"(\d+)\"[^>]*title=\"([^\"]*)\"/g
  const servers = []
  let m
  while ((m = re.exec(dataStr))) {
    servers.push({ id: m[1], name: m[2].trim() })
  }
  for (const s of servers) if (s.name.toLowerCase().includes(preferredProvider.toLowerCase())) return s.id
  return servers.length ? servers[0].id : null
}

async function getEmbedLink(episodeId) {
  const url = `${FLIXHQ_AJAX_URL}/episode/sources/${episodeId}`
  const resp = await axios.get(url)
  const body = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data)
  const m = body.match(/\"link\":\"([^\"]*)\"/)
  if (m) return m[1]
  return null
}

async function getEpisodeData(targetEpisode, seasonNum, episodeNum) {
  const episodeId = await getEpisodeServers(targetEpisode.data_id, 'Vidcloud')
  if (!episodeId) return null
  const embed = await getEmbedLink(episodeId)
  if (!embed) return null
  return { file: embed, label: `S${seasonNum}E${episodeNum} - ${targetEpisode.title}`, type: 'embed', season: seasonNum, episode: episodeNum }
}

async function poison() {
  if (contentType === 'movie') await movie()
  else if (contentType === 'series') await series()
  else {
    const ch = await inquirer.prompt([{ type: 'list', name: 't', message: 'Choose', choices: ['movie', 'series'] }])
    if (ch.t === 'movie') await movie()
    else await series()
  }
}

function determinePath() {
  const os = require('os')
  const plt = os.platform()
  const user = os.userInfo().username
  try {
    const cfg = readConfig()
    if (cfg && cfg.downloadPath && String(cfg.downloadPath).trim()) return String(cfg.downloadPath).trim()
  } catch (e) {}
  if (plt === 'win32') return `C://Users//${user}//Downloads`
  if (plt === 'darwin') return `/Users/${user}/Downloads`
  return `/home/${user}/Downloads`
}

async function dlData(dest = null, query = 'download') {
  if (!selectedMedia) { console.log('No media selected for download'); return }
  const episodes = Array.isArray(selectedMedia) ? selectedMedia : [selectedMedia]
  const cfg = readConfig()
  const basePath = dest || (cfg && cfg.downloadPath ? cfg.downloadPath : determinePath())
  for (let i = 0; i < episodes.length; i++) {
    const ep = episodes[i]
    const [decoded, subs] = await decodeUrl(ep.file)
    const name = ep.season ? `${query}_S${String(ep.season).padStart(2,'0')}E${String(ep.episode).padStart(2,'0')}` : `${query}_Episode_${i+1}`
    let referer = FLIXHQ_BASE_URL
    try {
      if (/kwik|owocdn|vidcloud|vault|vidcdn|vidstream/i.test(decoded)) referer = 'https://kwik.cx'
    } catch (e) {}
    await downloader.download(basePath, name, decoded, referer, { 
      recodeAudio: cfg && cfg.autoTranscode,
      subtitles: subs
    })
    console.log(`Successfully downloaded: ${ep.label}`)
  }
}

async function provideData() {
  if (!selectedMedia) { console.log('No media selected for playback'); return }
  const episodes = Array.isArray(selectedMedia) ? selectedMedia : [selectedMedia]
  const cfg = readConfig()
  for (let i = 0; i < episodes.length; i++) {
    const ep = episodes[i]
    const [decoded, subs] = await decodeUrl(ep.file)
    const title = ep.episode_title || ep.movie_title || ep.label
    const res = await player.play(decoded, title, FLIXHQ_BASE_URL, subs)
    const stopMode = res && res.stopMode ? res.stopMode : null
    const position = res && typeof res.position === 'number' ? Math.round(res.position) : 0
    if (stopMode === 'quit') {
      cfg.autoplayNext = false
      writeConfig(cfg)
      try { addHistoryEntry({ title, url: selectedUrl, season: ep.season, episode: ep.episode, label: ep.label, position }) } catch (e) {}
      return
    }
    if (stopMode === 'stop_only') {
      cfg.autoplayNext = false
      writeConfig(cfg)
    }
    if (i < episodes.length - 1) {
      if (cfg.autoplayNext) continue
      const { cont } = await inquirer.prompt([{ name: 'cont', message: 'Continue to next episode? (y/n):' }])
      if (!['y','yes',''].includes((cont||'').toLowerCase())) break
    }
  try { addHistoryEntry({ title, url: selectedUrl, season: ep.season, episode: ep.episode, label: ep.label, position }) } catch (e) {}
  }
}

async function init() {
  const ch = await inquirer.prompt([{ type: 'list', name: 'act', message: 'Action', choices: ['play', 'download', 'exit'] }])
  if (ch.act === 'play') await provideData()
  else if (ch.act === 'download') await dlData()
  else process.exit(0)
}

async function viewRecentlyWatched() {
  const hist = readHistory()
  if (!hist.length) { console.log('No recently watched entries.'); return }
  
  const byKey = {}
  for (const h of hist) {
    const key = `${h.url}::${h.season||''}::${h.episode||''}`
    if (!byKey[key] || (h.ts || 0) > (byKey[key].ts||0)) byKey[key] = h
  }
  const unique = Object.values(byKey)
  unique.forEach((h, i) => {
    const t = new Date(h.ts).toLocaleString()
    console.log(`${i+1}. ${h.title || 'Unknown'} — ${h.season?`S${h.season} `:''}${h.episode?`E${h.episode}`:''} — ${t}`)
  })
  const { pick } = await inquirer.prompt([{ name: 'pick', message: 'Select entry to resume by number (or blank to exit):' }])
  if (!pick) return
  const n = parseInt(pick,10)
  if (isNaN(n) || n < 1 || n > unique.length) return
  const entry = unique[n-1]
  
  selectedUrl = entry.url
  if (selectedUrl.includes('/movie/')) contentType = 'movie'
  else if (selectedUrl.includes('/tv/')) contentType = 'series'
  else contentType = 'unknown'
  if (contentType === 'movie') {
    await movie()
    await provideData()
    return
  }
  
  const m = selectedUrl.match(/\/tv\/[^/]*-(\d+)/)
  if (!m) { console.log('Cannot resume: invalid URL'); return }
  const mediaId = m[1]
  const seasons = await getTvSeasons(mediaId)
  let targetSeasonId = null
  if (entry.season) {
    for (const s of seasons) {
      const t = s.title.toLowerCase()
      if (t.includes(`season ${entry.season}`) || t.includes(`s${entry.season}`)) { targetSeasonId = s.id; break }
    }
    if (!targetSeasonId && entry.season <= seasons.length) targetSeasonId = seasons[entry.season-1] && seasons[entry.season-1].id
  } else {
  targetSeasonId = seasons[0].id
  }
  if (!targetSeasonId) { console.log('Cannot find season to resume'); return }
  const eps = await getSeasonEpisodes(targetSeasonId)
  const epIndex = eps.findIndex(e => String(e.episode) === String(entry.episode) || e.title && e.title.includes(String(entry.episode)))
  
  const chosenIdx = epIndex === -1 ? 0 : epIndex
  const data = await getEpisodeData(eps[chosenIdx], entry.season || 1, entry.episode || (chosenIdx+1))
  if (!data) { console.log('Could not get episode for resume'); return }
  selectedMedia = [data]
  await provideData()
}

async function showSettingsMenu() {
  const cfg = readConfig()
  while (true) {
    console.log('\nSettings:')
    console.log(`1. Autoplay next: ${cfg.autoplayNext ? 'ON' : 'OFF'}`)
    console.log(`2. Auto-transcode downloaded audio: ${cfg.autoTranscode ? 'ON' : 'OFF'}`)
    console.log(`3. Download path: ${cfg.downloadPath || '(default)'}`)
    console.log(`4. Inquirer page size: ${cfg.pageSizeDefault || 20}`)
    console.log('5. Back')
    const { choice } = await inquirer.prompt([{ name: 'choice', message: 'Enter number to toggle/change:' }])
    if (!choice) return
    const v = (choice||'').trim()
    if (v === '1') { cfg.autoplayNext = !cfg.autoplayNext; writeConfig(cfg); console.log('Autoplay next set to', cfg.autoplayNext ? 'ON' : 'OFF') }
    else if (v === '2') { cfg.autoTranscode = !cfg.autoTranscode; writeConfig(cfg); console.log('Auto-transcode set to', cfg.autoTranscode ? 'ON' : 'OFF') }
    else if (v === '3') {
      const { path: newPath } = await inquirer.prompt([{ name: 'path', message: 'Enter download path (leave blank to clear):' }])
      cfg.downloadPath = (newPath || '').trim()
      writeConfig(cfg)
      console.log('Download path set to', cfg.downloadPath || '(default)')
    } else if (v === '4') {
      const { p } = await inquirer.prompt([{ name: 'p', message: 'Enter page size (number):' }])
      const n = parseInt((p||'').trim(), 10)
      if (!Number.isNaN(n) && n > 0) { cfg.pageSizeDefault = n; writeConfig(cfg); console.log('Page size set to', n) } else console.log('Invalid number')
    } else return
  }
}

module.exports = { getId, poison, init, dlData, provideData, viewRecentlyWatched, exportHistory, clearHistory, showSettingsMenu, searchContent, getTvSeasons, getSeasonEpisodes, getEpisodeData, readConfig, determinePath }
