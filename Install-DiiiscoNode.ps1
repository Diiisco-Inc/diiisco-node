#Requires -Version 5.1
<#
.SYNOPSIS
    Installs and configures diiisco-node on Windows 10/11

.DESCRIPTION
    This script:
    - Checks for and installs prerequisites (Git, Node.js)
    - Clones the diiisco-node repository
    - Installs npm dependencies
    - Creates the environment configuration file
    - Optionally starts the node

.NOTES
    Run as Administrator for best results (allows automatic prerequisite installation)
    Requires: Internet connection, Algorand wallet (address + mnemonic), Local LLM runtime (Ollama recommended)
#>

param(
    [string]$InstallPath = "$env:USERPROFILE\diiisco-node",
    [switch]$SkipPrerequisites,
    [switch]$AutoStart
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# Colors for output
function Write-Step { param($msg) Write-Host "`n[*] $msg" -ForegroundColor Cyan }
function Write-Success { param($msg) Write-Host "[+] $msg" -ForegroundColor Green }
function Write-Warning { param($msg) Write-Host "[!] $msg" -ForegroundColor Yellow }
function Write-Err { param($msg) Write-Host "[-] $msg" -ForegroundColor Red }

function Test-Administrator {
    $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($currentUser)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Test-CommandExists {
    param($Command)
    $null -ne (Get-Command $Command -ErrorAction SilentlyContinue)
}

function Install-Winget {
    if (-not (Test-CommandExists "winget")) {
        Write-Warning "winget not found. Attempting to install..."
        
        # Try to install via Microsoft Store
        try {
            Add-AppxPackage -RegisterByFamilyName -MainPackage Microsoft.DesktopAppInstaller_8wekyb3d8bbwe -ErrorAction Stop
            Write-Success "winget installed successfully"
        }
        catch {
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
    
    Write-Warning "Git not found. Installing..."
    
    if (Test-Administrator) {
        Install-Winget
        winget install --id Git.Git -e --silent --accept-package-agreements --accept-source-agreements
        
        # Refresh PATH
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
        
        if (Test-CommandExists "git") {
            Write-Success "Git installed successfully"
        }
        else {
            Write-Err "Git installation completed but 'git' command not found."
            Write-Host "Please restart your terminal or add Git to PATH manually."
            exit 1
        }
    }
    else {
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
        
        # Check if version is at least 18
        $versionNum = [int]($nodeVersion -replace 'v(\d+)\..*', '$1')
        if ($versionNum -lt 18) {
            Write-Warning "Node.js version $nodeVersion may be too old. Version 18+ recommended."
        }
        return
    }
    
    Write-Warning "Node.js not found. Installing..."
    
    if (Test-Administrator) {
        Install-Winget
        winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements
        
        # Refresh PATH
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
        
        if (Test-CommandExists "node") {
            $nodeVersion = node --version
            Write-Success "Node.js installed successfully: $nodeVersion"
        }
        else {
            Write-Err "Node.js installation completed but 'node' command not found."
            Write-Host "Please restart your terminal and run this script again."
            exit 1
        }
    }
    else {
        Write-Err "Node.js is not installed and admin rights are required for automatic installation."
        Write-Host "Please either:"
        Write-Host "  1. Run this script as Administrator"
        Write-Host "  2. Install Node.js manually from: https://nodejs.org/"
        exit 1
    }
}

function Clone-Repository {
    Write-Step "Cloning diiisco-node repository..."
    
    if (Test-Path $InstallPath) {
        Write-Warning "Directory already exists: $InstallPath"
        $response = Read-Host "Do you want to delete and re-clone? (y/N)"
        if ($response -eq 'y' -or $response -eq 'Y') {
            Remove-Item -Recurse -Force $InstallPath
        }
        else {
            Write-Host "Using existing directory..."
            return
        }
    }
    
    git clone https://github.com/Diiisco-Inc/diiisco-node.git $InstallPath
    
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
    }
    finally {
        Pop-Location
    }
}

function Test-OllamaInstalled {
    # Check if ollama command exists
    if (Test-CommandExists "ollama") {
        return $true
    }
    
    # Check common installation paths
    $commonPaths = @(
        "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe",
        "$env:ProgramFiles\Ollama\ollama.exe",
        "${env:ProgramFiles(x86)}\Ollama\ollama.exe"
    )
    
    foreach ($path in $commonPaths) {
        if (Test-Path $path) {
            return $true
        }
    }
    
    return $false
}

function Test-OllamaRunning {
    # Check if Ollama process is running
    $ollamaProcess = Get-Process -Name "ollama*" -ErrorAction SilentlyContinue
    if ($ollamaProcess) {
        return $true
    }
    
    # Also check if port 11434 is in use (Ollama's default port)
    try {
        $connection = Test-NetConnection -ComputerName localhost -Port 11434 -WarningAction SilentlyContinue -ErrorAction SilentlyContinue
        if ($connection.TcpTestSucceeded) {
            return $true
        }
    }
    catch {
        # Test-NetConnection might not be available, try alternative
        try {
            $tcpClient = New-Object System.Net.Sockets.TcpClient
            $tcpClient.Connect("127.0.0.1", 11434)
            $tcpClient.Close()
            return $true
        }
        catch {
            return $false
        }
    }
    
    return $false
}

function Install-Ollama {
    Write-Step "Checking for Ollama..."
    
    if (Test-OllamaInstalled) {
        $ollamaVersion = & ollama --version 2>$null
        Write-Success "Ollama is already installed: $ollamaVersion"
        return $true
    }
    
    Write-Warning "Ollama not found. Installing..."
    
    if (Test-Administrator) {
        Install-Winget
        
        Write-Host "Installing Ollama via winget..." -ForegroundColor Cyan
        winget install --id Ollama.Ollama -e --silent --accept-package-agreements --accept-source-agreements
        
        if ($LASTEXITCODE -ne 0) {
            Write-Err "winget installation failed. Trying direct download..."
            
            # Fallback to direct download
            $ollamaInstaller = "$env:TEMP\OllamaSetup.exe"
            Write-Host "Downloading Ollama installer..."
            
            try {
                Invoke-WebRequest -Uri "https://ollama.com/download/OllamaSetup.exe" -OutFile $ollamaInstaller -UseBasicParsing
                
                Write-Host "Running Ollama installer (silent)..."
                Start-Process -FilePath $ollamaInstaller -ArgumentList "/S" -Wait -NoNewWindow
                
                Remove-Item $ollamaInstaller -Force -ErrorAction SilentlyContinue
            }
            catch {
                Write-Err "Failed to download/install Ollama: $_"
                Write-Host "Please install Ollama manually from: https://ollama.com/download"
                return $false
            }
        }
        
        # Refresh PATH
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
        
        # Wait a moment for installation to complete
        Start-Sleep -Seconds 2
        
        if (Test-OllamaInstalled) {
            Write-Success "Ollama installed successfully"
            return $true
        }
        else {
            Write-Warning "Ollama installed but command not found in PATH."
            Write-Host "You may need to restart your terminal or log out and back in."
            return $true  # Installation likely succeeded
        }
    }
    else {
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
    
    # On Windows, Ollama typically runs as a background app
    # Try to start it via the ollama app or command
    
    # Method 1: Try starting via ollama app (background process)
    $ollamaExePaths = @(
        "$env:LOCALAPPDATA\Programs\Ollama\ollama app.exe",
        "$env:LOCALAPPDATA\Programs\Ollama\Ollama.exe",
        "$env:ProgramFiles\Ollama\ollama app.exe"
    )
    
    foreach ($exePath in $ollamaExePaths) {
        if (Test-Path $exePath) {
            Write-Host "Starting Ollama from: $exePath"
            Start-Process -FilePath $exePath -WindowStyle Hidden
            
            # Wait for it to start
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
    
    # Method 2: Try 'ollama serve' in background
    if (Test-CommandExists "ollama") {
        Write-Host "Starting Ollama via 'ollama serve'..."
        
        # Start ollama serve as a background job
        $job = Start-Job -ScriptBlock { ollama serve 2>&1 }
        
        # Wait for it to start
        $maxWait = 10
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
        else {
            # Check if job had an error (like port already in use)
            $jobOutput = Receive-Job -Job $job -ErrorAction SilentlyContinue
            if ($jobOutput -match "bind:|address already in use") {
                Write-Success "Ollama appears to already be running on another process"
                return $true
            }
        }
    }
    
    Write-Warning "Could not start Ollama automatically."
    Write-Host "Please start Ollama manually by:"
    Write-Host "  - Opening the Ollama app from your Start menu, OR"
    Write-Host "  - Running 'ollama serve' in a separate terminal"
    
    return $false
}

function Detect-OllamaRuntime {
    Write-Step "Auto-detecting Ollama runtime..."
    
    # Check OLLAMA_HOST environment variable first
    $ollamaHostEnv = $env:OLLAMA_HOST
    if ($ollamaHostEnv) {
        Write-Host "Found OLLAMA_HOST environment variable: $ollamaHostEnv"
        
        # Parse the environment variable (could be host:port or just host)
        if ($ollamaHostEnv -match '^(https?://)?([^:]+):?(\d+)?$') {
            $scheme = if ($Matches[1]) { $Matches[1].TrimEnd('://') } else { "http" }
            $detectedHost = $Matches[2]
            $port = if ($Matches[3]) { [int]$Matches[3] } else { 11434 }
            $baseURL = "${scheme}://${detectedHost}"
        }
        else {
            $baseURL = "http://localhost"
            $port = 11434
        }
    }
    else {
        $baseURL = "http://localhost"
        $port = 11434
    }
    
    # Common ports to check
    $portsToCheck = @($port, 11434, 8080, 3000, 5000) | Select-Object -Unique
    
    # Hosts to check
    $hostsToCheck = @($baseURL, "http://localhost", "http://127.0.0.1") | Select-Object -Unique
    
    $detectedEndpoints = @()
    
    foreach ($hostURL in $hostsToCheck) {
        foreach ($testPort in $portsToCheck) {
            $testURL = "${hostURL}:${testPort}"
            
            try {
                # Test Ollama API endpoint
                $response = Invoke-RestMethod -Uri "${testURL}/api/tags" -Method GET -TimeoutSec 3 -ErrorAction Stop
                
                # If we get here, Ollama is responding
                $modelCount = if ($response.models) { $response.models.Count } else { 0 }
                $modelNames = if ($response.models) { ($response.models | ForEach-Object { $_.name }) -join ", " } else { "none" }
                
                $detectedEndpoints += @{
                    Host = $hostURL
                    Port = $testPort
                    URL = $testURL
                    Models = $modelCount
                    ModelNames = $modelNames
                }
                
                Write-Success "Found Ollama at ${testURL} ($modelCount models: $modelNames)"
            }
            catch {
                # Try alternative health check endpoint
                try {
                    $null = Invoke-WebRequest -Uri "${testURL}/api/version" -Method GET -TimeoutSec 2 -ErrorAction Stop
                    $detectedEndpoints += @{
                        Host = $hostURL
                        Port = $testPort
                        URL = $testURL
                        Models = 0
                        ModelNames = "unknown"
                    }
                    Write-Success "Found Ollama at ${testURL} (version endpoint responded)"
                }
                catch {
                    # Silently continue - endpoint not available
                }
            }
        }
    }
    
    if ($detectedEndpoints.Count -eq 0) {
        Write-Warning "Could not auto-detect Ollama runtime!"
        Write-Host "Make sure Ollama is running."
        return $null
    }
    
    # Return the first (best) detected endpoint
    return $detectedEndpoints[0]
}

function Create-EnvironmentConfig {
    Write-Step "Creating environment configuration..."
    
    $envDir = Join-Path $InstallPath "src\environment"
    $envFile = Join-Path $envDir "environment.ts"
    $exampleFile = Join-Path $envDir "example.environment.ts"
    
    if (Test-Path $envFile) {
        Write-Warning "environment.ts already exists"
        $response = Read-Host "Do you want to reconfigure? (y/N)"
        if ($response -ne 'y' -and $response -ne 'Y') {
            return
        }
    }
    
    Write-Host "`n========================================" -ForegroundColor Magenta
    Write-Host "  DIIISCO NODE CONFIGURATION" -ForegroundColor Magenta
    Write-Host "========================================`n" -ForegroundColor Magenta
    
    # LLM Configuration - Auto-detect first
    Write-Host "--- Local LLM Settings ---" -ForegroundColor Yellow
    
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
            
            $llmPort = Read-Host "LLM Port [11434]"
            if ([string]::IsNullOrWhiteSpace($llmPort)) { $llmPort = "11434" }
        }
        else {
            $llmBaseURL = $ollamaDetected.Host
            $llmPort = $ollamaDetected.Port
        }
    }
    else {
        Write-Host "`nNo Ollama runtime detected. Please enter manually:" -ForegroundColor Yellow
        
        $llmBaseURL = Read-Host "LLM Base URL [http://localhost]"
        if ([string]::IsNullOrWhiteSpace($llmBaseURL)) { $llmBaseURL = "http://localhost" }
        
        $llmPort = Read-Host "LLM Port [11434]"
        if ([string]::IsNullOrWhiteSpace($llmPort)) { $llmPort = "11434" }
    }
    
    $llmApiKey = Read-Host "`nLLM API Key (leave blank if not needed - Ollama doesn't require one)"
    if ([string]::IsNullOrWhiteSpace($llmApiKey)) { $llmApiKey = "" }
    
    $chargePer1K = Read-Host "Charge per 1K tokens (default) [0.000001]"
    if ([string]::IsNullOrWhiteSpace($chargePer1K)) { $chargePer1K = "0.000001" }
    
    # Algorand Configuration
    Write-Host "`n--- Algorand Wallet Settings ---" -ForegroundColor Yellow
    Write-Host "You need an Algorand wallet to receive payments."
    Write-Host "Get one at: https://perawallet.app/`n"
    
    $algoAddr = Read-Host "Algorand Wallet Address"
    while ([string]::IsNullOrWhiteSpace($algoAddr)) {
        Write-Warning "Algorand address is required!"
        $algoAddr = Read-Host "Algorand Wallet Address"
    }
    
    Write-Host "`n[!] Your mnemonic (25 words) will be stored in the config file." -ForegroundColor Red
    Write-Host "[!] Keep this file secure and never share it!`n" -ForegroundColor Red
    
    $validMnemonic = $false
    while (-not $validMnemonic) {
        $algoMnemonic = Read-Host "Algorand Mnemonic (25 words, space-separated)"
        
        if ([string]::IsNullOrWhiteSpace($algoMnemonic)) {
            Write-Warning "Algorand mnemonic is required!"
            continue
        }
        
        # Clean up the mnemonic - normalize whitespace
        $algoMnemonic = ($algoMnemonic.Trim() -replace '\s+', ' ')
        
        # Count words
        $wordCount = ($algoMnemonic -split ' ').Count
        
        if ($wordCount -ne 25) {
            Write-Warning "Invalid mnemonic! Expected 25 words, got $wordCount words."
            Write-Host "Please enter all 25 words separated by single spaces."
            continue
        }
        
        # Basic validation - check all words are lowercase letters only
        $words = $algoMnemonic -split ' '
        $invalidWords = $words | Where-Object { $_ -notmatch '^[a-z]+$' }
        
        if ($invalidWords.Count -gt 0) {
            Write-Warning "Invalid words detected: $($invalidWords -join ', ')"
            Write-Host "Mnemonic words should be lowercase letters only (no numbers or special characters)."
            
            # Auto-fix: convert to lowercase
            $algoMnemonic = $algoMnemonic.ToLower()
            $words = $algoMnemonic -split ' '
            $invalidWords = $words | Where-Object { $_ -notmatch '^[a-z]+$' }
            
            if ($invalidWords.Count -eq 0) {
                Write-Host "Auto-corrected to lowercase. Proceeding..." -ForegroundColor Green
                $validMnemonic = $true
            }
            else {
                continue
            }
        }
        else {
            $validMnemonic = $true
        }
    }
    
    Write-Success "Mnemonic accepted (25 words)"
    
    $algoNetwork = Read-Host "Algorand Network [mainnet/testnet] (mainnet)"
    if ($algoNetwork -eq "testnet") {
        $algoNodeURL = "https://testnet-api.algonode.cloud/"
    }
    else {
        $algoNodeURL = "https://mainnet-api.algonode.cloud/"
    }
    
    # API Configuration
    Write-Host "`n--- API Settings ---" -ForegroundColor Yellow
    
    $apiPort = Read-Host "API Port [8181]"
    if ([string]::IsNullOrWhiteSpace($apiPort)) { $apiPort = "8181" }
    
    $enableAuth = Read-Host "Enable Bearer Authentication? (Y/n)"
    $bearerAuth = if ($enableAuth -eq 'n' -or $enableAuth -eq 'N') { "false" } else { "true" }
    
    # Generate random API keys
    $apiKey1 = "sk-" + (-join ((65..90) + (97..122) + (48..57) | Get-Random -Count 32 | ForEach-Object { [char]$_ }))
    $apiKey2 = "sk-" + (-join ((65..90) + (97..122) + (48..57) | Get-Random -Count 32 | ForEach-Object { [char]$_ }))
    
    Write-Host "`nGenerated API Keys:" -ForegroundColor Green
    Write-Host "  Key 1: $apiKey1"
    Write-Host "  Key 2: $apiKey2"
    
    # Node configuration
    Write-Host "`n--- Node Settings ---" -ForegroundColor Yellow
    
    $nodePort = Read-Host "Node P2P Port [4242]"
    if ([string]::IsNullOrWhiteSpace($nodePort)) { $nodePort = "4242" }
    
    # PeerId storage path - use a folder in the install directory
    $peerIdPath = Join-Path $InstallPath "peerid"
    $peerIdPath = $peerIdPath -replace '\\', '/'
    
    # Create the environment file
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
    network: "$( if ($algoNetwork -eq 'testnet') { 'testnet' } else { 'mainnet' } )",
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
    
    # Create peerid storage directory
    $peerIdDir = Join-Path $InstallPath "peerid"
    if (-not (Test-Path $peerIdDir)) {
        New-Item -ItemType Directory -Path $peerIdDir -Force | Out-Null
        Write-Host "Created PeerId storage directory: $peerIdDir"
    }
    
    # Ensure directory exists
    if (-not (Test-Path $envDir)) {
        New-Item -ItemType Directory -Path $envDir -Force | Out-Null
    }
    
    Set-Content -Path $envFile -Value $envContent -Encoding UTF8
    
    Write-Success "Environment configuration saved to: $envFile"
    
    # Save API keys to a separate reference file
    $keysFile = Join-Path $InstallPath "API_KEYS.txt"
    @"
DIIISCO NODE API KEYS
=====================
Generated: $(Get-Date)

API Key 1: $apiKey1
API Key 2: $apiKey2

Keep these keys secure! They are required to authenticate with your node.
"@ | Set-Content -Path $keysFile -Encoding UTF8
    
    Write-Success "API keys also saved to: $keysFile"
}

function Start-DiiiscoNode {
    Write-Step "Starting Diiisco Node..."
    
    Push-Location $InstallPath
    try {
        Write-Host "`nStarting with 'npm run serve'..." -ForegroundColor Cyan
        Write-Host "Press Ctrl+C to stop the node.`n"
        
        npm run serve
    }
    finally {
        Pop-Location
    }
}

function Show-Summary {
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
    if (Test-OllamaRunning) {
        Write-Host "  Ollama is running" -ForegroundColor Green
        Write-Host "  Pull models with: ollama pull llama3.2"
    }
    else {
        Write-Host "  Ollama is NOT running - start it before running the node" -ForegroundColor Red
        Write-Host "  Open the Ollama app from your Start menu"
    }
    Write-Host ""
    Write-Host "API Endpoint (when running):" -ForegroundColor Yellow
    Write-Host "  http://localhost:8181"
    Write-Host ""
    Write-Host "Configuration file:" -ForegroundColor Yellow
    Write-Host "  $InstallPath\src\environment\environment.ts"
    Write-Host ""
    Write-Host "For more info, visit:" -ForegroundColor Cyan
    Write-Host "  https://github.com/Diiisco-Inc/diiisco-node"
    Write-Host ""
}

# Main execution
Write-Host @"

  ____  _ _ _                 _   _           _      
 |  _ \(_|_|_)___  ___ ___   | \ | | ___   __| | ___ 
 | | | | | | / __|/ __/ _ \  |  \| |/ _ \ / _` |/ _ \
 | |_| | | | \__ \ (_| (_) | | |\  | (_) | (_| |  __/
 |____/|_|_|_|___/\___\___/  |_| \_|\___/ \__,_|\___|
                                                     
         Windows Installation Script v1.0

"@ -ForegroundColor Cyan

Write-Host "Install Path: $InstallPath"
Write-Host "Administrator: $(if (Test-Administrator) { 'Yes' } else { 'No' })"
Write-Host ""

# Check prerequisites
if (-not $SkipPrerequisites) {
    Install-Git
    Install-NodeJS
    
    # Install and start Ollama
    $ollamaInstalled = Install-Ollama
    if ($ollamaInstalled) {
        Start-OllamaService
        # Give Ollama a moment to fully initialize
        Start-Sleep -Seconds 2
    }
}

# Clone repository
Clone-Repository

# Install dependencies
Install-Dependencies

# Create environment configuration
Create-EnvironmentConfig

# Show summary
Show-Summary

# Optionally start the node
if ($AutoStart) {
    Start-DiiiscoNode
}
else {
    $startNow = Read-Host "Start the node now? (y/N)"
    if ($startNow -eq 'y' -or $startNow -eq 'Y') {
        Start-DiiiscoNode
    }
}
