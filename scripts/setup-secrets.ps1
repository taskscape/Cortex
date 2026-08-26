param(
    # OpenAI API key. If omitted, an existing OPENAI_API_KEY env var is kept.
    [string]$OpenAiKey,
    # Regenerate passwords even if they are already present in the environment.
    [switch]$Force
)

$ErrorActionPreference = "Stop"

function New-Secret([int]$Length = 28) {
    $chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    # GetInt32 samples the full alphabet uniformly; byte % length would bias
    # the first characters of the alphabet (256 % 62 != 0).
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $indexes = New-Object 'System.Int32[]' $Length
        for ($i = 0; $i -lt $Length; $i++) {
            $indexes[$i] = [System.Security.Cryptography.RandomNumberGenerator]::GetInt32(0, $chars.Length)
        }
        return -join ($indexes | ForEach-Object { $chars[$_] })
    }
    finally {
        $rng.Dispose()
    }
}

function Resolve-Secret($Name, [int]$Length) {
    $existing = [Environment]::GetEnvironmentVariable($Name, 'User')
    if ($existing -and -not $Force) { return $existing }
    return (New-Secret $Length)
}

# OpenAI key: use the provided value, otherwise keep an existing one.
if (-not $OpenAiKey) {
    $OpenAiKey = [Environment]::GetEnvironmentVariable('OPENAI_API_KEY', 'User')
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

# Write the gitignored .env consumed by docker compose.
$envPath = Join-Path $PSScriptRoot "..\local-agent\docker\mem0\.env"
@(
    "MEM0_BASE_URL=http://localhost:8888",
    "MEM0_API_KEY=$mem0Key",
    "POSTGRES_DB=mem0",
    "POSTGRES_USER=mem0",
    "POSTGRES_PASSWORD=$pgPass",
    "NEO4J_PASSWORD=$neoPass",
    "NEO4J_AUTH=$neoAuth",
    "OPENAI_API_KEY=$OpenAiKey"
) | Set-Content -Path $envPath -Encoding ascii

# Restrict the .env to the current user: strip inherited ACLs, then grant only
# the invoking account full control. The file holds every generated secret.
$identity = "$env:USERDOMAIN\$env:USERNAME"
icacls $envPath /inheritance:r /grant:r "${identity}:F" | Out-Null

Write-Host "Secrets configured (values hidden)."
Write-Host "  OPENAI_API_KEY, POSTGRES_PASSWORD, NEO4J_PASSWORD, NEO4J_AUTH, MEM0_API_KEY set at User scope."
Write-Host "  Wrote $((Resolve-Path $envPath).Path)"
Write-Host "Open a new terminal for the User-scope variables to be visible to other processes."
