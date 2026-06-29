param(
    [string]$ServiceName = "CortexLocalAgent",
    [switch]$RemoveWrapperFiles
)

$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$ServiceDir = Join-Path $Root "local-agent\service"
$WrapperExe = Join-Path $ServiceDir "$ServiceName.exe"
$WrapperXml = Join-Path $ServiceDir "$ServiceName.xml"

function Test-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Administrator)) {
    throw "Run this script from an elevated PowerShell session."
}

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    if ($existing.Status -ne "Stopped") {
        Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
        $existing.WaitForStatus("Stopped", [TimeSpan]::FromSeconds(30))
    }

    if (Test-Path -LiteralPath $WrapperExe) {
        & $WrapperExe uninstall
    }
    else {
        sc.exe delete $ServiceName | Write-Host
    }
}
else {
    Write-Host "Service '$ServiceName' is not installed."
}

if ($RemoveWrapperFiles) {
    foreach ($path in @($WrapperExe, $WrapperXml)) {
        if (Test-Path -LiteralPath $path) {
            Remove-Item -LiteralPath $path -Force
        }
    }
}

Write-Host "Uninstall complete for '$ServiceName'."
