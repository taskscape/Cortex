param(
    [ValidateSet('standard','minimal','compatibility')]
    [string]$CapabilityProfile = $(if ($env:CORTEX_CAPABILITY_PROFILE) { $env:CORTEX_CAPABILITY_PROFILE } else { 'standard' }),
    [string]$WebUrl = $(if ($env:MATBOT_WEB_PORT) { "http://localhost:$env:MATBOT_WEB_PORT" } else { 'http://localhost:19778' }),
    [switch]$ShowBody
)
$ErrorActionPreference = 'Stop'
# The running registry is authoritative: optional sources have their own bounded probes.
try {
    $runtime = Invoke-RestMethod -Method Get -Uri "$WebUrl/health" -TimeoutSec 5
    Write-Host 'matbot-web: ready'
    if ($CapabilityProfile -eq 'minimal') { return }
    $report = Invoke-RestMethod -Method Get -Uri "$WebUrl/api/diagnostics" -TimeoutSec 15
    foreach ($capability in $report.capabilities) {
        Write-Host "$($capability.id): $($capability.state)"
        if ($ShowBody -or $env:SHOW_BODIES) { $capability | ConvertTo-Json -Depth 12 | Write-Host }
    }
    Write-Host "runtime: $($report.state)"
} catch {
    throw "Capability health unavailable at $WebUrl. $($_.Exception.Message)"
}
