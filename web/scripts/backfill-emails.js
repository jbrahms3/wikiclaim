#!/usr/bin/env node
// One-time backfill for accounts created before the `email` column existed.
// Pulls each user's email from Clerk (which still owns identity) and syncs
// them into the Resend marketing segment. Safe to rerun - skips anyone who
// already has an email on file.
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });

const { createClerkClient } = await import("@clerk/backend");
const { store, initStore } = await import("../store.js");
const { syncMarketingContact } = await import("../email.js");

const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;
if (!CLERK_SECRET_KEY) {
  console.error("CLERK_SECRET_KEY is not set - see web/.env.example.");
  process.exit(1);
}
const clerkClient = createClerkClient({ secretKey: CLERK_SECRET_KEY });

await initStore();
const users = await store.allUsers();
const missing = users.filter((u) => u.clerkUserId && !u.email);
console.log(`${missing.length} of ${users.length} users are missing an email.`);

let updated = 0;
for (const user of missing) {
  try {
    const profile = await clerkClient.users.getUser(user.clerkUserId);
    const email = profile.emailAddresses?.[0]?.emailAddress;
    if (!email) {
      console.warn(`No email on Clerk profile for ${user.username} (${user.id}) - skipped.`);
      continue;
    }
    await store.setEmail(user.id, email);
    await syncMarketingContact({ ...user, email });
    updated++;
  } catch (err) {
    console.error(`Failed for ${user.username} (${user.id}):`, err.message || err);
  }
}
console.log(`Backfilled ${updated} user(s).`);
