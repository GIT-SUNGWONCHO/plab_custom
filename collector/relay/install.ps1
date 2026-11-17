# 플랩레이더 알림 발송기 설치 (Windows)
# PowerShell에서:  irm https://plab-radar.oroloov.workers.dev/relay/install.ps1 | iex
# 하는 일: %LOCALAPPDATA%\PlabRadarRelay 에 발송기 저장 → 비밀값 만들기/ntfy 토큰 입력(이 PC 계정으로 암호화 저장)
#          → 로그인할 때 자동 실행되게 작업 스케줄러 등록 → 바로 시작

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$worker = 'https://plab-radar.oroloov.workers.dev'
$dir = Join-Path $env:LOCALAPPDATA 'PlabRadarRelay'
New-Item -ItemType Directory -Force -Path $dir | Out-Null

$script = (Invoke-WebRequest -Uri "$worker/relay/plab-relay.ps1" -UseBasicParsing).Content
if ($script -is [byte[]]) { $script = [Text.Encoding]::UTF8.GetString($script) }
[IO.File]::WriteAllText((Join-Path $dir 'plab-relay.ps1'), $script, (New-Object Text.UTF8Encoding $true))

$cfgPath = Join-Path $dir 'config.json'
$reuse = $false
if (Test-Path $cfgPath) { $reuse = (Read-Host '이미 설정이 있어요. 그대로 쓸까요? (y/n)') -eq 'y' }
if (-not $reuse) {
  $bytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $secret = ([Convert]::ToBase64String($bytes)) -replace '[+/=]', ''
  $tok = Read-Host 'ntfy 액세스 토큰(tk_...)을 붙여넣고 Enter (화면에 안 보여요)' -AsSecureString
  $cfg = [ordered]@{
    workerUrl   = $worker
    relaySecret = (ConvertTo-SecureString $secret -AsPlainText -Force | ConvertFrom-SecureString)
    ntfyToken   = ($tok | ConvertFrom-SecureString)
  }
  $cfg | ConvertTo-Json | Set-Content -Path $cfgPath -Encoding UTF8
  try { Set-Clipboard -Value $secret } catch {}
  Write-Host ''
  Write-Host '아래 값을 Cloudflare 워커 비밀(Secret) PC_RELAY_SECRET 에 넣어 주세요. (클립보드에도 복사했어요)' -ForegroundColor Yellow
  Write-Host $secret -ForegroundColor Cyan
  Write-Host ''
}

$ps1 = Join-Path $dir 'plab-relay.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ps1`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'PlabRadarRelay' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Stop-ScheduledTask -TaskName 'PlabRadarRelay' -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName 'PlabRadarRelay'
Write-Host "설치 완료: 발송기가 백그라운드에서 돌고 있어요. 로그: $dir\relay.log" -ForegroundColor Green
