const axios = require("axios");
const USER_AGENT = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36";

async function decodeUrl(url) {
  try {
    const parsed = new URL(url);
    const MAIN_URL = `${parsed.protocol}//${parsed.host}`;
    const REFER = `${MAIN_URL}/`;

    const headers = {
        Accept: "*/*",
        "X-Requested-With": "XMLHttpRequest",
        Referer: REFER,
        "User-Agent": USER_AGENT
    };

    const html = (await axios.get(url, { headers })).data;

    let nonceMatch =
        html.match(/\b[a-zA-Z0-9]{48}\b/) ||
        html.match(/\b([a-zA-Z0-9]{16})\b.*?\b([a-zA-Z0-9]{16})\b.*?\b([a-zA-Z0-9]{16})\b/);

    if (!nonceMatch) throw new Error("Nonce not found in HTML");

    const nonce =
        nonceMatch.length === 4
            ? nonceMatch.slice(1).join("")
            : nonceMatch[0];

    const fileId = url.substring(url.lastIndexOf("/") + 1).split("?")[0];

    const apiUrl = `${MAIN_URL}/embed-1/v3/e-1/getSources?id=${fileId}&_k=${nonce}`;
    const apiRes = (await axios.get(apiUrl, { headers })).data;

    const firstSource = apiRes.sources?.[0]?.file;
    if (!firstSource) throw new Error("No sources found in API response");

    const subs = (apiRes.tracks || [])
        .filter(t => t.kind === 'captions' && t.file)
        .map(t => t.file);

    return [firstSource, subs];

  } catch (err) {
    console.error("Error in decodeUrl:", err.message);
    return [url, []];
  }
}

module.exports = { decodeUrl };
