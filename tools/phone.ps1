# Helpers for building, installing and screenshotting the app on the test phone over adb.
# Usage examples:
#   .\tools\phone.ps1 build [-ApiBase <url>]   # test build (the Dev copy), arm64, and install. Without -ApiBase it looks for
#                                              # http://10.0.2.2:18787, which only an emulator reaches; on a phone, run
#                                              # adb reverse tcp:18787 tcp:18787 and pass -ApiBase http://127.0.0.1:18787
#   .\tools\phone.ps1 release -ApiBase <url>   # signed release build for the server at that address, and install
#   .\tools\phone.ps1 launch [-Live]        # -Live drives the live app instead of the test build
#   .\tools\phone.ps1 shot login-light      # saves design/screenshots/app/login-light.png
#   .\tools\phone.ps1 tap 210 600           # in dp (density 3 on the A024)
#   .\tools\phone.ps1 text "harini.v"
param([Parameter(Position = 0)][string]$Cmd, [Parameter(Position = 1)][string]$A, [Parameter(Position = 2)][string]$B, [string]$ApiBase, [switch]$Live)

$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:USERPROFILE 'Android\Sdk' }
$adb = Join-Path $sdk 'platform-tools\adb.exe'
# The phone to drive: PHONE_SERIAL, or else the only phone adb can see.
$serial = $env:PHONE_SERIAL
if (-not $serial) {
  $phones = @(& $adb devices | Select-String -Pattern '^(\S+)\s+device$' | ForEach-Object { $_.Matches[0].Groups[1].Value })
  # The same phone shows up twice when it is on USB and wireless debugging at once; USB wins.
  $usb = @($phones | Where-Object { $_ -notmatch ':|_adb-tls' })
  if ($usb.Count -eq 1) { $phones = $usb }
  if ($phones.Count -ne 1) { "Connect one phone or set PHONE_SERIAL (adb sees $($phones.Count))"; exit 2 }
  $serial = $phones[0]
}
$root = Split-Path $PSScriptRoot -Parent
# The app's id, set beside the product's name in app/lib/core/brand.dart.
$appId = [regex]::Match((Get-Content (Join-Path $root 'app\lib\core\brand.dart') -Raw), "const androidAppId = '([^']+)';").Groups[1].Value
if (-not $appId) { 'No androidAppId in app/lib/core/brand.dart'; exit 2 }
$idPattern = [regex]::Escape($appId)
$pkg = if ($Live) { $appId } else { "$appId.dev" }
$activity = 'com.tuitionapp.main.MainActivity'
$scale = 3.0

function Adb { & $adb -s $serial @args }
# A call stops everything. Phone calls show in the call state; WhatsApp and other app calls only put the
# audio in communication mode, so look for both.
$callState = (& $adb -s $serial shell dumpsys telephony.registry | Select-String 'mCallState=' | Select-Object -First 1)
$audioMode = (& $adb -s $serial shell dumpsys audio | Select-String 'Actual mode = ' | Select-Object -First 1)
if (("$callState" -and "$callState" -notmatch 'mCallState=0') -or ("$audioMode" -match 'MODE_IN_(COMMUNICATION|CALL)')) { "STOP: the phone is on a call, so nothing was sent"; exit 1 }


# Input and screenshots only ever touch this app (live or test build): the phone is the developer's
# own, so refuse when another app is in front.
function Test-Ours {
  $top = Adb shell dumpsys activity activities | Select-String -Pattern 'topResumedActivity' | Select-Object -First 1
  if ("$top" -notmatch "$idPattern(\.dev)?/") { return $false }
  # The notification shade and quick settings sit over an app without changing the resumed activity, and
  # a capture then shows the owner's Wi-Fi, earbuds and notifications. The window that has focus says
  # whether it is still the app: only its package name is read from the dump.
  Adb shell uiautomator dump /sdcard/ca-guard.xml 2>$null | Out-Null
  $xml = (Adb shell cat /sdcard/ca-guard.xml 2>$null) -join ''
  Adb shell rm /sdcard/ca-guard.xml 2>$null | Out-Null
  $pkg = [regex]::Match($xml, 'package="([^"]+)"').Groups[1].Value
  return $pkg -match "^$idPattern(\.dev)?$"
}
function Assert-Ours { if (-not (Test-Ours)) { "REFUSED: the app is not in front"; exit 2 } }
if ($Cmd -in @('tap', 'swipe', 'text', 'key', 'back', 'shot')) { Assert-Ours }

switch ($Cmd) {
  'build' {
    Push-Location (Join-Path $root 'app')
    try {
      $defines = @()
      if ($ApiBase) { $defines = @("--dart-define=API_BASE=$ApiBase") }
      & C:\src\flutter\bin\flutter.bat build apk --debug --target-platform android-arm64 @defines 2>&1 | Select-Object -Last 3
      Adb install -r 'build\app\outputs\flutter-apk\app-debug.apk'
    } finally { Pop-Location }
  }
  'release' {
    # Needs app/android/key.properties and the keystore it names. ARM only: that is every phone.
    # A release build knows only the server it is built with; without one it would open on "no server".
    if (-not $ApiBase) { throw 'Give the server address: .\tools\phone.ps1 release -ApiBase https://...' }
    Push-Location (Join-Path $root 'app')
    try {
      & C:\src\flutter\bin\flutter.bat build apk --release --target-platform android-arm,android-arm64 "--dart-define=API_BASE=$ApiBase" 2>&1 | Select-Object -Last 3
      Adb install -r 'build\app\outputs\flutter-apk\app-release.apk'
    } finally { Pop-Location }
  }
  'launch' { Adb shell am force-stop $pkg; Adb shell am start -n "$pkg/$activity" | Out-Null; 'launched' }
  'stop' { Adb shell am force-stop $pkg }
  'clear' { Adb shell pm clear $pkg }
  'shot' {
    $dir = Join-Path $root 'design\screenshots\app'
    New-Item -ItemType Directory -Force $dir | Out-Null
    $file = Join-Path $dir "$A.png"
    Adb shell screencap -p /sdcard/ca-shot.png
    # Another app may have come to the front during the capture: then the picture is not ours to keep.
    if (-not (Test-Ours)) { Adb shell rm /sdcard/ca-shot.png; "DISCARDED: another app came to the front"; exit 2 }
    Adb pull /sdcard/ca-shot.png $file | Out-Null
    Adb shell rm /sdcard/ca-shot.png
    $file
  }
  'tap' { Adb shell input tap ([int]([double]$A * $scale)) ([int]([double]$B * $scale)) }
  'swipe' { $p = $A.Split(','); Adb shell input swipe ([int]([double]$p[0] * $scale)) ([int]([double]$p[1] * $scale)) ([int]([double]$p[2] * $scale)) ([int]([double]$p[3] * $scale)) 200 }
  'text' { Adb shell input text ($A -replace ' ', '%s') }
  'key' { Adb shell input keyevent $A }
  'back' { Adb shell input keyevent 4 }
  default { 'commands: build, release, launch, stop, clear, shot <name>, tap <x> <y>, swipe x1,y1,x2,y2, text <s>, key <code>, back (-Live: the live app)' }
}
