$ErrorActionPreference = "Stop"

$checks = @(
    @{ Name = "file-index"; Url = "http://localhost:8877/health" },
    @{ Name = "file-broker"; Url = "http://localhost:8878/health" },
    # mem0/mem0-api-server exposes no /health route; its Swagger UI at /docs
    # returning 200 confirms the API is up and serving.
    @{ Name = "mem0"; Url = "http://localhost:8888/docs" },
    @{ Name = "qdrant"; Url = "$(if ($env:CORTEX_RAG_QDRANT_URL) { $env:CORTEX_RAG_QDRANT_URL } else { 'http://localhost:6333' })/readyz" }
)

if ($env:CORTEX_RAG_CUDA_EMBEDDING_URL) {
    $checks += @{ Name = "workspace-rag-cuda"; Url = "$env:CORTEX_RAG_CUDA_EMBEDDING_URL/health" }
}

foreach ($check in $checks) {
    try {
        $response = Invoke-WebRequest -Method Get -Uri $check.Url -TimeoutSec 5 -UseBasicParsing
        $detail = ""
        $contentType = $response.Headers["Content-Type"]
        if ($contentType -and $contentType -match "application/json") {
            $detail = " " + $response.Content
        }
        Write-Host "$($check.Name): ok (HTTP $($response.StatusCode))$detail"
    }
    catch {
        Write-Warning "$($check.Name): unavailable ($($_.Exception.Message))"
    }
}
