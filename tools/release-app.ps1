# Builds a signed release of the app and publishes it on GitHub with the update feed that
# installed copies read (app/lib/core/updater.dart). Every installed copy then offers the update by itself.
#
# Each release also carries the same APK under one fixed name (the product's name, such as tuition-tests.apk), so this
# link never changes and always gives the newest version (GitHub's "latest" release). The website's download button uses it:
#   https://github.com/<owner>/<repo>/releases/latest/download/<name>.apk
#
#   .\tools\release-app.ps1 -Notes notes.txt -Repo owner/name -ApiBase https://...              # build, then publish v<version>
#   .\tools\release-app.ps1 -Notes notes.txt -Repo owner/name -ApiBase https://... -NoPublish   # build and write the files only
#
# -Repo is the startup's GitHub repository and -ApiBase its live API: the build is told both, and has no other server.
# Raise `version:` in app/pubspec.yaml first; the number after + must go up every release.
# The notes file is plain text: the GitHub release shows it, and so does the app's
# "What is new" card (with ** marks removed).
param(
  [Parameter(Mandatory = $true)][string]$Notes,
  [Parameter(Mandatory = $true)][string]$Repo,
  [Parameter(Mandatory = $true)][string]$ApiBase,
  [switch]$NoPublish
)
$ErrorActionPreference = 'Stop'

# Flutter and gh print warnings and progress on stderr, which PowerShell turns into a fatal
# error under 'Stop' whenever the output is captured; judge them by their exit code instead.
function Invoke-Native([string]$What, [scriptblock]$Run) {
  $ErrorActionPreference = 'Continue'
  & $Run
  if ($LASTEXITCODE -ne 0) { throw "$What failed (exit code $LASTEXITCODE)" }
}

if ($Repo -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw "-Repo is owner/name, such as acme/tuition-app" }
if ($ApiBase -notmatch '^https://[^/\s]+$') { throw "-ApiBase is the live API's address, https://host with no path" }

$root = Split-Path $PSScriptRoot -Parent
$brand = Get-Content (Join-Path $root 'app\lib\core\brand.dart') -Raw
# No release under the stand-in name: the product's name is chosen first (tools/rename-product.mjs removes the marker).
if ($brand -match '(?m)^/// STAND-IN:') {
  throw 'The product has no name yet (app/lib/core/brand.dart still says STAND-IN). Choose it with tools/rename-product.mjs first.'
}
$name = [regex]::Match($brand, "const appName = '([^']+)';").Groups[1].Value
$appId = [regex]::Match($brand, "const androidAppId = '([^']+)';").Groups[1].Value
# Nor with the stand-in's app ids under a real name: an id can never change once phones have the app.
if ($appId.StartsWith('com.tuitiontests.') -and $name -ne 'Tuition Tests') {
  throw "The app ids are still the stand-in's ($appId). Set androidAppId and adminAndroidAppId in app/lib/core/brand.dart for $name first: they can never change after this."
}
# The APK's file name: the product's name in small letters, such as tuition-tests.apk.
$slug = ($name.ToLower() -replace '[^a-z0-9]+', '-').Trim('-')
if (-not $slug) { $slug = 'app' }

$line = (Get-Content (Join-Path $root 'app\pubspec.yaml')) -match '^version:\s*' | Select-Object -First 1
if ($line -notmatch '^version:\s*(\d+\.\d+\.\d+)\+(\d+)\s*$') { throw "No version like 1.2.0+3 in pubspec.yaml" }
$version = $Matches[1]
$build = [int]$Matches[2]
$tag = "v$version"
$text = (Get-Content -Raw -Encoding utf8 (Resolve-Path $Notes)).Trim()
$feedUrl = "https://github.com/$Repo/releases/latest/download/update.json"

# Needs app/android/key.properties and the keystore it names. ARM only: that is every phone.
Push-Location (Join-Path $root 'app')
try {
  Invoke-Native 'flutter build' {
    & C:\src\flutter\bin\flutter.bat build apk --release --target-platform android-arm,android-arm64 "--dart-define=API_BASE=$ApiBase" "--dart-define=UPDATE_FEED=$feedUrl"
  }
} finally { Pop-Location }

$out = Join-Path $root 'tools\out'
New-Item -ItemType Directory -Force $out | Out-Null
$apk = Join-Path $out "$slug-$version.apk"
Copy-Item (Join-Path $root 'app\build\app\outputs\flutter-apk\app-release.apk') $apk -Force

# The same file under a name with no version in it: the one link to send to anyone.
$fixed = Join-Path $out "$slug.apk"
Copy-Item $apk $fixed -Force

$feed = [ordered]@{
  version = $version
  build   = $build
  apk     = "https://github.com/$Repo/releases/download/$tag/$slug-$version.apk"
  sha256  = (Get-FileHash $apk -Algorithm SHA256).Hash.ToLower()
  size    = (Get-Item $apk).Length
  notes   = $text -replace '\*\*', ''
}
$json = Join-Path $out 'update.json'
# UTF-8 without a byte-order mark, which the app's JSON reader expects.
[IO.File]::WriteAllText($json, ($feed | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
"$apk"
"$json  (build $build, $($feed.size) bytes, sha256 $($feed.sha256))"

if ($NoPublish) { return }
$notesFile = Join-Path $out "notes-$version.md"
[IO.File]::WriteAllText($notesFile, $text, (New-Object Text.UTF8Encoding $false))
Invoke-Native 'gh release create' { gh release create $tag $apk $fixed $json --repo $Repo --title "$name $version" --notes-file $notesFile }
# The feed every installed copy reads; it should now name this version.
$r = Invoke-WebRequest $feedUrl -UseBasicParsing
if ($r.Content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($r.Content) } else { $r.Content }
# The one link: it must answer, and it must be the file just published.
$link = "https://github.com/$Repo/releases/latest/download/$slug.apk"
$head = Invoke-WebRequest $link -Method Head -UseBasicParsing
"$link  ->  HTTP $($head.StatusCode), $($head.Headers['Content-Length']) bytes (this build: $($feed.size))"
