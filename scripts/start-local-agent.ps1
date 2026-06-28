param(
    [switch]$SkipDocker,
    [switch]$SkipBuild,
    [switch]$NoRestartMatbot,
    [string]$MatbotCommand = $env:MATBOT_COMMAND
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$ComposeFile = Join-Path $Root "local-agent\docker\mem0\docker-compose.yml"

Set-Location $Root

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
        Write-Host "Stopping $Name listener on port $Port (PID $processId)"
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

if (-not $SkipBuild) {
    npm run build
}

if (-not $SkipDocker) {
    if (Get-Command docker -ErrorAction SilentlyContinue) {
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

New-Item -ItemType Directory -Force -Path "local-agent\logs" | Out-Null

if (Test-PortListening 8877) {
    Write-Host "File index already listening on http://localhost:8877"
}
else {
    Start-Process -FilePath "node" `
        -ArgumentList "local-agent\file-index\dist\server.js" `
        -WorkingDirectory $Root `
        -WindowStyle Hidden `
        -RedirectStandardOutput "local-agent\logs\file-index.out.log" `
        -RedirectStandardError "local-agent\logs\file-index.err.log"
}

if (Test-PortListening 8878) {
    Write-Host "File broker already listening on http://localhost:8878"
}
else {
    Start-Process -FilePath "node" `
        -ArgumentList "local-agent\file-broker\dist\server.js" `
        -WorkingDirectory $Root `
        -WindowStyle Hidden `
        -RedirectStandardOutput "local-agent\logs\file-broker.out.log" `
        -RedirectStandardError "local-agent\logs\file-broker.err.log"
}

if ($MatbotCommand) {
    $matbotWebPort = if ($env:MATBOT_WEB_PORT) { [int]$env:MATBOT_WEB_PORT } else { 19778 }
    if ((Test-PortListening $matbotWebPort) -and $NoRestartMatbot) {
        Write-Host "Matbot web UI already listening on http://localhost:$matbotWebPort"
    }
    else {
        if (Test-PortListening $matbotWebPort) {
            Stop-PortListeners $matbotWebPort "Matbot web UI"
        }
        Start-Process -FilePath "powershell" `
            -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $MatbotCommand `
            -WorkingDirectory $Root `
            -WindowStyle Hidden `
            -RedirectStandardOutput "local-agent\logs\matbot.out.log" `
            -RedirectStandardError "local-agent\logs\matbot.err.log"
    }
}

Write-Host "Local agent services requested."
Write-Host "File index:  http://localhost:8877"
Write-Host "File broker: http://localhost:8878"
Write-Host "Mem0:        $env:MEM0_BASE_URL"
Write-Host "Hybrid KnowledgeIndex plugin: local-agent\matbot\plugins\hybrid-knowledge-index\dist\index.js"
Write-Host "Workspace policy: local-agent\config\workspaces.json"
