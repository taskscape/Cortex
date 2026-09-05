param(
    [ValidateSet('standard','minimal','compatibility')]
    [string]$CapabilityProfile = $(if ($env:CORTEX_CAPABILITY_PROFILE) { $env:CORTEX_CAPABILITY_PROFILE } else { 'standard' }),
    [int]$WebPort = 19778,
    [switch]$SkipDocker
)
$env:CORTEX_CAPABILITY_PROFILE = $CapabilityProfile
$ErrorActionPreference = "Stop"

# Port-based stopping must never force-kill an unrelated application that
# happens to own one of these ports: verify the image name first.
$expectedNames = @("node", "powershell", "pwsh", "docker-compose")

$ports = @($WebPort,19779)
if ($CapabilityProfile -eq 'compatibility') { $ports += @(8877,8878) }
foreach ($port in $ports) {
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

if (-not $SkipDocker -and $CapabilityProfile -ne 'minimal' -and (Get-Command docker -ErrorAction SilentlyContinue)) {
    $Root = Resolve-Path (Join-Path $PSScriptRoot "..")
    $ComposeFile = Join-Path $Root "local-agent\docker\mem0\docker-compose.yml"
    docker compose -f $ComposeFile down --remove-orphans
}

Write-Host "Local agent services stopped."
