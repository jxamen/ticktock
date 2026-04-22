# One-shot release pipeline.
#
# Usage:
#   ./release.ps1                                # patch bump (0.1.7 → 0.1.8)
#   ./release.ps1 -Notes "버그 수정"             # patch bump + custom release notes
#   ./release.ps1 -Version 0.2.0 -Notes "..."    # explicit version
#   ./release.ps1 -SkipBump                      # keep current version (already bumped)
#   ./release.ps1 -SkipBuild                     # reuse existing NSIS artifacts
#   ./release.ps1 -Version 0.1.7 -SkipBump -SkipBuild   # just re-upload
#
# Does everything in order:
#   1. Read current version from tauri.conf.json
#   2. Bump version in tauri.conf.json + Cargo.toml (unless -SkipBump)
#   3. Build + sign NSIS installer (unless -SkipBuild and artifacts already exist)
#   4. Generate latest.json with the freshly-computed .sig
#   5. gh release create — upload setup.exe + .sig + latest.json
#
# Prerequisites (one-time):
#   - Signing key at %USERPROFILE%\.ticktock\signing.key
#   - `gh auth login` completed, remains valid
#   - GitHub repo 'jxamen/ticktock' (public — required for unauthenticated
#     updater downloads)

param(
    [string]$Version,
    [string]$Notes,
    [switch]$SkipBump,
    [switch]$SkipBuild,
    [switch]$NoSign
)

$ErrorActionPreference = "Stop"

# Stamped log so it's obvious which step is blocking if the pipeline stalls.
function Log([string]$msg, [string]$color = "Gray") {
    $ts = (Get-Date).ToString("HH:mm:ss")
    Write-Host "[$ts] $msg" -ForegroundColor $color
}

$repoRoot = $PSScriptRoot
$confPath = Join-Path $repoRoot "agent\src-tauri\tauri.conf.json"
$cargoPath = Join-Path $repoRoot "agent\src-tauri\Cargo.toml"
$latestPath = Join-Path $repoRoot "latest.json"
$bundleDir = Join-Path $repoRoot "agent\src-tauri\target\release\bundle\nsis"
$ghRepo = "jxamen/ticktock"

# Prefer the gh CLI in its default install location; fall back to PATH.
$gh = "C:\Program Files\GitHub CLI\gh.exe"
if (-not (Test-Path $gh)) { $gh = "gh" }

# ---------- 0) gh auth pre-check ----------
# Catching an expired token here is much nicer than watching the release
# step hang on an interactive login prompt.

Log "Checking gh auth status..." "Cyan"
& $gh auth status 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "gh CLI is not authenticated. Run: gh auth login"
}
Log "✓ gh auth OK" "Green"

# ---------- 1) version ----------

$confRaw = Get-Content $confPath -Raw
# Read current version by regex (avoids ConvertFrom/ConvertTo-Json reformatting
# the whole file, which PowerShell 5.1 would also BOM-corrupt).
$m = [regex]::Match($confRaw, '"version"\s*:\s*"([0-9\.]+)"')
if (-not $m.Success) { throw "could not find version in tauri.conf.json" }
$currentVer = $m.Groups[1].Value

if (-not $Version) {
    if ($SkipBump) {
        $Version = $currentVer
    } else {
        $parts = $currentVer -split '\.'
        if ($parts.Count -ne 3) { throw "unexpected version format '$currentVer'" }
        $parts[2] = [int]$parts[2] + 1
        $Version = $parts -join '.'
    }
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

if ($SkipBump -or $currentVer -eq $Version) {
    Log "Skipping version bump (already at $Version)" "Yellow"
} else {
    $confNew = [regex]::Replace($confRaw, '"version"\s*:\s*"[0-9\.]+"', "`"version`": `"$Version`"", 1)
    Write-UTF8NoBom $confPath $confNew

    $cargo = Get-Content $cargoPath -Raw
    $cargo = [regex]::Replace($cargo, '(?m)^version = "[0-9\.]+"', "version = `"$Version`"")
    Write-UTF8NoBom $cargoPath $cargo

    Log "✓ bumped tauri.conf.json + Cargo.toml" "Green"
}

# ---------- 3) build + sign ----------

$exe = Join-Path $bundleDir "TickTock_${Version}_x64-setup.exe"
$sig = Join-Path $bundleDir "TickTock_${Version}_x64-setup.exe.sig"

$needSig = -not $NoSign
$haveArtifacts = (Test-Path $exe) -and ((-not $needSig) -or (Test-Path $sig))
if ($SkipBuild -and $haveArtifacts) {
    Log "Skipping build (artifacts already at $bundleDir)" "Yellow"
} elseif ($SkipBuild -and -not $haveArtifacts) {
    throw "-SkipBuild specified but artifacts missing: $exe"
} else {
    Log "Building (can take 1-2 min)..." "Cyan"
    if ($NoSign) {
        & (Join-Path $repoRoot "agent\scripts\sign-and-build.ps1") -NoSign
    } else {
        & (Join-Path $repoRoot "agent\scripts\sign-and-build.ps1")
    }
    if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne $null) {
        throw "build script returned exit code $LASTEXITCODE"
    }
    if (-not (Test-Path $exe)) { throw "build artifact missing: $exe" }
    if ($needSig -and -not (Test-Path $sig)) { throw "signature missing: $sig" }
    Log "✓ build complete" "Green"
}

$sigContent = if ($needSig) { (Get-Content $sig -Raw).Trim() } else { "" }

# ---------- 4) latest.json ----------

$pubDate = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$latest = [ordered]@{
    version   = $Version
    notes     = $Notes
    pub_date  = $pubDate
    platforms = [ordered]@{
        "windows-x86_64" = [ordered]@{
            signature = $sigContent
            url       = "https://github.com/$ghRepo/releases/download/v$Version/TickTock_${Version}_x64-setup.exe"
        }
    }
}
$latestJson = $latest | ConvertTo-Json -Depth 10
Write-UTF8NoBom $latestPath $latestJson
Log "✓ wrote latest.json" "Green"

# ---------- 5) github release ----------

Log "Checking for existing release v$Version..." "Cyan"
& $gh release view "v$Version" --repo $ghRepo 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) {
    Log "Release v$Version already exists — deleting it so we can re-create" "Yellow"
    # --yes skips the "are you sure" prompt; --cleanup-tag removes the git tag too.
    & $gh release delete "v$Version" --repo $ghRepo --yes --cleanup-tag 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "failed to delete existing release v$Version"
    }
}

Log "Uploading GitHub release v$Version..." "Cyan"
# --repo is explicit so we don't depend on the working-directory git remote.
# Positional args at the end are the files to attach.
$attachments = @($exe, $latestPath)
if ($needSig) { $attachments += $sig }

& $gh release create "v$Version" `
    --repo $ghRepo `
    --title "v$Version" `
    --notes $Notes `
    @attachments

if ($LASTEXITCODE -ne 0) {
    throw "gh release create failed with exit code $LASTEXITCODE"
}

Write-Host "`n✓ Released v$Version" -ForegroundColor Green
Write-Host "  https://github.com/$ghRepo/releases/tag/v$Version" -ForegroundColor Gray
Write-Host "`n자녀 PC는 부팅 후 60초 내 (또는 6시간 주기로) 자동 다운로드합니다." -ForegroundColor Gray
