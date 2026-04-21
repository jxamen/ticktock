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
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""

Write-Host "Building signed release..." -ForegroundColor Cyan
Push-Location (Split-Path -Parent $PSScriptRoot)
try {
    npm run tauri:build
} finally {
    Pop-Location
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
}

Write-Host "`nArtifacts:" -ForegroundColor Green
Get-ChildItem (Join-Path $PSScriptRoot "..\src-tauri\target\release\bundle\nsis") -File | ForEach-Object { "  $($_.FullName)" }
