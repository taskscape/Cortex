param(
    # OpenAI API key. If omitted, an existing OPENAI_API_KEY env var is kept.
    [string]$OpenAiKey,
    # Setup passes the wizard value through a temporary file so it never appears
    # in a process command line or Inno Setup log.
    [string]$OpenAiKeyFile,
    # Regenerate passwords even if they are already present in the environment.
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$envPath = Join-Path $PSScriptRoot "..\local-agent\docker\mem0\.env"
$existingDockerEnv = @{}
if (Test-Path -LiteralPath $envPath) {
    foreach ($line in Get-Content -LiteralPath $envPath) {
        if ($line -match '^([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
            $existingDockerEnv[$Matches[1]] = $Matches[2]
        }
    }
}

function New-Secret([int]$Length = 28) {
    $chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    # GetInt32 samples the full alphabet uniformly; byte % length would bias
    # the first characters of the alphabet (256 % 62 != 0).
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $bytes = New-Object 'System.Byte[]' 1
        $result = New-Object System.Text.StringBuilder
        # Rejection sampling works in Windows PowerShell 5.1 and avoids modulo bias.
        $limit = [int]([math]::Floor(256 / $chars.Length) * $chars.Length)
        while ($result.Length -lt $Length) {
            $rng.GetBytes($bytes)
            if ($bytes[0] -lt $limit) {
                [void]$result.Append($chars[$bytes[0] % $chars.Length])
            }
        }
        return $result.ToString()
    }
    finally {
        $rng.Dispose()
    }
}

function Resolve-Secret($Name, [int]$Length) {
    $existing = [Environment]::GetEnvironmentVariable($Name, 'User')
    if ($existing -and -not $Force) { return $existing }
    if ($existingDockerEnv.ContainsKey($Name) -and -not $Force) { return $existingDockerEnv[$Name] }
    return (New-Secret $Length)
}

# OpenAI key: use the provided value, otherwise keep an existing one.
if ($OpenAiKeyFile) {
    if ($OpenAiKey) { throw 'Specify either -OpenAiKey or -OpenAiKeyFile.' }
    $OpenAiKey = [System.IO.File]::ReadAllText($OpenAiKeyFile, [System.Text.Encoding]::UTF8).Trim()
}
if (-not $OpenAiKey) {
    $OpenAiKey = [Environment]::GetEnvironmentVariable('OPENAI_API_KEY', 'User')
}
if (-not $OpenAiKey -and $existingDockerEnv.ContainsKey('OPENAI_API_KEY')) {
    $OpenAiKey = $existingDockerEnv['OPENAI_API_KEY']
}
if (-not $OpenAiKey) {
    throw "No OpenAI key supplied. Re-run with -OpenAiKey '<key>'."
}

$pgPass  = Resolve-Secret 'POSTGRES_PASSWORD' 28
$neoPass = Resolve-Secret 'NEO4J_PASSWORD'    28
$mem0Key = Resolve-Secret 'MEM0_API_KEY'      40
$neoAuth = "neo4j/$neoPass"

# Persist as User-level environment variables.
[Environment]::SetEnvironmentVariable('OPENAI_API_KEY',   $OpenAiKey, 'User')
[Environment]::SetEnvironmentVariable('POSTGRES_PASSWORD', $pgPass,   'User')
[Environment]::SetEnvironmentVariable('NEO4J_PASSWORD',    $neoPass,  'User')
[Environment]::SetEnvironmentVariable('NEO4J_AUTH',        $neoAuth,  'User')
[Environment]::SetEnvironmentVariable('MEM0_API_KEY',      $mem0Key,  'User')

# Make them available in the current session too.
$env:OPENAI_API_KEY    = $OpenAiKey
$env:POSTGRES_PASSWORD = $pgPass
$env:NEO4J_PASSWORD    = $neoPass
$env:NEO4J_AUTH        = $neoAuth
$env:MEM0_API_KEY      = $mem0Key

# Write the gitignored .env consumed by docker compose. Preserve operator-owned
# settings such as embedding models on upgrades and key rotation.
$managedNames = @('MEM0_BASE_URL', 'MEM0_API_KEY', 'POSTGRES_DB', 'POSTGRES_USER',
    'POSTGRES_PASSWORD', 'NEO4J_PASSWORD', 'NEO4J_AUTH', 'OPENAI_API_KEY')
$preservedLines = @()
if (Test-Path -LiteralPath $envPath) {
    $preservedLines = @(Get-Content -LiteralPath $envPath | Where-Object {
        $_ -notmatch '^([A-Za-z_][A-Za-z0-9_]*)=' -or $Matches[1] -notin $managedNames
    })
}
$newLines = @(
    "MEM0_BASE_URL=http://localhost:8888",
    "MEM0_API_KEY=$mem0Key",
    "POSTGRES_DB=mem0",
    "POSTGRES_USER=mem0",
    "POSTGRES_PASSWORD=$pgPass",
    "NEO4J_PASSWORD=$neoPass",
    "NEO4J_AUTH=$neoAuth",
    "OPENAI_API_KEY=$OpenAiKey"
)
[System.IO.File]::WriteAllLines($envPath, [string[]]($preservedLines + $newLines),
    [System.Text.UTF8Encoding]::new($false))

# Restrict the .env to the current user: strip inherited ACLs, then grant only
# the invoking account full control. The file holds every generated secret.
$identity = "$env:USERDOMAIN\$env:USERNAME"
icacls $envPath /inheritance:r /grant:r "${identity}:F" | Out-Null

Write-Host "Secrets configured (values hidden)."
Write-Host "  OPENAI_API_KEY, POSTGRES_PASSWORD, NEO4J_PASSWORD, NEO4J_AUTH, MEM0_API_KEY set at User scope."
Write-Host "  Wrote $((Resolve-Path $envPath).Path)"
Write-Host "Open a new terminal for the User-scope variables to be visible to other processes."
