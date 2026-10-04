param(
    [ValidateSet('standard','minimal','compatibility')]
    [string]$CapabilityProfile = $(if ($env:CORTEX_CAPABILITY_PROFILE) { $env:CORTEX_CAPABILITY_PROFILE } else { 'standard' }),
    [switch]$ForceInstall,
    [switch]$SkipInstall,
    [switch]$SkipBuild,
    [switch]$SkipDocker,
    [switch]$SkipCudaIngestion,
    [switch]$SkipHealth,
    [switch]$NoBrowser,
    [switch]$NoStart,
    [switch]$NoRestartMatbot,
    [int]$WebPort = 19778,
    [int]$HealthTimeoutSec = 120
)

$ErrorActionPreference = "Stop"
$env:CORTEX_CAPABILITY_PROFILE = $CapabilityProfile

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$MatbotRoot = Join-Path $Root "local-agent\matbot"
$LogsRoot = Join-Path $Root "local-agent\logs"
$SetupScript = Join-Path $PSScriptRoot "setup-local-agent.ps1"
$StartScript = Join-Path $PSScriptRoot "start-local-agent.ps1"
$HealthScript = Join-Path $PSScriptRoot "health-check.ps1"
$WebUrl = "http://localhost:$WebPort"

function Write-Step($Message) {
    Write-Host ""
    Write-Host "==> $Message"
}

function Test-Command($Name) {
    return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Test-PathMissing($Path) {
    return -not (Test-Path -LiteralPath $Path)
}

function Test-AnySourceNewerThanOutput($SourceRoot, $OutputPath) {
    if (-not (Test-Path -LiteralPath $OutputPath)) {
        return $true
    }

    $outputTime = (Get-Item -LiteralPath $OutputPath).LastWriteTimeUtc
    $newer = Get-ChildItem -LiteralPath $SourceRoot -Recurse -File -Include *.ts,*.js,*.json -ErrorAction SilentlyContinue |
        Where-Object {
            $_.FullName -notmatch "\\node_modules\\" -and
            $_.FullName -notmatch "\\dist\\" -and
            $_.LastWriteTimeUtc -gt $outputTime
        } |
        Select-Object -First 1

    return $null -ne $newer
}

function Invoke-LoggedCommand($Command, $Arguments, $WorkingDirectory) {
    Write-Host "> $Command $($Arguments -join ' ')"
    $previous = Get-Location
    try {
        Set-Location -LiteralPath $WorkingDirectory
        & $Command @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "$Command exited with code $LASTEXITCODE."
        }
    }
    finally {
        Set-Location $previous
    }
}

function Wait-HttpOk($Name, $Url, $TimeoutSec) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $lastError = $null

    while ((Get-Date) -lt $deadline) {
        try {
            $response = Invoke-WebRequest -Method Get -Uri $Url -TimeoutSec 5 -UseBasicParsing
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) {
                Write-Host "${Name}: ok (HTTP $($response.StatusCode))"
                return $true
            }
            $lastError = "HTTP $($response.StatusCode)"
        }
        catch {
            $lastError = $_.Exception.Message
        }

        Start-Sleep -Seconds 2
    }

    Write-Warning "${Name}: unavailable after $TimeoutSec seconds ($lastError)"
    return $false
}

function Wait-TcpOk($Name, $HostName, $Port, $TimeoutSec) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $lastError = $null

    while ((Get-Date) -lt $deadline) {
        $client = $null
        try {
            $client = [System.Net.Sockets.TcpClient]::new()
            $task = $client.ConnectAsync($HostName, [int]$Port)
            if ($task.Wait(5000) -and $client.Connected) {
                Write-Host "${Name}: ok ($HostName`:$Port)"
                return $true
            }
            $lastError = "connection timed out"
        }
        catch {
            $lastError = $_.Exception.Message
        }
        finally {
            if ($client) { $client.Dispose() }
        }

        Start-Sleep -Seconds 2
    }

    Write-Warning "${Name}: unavailable after $TimeoutSec seconds ($lastError)"
    return $false
}

function Ensure-Pnpm {
    if (Test-Command pnpm) {
        return
    }

    Write-Step "Installing pnpm 9"
    Invoke-LoggedCommand "npm" @("install", "-g", "pnpm@9") $Root
    # A fresh Node install may not have the user npm prefix in the current
    # Explorer/Powershell PATH yet, even after the global install succeeds.
    $globalPrefix = (& npm config get prefix).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Unable to find the npm global prefix.' }
    if (Test-Path -LiteralPath $globalPrefix) {
        $env:PATH = $globalPrefix + ';' + $env:PATH
    }
    if (-not (Test-Command pnpm)) { throw 'pnpm 9 was installed but is not available on PATH.' }
}

Write-Host "Cortex local-agent launcher"
Write-Host "Root: $Root"

if (-not (Test-Command node)) {
    throw "Node.js is required. Install Node.js 20+ before running this script."
}
if (-not (Test-Command npm)) {
    throw "npm is required. It should be available with Node.js."
}

New-Item -ItemType Directory -Force -Path $LogsRoot | Out-Null

$fileIndexOutput = Join-Path $Root "local-agent\file-index\dist\server.js"
$fileBrokerOutput = Join-Path $Root "local-agent\file-broker\dist\server.js"
$fileBrokerClientOutput = Join-Path $Root "local-agent\matbot\plugins\file-broker\dist\index.js"
$rootInstallNeeded = $ForceInstall -or
    (Test-PathMissing (Join-Path $Root "node_modules")) -or
    (Test-PathMissing $fileIndexOutput) -or
    (Test-PathMissing $fileBrokerOutput)

$rootBuildNeeded = -not $SkipBuild -and (
    $rootInstallNeeded -or
    (Test-AnySourceNewerThanOutput (Join-Path $Root "local-agent\file-index\src") $fileIndexOutput) -or
    (Test-AnySourceNewerThanOutput (Join-Path $Root "local-agent\file-broker\src") $fileBrokerOutput) -or
    (Test-AnySourceNewerThanOutput (Join-Path $Root "local-agent\matbot\plugins\file-broker\src") $fileBrokerClientOutput)
)

if (-not $SkipInstall -and ($rootInstallNeeded -or $rootBuildNeeded)) {
    Write-Step "Installing and building local-agent"
    & $SetupScript
}
elseif (-not $SkipBuild -and $rootBuildNeeded) {
    Write-Step "Building local-agent"
    Invoke-LoggedCommand "npm" @("run", "build") $Root
}
else {
    Write-Step "Local-agent install/build is up to date"
}

if (-not $SkipInstall) {
    Ensure-Pnpm
}
elseif (-not (Test-Command pnpm)) {
    throw "pnpm is required to start Matbot. Re-run without -SkipInstall or install pnpm@9 manually."
}

$matbotInstallNeeded = $ForceInstall -or (Test-PathMissing (Join-Path $MatbotRoot "node_modules"))
if (-not $SkipInstall -and $matbotInstallNeeded) {
    Write-Step "Installing Matbot dependencies"
    Invoke-LoggedCommand "pnpm" @("install") $MatbotRoot
}
else {
    Write-Step "Matbot dependencies are installed"
}

if (-not $NoStart) {
    Write-Step "Starting local services and Matbot WebUI"
    $env:MATBOT_WEB_PORT = [string]$WebPort
    # --session create flips the CLI out of its ephemeral default (isEphemeral is true whenever
    # --session is absent), which is what makes every Store — sessions, remembered_facts, session
    # titles — persist to .data instead of a MemoryStore that dies with the process. The WebUI is a
    # long-lived server, so ephemeral-by-default is wrong for it. Filtered form so the flag reaches the
    # cli entry unambiguously through the single -- boundary.
    # Nothing is interpolated into this command string: the Matbot working directory travels via
    # -MatbotWorkingDirectory and MATBOT_WEB_PORT is already exported above, so a repository path
    # containing quotes cannot break child-process quoting.
    $matbotCommand = "pnpm --filter '@matatbread/matbot-cli' start -- --session create"
    $startArgs = @{
        CapabilityProfile = $CapabilityProfile
        SkipBuild = $true
        MatbotCommand = $matbotCommand
        MatbotWorkingDirectory = $MatbotRoot
    }
    if ($SkipDocker) {
        $startArgs.SkipDocker = $true
    }
    if ($SkipCudaIngestion) {
        $startArgs.SkipCudaIngestion = $true
    }
    if ($NoRestartMatbot) {
        $startArgs.NoRestartMatbot = $true
    }
    & $StartScript @startArgs
}
else {
    Write-Step "Skipping service startup"
}

if (-not $SkipHealth) {
    Write-Step "Checking service health"
    $webReady = $true
    if (-not $NoStart) {
        $webReady = Wait-HttpOk "matbot-web" $WebUrl $HealthTimeoutSec
    }

    & $HealthScript -WebUrl $WebUrl -CapabilityProfile $CapabilityProfile

    if (-not $webReady) {
        throw "Matbot WebUI did not become healthy at $WebUrl. Check local-agent\logs\matbot.err.log."
    }
}
else {
    Write-Step "Skipping health checks"
}

if (-not $NoBrowser) {
    Write-Step "Opening Matbot WebUI"
    Start-Process $WebUrl
}
else {
    Write-Step "Browser launch skipped"
}

Write-Host ""
Write-Host "Matbot WebUI: $WebUrl"
Write-Host "Logs:"
if ($CapabilityProfile -eq 'compatibility') {
    Write-Host "  local-agent\logs\file-index.out.log"
    Write-Host "  local-agent\logs\file-broker.out.log"
}
Write-Host "  local-agent\logs\matbot.out.log"
