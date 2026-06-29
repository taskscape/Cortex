param(
    [switch]$SkipDocker,
    [int]$WebPort = 19778
)

$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$MatbotRoot = Join-Path $Root "local-agent\matbot"
$ComposeFile = Join-Path $Root "local-agent\docker\mem0\docker-compose.yml"
$LogsRoot = Join-Path $Root "local-agent\logs"

function Write-ServiceLog($Message) {
    $timestamp = (Get-Date).ToString("s")
    Write-Host "[$timestamp] $Message"
}

function Test-PortListening($Port) {
    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1
    return $null -ne $listener
}

function Stop-PortListeners($Port, $Name) {
    $processIds = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique

    foreach ($processId in $processIds) {
        if (-not $processId) { continue }
        Write-ServiceLog "Stopping stale $Name listener on port $Port (PID $processId)"
        Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    }

    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $deadline) {
        if (-not (Test-PortListening $Port)) { return }
        Start-Sleep -Milliseconds 250
    }

    if (Test-PortListening $Port) {
        throw "$Name listener on port $Port did not stop."
    }
}

function Require-Command($Name) {
    $command = Get-Command $Name -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $command) {
        throw "$Name is required but was not found in PATH for the service account."
    }
    return $command.Source
}

function Start-NodeService($Name, $Port, $ScriptPath, $OutLog, $ErrLog) {
    if (Test-PortListening $Port) {
        Write-ServiceLog "$Name already listening on http://localhost:$Port"
        return
    }

    $node = Require-Command "node"
    Write-ServiceLog "Starting $Name on port $Port"
    Start-Process -FilePath $node `
        -ArgumentList $ScriptPath `
        -WorkingDirectory $Root `
        -WindowStyle Hidden `
        -RedirectStandardOutput $OutLog `
        -RedirectStandardError $ErrLog | Out-Null
}

Set-Location $Root
New-Item -ItemType Directory -Force -Path $LogsRoot | Out-Null

$fileIndexOutput = Join-Path $Root "local-agent\file-index\dist\server.js"
$fileBrokerOutput = Join-Path $Root "local-agent\file-broker\dist\server.js"
if (-not (Test-Path -LiteralPath $fileIndexOutput)) {
    throw "Missing $fileIndexOutput. Run .\scripts\setup-local-agent.ps1 before installing or starting the service."
}
if (-not (Test-Path -LiteralPath $fileBrokerOutput)) {
    throw "Missing $fileBrokerOutput. Run .\scripts\setup-local-agent.ps1 before installing or starting the service."
}
if (-not (Test-Path -LiteralPath (Join-Path $MatbotRoot "node_modules"))) {
    throw "Matbot dependencies are missing. Run .\scripts\run.ps1 -NoStart before installing or starting the service."
}

if (-not $SkipDocker) {
    if (Get-Command docker -ErrorAction SilentlyContinue) {
        Write-ServiceLog "Starting Mem0 Docker stack"
        docker compose -f $ComposeFile up -d
    }
    else {
        Write-Warning "Docker CLI not found. Skipping Mem0 dependency startup."
    }
}

if (-not $env:FILE_INDEX_BASE_URL) {
    $env:FILE_INDEX_BASE_URL = "http://localhost:8877"
}
if (-not $env:FILE_BROKER_BASE_URL) {
    $env:FILE_BROKER_BASE_URL = "http://localhost:8878"
}
if (-not $env:MEM0_BASE_URL) {
    $env:MEM0_BASE_URL = "http://localhost:8888"
}

$env:MATBOT_WEB_PORT = [string]$WebPort
$env:CORTEX_SERVICE_SUPERVISED = "1"

Start-NodeService `
    -Name "file-index" `
    -Port 8877 `
    -ScriptPath "local-agent\file-index\dist\server.js" `
    -OutLog "local-agent\logs\file-index.out.log" `
    -ErrLog "local-agent\logs\file-index.err.log"

Start-NodeService `
    -Name "file-broker" `
    -Port 8878 `
    -ScriptPath "local-agent\file-broker\dist\server.js" `
    -OutLog "local-agent\logs\file-broker.out.log" `
    -ErrLog "local-agent\logs\file-broker.err.log"

if (Test-PortListening $WebPort) {
    Stop-PortListeners $WebPort "Matbot web UI"
}

$pnpm = Get-Command "pnpm.cmd" -ErrorAction SilentlyContinue |
    Select-Object -First 1
if (-not $pnpm) {
    $pnpm = Get-Command "pnpm" -ErrorAction SilentlyContinue |
        Select-Object -First 1
}
if (-not $pnpm) {
    throw "pnpm is required but was not found in PATH for the service account."
}

Write-ServiceLog "Starting Matbot foreground process on http://localhost:$WebPort"
Set-Location $MatbotRoot
& $pnpm.Source start
$exitCode = if ($LASTEXITCODE -ne $null) { $LASTEXITCODE } else { 0 }
Write-ServiceLog "Matbot foreground process exited with code $exitCode"
exit $exitCode
