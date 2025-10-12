const child_process = require('child_process')
const _open = require('open')
const open = (_open && _open.default) ? _open.default : _open

async function play(url, title, base, subs) {
  console.log(`Opening ${title} -> ${url}`)
  try {
    const args = []
    if (Array.isArray(subs) && subs.length) {
      for (const s of subs) args.push(`--sub-file=${s}`)
    }
    args.push(url)

    const mpv = child_process.spawn('mpv', args, { stdio: 'inherit' })

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
  } catch (err) { await open(url) }
}

module.exports = { play }
