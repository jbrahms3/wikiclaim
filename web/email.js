// Resend integration: a transactional welcome email on signup, plus keeping
// each user synced into a Resend Segment so marketing campaigns (sent from
// scripts/send-marketing.js) can reach them. Resend owns unsubscribe state
// for the segment - we never send marketing mail ourselves.
import { Resend } from "resend";

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL;
const SEGMENT_ID = process.env.RESEND_SEGMENT_ID;
const APP_URL = process.env.APP_URL;

if (!RESEND_API_KEY) {
  console.warn(
    "RESEND_API_KEY is not set - welcome emails and marketing-contact sync " +
      "are disabled. Set it in web/.env locally (see .env.example) and in " +
      "your Railway service's Variables in production."
  );
}

export const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

function welcomeEmailHtml(username) {
  return `
    <div style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 480px; margin: 0 auto;">
      <h1 style="font-size: 22px;">Welcome to WikiPicks, ${escapeHtml(username)}!</h1>
      <p style="color: #444; font-size: 15px; line-height: 1.5;">
        You're starting out with ${new Intl.NumberFormat("en-US").format(5000)} points.
        Claim Wikipedia articles priced by their real daily traffic, and earn
        points every day they're read.
      </p>
      ${APP_URL ? `<p style="color: #444; font-size: 15px; line-height: 1.5;">
        Jump back in any time at <a href="${escapeHtml(APP_URL)}">${escapeHtml(APP_URL)}</a>.
      </p>` : ""}
    </div>
  `;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/**
 * Fire-and-forget welcome email for a newly-provisioned account. Never
 * throws - a Resend outage or missing config must not break signup.
 */
export async function sendWelcomeEmail(user) {
  if (!resend || !FROM_EMAIL || !user.email) return;
  try {
    const { error } = await resend.emails.send({
      from: FROM_EMAIL,
      to: user.email,
      subject: "Welcome to WikiPicks",
      html: welcomeEmailHtml(user.username),
    });
    if (error) console.error("Welcome email failed for", user.id, error);
  } catch (err) {
    console.error("Welcome email failed for", user.id, err);
  }
}

/**
 * Upsert this user into the marketing segment so a future broadcast (see
 * scripts/send-marketing.js) can reach them. Fire-and-forget, same as above.
 */
export async function syncMarketingContact(user) {
  if (!resend || !SEGMENT_ID || !user.email) return;
  try {
    const { error } = await resend.contacts.create({
      email: user.email,
      firstName: user.username,
      segments: [{ id: SEGMENT_ID }],
    });
    if (error) console.error("Marketing contact sync failed for", user.id, error);
  } catch (err) {
    console.error("Marketing contact sync failed for", user.id, err);
  }
}
