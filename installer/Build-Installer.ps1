param(
    [string]$IsccPath,
    [string]$OutputDirectory = (Join-Path $PSScriptRoot 'Output')
)

$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$installerRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$stage = Join-Path $installerRoot ('.stage-' + [guid]::NewGuid().ToString('N'))
if (-not $stage.StartsWith($installerRoot + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Unsafe staging directory.'
}

if (-not $IsccPath) {
    $command = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if ($command) { $IsccPath = $command.Source }
    if (-not $IsccPath) {
        $IsccPath = @(
            'C:\Program Files\Inno Setup 6\ISCC.exe',
            'C:\Program Files (x86)\Inno Setup 6\ISCC.exe'
        ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    }
}
if (-not (Test-Path -LiteralPath $IsccPath -PathType Leaf)) { throw "Inno Setup compiler not found: $IsccPath" }
$version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version

try {
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    $tracked = & git -C $root ls-files --cached --full-name
    if ($LASTEXITCODE -ne 0) { throw 'Could not enumerate tracked source files.' }
    $copied = 0
    foreach ($relative in $tracked) {
        $path = $relative.Replace('/', '\')
        $include = $path -in @('package.json', 'package-lock.json', 'tsconfig.json', 'README.md', 'userguide.md') -or
            $path.StartsWith('docs\', [StringComparison]::OrdinalIgnoreCase) -or
            $path.StartsWith('scripts\', [StringComparison]::OrdinalIgnoreCase) -or
            $path.StartsWith('local-agent\', [StringComparison]::OrdinalIgnoreCase)
        if (-not $include) { continue }
        if ($path -ieq 'local-agent\config\workspaces.json' -or
            $path -ieq 'local-agent\matbot\cortex-workspaces.json' -or
            $path.StartsWith('local-agent\matbot\workspaces\', [StringComparison]::OrdinalIgnoreCase) -or
            $path -match '(?i)(^|\\)(matbot\.yaml|cortex-rag\.json|\.env[^\\]*|\.data[^\\]*)(\\|$)') { continue }
        $source = Join-Path $root $path
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Tracked source is missing: $relative" }
        $item = Get-Item -LiteralPath $source
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Symlinks are not allowed in installer payload: $relative" }
        $destination = Join-Path $stage $path
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        Copy-Item -LiteralPath $source -Destination $destination
        $copied++
    }
    # Include new helpers before the installer change is committed.
    foreach ($helperName in @('install-cortex-package.ps1', 'open-cortex.ps1')) {
        Copy-Item -LiteralPath (Join-Path $root "scripts\$helperName") -Destination (Join-Path $stage "scripts\$helperName") -Force
    }
    Write-Host "Staged $copied tracked source files without workspace-local settings."
    New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
    & $IsccPath "/DPayloadDir=$stage" "/DAppVersion=$version" "/DOutputDir=$OutputDirectory" (Join-Path $installerRoot 'Cortex.iss')
    if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed with exit code $LASTEXITCODE." }
    Write-Host "Installer: $(Join-Path $OutputDirectory "Cortex-$version-win-x64-Setup.exe")"
}
finally {
    if (Test-Path -LiteralPath $stage) {
        $resolved = [System.IO.Path]::GetFullPath($stage)
        if (-not $resolved.StartsWith($installerRoot + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Unsafe staging cleanup path.'
        }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
