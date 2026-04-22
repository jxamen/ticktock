# Build + sign a release NSIS bundle for auto-update distribution.
#
# Requires (one-time setup):
#   - Private signing key at %USERPROFILE%\.ticktock\signing.key
#     (generated via `npx tauri signer generate -w "$keyPath"`)
#   - Signing-key password stored as a User-scope env var so the Tauri CLI
#     doesn't hang on stdin waiting for it. Set it once from PowerShell:
#
#       [Environment]::SetEnvironmentVariable(
#           "TAURI_SIGNING_PRIVATE_KEY_PASSWORD", "<비밀번호>", "User")
#
#     Unset `-Scope User` means the whole login-user sees it; any new shell
#     will inherit it. If the key was generated with no password, set the
#     env var to a single space character (Windows can't persist an empty
#     env var) — minisign/rsign accepts that.
#
#   - Optional: -NoSign to build the installer without generating a .sig.
#     Produces a working NSIS installer you can hand-install, but OTA
#     updates (which verify .sig) won't work.
#
# Output:
#   releases\v<version>\
#     TickTock_<version>_x64-setup.exe
#     TickTock_<version>_x64-setup.exe.sig  (unless -NoSign)

param(
    [switch]$NoSign
)

$ErrorActionPreference = "Stop"

function Log([string]$msg, [string]$color = "Gray") {
    $ts = (Get-Date).ToString("HH:mm:ss")
    Write-Host "[$ts] $msg" -ForegroundColor $color
}

# ---------- signing key + password ----------

if (-not $NoSign) {
    $keyPath = Join-Path $HOME ".ticktock\signing.key"
    if (-not (Test-Path $keyPath)) {
        Write-Error @"
Signing key not found at $keyPath.
Generate one with:
  npx tauri signer generate -w "$keyPath"
Or pass -NoSign to build an unsigned installer (OTA updates won't work).
"@
    }

    # User-scope env var is the preferred place for the password — it survives
    # shells, and the Tauri CLI picks it up without any prompt. We fall back
    # to the current-process var in case the caller exported it inline.
    $pw = $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
    if (-not $pw) {
        $pw = [Environment]::GetEnvironmentVariable(
            "TAURI_SIGNING_PRIVATE_KEY_PASSWORD", "User")
    }
    if (-not $pw) {
        Write-Error @"
TAURI_SIGNING_PRIVATE_KEY_PASSWORD is not set. The Tauri signer would block
on a stdin prompt if we started the build now. Set it once:

  [Environment]::SetEnvironmentVariable(
      "TAURI_SIGNING_PRIVATE_KEY_PASSWORD", "<비밀번호>", "User")

Open a NEW shell afterwards so the variable is inherited.
(If the key was created without a password, use a single space as the value.)

Or pass -NoSign to build an unsigned installer.
"@
    }

    $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $keyPath -Raw
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $pw
    Log "Signing enabled (key + password loaded)" "Green"
} else {
    # Make sure no stale key sneaks into the build.
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
    Log "NoSign: building without signature (OTA disabled for this release)" "Yellow"
}

# ---------- build ----------

Log "Running `npm run tauri:build` (1-2 min)..." "Cyan"

# In -NoSign mode, tauri.conf.json's updater pubkey + createUpdaterArtifacts
# would force the CLI to demand a private key. Override just that one field
# via a scratch config file so the rest of tauri.conf.json stays untouched.
$overridePath = $null
if ($NoSign) {
    $overridePath = Join-Path $env:TEMP "ticktock-nosign-override.json"
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText(
        $overridePath,
        '{"bundle":{"createUpdaterArtifacts":false}}',
        $utf8NoBom)
}

Push-Location (Split-Path -Parent $PSScriptRoot)
try {
    # Redirect stdin from NUL so the Tauri CLI can never stall waiting on
    # interactive input — any prompt it might raise will read EOF and fail
    # fast instead of hanging the pipeline.
    if ($NoSign) {
        cmd /c "npm run tauri:build -- -c `"$overridePath`" < NUL"
    } else {
        cmd /c "npm run tauri:build < NUL"
    }
    if ($LASTEXITCODE -ne 0) {
        throw "tauri:build exited with code $LASTEXITCODE"
    }
} finally {
    Pop-Location
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
    if ($overridePath -and (Test-Path $overridePath)) {
        Remove-Item $overridePath -ErrorAction SilentlyContinue
    }
}
Log "✓ tauri:build finished" "Green"

# ---------- copy artifacts ----------

$bundleDir = Join-Path $PSScriptRoot "..\src-tauri\target\release\bundle\nsis"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")

# Read version from tauri.conf.json so the release folder matches the binary.
$conf = Get-Content (Join-Path $PSScriptRoot "..\src-tauri\tauri.conf.json") -Raw | ConvertFrom-Json
$version = $conf.version

$destDir = Join-Path $repoRoot "releases\v$version"
New-Item -ItemType Directory -Path $destDir -Force | Out-Null

$exe = Join-Path $bundleDir "TickTock_${version}_x64-setup.exe"
$sig = Join-Path $bundleDir "TickTock_${version}_x64-setup.exe.sig"

if (-not (Test-Path $exe)) {
    throw "expected installer not found: $exe"
}
Copy-Item $exe $destDir -Force

if (-not $NoSign) {
    if (-not (Test-Path $sig)) {
        throw "expected signature not found: $sig  (signing password may be wrong)"
    }
    Copy-Item $sig $destDir -Force
}

Write-Host "`nArtifacts copied to:" -ForegroundColor Green
Get-ChildItem $destDir | ForEach-Object { "  $($_.FullName)" }
