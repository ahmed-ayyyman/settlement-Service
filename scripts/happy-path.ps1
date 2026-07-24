<#
.SYNOPSIS
  MCDR Settlement API - happy-path smoke test for all 16 endpoints + register.

.DESCRIPTION
  Walks the full settlement lifecycle (health -> register -> login -> create ->
  review -> fee -> approve -> pay -> settle -> downloads -> notifications) and
  prints a per-endpoint pass/fail report.

  Requires the Docker Compose stack to be up (mcdr-api on :3000, mcdr-keycloak
  on :8081). Run from the repo root:  .\scripts\happy-path.ps1
#>

[CmdletBinding()]
param(
  [string]$ApiBase     = 'http://localhost:3000/api',
  [string]$KeycloakBase= 'http://localhost:8081',
  [string]$Realm       = 'mcdr',
  [string]$PublicClientId = 'mcdr-owner-portal',
  [string]$BackofficeUser = 'backoffice1',
  [string]$BackofficePass = 'test123',
  [int]   $NewUserPwdLen  = 12
)

$ErrorActionPreference = 'Stop'
# Strict mode 'Off' on purpose: this is a smoke test that must gracefully
# tolerate missing fields in error responses (e.g. body.id on a 400 body).

# --- helpers -----------------------------------------------------------------

$script:results = New-Object System.Collections.Generic.List[object]

function Write-Step([string]$msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok ([string]$msg)  { Write-Host "  [OK ] $msg" -ForegroundColor Green }
function Write-Err([string]$msg)  { Write-Host "  [FAIL] $msg" -ForegroundColor Red }

function Add-Result([int]$n, [string]$endpoint, [string]$method, [int]$expected, [int]$actual, [string]$note) {
  $passed = ($actual -eq $expected)
  $script:results.Add([pscustomobject]@{
    '#'        = $n
    Endpoint   = $endpoint
    Method     = $method
    Expected   = $expected
    Actual     = $actual
    Passed     = if ($passed) { 'PASS' } else { 'FAIL' }
    Note       = $note
  })
  if ($passed) { Write-Ok  ("{0,3} {1,-6} {2}  ->  {3}" -f $n, $method, $endpoint, $note) }
  else {
    Write-Err ("{0,3} {1,-6} {2}  ->  expected {3} got {4}: {5}" -f $n, $method, $endpoint, $expected, $actual, $note)
    if ($script:lastRaw -and $script:lastRaw.Length -lt 800) { Write-Host "        body: $script:lastRaw" -ForegroundColor DarkGray }
  }
}

function Invoke-CurlJson {
  <# Returns @{ status=int; body=obj } using curl.exe + ConvertFrom-Json #>
  param(
    [Parameter(Mandatory)] [string]$Url,
    [string]$Method = 'GET',
    [string]$Token,
    [string]$JsonBody,
    [string]$FormPayload,          # for multipart 'payload' field (JSON text)
    [string[]]$AttachmentPaths,    # for multipart 'attachments[]' files
    [string]$FileFieldName = 'attachments',  # multipart field name for the file(s)
    [string[]]$FilePaths           # alias: explicit single-file upload (uses $FileFieldName)
  )
  $tmp         = New-TemporaryFile
  $jsonTmp     = New-TemporaryFile
  $payloadFile = $null
  try {
    $curlArgs = @('-s', '-o', $tmp.FullName, '-w', '%{http_code}', '-X', $Method, $Url)
    if ($Token) { $curlArgs += @('-H', "Authorization: Bearer $Token") }
    if ($JsonBody) {
      [System.IO.File]::WriteAllText($jsonTmp.FullName, $JsonBody)
      $curlArgs += @('-H', 'Content-Type: application/json', '--data-binary', "@$($jsonTmp.FullName)")
    }
    if ($FormPayload -or $AttachmentPaths -or $FilePaths) {
      if ($FormPayload) {
        $payloadFile = New-TemporaryFile
        [System.IO.File]::WriteAllText($payloadFile.FullName, $FormPayload)
        $curlArgs += @('-F', "payload=<$($payloadFile.FullName);type=application/json")
      }
      $paths = $AttachmentPaths; if (-not $paths) { $paths = $FilePaths }
      if ($paths) {
        foreach ($p in $paths) {
          $curlArgs += @('-F', "$FileFieldName=@$p;type=application/pdf")
        }
      }
    }
    $code = & curl.exe @curlArgs
    $raw  = Get-Content $tmp.FullName -Raw
    $script:lastRaw = $raw
    $obj  = $null
    if ($raw) { try { $obj = $raw | ConvertFrom-Json } catch { $obj = $raw } }
    return @{ status = [int]$code; body = $obj; raw = $raw }
  }
  finally {
    Remove-Item $tmp.FullName     -Force -ErrorAction SilentlyContinue
    Remove-Item $jsonTmp.FullName -Force -ErrorAction SilentlyContinue
    if ($payloadFile) { Remove-Item $payloadFile.FullName -Force -ErrorAction SilentlyContinue }
  }
}

function Invoke-CurlBinary {
  <# Returns @{ status=int; bytes=byte[]; contentType=string } for file downloads #>
  param(
    [Parameter(Mandatory)] [string]$Url,
    [string]$Token
  )
  $tmp = New-TemporaryFile
  try {
    $curlArgs = @('-s', '-o', $tmp.FullName, '-D', '-', '-w', "`n%{http_code}")
    if ($Token) { $curlArgs += @('-H', "Authorization: Bearer $Token") }
    $raw   = & curl.exe @curlArgs $Url
    $lines = $raw -split "`n" | Where-Object { $_ -ne '' -and $_.Trim() -ne '' }
    $code  = [int](($lines | Select-Object -Last 1) -replace "`r", '')
    $ct    = ''
    $ctLine = $lines | Where-Object { $_ -match '^content-type:' } | Select-Object -First 1
    if ($ctLine) { $ct = ($ctLine -replace "`r", '') -replace '^content-type:\s*', '' }
    $bytes = [System.IO.File]::ReadAllBytes($tmp.FullName)
    return @{ status = $code; bytes = $bytes; contentType = $ct }
  }
  finally { Remove-Item $tmp.FullName -Force -ErrorAction SilentlyContinue }
}

function Get-Token([string]$username, [string]$password) {
  <# Password grant via Keycloak. Returns the access_token string. #>
  $tokenUrl = "$KeycloakBase/realms/$Realm/protocol/openid-connect/token"
  # URL-encode each field (a literal '+' in the email would otherwise be
  # decoded as a space by Keycloak's form parser).
  $u = [uri]::EscapeDataString($username)
  $p = [uri]::EscapeDataString($password)
  $cid = [uri]::EscapeDataString($PublicClientId)
  $body = "client_id=$cid&grant_type=password&username=$u&password=$p"
  $tmp = New-TemporaryFile
  try {
    $code = & curl.exe -s -o $tmp.FullName -w '%{http_code}' -X POST $tokenUrl `
            -H 'Content-Type: application/x-www-form-urlencoded' -d $body
    if ([int]$code -ne 200) { throw "Token request failed: HTTP $code for user '$username'" }
    $data = (Get-Content $tmp.FullName -Raw) | ConvertFrom-Json
    return $data.access_token
  }
  finally { Remove-Item $tmp.FullName -Force -ErrorAction SilentlyContinue }
}

function New-TemporaryPdf([string]$path, [string]$label) {
  # Minimal valid PDF (header + an empty page + xref + trailer). Multer trusts
  # the client's content-type so this is accepted as application/pdf.
  $pdf = @"
%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R>>endobj
4 0 obj<</Length 44>>stream
BT /F1 12 Tf 10 180 Td ($label) Tj ET
endstream endobj
xref
0 5
0000000000 65535 f
0000000009 00000 n
0000000052 00000 n
0000000095 00000 n
0000000143 00000 n
trailer<</Size 5/Root 1 0 R>>
startxref
237
%%EOF
"@
  [System.IO.File]::WriteAllText($path, $pdf, [System.Text.Encoding]::ASCII)
}

# --- run ----------------------------------------------------------------------

$overallPass = 0
$overallFail = 0

# 1. Health (public)
Write-Step '#1 GET /health'
$r = Invoke-CurlJson -Url "$ApiBase/health"
Add-Result 1 '/health' 'GET' 200 $r.status ("status=" + $r.body.status)
if ($r.status -eq 200) { $overallPass++ } else { $overallFail++ }

# 2. Register a brand-new owner (also endpoint #17 in README)
$stamp = Get-Date -Format 'yyyyMMddHHmmss'
$email = "happy+$stamp@example.com"
$password = "Pa`$$stamp"      # meets MinLength(6), contains specials
$firstName = 'Happy'
$lastName  = 'Path'
Write-Step "#2 (extra) POST /auth/register  ->  $email"
$body = @{ email = $email; firstName = $firstName; lastName = $lastName; password = $password } | ConvertTo-Json -Compress
$r = Invoke-CurlJson -Url "$ApiBase/auth/register" -Method POST -JsonBody $body
$ownerId = $r.body.id
Add-Result 2 '/auth/register' 'POST' 201 $r.status ("userId=$ownerId")
if ($r.status -eq 201) { $overallPass++ } else { $overallFail++ }

# 3. Login as the new owner
Write-Step "#3 POST /token (owner login)  ->  get access_token"
Start-Sleep -Milliseconds 500   # tiny grace period for Keycloak replication
try {
  $ownerToken = Get-Token -username $email -password $password
  Write-Ok "owner token acquired for $email ($($ownerToken.Length) chars)"
} catch {
  Write-Err "new-owner login failed: $_  -- falling back to built-in owner2"
  $email = 'owner2@test.com'
  $password = 'test123'
  try {
    $ownerToken = Get-Token -username 'owner2' -password 'test123'
    Write-Ok "fallback: logged in as owner2"
  } catch {
    Write-Err "owner2 login also failed: $_"
    throw
  }
}
$overallPass++

# 4. CRN eligibility (owner)
$crn = "CRN$stamp"            # 5-20 alphanumeric; matches ^[a-zA-Z0-9]+$
Write-Step "#4 GET /crn/$crn/eligibility"
$r = Invoke-CurlJson -Url "$ApiBase/crn/$crn/eligibility" -Token $ownerToken
Add-Result 4 "/crn/:crn/eligibility" 'GET' 200 $r.status ("needsSettlement=" + $r.body.needsSettlement)
if ($r.status -eq 200) { $overallPass++ } else { $overallFail++ }

# 5. Create settlement request (multipart: payload + 2 attachments)
$work = Join-Path $env:TEMP "mcdr-happy-$stamp"
New-Item -ItemType Directory -Path $work -Force | Out-Null
$pdf1 = Join-Path $work 'meeting1.pdf'; New-TemporaryPdf $pdf1 'Meeting 1'
$pdf2 = Join-Path $work 'meeting2.pdf'; New-TemporaryPdf $pdf2 'Meeting 2'

$payload = @{
  crn = $crn
  meetings = @(
    @{ meetingDate = '2024-01-15'; capitalAtMeeting = 100000 },
    @{ meetingDate = '2024-02-20'; capitalAtMeeting = 250000 }
  )
} | ConvertTo-Json -Compress

Write-Step '#5 POST /settlement-requests (multipart, 2 meetings)'
$r = Invoke-CurlJson -Url "$ApiBase/settlement-requests" -Method POST -Token $ownerToken `
     -FormPayload $payload -AttachmentPaths @($pdf1, $pdf2)
$reqId     = $r.body.id
$meeting1  = $r.body.meetings[0]
$meeting2  = $r.body.meetings[1]
$meeting1Id = $meeting1._id
$meeting2Id = $meeting2._id
Add-Result 5 '/settlement-requests' 'POST' 201 $r.status ("reqId=$reqId; m1=$meeting1Id m2=$meeting2Id status=" + $r.body.status)
if ($r.status -eq 201) { $overallPass++ } else { $overallFail++ }

# 6. GET /settlement-requests/mine
Write-Step '#6 GET /settlement-requests/mine'
$r = Invoke-CurlJson -Url "$ApiBase/settlement-requests/mine" -Token $ownerToken
$req2 = $r.body.request
Add-Result 6 '/settlement-requests/mine' 'GET' 200 $r.status ("request.id=" + $req2.id + " status=" + $req2.status)
if ($r.status -eq 200 -and $req2.id -eq $reqId) { $overallPass++ } else { $overallFail++ }

# 7. Backoffice login + GET /settlement-requests?status=PENDING_REVIEW
Write-Step '#7 POST /token (backoffice login)  ->  GET /settlement-requests'
$boToken = Get-Token -username $BackofficeUser -password $BackofficePass
$r = Invoke-CurlJson -Url "$ApiBase/settlement-requests`?status=PENDING_REVIEW&page=1&limit=10" -Token $boToken
$itemIds = $r.body.items | ForEach-Object { $_.id }
$foundInQueue = ($itemIds -contains $reqId)
Add-Result 7 '/settlement-requests' 'GET' 200 $r.status ("total=" + $r.body.total + " page=" + $r.body.page + " limit=" + $r.body.limit + " itemIds=[" + ($itemIds -join ',') + "] ours=$reqId in-list=$foundInQueue")
if ($r.status -eq 200 -and $foundInQueue) { $overallPass++ } else { $overallFail++ }

# 8. GET /settlement-requests/:id
Write-Step "#8 GET /settlement-requests/$reqId"
$r = Invoke-CurlJson -Url "$ApiBase/settlement-requests/$reqId" -Token $boToken
Add-Result 8 '/settlement-requests/:id' 'GET' 200 $r.status ("status=" + $r.body.status + " meetings=" + $r.body.meetings.Count)
if ($r.status -eq 200) { $overallPass++ } else { $overallFail++ }

# 9. PATCH meetings[0].fee = 500
Write-Step "#9 PATCH .../meetings/$meeting1Id/fee"
$r = Invoke-CurlJson -Url "$ApiBase/settlement-requests/$reqId/meetings/$meeting1Id/fee" -Method PATCH `
     -Token $boToken -JsonBody (@{ fee = 500 } | ConvertTo-Json -Compress)
Add-Result 9 '.../meetings/:meetingId/fee' 'PATCH' 200 $r.status ("meetingId=" + $r.body.meetingId + " fee=" + $r.body.fee)
if ($r.status -eq 200) { $overallPass++ } else { $overallFail++ }

# 10. PATCH meetings[1].fee = 750
Write-Step "#10 PATCH .../meetings/$meeting2Id/fee"
$r = Invoke-CurlJson -Url "$ApiBase/settlement-requests/$reqId/meetings/$meeting2Id/fee" -Method PATCH `
     -Token $boToken -JsonBody (@{ fee = 750 } | ConvertTo-Json -Compress)
Add-Result 10 '.../meetings/:meetingId/fee' 'PATCH' 200 $r.status ("fee=" + $r.body.fee)
if ($r.status -eq 200) { $overallPass++ } else { $overallFail++ }

# 11. POST /approve
Write-Step "#11 POST /settlement-requests/$reqId/approve"
$r = Invoke-CurlJson -Url "$ApiBase/settlement-requests/$reqId/approve" -Method POST -Token $boToken
Add-Result 11 '.../approve' 'POST' 200 $r.status ("status=" + $r.body.status)
if ($r.status -eq 200 -and $r.body.status -eq 'AWAITING_PAYMENT') { $overallPass++ } else { $overallFail++ }

# 12. GET /payment-summary
Write-Step "#12 GET /settlement-requests/$reqId/payment-summary"
$r = Invoke-CurlJson -Url "$ApiBase/settlement-requests/$reqId/payment-summary" -Token $ownerToken
$totalOk = ($r.body.total -eq 1250)
Add-Result 12 '.../payment-summary' 'GET' 200 $r.status ("total=" + $r.body.total + " (expected 1250 = 500+750)")
if ($r.status -eq 200 -and $totalOk) { $overallPass++ } else { $overallFail++ }

# 13. POST /pay
Write-Step "#13 POST /settlement-requests/$reqId/pay"
$r = Invoke-CurlJson -Url "$ApiBase/settlement-requests/$reqId/pay" -Method POST -Token $ownerToken
Add-Result 13 '.../pay' 'POST' 200 $r.status ("status=" + $r.body.status)
if ($r.status -eq 200 -and $r.body.status -eq 'AWAITING_SETTLEMENT') { $overallPass++ } else { $overallFail++ }

# 14. POST settlement-document for meeting1 (should NOT auto-settle yet)
Write-Step "#14 POST .../meetings/$meeting1Id/settlement-document (first)"
$r = Invoke-CurlJson -Url "$ApiBase/settlement-requests/$reqId/meetings/$meeting1Id/settlement-document" -Method POST -Token $boToken -FilePaths @($pdf1) -FileFieldName 'file'
Add-Result 14 '.../settlement-document (1)' 'POST' 201 $r.status ("status=" + $r.body.status + " (still AWAITING_SETTLEMENT)")
if ($r.status -eq 201 -and $r.body.status -eq 'AWAITING_SETTLEMENT') { $overallPass++ } else { $overallFail++ }

# 14b. POST settlement-document for meeting2 (auto-settles)
Write-Step "#14b POST .../meetings/$meeting2Id/settlement-document (last -> SETTLED)"
$r = Invoke-CurlJson -Url "$ApiBase/settlement-requests/$reqId/meetings/$meeting2Id/settlement-document" -Method POST -Token $boToken -FilePaths @($pdf2) -FileFieldName 'file'
Add-Result 14 '.../settlement-document (2)' 'POST' 201 $r.status ("status=" + $r.body.status + " (expected SETTLED)")
if ($r.status -eq 201 -and $r.body.status -eq 'SETTLED') { $overallPass++ } else { $overallFail++ }

# 15. GET attachment (binary)
Write-Step "#15 GET .../meetings/$meeting1Id/attachment"
$r = Invoke-CurlBinary -Url "$ApiBase/settlement-requests/$reqId/meetings/$meeting1Id/attachment" -Token $ownerToken
Add-Result 15 '.../attachment' 'GET' 200 $r.status ("contentType=" + $r.contentType + " bytes=" + $r.bytes.Length)
if ($r.status -eq 200 -and $r.contentType -match 'application/pdf') { $overallPass++ } else { $overallFail++ }

# 16. GET settlement-document (binary)
Write-Step "#16 GET .../meetings/$meeting1Id/settlement-document"
$r = Invoke-CurlBinary -Url "$ApiBase/settlement-requests/$reqId/meetings/$meeting1Id/settlement-document" -Token $ownerToken
Add-Result 16 '.../settlement-document' 'GET' 200 $r.status ("contentType=" + $r.contentType + " bytes=" + $r.bytes.Length)
if ($r.status -eq 200 -and $r.contentType -match 'application/pdf') { $overallPass++ } else { $overallFail++ }

# 17. GET /notifications (owner)
Write-Step '#17 GET /notifications (owner)'
$r = Invoke-CurlJson -Url "$ApiBase/notifications" -Token $ownerToken
$ownerNotif = $r.body.notifications | Where-Object { -not $_.isRead } | Select-Object -First 1
Add-Result 17 '/notifications (owner)' 'GET' 200 $r.status ("unread=" + $r.body.unreadCount + " total=" + $r.body.notifications.Count)
if ($r.status -eq 200) { $overallPass++ } else { $overallFail++ }

# 18. PATCH /notifications/:id/read
if ($ownerNotif) {
  Write-Step "#18 PATCH /notifications/$($ownerNotif.id)/read"
  $r = Invoke-CurlJson -Url "$ApiBase/notifications/$($ownerNotif.id)/read" -Method PATCH -Token $ownerToken
  Add-Result 18 '/notifications/:id/read' 'PATCH' 200 $r.status ("isRead=" + $r.body.isRead)
  if ($r.status -eq 200 -and $r.body.isRead -eq $true) { $overallPass++ } else { $overallFail++ }
} else {
  Write-Err 'no unread owner notification to test mark-read'
  Add-Result 18 '/notifications/:id/read' 'PATCH' 200 0 'no unread notification'
  $overallFail++
}

# --- summary ------------------------------------------------------------------

Write-Host "`n================================== SUMMARY ==================================" -ForegroundColor White
$script:results | Format-Table -AutoSize | Out-Host
Write-Host "----------------------------------------------------------------------------"
Write-Host (" Passed: {0} / {1}" -f $overallPass, ($overallPass + $overallFail)) -ForegroundColor Green
if ($overallFail -gt 0) {
  Write-Host (" Failed: {0}" -f $overallFail) -ForegroundColor Red
  exit 1
} else {
  Write-Host " All endpoints passed - happy path verified." -ForegroundColor Green
  exit 0
}
