[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Test-Command($name) {
    return (Get-Command $name -ErrorAction SilentlyContinue) -ne $null 
}

function Refresh-Env {
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "User") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "Machine")
}

function Ensure-Scoop {
    if (Test-Command scoop) { return $true }
    
    $ans = Read-Host "Scoop not found. Install Scoop now? (y/N)"
    if ($ans -match '^[Yy]') {
        try {
            Write-Host "Installing Scoop..."
            # FIX: Added -ErrorAction SilentlyContinue to prevent crashes if policy is managed by Admin/GPO
            Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser -Force -ErrorAction SilentlyContinue
            Invoke-RestMethod -Uri https://get.scoop.sh | Invoke-Expression
            
            Refresh-Env
            
            if (Test-Command scoop) {
                Write-Host "Scoop installed successfully." -ForegroundColor Green
                return $true
            } else {
                throw "Scoop installed but not found in PATH."
            }
        } catch {
            Write-Error "Scoop installation failed: $_"
            return $false
        }
    }
    return $false
}

try {
    Write-Host "Checking required tools: git, node, npm, mpv, ffmpeg, yt-dlp"

    if (Ensure-Scoop) {
        if (-not (Test-Command git)) {
             Write-Host "Git not found (required for Scoop buckets)."
             $ans = Read-Host "Install Git via Scoop? (y/N)"
             if ($ans -match '^[Yy]') {
                 scoop install git
                 Refresh-Env
             } else {
                 Write-Error "Git is required for MPV installation. Aborting."
                 exit 1
             }
        }
    }

    if (Test-Command node) { Write-Host "node found: $(node -v)" } else {
        Write-Host "node not found. Attempting to install via scoop (preferred) or winget."
        $installed = $false
        
        if (Test-Command scoop) {
            $ans = Read-Host "Install Node.js LTS via scoop? (y/N)"
            if ($ans -match '^[Yy]') { 
                scoop install nodejs-lts
                Refresh-Env 
                $installed = $true 
            }
        }
        
        if (-not $installed -and (Test-Command winget)) {
            $ans = Read-Host "Install Node.js LTS via winget? (y/N)"
            if ($ans -match '^[Yy]') { 
                winget install --id OpenJS.NodeJS.LTS -e --silent
                Refresh-Env
                $installed = $true 
            }
        }
        
        if (-not $installed) { Write-Error "Please install Node.js manually and re-run this script."; exit 1 }
    }

    if (-not (Test-Command npm)) { 
        Refresh-Env 
        if (-not (Test-Command npm)) { Write-Error "npm not found after Node install. Aborting."; exit 1 }
    }

    if (Test-Command mpv) { Write-Host "mpv found" } else {
        if (Test-Command scoop) {
            $ans = Read-Host "Install mpv via scoop? (y/N)"
            if ($ans -match '^[Yy]') { 
                Write-Host "Adding scoop 'extras' bucket..."
                scoop bucket add extras
                scoop install extras/mpv
            }
        } elseif (Test-Command winget) {
            $ans = Read-Host "Install mpv via winget? (y/N)"
            if ($ans -match '^[Yy]') { winget install --id mpv -e --silent }
        } else { 
            Write-Host "Please install mpv manually (https://mpv.io)" 
        }
    }

    if (Test-Command ffmpeg) { Write-Host "ffmpeg found" } else {
        if (Test-Command scoop) {
            $ans = Read-Host "Install ffmpeg via scoop? (y/N)"
            if ($ans -match '^[Yy]') { scoop install ffmpeg }
        } elseif (Test-Command winget) {
            $ans = Read-Host "Install ffmpeg via winget? (y/N)"
            if ($ans -match '^[Yy]') { winget install --id Gyan.FFmpeg -e --silent }
        } else { 
            Write-Host "Please install ffmpeg manually (https://ffmpeg.org)" 
        }
    }

    if (Test-Command yt-dlp) { Write-Host "yt-dlp found" } else {
        if (Test-Command scoop) {
            $ans = Read-Host "Install yt-dlp via scoop? (y/N)"
            if ($ans -match '^[Yy]') { scoop install yt-dlp }
        } elseif (Test-Command winget) {
            $ans = Read-Host "Install yt-dlp via winget? (y/N)"
            if ($ans -match '^[Yy]') { winget install --id yt-dlp.yt-dlp -e --silent }
        } elseif (Test-Command pip) {
            $ans = Read-Host "Install yt-dlp via pip --user? (y/N)"
            if ($ans -match '^[Yy]') { pip install --user yt-dlp }
        } else { 
            Write-Host "Please install yt-dlp manually." 
        }
    }

    Write-Host "Installing Node.js dependencies..."
    npm install
    
    Write-Host "Linking package globally..."
    npm link
    
    Write-Host "Done. If this script added tools to your PATH, please restart your terminal." 

    $hostName = $Host.Name
    
    $ansOpen = Read-Host "Open a new PowerShell window now? (y/N)"
    if ($ansOpen -match '^[Yy]') {
        if (Get-Command wt -ErrorAction SilentlyContinue) {
            Start-Process wt -ArgumentList "powershell -NoExit -Command Set-Location -LiteralPath '$((Get-Location).Path)'"
        } else {
            Start-Process powershell -ArgumentList "-NoExit","-Command","Set-Location -LiteralPath '$((Get-Location).Path)'"
        }
        Write-Host "Opened new PowerShell window." 
    } else { 
        Write-Host "Please close and re-open your terminal to use 'streamweb-cli'." 
    }

} catch {
    Write-Error "An error occurred: $_"
    exit 1
}
