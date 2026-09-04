/**
 * Server-side verification for "Sign in with Google" (Google Identity Services).
 *
 * The frontend never talks to Google's OAuth token endpoint directly and never hands us a
 * password — GIS gives the browser a signed ID token (a JWT) after the user picks their Google
 * account, and the browser posts that token here. We must verify its signature against Google's
 * public keys, its audience (our own client id) and issuer before trusting anything in it;
 * an unverified JWT is just a string an attacker can also send.
 */

import { OAuth2Client } from "google-auth-library";

/** Set to the OAuth "Web application" client id from Google Cloud Console. Required for Google
 *  sign-in to work; if unset, verifyGoogleIdToken always throws (fails closed). */
const GOOGLE_CLIENT_ID = process.env.XCODER_GOOGLE_CLIENT_ID || "";

let client: OAuth2Client | null = null;
function getClient(): OAuth2Client {
  if (!client) client = new OAuth2Client(GOOGLE_CLIENT_ID);
  return client;
}

export interface GoogleIdentity {
  /** Google's stable, unique subject id for this account — the correct long-term key to match
   *  a local user against (email addresses can be reassigned; "sub" cannot). */
  googleId: string;
  email: string;
  emailVerified: boolean;
  name?: string;
}

/**
 * Verify a Google ID token (JWT) and return the identity it attests to.
 * Throws if XCODER_GOOGLE_CLIENT_ID isn't configured, the token is malformed/expired/forged,
 * or its audience doesn't match our client id.
 */
export async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdentity> {
  if (!GOOGLE_CLIENT_ID) {
    throw new Error("Google sign-in is not configured on this server (set XCODER_GOOGLE_CLIENT_ID)");
  }
  if (!idToken || typeof idToken !== "string") {
    throw new Error("Missing Google credential");
  }

  const ticket = await getClient().verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
  const payload = ticket.getPayload();
  if (!payload || !payload.sub || !payload.email) {
    throw new Error("Invalid Google credential");
  }
  if (payload.email_verified !== true) {
    throw new Error("Google account email is not verified");
  }

  return {
    googleId: payload.sub,
    email: payload.email,
    emailVerified: payload.email_verified === true,
    name: payload.name,
  };
}

/** Whether Google sign-in has been configured on this deployment. Used by GET /platform &
 *  the login screen to decide whether to render the "Sign in with Google" button at all. */
export function isGoogleSignInConfigured(): boolean {
  return Boolean(GOOGLE_CLIENT_ID);
}

export function getGoogleClientId(): string {
  return GOOGLE_CLIENT_ID;
}
