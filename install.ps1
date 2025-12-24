function Test-Command($name) { return (Get-Command $name -ErrorAction SilentlyContinue) -ne $null }

function Ensure-Scoop {
    if (Test-Command scoop) { return $true }
    $ans = Read-Host "Scoop not found. Install Scoop now? (y/N)"
    if ($ans -match '^[Yy]') {
        try {
            Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser -Force
            Invoke-RestMethod -Uri https://get.scoop.sh | Invoke-Expression
        } catch {
            Write-Host "Scoop installation failed: $_"
            return $false
        }
        return (Test-Command scoop)
    }
    return $false
}

try {
    Write-Host "Checking required tools: node, npm, mpv, ffmpeg, yt-dlp"

    if (Test-Command node) { Write-Host "node found: $(node -v)" } else {
            Write-Host "node not found. Attempting to install via scoop (preferred) or winget."
        $installed = $false
        if (Ensure-Scoop) {
            $ans = Read-Host "Install Node.js LTS via scoop? (y/N)"
            if ($ans -match '^[Yy]') { scoop install nodejs-lts; $installed = $true }
        }
        if (-not $installed -and (Test-Command winget)) {
            $ans = Read-Host "Install Node.js LTS via winget? (y/N)"
            if ($ans -match '^[Yy]') { winget install --id OpenJS.NodeJS.LTS -e --silent; $installed = $true }
        }
        if (-not $installed) { Write-Host "Please install Node.js manually and re-run this script."; exit 1 }
    }

    if (-not (Test-Command npm)) { Write-Error "npm not found after Node install. Aborting."; exit 1 }

    if (Test-Command mpv) { Write-Host "mpv found" } else {
        if (Ensure-Scoop) {
            $ans = Read-Host "Install mpv via scoop? (y/N)"
            if ($ans -match '^[Yy]') { scoop install mpv }
        } elseif (Test-Command winget) {
            $ans = Read-Host "Install mpv via winget? (y/N)"
            if ($ans -match '^[Yy]') { winget install --id mpv -e --silent }
        } else { Write-Host "Please install mpv manually (https://mpv.io)" }
    }

    if (Test-Command ffmpeg) { Write-Host "ffmpeg found" } else {
        if (Ensure-Scoop) {
            $ans = Read-Host "Install ffmpeg via scoop? (y/N)"
            if ($ans -match '^[Yy]') { scoop install ffmpeg }
        } elseif (Test-Command winget) {
            $ans = Read-Host "Install ffmpeg via winget? (y/N)"
            if ($ans -match '^[Yy]') { winget install --id Gyan.FFmpeg -e --silent }
        } else { Write-Host "Please install ffmpeg manually (https://ffmpeg.org)" }
    }

    if (Test-Command yt-dlp) { Write-Host "yt-dlp found" } else {
        if (Ensure-Scoop) {
            $ans = Read-Host "Install yt-dlp via scoop? (y/N)"
            if ($ans -match '^[Yy]') { scoop install yt-dlp }
        } elseif (Test-Command winget) {
            $ans = Read-Host "Install yt-dlp via winget? (y/N)"
            if ($ans -match '^[Yy]') { winget install --id yt-dlp.yt-dlp -e --silent }
        } elseif (Test-Command pip) {
            $ans = Read-Host "Install yt-dlp via pip --user? (y/N)"
            if ($ans -match '^[Yy]') { pip install --user yt-dlp }
        } else { Write-Host "Please install yt-dlp or youtube-dl manually." }
    }

    Write-Host "Installing Node.js dependencies..."
    npm install
    Write-Host "Linking package globally..."
    npm link
    Write-Host "If this script added tools to your PATH, please restart your terminal to pick up changes." 
    $hostName = $Host.Name
    Write-Host "Detected host: $hostName"
    Write-Host "Auto restart terminal in 3..2..1 (informational only). Press Ctrl+C to cancel."
    for ($i = 3; $i -ge 1; $i--) { Write-Host "$i..."; Start-Sleep -Seconds 1 }
    $ansOpen = Read-Host "Open a new PowerShell window now? (y/N)"
    if ($ansOpen -match '^[Yy]') {
        if (Get-Command wt -ErrorAction SilentlyContinue) {
            Start-Process wt -ArgumentList "powershell -NoExit -Command Set-Location -LiteralPath '$((Get-Location).Path)'"
        } else {
            Start-Process powershell -ArgumentList "-NoExit","-Command","Set-Location -LiteralPath '$((Get-Location).Path)'"
        }
        Write-Host "Opened new PowerShell window." 
    } else { Write-Host "Please close and re-open your terminal (PowerShell) to use 'streamweb-cli'." }
    Write-Host "Done. You can now run 'streamweb-cli' from anywhere after restarting your shell."
} catch {
    Write-Error "Install/link failed: $_"
    exit 1
}
