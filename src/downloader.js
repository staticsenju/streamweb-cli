  function sanitizeName(name) {
  return String(name).replace(/\s+/g, '-').replace(/"/g, '').replace(/[^a-zA-Z0-9\-_.]/g, '');
}
const fs = require('fs')
const path = require('path')
const { spawn, spawnSync } = require('child_process')
const axios = require('axios')

const DEFAULT_UA = process.env.STREAMWEB_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const FFMPEG_EXECUTABLE = process.env.FFMPEG_PATH || 'ffmpeg'

async function estimateDurationFromM3U8(url, referer) {
  try {
    const resp = await axios.get(url, { headers: { Referer: referer, 'User-Agent': 'flix-cli' }, responseType: 'text' })
    const txt = resp.data
    if (typeof txt !== 'string') return null
    const lines = txt.split(/\r?\n/)
    let total = 0
    let found = false
    for (const line of lines) {
      const m = line.match(/^#EXTINF:([0-9.]+)/)
      if (m) { total += parseFloat(m[1] || '0'); found = true }
    }
    return found ? total : null
  } catch (e) { return null }
}

function renderProgress(percent) {
  const width = 40
  const filled = Math.round((percent / 100) * width)
  const bar = '█'.repeat(filled) + '-'.repeat(Math.max(0, width - filled))
  process.stdout.write(`\r[${bar}] ${percent.toFixed(1)}%`)
  process.stdout.write(' ');
  if (process.stdout.flush) process.stdout.flush();
}

function renderProgressPct(percent) {
    const width = 40
    const p = Math.max(0, Math.min(100, Number(percent) || 0))
    const filled = Math.round((p / 100) * width)
    const bar = '█'.repeat(filled) + '-'.repeat(Math.max(0, width - filled))
    process.stdout.write(`\r[${bar}] ${p.toFixed(1)}%`)
  process.stdout.write(' ');
  if (process.stdout.flush) process.stdout.flush();
  }


async function download(destPath, name, url, referer, opts = {}) {
  if (!fs.existsSync(destPath)) fs.mkdirSync(destPath, { recursive: true })
  const safe = sanitizeName(name)
  const outFile = path.join(destPath, `${safe}.mp4`)

  const estimatedDuration = await estimateDurationFromM3U8(url, referer)
    let estimatedSize = 0;
    let showSpinner = !estimatedDuration || estimatedDuration < 1;
  let spinnerInterval = null;
  let spinnerIndex = 0;
  const spinnerChars = ['|', '/', '-', '\\'];
  if (showSpinner && opts.progressCallback) {
    spinnerInterval = setInterval(() => {
      opts.progressCallback(0, 'downloading... ' + spinnerChars[spinnerIndex++ % spinnerChars.length]);
    }, 120);
  }

  const recodeAudio = !!opts.recodeAudio
  const extraHeaders = opts.extraHeaders || {}

  const useYtdlp = (() => {
    try {
      const r = spawnSync('yt-dlp', ['--version'], { stdio: 'ignore' })
      return r.status === 0
    } catch (e) { return false }
  })()

  if (useYtdlp) {
    return await new Promise((resolve, reject) => {
      const args = ['-o', outFile, url, '--no-part', '--newline', '--concurrent-fragments', '64', '--fragment-retries', '10', '--retries', '10', '--socket-timeout', '60']
      if (referer) {
        args.push('--add-header'); args.push(`Referer: ${referer}`)
        args.push('--referer'); args.push(referer)
      }
      try { if (referer && /kwik\.cx/i.test(referer)) { args.push('--add-header'); args.push('Origin: https://kwik.cx') } } catch (e) {}
      args.push('--add-header'); args.push(`User-Agent: ${DEFAULT_UA}`)
      for (const k of Object.keys(extraHeaders)) { args.push('--add-header'); args.push(`${k}: ${extraHeaders[k]}`) }
      if (!opts.progressCallback) { try { process.stdout.write(`Downloading ${safe}...\n`) } catch (e) {} }
      const ytd = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let errBuf = ''
      let outBuf = ''
      let totalFrags = null
      let lastPct = 0
      let sawProgress = false;
      function handleChunk(buf, isStdErr) {
        const txt = buf.toString('utf8')
        if (isStdErr) errBuf += txt
        else outBuf += txt
        const combined = (errBuf + '\n' + outBuf)
        const lines = combined.split(/\r?\n/)
        const tail = lines.pop() || ''
        errBuf = ''
        outBuf = tail
        for (const line of lines) {
          try {
            const rePct = /(\d{1,3}(?:\.\d+)?)%/g
            let m; let lastPctTok = null
            while ((m = rePct.exec(line)) !== null) lastPctTok = parseFloat(m[1])
            if (lastPctTok !== null) {
              if (!Number.isNaN(lastPctTok) && Math.abs(lastPctTok - lastPct) >= 1.0) {
                if (opts.progressCallback) opts.progressCallback(lastPctTok);
                else renderProgressPct(lastPctTok);
                lastPct = lastPctTok;
                sawProgress = true;
              }
              continue;
            }
            const mFrag = line.match(/frag\D*(\d+)\D*(\d+)/i) || line.match(/(\d+)\s*\/\s*(\d+)\s*\(frag\)/i)
            if (mFrag) {
              const cur = Number(mFrag[1]);
              const tot = Number(mFrag[2]);
              if (tot > 0) {
                const pct = (cur / tot) * 100;
                if (Math.abs(pct - lastPct) >= 1.0) {
                  if (opts.progressCallback) opts.progressCallback(pct);
                  else renderProgressPct(pct);
                  lastPct = pct;
                  sawProgress = true;
                }
                continue;
              }
            }
            const ariaRe = /\((\d{1,3}(?:\.\d+)?)%\)/g
            let ariaM; let ariaLast = null
            while ((ariaM = ariaRe.exec(line)) !== null) ariaLast = parseFloat(ariaM[1])
            if (ariaLast !== null) {
              if (!Number.isNaN(ariaLast) && Math.abs(ariaLast - lastPct) >= 1.0) {
                if (opts.progressCallback) opts.progressCallback(ariaLast);
                else renderProgressPct(ariaLast);
                lastPct = ariaLast;
                sawProgress = true;
              }
            }
          } catch (e) {}
        }
      }
      ytd.stdout.on('data', (c) => handleChunk(c, false))
      ytd.stderr.on('data', (c) => handleChunk(c, true))
      ytd.on('error', (err) => reject(err))
      ytd.on('close', (code) => {
        if (spinnerInterval) clearInterval(spinnerInterval);
        if (sawProgress) {
          if (opts.progressCallback) opts.progressCallback(100, 'Done');
          else { renderProgressPct(100); process.stdout.write('\n'); }
        } else if (showSpinner && opts.progressCallback) {
          opts.progressCallback(100, 'Done');
        }
        try {
          const tmp = outFile + '.recode.tmp.mp4';
          if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
          const dir = path.dirname(outFile);
          const base = path.basename(outFile);
          const files = fs.readdirSync(dir);
          files.forEach(f => {
            if (f.startsWith(base) && (f.endsWith('.part') || f.endsWith('.tmp'))) {
              try { fs.unlinkSync(path.join(dir, f)); } catch (e) {}
            }
          });
        } catch (e) {}
        if (code === 0) {
          if (recodeAudio) {
            try {
              const tmp = outFile + '.recode.tmp.mp4';
              const rc = spawnSync(FFMPEG_EXECUTABLE, ['-y', '-hide_banner', '-loglevel', 'error', '-i', outFile, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', tmp], { stdio: 'ignore' });
              if (rc.status === 0) {
                try { fs.renameSync(tmp, outFile); } catch (e) { /* ignore */ }
              } else {
                try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) {}
              }
            } catch (e) {}
          }
          try { cleanTempFilesFor(outFile) } catch (e) {}
          return resolve(outFile);
        }
        const msg = errBuf || `yt-dlp exited with ${code}`;
        return reject(new Error(msg))
      })
    })
  }

  return await new Promise((resolve, reject) => {
    const headers = []
    if (referer) headers.push(`Referer: ${referer}`)
    headers.push(`User-Agent: ${DEFAULT_UA}`)
    try { if (referer && /kwik\.cx/i.test(referer)) headers.push('Origin: https://kwik.cx') } catch (e) {}
    for (const k of Object.keys(extraHeaders)) headers.push(`${k}: ${extraHeaders[k]}`)
    const args = ['-y', '-loglevel', 'error']
    if (headers.length) { args.push('-headers'); args.push(headers.join('\r\n')) }
    if (referer) args.push('-referer', referer)
    args.push('-i', url, '-c', 'copy', '-threads', '4', '-progress', 'pipe:1', outFile)
    const ff = spawn(FFMPEG_EXECUTABLE, args, { stdio: ['ignore', 'pipe', 'pipe'] })

    let stdoutBuf = ''
    let lastPercent = 0
    let spinnerInterval = null;
    let spinnerIndex = 0;
    const spinnerChars = ['|', '/', '-', '\\'];
    if (showSpinner && opts.progressCallback) {
      spinnerInterval = setInterval(() => {
        opts.progressCallback(0, 'downloading... ' + spinnerChars[spinnerIndex++ % spinnerChars.length]);
      }, 120);
    }

    ff.stdout.on('data', (chunk) => {
      try {
        stdoutBuf += chunk.toString('utf8')
        const parts = stdoutBuf.split(/\r?\n/)
        if (stdoutBuf.endsWith('\n') || stdoutBuf.endsWith('\r')) stdoutBuf = ''
        else stdoutBuf = parts.pop() || ''
        for (const line of parts) {
          const kv = line.split('=')
          if (kv.length !== 2) continue
          const k = kv[0].trim()
          const v = kv[1].trim()
          if (k === 'out_time_ms' && estimatedDuration) {
            const outMs = Number(v)
            const outSec = outMs / 1000
            const pct = Math.min(100, (outSec / estimatedDuration) * 100)
            if (Math.abs(pct - lastPercent) >= 0.1) {
              if (opts.progressCallback) opts.progressCallback(pct);
              else renderProgress(pct);
              lastPercent = pct
            }
          }
          if (k === 'progress' && v === 'end') {
            if (opts.progressCallback) opts.progressCallback(100, 'Done');
            else { renderProgress(100); process.stdout.write('\n'); }
          }
        }
      } catch (e) {}
    })

    let errBuf = ''
    ff.stderr.on('data', (c) => { errBuf += c.toString('utf8') })

    ff.on('error', (err) => {
      if (spinnerInterval) clearInterval(spinnerInterval);
      reject(err)
    })
    ff.on('close', (code) => {
      if (spinnerInterval) clearInterval(spinnerInterval);
      if (code === 0) {
        if (recodeAudio) {
          try {
            const tmp = outFile + '.recode.tmp.mp4'
            const rc = spawnSync(FFMPEG_EXECUTABLE, ['-y', '-hide_banner', '-loglevel', 'error', '-i', outFile, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', tmp], { stdio: 'ignore' })
            if (rc.status === 0) {
              try { fs.renameSync(tmp, outFile) } catch (e) {}
            } else {
              try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) } catch (e) {}
            }
          } catch (e) {}
        }
        try { cleanTempFilesFor(outFile) } catch (e) {}
        resolve(outFile)
      } else {
        const msg = errBuf || `ffmpeg exited with ${code}`
        reject(new Error(msg))
      }
    })
  })
}

function cleanTempFilesFor(outFile) {
  try {
    const dir = path.dirname(outFile)
    const base = path.basename(outFile)
    const candidates = [base + '.part', base + '.tmp', base + '.recode.tmp.mp4']
    for (const c of candidates) {
      const p = path.join(dir, c)
      try { if (fs.existsSync(p)) fs.unlinkSync(p) } catch (e) {}
    }
    try {
      const files = fs.readdirSync(dir)
      for (const f of files) {
        if (f.startsWith(base) && (f.endsWith('.part') || f.endsWith('.tmp'))) {
          try { fs.unlinkSync(path.join(dir, f)) } catch (e) {}
        }
      }
    } catch (e) {}
  } catch (e) {}
}

module.exports = { download }
