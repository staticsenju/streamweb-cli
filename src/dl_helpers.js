const axios = require('axios')
const FLIXHQ_BASE_URL = 'https://flixhq.to'
const FLIXHQ_AJAX_URL = `${FLIXHQ_BASE_URL}/ajax`

async function getEmbedLinkForMovie(episodeId) {
  try {
    const url = `${FLIXHQ_AJAX_URL}/episode/sources/${episodeId}`
    const resp = await axios.get(url)
    const body = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data)
    const m = body.match(/"link":"([^"]*)"/)
    if (m) return m[1]
  } catch (e) {}
  return null
}

async function findVidcloudFromMovieId(mediaId) {
  try {
    const url = `${FLIXHQ_AJAX_URL}/movie/episodes/${mediaId}`
    const resp = await axios.get(url)
    const content = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data)
    const match = content.match(/href=\"([^\"]*)\"[^>]*title=\"Vidcloud\"/)
    if (match) return match[1]
  } catch (e) {}
  return null
}

module.exports = { getEmbedLinkForMovie, findVidcloudFromMovieId }
