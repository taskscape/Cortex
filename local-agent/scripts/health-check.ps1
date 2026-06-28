$ErrorActionPreference = "Stop"

$checks = @(
    @{ Name = "file-index"; Url = "http://localhost:8877/health" },
    @{ Name = "file-broker"; Url = "http://localhost:8878/health" },
    @{ Name = "mem0"; Url = "http://localhost:8888/health" }
)

foreach ($check in $checks) {
    try {
        $response = Invoke-RestMethod -Method Get -Uri $check.Url -TimeoutSec 3
        Write-Host "$($check.Name): ok $($response | ConvertTo-Json -Compress)"
    }
    catch {
        Write-Warning "$($check.Name): unavailable"
    }
}
