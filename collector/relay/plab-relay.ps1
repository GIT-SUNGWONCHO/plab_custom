# 플랩레이더 알림 발송기 (Windows PowerShell 5.1+)
# 20초마다 워커에서 보낼 알림을 가져와 이 PC(집 IP)에서 ntfy.sh로 보내고 완료 표시.
# ntfy 무료 한도가 IP 기준이라 Cloudflare 공용 IP 대신 집 IP에서 보냄.
# 설정: 같은 폴더의 config.json (install.ps1이 만듦, 비밀값은 이 PC 사용자 계정으로만 풀리게 암호화)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $dir 'relay.log'

function Write-Log($msg) {
  try {
    if ((Test-Path $log) -and ((Get-Item $log).Length -gt 1MB)) { Move-Item $log "$log.old" -Force }
    Add-Content -Path $log -Value ("{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg) -Encoding UTF8
  } catch {}
}
function Unprotect($enc) {
  $ss = ConvertTo-SecureString $enc
  return [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss))
}

$cfg = Get-Content (Join-Path $dir 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$worker = $cfg.workerUrl.TrimEnd('/')
$secret = Unprotect $cfg.relaySecret
$ntfyToken = if ($cfg.ntfyToken) { Unprotect $cfg.ntfyToken } else { '' }
$auth = @{ Authorization = "Bearer $secret" }
Write-Log "start $worker"

while ($true) {
  try {
    $res = Invoke-RestMethod -Uri "$worker/api/relay/outbox" -Headers $auth -UseBasicParsing -TimeoutSec 20
    $sent = @(); $failed = @()
    foreach ($it in @($res.items)) {
      if ($null -eq $it) { continue }
      try {
        $h = @{}
        if ($ntfyToken) { $h.Authorization = "Bearer $ntfyToken" }
        $bytes = [Text.Encoding]::UTF8.GetBytes([string]$it.payload)
        Invoke-WebRequest -Uri 'https://ntfy.sh' -Method Post -Headers $h -Body $bytes -ContentType 'application/json; charset=utf-8' -UseBasicParsing -TimeoutSec 15 | Out-Null
        $sent += [int]$it.id
      } catch {
        $code = try { [int]$_.Exception.Response.StatusCode } catch { 0 }
        $failed += [pscustomobject]@{ id = [int]$it.id; error = ("ntfy $code " + $_.Exception.Message) }
        Write-Log ("send fail id={0} {1}" -f $it.id, $_.Exception.Message)
      }
    }
    if ($sent.Count -or $failed.Count) {
      $failedJson = ($failed | ForEach-Object { '{"id":' + $_.id + ',"error":' + (ConvertTo-Json ([string]$_.error)) + '}' }) -join ','
      $body = '{"sent":[' + ($sent -join ',') + '],"failed":[' + $failedJson + ']}'
      Invoke-RestMethod -Uri "$worker/api/relay/ack" -Method Post -Headers $auth -Body ([Text.Encoding]::UTF8.GetBytes($body)) -ContentType 'application/json; charset=utf-8' -UseBasicParsing -TimeoutSec 20 | Out-Null
      Write-Log ("sent={0} failed={1}" -f $sent.Count, $failed.Count)
    }
  } catch {
    Write-Log ("poll error " + $_.Exception.Message)
  }
  Start-Sleep -Seconds 20
}
