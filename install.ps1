<#
.SYNOPSIS
    DIIISCO CLI + DIIISCO Desktop installer for Windows (spec §7.1, Windows arm of install.sh).

.DESCRIPTION
    irm https://diiis.co/install.ps1 | iex

    Downloads the release artifact for this machine, verifies its SHA-256
    against the published SHA256SUMS, and installs it to
    %LOCALAPPDATA%\DIIISCO\bin — a directory this user owns, so no
    Administrator rights are needed. Unlike Unix there is no conventional
    already-on-PATH user bin directory on Windows, so the installer adds it to
    your *user* PATH in the registry (pass -NoModifyPath to skip). Use -System
    to install to %ProgramFiles%\DIIISCO\bin and the machine PATH instead;
    that needs an elevated terminal.

    DIIISCO Desktop is installed too, by default, by running the published
    DIIISCO-setup.exe silently. That installer places the app in
    %LOCALAPPDATA%\Programs\DIIISCO and puts its own bundled copy of the CLI
    (resources\bin) on your user PATH — which is why this script warns when
    the two are about to shadow each other. Pass -NoDesktop for CLI only.

    Published layout this reads (see diiisco-publish/scripts/collect.ts):

      <BaseUrl>/latest.json                                {"tag": "v1.2.3"}
      <BaseUrl>/releases/<tag>/diiisco-windows-x64.exe
      <BaseUrl>/releases/<tag>/SHA256SUMS
      <DesktopBaseUrl>/DIIISCO-setup.exe                   flat, always-latest
      <DesktopBaseUrl>/releases/<tag>/DIIISCO-setup.exe    archival, per-tag

    Like install.sh, this never elevates on your behalf: if a destination
    needs Administrator it tells you what to run rather than running it.

.PARAMETER Version
    Release tag to install, e.g. v1.0.7 (default: latest). Env: DIIISCO_VERSION

.PARAMETER InstallDir
    Where to put diiisco.exe. Env: DIIISCO_INSTALL_DIR

.PARAMETER System
    Install for all users into %ProgramFiles%\DIIISCO\bin and the machine
    PATH. Requires an elevated terminal. Env: DIIISCO_SYSTEM=1

.PARAMETER NoDesktop
    Skip DIIISCO Desktop, install just the CLI. Env: DIIISCO_NO_DESKTOP=1

.PARAMETER NoModifyPath
    Do not touch PATH; print the directory to add yourself.
    Env: DIIISCO_NO_MODIFY_PATH=1

.PARAMETER NoVerify
    Skip checksum verification (unsupported). Env: DIIISCO_NO_VERIFY=1

.PARAMETER DesktopInteractive
    Show DIIISCO Desktop's installer wizard instead of installing silently.
    Env: DIIISCO_DESKTOP_INTERACTIVE=1

.PARAMETER BaseUrl
    Override the CLI release host. Env: DIIISCO_BASE_URL
    (default: https://diiis.co/cli)

.PARAMETER DesktopBaseUrl
    Override the desktop release host. Env: DIIISCO_DESKTOP_BASE_URL
    (default: https://diiis.co/desktop)

.EXAMPLE
    irm https://diiis.co/install.ps1 | iex

.EXAMPLE
    # `iex` cannot forward arguments, so build a script block to pass flags:
    & ([scriptblock]::Create((irm https://diiis.co/install.ps1))) -NoDesktop

.EXAMPLE
    # ...or set the equivalent environment variable first:
    $env:DIIISCO_NO_DESKTOP = '1'; irm https://diiis.co/install.ps1 | iex

.EXAMPLE
    # From a downloaded copy (a .ps1 off the internet is blocked by default):
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -Version v1.0.7
#>
[CmdletBinding()]
param(
    [string] $Version,
    [string] $InstallDir,
    [switch] $System,
    [switch] $NoDesktop,
    [switch] $NoModifyPath,
    [switch] $NoVerify,
    [switch] $DesktopInteractive,
    [string] $BaseUrl,
    [string] $DesktopBaseUrl,
    [Alias('h')]
    [switch] $Help
)

$ErrorActionPreference = 'Stop'
# Invoke-WebRequest's progress bar makes downloads several times slower on
# Windows PowerShell 5.1, and it is noise in a one-liner installer anyway.
$ProgressPreference = 'SilentlyContinue'

# Windows PowerShell 5.1 still defaults to TLS 1.0/1.1 on some builds, which
# every modern host rejects. PowerShell 7 ignores this (it uses the OS default).
try {
    [Net.ServicePointManager]::SecurityProtocol =
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {
    # Older .NET without a Tls12 enum member — nothing useful to do about it.
}

# ---------------------------------------------------------------------------
# Environment-variable fallbacks (each flag is also settable as an env var, so
# `irm | iex` — which cannot forward arguments — can still be configured)
# ---------------------------------------------------------------------------

if (-not $Version        -and $env:DIIISCO_VERSION)          { $Version        = $env:DIIISCO_VERSION }
if (-not $InstallDir     -and $env:DIIISCO_INSTALL_DIR)      { $InstallDir     = $env:DIIISCO_INSTALL_DIR }
if (-not $BaseUrl        -and $env:DIIISCO_BASE_URL)         { $BaseUrl        = $env:DIIISCO_BASE_URL }
if (-not $DesktopBaseUrl -and $env:DIIISCO_DESKTOP_BASE_URL) { $DesktopBaseUrl = $env:DIIISCO_DESKTOP_BASE_URL }

if (-not $System             -and $env:DIIISCO_SYSTEM -eq '1')              { $System             = $true }
if (-not $NoDesktop          -and $env:DIIISCO_NO_DESKTOP -eq '1')          { $NoDesktop          = $true }
if (-not $NoModifyPath       -and $env:DIIISCO_NO_MODIFY_PATH -eq '1')      { $NoModifyPath       = $true }
if (-not $NoVerify           -and $env:DIIISCO_NO_VERIFY -eq '1')           { $NoVerify           = $true }
if (-not $DesktopInteractive -and $env:DIIISCO_DESKTOP_INTERACTIVE -eq '1') { $DesktopInteractive = $true }

if (-not $BaseUrl)        { $BaseUrl        = 'https://diiis.co/cli' }
if (-not $DesktopBaseUrl) { $DesktopBaseUrl = 'https://diiis.co/desktop' }

$BaseUrl        = $BaseUrl.TrimEnd('/')
$DesktopBaseUrl = $DesktopBaseUrl.TrimEnd('/')

# Whether the caller pinned a version, as opposed to us resolving "latest".
# The desktop artifact has two homes and this decides which one we use.
$script:VersionPinned = [bool]$Version

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

$script:Color = -not $env:NO_COLOR

function Write-Plain {
    param([string] $Message = '')
    Write-Host $Message
}

function Write-Info {
    param([string] $Message)
    if ($script:Color) { Write-Host $Message -ForegroundColor DarkGray } else { Write-Host $Message }
}

function Write-Ok {
    param([string] $Message)
    if ($script:Color) {
        Write-Host '  OK ' -ForegroundColor Green -NoNewline
        Write-Host $Message
    } else {
        Write-Host "  OK $Message"
    }
}

function Write-Warn {
    param([string] $Message)
    if ($script:Color) {
        Write-Host '  !  ' -ForegroundColor Yellow -NoNewline
        Write-Host $Message
    } else {
        Write-Host "  !  $Message"
    }
}

# Failures are thrown, not `exit`ed: piped through `irm | iex` an `exit` would
# close the caller's whole PowerShell session and take the error message with
# it. The top-level catch prints, and only a real script file exits nonzero.
function Stop-Install {
    param([string] $Message, [string[]] $Hints = @())
    $script:Deliberate = $true
    $lines = @($Message) + @($Hints | ForEach-Object { "  $_" })
    throw ([string]::Join([Environment]::NewLine, $lines))
}

function Show-Usage {
    Write-Plain @'
DIIISCO CLI + DIIISCO Desktop installer for Windows.

  irm https://diiis.co/install.ps1 | iex

Installs diiisco.exe to %LOCALAPPDATA%\DIIISCO\bin, adds it to your user PATH,
and installs DIIISCO Desktop. No Administrator rights required.

Options (each also settable as an environment variable):

  -Version VERSION        DIIISCO_VERSION              release tag (default: latest)
  -InstallDir DIR         DIIISCO_INSTALL_DIR          where to put diiisco.exe
  -System                 DIIISCO_SYSTEM=1             all users: %ProgramFiles%\DIIISCO\bin (needs elevation)
  -NoDesktop              DIIISCO_NO_DESKTOP=1         skip DIIISCO Desktop, install just the CLI
  -NoModifyPath           DIIISCO_NO_MODIFY_PATH=1     do not touch PATH
  -NoVerify               DIIISCO_NO_VERIFY=1          skip checksum verification (unsupported)
  -DesktopInteractive     DIIISCO_DESKTOP_INTERACTIVE=1  show the desktop installer wizard
  -BaseUrl URL            DIIISCO_BASE_URL             CLI release host (default: https://diiis.co/cli)
  -DesktopBaseUrl URL     DIIISCO_DESKTOP_BASE_URL     desktop release host (default: https://diiis.co/desktop)
  -Help                   this message

`iex` cannot forward arguments. To pass flags, create a script block:

  & ([scriptblock]::Create((irm https://diiis.co/install.ps1))) -NoDesktop -NoModifyPath

or set the environment variable equivalents before piping.
'@
}

# ---------------------------------------------------------------------------
# Download helpers
# ---------------------------------------------------------------------------

function Get-RemoteFile {
    param([string] $Url, [string] $Destination)
    try {
        Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing
    } catch {
        return $false
    }
    return (Test-Path -LiteralPath $Destination)
}

# diiis.co redirects anything it cannot find to diiisco.com rather than 404ing
# (deliberate, for browser-facing URLs), and Invoke-WebRequest follows that
# into a perfectly successful HTML response. So a "downloaded" file is not
# evidence the artifact exists — check it actually starts with the PE/MZ magic
# before we install or execute it.
function Assert-WindowsExecutable {
    param([string] $Path, [string] $Url)

    $first = @(0, 0)
    $stream = [IO.File]::OpenRead($Path)
    try {
        $first[0] = $stream.ReadByte()
        $first[1] = $stream.ReadByte()
    } finally {
        $stream.Dispose()
    }

    if ($first[0] -ne 0x4D -or $first[1] -ne 0x5A) {
        Stop-Install "What came back from $Url is not a Windows executable." @(
            'The release host serves a redirect for paths it does not have, so this',
            'usually means no build exists at that URL. Check the version tag.'
        )
    }
}

function Get-Sha256 {
    param([string] $Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

# ---------------------------------------------------------------------------
# PATH (registry)
# ---------------------------------------------------------------------------

$script:MachineEnvKey = 'SYSTEM\CurrentControlSet\Control\Session Manager\Environment'

function Open-EnvKey {
    param([ValidateSet('User', 'Machine')][string] $Scope, [bool] $Writable)
    $hive = if ($Scope -eq 'User') {
        [Microsoft.Win32.Registry]::CurrentUser
    } else {
        [Microsoft.Win32.Registry]::LocalMachine
    }
    if (-not $hive) { throw "The $Scope registry hive is not available on this system." }
    $subKey = if ($Scope -eq 'User') { 'Environment' } else { $script:MachineEnvKey }
    return $hive.OpenSubKey($subKey, $Writable)
}

# Read the *raw* stored value: [Environment]::GetEnvironmentVariable expands
# %VAR% references, and writing an expanded value back would permanently bake
# in whatever those happened to point at today.
function Get-StoredPath {
    param([ValidateSet('User', 'Machine')][string] $Scope)

    $key = Open-EnvKey -Scope $Scope -Writable $false
    if (-not $key) {
        return [pscustomobject]@{ Value = ''; Kind = [Microsoft.Win32.RegistryValueKind]::ExpandString }
    }
    try {
        $value = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        $kind = try { $key.GetValueKind('Path') } catch { [Microsoft.Win32.RegistryValueKind]::ExpandString }
        return [pscustomobject]@{ Value = [string] $value; Kind = $kind }
    } finally {
        $key.Close()
    }
}

function Set-StoredPath {
    param([ValidateSet('User', 'Machine')][string] $Scope, [string] $Value, $Kind)

    $key = Open-EnvKey -Scope $Scope -Writable $true
    if (-not $key) { throw "Could not open the $Scope environment registry key for writing." }
    try {
        $key.SetValue('Path', $Value, $Kind)
    } finally {
        $key.Close()
    }
}

# [Environment]::SetEnvironmentVariable broadcasts this for you, but it also
# rewrites REG_EXPAND_SZ to REG_SZ; we write the registry directly to preserve
# the value kind, so the broadcast is ours to send. Without it, already-open
# Explorer/terminal processes never learn about the new PATH.
function Publish-EnvironmentChange {
    try {
        if (-not ('Diiisco.NativeMethods' -as [type])) {
            Add-Type -Namespace Diiisco -Name NativeMethods -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
        }
        $result = [UIntPtr]::Zero
        # HWND_BROADCAST, WM_SETTINGCHANGE, SMTO_ABORTIFHUNG, 5s timeout.
        [void][Diiisco.NativeMethods]::SendMessageTimeout(
            [IntPtr] 0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 0x0002, 5000, [ref] $result)
    } catch {
        # Cosmetic only — a new terminal picks the change up regardless.
    }
}

function Test-PathContains {
    param([string] $StoredPath, [string] $Directory)
    $needle = $Directory.TrimEnd('\')
    foreach ($entry in $StoredPath -split ';') {
        $candidate = $entry.Trim().Trim('"').TrimEnd('\')
        if (-not $candidate) { continue }
        # Compare expanded, so an existing %LOCALAPPDATA%\DIIISCO\bin entry is
        # recognised as the same directory we are about to add literally.
        $expanded = try { [Environment]::ExpandEnvironmentVariables($candidate).TrimEnd('\') } catch { $candidate }
        if ($expanded -ieq $needle -or $candidate -ieq $needle) { return $true }
    }
    return $false
}

function Test-Elevated {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    return ([Security.Principal.WindowsPrincipal] $identity).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

function Invoke-DiiiscoInstall {

    # -- Prerequisites ------------------------------------------------------

    if ($PSVersionTable.PSVersion.Major -lt 5) {
        Stop-Install "This installer needs PowerShell 5.1 or newer (found $($PSVersionTable.PSVersion))." @(
            'Windows 10 and 11 ship 5.1 as "Windows PowerShell".'
        )
    }

    if (-not $IsWindowsPlatform) {
        Stop-Install 'This installer is for Windows.' @(
            'On macOS and Linux use: curl -fsSL https://diiis.co/install.sh | sudo sh'
        )
    }

    # -- Target -------------------------------------------------------------

    # Only windows-x64 is published (see manifest.json). Windows 11 on ARM runs
    # x64 binaries under emulation, which is a supported-but-worth-saying path;
    # a 32-bit OS cannot run them at all.
    $processorArch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    $emulated = $false
    switch ($processorArch) {
        'AMD64' { }
        'ARM64' { $emulated = $true }
        default {
            Stop-Install "Unsupported processor architecture `"$processorArch`"." @(
                'DIIISCO ships a 64-bit build only. A 32-bit Windows cannot run it.',
                "Releases: $BaseUrl"
            )
        }
    }

    $artifact = 'diiisco-windows-x64.exe'

    # -- Version ------------------------------------------------------------

    if ($Version) {
        $tag = if ($Version.StartsWith('v')) { $Version } else { "v$Version" }
    } else {
        try {
            $latest = Invoke-RestMethod -Uri "$BaseUrl/latest.json" -UseBasicParsing
            $tag = $latest.tag
        } catch {
            $tag = $null
        }
        if (-not $tag) {
            Stop-Install 'Could not work out the latest DIIISCO release.' @(
                'Check your network, or pin a version:',
                '  $env:DIIISCO_VERSION = "v1.0.7"; irm https://diiis.co/install.ps1 | iex',
                "Releases: $BaseUrl"
            )
        }
    }

    # -- Install directory --------------------------------------------------

    $pathScope = if ($System) { 'Machine' } else { 'User' }

    if ($System -and -not (Test-Elevated)) {
        Stop-Install '-System installs for all users and needs Administrator rights.' @(
            'This script never elevates on your behalf. Open an elevated PowerShell',
            '("Run as administrator") and run it again, or drop -System to install',
            'just for you into %LOCALAPPDATA%\DIIISCO\bin — no elevation needed.'
        )
    }

    if (-not $InstallDir) {
        $InstallDir = if ($System) {
            Join-Path $env:ProgramFiles 'DIIISCO\bin'
        } else {
            Join-Path $env:LOCALAPPDATA 'DIIISCO\bin'
        }
    }

    # A value that arrived through an environment variable was never expanded
    # by a shell, so %VAR% and ~ are still literal here.
    $InstallDir = [Environment]::ExpandEnvironmentVariables($InstallDir)
    if ($InstallDir -eq '~') { $InstallDir = $HOME }
    elseif ($InstallDir.StartsWith('~\') -or $InstallDir.StartsWith('~/')) {
        $InstallDir = Join-Path $HOME $InstallDir.Substring(2)
    }
    $InstallDir = $InstallDir.TrimEnd('\')

    try {
        $null = New-Item -ItemType Directory -Path $InstallDir -Force
    } catch {
        Stop-Install "Cannot create $InstallDir." @(
            'Pick a directory you own: -InstallDir C:\Users\you\bin',
            'or, for an all-users install, run this from an elevated PowerShell with -System.'
        )
    }

    $destination = Join-Path $InstallDir 'diiisco.exe'

    # -- Shadowing check (spec §9.4) ---------------------------------------

    $existing = Get-Command -Name diiisco -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($existing -and ($existing.Source -ine $destination)) {
        $existingVersion = try { (& $existing.Source version 2>$null) -join ' ' } catch { '' }
        if (-not $existingVersion) { $existingVersion = 'unknown version' }
        Write-Plain
        if ($existingVersion -like '*desktop-bundled*') {
            Write-Warn 'DIIISCO Desktop already provides a diiisco on your PATH:'
            Write-Warn "  $($existing.Source)  ($existingVersion)"
            Write-Warn "Installing to $InstallDir may shadow it, depending on PATH order."
            Write-Warn 'That copy is updated by the desktop app; this one by re-running install.ps1.'
        } else {
            Write-Warn 'Another diiisco is already on your PATH:'
            Write-Warn "  $($existing.Source)  ($existingVersion)"
            Write-Warn "Installing to $InstallDir may shadow it, depending on PATH order."
        }
    }

    # -- Download + verify --------------------------------------------------

    $downloadBase = "$BaseUrl/releases/$tag"
    $staging = Join-Path ([IO.Path]::GetTempPath()) ("diiisco-install-" + [Guid]::NewGuid().ToString('n'))
    $null = New-Item -ItemType Directory -Path $staging -Force
    $script:Staging = $staging

    Write-Plain
    Write-Plain 'Installing DIIISCO CLI'
    Write-Info  "  version  $tag"
    Write-Info  "  target   windows-x64$(if ($emulated) { ' (running under x64 emulation on ARM64)' })"
    Write-Info  "  into     $InstallDir"
    Write-Plain

    $downloaded = Join-Path $staging $artifact
    Write-Info "Downloading $artifact..."
    if (-not (Get-RemoteFile -Url "$downloadBase/$artifact" -Destination $downloaded)) {
        Stop-Install "Could not download $downloadBase/$artifact." @(
            'Check the version tag and your network connection.',
            "Releases: $BaseUrl"
        )
    }
    Assert-WindowsExecutable -Path $downloaded -Url "$downloadBase/$artifact"

    if ($NoVerify) {
        Write-Warn 'Skipping checksum verification (-NoVerify). This is unsupported.'
    } else {
        Write-Info 'Verifying checksum...'
        $sumsFile = Join-Path $staging 'SHA256SUMS'
        if (-not (Get-RemoteFile -Url "$downloadBase/SHA256SUMS" -Destination $sumsFile)) {
            Stop-Install "Could not download $downloadBase/SHA256SUMS." @(
                'Refusing to install an unverified binary.'
            )
        }

        $pattern = '^([0-9a-fA-F]{64})\s+\*?' + [regex]::Escape($artifact) + '$'
        $expected = $null
        foreach ($line in (Get-Content -LiteralPath $sumsFile)) {
            if ($line -match $pattern) { $expected = $Matches[1].ToLowerInvariant(); break }
        }
        if (-not $expected) {
            Stop-Install "SHA256SUMS has no entry for $artifact." @('Refusing to install an unverified binary.')
        }

        $actual = Get-Sha256 -Path $downloaded
        if ($expected -ne $actual) {
            Stop-Install "Checksum mismatch for $artifact - the download is corrupt or has been tampered with." @(
                "expected $expected",
                "got      $actual"
            )
        }
        Write-Ok 'Checksum verified.'
    }

    # -- Install ------------------------------------------------------------

    # Windows locks a running .exe against deletion, but not against rename —
    # so a node started from this binary does not block an upgrade. The
    # displaced copy is cleaned up by the next run, once nothing holds it.
    Get-ChildItem -LiteralPath $InstallDir -Filter 'diiisco.exe.old-*' -ErrorAction SilentlyContinue |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }

    $staged = "$destination.new"
    Copy-Item -LiteralPath $downloaded -Destination $staged -Force

    if (Test-Path -LiteralPath $destination) {
        try {
            Remove-Item -LiteralPath $destination -Force
        } catch {
            $displaced = "$destination.old-$(Get-Date -Format 'yyyyMMddHHmmss')"
            try {
                Move-Item -LiteralPath $destination -Destination $displaced -Force
            } catch {
                Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue
                Stop-Install "Could not replace $destination." @(
                    'Is a DIIISCO node running from that binary? Stop it with: diiisco stop'
                )
            }
        }
    }

    try {
        Move-Item -LiteralPath $staged -Destination $destination -Force
    } catch {
        Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue
        Stop-Install "Could not write $destination." @(
            'Is a DIIISCO node running from that binary? Stop it with: diiisco stop'
        )
    }

    # Anything fetched over the network carries a mark-of-the-web alternate
    # data stream; without clearing it SmartScreen challenges the first run.
    try { Unblock-File -LiteralPath $destination -ErrorAction SilentlyContinue } catch { }

    $installedVersion = try { (& $destination version 2>$null) -join ' ' } catch { '' }
    if (-not $installedVersion) {
        Stop-Install "Installed $destination, but it does not run on this machine." @(
            'Report this with the output of: systeminfo | findstr /B /C:"OS Name" /C:"System Type"'
        )
    }

    Write-Ok "Installed $installedVersion to $destination"

    # -- PATH ---------------------------------------------------------------

    $stored = $null
    try {
        $stored = Get-StoredPath -Scope $pathScope
    } catch {
        Write-Plain
        Write-Warn "Could not read your $($pathScope.ToLowerInvariant()) PATH from the registry: $($_.Exception.Message)"
        Write-Warn "diiisco.exe is installed; add this directory to PATH yourself: $InstallDir"
    }

    $alreadyOnPath = $stored -and (Test-PathContains -StoredPath $stored.Value -Directory $InstallDir)

    if (-not $stored) {
        # Already reported above.
    } elseif ($alreadyOnPath) {
        Write-Info "$InstallDir is already on your $($pathScope.ToLowerInvariant()) PATH."
    } elseif ($NoModifyPath) {
        Write-Plain
        Write-Warn "$InstallDir is not on your PATH."
        Write-Plain '  Add this directory to your PATH:'
        Write-Plain ''
        Write-Plain "    $InstallDir"
        Write-Plain ''
        Write-Info  '  Windows > Settings > Edit environment variables for your account > Path,'
        Write-Info  '  or re-run this installer without -NoModifyPath to do it for you.'
        Write-Info  '  (Avoid `setx PATH` for this - it truncates at 1024 characters and merges'
        Write-Info  '  the machine PATH into your user one.)'
    } else {
        # Unlike Unix there is no conventional user bin directory already on
        # PATH, so a Windows install that does not touch PATH leaves `diiisco`
        # uncallable. Editing the registry value is the native equivalent of
        # install.sh's --modify-path, and it is reversible.
        $separator = if ($stored.Value -and -not $stored.Value.EndsWith(';')) { ';' } else { '' }
        try {
            Set-StoredPath -Scope $pathScope -Value "$($stored.Value)$separator$InstallDir" -Kind $stored.Kind
            Publish-EnvironmentChange
            Write-Ok "Added $InstallDir to your $($pathScope.ToLowerInvariant()) PATH."
            Write-Info 'Open a new terminal for other shells to pick this up.'
        } catch {
            Write-Plain
            Write-Warn "Could not add $InstallDir to your $($pathScope.ToLowerInvariant()) PATH: $($_.Exception.Message)"
            Write-Warn 'diiisco.exe is installed; add that directory to PATH yourself.'
        }

        # Make it usable in *this* session too, not just new ones.
        if (-not (Test-PathContains -StoredPath $env:Path -Directory $InstallDir)) {
            $env:Path = "$($env:Path.TrimEnd(';'));$InstallDir"
        }
    }

    # -- DIIISCO Desktop ----------------------------------------------------

    if (-not $NoDesktop) {
        # collect.ts publishes the installer twice: flat under desktop/ (the
        # always-latest URL Electrobun's updater and the website both point at)
        # and archived under desktop/releases/<tag>/. Follow whichever the
        # caller asked for.
        $desktopArtifact = 'DIIISCO-setup.exe'
        $desktopUrl = if ($script:VersionPinned) {
            "$DesktopBaseUrl/releases/$tag/$desktopArtifact"
        } else {
            "$DesktopBaseUrl/$desktopArtifact"
        }

        Write-Plain
        Write-Plain 'Installing DIIISCO Desktop'
        Write-Info  '  target   win-x64'
        Write-Info  "  from     $desktopUrl"
        Write-Plain

        $setup = Join-Path $staging $desktopArtifact
        Write-Info "Downloading $desktopArtifact..."
        if (-not (Get-RemoteFile -Url $desktopUrl -Destination $setup)) {
            Stop-Install "Could not download $desktopUrl." @(
                'Check that a desktop build exists for this release.',
                "Releases: $DesktopBaseUrl",
                'Or skip the desktop app: -NoDesktop'
            )
        }
        Assert-WindowsExecutable -Path $setup -Url $desktopUrl

        # No SHA256SUMS is published for the desktop installer (unlike the CLI
        # binary above) - its Authenticode signature is the equivalent
        # integrity check. An unsigned build is a supported fallback elsewhere
        # in this pipeline, so a bad or missing signature warns, not blocks.
        if (-not $NoVerify) {
            Write-Info 'Verifying code signature...'
            $signature = Get-AuthenticodeSignature -LiteralPath $setup
            if ($signature.Status -eq 'Valid') {
                Write-Ok "Code signature verified ($($signature.SignerCertificate.Subject))."
            } else {
                Write-Warn "DIIISCO-setup.exe's code signature did not verify ($($signature.Status)) - installing anyway."
                Write-Warn 'This is expected for an unsigned build; SmartScreen may warn on first launch.'
            }
        }

        try { Unblock-File -LiteralPath $setup -ErrorAction SilentlyContinue } catch { }

        # /S is NSIS's silent-install switch (electrobun-builder-for-windows
        # produces a standard NSIS Setup.exe). The wizard is available with
        # -DesktopInteractive for anyone who wants to choose a location.
        $arguments = if ($DesktopInteractive) { @() } else { @('/S') }
        if (-not $DesktopInteractive) { Write-Info 'Running the installer silently (-DesktopInteractive shows the wizard)...' }

        $process = Start-Process -FilePath $setup -ArgumentList $arguments -Wait -PassThru
        if ($process.ExitCode -ne 0) {
            Stop-Install "DIIISCO-setup.exe exited with code $($process.ExitCode)." @(
                'Try running it yourself to see what it reports:',
                '  & ([scriptblock]::Create((irm https://diiis.co/install.ps1))) -DesktopInteractive',
                'Or install just the CLI: -NoDesktop'
            )
        }

        Write-Ok 'Installed DIIISCO Desktop.'
        Write-Info 'It also puts its own bundled diiisco.exe on your PATH; whichever'
        Write-Info 'directory comes first in PATH wins. `diiisco version` says which.'
    }

    # -- Next steps (spec §3.3: there is no zero-config run) ----------------

    Write-Plain
    Write-Plain 'Next steps'
    Write-Plain
    Write-Plain '  1. diiisco setup          create your configuration'
    Write-Plain '  2. diiisco launch claude  start a node and point Claude Code at it'
    Write-Plain
    Write-Info  '  diiisco help  for the full command list'
    Write-Plain
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

# $IsWindows only exists on PowerShell 6+; on 5.1 the host is always Windows.
$IsWindowsPlatform = if ($null -eq (Get-Variable -Name IsWindows -ErrorAction SilentlyContinue)) { $true } else { $IsWindows }

if ($Help) {
    Show-Usage
    return
}

$script:Deliberate = $false
$script:Staging = $null
$script:Failed = $false

try {
    Invoke-DiiiscoInstall
} catch {
    $script:Failed = $true
    $message = $_.Exception.Message
    if ($script:Color) {
        Write-Host ''
        Write-Host 'DIIISCO install failed' -ForegroundColor Red
        Write-Host $message
    } else {
        Write-Host ''
        Write-Host 'DIIISCO install failed'
        Write-Host $message
    }
    if (-not $script:Deliberate) {
        Write-Info $_.ScriptStackTrace
    }
    Write-Host ''
} finally {
    if ($script:Staging -and (Test-Path -LiteralPath $script:Staging)) {
        Remove-Item -LiteralPath $script:Staging -Recurse -Force -ErrorAction SilentlyContinue
    }
}

if ($script:Failed) {
    # `exit` from a script file is the caller's exit code; from an `iex`'d
    # script block it would terminate the user's interactive session, so set
    # $LASTEXITCODE there instead and let the printed error stand.
    if ($PSCommandPath) { exit 1 } else { $global:LASTEXITCODE = 1 }
}
