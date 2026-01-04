#Requires -Version 5.1
<#
.SYNOPSIS
    Installs and configures diiisco-node on Windows 10/11

.DESCRIPTION
    This script:
    - Checks for and installs prerequisites (Git, Node.js, Ollama)
    - Clones the diiisco-node repository
    - Installs npm dependencies
    - Creates the environment configuration file
    - Optionally starts the node

.PARAMETER InstallPath
    Where to install diiisco-node (default: $env:USERPROFILE\diiisco-node)

.PARAMETER SkipPrerequisites
    Skip checking/installing Git, Node.js, and Ollama

.PARAMETER AutoStart
    Automatically start the node after installation

.EXAMPLE
    .\Install-DiiiscoNode.ps1
    .\Install-DiiiscoNode.ps1 -InstallPath "D:\diiisco-node"
    .\Install-DiiiscoNode.ps1 -AutoStart

.NOTES
    Run as Administrator for automatic prerequisite installation
    Requires: Internet connection, Algorand wallet (address + mnemonic)
#>

param(
    [string]$InstallPath = "$env:USERPROFILE\diiisco-node",
    [switch]$SkipPrerequisites,
    [switch]$AutoStart
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

function Write-Step { param($msg) Write-Host "`n[*] $msg" -ForegroundColor Cyan }
function Write-Success { param($msg) Write-Host "[+] $msg" -ForegroundColor Green }
function Write-Warn { param($msg) Write-Host "[!] $msg" -ForegroundColor Yellow }
function Write-Err { param($msg) Write-Host "[-] $msg" -ForegroundColor Red }

function Refresh-Path {
    $machinePath = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machinePath;$userPath"
}

function Test-Administrator {
    $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($currentUser)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Test-CommandExists {
    param($Command)
    $null -ne (Get-Command $Command -ErrorAction SilentlyContinue)
}

# ============================================================================
# HARDWARE DETECTION
# ============================================================================

function Get-SystemSpecs {
    Write-Step "Detecting system hardware..."
    
    $specs = @{
        CPU = @{
            Name = "Unknown"
            Cores = 0
            Threads = 0
            Speed = 0
        }
        RAM = @{
            TotalGB = 0
            AvailableGB = 0
        }
        GPU = @{
            Name = "Unknown"
            VRAM_GB = 0
            IsNvidia = $false
            IsAMD = $false
            IsIntel = $false
            IsDedicated = $false
        }
        Tier = "unknown"
    }
    
    # Detect CPU
    try {
        $cpu = Get-CimInstance -ClassName Win32_Processor | Select-Object -First 1
        $specs.CPU.Name = $cpu.Name.Trim()
        $specs.CPU.Cores = $cpu.NumberOfCores
        $specs.CPU.Threads = $cpu.NumberOfLogicalProcessors
        $specs.CPU.Speed = [math]::Round($cpu.MaxClockSpeed / 1000, 2)
        Write-Host "  CPU: $($specs.CPU.Name)" -ForegroundColor Gray
        Write-Host "       $($specs.CPU.Cores) cores / $($specs.CPU.Threads) threads @ $($specs.CPU.Speed) GHz" -ForegroundColor DarkGray
    } catch {
        Write-Warn "Could not detect CPU"
    }
    
    # Detect RAM
    try {
        $os = Get-CimInstance -ClassName Win32_OperatingSystem
        $specs.RAM.TotalGB = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
        $specs.RAM.AvailableGB = [math]::Round($os.FreePhysicalMemory / 1MB, 1)
        Write-Host "  RAM: $($specs.RAM.TotalGB) GB total ($($specs.RAM.AvailableGB) GB available)" -ForegroundColor Gray
    } catch {
        Write-Warn "Could not detect RAM"
    }
    
    # Detect GPU
    try {
        $gpus = Get-CimInstance -ClassName Win32_VideoController
        
        # Find the best GPU (prefer dedicated over integrated)
        $bestGpu = $null
        $bestVram = 0
        
        foreach ($gpu in $gpus) {
            $vram = 0
            if ($gpu.AdapterRAM -and $gpu.AdapterRAM -gt 0) {
                $vram = [math]::Round($gpu.AdapterRAM / 1GB, 1)
                # Handle overflow for GPUs with >4GB VRAM (32-bit limitation)
                if ($vram -lt 0 -or $vram -gt 1000) {
                    # Try to detect from name
                    if ($gpu.Name -match "(\d+)\s*GB") {
                        $vram = [int]$Matches[1]
                    }
                }
            }
            
            $isDedicated = $gpu.Name -notmatch "Intel|UHD|Integrated|Microsoft Basic"
            
            if ($isDedicated -and $vram -ge $bestVram) {
                $bestGpu = $gpu
                $bestVram = $vram
            } elseif (-not $bestGpu) {
                $bestGpu = $gpu
                $bestVram = $vram
            }
        }
        
        if ($bestGpu) {
            $specs.GPU.Name = $bestGpu.Name.Trim()
            $specs.GPU.VRAM_GB = $bestVram
            $specs.GPU.IsNvidia = $bestGpu.Name -match "NVIDIA|GeForce|RTX|GTX|Quadro"
            $specs.GPU.IsAMD = $bestGpu.Name -match "AMD|Radeon|RX\s*\d"
            $specs.GPU.IsIntel = $bestGpu.Name -match "Intel|UHD|Iris"
            $specs.GPU.IsDedicated = $bestGpu.Name -notmatch "Intel|UHD|Integrated|Microsoft Basic"
            
            Write-Host "  GPU: $($specs.GPU.Name)" -ForegroundColor Gray
            
            # Try nvidia-smi for accurate VRAM on NVIDIA cards
            if ($specs.GPU.IsNvidia -and (Test-CommandExists "nvidia-smi")) {
                try {
                    $nvidiaSmi = nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>$null
                    if ($nvidiaSmi) {
                        $specs.GPU.VRAM_GB = [math]::Round([int]$nvidiaSmi.Trim() / 1024, 0)
                    }
                } catch {}
            }
            
            if ($specs.GPU.VRAM_GB -gt 0) {
                Write-Host "       $($specs.GPU.VRAM_GB) GB VRAM" -ForegroundColor DarkGray
            }
        }
    } catch {
        Write-Warn "Could not detect GPU"
    }
    
    # Determine system tier
    $ramGB = $specs.RAM.TotalGB
    $vramGB = $specs.GPU.VRAM_GB
    $hasDedicatedGPU = $specs.GPU.IsDedicated
    
    if ($ramGB -ge 64 -and $vramGB -ge 16) {
        $specs.Tier = "enthusiast"
    } elseif ($ramGB -ge 32 -and $vramGB -ge 8) {
        $specs.Tier = "high"
    } elseif ($ramGB -ge 16 -and ($vramGB -ge 4 -or $hasDedicatedGPU)) {
        $specs.Tier = "mid"
    } elseif ($ramGB -ge 8) {
        $specs.Tier = "low"
    } else {
        $specs.Tier = "minimal"
    }
    
    Write-Host ""
    Write-Host "  System Tier: " -NoNewline -ForegroundColor Gray
    switch ($specs.Tier) {
        "enthusiast" { Write-Host "ENTHUSIAST" -ForegroundColor Magenta }
        "high" { Write-Host "HIGH-END" -ForegroundColor Green }
        "mid" { Write-Host "MID-RANGE" -ForegroundColor Cyan }
        "low" { Write-Host "ENTRY-LEVEL" -ForegroundColor Yellow }
        default { Write-Host "MINIMAL" -ForegroundColor Red }
    }
    
    return $specs
}

function Get-RecommendedModels {
    param($Specs)
    
    # Model database with requirements
    $models = @(
        # Tiny models (1-3B) - Good for minimal/low systems
        @{ Name = "tinyllama"; Size = "637MB"; Params = "1.1B"; MinRAM = 4; MinVRAM = 0; Tier = "minimal"; Description = "Tiny but capable, great for testing" }
        @{ Name = "phi3:mini"; Size = "2.2GB"; Params = "3.8B"; MinRAM = 6; MinVRAM = 0; Tier = "minimal"; Description = "Microsoft's efficient small model" }
        @{ Name = "gemma2:2b"; Size = "1.6GB"; Params = "2B"; MinRAM = 6; MinVRAM = 0; Tier = "minimal"; Description = "Google's compact model" }
        
        # Small models (7-8B) - Good for low/mid systems
        @{ Name = "llama3.2:3b"; Size = "2.0GB"; Params = "3B"; MinRAM = 8; MinVRAM = 2; Tier = "low"; Description = "Meta's latest small model" }
        @{ Name = "mistral:7b"; Size = "4.1GB"; Params = "7B"; MinRAM = 8; MinVRAM = 4; Tier = "low"; Description = "Excellent general-purpose model" }
        @{ Name = "llama3.2:latest"; Size = "2.0GB"; Params = "3B"; MinRAM = 8; MinVRAM = 2; Tier = "low"; Description = "Meta's latest efficient model" }
        @{ Name = "qwen2.5:7b"; Size = "4.4GB"; Params = "7B"; MinRAM = 10; MinVRAM = 4; Tier = "low"; Description = "Alibaba's strong 7B model" }
        @{ Name = "gemma2:9b"; Size = "5.4GB"; Params = "9B"; MinRAM = 12; MinVRAM = 6; Tier = "low"; Description = "Google's capable mid-size model" }
        @{ Name = "deepseek-r1:8b"; Size = "4.9GB"; Params = "8B"; MinRAM = 10; MinVRAM = 4; Tier = "low"; Description = "DeepSeek's reasoning model" }
        
        # Medium models (13-14B) - Good for mid systems
        @{ Name = "llama3:8b"; Size = "4.7GB"; Params = "8B"; MinRAM = 12; MinVRAM = 6; Tier = "mid"; Description = "Meta's balanced performance model" }
        @{ Name = "qwen2.5:14b"; Size = "9.0GB"; Params = "14B"; MinRAM = 16; MinVRAM = 8; Tier = "mid"; Description = "Strong multilingual capabilities" }
        @{ Name = "deepseek-r1:14b"; Size = "9.0GB"; Params = "14B"; MinRAM = 16; MinVRAM = 8; Tier = "mid"; Description = "Advanced reasoning at 14B" }
        @{ Name = "mixtral:8x7b"; Size = "26GB"; Params = "47B"; MinRAM = 32; MinVRAM = 10; Tier = "mid"; Description = "MoE architecture, very capable" }
        
        # Large models (32-70B) - Good for high-end systems  
        @{ Name = "qwen2.5:32b"; Size = "19GB"; Params = "32B"; MinRAM = 32; MinVRAM = 12; Tier = "high"; Description = "Excellent for complex tasks" }
        @{ Name = "deepseek-r1:32b"; Size = "19GB"; Params = "32B"; MinRAM = 32; MinVRAM = 12; Tier = "high"; Description = "Top-tier reasoning model" }
        @{ Name = "llama3:70b"; Size = "40GB"; Params = "70B"; MinRAM = 48; MinVRAM = 16; Tier = "high"; Description = "Meta's flagship model" }
        @{ Name = "codellama:34b"; Size = "19GB"; Params = "34B"; MinRAM = 32; MinVRAM = 12; Tier = "high"; Description = "Specialized for coding" }
        
        # XL models (70B+) - For enthusiast systems
        @{ Name = "qwen2.5:72b"; Size = "43GB"; Params = "72B"; MinRAM = 64; MinVRAM = 24; Tier = "enthusiast"; Description = "Alibaba's flagship model" }
        @{ Name = "llama3.1:70b"; Size = "40GB"; Params = "70B"; MinRAM = 64; MinVRAM = 20; Tier = "enthusiast"; Description = "Latest Llama flagship" }
        @{ Name = "deepseek-r1:70b"; Size = "43GB"; Params = "70B"; MinRAM = 64; MinVRAM = 24; Tier = "enthusiast"; Description = "Best reasoning capabilities" }
        @{ Name = "mixtral:8x22b"; Size = "80GB"; Params = "141B"; MinRAM = 96; MinVRAM = 32; Tier = "enthusiast"; Description = "Massive MoE model" }
        
        # Specialized models - Various tiers
        @{ Name = "codellama:7b"; Size = "3.8GB"; Params = "7B"; MinRAM = 8; MinVRAM = 4; Tier = "low"; Description = "Code-focused model" }
        @{ Name = "starcoder2:7b"; Size = "4.0GB"; Params = "7B"; MinRAM = 10; MinVRAM = 4; Tier = "low"; Description = "Excellent for code generation" }
        @{ Name = "llava:7b"; Size = "4.5GB"; Params = "7B"; MinRAM = 10; MinVRAM = 4; Tier = "low"; Description = "Vision + language model" }
        @{ Name = "dolphin-mixtral:8x7b"; Size = "26GB"; Params = "47B"; MinRAM = 32; MinVRAM = 10; Tier = "mid"; Description = "Uncensored MoE model" }
        @{ Name = "yi:34b"; Size = "19GB"; Params = "34B"; MinRAM = 32; MinVRAM = 12; Tier = "high"; Description = "01.AI's strong model" }
    )
    
    $ramGB = $Specs.RAM.TotalGB
    $vramGB = $Specs.GPU.VRAM_GB
    $tier = $Specs.Tier
    
    # Categorize recommendations
    $recommended = @{
        MustHave = @()
        Recommended = @()
        Optional = @()
        Specialized = @()
    }
    
    foreach ($model in $models) {
        $canRun = ($ramGB -ge $model.MinRAM) -and ($vramGB -ge $model.MinVRAM -or $model.MinVRAM -eq 0)
        
        if (-not $canRun) { continue }
        
        $isSpecialized = $model.Name -match "code|starcoder|llava|dolphin"
        
        if ($isSpecialized) {
            $recommended.Specialized += $model
        } elseif ($model.Tier -eq $tier) {
            $recommended.MustHave += $model
        } elseif ($model.Tier -eq "minimal" -or $model.Tier -eq "low") {
            $recommended.Recommended += $model
        } else {
            $recommended.Optional += $model
        }
    }
    
    # Limit results
    $recommended.MustHave = $recommended.MustHave | Select-Object -First 4
    $recommended.Recommended = $recommended.Recommended | Select-Object -First 4
    $recommended.Optional = $recommended.Optional | Select-Object -First 3
    $recommended.Specialized = $recommended.Specialized | Select-Object -First 3
    
    return $recommended
}

function Show-ModelRecommendations {
    param($Specs)
    
    Write-Host "`n========================================" -ForegroundColor Magenta
    Write-Host "  RECOMMENDED MODELS FOR YOUR SYSTEM" -ForegroundColor Magenta
    Write-Host "========================================" -ForegroundColor Magenta
    
    $recommendations = Get-RecommendedModels -Specs $Specs
    
    # Must Have
    if ($recommendations.MustHave.Count -gt 0) {
        Write-Host "`n  [BEST FOR YOUR HARDWARE]" -ForegroundColor Green
        foreach ($model in $recommendations.MustHave) {
            Write-Host "    * " -NoNewline -ForegroundColor Green
            Write-Host "$($model.Name)" -NoNewline -ForegroundColor White
            Write-Host " ($($model.Size), $($model.Params))" -NoNewline -ForegroundColor DarkGray
            Write-Host " - $($model.Description)" -ForegroundColor Gray
        }
    }
    
    # Recommended  
    if ($recommendations.Recommended.Count -gt 0) {
        Write-Host "`n  [ALSO RECOMMENDED]" -ForegroundColor Cyan
        foreach ($model in $recommendations.Recommended) {
            Write-Host "    - " -NoNewline -ForegroundColor Cyan
            Write-Host "$($model.Name)" -NoNewline -ForegroundColor White
            Write-Host " ($($model.Size))" -NoNewline -ForegroundColor DarkGray
            Write-Host " - $($model.Description)" -ForegroundColor Gray
        }
    }
    
    # Optional
    if ($recommendations.Optional.Count -gt 0) {
        Write-Host "`n  [OPTIONAL - May be slower]" -ForegroundColor Yellow
        foreach ($model in $recommendations.Optional) {
            Write-Host "    - " -NoNewline -ForegroundColor Yellow
            Write-Host "$($model.Name)" -NoNewline -ForegroundColor White
            Write-Host " ($($model.Size))" -ForegroundColor DarkGray
        }
    }
    
    # Specialized
    if ($recommendations.Specialized.Count -gt 0) {
        Write-Host "`n  [SPECIALIZED]" -ForegroundColor Magenta
        foreach ($model in $recommendations.Specialized) {
            Write-Host "    - " -NoNewline -ForegroundColor Magenta
            Write-Host "$($model.Name)" -NoNewline -ForegroundColor White
            Write-Host " - $($model.Description)" -ForegroundColor Gray
        }
    }
    
    Write-Host ""
    
    return $recommendations
}

function Install-RecommendedModels {
    param($Specs)
    
    $recommendations = Show-ModelRecommendations -Specs $Specs
    
    # Get the Ollama port to use
    $ollamaPort = $script:OllamaPort
    if ($ollamaPort -eq 0) { $ollamaPort = 11434 }
    
    # Check if any models already installed
    $existingModels = @()
    try {
        $response = Invoke-RestMethod -Uri "http://localhost:$ollamaPort/api/tags" -TimeoutSec 5 -ErrorAction Stop
        if ($response.models) { $existingModels = $response.models }
    } catch {}
    
    if ($existingModels.Count -gt 0) {
        Write-Host "`n  You already have $($existingModels.Count) model(s) installed:" -ForegroundColor Green
        foreach ($m in $existingModels) {
            Write-Host "    - $($m.name)" -ForegroundColor Gray
        }
    }
    
    # Combine must-have and recommended for install prompt
    $allModels = @()
    $allModels += $recommendations.MustHave
    $allModels += $recommendations.Recommended
    $allModels += $recommendations.Specialized
    
    if ($allModels.Count -eq 0) {
        Write-Warn "No models found suitable for your hardware."
        Write-Host "You can manually install models with: ollama pull <model-name>"
        return
    }
    
    Write-Host "`n----------------------------------------" -ForegroundColor DarkGray
    Write-Host "Diiisco works best with multiple models to serve diverse requests." -ForegroundColor Gray
    Write-Host "More models = more earning potential on the network!" -ForegroundColor Gray
    Write-Host "Models are shared across all Ollama instances." -ForegroundColor Gray
    Write-Host "----------------------------------------" -ForegroundColor DarkGray
    
    Write-Host "`nWould you like to install models now?" -ForegroundColor Yellow
    Write-Host "  [1] Install top recommended models ($(($recommendations.MustHave | Measure-Object).Count) models)" -ForegroundColor White
    Write-Host "  [2] Choose which models to install" -ForegroundColor White
    if ($existingModels.Count -gt 0) {
        Write-Host "  [3] Skip - I already have models installed" -ForegroundColor White
    } else {
        Write-Host "  [3] Skip - I'll install models later " -NoNewline -ForegroundColor White
        Write-Host "(NOT RECOMMENDED)" -ForegroundColor Red
    }
    Write-Host ""
    
    $choice = Read-Host "Select option (1/2/3)"
    
    switch ($choice) {
        "1" {
            $modelsToInstall = $recommendations.MustHave
            if ($modelsToInstall.Count -eq 0) {
                $modelsToInstall = $recommendations.Recommended | Select-Object -First 2
            }
            
            Write-Host ""
            foreach ($model in $modelsToInstall) {
                Write-Step "Installing $($model.Name) ($($model.Size))..."
                ollama pull $model.Name
                if ($LASTEXITCODE -eq 0) {
                    Write-Success "Installed $($model.Name)"
                } else {
                    Write-Warn "Failed to install $($model.Name)"
                }
            }
        }
        "2" {
            Write-Host "`nEnter model numbers to install (comma-separated), or 'all':" -ForegroundColor Yellow
            Write-Host ""
            
            $i = 1
            $modelList = @()
            foreach ($model in $allModels) {
                Write-Host "  [$i] $($model.Name) ($($model.Size)) - $($model.Description)" -ForegroundColor Gray
                $modelList += $model
                $i++
            }
            
            Write-Host ""
            $selection = Read-Host "Selection"
            
            $indicesToInstall = @()
            if ($selection -eq "all") {
                $indicesToInstall = 1..$modelList.Count
            } else {
                $indicesToInstall = $selection -split ',' | ForEach-Object { [int]$_.Trim() }
            }
            
            Write-Host ""
            foreach ($idx in $indicesToInstall) {
                if ($idx -ge 1 -and $idx -le $modelList.Count) {
                    $model = $modelList[$idx - 1]
                    Write-Step "Installing $($model.Name) ($($model.Size))..."
                    ollama pull $model.Name
                    if ($LASTEXITCODE -eq 0) {
                        Write-Success "Installed $($model.Name)"
                    } else {
                        Write-Warn "Failed to install $($model.Name)"
                    }
                }
            }
        }
        default {
            if ($existingModels.Count -eq 0) {
                Write-Host ""
                Write-Host "  +==============================================================+" -ForegroundColor Yellow
                Write-Host "  |                        WARNING                               |" -ForegroundColor Yellow
                Write-Host "  +==============================================================+" -ForegroundColor Yellow
                Write-Host "  |  You have NO models installed!                              |" -ForegroundColor Yellow
                Write-Host "  |  Your Diiisco node will NOT work without at least 1 model. |" -ForegroundColor Yellow
                Write-Host "  |                                                              |" -ForegroundColor Yellow
                Write-Host "  |  Install a model before starting the node:                  |" -ForegroundColor Yellow
                Write-Host "  |    ollama pull llama3.2                                     |" -ForegroundColor Yellow
                Write-Host "  +==============================================================+" -ForegroundColor Yellow
                Write-Host ""
            } else {
                Write-Host "`nSkipping - using existing models." -ForegroundColor Gray
            }
        }
    }
}

# ============================================================================
# PREREQUISITE INSTALLATION
# ============================================================================

function Install-Winget {
    if (-not (Test-CommandExists "winget")) {
        Write-Warn "winget not found. Attempting to install..."
        try {
            Add-AppxPackage -RegisterByFamilyName -MainPackage Microsoft.DesktopAppInstaller_8wekyb3d8bbwe -ErrorAction Stop
            Write-Success "winget installed successfully"
        } catch {
            Write-Err "Could not install winget automatically."
            Write-Host "Please install 'App Installer' from the Microsoft Store manually."
            Write-Host "URL: https://apps.microsoft.com/store/detail/app-installer/9NBLGGH4NNS1"
            exit 1
        }
    }
}

function Install-Git {
    Write-Step "Checking for Git..."
    
    if (Test-CommandExists "git") {
        $gitVersion = git --version
        Write-Success "Git is already installed: $gitVersion"
        return
    }
    
    Write-Warn "Git not found. Installing..."
    
    if (Test-Administrator) {
        Install-Winget
        winget install --id Git.Git -e --silent --accept-package-agreements --accept-source-agreements
        
        # Refresh PATH
        Refresh-Path
        
        if (Test-CommandExists "git") {
            Write-Success "Git installed successfully"
        } else {
            Write-Err "Git installation completed but 'git' command not found."
            Write-Host "Please restart your terminal or add Git to PATH manually."
            exit 1
        }
    } else {
        Write-Err "Git is not installed and admin rights are required for automatic installation."
        Write-Host "Please either:"
        Write-Host "  1. Run this script as Administrator"
        Write-Host "  2. Install Git manually from: https://git-scm.com/download/win"
        exit 1
    }
}

function Install-NodeJS {
    Write-Step "Checking for Node.js..."
    
    if (Test-CommandExists "node") {
        $nodeVersion = node --version
        Write-Success "Node.js is already installed: $nodeVersion"
        
        $versionNum = [int]($nodeVersion -replace 'v(\d+)\..*', '$1')
        if ($versionNum -lt 18) {
            Write-Warn "Node.js version $nodeVersion may be too old. Version 18+ recommended."
        }
        return
    }
    
    Write-Warn "Node.js not found. Installing..."
    
    if (Test-Administrator) {
        Install-Winget
        winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements
        
        # Refresh PATH
        Refresh-Path
        
        if (Test-CommandExists "node") {
            $nodeVersion = node --version
            Write-Success "Node.js installed successfully: $nodeVersion"
        } else {
            Write-Err "Node.js installation completed but 'node' command not found."
            Write-Host "Please restart your terminal and run this script again."
            exit 1
        }
    } else {
        Write-Err "Node.js is not installed and admin rights are required for automatic installation."
        Write-Host "Please either:"
        Write-Host "  1. Run this script as Administrator"
        Write-Host "  2. Install Node.js manually from: https://nodejs.org/"
        exit 1
    }
}

function Test-OllamaInstalled {
    if (Test-CommandExists "ollama") { return $true }
    
    $commonPaths = @(
        "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe",
        "$env:ProgramFiles\Ollama\ollama.exe",
        "${env:ProgramFiles(x86)}\Ollama\ollama.exe"
    )
    
    foreach ($path in $commonPaths) {
        if (Test-Path $path) { return $true }
    }
    
    return $false
}

function Test-OllamaRunning {
    param([int]$Port = 11434)
    try {
        $tcpClient = New-Object System.Net.Sockets.TcpClient
        $tcpClient.Connect("127.0.0.1", $Port)
        $tcpClient.Close()
        return $true
    } catch {
        return $false
    }
}

function Find-AvailablePort {
    param([int]$StartPort = 11435)
    
    $port = $StartPort
    $maxPort = $StartPort + 100
    
    while ($port -lt $maxPort) {
        try {
            $tcpClient = New-Object System.Net.Sockets.TcpClient
            $tcpClient.Connect("127.0.0.1", $port)
            $tcpClient.Close()
            $port++
        } catch {
            return $port
        }
    }
    
    return $null
}

function Get-OllamaInstanceInfo {
    param([int]$Port = 11434)
    
    try {
        $response = Invoke-RestMethod -Uri "http://localhost:$Port/api/tags" -TimeoutSec 3 -ErrorAction Stop
        $modelCount = 0
        $modelNames = ""
        if ($response.models) {
            $modelCount = $response.models.Count
            $modelNames = ($response.models | ForEach-Object { $_.name }) -join ", "
        }
        $result = @{
            Running = $true
            Port = $Port
            Models = $modelCount
            ModelNames = $modelNames
        }
        return $result
    }
    catch {
        $result = @{
            Running = $false
            Port = $Port
            Models = 0
            ModelNames = ""
        }
        return $result
    }
}

function Start-DedicatedOllamaInstance {
    Write-Step "Checking for existing Ollama instances..."
    
    $defaultPort = 11434
    $existingInstance = Get-OllamaInstanceInfo -Port $defaultPort
    
    if ($existingInstance.Running) {
        Write-Host "  Found existing Ollama instance on port $defaultPort" -ForegroundColor Yellow
        if ($existingInstance.Models -gt 0) {
            Write-Host "  Models: $($existingInstance.ModelNames)" -ForegroundColor Gray
        }
        
        Write-Host ""
        Write-Host "  An Ollama instance is already running." -ForegroundColor Yellow
        Write-Host ""
        Write-Host "  To avoid conflicts between Diiisco and other apps using Ollama," -ForegroundColor Gray
        Write-Host "  you can create a dedicated instance for Diiisco." -ForegroundColor Gray
        Write-Host ""
        Write-Host "  OPTIONS:" -ForegroundColor Cyan
        Write-Host "    [1] Use existing instance (port $defaultPort)" -ForegroundColor White
        Write-Host "        - Diiisco will share Ollama with other apps" -ForegroundColor DarkGray
        Write-Host "        - May cause conflicts if other apps are using Ollama" -ForegroundColor DarkGray
        Write-Host ""
        Write-Host "    [2] Create dedicated Diiisco instance (RECOMMENDED)" -ForegroundColor White
        Write-Host "        - Runs on a separate port (no conflicts)" -ForegroundColor DarkGray
        Write-Host "        - All $($existingInstance.Models) models instantly available" -ForegroundColor DarkGray
        Write-Host "        - NO extra disk space (models are shared)" -ForegroundColor DarkGray
        Write-Host "        - Diiisco gets its own isolated Ollama process" -ForegroundColor DarkGray
        Write-Host ""
        
        $choice = Read-Host "  Select option (1/2)"
        
        if ($choice -eq "2") {
            $newPort = Find-AvailablePort -StartPort 11435
            
            if (-not $newPort) {
                Write-Err "Could not find an available port for Ollama"
                return @{ Port = $defaultPort; Dedicated = $false }
            }
            
            Write-Host ""
            Write-Step "Creating dedicated Diiisco Ollama instance on port $newPort..."
            Write-Host "  (Models are shared - no extra disk space used)" -ForegroundColor Gray
            
            $ollamaExe = $null
            $searchPaths = @(
                "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe",
                "$env:ProgramFiles\Ollama\ollama.exe"
            )
            
            $ollamaCmd = Get-Command "ollama" -ErrorAction SilentlyContinue
            if ($ollamaCmd) { $searchPaths += $ollamaCmd.Source }
            
            foreach ($path in $searchPaths) {
                if ($path -and (Test-Path $path)) {
                    $ollamaExe = $path
                    break
                }
            }
            
            if (-not $ollamaExe) {
                Write-Warn "Could not find Ollama executable"
                Write-Host "  Using existing instance on port $defaultPort" -ForegroundColor Gray
                return @{ Port = $defaultPort; Dedicated = $false }
            }
            
            try {
                $psi = New-Object System.Diagnostics.ProcessStartInfo
                $psi.FileName = $ollamaExe
                $psi.Arguments = "serve"
                $psi.UseShellExecute = $false
                $psi.CreateNoWindow = $true
                $psi.EnvironmentVariables["OLLAMA_HOST"] = "127.0.0.1:$newPort"
                
                $process = [System.Diagnostics.Process]::Start($psi)
                
                $maxWait = 15
                $waited = 0
                Write-Host "  Waiting for Ollama to start" -NoNewline -ForegroundColor Gray
                while (-not (Test-OllamaRunning -Port $newPort) -and $waited -lt $maxWait) {
                    Start-Sleep -Seconds 1
                    $waited++
                    Write-Host "." -NoNewline
                }
                Write-Host ""
                
                if (Test-OllamaRunning -Port $newPort) {
                    Write-Success "Dedicated Diiisco Ollama instance created!"
                    
                    $pidFile = Join-Path $InstallPath "ollama.pid"
                    Set-Content -Path $pidFile -Value $process.Id -Force
                    
                    $portFile = Join-Path $InstallPath "ollama.port"
                    Set-Content -Path $portFile -Value $newPort -Force
                    
                    Write-Host ""
                    Write-Host "  +==============================================================+" -ForegroundColor Green
                    Write-Host "  |           DEDICATED DIIISCO OLLAMA INSTANCE                 |" -ForegroundColor Green
                    Write-Host "  +==============================================================+" -ForegroundColor Green
                    Write-Host "  |  Port: $($newPort.ToString().PadRight(54))|" -ForegroundColor Green
                    Write-Host "  |  PID:  $($process.Id.ToString().PadRight(54))|" -ForegroundColor Green
                    Write-Host "  |                                                              |" -ForegroundColor Green
                    Write-Host "  |  - Isolated from other Ollama applications                  |" -ForegroundColor Green
                    Write-Host "  |  - All $($existingInstance.Models.ToString().PadRight(2)) models available (shared storage)            |" -ForegroundColor Green
                    Write-Host "  |  - No extra disk space used                                 |" -ForegroundColor Green
                    Write-Host "  |  - No conflicts with port $defaultPort                            |" -ForegroundColor Green
                    Write-Host "  +==============================================================+" -ForegroundColor Green
                    Write-Host ""
                    
                    $script:OllamaPort = $newPort
                    return @{ Port = $newPort; Dedicated = $true; PID = $process.Id }
                } else {
                    Write-Warn "Dedicated instance failed to start"
                    Write-Host "  Falling back to existing instance on port $defaultPort" -ForegroundColor Gray
                    return @{ Port = $defaultPort; Dedicated = $false }
                }
            } catch {
                Write-Warn "Failed to start dedicated instance: $_"
                Write-Host "  Using existing instance on port $defaultPort" -ForegroundColor Gray
                return @{ Port = $defaultPort; Dedicated = $false }
            }
        } else {
            Write-Success "Using existing Ollama instance on port $defaultPort"
            Write-Host "  Note: Other apps using Ollama may affect Diiisco performance" -ForegroundColor Yellow
            return @{ Port = $defaultPort; Dedicated = $false }
        }
    } else {
        Write-Host "  No existing Ollama instance found" -ForegroundColor Gray
        $started = Start-OllamaService
        if ($started) {
            return @{ Port = $defaultPort; Dedicated = $false }
        } else {
            return @{ Port = $defaultPort; Dedicated = $false; Failed = $true }
        }
    }
}

# Global variable to track Ollama port for this session
$script:OllamaPort = 11434

function Test-OllamaModelsInstalled {
    param([int]$Port = 0)
    
    # Use provided port, script-level port, or default
    if ($Port -eq 0) { $Port = $script:OllamaPort }
    if ($Port -eq 0) { $Port = 11434 }
    
    Write-Step "Checking for installed Ollama models (port $Port)..."
    
    if (-not (Test-OllamaRunning -Port $Port)) {
        Write-Err "Ollama is not running on port $Port!"
        Write-Host "  Please start Ollama first:" -ForegroundColor Yellow
        Write-Host "    - Open the Ollama app from your Start menu, OR" -ForegroundColor Gray
        Write-Host "    - Run 'ollama serve' in a separate terminal" -ForegroundColor Gray
        return $false
    }
    
    try {
        $response = Invoke-RestMethod -Uri "http://localhost:$Port/api/tags" -TimeoutSec 10 -ErrorAction Stop
        
        if (-not $response.models -or $response.models.Count -eq 0) {
            Write-Host ""
            Write-Host "  +==============================================================+" -ForegroundColor Red
            Write-Host "  |                    NO MODELS INSTALLED                       |" -ForegroundColor Red
            Write-Host "  +==============================================================+" -ForegroundColor Red
            Write-Host "  |  Diiisco requires at least one Ollama model to function.    |" -ForegroundColor Red
            Write-Host "  |                                                              |" -ForegroundColor Red
            Write-Host "  |  The whole point of Diiisco is to share LLM compute!        |" -ForegroundColor Red
            Write-Host "  |  Without models, your node has nothing to offer.            |" -ForegroundColor Red
            Write-Host "  +==============================================================+" -ForegroundColor Red
            Write-Host ""
            Write-Host "  Install models with:" -ForegroundColor Yellow
            Write-Host "    ollama pull llama3.2        # Small, fast model (2GB)" -ForegroundColor Gray
            Write-Host "    ollama pull mistral:7b      # Great general-purpose (4GB)" -ForegroundColor Gray
            Write-Host "    ollama pull qwen2.5:7b      # Strong multilingual (4GB)" -ForegroundColor Gray
            Write-Host "    ollama pull codellama:7b    # Code-focused (4GB)" -ForegroundColor Gray
            Write-Host ""
            Write-Host "  Models are shared across all Ollama instances." -ForegroundColor Gray
            Write-Host "  Or run this script again to get personalized recommendations" -ForegroundColor Yellow
            Write-Host "  based on your hardware specs." -ForegroundColor Yellow
            Write-Host ""
            return $false
        }
        
        $modelCount = $response.models.Count
        Write-Success "Found $modelCount installed model(s):"
        foreach ($model in $response.models) {
            $size = ""
            if ($model.size) { $size = " (" + [math]::Round($model.size / 1GB, 1).ToString() + " GB)" }
            Write-Host "    - $($model.name)$size" -ForegroundColor Gray
        }
        
        return $true
    } catch {
        Write-Err "Could not connect to Ollama API: $_"
        Write-Host "  Make sure Ollama is running and accessible at http://localhost:$Port" -ForegroundColor Yellow
        return $false
    }
}

function Install-Ollama {
    Write-Step "Checking for Ollama..."
    
    if (Test-OllamaInstalled) {
        Write-Success "Ollama is already installed"
        return $true
    }
    
    Write-Warn "Ollama not found. Installing..."
    
    if (Test-Administrator) {
        Install-Winget
        
        Write-Host "Installing Ollama via winget..." -ForegroundColor Cyan
        winget install --id Ollama.Ollama -e --silent --accept-package-agreements --accept-source-agreements
        
        if ($LASTEXITCODE -ne 0) {
            Write-Warn "winget installation failed. Trying direct download..."
            
            $ollamaInstaller = "$env:TEMP\OllamaSetup.exe"
            Write-Host "Downloading Ollama installer..."
            
            try {
                Invoke-WebRequest -Uri "https://ollama.com/download/OllamaSetup.exe" -OutFile $ollamaInstaller -UseBasicParsing
                Write-Host "Running Ollama installer (silent)..."
                Start-Process -FilePath $ollamaInstaller -ArgumentList "/S" -Wait -NoNewWindow
                Remove-Item $ollamaInstaller -Force -ErrorAction SilentlyContinue
            } catch {
                Write-Err "Failed to download/install Ollama: $_"
                Write-Host "Please install Ollama manually from: https://ollama.com/download"
                return $false
            }
        }
        
        # Refresh PATH
        Refresh-Path
        
        Start-Sleep -Seconds 2
        
        if (Test-OllamaInstalled) {
            Write-Success "Ollama installed successfully"
            return $true
        } else {
            Write-Warn "Ollama installed but command not found in PATH."
            Write-Host "You may need to restart your terminal or log out and back in."
            return $true
        }
    } else {
        Write-Err "Ollama is not installed and admin rights are required for automatic installation."
        Write-Host "Please either:"
        Write-Host "  1. Run this script as Administrator"
        Write-Host "  2. Install Ollama manually from: https://ollama.com/download"
        return $false
    }
}

function Start-OllamaService {
    Write-Step "Ensuring Ollama is running..."
    
    if (Test-OllamaRunning) {
        Write-Success "Ollama is already running"
        return $true
    }
    
    Write-Host "Starting Ollama service..."
    
    $ollamaExePaths = @(
        "$env:LOCALAPPDATA\Programs\Ollama\ollama app.exe",
        "$env:LOCALAPPDATA\Programs\Ollama\Ollama.exe",
        "$env:ProgramFiles\Ollama\ollama app.exe"
    )
    
    foreach ($exePath in $ollamaExePaths) {
        if (Test-Path $exePath) {
            Write-Host "Starting Ollama from: $exePath"
            Start-Process -FilePath $exePath -WindowStyle Hidden
            
            $maxWait = 15
            $waited = 0
            while (-not (Test-OllamaRunning) -and $waited -lt $maxWait) {
                Start-Sleep -Seconds 1
                $waited++
                Write-Host "." -NoNewline
            }
            Write-Host ""
            
            if (Test-OllamaRunning) {
                Write-Success "Ollama started successfully"
                return $true
            }
        }
    }
    
    Write-Warn "Could not start Ollama automatically."
    Write-Host "Please start Ollama manually by:"
    Write-Host "  - Opening the Ollama app from your Start menu, OR"
    Write-Host "  - Running 'ollama serve' in a separate terminal"
    
    return $false
}

function Detect-OllamaRuntime {
    Write-Step "Auto-detecting Ollama runtime..."
    
    $baseURL = "http://localhost"
    $port = 11434
    
    # Check OLLAMA_HOST environment variable
    $ollamaHostEnv = $env:OLLAMA_HOST
    if ($ollamaHostEnv) {
        Write-Host "Found OLLAMA_HOST: $ollamaHostEnv"
        if ($ollamaHostEnv -match '^(https?://)?([^:]+):?(\d+)?$') {
            $baseURL = "http://$($Matches[2])"
            if ($Matches[3]) { $port = [int]$Matches[3] }
        }
    }
    
    # Ports to check
    $portsToCheck = @($port, 11434, 8080, 3000, 5000) | Select-Object -Unique
    
    foreach ($testPort in $portsToCheck) {
        $testURL = "${baseURL}:${testPort}"
        
        try {
            $response = Invoke-RestMethod -Uri "${testURL}/api/tags" -Method GET -TimeoutSec 3 -ErrorAction Stop
            
            $modelCount = 0
            $modelNames = "none"
            if ($response.models) {
                $modelCount = $response.models.Count
                $modelNames = ($response.models | ForEach-Object { $_.name }) -join ", "
            }
            
            Write-Success "Found Ollama at ${testURL} ($modelCount models: $modelNames)"
            
            return @{
                Host = $baseURL
                Port = $testPort
                URL = $testURL
                Models = $modelCount
                ModelNames = $modelNames
            }
        } catch {
            # Try version endpoint as backup
            try {
                $null = Invoke-WebRequest -Uri "${testURL}/api/version" -Method GET -TimeoutSec 2 -ErrorAction Stop
                Write-Success "Found Ollama at ${testURL}"
                return @{
                    Host = $baseURL
                    Port = $testPort
                    URL = $testURL
                    Models = 0
                    ModelNames = "unknown"
                }
            } catch {
                # Continue to next port
            }
        }
    }
    
    Write-Warn "Could not auto-detect Ollama runtime!"
    Write-Host "Make sure Ollama is running."
    return $null
}

# ============================================================================
# REPOSITORY SETUP
# ============================================================================

# Global variable to track which repo was used
$script:RepoSource = "official"

function Clone-Repository {
    Write-Step "Selecting diiisco-node repository..."
    
    Write-Host ""
    Write-Host "  Choose which repository to install from:" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  [1] Official Repository (RECOMMENDED)" -ForegroundColor White
    Write-Host "      github.com/Diiisco-Inc/diiisco-node" -ForegroundColor DarkGray
    Write-Host "      - Stable, tested releases" -ForegroundColor DarkGray
    Write-Host "      - Official support from Diiisco team" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  [2] Fry Networks Fork (EXPERIMENTAL)" -ForegroundColor White
    Write-Host "      github.com/FrysCrypto/diiisco-node" -ForegroundColor DarkGray
    Write-Host "      - May include experimental features" -ForegroundColor DarkGray
    Write-Host "      - Keep-alive pings & auto-reconnection" -ForegroundColor DarkGray
    Write-Host "      - Community maintained" -ForegroundColor DarkGray
    Write-Host ""
    
    $repoChoice = Read-Host "  Select repository (1/2)"
    
    $repoUrl = ""
    if ($repoChoice -eq "2") {
        $repoUrl = "https://github.com/FrysCrypto/diiisco-node.git"
        $script:RepoSource = "frynetworks"
        Write-Host ""
        Write-Host "  Using Fry Networks fork (experimental)" -ForegroundColor Cyan
    } else {
        $repoUrl = "https://github.com/Diiisco-Inc/diiisco-node.git"
        $script:RepoSource = "official"
        Write-Host ""
        Write-Host "  Using official Diiisco repository" -ForegroundColor Green
    }
    
    Write-Step "Cloning diiisco-node repository..."
    
    if (Test-Path $InstallPath) {
        Write-Warn "Directory already exists: $InstallPath"
        $response = Read-Host "Do you want to delete and re-clone? (y/N)"
        if ($response -eq 'y' -or $response -eq 'Y') {
            Remove-Item -Recurse -Force $InstallPath
        } else {
            Write-Host "Using existing directory..."
            return
        }
    }
    
    git clone $repoUrl $InstallPath
    
    if ($LASTEXITCODE -ne 0) {
        Write-Err "Failed to clone repository"
        exit 1
    }
    
    Write-Success "Repository cloned to: $InstallPath"
}

function Install-Dependencies {
    Write-Step "Installing npm dependencies..."
    
    Push-Location $InstallPath
    try {
        npm install
        
        if ($LASTEXITCODE -ne 0) {
            Write-Err "Failed to install npm dependencies"
            exit 1
        }
        
        Write-Success "Dependencies installed successfully"
    } finally {
        Pop-Location
    }
}

# ============================================================================
# ENVIRONMENT CONFIGURATION
# ============================================================================

function Create-EnvironmentConfig {
    Write-Step "Creating environment configuration..."
    
    $envDir = Join-Path $InstallPath "src\environment"
    $envFile = Join-Path $envDir "environment.ts"
    
    if (Test-Path $envFile) {
        Write-Warn "environment.ts already exists"
        $response = Read-Host "Do you want to reconfigure? (y/N)"
        if ($response -ne 'y' -and $response -ne 'Y') {
            return
        }
    }
    
    Write-Host "`n========================================" -ForegroundColor Magenta
    Write-Host "  DIIISCO NODE CONFIGURATION" -ForegroundColor Magenta
    Write-Host "========================================`n" -ForegroundColor Magenta
    
    # --- LLM Configuration ---
    Write-Host "--- Local LLM Settings ---" -ForegroundColor Yellow
    
    # Check if we have a dedicated Ollama port already set
    $ollamaPort = $script:OllamaPort
    if ($ollamaPort -and $ollamaPort -ne 0 -and $ollamaPort -ne 11434) {
        Write-Host "`nUsing dedicated Ollama instance on port $ollamaPort" -ForegroundColor Cyan
        $llmBaseURL = "http://localhost"
        $llmPort = $ollamaPort
        
        # Check for models on dedicated instance
        try {
            $response = Invoke-RestMethod -Uri "http://localhost:$ollamaPort/api/tags" -TimeoutSec 3 -ErrorAction Stop
            if ($response.models -and $response.models.Count -gt 0) {
                Write-Host "Available models: $(($response.models | ForEach-Object { $_.name }) -join ', ')" -ForegroundColor Green
            }
        } catch {}
    } else {
        $ollamaDetected = Detect-OllamaRuntime
        
        if ($ollamaDetected) {
            Write-Host "`nUsing detected Ollama endpoint: $($ollamaDetected.URL)" -ForegroundColor Green
            if ($ollamaDetected.Models -gt 0) {
                Write-Host "Available models: $($ollamaDetected.ModelNames)" -ForegroundColor Green
            }
            
            $useDetected = Read-Host "`nUse this endpoint? (Y/n)"
            if ($useDetected -eq 'n' -or $useDetected -eq 'N') {
                $llmBaseURL = Read-Host "LLM Base URL [http://localhost]"
                if ([string]::IsNullOrWhiteSpace($llmBaseURL)) { $llmBaseURL = "http://localhost" }
                
                $llmPort = Read-Host "LLM Port [$($script:OllamaPort)]"
                if ([string]::IsNullOrWhiteSpace($llmPort)) { $llmPort = $script:OllamaPort }
                if ([string]::IsNullOrWhiteSpace($llmPort) -or $llmPort -eq 0) { $llmPort = "11434" }
            } else {
                $llmBaseURL = $ollamaDetected.Host
                $llmPort = $ollamaDetected.Port
            }
        } else {
            Write-Host "`nNo Ollama runtime detected. Please enter manually:" -ForegroundColor Yellow
            
            $llmBaseURL = Read-Host "LLM Base URL [http://localhost]"
            if ([string]::IsNullOrWhiteSpace($llmBaseURL)) { $llmBaseURL = "http://localhost" }
            
            $defaultPort = if ($script:OllamaPort -and $script:OllamaPort -ne 0) { $script:OllamaPort } else { "11434" }
            $llmPort = Read-Host "LLM Port [$defaultPort]"
            if ([string]::IsNullOrWhiteSpace($llmPort)) { $llmPort = $defaultPort }
        }
    }
    
    $llmApiKey = Read-Host "`nLLM API Key (leave blank if not needed - Ollama doesn't require one)"
    if ([string]::IsNullOrWhiteSpace($llmApiKey)) { $llmApiKey = "" }
    
    $chargePer1K = Read-Host "Charge per 1K tokens (default) [0.000001]"
    if ([string]::IsNullOrWhiteSpace($chargePer1K)) { $chargePer1K = "0.000001" }
    
    # --- Algorand Configuration ---
    Write-Host "`n--- Algorand Wallet Settings ---" -ForegroundColor Yellow
    Write-Host "You need an Algorand wallet to receive payments."
    Write-Host "Get one at: https://perawallet.app/`n"
    
    $algoAddr = Read-Host "Algorand Wallet Address"
    while ([string]::IsNullOrWhiteSpace($algoAddr)) {
        Write-Warn "Algorand address is required!"
        $algoAddr = Read-Host "Algorand Wallet Address"
    }
    
    Write-Host "`n[!] Your mnemonic (25 words) will be stored in the config file." -ForegroundColor Red
    Write-Host "[!] Keep this file secure and never share it!`n" -ForegroundColor Red
    
    $validMnemonic = $false
    while (-not $validMnemonic) {
        $algoMnemonic = Read-Host "Algorand Mnemonic (25 words, space-separated)"
        
        if ([string]::IsNullOrWhiteSpace($algoMnemonic)) {
            Write-Warn "Algorand mnemonic is required!"
            continue
        }
        
        # Clean up the mnemonic
        $algoMnemonic = ($algoMnemonic.Trim() -replace '\s+', ' ').ToLower()
        $wordCount = ($algoMnemonic -split ' ').Count
        
        if ($wordCount -ne 25) {
            Write-Warn "Invalid mnemonic! Expected 25 words, got $wordCount words."
            Write-Host "Please enter all 25 words separated by single spaces."
            continue
        }
        
        $validMnemonic = $true
    }
    Write-Success "Mnemonic accepted (25 words)"
    
    $algoNetwork = Read-Host "`nAlgorand Network [mainnet/testnet] (mainnet)"
    if ($algoNetwork -eq "testnet") {
        $algoNodeURL = "https://testnet-api.algonode.cloud/"
    } else {
        $algoNodeURL = "https://mainnet-api.algonode.cloud/"
        $algoNetwork = "mainnet"
    }
    
    # --- API Configuration ---
    Write-Host "`n--- API Settings ---" -ForegroundColor Yellow
    
    $apiPort = Read-Host "API Port [4200]"
    if ([string]::IsNullOrWhiteSpace($apiPort)) { $apiPort = "4200" }
    
    $enableAuth = Read-Host "Enable Bearer Authentication? (Y/n)"
    $bearerAuth = if ($enableAuth -eq 'n' -or $enableAuth -eq 'N') { "false" } else { "true" }
    
    # Generate random API keys
    $apiKey1 = "sk-" + (-join ((65..90) + (97..122) + (48..57) | Get-Random -Count 32 | ForEach-Object { [char]$_ }))
    $apiKey2 = "sk-" + (-join ((65..90) + (97..122) + (48..57) | Get-Random -Count 32 | ForEach-Object { [char]$_ }))
    
    Write-Host "`nGenerated API Keys:" -ForegroundColor Green
    Write-Host "  Key 1: $apiKey1"
    Write-Host "  Key 2: $apiKey2"
    
    # --- Node Configuration ---
    Write-Host "`n--- Node Settings ---" -ForegroundColor Yellow
    
    $nodePort = Read-Host "Node P2P Port [4242]"
    if ([string]::IsNullOrWhiteSpace($nodePort)) { $nodePort = "4242" }
    
    # PeerId storage path
    $peerIdPath = (Join-Path $InstallPath "peerid") -replace '\\', '/'
    
    # Create the environment file content
    $envContent = @"
import { Environment } from "./environment.types";
import { selectHighestStakeQuote } from "../utils/quoteSelectionMethods";

const environment: Environment = {
  peerIdStorage: {
    path: "$peerIdPath/"
  },
  models: {
    enabled: true,
    baseURL: "$llmBaseURL",
    port: $llmPort,
    apiKey: "$llmApiKey",
    chargePer1KTokens: {
      default: $chargePer1K,
    }
  },
  algorand: {
    addr: "$algoAddr",
    mnemonic: "$algoMnemonic",
    network: "$algoNetwork",
    client: {
      address: "$algoNodeURL",
      port: 443,
      token: ""
    },
  },
  api: {
    enabled: true,
    bearerAuthentication: $bearerAuth,
    keys: [
      "$apiKey1",
      "$apiKey2"
    ],
    port: $apiPort
  },
  quoteEngine: {
    waitTime: 1000,
    quoteSelectionFunction: selectHighestStakeQuote,
  },
  libp2pBootstrapServers: [
    "lon.diiisco.algo",
    "nyc.diiisco.algo",
  ],
  node: {
    url: "http://localhost",
    port: $nodePort
  }
}

export default environment;
"@
    
    # Ensure directory exists
    if (-not (Test-Path $envDir)) {
        New-Item -ItemType Directory -Path $envDir -Force | Out-Null
    }
    
    Set-Content -Path $envFile -Value $envContent -Encoding UTF8
    Write-Success "Environment configuration saved to: $envFile"
    
    # Create peerid storage directory
    $peerIdDir = Join-Path $InstallPath "peerid"
    if (-not (Test-Path $peerIdDir)) {
        New-Item -ItemType Directory -Path $peerIdDir -Force | Out-Null
        Write-Host "Created PeerId storage directory: $peerIdDir"
    }
    
    # Save API keys and info to reference file
    $keysFile = Join-Path $InstallPath "API_KEYS.txt"
    
    $keysContent = "DIIISCO NODE - CONFIGURATION REFERENCE`r`n"
    $keysContent += "======================================`r`n"
    $keysContent += "Generated: $(Get-Date)`r`n"
    $keysContent += "`r`n"
    $keysContent += "API KEYS`r`n"
    $keysContent += "--------`r`n"
    $keysContent += "Key 1: $apiKey1`r`n"
    $keysContent += "Key 2: $apiKey2`r`n"
    $keysContent += "`r`n"
    $keysContent += "Keep these keys secure! They are required to authenticate with your node.`r`n"
    $keysContent += "`r`n"
    $keysContent += "ENDPOINTS`r`n"
    $keysContent += "---------`r`n"
    $keysContent += "API Base URL: http://localhost:$apiPort`r`n"
    $keysContent += "Health Check: http://localhost:$apiPort/health`r`n"
    $keysContent += "Peers:        http://localhost:$apiPort/peers`r`n"
    $keysContent += "Chat:         http://localhost:$apiPort/v1/chat/completions`r`n"
    $keysContent += "`r`n"
    $keysContent += "TEST COMMANDS (PowerShell)`r`n"
    $keysContent += "--------------------------`r`n"
    $keysContent += "# Check node health`r`n"
    $keysContent += "Invoke-RestMethod -Uri `"http://localhost:$apiPort/health`" -Headers @{Authorization=`"Bearer $apiKey1`"}`r`n"
    $keysContent += "`r`n"
    $keysContent += "# List connected peers`r`n"
    $keysContent += "Invoke-RestMethod -Uri `"http://localhost:$apiPort/peers`" -Headers @{Authorization=`"Bearer $apiKey1`"}`r`n"
    $keysContent += "`r`n"
    $keysContent += "CURL COMMANDS`r`n"
    $keysContent += "-------------`r`n"
    $keysContent += "# Check node health`r`n"
    $keysContent += "curl -H `"Authorization: Bearer $apiKey1`" http://localhost:$apiPort/health`r`n"
    $keysContent += "`r`n"
    $keysContent += "# List connected peers`r`n"
    $keysContent += "curl -H `"Authorization: Bearer $apiKey1`" http://localhost:$apiPort/peers`r`n"
    $keysContent += "`r`n"
    $keysContent += "OPENAI SDK CONFIGURATION`r`n"
    $keysContent += "------------------------`r`n"
    $keysContent += "Base URL: http://localhost:$apiPort/v1`r`n"
    $keysContent += "API Key:  $apiKey1`r`n"
    $keysContent += "`r`n"
    $keysContent += "DOCUMENTATION`r`n"
    $keysContent += "-------------`r`n"
    $keysContent += "https://diiisco.com/docs/api-reference`r`n"
    if ($script:RepoSource -eq "frynetworks") {
        $keysContent += "https://github.com/FrysCrypto/diiisco-node`r`n"
        $keysContent += "(Fry Networks fork - experimental)`r`n"
    } else {
        $keysContent += "https://github.com/Diiisco-Inc/diiisco-node`r`n"
    }
    
    Set-Content -Path $keysFile -Value $keysContent -Encoding UTF8
    Write-Success "API keys and reference saved to: $keysFile"
}

# ============================================================================
# NODE OPERATIONS
# ============================================================================

function Show-NodeStatus {
    param(
        [string]$ApiKey,
        [int]$Port = 4200,
        [int]$OllamaPort = 0
    )
    
    # Use script-level port if not specified
    if ($OllamaPort -eq 0) { $OllamaPort = $script:OllamaPort }
    if ($OllamaPort -eq 0) { $OllamaPort = 11434 }
    
    $baseUrl = "http://localhost:$Port"
    $headers = @{}
    if ($ApiKey) { $headers["Authorization"] = "Bearer $ApiKey" }
    
    Write-Host ""
    Write-Host "==========================================" -ForegroundColor Cyan
    Write-Host "         DIIISCO NODE STATUS" -ForegroundColor Cyan
    Write-Host "==========================================" -ForegroundColor Cyan
    Write-Host ""
    
    # Health Check
    Write-Host "[Health]" -ForegroundColor Yellow
    try {
        $null = Invoke-RestMethod -Uri "$baseUrl/health" -Headers $headers -TimeoutSec 5 -ErrorAction Stop
        Write-Host "  Status: ONLINE" -ForegroundColor Green
    } catch {
        Write-Host "  Status: OFFLINE" -ForegroundColor Red
        Write-Host "  Make sure the node is running (npm run serve)" -ForegroundColor DarkGray
        return
    }
    
    # Peers
    Write-Host ""
    Write-Host "[Peers]" -ForegroundColor Yellow
    try {
        $peersResponse = Invoke-RestMethod -Uri "$baseUrl/peers" -Headers $headers -TimeoutSec 5 -ErrorAction Stop
        
        $peers = @()
        if ($peersResponse.peers) { $peers = $peersResponse.peers } elseif ($peersResponse -is [array]) { $peers = $peersResponse }
        
        if ($peers.Count -gt 0) {
            Write-Host "  Connected: $($peers.Count) peer(s)" -ForegroundColor Green
            $i = 1
            foreach ($peer in $peers) {
                $peerId = ""
                if ($peer.peerId) { $peerId = $peer.peerId } elseif ($peer.id) { $peerId = $peer.id } else { $peerId = $peer.ToString() }
                
                if ($peerId.Length -gt 52) {
                    $peerId = $peerId.Substring(0, 24) + "..." + $peerId.Substring($peerId.Length - 24)
                }
                Write-Host "    [$i] $peerId" -ForegroundColor Gray
                $i++
            }
        } else {
            Write-Host "  Connected: 0 peers (bootstrapping...)" -ForegroundColor Yellow
        }
    } catch {
        Write-Host "  Error fetching peers" -ForegroundColor Red
    }
    
    # Models
    Write-Host ""
    Write-Host "[Models]" -ForegroundColor Yellow
    try {
        $models = Invoke-RestMethod -Uri "http://localhost:$OllamaPort/api/tags" -TimeoutSec 5 -ErrorAction Stop
        if ($models.models -and $models.models.Count -gt 0) {
            Write-Host "  Available: $($models.models.Count) model(s) (Ollama port $OllamaPort)" -ForegroundColor Green
            foreach ($model in $models.models) {
                $size = ""
                if ($model.size) { $size = " (" + [math]::Round($model.size / 1GB, 1).ToString() + " GB)" }
                Write-Host "    - $($model.name)$size" -ForegroundColor Gray
            }
        } else {
            Write-Host "  Available: 0 models" -ForegroundColor Yellow
            Write-Host "    Run: ollama pull llama3.2" -ForegroundColor DarkGray
        }
    } catch {
        Write-Host "  Ollama not running on port $OllamaPort" -ForegroundColor Red
    }
    
    Write-Host ""
    Write-Host "==========================================" -ForegroundColor Cyan
    Write-Host "Endpoint: $baseUrl" -ForegroundColor Gray
    Write-Host ""
}

function Start-DiiiscoNode {
    Write-Step "Starting Diiisco Node..."
    
    # Check for installed models before starting
    $hasModels = Test-OllamaModelsInstalled
    if (-not $hasModels) {
        Write-Err "Cannot start Diiisco Node without installed models!"
        Write-Host ""
        Write-Host "Please install at least one model and try again." -ForegroundColor Yellow
        Write-Host "Run: ollama pull llama3.2" -ForegroundColor Cyan
        Write-Host ""
        return
    }
    
    Push-Location $InstallPath
    try {
        Write-Host "`nStarting with 'npm run serve'..." -ForegroundColor Cyan
        Write-Host "Press Ctrl+C to stop the node.`n"
        
        npm run serve
    } finally {
        Pop-Location
    }
}

# ============================================================================
# INSTALLATION SUMMARY
# ============================================================================

function Show-Summary {
    # Try to read config for port/key info
    $apiPort = "4200"
    $apiKey = "<your-api-key>"
    $ollamaPort = $script:OllamaPort
    if ($ollamaPort -eq 0) { $ollamaPort = 11434 }
    
    $envFile = Join-Path $InstallPath "src\environment\environment.ts"
    if (Test-Path $envFile) {
        $content = Get-Content $envFile -Raw
        if ($content -match 'port:\s*(\d+)') { $apiPort = $Matches[1] }
        if ($content -match '"(sk-[^"]+)"') { $apiKey = $Matches[1] }
    }
    
    Write-Host "`n========================================" -ForegroundColor Green
    Write-Host "  INSTALLATION COMPLETE!" -ForegroundColor Green
    Write-Host "========================================`n" -ForegroundColor Green
    
    Write-Host "Installation Path: $InstallPath"
    Write-Host ""
    
    Write-Host "To start the node:" -ForegroundColor Yellow
    Write-Host "  cd `"$InstallPath`""
    Write-Host "  npm run serve"
    Write-Host ""
    
    Write-Host "Ollama Status:" -ForegroundColor Yellow
    if (Test-OllamaRunning -Port $ollamaPort) {
        Write-Host "  Running on port $ollamaPort" -ForegroundColor Green
        
        # Show installed models
        try {
            $models = Invoke-RestMethod -Uri "http://localhost:$ollamaPort/api/tags" -TimeoutSec 5 -ErrorAction Stop
            if ($models.models -and $models.models.Count -gt 0) {
                Write-Host "  Installed Models: $($models.models.Count)" -ForegroundColor Green
                foreach ($model in $models.models) {
                    $size = ""
                    if ($model.size) { $size = " (" + [math]::Round($model.size / 1GB, 1).ToString() + " GB)" }
                    Write-Host "    - $($model.name)$size" -ForegroundColor Gray
                }
            } else {
                Write-Host "  No models installed yet" -ForegroundColor Yellow
                Write-Host "  Pull models with: ollama pull llama3.2"
            }
        } catch {
            Write-Host "  Pull models with: ollama pull llama3.2"
        }
    } else {
        Write-Host "  NOT running - start Ollama before running the node" -ForegroundColor Red
    }
    Write-Host ""
    
    if ($ollamaPort -ne 11434) {
        Write-Host "Dedicated Ollama Instance:" -ForegroundColor Cyan
        Write-Host "  Port: $ollamaPort (avoids conflicts with your main Ollama)"
        Write-Host "  All models are shared - pull once, use anywhere"
        Write-Host ""
    }
    
    Write-Host "API Endpoint: http://localhost:$apiPort" -ForegroundColor Yellow
    Write-Host ""
    
    Write-Host "Quick Test:" -ForegroundColor Yellow
    Write-Host "  Invoke-RestMethod -Uri `"http://localhost:$apiPort/health`" -Headers @{Authorization=`"Bearer $apiKey`"}"
    Write-Host ""
    
    Write-Host "Reference File: $InstallPath\API_KEYS.txt" -ForegroundColor Yellow
    Write-Host "  Contains API keys, test commands, and SDK examples"
    Write-Host ""
    
    Write-Host "Algorand Wallet:" -ForegroundColor Yellow
    Write-Host "  Make sure your wallet has ALGO to register on the network"
    Write-Host ""
    
    Write-Host "Documentation:" -ForegroundColor Cyan
    Write-Host "  https://diiisco.com/docs/api-reference"
    if ($script:RepoSource -eq "frynetworks") {
        Write-Host "  https://github.com/FrysCrypto/diiisco-node" -ForegroundColor Gray
        Write-Host "  (Fry Networks fork - experimental features)" -ForegroundColor DarkGray
    } else {
        Write-Host "  https://github.com/Diiisco-Inc/diiisco-node"
    }
    Write-Host ""
}

# ============================================================================
# MAIN EXECUTION
# ============================================================================

Write-Host @"

  ____  _ _ _                 _   _           _      
 |  _ \(_|_|_)___  ___ ___   | \ | | ___   __| | ___ 
 | | | | | | / __|/ __/ _ \  |  \| |/ _ \ / _` |/ _ \
 | |_| | | | \__ \ (_| (_) | | |\  | (_) | (_| |  __/
 |____/|_|_|_|___/\___\___/  |_| \_|\___/ \__,_|\___|
                                                     
         Windows Installation Script v2.1

"@ -ForegroundColor Cyan

Write-Host "Install Path: $InstallPath"
Write-Host "Administrator: $(if (Test-Administrator) { 'Yes' } else { 'No' })"
Write-Host ""

# Check prerequisites
if (-not $SkipPrerequisites) {
    Install-Git
    Install-NodeJS
    
    $ollamaInstalled = Install-Ollama
    if ($ollamaInstalled) {
        # Check for existing instances and handle accordingly
        $ollamaInstance = Start-DedicatedOllamaInstance
        $script:OllamaPort = $ollamaInstance.Port
        Start-Sleep -Seconds 2
    }
    
    # Detect hardware and recommend models
    $systemSpecs = Get-SystemSpecs
    Install-RecommendedModels -Specs $systemSpecs
}

# Clone repository
Clone-Repository

# Install dependencies
Install-Dependencies

# Create environment configuration
Create-EnvironmentConfig

# Show summary
Show-Summary

# Final model check before offering to start
Write-Step "Final pre-flight check..."
$hasModels = Test-OllamaModelsInstalled

if (-not $hasModels) {
    Write-Host ""
    Write-Err "Installation incomplete - no Ollama models found!"
    Write-Host ""
    Write-Host "Your node is installed but CANNOT RUN without models." -ForegroundColor Yellow
    Write-Host "Diiisco nodes share LLM compute - without models, there's nothing to share." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "To complete setup:" -ForegroundColor Cyan
    Write-Host "  1. Install at least one model:" -ForegroundColor White
    Write-Host "     ollama pull llama3.2" -ForegroundColor Gray
    Write-Host ""
    Write-Host "  2. Then start the node:" -ForegroundColor White
    Write-Host "     cd `"$InstallPath`"" -ForegroundColor Gray
    Write-Host "     npm run serve" -ForegroundColor Gray
    Write-Host ""
    exit 1
}

# Optionally start the node
if ($AutoStart) {
    Start-DiiiscoNode
} else {
    $startNow = Read-Host "Start the node now? (y/N)"
    if ($startNow -eq 'y' -or $startNow -eq 'Y') {
        Start-DiiiscoNode
    }
}

