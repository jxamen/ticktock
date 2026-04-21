// TickTock pairing — Cloud Functions (Gen 2, region: asia-northeast3 / Seoul).
//
// Three HTTPS endpoints used by the agent + parent app to establish trust:
//
//   POST /createPairingCode          — unauthenticated, called by the agent
//     Response: { code: "123456", expiresInSeconds: 600 }
//
//   POST /claimPairingCode           — authenticated (parent's Firebase ID token)
//     Headers: Authorization: Bearer <idToken>
//     Body:    { code: "123456", deviceName?: string, timezone?: string }
//     Response:{ deviceId: "..." }
//     Effect:  creates /users/{uid}/devices/{deviceId}: "owner"
//              creates /devices/{deviceId}/meta
//              writes /pairing/{code}/{claimedBy,deviceId,token}
//
//   POST /checkPairingCode           — unauthenticated, called by the agent (polling)
//     Body:    { code: "123456" }
//     Response while waiting: { claimed: false }
//     Response after claim:   { claimed: true, deviceId, token }
//     Consumes the pairing node on success (one-shot).
//
// Admin SDK bypasses RTDB security rules so /pairing/* doesn't need any
// client-facing rules — the rules in docs/firebase-setup.md stay as-is.

import { onRequest } from "firebase-functions/v2/https";
import { setGlobalOptions } from "firebase-functions/v2";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getDatabase } from "firebase-admin/database";
import * as crypto from "crypto";

setGlobalOptions({ region: "asia-northeast3", maxInstances: 5 });
initializeApp();

const PAIR_TTL_MS = 10 * 60 * 1000; // codes valid for 10 minutes

function generateCode(): string {
  // 6-digit numeric with leading zeros preserved.
  return Math.floor(Math.random() * 1_000_000).toString().padStart(6, "0");
}

// Allocate an unused code via transaction — retries on collision.
async function allocateCode(): Promise<string> {
  const db = getDatabase();
  for (let i = 0; i < 5; i++) {
    const code = generateCode();
    const ref = db.ref(`/pairing/${code}`);
    const tx = await ref.transaction((current) =>
      current === null
        ? { createdAt: Date.now(), expiresAt: Date.now() + PAIR_TTL_MS }
        : undefined,
    );
    if (tx.committed) return code;
  }
  throw new Error("failed to allocate pairing code after 5 attempts");
}

// --- Endpoints ---

export const createPairingCode = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.status(405).send({ error: "POST only" });
      return;
    }
    const code = await allocateCode();
    res.send({ code, expiresInSeconds: PAIR_TTL_MS / 1000 });
  } catch (e: unknown) {
    res.status(500).send({ error: errMsg(e) });
  }
});

export const checkPairingCode = onRequest({ cors: true }, async (req, res) => {
  try {
    const code = String(req.body?.code ?? req.query?.code ?? "");
    if (!code) {
      res.status(400).send({ error: "missing code" });
      return;
    }
    const ref = getDatabase().ref(`/pairing/${code}`);
    const snap = await ref.get();
    const pending = snap.val() as PendingPairing | null;
    if (!pending) {
      res.status(404).send({ error: "unknown code" });
      return;
    }
    if (pending.expiresAt < Date.now()) {
      await ref.remove();
      res.status(410).send({ error: "expired" });
      return;
    }
    if (!pending.claimedBy || !pending.deviceId || !pending.token) {
      res.send({ claimed: false });
      return;
    }
    // Success — consume the node so the token can't be re-fetched.
    await ref.remove();
    res.send({
      claimed: true,
      deviceId: pending.deviceId,
      token: pending.token,
    });
  } catch (e: unknown) {
    res.status(500).send({ error: errMsg(e) });
  }
});

export const claimPairingCode = onRequest({ cors: true }, async (req, res) => {
  try {
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) {
      res.status(401).send({ error: "missing bearer token" });
      return;
    }
    const idToken = auth.slice(7);
    let uid: string;
    try {
      const decoded = await getAuth().verifyIdToken(idToken);
      uid = decoded.uid;
    } catch {
      res.status(401).send({ error: "invalid token" });
      return;
    }

    const code = String(req.body?.code ?? "");
    if (!code) {
      res.status(400).send({ error: "missing code" });
      return;
    }

    const pairingRef = getDatabase().ref(`/pairing/${code}`);
    const snap = await pairingRef.get();
    const pending = snap.val() as PendingPairing | null;
    if (!pending) {
      res.status(404).send({ error: "unknown code" });
      return;
    }
    if (pending.expiresAt < Date.now()) {
      await pairingRef.remove();
      res.status(410).send({ error: "expired" });
      return;
    }
    if (pending.claimedBy) {
      res.status(409).send({ error: "already claimed" });
      return;
    }

    const deviceId = crypto.randomUUID();
    const token = await getAuth().createCustomToken(`device-${deviceId}`, {
      deviceId,
    });

    const deviceName = String(req.body?.deviceName ?? "새 PC");
    const timezone = String(req.body?.timezone ?? "Asia/Seoul");

    await getDatabase().ref().update({
      [`/users/${uid}/devices/${deviceId}`]: "owner",
      [`/devices/${deviceId}/meta`]: {
        name: deviceName,
        registeredAt: Date.now(),
        timezone,
      },
      [`/pairing/${code}/claimedBy`]: uid,
      [`/pairing/${code}/deviceId`]: deviceId,
      [`/pairing/${code}/token`]: token,
    });

    res.send({ deviceId });
  } catch (e: unknown) {
    res.status(500).send({ error: errMsg(e) });
  }
});

// --- Types & helpers ---

interface PendingPairing {
  createdAt: number;
  expiresAt: number;
  claimedBy?: string;
  deviceId?: string;
  token?: string;
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
