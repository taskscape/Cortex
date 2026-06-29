param(
    [string]$ServiceName = "CortexLocalAgent",
    [string]$DisplayName = "Cortex Local Agent",
    [string]$Description = "Runs Cortex local-agent services and the Matbot WebUI under a Windows service wrapper.",
    [int]$WebPort = 19778,
    [switch]$SkipDocker,
    [switch]$Start,
    [switch]$Force,
    [string]$WinSWExe,
    [string]$WinSWDownloadUrl = "https://github.com/winsw/winsw/releases/latest/download/WinSW-x64.exe"
)

$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$ServiceDir = Join-Path $Root "local-agent\service"
$LogsDir = Join-Path $Root "local-agent\logs\service"
$WrapperExe = Join-Path $ServiceDir "$ServiceName.exe"
$WrapperXml = Join-Path $ServiceDir "$ServiceName.xml"
$Runner = Join-Path $PSScriptRoot "run-service.ps1"

function Test-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Escape-Xml($Value) {
    return [Security.SecurityElement]::Escape([string]$Value)
}

function Remove-ExistingService($Name) {
    $existing = Get-Service -Name $Name -ErrorAction SilentlyContinue
    if (-not $existing) { return }

    if (-not $Force) {
        throw "Service '$Name' already exists. Re-run with -Force to replace it."
    }

    if ($existing.Status -ne "Stopped") {
        Stop-Service -Name $Name -Force -ErrorAction SilentlyContinue
        $existing.WaitForStatus("Stopped", [TimeSpan]::FromSeconds(30))
    }

    if (Test-Path -LiteralPath $WrapperExe) {
        & $WrapperExe uninstall | Write-Host
    }
    else {
        sc.exe delete $Name | Write-Host
    }

    Start-Sleep -Seconds 2
}

if (-not (Test-Administrator)) {
    throw "Run this script from an elevated PowerShell session."
}

if (-not (Test-Path -LiteralPath $Runner)) {
    throw "Service runner not found: $Runner"
}

New-Item -ItemType Directory -Force -Path $ServiceDir | Out-Null
New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null

Remove-ExistingService $ServiceName

if ($WinSWExe) {
    if (-not (Test-Path -LiteralPath $WinSWExe)) {
        throw "WinSW executable not found: $WinSWExe"
    }
    Copy-Item -LiteralPath $WinSWExe -Destination $WrapperExe -Force
}
elseif (-not (Test-Path -LiteralPath $WrapperExe)) {
    Write-Host "Downloading WinSW service wrapper..."
    Invoke-WebRequest -Uri $WinSWDownloadUrl -OutFile $WrapperExe
}

Unblock-File -LiteralPath $WrapperExe -ErrorAction SilentlyContinue

$powershell = (Get-Command "powershell.exe" -ErrorAction Stop).Source
$arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$Runner`" -WebPort $WebPort"
if ($SkipDocker) {
    $arguments += " -SkipDocker"
}

$xml = @"
<service>
  <id>$(Escape-Xml $ServiceName)</id>
  <name>$(Escape-Xml $DisplayName)</name>
  <description>$(Escape-Xml $Description)</description>
  <executable>$(Escape-Xml $powershell)</executable>
  <arguments>$(Escape-Xml $arguments)</arguments>
  <workingdirectory>$(Escape-Xml $Root)</workingdirectory>
  <env name="CORTEX_SERVICE_SUPERVISED" value="1" />
  <env name="MATBOT_WEB_PORT" value="$(Escape-Xml $WebPort)" />
  <logpath>$(Escape-Xml $LogsDir)</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>10485760</sizeThreshold>
    <keepFiles>8</keepFiles>
  </log>
  <onfailure action="restart" delay="10 sec" />
  <onfailure action="restart" delay="30 sec" />
  <onfailure action="restart" delay="60 sec" />
  <resetfailure>1 hour</resetfailure>
  <stoptimeout>30 sec</stoptimeout>
  <stopparentprocessfirst>true</stopparentprocessfirst>
</service>
"@

Set-Content -LiteralPath $WrapperXml -Value $xml -Encoding UTF8

Write-Host "Installing $ServiceName..."
& $WrapperExe install | Write-Host

if ($Start) {
    Write-Host "Starting $ServiceName..."
    Start-Service -Name $ServiceName
}

Write-Host "Installed service '$ServiceName'."
Write-Host "Wrapper: $WrapperExe"
Write-Host "Config:  $WrapperXml"
Write-Host "Logs:    $LogsDir"
