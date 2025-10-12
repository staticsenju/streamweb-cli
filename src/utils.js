const axios = require('axios')
const DECODER = 'https://dec.eatmynerds.live'

async function decodeUrl(url) {
  try {
    const endpoint = `${DECODER}?url=${encodeURIComponent(url)}`
    const resp = await axios.get(endpoint, { headers: { 'Referer': 'https://flixhq.to' } })
    if (resp.status === 200) {
      const data = resp.data
      if (data && data.sources && data.sources.length) {
        const file = data.sources[0].file
        const subs = (data.tracks||[]).filter(t=>t.kind==='captions'&&t.file).map(t=>t.file)
        return [file, subs]
      }
      if (data && (data.link || data.url || data.file)) return [data.link||data.url||data.file, []]
      
      const txt = typeof data === 'string' ? data : JSON.stringify(data)
      const m = txt.match(/\"file\":\"([^\"]*\.m3u8[^\"]*)\"/)
      if (m) return [m[1], []]
    }
  } catch (err) {}
  return [url, []]
}

module.exports = { decodeUrl }
