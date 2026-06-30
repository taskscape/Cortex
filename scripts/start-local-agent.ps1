param(
    [switch]$SkipDocker,
    [switch]$SkipBuild,
    [switch]$SkipCudaIngestion,
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
                Write-Host "workspace-rag-cuda: ok ($($body.device), $($body.model))"
                return $true
            }
            $lastError = if ($body.message) { $body.message } else { "CUDA not reported as available" }
        }
        catch {
            $lastError = $_.Exception.Message
        }

        Start-Sleep -Seconds 2
    }

    Write-Warning "workspace-rag-cuda: unavailable after $TimeoutSec seconds ($lastError). Ingestion will use CPU."
    return $false
}

function Wait-QdrantReady($Url, $TimeoutSec) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $lastError = $null

    while ((Get-Date) -lt $deadline) {
        try {
            $response = Invoke-WebRequest -Method Get -Uri "$Url/readyz" -TimeoutSec 5 -UseBasicParsing
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) {
                Write-Host "qdrant: ok ($Url)"
                return $true
            }
            $lastError = "HTTP $($response.StatusCode)"
        }
        catch {
            $lastError = $_.Exception.Message
        }

        Start-Sleep -Seconds 2
    }

    Write-Warning "qdrant: unavailable after $TimeoutSec seconds ($lastError). Workspace RAG will fall back to JSON unless CORTEX_RAG_STORAGE forces Qdrant."
    return $false
}

if (-not $env:CORTEX_RAG_QDRANT_URL) {
    $env:CORTEX_RAG_QDRANT_URL = "http://localhost:6333"
}

if (-not $SkipBuild) {
    npm run build
}

if (-not $SkipDocker) {
    if (Get-Command docker -ErrorAction SilentlyContinue) {
        if (Test-CudaIngestionAvailable) {
            Write-Host "CUDA-capable Docker runtime detected. Starting Mem0 stack with workspace-rag CUDA embeddings."
            docker compose -f $ComposeFile --profile cuda up -d
            Wait-QdrantReady $env:CORTEX_RAG_QDRANT_URL 120 | Out-Null
            if (-not $env:CORTEX_RAG_CUDA_EMBEDDING_URL) {
                $env:CORTEX_RAG_CUDA_EMBEDDING_URL = "http://localhost:8890"
            }
            if (-not (Wait-CudaEmbeddingReady $env:CORTEX_RAG_CUDA_EMBEDDING_URL 180)) {
                $env:CORTEX_RAG_DISABLE_CUDA = "1"
                Remove-Item Env:CORTEX_RAG_CUDA_EMBEDDING_URL -ErrorAction SilentlyContinue
            }
        }
        else {
            Write-Host "CUDA-capable Docker runtime not detected. Starting Mem0 stack without CUDA ingestion."
            docker compose -f $ComposeFile up -d
            Wait-QdrantReady $env:CORTEX_RAG_QDRANT_URL 120 | Out-Null
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
Write-Host "Qdrant:      $env:CORTEX_RAG_QDRANT_URL"
$ragCudaUrl = if ($env:CORTEX_RAG_CUDA_EMBEDDING_URL) { $env:CORTEX_RAG_CUDA_EMBEDDING_URL } else { "disabled" }
Write-Host "RAG CUDA:    $ragCudaUrl"
Write-Host "Hybrid KnowledgeIndex plugin: local-agent\matbot\plugins\hybrid-knowledge-index\dist\index.js"
Write-Host "Workspace policy: local-agent\config\workspaces.json"
