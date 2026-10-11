<#
.SYNOPSIS
  Launch Chrome with consistent debugging port + user-data-dir for CDP MCP Server.

.DESCRIPTION
  Ensures every Chrome session uses the same port (9222) and profile dir.
  If a Chrome instance is already running on that port, this script no-ops.

.PARAMETER Port
  Remote debugging port. Default: 9222.

.PARAMETER UserDataDir
  Chrome user data directory. Default: $env:LOCALAPPDATA\Google\Chrome\User Data
  (your normal profile - careful, this attaches to your existing Chrome).
  Set to a custom path for an isolated profile (recommended for automation).

.PARAMETER Profile
  Profile directory name within UserDataDir. Default: Default
  Use "Profile 1", "Profile 2", etc. for multi-profile setups.

.PARAMETER Isolated
  If set, use a fresh profile dir at $env:TEMP\chrome-cdp-isolated
  (no cookies, no extensions - clean automation context).

.EXAMPLE
  .\start-chrome.ps1
  Launch Chrome at port 9222 with your Default profile.

.EXAMPLE
  .\start-chrome.ps1 -Isolated
  Launch Chrome at port 9222 with a fresh isolated profile.

.EXAMPLE
  .\start-chrome.ps1 -Port 9333 -Profile "Profile 2"
  Launch Chrome at port 9333 using Profile 2.

.NOTES
  Author: CDP Browser MCP Server team
  About the persistent "Chrome is being controlled" infobar:
  This is enforced by Chrome and CANNOT be hidden in stable builds.
  --disable-blink-features=AutomationControlled only hides navigator.webdriver,
  not the infobar. See _archive/research/ConnectionTokenInvestigation.md.
#>

[CmdletBinding()]
param(
  [int]$Port = 9222,
  [string]$UserDataDir = "$env:LOCALAPPDATA\Google\Chrome\User Data",
  [string]$Profile = "Default",
  [switch]$Isolated
)

$ErrorActionPreference = 'Stop'

# Detect Chrome path
$chromePaths = @(
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe"
)
$chromeExe = $chromePaths | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chromeExe) {
  Write-Error "Chrome not found. Install Chrome or set CHROME_PATH env var."
  exit 1
}

# Choose profile
if ($Isolated) {
  $UserDataDir = "$env:TEMP\chrome-cdp-isolated"
  $Profile = "Default"
  Write-Host "Using isolated profile: $UserDataDir"
} else {
  Write-Host "Using profile: $UserDataDir\$Profile"
}

# Check if already running on this port
try {
  $check = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/json/version" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
  Write-Host "Chrome already running on port $Port ($($check.Content -replace '\s+', ' ' | Out-String))" -ForegroundColor Yellow
  Write-Host "No-op. To start fresh: close Chrome first."
  exit 0
} catch {
  # not running, OK to launch
}

# Build args
$args = @(
  "--remote-debugging-port=$Port",
  "--user-data-dir=`"$UserDataDir`"",
  "--profile-directory=`"$Profile`"",
  "--disable-features=DisableLoadExtensionCommandLineSwitch"
)
Write-Host "Launching: $chromeExe $($args -join ' ')"

Start-Process -FilePath $chromeExe -ArgumentList $args

# Wait for the port to open
$tries = 0
while ($tries -lt 20) {
  Start-Sleep -Milliseconds 500
  try {
    Invoke-WebRequest -Uri "http://127.0.0.1:$Port/json/version" -UseBasicParsing -TimeoutSec 1 -ErrorAction Stop | Out-Null
    Write-Host "Chrome is up at http://127.0.0.1:$Port" -ForegroundColor Green
    Write-Host ""
    Write-Host "Connect CDP MCP Server: chrome://discovery URL = http://127.0.0.1:$Port"
    exit 0
  } catch {
    $tries++
  }
}
Write-Error "Chrome started but port $Port did not open within 10s. Check Chrome logs."
exit 2
