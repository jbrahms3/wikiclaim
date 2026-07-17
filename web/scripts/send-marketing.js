#!/usr/bin/env node
// One-off marketing send, run locally whenever you choose to send a
// campaign. Creates a Resend Broadcast against RESEND_SEGMENT_ID; by
// default it only drafts it (safe to run repeatedly) - pass --send to
// actually deliver it.
//
// Usage:
//   node scripts/send-marketing.js --subject "..." --html-file ./campaign.html [--send]
//   node scripts/send-marketing.js --subject "..." --text "Plain text body" [--send]
//
// Optional: --from "Name <you@yourdomain.com>" (else RESEND_FROM_EMAIL),
//           --name "Internal label for the Resend dashboard"
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });

const { resend } = await import("../email.js");

function parseArgs(argv) {
  const out = { send: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--send") out.send = true;
    else if (a.startsWith("--")) out[a.slice(2)] = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

if (!resend) fail("RESEND_API_KEY is not set - see web/.env.example.");
const segmentId = process.env.RESEND_SEGMENT_ID;
if (!segmentId) fail("RESEND_SEGMENT_ID is not set - see web/.env.example.");
if (!args.subject) fail("Missing --subject");

const from = args.from || process.env.RESEND_FROM_EMAIL;
if (!from) fail("Missing --from and RESEND_FROM_EMAIL is not set.");

let html;
if (args["html-file"]) {
  html = fs.readFileSync(path.resolve(args["html-file"]), "utf8");
} else if (!args.text) {
  fail("Provide either --html-file <path> or --text \"...\"");
}

const { data, error } = await resend.broadcasts.create({
  segmentId,
  from,
  subject: args.subject,
  ...(html ? { html } : { text: args.text }),
  ...(args.name ? { name: args.name } : {}),
  send: args.send,
});

if (error) fail(`Resend error: ${error.message || JSON.stringify(error)}`);

if (args.send) {
  console.log(`Sent. Broadcast id: ${data.id}`);
} else {
  console.log(
    `Drafted (not sent). Broadcast id: ${data.id}\n` +
      `Review it at https://resend.com/broadcasts/${data.id}, or rerun this ` +
      `command with --send to deliver it now.`
  );
}
