# install.ps1 — install Sanad into a Claude Code home folder (default: %USERPROFILE%\.claude).
#
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Dest D:\other\.claude -KeepSettings
#
# 1. Backs up every file it will replace to <Dest>\backups\sanad-install-<timestamp>\.
# 2. Copies CLAUDE.md, skills\, hooks\, agents\, output-styles\, scripts\workflow-install.sh, scripts\remote\, scripts\docker\ and scripts\replay\.
# 3. Writes settings.json with the hook paths pointed at <Dest>\hooks\ (skip with -KeepSettings).
# 4. Runs the hook and gate test suites from the installed location (skip with -SkipTests).
# 5. Registers the two Docker tasks for this user (scripts\docker\register-tasks.ps1).
# A test suite that fails (a failing test, a runner that cannot start, or no result line) puts the previous
# files back before the script stops (2026-11-17: twice a failed suite left the new files live and half set up).
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
  @{ From = 'output-styles';               To = 'output-styles' },
  @{ From = 'scripts\workflow-install.sh'; To = 'scripts\workflow-install.sh' },
  @{ From = 'scripts\remote';              To = 'scripts\remote' },
  @{ From = 'scripts\docker';              To = 'scripts\docker' },
  @{ From = 'scripts\replay';              To = 'scripts\replay' }
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

# Every path the copy writes, relative to $Dest, so a failed test run can put the old files back.
$written = New-Object System.Collections.ArrayList

# Puts back what the copy replaced and removes what it added: each written path is removed, then restored
# from the backup when it was there before.
function Restore-Install {
  foreach ($relative in $written) {
    $live = Join-Path $Dest $relative
    $old = Join-Path $Backup $relative
    if (Test-Path $live) { Remove-Item -Recurse -Force $live }
    if (Test-Path $old) { Copy-Item -Recurse -Force $old $live }
  }
  Write-Host ("  rolled back: the previous files are live again (" + $written.Count + " entries)")
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
      [void]$written.Add((Join-Path $i.To $_.Name))
      if (Test-Path $dst) { Remove-Item -Recurse -Force $dst }
      Copy-Item -Recurse -Force $_.FullName $dst
    }
  } else {
    [void]$written.Add($i.To)
    Copy-Item -Force $from $to
  }
  Write-Host ("  installed  " + $i.To)
}

if ($KeepSettings) {
  Write-Host '  skipped    settings.json (-KeepSettings)'
} else {
  Backup-Target 'settings.json'
  [void]$written.Add('settings.json')
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
    $code = -1
    try {
      $out = & node --test 2>&1 | Out-String
      $code = $LASTEXITCODE
    } finally { Pop-Location }
    # The runner's own totals are its last "pass N" and "fail N" lines (a test title may hold the same words).
    $passes = [regex]::Matches($out, 'pass (\d+)')
    $fails = [regex]::Matches($out, 'fail (\d+)')
    $pass = if ($passes.Count) { $passes[$passes.Count - 1].Groups[1].Value } else { '' }
    $fail = if ($fails.Count) { $fails[$fails.Count - 1].Groups[1].Value } else { '' }
    Write-Host ("  tests      " + $suite + ": pass " + $pass + ", fail " + $fail)
    # Passed only with exit 0, a result line, at least one passing test and no failing one: a runner that
    # could not start prints no totals and must not read as success.
    $ok = ($code -eq 0) -and ($pass -match '^\d+$') -and ([int]$pass -gt 0) -and ($fail -eq '0')
    if (-not $ok) {
      Write-Host $out
      Restore-Install
      throw "Test suite failed: $suite (exit $code). The previous files are live again; the backup stays at $Backup"
    }
  }
}

& (Join-Path $Dest 'scripts\docker\register-tasks.ps1')

Write-Host ''
Write-Host 'Sanad installed. Restart Claude Code, then check /hooks and /help.'
