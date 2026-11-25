# Makes the worker start when you sign in to Windows and restart if it stops. Run it in PowerShell:
#   powershell -ExecutionPolicy Bypass -File worker\install-service.ps1           install and start
#   powershell -ExecutionPolicy Bypass -File worker\install-service.ps1 remove    stop and remove
# Log: %LOCALAPPDATA%\Video Translator Worker\worker.log
# (`run` is what the scheduled task calls: it keeps the worker going, in a hidden window.)
param([ValidateSet("install", "remove", "run")][string]$Action = "install")
$ErrorActionPreference = "Stop"

$TaskName = "Video Translator Worker"
$Repo = Split-Path -Parent $PSScriptRoot
$Dir = Join-Path $env:LOCALAPPDATA "Video Translator Worker"
$Log = Join-Path $Dir "worker.log"

function Stop-Worker {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }
    # Stopping the task ends this script's loop, not the worker it started: end that one too.
    Get-CimInstance Win32_Process -Filter "Name = 'python.exe' OR Name = 'uv.exe'" |
        Where-Object { $_.CommandLine -like "*worker.py*--log*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

if ($Action -eq "run") {
    # Like launchd's KeepAlive: start it again 30 s after it stops, for whatever reason.
    $uv = (Get-Command uv).Source
    while ($true) {
        & $uv run --quiet (Join-Path $Repo "worker\worker.py") --log $Log
        Start-Sleep -Seconds 30
    }
}

Stop-Worker
if ($Action -eq "remove") {
    Write-Host "removed"
    exit 0
}

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) { throw "uv not found - winget install astral-sh.uv, then open a new PowerShell" }
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) { throw "ffmpeg not found - winget install Gyan.FFmpeg, then open a new PowerShell" }
if (-not (Test-Path (Join-Path $Repo "worker\.env"))) { throw "create $Repo\worker\.env first (see worker\.env.example)" }

New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$action = New-ScheduledTaskAction -Execute "powershell.exe" -WorkingDirectory $Repo `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`" run"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "installed and started - log: $Log"
