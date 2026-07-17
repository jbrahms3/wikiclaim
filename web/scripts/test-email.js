#!/usr/bin/env node
// Sends a one-off welcome email to yourself, to verify RESEND_API_KEY and
// RESEND_FROM_EMAIL are wired up correctly - bypasses Clerk/signup entirely.
//
// Usage: node scripts/test-email.js you@example.com
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });

const { sendWelcomeEmail } = await import("../email.js");

const email = process.argv[2];
if (!email) {
  console.error("Usage: node scripts/test-email.js you@example.com");
  process.exit(1);
}

await sendWelcomeEmail({ id: "test", username: "Tester", email });
console.log(`Attempted send to ${email} - check your inbox (and spam folder), or the Resend dashboard's Logs/Emails tab for delivery status and any errors.`);
