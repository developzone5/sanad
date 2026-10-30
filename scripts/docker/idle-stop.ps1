# idle-stop.ps1 - stop this machine's containers when nothing has used them for a while.
# Runs every 5 minutes from the "Sanad Docker Idle Stop" task, so no session has to remember.
# Settings, per machine, in <claude home>\docker-idle.json (no file = do nothing):
#   { "idleMinutes": 30,
#     "watch": [ { "container": "app", "request": "HTTP (GET|POST) ", "ignore": "/health" } ] }
# Busy means: a test run is alive, a container started less than idleMinutes ago, or a watched
# container logged a request in that time. Containers are stopped, never removed.
param([int]$IdleMinutes = -1)
$ErrorActionPreference = 'Continue'

$home_ = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$config = Join-Path $home_ 'docker-idle.json'
$log = Join-Path $home_ 'docker-idle.log'
function Note([string]$text) { Add-Content -Path $log -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm') + ' ' + $text) }

if (-not (Test-Path $config)) { exit 0 }
$settings = Get-Content $config -Raw | ConvertFrom-Json
if ($IdleMinutes -lt 0) { $IdleMinutes = [int]$settings.idleMinutes }
if ($IdleMinutes -lt 0) { exit 0 }

$running = @(docker ps -q 2>$null)
if ($LASTEXITCODE -ne 0 -or $running.Count -eq 0) { exit 0 }

if (@(Get-Process testhost -ErrorAction SilentlyContinue).Count -gt 0) { exit 0 }

$cutoff = (Get-Date).ToUniversalTime().AddMinutes(-$IdleMinutes)
foreach ($id in $running) {
  $started = [DateTimeOffset]::Parse((docker inspect -f '{{.State.StartedAt}}' $id)).UtcDateTime
  if ($started -gt $cutoff) { exit 0 }
}

foreach ($watch in @($settings.watch)) {
  $lines = docker logs --since "$($IdleMinutes)m" $watch.container 2>&1 | ForEach-Object { "$_" }
  $used = @($lines | Where-Object { $_ -match $watch.request -and $_ -notmatch $watch.ignore })
  if ($used.Count -gt 0) { exit 0 }
}

docker stop $running | Out-Null
Note ("stopped " + $running.Count + " idle containers")
