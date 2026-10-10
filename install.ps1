# install.ps1 — install Sanad into a Claude Code home folder (default: %USERPROFILE%\.claude).
#
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Dest D:\other\.claude -KeepSettings
#
# 1. Backs up every file it will replace to <Dest>\backups\sanad-install-<timestamp>\.
# 2. Copies CLAUDE.md, skills\, hooks\, agents\ and scripts\workflow-install.sh.
# 3. Writes settings.json with the hook paths pointed at <Dest>\hooks\ (skip with -KeepSettings).
# 4. Runs the hook and gate test suites from the installed location (skip with -SkipTests).
# Windows PowerShell 5.1 compatible. Never touches credentials, sessions, memory or projects.

[CmdletBinding()]
param(
  [string]$Dest = (Join-Path $env:USERPROFILE '.claude'),
  [switch]$KeepSettings,
  [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
$Src = $PSScriptRoot
$stamp = Get-Date -Format 'yyyy-MM-dd-HHmmss'
$Backup = Join-Path $Dest ("backups\sanad-install-" + $stamp)

$node = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $node) { throw 'Node.js is required (the hooks and tests run on Node). Install it from https://nodejs.org and retry.' }

$items = @(
  @{ From = 'CLAUDE.md';                   To = 'CLAUDE.md' },
  @{ From = 'skills';                      To = 'skills' },
  @{ From = 'hooks';                       To = 'hooks' },
  @{ From = 'agents';                      To = 'agents' },
  @{ From = 'scripts\workflow-install.sh'; To = 'scripts\workflow-install.sh' }
)

New-Item -ItemType Directory -Force -Path $Dest | Out-Null

function Backup-Target([string]$relative) {
  $target = Join-Path $Dest $relative
  if (Test-Path $target) {
    $dir = Split-Path (Join-Path $Backup $relative) -Parent
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Copy-Item -Recurse -Force $target (Join-Path $Backup $relative)
  }
}

foreach ($i in $items) {
  $from = Join-Path $Src $i.From
  if (-not (Test-Path $from)) { throw "Missing in the bundle: $($i.From)" }
  Backup-Target $i.To
  $to = Join-Path $Dest $i.To
  $parent = Split-Path $to -Parent
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  if ((Get-Item $from).PSIsContainer) {
    # Replace the skill/hook/agent entries that Sanad owns; leave other entries alone.
    New-Item -ItemType Directory -Force -Path $to | Out-Null
    Get-ChildItem $from | ForEach-Object {
      $dst = Join-Path $to $_.Name
      if (Test-Path $dst) { Remove-Item -Recurse -Force $dst }
      Copy-Item -Recurse -Force $_.FullName $dst
    }
  } else {
    Copy-Item -Force $from $to
  }
  Write-Host ("  installed  " + $i.To)
}

if ($KeepSettings) {
  Write-Host '  skipped    settings.json (-KeepSettings)'
} else {
  Backup-Target 'settings.json'
  $raw = Get-Content (Join-Path $Src 'settings.json') -Raw
  # The bundle points every hook at C:\Users\Asus\.claude\hooks\...; JSON doubles the backslashes.
  $bundled = 'C:\\Users\\Asus\\.claude'
  $mine = ($Dest.TrimEnd('\')) -replace '\\', '\\'
  $raw = $raw.Replace($bundled, $mine)
  [System.IO.File]::WriteAllText((Join-Path $Dest 'settings.json'), $raw, (New-Object System.Text.UTF8Encoding $false))
  Write-Host ("  installed  settings.json (hooks -> " + $Dest + "\hooks)")
}

if (Test-Path $Backup) { Write-Host ("  backup     " + $Backup) }

if ($SkipTests) {
  Write-Host '  skipped    tests (-SkipTests)'
} else {
  foreach ($suite in @('hooks\tests', 'skills\gate\tests')) {
    $dir = Join-Path $Dest $suite
    Push-Location $dir
    try {
      $out = & node --test 2>&1 | Out-String
    } finally { Pop-Location }
    $pass = [regex]::Match($out, 'pass (\d+)').Groups[1].Value
    $fail = [regex]::Match($out, 'fail (\d+)').Groups[1].Value
    Write-Host ("  tests      " + $suite + ": pass " + $pass + ", fail " + $fail)
    if ($fail -ne '0') { Write-Host $out; throw "Test suite failed: $suite" }
  }
}

Write-Host ''
Write-Host 'Sanad installed. Restart Claude Code, then check /hooks and /help.'
