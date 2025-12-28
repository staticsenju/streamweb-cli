#!/usr/bin/env node
function isTermux() {
  return !!process.env.PREFIX && process.env.PREFIX.includes('/data/data/com.termux');
}
const inquirer = (require('inquirer') && require('inquirer').default) ? require('inquirer').default : require('inquirer')
const path = require('path')
const fs = require('fs')
const animeMod = require('./src/anime')
const core = require('./src/core')
const downloader = require('./src/downloader')
const { decodeUrl } = require('./src/utils')
const axios = require('axios')
const cheerio = (require('cheerio') && require('cheerio').default) ? require('cheerio').default : require('cheerio')

const FLIXHQ_BASE_URL = 'https://flixhq.to'
const FLIXHQ_AJAX_URL = `${FLIXHQ_BASE_URL}/ajax`
const activeDownloads = []
function sanitizeForFile(s) {
  return String(s||'').replace(/\s+/g, '-').replace(/"/g, '').replace(/[^a-zA-Z0-9\-_.]/g, '')
}
function htmlDecode(s) {
  if (!s) return s
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}
function normalizeEpisodeFileName(name) {
  if (!name) return name
  name = String(name).trim()
  name = name.replace(/-+/g,'-').replace(/^\-+|\-+$/g,'').replace(/\s+/g,' ').trim()
  try {
    const lead = name.match(/^(E0*\d+)\b/i)
    if (lead && /Episode[-\s]*0*\d+/i.test(name)) return lead[1]
  } catch (e) {}
  return name
}
function registerDownload(dir, baseName) {
  try {
    const mp4 = require('path').join(dir, baseName + '.mp4')
    const part = mp4 + '.part'
    activeDownloads.push({ mp4, part, dir, baseName })
    return { mp4, part }
  } catch (e) { return {} }
}
function unregisterDownload(baseName) {
  for (let i = activeDownloads.length - 1; i >= 0; i--) {
    if (activeDownloads[i].baseName === baseName) activeDownloads.splice(i,1)
  }
}
function cleanupDownloads() {
  for (const d of activeDownloads) {
    try { if (require('fs').existsSync(d.part)) require('fs').unlinkSync(d.part) } catch (e) {}
    try { if (require('fs').existsSync(d.mp4)) require('fs').unlinkSync(d.mp4) } catch (e) {}
    try {
      const files = require('fs').readdirSync(d.dir)
      for (const f of files) {
        if (f.startsWith(d.baseName) && (f.endsWith('.part') || f.endsWith('.tmp'))) {
          try { require('fs').unlinkSync(require('path').join(d.dir, f)) } catch (e) {}
        }
      }
    } catch (e) {}
  }
  activeDownloads.length = 0
}
process.on('SIGINT', () => { cleanupDownloads(); process.exit(130) })
process.on('SIGTERM', () => { cleanupDownloads(); process.exit(143) })
process.on('SIGHUP', () => { cleanupDownloads(); process.exit(129) })
process.on('exit', cleanupDownloads)
function parseArgs() {
  const argv = process.argv.slice(2)
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const k = a.replace(/^-+/, '')
      const next = argv[i+1]
      if ((k === 'season' || k === 'episode')) {
        if (!flags[k]) flags[k] = [];
        if (next && !next.startsWith('--')) { flags[k].push(next); i++; } else { flags[k].push(true); }
      } else if (k === 'f' || k === 'folder') {
        flags.folder = true;
      } else if (next && !next.startsWith('--')) { flags[k] = next; i++ } else { flags[k] = true }
    }
  }
  return flags
}

async function ensureDir(d) { try { fs.mkdirSync(d, { recursive: true }) } catch (e) {} }
function updateLine(idx, text, anime, episodeList) {
  process.stdout.write(`\x1b7`);
  process.stdout.write(`\x1b[${episodeList.length - idx}A`);
  const epName = `${htmlDecode(String(anime.title||'')).replace(/\s+/g, '-')}_E${String(episodeList[idx].ep.episode).padStart(2,'0')}`;
  process.stdout.write(`\r${epName} ${text}\x1b[K`);
  process.stdout.write(`\x1b8`);
}
async function animeFlow(flags) {
  const termux = isTermux();
  const cookie = animeMod.genCookie()
  const { q } = await inquirer.prompt([{ name: 'q', message: 'Search anime:' }])
  const query = (q||'').trim()
  if (!query) return
  const results = await animeMod.searchAnime(query, cookie)
  if (!results || !results.data || !results.data.length) { console.log('No results'); return }
  const choices = results.data.map((a, idx) => ({ name: `${idx+1}. ${htmlDecode(a.title||'')}`, value: a }))
  const cfg = (require('./src/core').readConfig && require('./src/core').readConfig()) || {}
  const { anime } = await inquirer.prompt([{ type: 'list', name: 'anime', message: 'Select anime', choices, pageSize: Math.min(choices.length, cfg.pageSizeDefault || 20) }])
  const slug = anime.session || anime.id || anime.slug
  const episodes = await animeMod.getAllEpisodes(slug, cookie)
  if (!episodes || !episodes.length) { console.log('No episodes'); return }

  let dest = flags.path || flags.out || (cfg && cfg.downloadPath) || (core.determinePath && core.determinePath());
  if (!dest) dest = path.join(__dirname, 'downloads');
  try { fs.mkdirSync(dest, { recursive: true }); } catch (e) { console.error('Failed to create output directory:', dest, e.message || e); process.exit(1); }
  console.log(`Output directory ready: ${dest}`);
  let showFolder = '';
  let seasonFolder = '';
  const rawTitle = (anime && anime.title) || '';
  const cleanedTitle = rawTitle.replace(/\(SS\s*\d+\)/i, '').trim();
  const safeTitle = cleanedTitle.replace(/\s+/g, '-').replace(/"/g, '').replace(/[^a-zA-Z0-9\-_.]/g, '');
  if (flags.folder) {
    showFolder = cleanedTitle;
    dest = path.join(dest, showFolder);
    ensureDir(dest);
  }

  if (flags.wholeshow) {
    console.log('Queueing whole show:', htmlDecode(anime.title || ''))
    const progressStates = {};
    const episodeList = episodes.map((ep, idx) => ({ ep, idx }));
    let allOpts = [];
    for (const { ep } of episodeList) {
      const playUrl = `https://animepahe.si/play/${encodeURIComponent(slug)}/${ep.session}`;
      try {
        const html = await axios.get(playUrl, { headers: { Referer: 'https://animepahe.si', Cookie: cookie } });
        const $ = cheerio.load(html.data);
        $('button[data-src]').each((_, el) => {
          const e = $(el);
          allOpts.push({ audio: (e.attr('data-audio')||'').toLowerCase(), resolution: e.attr('data-resolution')||'', src: e.attr('data-src')||'' });
        });
      } catch {}
    }
    const uniqAllOpts = Array.from(new Map(allOpts.map(o => [`${o.audio}|${o.resolution}`, o])).values());
    const optChoices = uniqAllOpts.map((o, i) => ({ name: `${i+1}. Audio: ${o.audio} Resolution: ${o.resolution}`, value: o }));
    let selectedOpt = null;
    if (optChoices.length > 0) {
      selectedOpt = (await inquirer.prompt([{ type: 'list', name: 'opt', message: `Select batch quality for all episodes`, choices: optChoices }])).opt;
    }
    for (const { ep, idx } of episodeList) {
      const epName = `${htmlDecode(String(anime.title||'')).replace(/\s+/g, '-')}_E${String(ep.episode).padStart(2,'0')}`;
      process.stdout.write(`Downloading ${epName}...\n`);
    }
    for (const { ep, idx } of episodeList) {
      let m3u8 = null;
      let refer = 'https://animepahe.si';
      let usedOpt = selectedOpt;
      let epOpts = [];
      try {
        const playUrl = `https://animepahe.si/play/${encodeURIComponent(slug)}/${ep.session}`;
        const html = await axios.get(playUrl, { headers: { Referer: 'https://animepahe.si', Cookie: cookie } });
        const $ = cheerio.load(html.data);
        $('button[data-src]').each((_, el) => {
          const e = $(el);
          epOpts.push({ audio: (e.attr('data-audio')||'').toLowerCase(), resolution: e.attr('data-resolution')||'', src: e.attr('data-src')||'' });
        });
      } catch {}
      if (usedOpt) {
        m3u8 = await animeMod.getEpisodeM3U8({ slug, episode: ep.episode, audio: usedOpt.audio, resolution: usedOpt.resolution, cookie });
      }
      if (!m3u8 && usedOpt) {
        const lowerOpts = epOpts.filter(o => o.audio === usedOpt.audio && Number(o.resolution) < Number(usedOpt.resolution)).sort((a,b)=>Number(b.resolution)-Number(a.resolution));
        for (const lowOpt of lowerOpts) {
          m3u8 = await animeMod.getEpisodeM3U8({ slug, episode: ep.episode, audio: lowOpt.audio, resolution: lowOpt.resolution, cookie });
          if (m3u8) { usedOpt = lowOpt; break; }
        }
      }
      if (!m3u8 && epOpts.length) {
        const sorted = epOpts.sort((a,b)=>Number(b.resolution)-Number(a.resolution));
        for (const opt of sorted) {
          m3u8 = await animeMod.getEpisodeM3U8({ slug, episode: ep.episode, audio: opt.audio, resolution: opt.resolution, cookie });
          if (m3u8) { usedOpt = opt; break; }
        }
      }
      if (!m3u8) { updateLine(idx, `Unable to download ep ${ep.episode}: no available stream`, anime, episodeList); continue; }
      try { if (/kwik|owocdn|vidcloud|vault|vidcdn|vidstream/i.test(m3u8)) refer = 'https://kwik.cx'; } catch (e) {}
      const rawTitle = htmlDecode(anime.title || slug);
      const cleanedTitle = rawTitle.replace(/\(SS\s*\d+\)/i, '').trim();
      const safeTitle = cleanedTitle.replace(/\s+/g, '-').replace(/"/g, '').replace(/[^a-zA-Z0-9\-_.]/g, '');
      let fileName;
      if (flags.folder) {
        let epTitle = htmlDecode((ep.title || '')).trim();
        let match = epTitle.match(/^(Ep|Eps)[-\s]*([0-9]+)/i);
        if (epTitle && match) {
          const epNum = match[2];
          let rest = epTitle.replace(match[0], '');
          rest = rest.replace(/^[-\s]+/, '');
          rest = rest.replace(/^[-]+/, '');
          if (flags.folderName) {
            rest = rest.replace(/[^a-zA-Z0-9 \-_.]/g, '');
            fileName = rest ? `E${epNum} ${rest}` : `E${epNum}`;
          } else {
            rest = rest.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9\-_.]/g, '');
            fileName = rest ? `E${epNum}-${rest}` : `E${epNum}`;
          }
        } else if (epTitle) {
          if (flags.folderName) {
            epTitle = epTitle.replace(/[^a-zA-Z0-9 \-_.]/g, '');
            let epNum = (ep.episode != null && ep.episode !== undefined) ? String(ep.episode).padStart(2,'0') : '';
            fileName = epNum ? `E${epNum} ${epTitle}` : epTitle;
          } else {
            epTitle = epTitle.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9\-_.]/g, '');
            let epNum = (ep.episode != null && ep.episode !== undefined) ? String(ep.episode).padStart(2,'0') : '';
            fileName = epNum ? `E${epNum}-${epTitle}` : epTitle;
          }
        } else {
          let epNum = (ep.episode != null && ep.episode !== undefined) ? String(ep.episode).padStart(2,'0') : '';
          fileName = epNum ? `E${epNum}` : 'E';
        }
      } else {
        let epNum = (ep.episode != null && ep.episode !== undefined) ? String(ep.episode).padStart(2,'0') : '';
        fileName = epNum ? `${safeTitle}_E${epNum}` : safeTitle;
      }
      const cfgCore = core.readConfig();
      const recode = (flags.transcode || flags.recode) ? true : (cfgCore && cfgCore.autoTranscode);
      let episodeDest = dest;
      fileName = normalizeEpisodeFileName(String(fileName || ''))
      const _base = sanitizeForFile(fileName)
      const _reg = registerDownload(episodeDest, _base)
      let outPath = path.join(episodeDest, fileName + '.mp4');
      let subCount = 0;
      try {
        const result = await downloader.download(episodeDest, fileName, m3u8, refer, {
          recodeAudio: !!recode,
          subtitles: (subs && subs.length) ? subs : undefined,
          progressCallback: (pct, msg) => {
            updateLine(idx, `[${'█'.repeat(Math.round((pct/100)*40)).padEnd(40,'-')}] ${pct.toFixed(1)}% ${msg||''}`, anime, episodeList);
          }
        });
        if (result && result.subtitles) subCount = result.subtitles.length;
      } finally { unregisterDownload(_base) }
      updateLine(idx, `[${'█'.repeat(40)}] 100% Done`, anime, episodeList);
      console.log(`Saved: ${outPath}`);
      console.log(`Subtitle tracks: ${subCount}`);
      if (flags.autoplay && !termux) {
        try {
          const open = require('open');
          await open(outPath, { wait: false });
        } catch (e) {}
      } else if (flags.autoplay && termux) {
        console.log('Autoplay is not supported in Termux. Please open the file manually with mpv or your preferred player.');
      }
    }
    return
  }

  let targets = []
  if (flags.ep) {
    let epnums = Array.isArray(flags.ep) ? flags.ep : [flags.ep]
    for (const epnum of epnums) {
      if (typeof epnum === 'string' && epnum.includes('-')) {
        const [start, end] = epnum.split('-', 2).map(x => parseInt(x, 10))
        for (let i = start; i <= end; i++) {
          const found = episodes.find(ep => Number(ep.episode) === i)
          if (found) targets.push(found)
        }
      } else {
        const n = parseInt(epnum, 10)
        const found = episodes.find(ep => Number(ep.episode) === n)
        if (found) targets.push(found)
      }
    }
  }
  if (!flags.ep || targets.length === 0) {
    const epChoices = episodes.map((ep) => ({ name: `Episode ${ep.episode}${ep.filler? ' (filler)':''}`, value: ep }))
    const { pick } = await inquirer.prompt([{ type: 'list', name: 'pick', message: 'Select episode or choose range', choices: [...epChoices, { name: 'Enter range (e.g. 1-5)', value: 'range' }], pageSize: Math.min(epChoices.length, cfg.pageSizeDefault || 20) }])
    if (pick === 'range') {
      const { r } = await inquirer.prompt([{ name: 'r', message: 'Range:' }])
      const pr = (r||'').trim()
      if (pr.includes('-')) {
        const [s,e] = pr.split('-',2).map(x=>parseInt(x,10))
        for (let i=s;i<=e;i++) targets.push(episodes.find(ep=>Number(ep.episode)===i))
      } else {
        const n = parseInt(pr,10)
        targets.push(episodes.find(ep=>Number(ep.episode)===n))
      }
    } else {
      targets.push(pick)
    }
  }
  targets = targets.filter(Boolean)
  for (const ep of targets.filter(Boolean)) {
    let allOpts = [];
    const playUrl = `https://animepahe.si/play/${encodeURIComponent(slug)}/${ep.session}`;
    try {
      const html = await axios.get(playUrl, { headers: { Referer: 'https://animepahe.si', Cookie: cookie } });
      const $ = cheerio.load(html.data);
      $('button[data-src]').each((_, el) => {
        const e = $(el);
        allOpts.push({ audio: (e.attr('data-audio')||'').toLowerCase(), resolution: e.attr('data-resolution')||'', src: e.attr('data-src')||'' });
      });
    } catch {}
    const uniqAllOpts = Array.from(new Map(allOpts.map(o => [`${o.audio}|${o.resolution}`, o])).values());
    const optChoices = uniqAllOpts.map((o, i) => ({ name: `${i+1}. Audio: ${o.audio} Resolution: ${o.resolution}`, value: o }));
    let selectedOpt = null;
    if (optChoices.length > 0) {
      selectedOpt = (await inquirer.prompt([{ type: 'list', name: 'opt', message: `Select quality for episode ${ep.episode}`, choices: optChoices }])).opt;
    }
    let m3u8 = null;
    let refer = 'https://animepahe.si';
    let usedOpt = selectedOpt;
    let epOpts = allOpts;
    if (usedOpt) {
      m3u8 = await animeMod.getEpisodeM3U8({ slug, episode: ep.episode, audio: usedOpt.audio, resolution: usedOpt.resolution, cookie });
    }
    if (!m3u8 && usedOpt) {
      const lowerOpts = epOpts.filter(o => o.audio === usedOpt.audio && Number(o.resolution) < Number(usedOpt.resolution)).sort((a,b)=>Number(b.resolution)-Number(a.resolution));
      for (const lowOpt of lowerOpts) {
        m3u8 = await animeMod.getEpisodeM3U8({ slug, episode: ep.episode, audio: lowOpt.audio, resolution: lowOpt.resolution, cookie });
        if (m3u8) { usedOpt = lowOpt; break; }
      }
    }
    if (!m3u8 && epOpts.length) {
      const sorted = epOpts.sort((a,b)=>Number(b.resolution)-Number(a.resolution));
      for (const opt of sorted) {
        m3u8 = await animeMod.getEpisodeM3U8({ slug, episode: ep.episode, audio: opt.audio, resolution: opt.resolution, cookie });
        if (m3u8) { usedOpt = opt; break; }
      }
    }
    if (!m3u8) { console.log('Could not get stream for ep', ep.episode); continue }
    try { if (/kwik|owocdn|vidcloud|vault|vidcdn|vidstream/i.test(m3u8)) refer = 'https://kwik.cx' } catch (e) {}
    const rawTitle = htmlDecode(anime.title || slug)
    const cleanedTitle = rawTitle.replace(/\(SS\s*\d+\)/i, '').trim();
    const safeTitle = cleanedTitle.replace(/\s+/g, '-').replace(/"/g, '').replace(/[^a-zA-Z0-9\-_.]/g, '')
    let fileName;
    if (flags.folder) {
      let epTitle = htmlDecode((ep.title || '')).trim();
      if (epTitle) {
        epTitle = epTitle.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9\-_.]/g, '');
        fileName = `E${String(ep.episode).padStart(2,'0')}-${epTitle}`;
      } else {
        fileName = `E${String(ep.episode).padStart(2,'0')}`;
      }
    } else {
      fileName = `${safeTitle}_E${String(ep.episode).padStart(2,'0')}`;
    }
    const cfgCore = core.readConfig()
    const recode = (flags.transcode || flags.recode) ? true : (cfgCore && cfgCore.autoTranscode)
    fileName = normalizeEpisodeFileName(String(fileName || ''))
    const _base = sanitizeForFile(fileName)
    registerDownload(dest, _base)
    try { await downloader.download(dest, fileName, m3u8, refer, { recodeAudio: !!recode }) } finally { unregisterDownload(_base) }
  }
}

async function seriesFlow(flags) {
  const sel = await core.searchContent(await (async function getQuery(){ const { q } = await inquirer.prompt([{ name:'q', message: 'Search show:' }]); return q })(), 'series')
  if (!sel) return
  const selectedUrl = sel
  if (!selectedUrl.includes('/tv/')) { console.log('Selected content is not a TV series'); return }
  const m = selectedUrl.match(/\/tv\/[^/]*-(\d+)/)
  if (!m) { console.log('Cannot extract media id'); return }
  const mediaId = m[1]
  const seasons = await core.getTvSeasons(mediaId)
  if (!seasons || !seasons.length) { console.log('No seasons'); return }
  const cfg = core.readConfig()
  const seasonChoices = seasons.map((s,i)=>({ name: `${i+1}. ${htmlDecode(s.title || '')}`, value: i }))
  let targetSeasons = [];
  if (flags.season) {
    const sn = Array.isArray(flags.season) ? flags.season : [flags.season];
    for (const s of sn) {
      const idx = Number(s)-1;
      if (idx >= 0 && idx < seasons.length) targetSeasons.push(seasons[idx]);
    }
  } else if (flags.wholeshow) {
    targetSeasons = seasons;
  }
  if (targetSeasons.length) {
    for (const seasonObj of targetSeasons) {
      const eps = await core.getSeasonEpisodes(seasonObj.id)
      let targetEpisodes = eps;
      if (flags.episode) {
        const epnums = Array.isArray(flags.episode) ? flags.episode : [flags.episode];
        targetEpisodes = eps.filter(e => epnums.includes(String(e.episode)) || epnums.includes(Number(e.episode)));
      }
      
      let showSlug = '';
      try { const u = new URL(selectedUrl); const segs = (u.pathname||'').split('/').filter(Boolean); showSlug = segs[1] || segs[0] || '' } catch (e) {}
      showSlug = htmlDecode(String(showSlug)).replace(/-\d+$/,'').replace(/^watch[-_\s]*/i,'')
      let showFolder = showSlug.replace(/[-_]+/g,' ').trim();
      showFolder = htmlDecode(showFolder)
      if (!showFolder) showFolder = 'Show';
      showFolder = showFolder.split(/\s+/).map(s=>s.charAt(0).toUpperCase()+s.slice(1)).join(' ');
      
      let seasonFolder = (seasonObj.title || '').toString().trim();
      if (!/^season/i.test(seasonFolder)) seasonFolder = `Season ${seasonFolder}`;
      let baseDest = flags.path || flags.out || core.determinePath();
      for (const ep of targetEpisodes) {
        
        let dest = baseDest;
        if (flags.folder) {
          dest = path.join(baseDest, showFolder, seasonFolder);
          ensureDir(dest);
        }
        try {
          const data = await core.getEpisodeData(ep, seasonObj.title, ep.episode)
          if (!data) continue
          const [decoded, subs] = await decodeUrl(data.file)
          let refer = decoded && /kwik|owocdn|vidcloud|vault|vidcdn|vidstream/i.test(decoded) ? 'https://kwik.cx' : 'https://flixhq.to'
          let fileName;
          if (flags.folder) {
            let epTitle = htmlDecode((ep.title || '')).trim();
            let match = epTitle.match(/^(Ep|Eps)[-\s]*([0-9]+)/i);
            if (epTitle && match) {
              const epNum = match[2];
              let rest = epTitle.replace(match[0], '').replace(/^[-\s]+/, '');
              rest = rest.replace(/^[-]+/, '');
              rest = rest.replace(/[^a-zA-Z0-9 \-_.]/g, '');
              fileName = rest ? `E${epNum} ${rest}` : `E${epNum}`;
            } else if (epTitle) {
              epTitle = epTitle.replace(/[^a-zA-Z0-9 \-_.]/g, '');
              let epNum = (ep.episode != null && ep.episode !== undefined) ? String(ep.episode).padStart(2,'0') : '';
              fileName = epNum ? `E${epNum} ${epTitle}` : epTitle;
            } else {
              let epNum = (ep.episode != null && ep.episode !== undefined) ? String(ep.episode).padStart(2,'0') : '';
              fileName = epNum ? `E${epNum}` : 'E';
            }
          } else {
            const title = data.label || `S${seasonObj.title}E${ep.episode}`;
            const safeTitle = title.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9\-_.]/g, '');
            fileName = safeTitle;
          }
          const recode = (flags.transcode || flags.recode) ? true : (cfg && cfg.autoTranscode);
          fileName = normalizeEpisodeFileName(String(fileName || ''))
          const _base = sanitizeForFile(fileName)
          console.log(`Starting download`)
          registerDownload(dest, _base)
          let outPath = path.join(dest, fileName + '.mp4');
          let subCount = 0;
          try {
              const result = await downloader.download(dest, fileName, decoded, refer, {
                recodeAudio: !!recode,
                subtitles: (flags.s && subs && subs.length) ? subs : undefined
              });
            if (result && result.subtitles) subCount = result.subtitles.length;
          } finally { unregisterDownload(_base) }
          console.log(`Saved: ${outPath}`);
          console.log(`Subtitle tracks: ${subCount}`);
        } catch (e) { console.error('Failed download', e && e.message || e) }
      }
    }
    return
  }

  const { seasonIdx } = await inquirer.prompt([{ type: 'list', name: 'seasonIdx', message: 'Select season to download', choices: seasonChoices, pageSize: Math.min(seasonChoices.length, cfg.pageSizeDefault || 20) }])
  const targetSeason = seasons[seasonIdx]
  const eps = await core.getSeasonEpisodes(targetSeason.id)
  let baseDest = flags.path || flags.out || (cfg && cfg.downloadPath) || (core.determinePath && core.determinePath());
  if (!baseDest) baseDest = path.join(__dirname, 'downloads');
  try { fs.mkdirSync(baseDest, { recursive: true }) } catch (e) {}
  let dest = baseDest
  if (flags.folder) {
    try {
      const u = new URL(selectedUrl)
      const segs = (u.pathname || '').split('/').filter(Boolean)
      let showSlug = segs[1] || segs[0] || ''
      
      showSlug = htmlDecode(String(showSlug || ''))
        .replace(/-\d+$/,'')
        .replace(/^watch[-_\s]*/i,'')
        .replace(/[-_]+/g,' ')
        .trim()
      if (!showSlug) showSlug = 'Show'
      
      const showFolder = showSlug.split(/\s+/).map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' ')
      
      let seasonFolder = (targetSeason.title || (seasonIdx+1)).toString().trim()
      if (!/^season/i.test(seasonFolder)) seasonFolder = `Season ${seasonFolder}`
      dest = path.join(baseDest, showFolder, seasonFolder)
      fs.mkdirSync(dest, { recursive: true })
      console.log(`Created/using folder for downloads: ${dest}`)
    } catch (e) { console.error('Could not create show/season folder:', e && e.message || e) }
  }
  const epChoices = eps.map((ep,i)=>({ name: `${i+1}. ${htmlDecode(ep.title || `Episode ${i+1}`)}`, value: i }))
  const { epSelect } = await inquirer.prompt([{ type: 'list', name: 'epSelect', message: 'Select episode or choose range', choices: [...epChoices, { name: 'Enter range', value: 'range' }], pageSize: Math.min(epChoices.length+1, cfg.pageSizeDefault || 20) }])
  let targets = []
  if (epSelect === 'range') {
    const { r } = await inquirer.prompt([{ name: 'r', message: 'Range (e.g. 1-5):' }])
    const pr = (r||'').trim()
    if (pr.includes('-')) {
      const [s,e] = pr.split('-',2).map(x=>parseInt(x,10))
      for (let i=s;i<=e;i++) targets.push(eps[i-1])
    } else {
      const n = parseInt(pr,10)
      targets.push(eps[n-1])
    }
  } else targets.push(eps[epSelect])

  
  for (const t of targets.filter(Boolean)) {
    try {
      const data = await core.getEpisodeData(t, seasonIdx+1, t.episode || (epChoices.indexOf(t)+1))
      if (!data) { console.log('No data for ep'); continue }
      const [decoded, subs] = await decodeUrl(data.file)
      let refer = decoded && /kwik|owocdn|vidcloud|vault|vidcdn|vidstream/i.test(decoded) ? 'https://kwik.cx' : 'https://flixhq.to'
      let fileName;
      if (flags.folder) {
        let epTitle = htmlDecode((t.title || '')).trim();
        let match = epTitle.match(/^(Ep|Eps)[-\s]*([0-9]+)/i);
        if (epTitle && match) {
          const epNum = match[2];
          let rest = epTitle.replace(match[0], '');
          rest = rest.replace(/^[-\s]+/, '');
          rest = rest.replace(/^[-]+/, '');
          if (flags.folderName) {
            rest = rest.replace(/[^a-zA-Z0-9 \-_.]/g, '');
            fileName = rest ? `E${epNum} ${rest}` : `E${epNum}`;
          } else {
            rest = rest.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9\-_.]/g, '');
            fileName = rest ? `E${epNum}-${rest}` : `E${epNum}`;
          }
        } else if (epTitle) {
          if (flags.folderName) {
            epTitle = epTitle.replace(/[^a-zA-Z0-9 \-_.]/g, '');
            let epNum = (t.episode != null && t.episode !== undefined) ? String(t.episode).padStart(2,'0') : '';
            fileName = epNum ? `E${epNum} ${epTitle}` : epTitle;
          } else {
            epTitle = epTitle.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9\-_.]/g, '');
            let epNum = (t.episode != null && t.episode !== undefined) ? String(t.episode).padStart(2,'0') : '';
            fileName = epNum ? `E${epNum}-${epTitle}` : epTitle;
          }
        } else {
          let epNum = (t.episode != null && t.episode !== undefined) ? String(t.episode).padStart(2,'0') : '';
          fileName = epNum ? `E${epNum}` : 'E';
        }
      } else {
        const title = data.label || `S${seasonIdx+1}E${t.episode || '??'}`;
        const safeTitle = title.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9\-_.]/g, '');
        fileName = safeTitle;
      }
      fileName = normalizeEpisodeFileName(String(fileName || ''))
      const _base = sanitizeForFile(fileName)
      console.log(`Starting download -> dest: ${dest}, file: ${fileName}.mp4`)
      registerDownload(dest, _base)
      try { await downloader.download(dest, fileName, decoded, refer, { recodeAudio: cfg && cfg.autoTranscode, subtitles: (flags.s && subs && subs.length) ? subs : undefined }); } finally { unregisterDownload(_base) }
    } catch (e) { console.error('Failed:', e && e.message || e) }
  }
}

async function movieFlow(flags) {
  const { q } = await inquirer.prompt([{ name: 'q', message: 'Search movie:' }])
  const query = (q||'').trim()
  if (!query) return
    const sel = await core.searchContent(query, 'movie')
    if (!sel) return
    const selectedUrl = sel
    let displayTitle = null;
    try {
      const match = sel.match(/\/([^/]+)-\d+$/);
      if (match) {
        const params = query.replace(/\s+/g, '-');
        const url = `${FLIXHQ_BASE_URL}/search/${params}`;
        const resp = await axios.get(url, { headers: { 'User-Agent': `flix-cli/1.0.0` } });
        const $ = cheerio.load(resp.data);
        const items = $('.flw-item');
        items.each((i, el) => {
          const poster = $(el).find('.film-poster a');
          const href = new URL(poster.attr('href') || '', FLIXHQ_BASE_URL).toString();
          if (href === selectedUrl) {
            const titleElem = $(el).find('.film-detail h2.film-name a');
            const info = $(el).find('.fd-infor span');
            const title = titleElem.attr('title') || titleElem.text() || 'Unknown Title';
            displayTitle = htmlDecode(title);
            if (info && info.length) displayTitle += ` (${htmlDecode($(info[0]).text().trim())})`;
          }
        });
      }
    } catch (e) {}
  const m = selectedUrl.match(/\/movie\/[^/]*-(\d+)/)
  if (!m) { console.log('Could not extract media id from URL'); return }
  const mediaId = m[1]
  const { getEmbedLinkForMovie, findVidcloudFromMovieId } = require('./src/dl_helpers')
  let pageTitle = null
  try {
    const p = await axios.get(selectedUrl)
    const $ = cheerio.load(p.data)
    pageTitle = ($('.film-detail h2.film-name a').text() || $('.film-detail h2.film-name a').attr('title') || $('title').text())
    function cleanPageTitle(t) {
      if (!t) return t
      let s = String(t)
      s = s.replace(/\u00A0/g, ' ')
      s = s.replace(/^\s+|\s+$/g, '')
      s = s.replace(/^watch[\s:-_.]+/i, '')
      s = s.replace(/[-\s]*flixhq.*$/i, '')
      s = s.replace(/[-\s]*hd[-\s]*online[-\s]*free.*$/i, '')
      s = s.replace(/[-\s]*hd.*$/i, '')
      s = s.replace(/[-\s]*online[-\s]*free.*$/i, '')
      s = s.replace(/[-\s]*online.*$/i, '')
      s = s.replace(/[-\s]*free.*$/i, '')
      s = s.replace(/\b(HD|Online|Free|Watch)\b/ig, '')
      s = s.replace(/[^a-zA-Z0-9\s:\-()]/g, '')
      s = s.replace(/[\s:\-()]+/g, ' ').trim()
      return s
    }
    pageTitle = cleanPageTitle(pageTitle)
    if (!pageTitle || pageTitle.trim().length < 4 || /^\d{3,4}$/.test(pageTitle.trim())) {
      try {
        const u = new URL(selectedUrl)
        const seg = (u.pathname || '').split('/').filter(Boolean).pop() || ''
        let slugGuess = seg.replace(/-\d+$/,'')
        slugGuess = slugGuess.replace(/[-_]+/g, ' ')
        slugGuess = slugGuess.replace(/\b(movie|the)\b/ig, '')
        slugGuess = slugGuess.replace(/\s+/g,' ').trim()
        if (slugGuess && slugGuess.length >= 3) pageTitle = slugGuess
      } catch (e) {}
    }
  } catch (e) {}
  const vidLink = await findVidcloudFromMovieId(mediaId)
  if (!vidLink) { console.log('Could not find Vidcloud link for this movie'); return }
  const moviePage = new URL(vidLink, FLIXHQ_BASE_URL).toString()
  const epMatch = moviePage.match(/-(\d+)\.(\d+)$/)
  if (!epMatch) { console.log('Could not extract episode id from movie page'); return }
  const episodeId = epMatch[2]
  const embed = await getEmbedLinkForMovie(episodeId)
  if (!embed) { console.log('Could not get movie embed link'); return }
  const [decoded, subs] = await decodeUrl(embed)
  const cfg = core.readConfig()
  const dest = flags.path || flags.out || cfg.downloadPath || core.determinePath()
  let refer = FLIXHQ_BASE_URL
  try { if (/kwik|owocdn|vidcloud|vault|vidcdn|vidstream/i.test(decoded)) refer = 'https://kwik.cx' } catch (e) {}
  const recode = (flags.transcode || flags.recode) ? true : (cfg && cfg.autoTranscode)

  const title = (displayTitle && displayTitle.trim()) ? displayTitle.trim() : (pageTitle && pageTitle.trim()) ? pageTitle.trim() : ((decoded && typeof decoded === 'string') ? path.basename(decoded).split('?')[0] : `movie_${mediaId}`);
  const safeTitle = title.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9\-_.]/g, '').replace(/-+/g,'-').replace(/^-|-$/g,'');
  const _base = sanitizeForFile(normalizeEpisodeFileName(safeTitle))
  registerDownload(dest, _base)
  try { await downloader.download(dest, safeTitle, decoded, refer, { recodeAudio: !!recode, subtitles: (flags.s && subs && subs.length) ? subs : undefined }); } finally { unregisterDownload(_base) }
  console.log('Movie download complete — saved as', title + '.mp4');
}

async function main() {
  const flags = parseArgs()
  if (flags.anime) return await animeFlow(flags)
  if (flags.tv || flags.series || flags.mtv) return await seriesFlow(flags)
  if (flags.movie || flags.m) return await movieFlow(flags)
  if (isTermux()) {
    console.log('Termux detected: All features (download, playback, etc.) are supported if mpv/ffmpeg are installed. Autoplay is disabled by default.');
  }
  console.log('Usage: dl [options]')
  console.log('  --anime           Download anime (interactive)')
  console.log('    --all           Download all episodes (batch)')
  console.log('    --ep <n|n-n>    Download episode n or range n-n (repeatable)')
  console.log('    --aac           Re-encode audio to AAC')
  console.log('    --out <dir>     Output directory (default: ./downloads)')
  console.log('    --f, --folder   Organize downloads into a folder named after the anime, filenames like E05-Episode-Title.mp4')
  console.log('  --tv, --series    Download TV series (interactive)')
  console.log('    --all           Download all seasons/episodes')
  console.log('    --season <n>    Download only season n (repeatable)')
  console.log('    --ep <n>        Download only episode n (repeatable)')
  console.log('    --aac           Re-encode audio to AAC')
  console.log('    --out <dir>     Output directory (default: ./downloads)')
  console.log('    --f, --folder   Organize downloads into a folder named after the show, filenames like E05-Episode-Title.mp4')
  console.log('    --s              Download and embed available subtitles into the MP4')
  console.log('  --movie, -m       Download a movie (interactive)')
  console.log('    --aac           Re-encode audio to AAC')
  console.log('    --out <dir>     Output directory (default: ./downloads)')
  console.log('    --f, --folder   Organize download into a folder named after the movie')
  console.log('    --s              Download and embed available subtitles into the MP4')
  console.log('')
  console.log('With --folder, filenames are E{num}-{title}.mp4 if the episode/movie title is available, or just E{num}.mp4 otherwise. No show or season is included in the filename when --folder is used.')
  console.log('If --out is not specified, downloads go to ./downloads by default.')
}
main().catch(e=>{ console.error(e && e.stack || e); process.exit(1) })
#!/usr/bin/env node
function isTermux() {
  return !!process.env.PREFIX && process.env.PREFIX.includes('/data/data/com.termux');
}
const inquirer = (require('inquirer') && require('inquirer').default) ? require('inquirer').default : require('inquirer')
const path = require('path')
const fs = require('fs')
const animeMod = require('./src/anime')
const core = require('./src/core')
const downloader = require('./src/downloader')
const { decodeUrl } = require('./src/utils')
const axios = require('axios')
const cheerio = (require('cheerio') && require('cheerio').default) ? require('cheerio').default : require('cheerio')

const FLIXHQ_BASE_URL = 'https://flixhq.to'
const FLIXHQ_AJAX_URL = `${FLIXHQ_BASE_URL}/ajax`
const activeDownloads = []
function sanitizeForFile(s) {
  return String(s||'').replace(/\s+/g, '-').replace(/"/g, '').replace(/[^a-zA-Z0-9\-_.]/g, '')
}
function htmlDecode(s) {
  if (!s) return s
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}
function normalizeEpisodeFileName(name) {
  if (!name) return name
  name = String(name).trim()
  name = name.replace(/-+/g,'-').replace(/^\-+|\-+$/g,'').replace(/\s+/g,' ').trim()
  try {
    const lead = name.match(/^(E0*\d+)\b/i)
    if (lead && /Episode[-\s]*0*\d+/i.test(name)) return lead[1]
  } catch (e) {}
  return name
}
function registerDownload(dir, baseName) {
  try {
    const mp4 = require('path').join(dir, baseName + '.mp4')
    const part = mp4 + '.part'
    activeDownloads.push({ mp4, part, dir, baseName })
    return { mp4, part }
  } catch (e) { return {} }
}
function unregisterDownload(baseName) {
  for (let i = activeDownloads.length - 1; i >= 0; i--) {
    if (activeDownloads[i].baseName === baseName) activeDownloads.splice(i,1)
  }
}
function cleanupDownloads() {
  for (const d of activeDownloads) {
    try { if (require('fs').existsSync(d.part)) require('fs').unlinkSync(d.part) } catch (e) {}
    try { if (require('fs').existsSync(d.mp4)) require('fs').unlinkSync(d.mp4) } catch (e) {}
    try {
      const files = require('fs').readdirSync(d.dir)
      for (const f of files) {
        if (f.startsWith(d.baseName) && (f.endsWith('.part') || f.endsWith('.tmp'))) {
          try { require('fs').unlinkSync(require('path').join(d.dir, f)) } catch (e) {}
        }
      }
    } catch (e) {}
  }
  activeDownloads.length = 0
}
process.on('SIGINT', () => { cleanupDownloads(); process.exit(130) })
process.on('SIGTERM', () => { cleanupDownloads(); process.exit(143) })
process.on('SIGHUP', () => { cleanupDownloads(); process.exit(129) })
process.on('exit', cleanupDownloads)
function parseArgs() {
  const argv = process.argv.slice(2)
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const k = a.replace(/^-+/, '')
      const next = argv[i+1]
      if ((k === 'season' || k === 'episode')) {
        if (!flags[k]) flags[k] = [];
        if (next && !next.startsWith('--')) { flags[k].push(next); i++; } else { flags[k].push(true); }
      } else if (k === 'f' || k === 'folder') {
        flags.folder = true;
      } else if (next && !next.startsWith('--')) { flags[k] = next; i++ } else { flags[k] = true }
    }
  }
  return flags
}

async function ensureDir(d) { try { fs.mkdirSync(d, { recursive: true }) } catch (e) {} }
function updateLine(idx, text, anime, episodeList) {
  process.stdout.write(`\x1b7`);
  process.stdout.write(`\x1b[${episodeList.length - idx}A`);
  const epName = `${htmlDecode(String(anime.title||'')).replace(/\s+/g, '-')}_E${String(episodeList[idx].ep.episode).padStart(2,'0')}`;
  process.stdout.write(`\r${epName} ${text}\x1b[K`);
  process.stdout.write(`\x1b8`);
}
async function animeFlow(flags) {
  const termux = isTermux();
  const cookie = animeMod.genCookie()
  const { q } = await inquirer.prompt([{ name: 'q', message: 'Search anime:' }])
  const query = (q||'').trim()
  if (!query) return
  const results = await animeMod.searchAnime(query, cookie)
  if (!results || !results.data || !results.data.length) { console.log('No results'); return }
  const choices = results.data.map((a, idx) => ({ name: `${idx+1}. ${htmlDecode(a.title||'')}`, value: a }))
  const cfg = (require('./src/core').readConfig && require('./src/core').readConfig()) || {}
  const { anime } = await inquirer.prompt([{ type: 'list', name: 'anime', message: 'Select anime', choices, pageSize: Math.min(choices.length, cfg.pageSizeDefault || 20) }])
  const slug = anime.session || anime.id || anime.slug
  const episodes = await animeMod.getAllEpisodes(slug, cookie)
  if (!episodes || !episodes.length) { console.log('No episodes'); return }

  let dest = flags.path || flags.out || (cfg && cfg.downloadPath) || (core.determinePath && core.determinePath());
  if (!dest) dest = path.join(__dirname, 'downloads');
  try { fs.mkdirSync(dest, { recursive: true }); } catch (e) { console.error('Failed to create output directory:', dest, e.message || e); process.exit(1); }
  console.log(`Output directory ready: ${dest}`);
  let showFolder = '';
  let seasonFolder = '';
  const rawTitle = (anime && anime.title) || '';
  const cleanedTitle = rawTitle.replace(/\(SS\s*\d+\)/i, '').trim();
  const safeTitle = cleanedTitle.replace(/\s+/g, '-').replace(/"/g, '').replace(/[^a-zA-Z0-9\-_.]/g, '');
  if (flags.folder) {
    showFolder = cleanedTitle;
    dest = path.join(dest, showFolder);
    ensureDir(dest);
  }

  if (flags.wholeshow) {
    console.log('Queueing whole show:', htmlDecode(anime.title || ''))
    const progressStates = {};
    const episodeList = episodes.map((ep, idx) => ({ ep, idx }));
    let allOpts = [];
    for (const { ep } of episodeList) {
      const playUrl = `https://animepahe.si/play/${encodeURIComponent(slug)}/${ep.session}`;
      try {
        const html = await axios.get(playUrl, { headers: { Referer: 'https://animepahe.si', Cookie: cookie } });
        const $ = cheerio.load(html.data);
        $('button[data-src]').each((_, el) => {
          const e = $(el);
          allOpts.push({ audio: (e.attr('data-audio')||'').toLowerCase(), resolution: e.attr('data-resolution')||'', src: e.attr('data-src')||'' });
        });
      } catch {}
    }
    const uniqAllOpts = Array.from(new Map(allOpts.map(o => [`${o.audio}|${o.resolution}`, o])).values());
    const optChoices = uniqAllOpts.map((o, i) => ({ name: `${i+1}. Audio: ${o.audio} Resolution: ${o.resolution}`, value: o }));
    let selectedOpt = null;
    if (optChoices.length > 0) {
      selectedOpt = (await inquirer.prompt([{ type: 'list', name: 'opt', message: `Select batch quality for all episodes`, choices: optChoices }])).opt;
    }
    for (const { ep, idx } of episodeList) {
      const epName = `${htmlDecode(String(anime.title||'')).replace(/\s+/g, '-')}_E${String(ep.episode).padStart(2,'0')}`;
      process.stdout.write(`Downloading ${epName}...\n`);
    }
    for (const { ep, idx } of episodeList) {
      let m3u8 = null;
      let refer = 'https://animepahe.si';
      let usedOpt = selectedOpt;
      let epOpts = [];
      try {
        const playUrl = `https://animepahe.si/play/${encodeURIComponent(slug)}/${ep.session}`;
        const html = await axios.get(playUrl, { headers: { Referer: 'https://animepahe.si', Cookie: cookie } });
        const $ = cheerio.load(html.data);
        $('button[data-src]').each((_, el) => {
          const e = $(el);
          epOpts.push({ audio: (e.attr('data-audio')||'').toLowerCase(), resolution: e.attr('data-resolution')||'', src: e.attr('data-src')||'' });
        });
      } catch {}
      if (usedOpt) {
        m3u8 = await animeMod.getEpisodeM3U8({ slug, episode: ep.episode, audio: usedOpt.audio, resolution: usedOpt.resolution, cookie });
      }
      if (!m3u8 && usedOpt) {
        const lowerOpts = epOpts.filter(o => o.audio === usedOpt.audio && Number(o.resolution) < Number(usedOpt.resolution)).sort((a,b)=>Number(b.resolution)-Number(a.resolution));
        for (const lowOpt of lowerOpts) {
          m3u8 = await animeMod.getEpisodeM3U8({ slug, episode: ep.episode, audio: lowOpt.audio, resolution: lowOpt.resolution, cookie });
          if (m3u8) { usedOpt = lowOpt; break; }
        }
      }
      if (!m3u8 && epOpts.length) {
        const sorted = epOpts.sort((a,b)=>Number(b.resolution)-Number(a.resolution));
        for (const opt of sorted) {
          m3u8 = await animeMod.getEpisodeM3U8({ slug, episode: ep.episode, audio: opt.audio, resolution: opt.resolution, cookie });
          if (m3u8) { usedOpt = opt; break; }
        }
      }
      if (!m3u8) { updateLine(idx, `Unable to download ep ${ep.episode}: no available stream`, anime, episodeList); continue; }
      try { if (/kwik|owocdn|vidcloud|vault|vidcdn|vidstream/i.test(m3u8)) refer = 'https://kwik.cx'; } catch (e) {}
      const rawTitle = htmlDecode(anime.title || slug);
      const cleanedTitle = rawTitle.replace(/\(SS\s*\d+\)/i, '').trim();
      const safeTitle = cleanedTitle.replace(/\s+/g, '-').replace(/"/g, '').replace(/[^a-zA-Z0-9\-_.]/g, '');
      let fileName;
      if (flags.folder) {
        let epTitle = htmlDecode((ep.title || '')).trim();
        let match = epTitle.match(/^(Ep|Eps)[-\s]*([0-9]+)/i);
        if (epTitle && match) {
          const epNum = match[2];
          let rest = epTitle.replace(match[0], '');
          rest = rest.replace(/^[-\s]+/, '');
          rest = rest.replace(/^[-]+/, '');
          if (flags.folderName) {
            rest = rest.replace(/[^a-zA-Z0-9 \-_.]/g, '');
            fileName = rest ? `E${epNum} ${rest}` : `E${epNum}`;
          } else {
            rest = rest.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9\-_.]/g, '');
            fileName = rest ? `E${epNum}-${rest}` : `E${epNum}`;
          }
        } else if (epTitle) {
          if (flags.folderName) {
            epTitle = epTitle.replace(/[^a-zA-Z0-9 \-_.]/g, '');
            let epNum = (ep.episode != null && ep.episode !== undefined) ? String(ep.episode).padStart(2,'0') : '';
            fileName = epNum ? `E${epNum} ${epTitle}` : epTitle;
          } else {
            epTitle = epTitle.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9\-_.]/g, '');
            let epNum = (ep.episode != null && ep.episode !== undefined) ? String(ep.episode).padStart(2,'0') : '';
            fileName = epNum ? `E${epNum}-${epTitle}` : epTitle;
          }
        } else {
          let epNum = (ep.episode != null && ep.episode !== undefined) ? String(ep.episode).padStart(2,'0') : '';
          fileName = epNum ? `E${epNum}` : 'E';
        }
      } else {
        let epNum = (ep.episode != null && ep.episode !== undefined) ? String(ep.episode).padStart(2,'0') : '';
        fileName = epNum ? `${safeTitle}_E${epNum}` : safeTitle;
      }
      const cfgCore = core.readConfig();
      const recode = (flags.transcode || flags.recode) ? true : (cfgCore && cfgCore.autoTranscode);
      let episodeDest = dest;
      fileName = normalizeEpisodeFileName(String(fileName || ''))
      const _base = sanitizeForFile(fileName)
      const _reg = registerDownload(episodeDest, _base)
      let outPath = path.join(episodeDest, fileName + '.mp4');
      let subCount = 0;
      try {
        const result = await downloader.download(episodeDest, fileName, m3u8, refer, {
          recodeAudio: !!recode,
          subtitles: (subs && subs.length) ? subs : undefined,
          progressCallback: (pct, msg) => {
            updateLine(idx, `[${'█'.repeat(Math.round((pct/100)*40)).padEnd(40,'-')}] ${pct.toFixed(1)}% ${msg||''}`, anime, episodeList);
          }
        });
        if (result && result.subtitles) subCount = result.subtitles.length;
      } finally { unregisterDownload(_base) }
      updateLine(idx, `[${'█'.repeat(40)}] 100% Done`, anime, episodeList);
      console.log(`Saved: ${outPath}`);
      console.log(`Subtitle tracks: ${subCount}`);
      if (flags.autoplay && !termux) {
        try {
          const open = require('open');
          await open(outPath, { wait: false });
        } catch (e) {}
      } else if (flags.autoplay && termux) {
        console.log('Autoplay is not supported in Termux. Please open the file manually with mpv or your preferred player.');
      }
    }
    return
  }

  let targets = []
  if (flags.ep) {
    let epnums = Array.isArray(flags.ep) ? flags.ep : [flags.ep]
    for (const epnum of epnums) {
      if (typeof epnum === 'string' && epnum.includes('-')) {
        const [start, end] = epnum.split('-', 2).map(x => parseInt(x, 10))
        for (let i = start; i <= end; i++) {
          const found = episodes.find(ep => Number(ep.episode) === i)
          if (found) targets.push(found)
        }
      } else {
        const n = parseInt(epnum, 10)
        const found = episodes.find(ep => Number(ep.episode) === n)
        if (found) targets.push(found)
      }
    }
  }
  if (!flags.ep || targets.length === 0) {
    const epChoices = episodes.map((ep) => ({ name: `Episode ${ep.episode}${ep.filler? ' (filler)':''}`, value: ep }))
    const { pick } = await inquirer.prompt([{ type: 'list', name: 'pick', message: 'Select episode or choose range', choices: [...epChoices, { name: 'Enter range (e.g. 1-5)', value: 'range' }], pageSize: Math.min(epChoices.length, cfg.pageSizeDefault || 20) }])
    if (pick === 'range') {
      const { r } = await inquirer.prompt([{ name: 'r', message: 'Range:' }])
      const pr = (r||'').trim()
      if (pr.includes('-')) {
        const [s,e] = pr.split('-',2).map(x=>parseInt(x,10))
        for (let i=s;i<=e;i++) targets.push(episodes.find(ep=>Number(ep.episode)===i))
      } else {
        const n = parseInt(pr,10)
        targets.push(episodes.find(ep=>Number(ep.episode)===n))
      }
    } else {
      targets.push(pick)
    }
  }
  targets = targets.filter(Boolean)
  for (const ep of targets.filter(Boolean)) {
    let allOpts = [];
    const playUrl = `https://animepahe.si/play/${encodeURIComponent(slug)}/${ep.session}`;
    try {
      const html = await axios.get(playUrl, { headers: { Referer: 'https://animepahe.si', Cookie: cookie } });
      const $ = cheerio.load(html.data);
      $('button[data-src]').each((_, el) => {
        const e = $(el);
        allOpts.push({ audio: (e.attr('data-audio')||'').toLowerCase(), resolution: e.attr('data-resolution')||'', src: e.attr('data-src')||'' });
      });
    } catch {}
    const uniqAllOpts = Array.from(new Map(allOpts.map(o => [`${o.audio}|${o.resolution}`, o])).values());
    const optChoices = uniqAllOpts.map((o, i) => ({ name: `${i+1}. Audio: ${o.audio} Resolution: ${o.resolution}`, value: o }));
    let selectedOpt = null;
    if (optChoices.length > 0) {
      selectedOpt = (await inquirer.prompt([{ type: 'list', name: 'opt', message: `Select quality for episode ${ep.episode}`, choices: optChoices }])).opt;
    }
    let m3u8 = null;
    let refer = 'https://animepahe.si';
    let usedOpt = selectedOpt;
    let epOpts = allOpts;
    if (usedOpt) {
      m3u8 = await animeMod.getEpisodeM3U8({ slug, episode: ep.episode, audio: usedOpt.audio, resolution: usedOpt.resolution, cookie });
    }
    if (!m3u8 && usedOpt) {
      const lowerOpts = epOpts.filter(o => o.audio === usedOpt.audio && Number(o.resolution) < Number(usedOpt.resolution)).sort((a,b)=>Number(b.resolution)-Number(a.resolution));
      for (const lowOpt of lowerOpts) {
        m3u8 = await animeMod.getEpisodeM3U8({ slug, episode: ep.episode, audio: lowOpt.audio, resolution: lowOpt.resolution, cookie });
        if (m3u8) { usedOpt = lowOpt; break; }
      }
    }
    if (!m3u8 && epOpts.length) {
      const sorted = epOpts.sort((a,b)=>Number(b.resolution)-Number(a.resolution));
      for (const opt of sorted) {
        m3u8 = await animeMod.getEpisodeM3U8({ slug, episode: ep.episode, audio: opt.audio, resolution: opt.resolution, cookie });
        if (m3u8) { usedOpt = opt; break; }
      }
    }
    if (!m3u8) { console.log('Could not get stream for ep', ep.episode); continue }
    try { if (/kwik|owocdn|vidcloud|vault|vidcdn|vidstream/i.test(m3u8)) refer = 'https://kwik.cx' } catch (e) {}
    const rawTitle = htmlDecode(anime.title || slug)
    const cleanedTitle = rawTitle.replace(/\(SS\s*\d+\)/i, '').trim();
    const safeTitle = cleanedTitle.replace(/\s+/g, '-').replace(/"/g, '').replace(/[^a-zA-Z0-9\-_.]/g, '')
    let fileName;
    if (flags.folder) {
      let epTitle = htmlDecode((ep.title || '')).trim();
      if (epTitle) {
        epTitle = epTitle.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9\-_.]/g, '');
        fileName = `E${String(ep.episode).padStart(2,'0')}-${epTitle}`;
      } else {
        fileName = `E${String(ep.episode).padStart(2,'0')}`;
      }
    } else {
      fileName = `${safeTitle}_E${String(ep.episode).padStart(2,'0')}`;
    }
    const cfgCore = core.readConfig()
    const recode = (flags.transcode || flags.recode) ? true : (cfgCore && cfgCore.autoTranscode)
    fileName = normalizeEpisodeFileName(String(fileName || ''))
    const _base = sanitizeForFile(fileName)
    registerDownload(dest, _base)
    try { await downloader.download(dest, fileName, m3u8, refer, { recodeAudio: !!recode }) } finally { unregisterDownload(_base) }
  }
}

async function seriesFlow(flags) {
  const sel = await core.searchContent(await (async function getQuery(){ const { q } = await inquirer.prompt([{ name:'q', message: 'Search show:' }]); return q })(), 'series')
  if (!sel) return
  const selectedUrl = sel
  if (!selectedUrl.includes('/tv/')) { console.log('Selected content is not a TV series'); return }
  const m = selectedUrl.match(/\/tv\/[^/]*-(\d+)/)
  if (!m) { console.log('Cannot extract media id'); return }
  const mediaId = m[1]
  const seasons = await core.getTvSeasons(mediaId)
  if (!seasons || !seasons.length) { console.log('No seasons'); return }
  const cfg = core.readConfig()
  const seasonChoices = seasons.map((s,i)=>({ name: `${i+1}. ${htmlDecode(s.title || '')}`, value: i }))
  let targetSeasons = [];
  if (flags.season) {
    const sn = Array.isArray(flags.season) ? flags.season : [flags.season];
    for (const s of sn) {
      const idx = Number(s)-1;
      if (idx >= 0 && idx < seasons.length) targetSeasons.push(seasons[idx]);
    }
  } else if (flags.wholeshow) {
    targetSeasons = seasons;
  }
  if (targetSeasons.length) {
    for (const seasonObj of targetSeasons) {
      const eps = await core.getSeasonEpisodes(seasonObj.id)
      let targetEpisodes = eps;
      if (flags.episode) {
        const epnums = Array.isArray(flags.episode) ? flags.episode : [flags.episode];
        targetEpisodes = eps.filter(e => epnums.includes(String(e.episode)) || epnums.includes(Number(e.episode)));
      }
      
      let showSlug = '';
      try { const u = new URL(selectedUrl); const segs = (u.pathname||'').split('/').filter(Boolean); showSlug = segs[1] || segs[0] || '' } catch (e) {}
      showSlug = htmlDecode(String(showSlug)).replace(/-\d+$/,'').replace(/^watch[-_\s]*/i,'')
      let showFolder = showSlug.replace(/[-_]+/g,' ').trim();
      showFolder = htmlDecode(showFolder)
      if (!showFolder) showFolder = 'Show';
      showFolder = showFolder.split(/\s+/).map(s=>s.charAt(0).toUpperCase()+s.slice(1)).join(' ');
      
      let seasonFolder = (seasonObj.title || '').toString().trim();
      if (!/^season/i.test(seasonFolder)) seasonFolder = `Season ${seasonFolder}`;
      let baseDest = flags.path || flags.out || core.determinePath();
      for (const ep of targetEpisodes) {
        
        let dest = baseDest;
        if (flags.folder) {
          dest = path.join(baseDest, showFolder, seasonFolder);
          ensureDir(dest);
        }
        try {
          const data = await core.getEpisodeData(ep, seasonObj.title, ep.episode)
          if (!data) continue
          const [decoded, subs] = await decodeUrl(data.file)
          let refer = decoded && /kwik|owocdn|vidcloud|vault|vidcdn|vidstream/i.test(decoded) ? 'https://kwik.cx' : 'https://flixhq.to'
          let fileName;
          if (flags.folder) {
            let epTitle = htmlDecode((ep.title || '')).trim();
            let match = epTitle.match(/^(Ep|Eps)[-\s]*([0-9]+)/i);
            if (epTitle && match) {
              const epNum = match[2];
              let rest = epTitle.replace(match[0], '').replace(/^[-\s]+/, '');
              rest = rest.replace(/^[-]+/, '');
              rest = rest.replace(/[^a-zA-Z0-9 \-_.]/g, '');
              fileName = rest ? `E${epNum} ${rest}` : `E${epNum}`;
            } else if (epTitle) {
              epTitle = epTitle.replace(/[^a-zA-Z0-9 \-_.]/g, '');
              let epNum = (ep.episode != null && ep.episode !== undefined) ? String(ep.episode).padStart(2,'0') : '';
              fileName = epNum ? `E${epNum} ${epTitle}` : epTitle;
            } else {
              let epNum = (ep.episode != null && ep.episode !== undefined) ? String(ep.episode).padStart(2,'0') : '';
              fileName = epNum ? `E${epNum}` : 'E';
            }
          } else {
            const title = data.label || `S${seasonObj.title}E${ep.episode}`;
            const safeTitle = title.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9\-_.]/g, '');
            fileName = safeTitle;
          }
          const recode = (flags.transcode || flags.recode) ? true : (cfg && cfg.autoTranscode);
          fileName = normalizeEpisodeFileName(String(fileName || ''))
          const _base = sanitizeForFile(fileName)
          console.log(`Starting download`)
          registerDownload(dest, _base)
          let outPath = path.join(dest, fileName + '.mp4');
          let subCount = 0;
          try {
              const result = await downloader.download(dest, fileName, decoded, refer, {
                recodeAudio: !!recode,
                subtitles: (flags.s && subs && subs.length) ? subs : undefined
              });
            if (result && result.subtitles) subCount = result.subtitles.length;
          } finally { unregisterDownload(_base) }
          console.log(`Saved: ${outPath}`);
          console.log(`Subtitle tracks: ${subCount}`);
        } catch (e) { console.error('Failed download', e && e.message || e) }
      }
    }
    return
  }

  const { seasonIdx } = await inquirer.prompt([{ type: 'list', name: 'seasonIdx', message: 'Select season to download', choices: seasonChoices, pageSize: Math.min(seasonChoices.length, cfg.pageSizeDefault || 20) }])
  const targetSeason = seasons[seasonIdx]
  const eps = await core.getSeasonEpisodes(targetSeason.id)
  let baseDest = flags.path || flags.out || (cfg && cfg.downloadPath) || (core.determinePath && core.determinePath());
  if (!baseDest) baseDest = path.join(__dirname, 'downloads');
  try { fs.mkdirSync(baseDest, { recursive: true }) } catch (e) {}
  let dest = baseDest
  if (flags.folder) {
    try {
      const u = new URL(selectedUrl)
      const segs = (u.pathname || '').split('/').filter(Boolean)
      let showSlug = segs[1] || segs[0] || ''
      
      showSlug = htmlDecode(String(showSlug || ''))
        .replace(/-\d+$/,'')
        .replace(/^watch[-_\s]*/i,'')
        .replace(/[-_]+/g,' ')
        .trim()
      if (!showSlug) showSlug = 'Show'
      
      const showFolder = showSlug.split(/\s+/).map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' ')
      
      let seasonFolder = (targetSeason.title || (seasonIdx+1)).toString().trim()
      if (!/^season/i.test(seasonFolder)) seasonFolder = `Season ${seasonFolder}`
      dest = path.join(baseDest, showFolder, seasonFolder)
      fs.mkdirSync(dest, { recursive: true })
      console.log(`Created/using folder for downloads: ${dest}`)
    } catch (e) { console.error('Could not create show/season folder:', e && e.message || e) }
  }
  const epChoices = eps.map((ep,i)=>({ name: `${i+1}. ${htmlDecode(ep.title || `Episode ${i+1}`)}`, value: i }))
  const { epSelect } = await inquirer.prompt([{ type: 'list', name: 'epSelect', message: 'Select episode or choose range', choices: [...epChoices, { name: 'Enter range', value: 'range' }], pageSize: Math.min(epChoices.length+1, cfg.pageSizeDefault || 20) }])
  let targets = []
  if (epSelect === 'range') {
    const { r } = await inquirer.prompt([{ name: 'r', message: 'Range (e.g. 1-5):' }])
    const pr = (r||'').trim()
    if (pr.includes('-')) {
      const [s,e] = pr.split('-',2).map(x=>parseInt(x,10))
      for (let i=s;i<=e;i++) targets.push(eps[i-1])
    } else {
      const n = parseInt(pr,10)
      targets.push(eps[n-1])
    }
  } else targets.push(eps[epSelect])

  
  for (const t of targets.filter(Boolean)) {
    try {
      const data = await core.getEpisodeData(t, seasonIdx+1, t.episode || (epChoices.indexOf(t)+1))
      if (!data) { console.log('No data for ep'); continue }
      const [decoded, subs] = await decodeUrl(data.file)
      let refer = decoded && /kwik|owocdn|vidcloud|vault|vidcdn|vidstream/i.test(decoded) ? 'https://kwik.cx' : 'https://flixhq.to'
      let fileName;
      if (flags.folder) {
        let epTitle = htmlDecode((t.title || '')).trim();
        let match = epTitle.match(/^(Ep|Eps)[-\s]*([0-9]+)/i);
        if (epTitle && match) {
          const epNum = match[2];
          let rest = epTitle.replace(match[0], '');
          rest = rest.replace(/^[-\s]+/, '');
          rest = rest.replace(/^[-]+/, '');
          if (flags.folderName) {
            rest = rest.replace(/[^a-zA-Z0-9 \-_.]/g, '');
            fileName = rest ? `E${epNum} ${rest}` : `E${epNum}`;
          } else {
            rest = rest.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9\-_.]/g, '');
            fileName = rest ? `E${epNum}-${rest}` : `E${epNum}`;
          }
        } else if (epTitle) {
          if (flags.folderName) {
            epTitle = epTitle.replace(/[^a-zA-Z0-9 \-_.]/g, '');
            let epNum = (t.episode != null && t.episode !== undefined) ? String(t.episode).padStart(2,'0') : '';
            fileName = epNum ? `E${epNum} ${epTitle}` : epTitle;
          } else {
            epTitle = epTitle.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9\-_.]/g, '');
            let epNum = (t.episode != null && t.episode !== undefined) ? String(t.episode).padStart(2,'0') : '';
            fileName = epNum ? `E${epNum}-${epTitle}` : epTitle;
          }
        } else {
          let epNum = (t.episode != null && t.episode !== undefined) ? String(t.episode).padStart(2,'0') : '';
          fileName = epNum ? `E${epNum}` : 'E';
        }
      } else {
        const title = data.label || `S${seasonIdx+1}E${t.episode || '??'}`;
        const safeTitle = title.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9\-_.]/g, '');
        fileName = safeTitle;
      }
      fileName = normalizeEpisodeFileName(String(fileName || ''))
      const _base = sanitizeForFile(fileName)
      console.log(`Starting download -> dest: ${dest}, file: ${fileName}.mp4`)
      registerDownload(dest, _base)
      try { await downloader.download(dest, fileName, decoded, refer, { recodeAudio: cfg && cfg.autoTranscode, subtitles: (flags.s && subs && subs.length) ? subs : undefined }); } finally { unregisterDownload(_base) }
    } catch (e) { console.error('Failed:', e && e.message || e) }
  }
}

async function movieFlow(flags) {
  const { q } = await inquirer.prompt([{ name: 'q', message: 'Search movie:' }])
  const query = (q||'').trim()
  if (!query) return
    const sel = await core.searchContent(query, 'movie')
    if (!sel) return
    const selectedUrl = sel
    let displayTitle = null;
    try {
      const match = sel.match(/\/([^/]+)-\d+$/);
      if (match) {
        const params = query.replace(/\s+/g, '-');
        const url = `${FLIXHQ_BASE_URL}/search/${params}`;
        const resp = await axios.get(url, { headers: { 'User-Agent': `flix-cli/1.0.0` } });
        const $ = cheerio.load(resp.data);
        const items = $('.flw-item');
        items.each((i, el) => {
          const poster = $(el).find('.film-poster a');
          const href = new URL(poster.attr('href') || '', FLIXHQ_BASE_URL).toString();
          if (href === selectedUrl) {
            const titleElem = $(el).find('.film-detail h2.film-name a');
            const info = $(el).find('.fd-infor span');
            const title = titleElem.attr('title') || titleElem.text() || 'Unknown Title';
            displayTitle = htmlDecode(title);
            if (info && info.length) displayTitle += ` (${htmlDecode($(info[0]).text().trim())})`;
          }
        });
      }
    } catch (e) {}
  const m = selectedUrl.match(/\/movie\/[^/]*-(\d+)/)
  if (!m) { console.log('Could not extract media id from URL'); return }
  const mediaId = m[1]
  const { getEmbedLinkForMovie, findVidcloudFromMovieId } = require('./src/dl_helpers')
  let pageTitle = null
  try {
    const p = await axios.get(selectedUrl)
    const $ = cheerio.load(p.data)
    pageTitle = ($('.film-detail h2.film-name a').text() || $('.film-detail h2.film-name a').attr('title') || $('title').text())
    function cleanPageTitle(t) {
      if (!t) return t
      let s = String(t)
      s = s.replace(/\u00A0/g, ' ')
      s = s.replace(/^\s+|\s+$/g, '')
      s = s.replace(/^watch[\s:-_.]+/i, '')
      s = s.replace(/[-\s]*flixhq.*$/i, '')
      s = s.replace(/[-\s]*hd[-\s]*online[-\s]*free.*$/i, '')
      s = s.replace(/[-\s]*hd.*$/i, '')
      s = s.replace(/[-\s]*online[-\s]*free.*$/i, '')
      s = s.replace(/[-\s]*online.*$/i, '')
      s = s.replace(/[-\s]*free.*$/i, '')
      s = s.replace(/\b(HD|Online|Free|Watch)\b/ig, '')
      s = s.replace(/[^a-zA-Z0-9\s:\-()]/g, '')
      s = s.replace(/[\s:\-()]+/g, ' ').trim()
      return s
    }
    pageTitle = cleanPageTitle(pageTitle)
    if (!pageTitle || pageTitle.trim().length < 4 || /^\d{3,4}$/.test(pageTitle.trim())) {
      try {
        const u = new URL(selectedUrl)
        const seg = (u.pathname || '').split('/').filter(Boolean).pop() || ''
        let slugGuess = seg.replace(/-\d+$/,'')
        slugGuess = slugGuess.replace(/[-_]+/g, ' ')
        slugGuess = slugGuess.replace(/\b(movie|the)\b/ig, '')
        slugGuess = slugGuess.replace(/\s+/g,' ').trim()
        if (slugGuess && slugGuess.length >= 3) pageTitle = slugGuess
      } catch (e) {}
    }
  } catch (e) {}
  const vidLink = await findVidcloudFromMovieId(mediaId)
  if (!vidLink) { console.log('Could not find Vidcloud link for this movie'); return }
  const moviePage = new URL(vidLink, FLIXHQ_BASE_URL).toString()
  const epMatch = moviePage.match(/-(\d+)\.(\d+)$/)
  if (!epMatch) { console.log('Could not extract episode id from movie page'); return }
  const episodeId = epMatch[2]
  const embed = await getEmbedLinkForMovie(episodeId)
  if (!embed) { console.log('Could not get movie embed link'); return }
  const [decoded, subs] = await decodeUrl(embed)
  const cfg = core.readConfig()
  const dest = flags.path || flags.out || cfg.downloadPath || core.determinePath()
  let refer = FLIXHQ_BASE_URL
  try { if (/kwik|owocdn|vidcloud|vault|vidcdn|vidstream/i.test(decoded)) refer = 'https://kwik.cx' } catch (e) {}
  const recode = (flags.transcode || flags.recode) ? true : (cfg && cfg.autoTranscode)

  const title = (displayTitle && displayTitle.trim()) ? displayTitle.trim() : (pageTitle && pageTitle.trim()) ? pageTitle.trim() : ((decoded && typeof decoded === 'string') ? path.basename(decoded).split('?')[0] : `movie_${mediaId}`);
  const safeTitle = title.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9\-_.]/g, '').replace(/-+/g,'-').replace(/^-|-$/g,'');
  const _base = sanitizeForFile(normalizeEpisodeFileName(safeTitle))
  registerDownload(dest, _base)
  try { await downloader.download(dest, safeTitle, decoded, refer, { recodeAudio: !!recode, subtitles: (flags.s && subs && subs.length) ? subs : undefined }); } finally { unregisterDownload(_base) }
  console.log('Movie download complete — saved as', title + '.mp4');
}

async function main() {
  const flags = parseArgs()
  if (flags.anime) return await animeFlow(flags)
  if (flags.tv || flags.series || flags.mtv) return await seriesFlow(flags)
  if (flags.movie || flags.m) return await movieFlow(flags)
  if (isTermux()) {
    console.log('Termux detected: All features (download, playback, etc.) are supported if mpv/ffmpeg are installed. Autoplay is disabled by default.');
  }
  console.log('Usage: dl [options]')
  console.log('  --anime           Download anime (interactive)')
  console.log('    --all           Download all episodes (batch)')
  console.log('    --ep <n|n-n>    Download episode n or range n-n (repeatable)')
  console.log('    --aac           Re-encode audio to AAC')
  console.log('    --out <dir>     Output directory (default: ./downloads)')
  console.log('    --f, --folder   Organize downloads into a folder named after the anime, filenames like E05-Episode-Title.mp4')
  console.log('  --tv, --series    Download TV series (interactive)')
  console.log('    --all           Download all seasons/episodes')
  console.log('    --season <n>    Download only season n (repeatable)')
  console.log('    --ep <n>        Download only episode n (repeatable)')
  console.log('    --aac           Re-encode audio to AAC')
  console.log('    --out <dir>     Output directory (default: ./downloads)')
  console.log('    --f, --folder   Organize downloads into a folder named after the show, filenames like E05-Episode-Title.mp4')
  console.log('    --s              Download and embed available subtitles into the MP4')
  console.log('  --movie, -m       Download a movie (interactive)')
  console.log('    --aac           Re-encode audio to AAC')
  console.log('    --out <dir>     Output directory (default: ./downloads)')
  console.log('    --f, --folder   Organize download into a folder named after the movie')
  console.log('    --s              Download and embed available subtitles into the MP4')
  console.log('')
  console.log('With --folder, filenames are E{num}-{title}.mp4 if the episode/movie title is available, or just E{num}.mp4 otherwise. No show or season is included in the filename when --folder is used.')
  console.log('If --out is not specified, downloads go to ./downloads by default.')
}
main().catch(e=>{ console.error(e && e.stack || e); process.exit(1) })
