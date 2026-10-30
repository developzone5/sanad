# register-tasks.ps1 - make the two Docker tasks for this user. Safe to run again.
#   "Sanad Docker Idle Stop": runs idle-stop.ps1 every 5 minutes while the user is signed in.
#   "Sanad Docker Desktop":   no schedule; `schtasks /run` opens the Docker app in the user's
#                             desktop, which a remote session cannot do by itself.
$ErrorActionPreference = 'Stop'
$me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 4)

$script = Join-Path $PSScriptRoot 'idle-stop.ps1'
$run = New-ScheduledTaskAction -Execute 'conhost.exe' `
  -Argument "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$script`""
$every5 = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName 'Sanad Docker Idle Stop' -Action $run -Trigger $every5 `
  -Principal $principal -Settings $settings -Force | Out-Null

$app = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
if (Test-Path $app) {
  $open = New-ScheduledTaskAction -Execute $app
  Register-ScheduledTask -TaskName 'Sanad Docker Desktop' -Action $open `
    -Principal $principal -Settings $settings -Force | Out-Null
}
Write-Host '  tasks      Sanad Docker Idle Stop, Sanad Docker Desktop'
