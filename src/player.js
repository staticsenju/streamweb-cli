const child_process = require('child_process')
const open = require('open')
const os = require('os')
const path = require('path')
const fs = require('fs')

// Detect if running as pkg executable
const isPkg = typeof process.pkg !== 'undefined'
const binDir = isPkg ? path.join(path.dirname(process.execPath), 'bin') : null
const MPV_EXECUTABLE = isPkg && binDir ? path.join(binDir, 'mpv.exe') : 'mpv'

async function play(url, title, base, subs) {
  console.log(`Opening ${title}...`)
  console.log(`Loading stream with enhanced buffering...`)
  try {
    const args = []
    if (Array.isArray(subs) && subs.length) {
      for (const s of subs) args.push(`--sub-file=${s}`)
    }

    args.push('--cache=yes')
    args.push('--demuxer-max-bytes=200M')
    args.push('--demuxer-max-back-bytes=100M')
    args.push('--cache-secs=30')
    args.push('--stream-buffer-size=4M')
    args.push('--network-timeout=60')
    args.push('--hls-bitrate=max')

    args.push('--fullscreen')
    let sockPath
    if (process.platform === 'win32') sockPath = `\\.\pipe\streamweb-mpv-${process.pid}-${Date.now()}`
    else sockPath = path.join(os.tmpdir(), `streamweb-mpv-${process.pid}-${Date.now()}.sock`)

    const inputConfPath = path.join(os.tmpdir(), `streamweb-inputconf-${process.pid}-${Date.now()}.conf`)
    try { fs.writeFileSync(inputConfPath, `Ctrl+w print-text STREAMWEB:STOP_AUTOPLAY_AND_QUIT\nCtrl+o print-text STREAMWEB:STOP_AUTOPLAY_ONLY\n`, 'utf8') } catch (e) {}

    args.unshift(`--input-conf=${inputConfPath}`)
    args.unshift(`--input-ipc-server=${sockPath}`)
    args.push(url)

    const mpv = child_process.spawn(MPV_EXECUTABLE, args, { stdio: ['ignore','pipe','pipe'] })

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

    let lastPos = 0
    let reqId = 1
    let sock = null
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
    let poll = null
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
      poll = setInterval(() => { try { sock.write(JSON.stringify({ command: ['get_property', 'time-pos'], request_id: String(reqId++) }) + '\n') } catch (e) {} }, 2000)
    }

    await new Promise(resolve => mpv.on('exit', resolve))

    if (poll) clearInterval(poll)
    try { if (sock) { sock.end(); sock.destroy() } } catch (e) {}

    try { fs.unlinkSync(inputConfPath) } catch (e) {}
    if (!handledError && mpv.exitCode !== 0) {
      console.log(`mpv exited with code ${mpv.exitCode}, falling back to system opener`)
      try { await open(url) } catch (e) {}
    }
    return { stopMode: userStopMode, position: Math.round(lastPos || 0) }
  } catch (err) { try { await open(url) } catch {} ; return { stopMode: null, position: 0 } }
}

module.exports = { play }
