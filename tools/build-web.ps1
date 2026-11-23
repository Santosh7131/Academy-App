# Builds the web app, the Android app's own code run in a browser, into app/build/web: a folder of plain files that any static host
# can serve as they are. README.md "Web app" says what the host, the API and the file store need.
#
#   .\tools\build-web.ps1 -ApiBase https://api.example.com          # for the live API; pins pdf.js with an integrity hash
#   .\tools\build-web.ps1 -ApiBase https://api.example.com -BaseHref /app/   # served from a folder of a site, not its root
#   .\tools\build-web.ps1 -ApiBase http://127.0.0.1:18787 -Local    # to try against the local API (then node tools/serve-web.mjs)
#
# The API lets a browser in only from the addresses in its CORS_ORIGINS setting, and the file store only from those in its
# bucket's CORS rules. Set both to the web app's address before anyone opens it, or every request is refused.
param(
  [Parameter(Mandatory = $true)][string]$ApiBase,
  [string]$BaseHref = '/',
  [switch]$Local
)
$ErrorActionPreference = 'Stop'

# Flutter prints warnings and progress on stderr, which PowerShell turns into a fatal error under 'Stop' whenever the output is
# captured; judge it by its exit code instead.
function Invoke-Native([string]$What, [scriptblock]$Run) {
  $ErrorActionPreference = 'Continue'
  & $Run
  if ($LASTEXITCODE -ne 0) { throw "$What failed (exit code $LASTEXITCODE)" }
}

$root = Split-Path $PSScriptRoot -Parent
if ($Local) {
  if ($ApiBase -notmatch '^http://(127\.0\.0\.1|localhost):\d+$') { throw '-Local builds talk to this computer only, such as -ApiBase http://127.0.0.1:18787' }
} else {
  if ($ApiBase -notmatch '^https://[^/\s]+$') { throw "-ApiBase is the live API's address, https://host with no path" }
  # As with the Android app: nothing goes out under the stand-in name (tools/rename-product.mjs chooses the name).
  $brand = Get-Content (Join-Path $root 'app\lib\core\brand.dart') -Raw
  if ($brand -match '(?m)^/// STAND-IN:') {
    throw 'The product has no name yet (app/lib/core/brand.dart still says STAND-IN). Choose it with tools/rename-product.mjs first.'
  }
}
if ($BaseHref -notmatch '^/([^/\s]+/)*$') { throw '-BaseHref starts and ends with /, such as / or /app/' }

Push-Location (Join-Path $root 'app')
try {
  # --no-web-resources-cdn: the browser's drawing engine (CanvasKit) comes from the app's own host, not from Google's CDN.
  Invoke-Native 'flutter build web' {
    & C:\src\flutter\bin\flutter.bat build web --release --no-web-resources-cdn "--base-href=$BaseHref" "--dart-define=API_BASE=$ApiBase"
  }
} finally { Pop-Location }

$index = Join-Path $root 'app\build\web\index.html'
if (-not $Local) {
  Invoke-Native 'pinning pdf.js' { node (Join-Path $PSScriptRoot 'web-sri.mjs') $index }
}
Write-Host "Built app/build/web for $ApiBase. Upload everything in it to the host."
