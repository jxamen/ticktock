# Build + sign a release NSIS bundle for auto-update distribution.
#
# Requires:
#   - Private signing key at $HOME\.ticktock\signing.key (generated once via
#     `npx tauri signer generate --ci --password "" -w ...`)
#
# Output (after run):
#   src-tauri/target/release/bundle/nsis/
#     TickTock_<version>_x64-setup.exe
#     TickTock_<version>_x64-setup.exe.sig
#
# The .sig file + installer go into a GitHub Release along with latest.json
# (see docs/auto-update.md).

$ErrorActionPreference = "Stop"

$keyPath = Join-Path $HOME ".ticktock\signing.key"
if (-not (Test-Path $keyPath)) {
    Write-Error "Signing key not found at $keyPath. Generate it with:`n  npx tauri signer generate --ci --password `"`" -w `"$keyPath`""
}

$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $keyPath -Raw
# PowerShell's `$env:X = ""` removes the variable, so set it explicitly so
# the Tauri CLI sees an empty string instead of prompting.
[System.Environment]::SetEnvironmentVariable("TAURI_SIGNING_PRIVATE_KEY_PASSWORD", "", "Process")

Write-Host "Building signed release..." -ForegroundColor Cyan
Push-Location (Split-Path -Parent $PSScriptRoot)
try {
    npm run tauri:build
} finally {
    Pop-Location
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
}

$bundleDir = Join-Path $PSScriptRoot "..\src-tauri\target\release\bundle\nsis"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")

# Read version from tauri.conf.json so the release folder matches the binary.
$conf = Get-Content (Join-Path $PSScriptRoot "..\src-tauri\tauri.conf.json") -Raw | ConvertFrom-Json
$version = $conf.version

$destDir = Join-Path $repoRoot "releases\v$version"
New-Item -ItemType Directory -Path $destDir -Force | Out-Null

$exe = Join-Path $bundleDir "TickTock_${version}_x64-setup.exe"
$sig = Join-Path $bundleDir "TickTock_${version}_x64-setup.exe.sig"
Copy-Item $exe $destDir -Force
Copy-Item $sig $destDir -Force

Write-Host "`nArtifacts copied to:" -ForegroundColor Green
Get-ChildItem $destDir | ForEach-Object { "  $($_.FullName)" }
