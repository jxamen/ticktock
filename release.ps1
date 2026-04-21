# One-shot release pipeline.
#
# Usage:
#   ./release.ps1                          # patch bump (0.1.2 → 0.1.3)
#   ./release.ps1 -Notes "버그 수정"       # patch bump + custom release notes
#   ./release.ps1 -Version 0.2.0 -Notes "..."   # explicit version
#
# Does everything in order:
#   1. Read current version from tauri.conf.json
#   2. Bump version in tauri.conf.json + Cargo.toml
#   3. Build + sign NSIS installer (agent/scripts/sign-and-build.ps1)
#   4. Generate latest.json with the freshly-computed .sig
#   5. `gh release create` — upload setup.exe + .sig + latest.json
#
# Prerequisites (one-time):
#   - Signing key at %USERPROFILE%\.ticktock\signing.key
#   - `gh auth login` completed
#   - GitHub repo 'jxamen/ticktock' (public — required for unauthenticated
#     updater downloads)

param(
    [string]$Version,
    [string]$Notes
)

$ErrorActionPreference = "Stop"

$repoRoot = $PSScriptRoot
$confPath = Join-Path $repoRoot "agent\src-tauri\tauri.conf.json"
$cargoPath = Join-Path $repoRoot "agent\src-tauri\Cargo.toml"
$latestPath = Join-Path $repoRoot "latest.json"
$bundleDir = Join-Path $repoRoot "agent\src-tauri\target\release\bundle\nsis"

# Prefer the gh CLI in its default install location; fall back to PATH.
$gh = "C:\Program Files\GitHub CLI\gh.exe"
if (-not (Test-Path $gh)) { $gh = "gh" }

# ---------- 1) version ----------

$confRaw = Get-Content $confPath -Raw
# Read current version by regex (avoids ConvertFrom/ConvertTo-Json reformatting
# the whole file, which PowerShell 5.1 would also BOM-corrupt).
$m = [regex]::Match($confRaw, '"version"\s*:\s*"([0-9\.]+)"')
if (-not $m.Success) { throw "could not find version in tauri.conf.json" }
$currentVer = $m.Groups[1].Value

if (-not $Version) {
    $parts = $currentVer -split '\.'
    if ($parts.Count -ne 3) { throw "unexpected version format '$currentVer'" }
    $parts[2] = [int]$parts[2] + 1
    $Version = $parts -join '.'
}

if (-not $Notes) { $Notes = "v$Version 업데이트" }

Write-Host "`n== Release v$currentVer -> v$Version ==" -ForegroundColor Cyan
Write-Host "Notes: $Notes" -ForegroundColor Gray

# ---------- 2) bump files ----------

# Helper: write UTF-8 without BOM (tauri-build can't parse UTF-8-BOM JSON).
function Write-UTF8NoBom([string]$path, [string]$content) {
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($path, $content, $utf8NoBom)
}

$confNew = [regex]::Replace($confRaw, '"version"\s*:\s*"[0-9\.]+"', "`"version`": `"$Version`"", 1)
Write-UTF8NoBom $confPath $confNew

$cargo = Get-Content $cargoPath -Raw
$cargo = [regex]::Replace($cargo, '(?m)^version = "[0-9\.]+"', "version = `"$Version`"")
Write-UTF8NoBom $cargoPath $cargo

Write-Host "✓ bumped tauri.conf.json + Cargo.toml" -ForegroundColor Green

# ---------- 3) build + sign ----------

Write-Host "`n== Building (this can take 1-2 min) ==" -ForegroundColor Cyan
& (Join-Path $repoRoot "agent\scripts\sign-and-build.ps1")

$exe = Join-Path $bundleDir "TickTock_${Version}_x64-setup.exe"
$sig = Join-Path $bundleDir "TickTock_${Version}_x64-setup.exe.sig"
if (-not (Test-Path $exe)) { throw "build artifact missing: $exe" }
if (-not (Test-Path $sig)) { throw "signature missing: $sig" }

$sigContent = (Get-Content $sig -Raw).Trim()

# ---------- 4) latest.json ----------

$pubDate = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$latest = [ordered]@{
    version   = $Version
    notes     = $Notes
    pub_date  = $pubDate
    platforms = [ordered]@{
        "windows-x86_64" = [ordered]@{
            signature = $sigContent
            url       = "https://github.com/jxamen/ticktock/releases/download/v$Version/TickTock_${Version}_x64-setup.exe"
        }
    }
}
$latestJson = $latest | ConvertTo-Json -Depth 10
Write-UTF8NoBom $latestPath $latestJson
Write-Host "✓ wrote latest.json" -ForegroundColor Green

# ---------- 5) github release ----------

Write-Host "`n== Uploading GitHub release ==" -ForegroundColor Cyan
& $gh release create "v$Version" `
    --title "v$Version" `
    --notes $Notes `
    $exe $sig $latestPath

if ($LASTEXITCODE -ne 0) {
    throw "gh release create failed with exit code $LASTEXITCODE"
}

Write-Host "`n✓ Released v$Version" -ForegroundColor Green
Write-Host "  https://github.com/jxamen/ticktock/releases/tag/v$Version" -ForegroundColor Gray
Write-Host "`n자녀 PC는 부팅 후 60초 내 (또는 6시간 주기로) 자동 다운로드합니다." -ForegroundColor Gray
