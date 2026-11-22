# Screenshots admin-app mockups side by side (two phones per image) with headless Chrome.
# Needs the comp server on 127.0.0.1:8777:  py -3 -m http.server 8777 --directory design/comps
#   .\tools\shoot-admin-comps.ps1 -Pairs 'admin-a-overview,admin-b-overview'
param([string[]]$Pairs = @('admin-a-overview,admin-a-people'))

$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$out = Join-Path $PSScriptRoot '..\design\screenshots'
New-Item -ItemType Directory -Force $out | Out-Null
$profileDir = Join-Path $env:TEMP 'ca-shoot-profile'

foreach ($pair in $Pairs) {
  $l, $r = $pair.Split(',')
  $name = if ($r) { "$l+$r" } else { $l }
  $file = Join-Path (Resolve-Path $out) "$name.png"
  $url = "http://127.0.0.1:8777/admin-board.html?l=$l" + $(if ($r) { "&r=$r" } else { '' })
  & $chrome --headless=new --disable-gpu --hide-scrollbars --no-first-run --no-default-browser-check `
    --user-data-dir="$profileDir" --force-device-scale-factor=2 --window-size=898,894 `
    --virtual-time-budget=8000 --screenshot="$file" $url 2>$null | Out-Null
  if (Test-Path $file) { "{0,-44} {1:N0} bytes" -f "$name.png", (Get-Item $file).Length } else { "$name.png  FAILED" }
}
