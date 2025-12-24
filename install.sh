#!/usr/bin/env bash
set -e

check_cmd() { command -v "$1" >/dev/null 2>&1; }

echo "Checking required tools: node, npm, mpv, ffmpeg, yt-dlp"

if check_cmd node; then
	echo "node found: $(node -v)"
else
	echo "node not found. Will try to install via nvm (requires curl)."
	read -p "Proceed to install nvm and latest Node.js LTS? (y/N): " yn
	if [[ "$yn" =~ ^[Yy]$ ]]; then
		if ! check_cmd curl; then echo "curl not found; please install curl and retry."; exit 1; fi
		echo "Installing nvm..."
		curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.6/install.sh | bash
		export NVM_DIR="$HOME/.nvm"
		[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
		nvm install --lts
		nvm use --lts
	else
		echo "Skipped node installation. Please install Node.js and re-run this script."; exit 1
	fi
fi

if ! check_cmd npm; then
	echo "npm not found even after node install. Aborting."; exit 1
fi

if check_cmd mpv; then
	echo "mpv found: $(mpv --version | head -n1)"
else
	echo "mpv not found. Attempting to install using package manager." 
	if check_cmd apt-get; then
		read -p "Install mpv with apt-get (requires sudo)? (y/N): " yn
		if [[ "$yn" =~ ^[Yy]$ ]]; then sudo apt-get update && sudo apt-get install -y mpv; fi
	elif check_cmd brew; then
		read -p "Install mpv with brew? (y/N): " yn
		if [[ "$yn" =~ ^[Yy]$ ]]; then brew install mpv; fi
	elif check_cmd pacman; then
		read -p "Install mpv with pacman (requires sudo)? (y/N): " yn
		if [[ "$yn" =~ ^[Yy]$ ]]; then sudo pacman -S --noconfirm mpv; fi
	else
		echo "No supported package manager found. Please install mpv manually."; fi
fi

if check_cmd ffmpeg; then
	echo "ffmpeg found: $(ffmpeg -version | head -n1)"
else
	echo "ffmpeg not found. Attempting to install using package manager." 
	if check_cmd apt-get; then
		read -p "Install ffmpeg with apt-get (requires sudo)? (y/N): " yn
		if [[ "$yn" =~ ^[Yy]$ ]]; then sudo apt-get update && sudo apt-get install -y ffmpeg; fi
	elif check_cmd brew; then
		read -p "Install ffmpeg with brew? (y/N): " yn
		if [[ "$yn" =~ ^[Yy]$ ]]; then brew install ffmpeg; fi
	elif check_cmd pacman; then
		read -p "Install ffmpeg with pacman (requires sudo)? (y/N): " yn
		if [[ "$yn" =~ ^[Yy]$ ]]; then sudo pacman -S --noconfirm ffmpeg; fi
	else
		echo "No supported package manager found. Please install ffmpeg manually."; fi
fi

if check_cmd yt-dlp; then
	echo "yt-dlp found: $(yt-dlp --version)"
else
	echo "yt-dlp not found. Attempting to install yt-dlp (pip or curl)"
	if check_cmd pip3; then
		read -p "Install yt-dlp with pip3 --user? (y/N): " yn
		if [[ "$yn" =~ ^[Yy]$ ]]; then pip3 install --user yt-dlp; fi
	elif check_cmd curl; then
		read -p "Download yt-dlp to /usr/local/bin (requires sudo)? (y/N): " yn
		if [[ "$yn" =~ ^[Yy]$ ]]; then sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && sudo chmod a+rx /usr/local/bin/yt-dlp; fi
	else
		echo "No supported installer found. Please install yt-dlp or youtube-dl manually."; fi
fi

echo "Installing Node.js dependencies..."
npm install

echo "Linking package globally (requires npm permissions)..."
npm link

echo "If this script added Node or other tools to your shell profile, please restart your terminal to pick up PATH changes."
detected_shell="unknown"
if [ -n "$SHELL" ]; then detected_shell="$SHELL"; fi
echo "Detected shell: $detected_shell"
echo "Auto restart terminal in 3..2..1 (informational only). Press Ctrl+C to cancel."
for i in 3 2 1; do echo "$i..."; sleep 1; done
echo "Please close and re-open your terminal (Bash/WSL/Git Bash/PowerShell/CMD) to use 'streamweb-cli'."
echo "Done. You can now run 'streamweb-cli' from anywhere after restarting your shell."
