const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const axios = require('axios')

const FFMPEG_EXECUTABLE = process.env.FFMPEG_PATH || 'ffmpeg'

function sanitizeName(name) {
  return name.replace(/\s+/g, '-').replace(/"/g, '')
}

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
}

async function download(destPath, name, url, referer) {
  if (!fs.existsSync(destPath)) fs.mkdirSync(destPath, { recursive: true })
  const safe = sanitizeName(name)
  const outFile = path.join(destPath, `${safe}.mp4`)

  const estimatedDuration = await estimateDurationFromM3U8(url, referer)

  return await new Promise((resolve, reject) => {
  const args = ['-y', '-loglevel', 'error', '-referer', referer, '-i', url, '-c', 'copy', '-progress', 'pipe:1', outFile]
    const ff = spawn(FFMPEG_EXECUTABLE, args, { stdio: ['ignore', 'pipe', 'pipe'] })

    let stdoutBuf = ''
    let lastPercent = 0

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
            if (Math.abs(pct - lastPercent) >= 0.1) { renderProgress(pct); lastPercent = pct }
          }
          if (k === 'progress' && v === 'end') {
            renderProgress(100)
            process.stdout.write('\n')
          }
        }
      } catch (e) {}
    })

  let errBuf = ''
  ff.stderr.on('data', (c) => { errBuf += c.toString('utf8') })

    ff.on('error', (err) => reject(err))
    ff.on('close', (code) => {
      if (code === 0) {
  if (lastPercent === 0) console.log(`Downloaded at ${outFile}`)
  else process.stdout.write('\n')
        resolve(outFile)
      } else {
        const msg = errBuf || `ffmpeg exited with ${code}`
        reject(new Error(msg))
      }
    })
  })
}

module.exports = { download }
