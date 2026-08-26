$ErrorActionPreference = "Stop"

# Port-based stopping must never force-kill an unrelated application that
# happens to own one of these ports: verify the image name first.
$expectedNames = @("node", "powershell", "pwsh", "docker-compose")

foreach ($port in @(8877, 8878, 19778)) {
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique |
        ForEach-Object {
            if (-not $_) { return }
            $process = Get-Process -Id $_ -ErrorAction SilentlyContinue
            if (-not $process) { return }
            if ($expectedNames -notcontains $process.ProcessName.ToLowerInvariant()) {
                Write-Warning "Skipping PID $_ on port ${port}: process '$($process.ProcessName)' is not a recognized Cortex process."
                return
            }
            Write-Host "Stopping $($process.ProcessName) (PID $_) listening on port $port"
            Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
        }
}

if (Get-Command docker -ErrorAction SilentlyContinue) {
    $Root = Resolve-Path (Join-Path $PSScriptRoot "..")
    $ComposeFile = Join-Path $Root "local-agent\docker\mem0\docker-compose.yml"
    docker compose -f $ComposeFile down --remove-orphans
}

Write-Host "Local agent services stopped."
