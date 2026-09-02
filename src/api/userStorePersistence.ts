import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { StoredUser } from "./auth.js";

/**
 * Stopgap disk persistence for the user account store.
 *
 * SECURITY FINDING THIS FIXES: the user store (usernames, scrypt password hashes, roles) was
 * previously held ONLY in a plain in-memory array inside registerRoutes()'s closure. Every
 * server restart — a deploy, a crash, a routine scale event — silently and permanently wiped
 * every account on the platform, including the admin account, with total data loss and no way
 * to recover. In a SaaS with paying subscribers, this is an availability/data-loss defect on
 * its own, independent of any attacker.
 *
 * This module persists the same array to a local JSON file (mode 0600, matching
 * llmKeyStore.ts's practice for this file since it contains password hashes) so accounts
 * survive a restart on a single instance.
 *
 * WHAT THIS DOES NOT FIX: this is single-instance-only. A real production SaaS deployment runs
 * more than one app server process behind a load balancer for availability and horizontal
 * scaling — a JSON file on one instance's local disk is invisible to the others, so requests
 * would see different user stores depending on which instance handled them. The correct fix
 * for that is migrating this table onto the existing db/ layer (already used for projects,
 * task history, WBS — see src/db/initialize.ts) so every instance reads/writes the same shared
 * database. Treat this file as a bridge to get off "wiped on every restart," not as the final
 * state for a horizontally-scaled deployment.
 */

const STORE_PATH = process.env.DEVNULL_USERS_STORE || path.join(os.homedir(), ".devnull", "users.json");

export function loadPersistedUsers(): StoredUser[] {
  if (!fs.existsSync(STORE_PATH)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return []; // a corrupt store shouldn't take the whole API down; worst case is an empty
    // user list, which just re-triggers the "no users yet, register the first admin" flow.
  }
}

export function persistUsers(users: StoredUser[]): void {
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(users, null, 2), { encoding: "utf-8", mode: 0o600 });
  } catch (err) {
    // Best-effort: if the write fails, the in-memory store (and thus this request) still
    // succeeds — but the change won't survive a restart. Logged so it's visible, not silent.
    console.error(`[userStorePersistence] Failed to persist user store: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Resumes the sequential id counter from the highest persisted numeric id, so reloading an
 *  existing store on restart never reissues an id that's already in use. */
export function nextUserIdAfter(users: StoredUser[]): number {
  const maxId = users.reduce((max, u) => {
    const n = Number(u.id);
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);
  return maxId + 1;
}
