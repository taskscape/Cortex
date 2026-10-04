$ErrorActionPreference = 'Stop'

# Explorer may retain its pre-install environment until the next sign-in.
# Refresh only missing process values; explicit process overrides still win.
foreach ($name in @('OPENAI_API_KEY', 'POSTGRES_PASSWORD', 'NEO4J_PASSWORD', 'NEO4J_AUTH', 'MEM0_API_KEY')) {
    if (-not [Environment]::GetEnvironmentVariable($name, 'Process')) {
        $value = [Environment]::GetEnvironmentVariable($name, 'User')
        if ($value) { [Environment]::SetEnvironmentVariable($name, $value, 'Process') }
    }
}

foreach ($dockerBin in @(
    (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\bin'),
    (Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin')
)) {
    if ((Test-Path -LiteralPath (Join-Path $dockerBin 'docker.exe')) -and
        -not (Get-Command docker.exe -ErrorAction SilentlyContinue)) {
        $env:PATH = $dockerBin + ';' + $env:PATH
        break
    }
}

& (Join-Path $PSScriptRoot 'run.ps1') -NoRestartMatbot
if (-not $?) { exit 1 }
