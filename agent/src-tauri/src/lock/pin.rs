// Local PIN for offline unlock. Stored as an Argon2id hash in SQLite.
// Not protected by DPAPI yet — TODO wrap the DB or just the hash column with
// CryptProtectData so an image of the disk on another user context can't reuse it.

use anyhow::{bail, Result};
use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};

pub fn hash(pin: &str) -> Result<String> {
    if !is_valid_pin(pin) {
        bail!("PIN must be 4-6 digits");
    }
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::default();
    let hash = argon2
        .hash_password(pin.as_bytes(), &salt)
        .map_err(|e| anyhow::anyhow!("hash failed: {e}"))?
        .to_string();
    Ok(hash)
}

pub fn verify(pin: &str, stored_hash: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(stored_hash) else { return false };
    Argon2::default().verify_password(pin.as_bytes(), &parsed).is_ok()
}

fn is_valid_pin(pin: &str) -> bool {
    let len = pin.chars().count();
    (4..=6).contains(&len) && pin.chars().all(|c| c.is_ascii_digit())
}

// Rate-limiting state lives in storage::AppState (attempts + lockout_until).
// Check those before calling verify().
