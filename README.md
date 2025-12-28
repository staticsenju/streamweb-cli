# streamweb-cli

Streamweb-CLI is an interactive command-line downloader/player for anime, TV shows and movies from supported web sources.

Quick features
- Interactive search and selection for anime, TV series, and movies
- Download or stream episodes and movies
- Folder organization with `--f` and default `./downloads` output
- Subtitle fetching and automatic muxing with `--s`
- Filename normalization and HTML entity decoding for safe filenames

Requirements
- Node.js 18+ (uses global fetch)
- `ffmpeg` available in PATH (required for downloads and subtitle muxing)
- `mpv` recommended for playback (optional)
- `yt-dlp` optional (used when available for some downloads)

Install
Clone and install dependencies:

```bash
git clone https://github.com/staticsenju/streamweb-cli.git
cd streamweb-cli
npm install
```

Run the included installers (optional)
- Unix / WSL / Git Bash:

```bash
chmod +x ./install.sh
./install.sh
```

- Windows PowerShell (run as Administrator if installing system-wide):

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\install.ps1
```

The install scripts attempt to install helper tools and create convenient shortcuts where appropriate. Review the scripts before running.

Usage (player/stream)
- Run the interactive player/streaming CLI:

```bash
node index.js
streamweb-cli # run ./install.sh or install.ps1 beforehand
```

This launches the streaming/player flow which uses `mpv` when available for playback and supports resume tracking where supported.

Usage (downloader)
- Run the interactive downloader CLI:

```bash
node dl.js
dl # run ./install.sh or install.ps1 beforehand
```

- Or use the downloader entry directly:

```bash
node dl.js --tv       # interactive TV series flow
node dl.js --movie    # interactive movie flow
node dl.js --anime    # interactive anime flow
```

Important flags
- `--out <dir>` : output directory (default: `./downloads`)
- `-f`, `--folder` : organize downloads into show/movie/anime folders (creates Show/Season structure for TV)
- `--s` : fetch and mux available subtitle tracks into the output MP4
- `--all` : download all episodes (where supported)
- `--season <n>` / `--ep <n>` : select seasons/episodes in TV flow

Examples

```bash
node dl.js --tv --season 1 --ep 2 --f --s --out "./downloads"
node dl.js --movie --f --s --out "./downloads"
node dl.js --anime --all --f --out "./downloads"
```

What changed / New features
- Subtitle support: use `--s` to download available subtitle tracks and mux them into the MP4 using `ffmpeg` (mov_text). Language metadata defaults to `und` when not available.
- Filename fixes: HTML entities are decoded for display and filenames (e.g., `&amp;`, `&#39;`) and redundant fragments like `Episode-1` or duplicate dashes are removed.
- Folder normalization: TV show slugs are cleaned (leading `watch` removed), show titles are title-cased for folders, and `--f` now creates Show/Season directories immediately when used interactively.
- Cleanup: temporary fragments and subtitle files are removed after successful muxing and on interrupts (Ctrl+C).

Notes & troubleshooting
- Ensure `ffmpeg` is in PATH. If subtitles aren't embedded, check the CLI log for the `ffmpeg` mux step output.
- On Windows, run PowerShell with `ExecutionPolicy` bypass as shown above to run `install.ps1`.
- If a download is interrupted, temporary files are cleaned where possible; partial `.mp4` files may remain if ffmpeg fails  check the logs.

Reporting issues
- Open an issue with logs and a short description of the problem. Include the command you ran and the target folder listing.

License
- MIT
