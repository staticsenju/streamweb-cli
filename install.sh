#!/usr/bin/env bash
set -e

check_cmd() { command -v "$1" >/dev/null 2>&1; }

is_termux=false
if [ -n "$PREFIX" ] && [[ "$PREFIX" == *com.termux* || "$PREFIX" == "/data/data/com.termux"* ]]; then
	is_termux=true
fi

is_ish=false
if grep -qi 'ish' /proc/version 2>/dev/null || grep -qi 'alpine' /etc/os-release 2>/dev/null; then
	is_ish=true
fi

echo "Checking required tools: node, npm, mpv, ffmpeg, yt-dlp"

if $is_termux; then
	echo "[Termux detected]"
	echo "Installing/updating required packages with pkg..."
	pkg update -y
	pkg install -y nodejs-lts mpv ffmpeg python yt-dlp
	if ! check_cmd npm; then
		echo "npm not found after installing nodejs-lts. Please check your Termux setup."; exit 1
	fi
	echo "All required packages installed via pkg."
elif $is_ish; then
	echo "[iSH/Alpine detected]"
	echo "Installing required packages with apk..."
	apk update || true
	apk add --no-cache nodejs npm ffmpeg mpv python3 py3-pip curl || true
	if ! check_cmd yt-dlp; then
		pip3 install --user yt-dlp || echo "yt-dlp install failed, continuing anyway."
	fi
	for tool in node npm ffmpeg mpv yt-dlp; do
		if ! check_cmd $tool; then
			echo "$tool not found. Some features may not work, but continuing for test."
		fi
	done
	echo "iSH/Alpine setup done. Continuing with npm install."
else
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
	fia

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
		echo "yt-dlp not found. Attempting to install yt-dlp using your system's package manager."
		if check_cmd apt-get; then
			read -p "Install yt-dlp with apt-get (requires sudo)? (y/N): " yn
			if [[ "$yn" =~ ^[Yy]$ ]]; then sudo apt-get update && sudo apt-get install -y yt-dlp; fi
		elif check_cmd pacman; then
			read -p "Install yt-dlp with pacman (requires sudo)? (y/N): " yn
			if [[ "$yn" =~ ^[Yy]$ ]]; then sudo pacman -S --noconfirm yt-dlp; fi
		elif check_cmd dnf; then
			read -p "Install yt-dlp with dnf (requires sudo)? (y/N): " yn
			if [[ "$yn" =~ ^[Yy]$ ]]; then sudo dnf install -y yt-dlp; fi
		elif check_cmd zypper; then
			read -p "Install yt-dlp with zypper (requires sudo)? (y/N): " yn
			if [[ "$yn" =~ ^[Yy]$ ]]; then sudo zypper install -y yt-dlp; fi
		elif check_cmd brew; then
			read -p "Install yt-dlp with brew? (y/N): " yn
			if [[ "$yn" =~ ^[Yy]$ ]]; then brew install yt-dlp; fi
		else
			echo "No supported package manager found. Trying pipx, pip, or direct download."
			if check_cmd pipx; then
				read -p "Install yt-dlp with pipx? (y/N): " yn
				if [[ "$yn" =~ ^[Yy]$ ]]; then pipx install yt-dlp; fi
			elif check_cmd pip3; then
				read -p "Install yt-dlp with pip3 --user? (y/N): " yn
				if [[ "$yn" =~ ^[Yy]$ ]]; then pip3 install --user yt-dlp || echo "pip3 install failed. See PEP 668 and consider using your system package manager or pipx."; fi
			elif check_cmd curl; then
				read -p "Download yt-dlp to /usr/local/bin (requires sudo)? (y/N): " yn
				if [[ "$yn" =~ ^[Yy]$ ]]; then sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && sudo chmod a+rx /usr/local/bin/yt-dlp; fi
			else
				echo "No supported installer found. Please install yt-dlp or youtube-dl manually.";
			fi
		fi
		# Final check
		if check_cmd yt-dlp; then
			echo "yt-dlp installed successfully: $(yt-dlp --version)"
		else
			echo "yt-dlp installation failed. Please install yt-dlp using your system's package manager (e.g., apt, pacman, dnf, zypper, brew) or pipx. See https://github.com/yt-dlp/yt-dlp/wiki/Installation for help."
			exit 1
		fi
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
	echo "yt-dlp not found. Attempting to install yt-dlp using your system's package manager."
	if check_cmd apt-get; then
		read -p "Install yt-dlp with apt-get (requires sudo)? (y/N): " yn
		if [[ "$yn" =~ ^[Yy]$ ]]; then sudo apt-get update && sudo apt-get install -y yt-dlp; fi
	elif check_cmd pacman; then
		read -p "Install yt-dlp with pacman (requires sudo)? (y/N): " yn
		if [[ "$yn" =~ ^[Yy]$ ]]; then sudo pacman -S --noconfirm yt-dlp; fi
	elif check_cmd dnf; then
		read -p "Install yt-dlp with dnf (requires sudo)? (y/N): " yn
		if [[ "$yn" =~ ^[Yy]$ ]]; then sudo dnf install -y yt-dlp; fi
	elif check_cmd zypper; then
		read -p "Install yt-dlp with zypper (requires sudo)? (y/N): " yn
		if [[ "$yn" =~ ^[Yy]$ ]]; then sudo zypper install -y yt-dlp; fi
	elif check_cmd brew; then
		read -p "Install yt-dlp with brew? (y/N): " yn
		if [[ "$yn" =~ ^[Yy]$ ]]; then brew install yt-dlp; fi
	else
		echo "No supported package manager found. Trying pipx, pip, or direct download."
		if check_cmd pipx; then
			read -p "Install yt-dlp with pipx? (y/N): " yn
			if [[ "$yn" =~ ^[Yy]$ ]]; then pipx install yt-dlp; fi
		elif check_cmd pip3; then
			read -p "Install yt-dlp with pip3 --user? (y/N): " yn
			if [[ "$yn" =~ ^[Yy]$ ]]; then pip3 install --user yt-dlp || echo "pip3 install failed. See PEP 668 and consider using your system package manager or pipx."; fi
		elif check_cmd curl; then
			read -p "Download yt-dlp to /usr/local/bin (requires sudo)? (y/N): " yn
			if [[ "$yn" =~ ^[Yy]$ ]]; then sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && sudo chmod a+rx /usr/local/bin/yt-dlp; fi
		else
			echo "No supported installer found. Please install yt-dlp or youtube-dl manually.";
		fi
	fi
	# Final check
	if check_cmd yt-dlp; then
		echo "yt-dlp installed successfully: $(yt-dlp --version)"
	else
		echo "yt-dlp installation failed. Please install yt-dlp using your system's package manager (e.g., apt, pacman, dnf, zypper, brew) or pipx. See https://github.com/yt-dlp/yt-dlp/wiki/Installation for help."
		exit 1
	fi
fi


echo "Installing Node.js dependencies..."
npm install || echo "npm install failed, but continuing for test."

if $is_termux; then
	echo "[Termux] Installing package locally (no sudo required)..."
	if npm install -g .; then
		echo "Global install succeeded. You can now run 'streamweb-cli' from anywhere in Termux."
	else
		echo "Global install failed. Try restarting Termux or check your npm configuration."
		exit 1
	fi
	echo "If this script added Node or other tools to your shell profile, please restart Termux to pick up PATH changes."
	echo "Done. You can now run 'streamweb-cli' from anywhere in Termux after restarting your shell."
elif $is_ish; then
	echo "[iSH/Alpine] Installing package locally (no sudo required)..."
	if npm install -g .; then
		echo "Global install succeeded. You can now run 'streamweb-cli' from anywhere in iSH."
	else
		echo "Global install failed. Try restarting iSH or check your npm configuration. Continuing anyway for test."
	fi
	echo "If this script added Node or other tools to your shell profile, please restart iSH to pick up PATH changes."
	echo "Done. You can now run 'streamweb-cli' from anywhere in iSH after restarting your shell."
else
	echo "Installing package globally (requires npm permissions)..."
	if npm install -g .; then
		echo "Global install succeeded. You can now run 'streamweb-cli' from anywhere."
	else
		echo "Global install failed. Try running this script with elevated permissions (sudo) or check your npm configuration. Continuing anyway for test."
	fi
	echo "If this script added Node or other tools to your shell profile, please restart your terminal to pick up PATH changes."
	detected_shell="unknown"
	if [ -n "$SHELL" ]; then detected_shell="$SHELL"; fi
	echo "Detected shell: $detected_shell"
	echo "Auto restart terminal in 3..2..1 (informational only). Press Ctrl+C to cancel."
	for i in 3 2 1; do echo "$i..."; sleep 1; done
	echo "Please close and re-open your terminal (Bash/WSL/Git Bash/PowerShell/CMD) to use 'streamweb-cli'."
	echo "Done. You can now run 'streamweb-cli' from anywhere after restarting your shell."
fi

exit 0
