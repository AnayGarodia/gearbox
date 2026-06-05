$ErrorActionPreference = "Stop"

# Public Gearbox installer for Windows PowerShell.
#
# Installs the published npm package into user-owned directories:
#   %LOCALAPPDATA%\Gearbox\versions\<version>\cli.mjs
#   %LOCALAPPDATA%\Gearbox\bin\gearbox.cmd
#
# It avoids npm global installs, admin privileges, Program Files, and system PATH
# writes. The user PATH is updated when needed.

$PackageName = if ($env:GEARBOX_PACKAGE) { $env:GEARBOX_PACKAGE } else { "gearbox-code" }
$Version = if ($env:GEARBOX_VERSION) { $env:GEARBOX_VERSION } else { "latest" }
$InstallRoot = if ($env:GEARBOX_INSTALL_DIR) { $env:GEARBOX_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "Gearbox" }
$BinDir = if ($env:GEARBOX_BIN_DIR) { $env:GEARBOX_BIN_DIR } else { Join-Path $InstallRoot "bin" }

function Require-Command($Name, $InstallHint) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    Write-Error "Gearbox installer needs '$Name'. $InstallHint"
  }
}

Require-Command "node" "Install Node.js, then rerun this installer."
Require-Command "tar" "Install a current Windows build or Git for Windows, then rerun this installer."

$Temp = Join-Path ([System.IO.Path]::GetTempPath()) ("gearbox-install-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $Temp | Out-Null

try {
  $MetaUrl = "https://registry.npmjs.org/$PackageName/$Version"
  $MetaFile = Join-Path $Temp "meta.json"
  Write-Host "-> Fetching $PackageName@$Version"
  Invoke-WebRequest -Uri $MetaUrl -OutFile $MetaFile -UseBasicParsing

  $Meta = Get-Content $MetaFile -Raw | ConvertFrom-Json
  $ResolvedVersion = $Meta.version
  $TarballUrl = $Meta.dist.tarball
  if (-not $ResolvedVersion -or -not $TarballUrl) {
    Write-Error "Could not resolve $PackageName@$Version from npm."
  }

  $TargetDir = Join-Path (Join-Path $InstallRoot "versions") $ResolvedVersion
  $Archive = Join-Path $Temp "package.tgz"
  $ExtractDir = Join-Path $Temp "extract"

  Write-Host "-> Downloading $PackageName@$ResolvedVersion"
  Invoke-WebRequest -Uri $TarballUrl -OutFile $Archive -UseBasicParsing
  New-Item -ItemType Directory -Force -Path $ExtractDir, $TargetDir, $BinDir | Out-Null
  tar -xzf $Archive -C $ExtractDir

  $Cli = Join-Path $ExtractDir "package\dist\cli.mjs"
  if (-not (Test-Path $Cli)) {
    Write-Error "Package did not contain dist/cli.mjs."
  }

  $TargetCli = Join-Path $TargetDir "cli.mjs"
  Copy-Item $Cli $TargetCli -Force

  $CmdPath = Join-Path $BinDir "gearbox.cmd"
  $Cmd = @"
@echo off
node "$TargetCli" %*
"@
  Set-Content -Path $CmdPath -Value $Cmd -Encoding ASCII

  $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $PathParts = @()
  if ($UserPath) { $PathParts = $UserPath -split ";" }
  $AlreadyOnPath = $PathParts | Where-Object { $_ -ieq $BinDir }
  if (-not $AlreadyOnPath) {
    $NextPath = if ($UserPath) { "$UserPath;$BinDir" } else { $BinDir }
    [Environment]::SetEnvironmentVariable("Path", $NextPath, "User")
    $env:Path = "$env:Path;$BinDir"
  }

  Write-Host ""
  Write-Host "Installed Gearbox $ResolvedVersion"
  Write-Host "  $CmdPath"
  Write-Host ""
  Write-Host "Run it with: gearbox"
  if (-not $AlreadyOnPath) {
    Write-Host "Open a new terminal if this shell does not pick up the PATH change."
  }

  if ($env:GEARBOX_SKIP_ONBOARD -ne "1") {
    Write-Host ""
    Write-Host "Starting setup..."
    & $CmdPath onboard
  }
}
finally {
  Remove-Item -Recurse -Force $Temp -ErrorAction SilentlyContinue
}
