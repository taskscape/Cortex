param(
    [Parameter(Mandatory = $true)]
    [string]$CredentialFile,
    [int]$DockerTimeoutSec = 240
)

$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$logDirectory = Join-Path $root 'local-agent\logs'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$logPath = Join-Path $logDirectory 'installer-setup.log'

function Resolve-DockerCli {
    $command = Get-Command docker.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\bin\docker.exe'),
        (Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin\docker.exe')
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    throw 'Docker Desktop is not installed. Install it from https://docs.docker.com/desktop/setup/install/windows-install/ and run Cortex Setup again.'
}

function Resolve-DockerDesktop {
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\Docker Desktop.exe'),
        (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe')
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    return $null
}

function Wait-DockerEngine([string]$dockerCli, [int]$timeoutSec) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    $desktopStarted = $false
    do {
        $engineOs = $null
        try {
            $engineOs = & $dockerCli info --format '{{.OSType}}' 2>$null
            if ($LASTEXITCODE -ne 0) { $engineOs = $null }
        }
        catch { $engineOs = $null }
        if ($engineOs) {
            if ($engineOs.Trim() -ne 'linux') {
                throw 'Docker Desktop is using Windows containers. Switch to Linux containers and run Cortex Setup again.'
            }
            & $dockerCli compose version | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'Docker Compose V2 is required.' }
            return
        }
        if (-not $desktopStarted) {
            $desktop = Resolve-DockerDesktop
            if (-not $desktop) {
                throw 'Docker CLI was found, but Docker Desktop is unavailable. Start a Linux Docker engine and run Cortex Setup again.'
            }
            Write-Host 'Starting Docker Desktop. Complete its first-run prompts if shown.'
            Start-Process -FilePath $desktop | Out-Null
            $desktopStarted = $true
        }
        Start-Sleep -Seconds 5
    } while ((Get-Date) -lt $deadline)
    throw 'Docker Desktop did not start a Linux engine in time. Complete its WSL/terms setup, then run Cortex Setup again.'
}

function Assert-NodePrerequisite {
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $node) { throw 'Node.js 24 or newer is required. Install it from https://nodejs.org/ and run Cortex Setup again.' }
    $versionText = (& $node.Source --version).Trim()
    if ($LASTEXITCODE -ne 0 -or $versionText -notmatch '^v(\d+)\.') { throw 'Unable to read the Node.js version.' }
    if ([int]$Matches[1] -lt 24) { throw "Node.js 24 or newer is required; found $versionText." }
    foreach ($commandName in @('npm.cmd', 'corepack.cmd')) {
        if (-not (Get-Command $commandName -ErrorAction SilentlyContinue)) {
            throw "$commandName is required with Node.js 24 or newer."
        }
    }
}

try {
    Start-Transcript -Path $logPath -Append | Out-Null
    Assert-NodePrerequisite
    $dockerCli = Resolve-DockerCli
    $env:PATH = (Split-Path -Parent $dockerCli) + ';' + $env:PATH
    Wait-DockerEngine $dockerCli $DockerTimeoutSec
    if (-not (Test-Path -LiteralPath $CredentialFile -PathType Leaf)) {
        throw 'The temporary credential file is missing.'
    }
    & (Join-Path $PSScriptRoot 'setup-secrets.ps1') -OpenAiKeyFile $CredentialFile
    if (-not $?) { throw 'Cortex secret setup failed.' }
    & (Join-Path $PSScriptRoot 'run.ps1') -NoBrowser
    if (-not $?) { throw 'Cortex startup failed.' }
    Write-Host 'Cortex is ready at http://localhost:19778'
    exit 0
}
catch {
    Write-Host "Cortex setup failed: $($_.Exception.Message)"
    exit 1
}
finally {
    Stop-Transcript -ErrorAction SilentlyContinue | Out-Null
}
