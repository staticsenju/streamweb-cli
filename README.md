# streamweb-cli

Streamweb-CLI is a small interactive command-line tool that lets you search and stream (or download) anime, TV shows and movies from supported web sources. It combines two CLI flows:

- Anime: search and play anime with episode/audio/resolution selection (mpv-based playback and resume support)
- TV / Movies: search and play or download movies and TV episodes

## Requirements

- Node.js 18 or newer (global fetch is used)
- mpv installed and available in your PATH (for playback)
- ffmpeg installed and available in your PATH (for downloads/transmuxing)

## Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/staticsenju/streamweb-cli.git
cd streamweb-cli
npm install
```


## CLI Usage

You can run the main CLI:

```bash
node .
```

Or use the downloader directly:

```bash
node dl.js [options]
```

### dl CLI options

```
dl --anime           Download anime (interactive)
	--all              Download all episodes (batch)
	--aac              Re-encode audio to AAC
	--out <dir>        Output directory
dl --tv, --series    Download TV series (interactive)
	--all              Download all seasons/episodes
	--season <n>       Download only season n (repeatable)
	--ep <n>           Download only episode n (repeatable)
	--aac              Re-encode audio to AAC
	--out <dir>        Output directory
dl --movie, -m       Download a movie (interactive)
	--aac              Re-encode audio to AAC
	--out <dir>        Output directory
```

Examples:

```bash
dl --anime --all --out "./downloads"
dl --tv --season 2 --ep 5 --out "./tv"
dl --movie --aac
```

## Usage notes & tips

- Ensure `mpv` and `ffmpeg` are installed and available in your PATH.
- If you run Node older than 18, install a fetch polyfill (e.g., `node-fetch`) and require it globally before using the CLI.
- Downloads use ffmpeg with `-c copy` where possible to be fast; on some HLS sources ffmpeg may still re-encode segments.
- If mpv is not installed the CLI will fall back to opening the stream URL in your default system opener.

## History & resume

- Each flow records history so you can resume where you left off. History files are limited to recent entries (100 by default).
- The anime flow uses mpv's IPC when available to track playback position more accurately.

## Troubleshooting

- If playback doesn't start, confirm `mpv` is installed and in PATH. On Linux use your package manager (apt, dnf, pacman).
- If downloads fail, verify `ffmpeg` is installed and supports HLS input.

## Contributing

If you want to improve this tool, open issues or PRs on the repository. Small improvements I recommend:

- Add more robust decoder/embedding support for different providers
- Add a fetch polyfill and a lightweight install guide for older Node versions
- Add unit tests for scraping/parsing helpers

## License

This repository is provided under the MIT license (see LICENSE file).
