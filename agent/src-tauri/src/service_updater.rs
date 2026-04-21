// Service-side auto-updater.
//
// Runs in the Windows Service (LocalSystem) process so it can replace the
// installed binary without any UAC prompt. The user-session child no longer
// checks for updates — avoids the "standard user tries to install → asks for
// admin credentials" dialog that broke the v1 updater.
//
// Flow:
//   1. GET the manifest (same URL tauri-plugin-updater reads: the repo's
//      releases/latest/download/latest.json).
//   2. If manifest.version > current, download the setup.exe and its .sig.
//   3. Verify the minisign signature against the embedded public key (same
//      key that tauri-plugin-updater uses — matches tauri.conf.json.pubkey).
//   4. Spawn the NSIS installer silently (/S). The installer's hooks stop the
//      old service, replace the files, and start the new service. Our process
//      gets killed along the way — that's expected.
//
// Cadence: one check 60s after service start, then every 6 hours.

#![cfg(windows)]

use anyhow::{anyhow, Context, Result};
use minisign_verify::{PublicKey, Signature};
use serde::Deserialize;
use std::{
    sync::mpsc::{Receiver, RecvTimeoutError},
    time::Duration,
};

const MANIFEST_URL: &str =
    "https://github.com/jxamen/ticktock/releases/latest/download/latest.json";

// Matches plugins.updater.pubkey in tauri.conf.json.
const PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEU0RTAyQzdDQTAwQ0E3NEEKUldSS3B3eWdmQ3pnNVBIZEI0Tml0aVNYbGViT3grT0orUXpLdi9EamJuTHVoa0JMTkNBYk01Y3cK";

const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn run_updater(shutdown_rx: Receiver<()>) {
    // First check a minute after service start, then 6-hour cadence.
    if wait_or_shutdown(&shutdown_rx, Duration::from_secs(60)) {
        return;
    }
    loop {
        match check_and_install() {
            Ok(true) => {
                log::info!("update installer launched; service will be replaced");
                return;
            }
            Ok(false) => log::debug!("update: up to date"),
            Err(e) => log::warn!("update check failed: {e:#}"),
        }
        if wait_or_shutdown(&shutdown_rx, Duration::from_secs(6 * 60 * 60)) {
            return;
        }
    }
}

fn wait_or_shutdown(rx: &Receiver<()>, d: Duration) -> bool {
    match rx.recv_timeout(d) {
        Ok(()) | Err(RecvTimeoutError::Disconnected) => true,
        Err(RecvTimeoutError::Timeout) => false,
    }
}

// Returns Ok(true) if a new-version installer was launched, Ok(false) when
// nothing to do, Err on any failure during check/download/verify.
fn check_and_install() -> Result<bool> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()?;

    let manifest: Manifest = client.get(MANIFEST_URL).send()?.error_for_status()?.json()?;

    let latest = &manifest.version;
    if !is_newer(latest, CURRENT_VERSION) {
        return Ok(false);
    }
    log::info!("update available: {CURRENT_VERSION} -> {latest}");

    let platform = manifest
        .platforms
        .get("windows-x86_64")
        .ok_or_else(|| anyhow!("manifest missing windows-x86_64"))?;

    let bytes = client
        .get(&platform.url)
        .send()?
        .error_for_status()?
        .bytes()?;

    verify_signature(&bytes, &platform.signature)?;

    let temp = std::env::temp_dir().join(format!("ticktock-update-{latest}.exe"));
    std::fs::write(&temp, &bytes).context("write installer to temp")?;

    // NSIS silent flag /S. perMachine installer from LocalSystem → no UAC.
    std::process::Command::new(&temp)
        .arg("/S")
        .spawn()
        .context("spawn installer")?;

    Ok(true)
}

fn verify_signature(data: &[u8], signature: &str) -> Result<()> {
    let pk = PublicKey::decode(PUBKEY).map_err(|e| anyhow!("pubkey decode: {e:?}"))?;
    let sig = Signature::decode(signature.trim()).map_err(|e| anyhow!("sig decode: {e:?}"))?;
    pk.verify(data, &sig, false)
        .map_err(|e| anyhow!("signature verify: {e:?}"))?;
    Ok(())
}

// Lexicographic-on-numeric semver compare. We don't need pre-release handling;
// tauri just emits x.y.z.
fn is_newer(candidate: &str, current: &str) -> bool {
    fn parts(s: &str) -> Vec<u64> {
        s.split('.').filter_map(|p| p.parse().ok()).collect()
    }
    let a = parts(candidate);
    let b = parts(current);
    for (x, y) in a.iter().zip(b.iter()) {
        if x > y {
            return true;
        }
        if x < y {
            return false;
        }
    }
    a.len() > b.len()
}

#[derive(Deserialize)]
struct Manifest {
    version: String,
    platforms: std::collections::HashMap<String, PlatformEntry>,
}

#[derive(Deserialize)]
struct PlatformEntry {
    signature: String,
    url: String,
}

