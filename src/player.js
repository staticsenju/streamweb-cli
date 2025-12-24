const child_process = require('child_process')
const _open = require('open')
const open = (_open && _open.default) ? _open.default : _open
const os = require('os')
const path = require('path')
const fs = require('fs')

async function play(url, title, base, subs) {
  console.log(`Opening ${title} -> ${url}`)
  try {
    const args = []
    if (Array.isArray(subs) && subs.length) {
      for (const s of subs) args.push(`--sub-file=${s}`)
    }
    args.push('--fullscreen')
    args.push(url)

    const inputConfPath = path.join(os.tmpdir(), `streamweb-inputconf-${process.pid}-${Date.now()}.conf`)
    try { fs.writeFileSync(inputConfPath, `Ctrl+w print-text STREAMWEB:STOP_AUTOPLAY_AND_QUIT\nCtrl+o print-text STREAMWEB:STOP_AUTOPLAY_ONLY\n`, 'utf8') } catch (e) {}
    args.unshift(`--input-conf=${inputConfPath}`)

    const mpv = child_process.spawn('mpv', args, { stdio: ['ignore','pipe','pipe'] })

    let userStopMode = null
    if (mpv.stdout) mpv.stdout.on('data', d => {
      try {
        const txt = d.toString('utf8')
        if (txt.includes('STREAMWEB:STOP_AUTOPLAY_AND_QUIT')) {
          userStopMode = 'quit'
          try { mpv.kill() } catch (e) {}
        } else if (txt.includes('STREAMWEB:STOP_AUTOPLAY_ONLY')) {
          userStopMode = 'stop_only'
        }
      } catch (e) {}
    })
    if (mpv.stderr) mpv.stderr.on('data', d => {
      try {
        const txt = d.toString('utf8')
        if (txt.includes('STREAMWEB:STOP_AUTOPLAY_AND_QUIT')) {
          userStopMode = 'quit'
          try { mpv.kill() } catch (e) {}
        } else if (txt.includes('STREAMWEB:STOP_AUTOPLAY_ONLY')) {
          userStopMode = 'stop_only'
        }
      } catch (e) {}
    })

    let handledError = false
    mpv.on('error', async (err) => {
      handledError = true
      if (err && err.code === 'ENOENT') {
        console.log('mpv not found, falling back to system opener')
        await open(url)
      } else {
        console.error('mpv error:', err)
      }
    })

    const exitCode = await new Promise((resolve) => mpv.on('close', resolve))
    if (exitCode !== 0 && !handledError) {
      console.log(`mpv exited with code ${exitCode}, falling back to system opener`)
      await open(url)
    }
    try { fs.unlinkSync(inputConfPath) } catch (e) {}
    return userStopMode
  } catch (err) { try { await open(url) } catch {} ; return null }
}

module.exports = { play }
