# animeweb-cli
An interactive CLI tool to search and play anime using mpv, with episode, audio, and resolution selection.
# Anime CLI Setup & Usage

## Requirements
- Node.js 18 or newer
- mpv (media player) installed and available in your PATH
- ffmpeg installed and available in your PATH

## Installation
1. Clone this repository:
	```bash
	git clone https://github.com/staticsenju/animeweb-cli.git
	cd animeweb-cli
	```

2. Install dependencies:
	```bash
	npm install
	```
## Running the CLI

Start the interactive CLI with:
```bash
node index.js
```

You will be prompted to:
- Enter an anime search query
- Select an anime from the results
- Select an episode
- Select audio and resolution
- The episode will play in mpv

New features
- View recently watched: the CLI now shows a main menu where you can choose to view recently watched entries saved in `~/.animeweb_history.json`.
- Resume: choose a recently watched item to resume from the saved playback position.
- Autonext: when starting playback you can enable 'autonext' to automatically play the next episode when the current one finishes.

History is stored in JSON at `~/.animeweb_history.json` (up to 100 most recent entries). mpv is used for playback; for improved resume accuracy the tool uses mpv's IPC socket when available.
