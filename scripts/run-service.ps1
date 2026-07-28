param(
    [switch]$SkipDocker,
    [switch]$SkipCudaIngestion,
    [int]$WebPort = 19778,
    [int]$MemoryBrowserPort = 19779
)

$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$MatbotRoot = Join-Path $Root "local-agent\matbot"
$ComposeFile = Join-Path $Root "local-agent\docker\mem0\docker-compose.yml"
$DockerEnvFile = Join-Path (Split-Path $ComposeFile) ".env"
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

function Test-CudaIngestionAvailable {
    if ($SkipCudaIngestion -or $env:CORTEX_RAG_DISABLE_CUDA) {
        return $false
    }
    if (-not (Get-Command nvidia-smi -ErrorAction SilentlyContinue)) {
        return $false
    }
    try {
        & nvidia-smi -L *> $null
        if ($LASTEXITCODE -ne 0) {
            return $false
        }
    }
    catch {
        return $false
    }

    try {
        $runtimes = docker info --format "{{json .Runtimes}}" 2>$null
        return $runtimes -match '"nvidia"'
    }
    catch {
        return $false
    }
}

function Wait-CudaEmbeddingReady($Url, $TimeoutSec) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $lastError = $null

    while ((Get-Date) -lt $deadline) {
        try {
            $response = Invoke-WebRequest -Method Get -Uri "$Url/health" -TimeoutSec 5 -UseBasicParsing
            $body = $response.Content | ConvertFrom-Json
            if ($body.ok -and $body.cudaAvailable) {
                Write-ServiceLog "workspace-rag-cuda ready ($($body.device), $($body.model))"
                return $true
            }
            $lastError = if ($body.message) { $body.message } else { "CUDA not reported as available" }
        }
        catch {
            $lastError = $_.Exception.Message
        }

        Start-Sleep -Seconds 2
    }

    Write-Warning "workspace-rag-cuda unavailable after $TimeoutSec seconds ($lastError). Ingestion will use CPU."
    return $false
}

function Get-DockerEnvValue($Name) {
    if (-not (Test-Path -LiteralPath $DockerEnvFile)) { return $null }
    foreach ($line in Get-Content -LiteralPath $DockerEnvFile) {
        if ($line -match "^\s*$([regex]::Escape($Name))\s*=\s*(.*)\s*$") {
            return $Matches[1].Trim().Trim('"').Trim("'")
        }
    }
    return $null
}

function Resolve-ConfigValue($SpecificName, $BaseName, $DefaultValue = $null) {
    $specific = [Environment]::GetEnvironmentVariable($SpecificName)
    if ($specific) { return $specific }
    $base = [Environment]::GetEnvironmentVariable($BaseName)
    if ($base) { return $base }
    $fileValue = Get-DockerEnvValue $BaseName
    if ($fileValue) { return $fileValue }
    return $DefaultValue
}

function Set-PostgresRagEnv {
    if (-not $env:CORTEX_RAG_POSTGRES_HOST) { $env:CORTEX_RAG_POSTGRES_HOST = Resolve-ConfigValue "CORTEX_RAG_POSTGRES_HOST" "POSTGRES_HOST" "localhost" }
    if (-not $env:CORTEX_RAG_POSTGRES_PORT) { $env:CORTEX_RAG_POSTGRES_PORT = Resolve-ConfigValue "CORTEX_RAG_POSTGRES_PORT" "POSTGRES_PORT" "5432" }
    if (-not $env:CORTEX_RAG_POSTGRES_DB) { $env:CORTEX_RAG_POSTGRES_DB = Resolve-ConfigValue "CORTEX_RAG_POSTGRES_DB" "POSTGRES_DB" "mem0" }
    if (-not $env:CORTEX_RAG_POSTGRES_USER) { $env:CORTEX_RAG_POSTGRES_USER = Resolve-ConfigValue "CORTEX_RAG_POSTGRES_USER" "POSTGRES_USER" "mem0" }
    if (-not $env:CORTEX_RAG_POSTGRES_PASSWORD) { $env:CORTEX_RAG_POSTGRES_PASSWORD = Resolve-ConfigValue "CORTEX_RAG_POSTGRES_PASSWORD" "POSTGRES_PASSWORD" }
}

function Wait-PostgresReady($HostName, $Port, $TimeoutSec) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $lastError = $null

    while ((Get-Date) -lt $deadline) {
        $client = $null
        try {
            $client = [System.Net.Sockets.TcpClient]::new()
            $task = $client.ConnectAsync($HostName, [int]$Port)
            if ($task.Wait(5000) -and $client.Connected) {
                Write-ServiceLog "postgres ready ($HostName`:$Port)"
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

    Write-Warning "postgres unavailable after $TimeoutSec seconds ($lastError). Workspace RAG will fall back to JSON unless CORTEX_RAG_STORAGE forces Postgres."
    return $false
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

Set-PostgresRagEnv

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
        if (Test-CudaIngestionAvailable) {
            Write-ServiceLog "Starting Mem0 Docker stack with workspace-rag CUDA embeddings"
            docker compose -f $ComposeFile --profile cuda up -d
            Wait-PostgresReady $env:CORTEX_RAG_POSTGRES_HOST $env:CORTEX_RAG_POSTGRES_PORT 120 | Out-Null
            if (-not $env:CORTEX_RAG_CUDA_EMBEDDING_URL) {
                $env:CORTEX_RAG_CUDA_EMBEDDING_URL = "http://localhost:8890"
            }
            if (-not (Wait-CudaEmbeddingReady $env:CORTEX_RAG_CUDA_EMBEDDING_URL 180)) {
                $env:CORTEX_RAG_DISABLE_CUDA = "1"
                Remove-Item Env:CORTEX_RAG_CUDA_EMBEDDING_URL -ErrorAction SilentlyContinue
            }
        }
        else {
            Write-ServiceLog "Starting Mem0 Docker stack without CUDA ingestion"
            docker compose -f $ComposeFile up -d
            Wait-PostgresReady $env:CORTEX_RAG_POSTGRES_HOST $env:CORTEX_RAG_POSTGRES_PORT 120 | Out-Null
            if (-not $env:CORTEX_RAG_DISABLE_CUDA) {
                $env:CORTEX_RAG_DISABLE_CUDA = "1"
            }
        }
    }
    else {
        Write-Warning "Docker CLI not found. Skipping Mem0 dependency startup."
        if (-not $env:CORTEX_RAG_DISABLE_CUDA) {
            $env:CORTEX_RAG_DISABLE_CUDA = "1"
        }
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

while ($true) {
    if (Test-PortListening $WebPort) {
        Stop-PortListeners $WebPort "Matbot web UI"
    }
    # The memory browser binds its own port. A stale Matbot that kept it alive leaves the incoming one
    # with no memory UI (it only warns and carries on), which is how "port 19779 already in use" hid a
    # second runtime holding the same workspace .data.
    if (Test-PortListening $MemoryBrowserPort) {
        Stop-PortListeners $MemoryBrowserPort "Matbot memory browser"
    }

    Write-ServiceLog "Starting Matbot foreground process on http://localhost:$WebPort"
    Set-Location $MatbotRoot
    # --session create matches run.ps1. The CLI now also treats `start` as persistent on its own, so
    # this is belt-and-braces rather than the only thing standing between the service and a memory
    # store that dies with the process — but the two launch paths should stay identical.
    & $pnpm.Source --filter '@matatbread/matbot-cli' start -- --session create
    $exitCode = if ($LASTEXITCODE -ne $null) { $LASTEXITCODE } else { 0 }
    Write-ServiceLog "Matbot foreground process exited with code $exitCode"

    if ($exitCode -eq 42) {
        Write-ServiceLog "Workspace switch requested a Matbot restart; relaunching foreground process."
        Start-Sleep -Milliseconds 500
        continue
    }

    exit $exitCode
}
