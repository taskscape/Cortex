$ErrorActionPreference = "Stop"

foreach ($port in @(8877, 8878)) {
    Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique |
        ForEach-Object {
            Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
        }
}

if (Get-Command docker -ErrorAction SilentlyContinue) {
    $Root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
    $ComposeFile = Join-Path $Root "local-agent\docker\mem0\docker-compose.yml"
    docker compose -f $ComposeFile down
}

Write-Host "Local agent services stopped."
