param(
    [string]$WorkspaceConfig = "local-agent\config\workspaces.json"
)

$ErrorActionPreference = "Stop"

function Test-Command($Name) {
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    return $null -ne $command
}

function Test-PortFree($Port) {
    $listener = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue
    return $null -eq $listener
}

Write-Host "Checking local-agent prerequisites..."

if (-not (Test-Command node)) {
    throw "Node.js is required."
}

if (-not (Test-Command npm)) {
    throw "npm is required."
}

if (-not (Test-Command docker)) {
    Write-Warning "Docker CLI was not found. Mem0 services cannot be started until Docker Desktop is installed."
}

if (-not (Test-Command wsl)) {
    Write-Warning "WSL was not found. Docker Desktop WSL2 integration may be unavailable."
}

foreach ($port in @(8877, 8878, 8888, 3000)) {
    if (-not (Test-PortFree $port)) {
        Write-Warning "Port $port is already in use."
    }
}

if (-not (Test-Path -LiteralPath $WorkspaceConfig)) {
    throw "Workspace config not found: $WorkspaceConfig"
}

npm install
npm run build

Write-Host "Setup complete."
Write-Host "Review configured roots in $WorkspaceConfig before indexing or allowing writes."
