// AI triage for the anomalous view spikes the anti-botting cap flags for
// manual review (see contiguousSettlement in game.js). This is advisory
// only - it checks whether a real-world event plausibly explains the spike
// (news, a release, a viral post, ...) so the human reviewer at
// /api/admin/escrow has a head start instead of having to search manually
// for every flagged holding. It never makes the release/forfeit decision
// itself, and a spike with "no explanation found" is a normal, honest
// result - not proof of anything.
import Anthropic from "@anthropic-ai/sdk";

// Simple classification-and-search task, not deep reasoning - Opus is the
// house default per policy, but this is a good candidate to downgrade to
// Haiku 4.5 (~15-20x cheaper) if per-check cost ever matters at your flag
// volume; ask if you'd like that switched.
const MODEL = "claude-opus-4-8";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.warn(
    "ANTHROPIC_API_KEY is not set - AI spike-check on flagged holdings is disabled. " +
      "Set it in web/.env locally and in Railway's Variables to enable it."
  );
}
const client = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

const SYSTEM_PROMPT =
  "You are a fraud-triage assistant for a game where users earn points from real Wikipedia " +
  "pageview traffic. An article's pageviews spiked well above its normal baseline, which the " +
  "system flags for manual review because it could be either a real-world event driving genuine " +
  "reader interest, or artificial inflation (someone manually refreshing, a bot, or a coordinated " +
  "group). Search the web to see whether the spike lines up with something real - breaking news, " +
  "a film/show release, a death, an election, a viral social media post, a Reddit or forum thread " +
  "linking the article, a sports result, etc. You are not making the final call; a human reviewer " +
  "decides. Be honest about uncertainty: many spikes will have no discoverable external cause, and " +
  "that is a valid, common finding, not a failure to search hard enough.";

const VERDICTS = new Set(["REAL_EVENT", "LIKELY_REAL", "UNCLEAR", "NO_EXPLANATION_FOUND"]);

function reasonPhrase(reason) {
  switch (reason) {
    case "amount":
      return "held earnings crossed the escrow amount threshold";
    case "streak":
      return "a sustained streak of days over the normal-traffic cap";
    case "both":
      return "both the escrow amount threshold and a sustained streak over the normal-traffic cap";
    default:
      return "an anomalous view spike";
  }
}

function buildUserMessage({ article, displayTitle, lang, date, amount, streakDays, reason }) {
  return (
    `Wikipedia article: "${displayTitle}" (${lang}.wikipedia.org/wiki/${article})\n` +
    `Flagged: ${date} - ${reasonPhrase(reason)} (escrow ${amount} pts, ${streakDays}-day streak)\n\n` +
    `Search for real-world events, news, or social media activity around ${date} that could ` +
    `explain a traffic spike for this article. Respond in exactly this format:\n\n` +
    `VERDICT: <one of REAL_EVENT, LIKELY_REAL, UNCLEAR, NO_EXPLANATION_FOUND>\n` +
    `<one short paragraph explaining what you found, or that you found nothing>`
  );
}

/**
 * Checks whether a flagged holding's view spike lines up with a real-world
 * event. Never throws - a failed or disabled check just means the reviewer
 * sees no AI read on that holding, not a broken settlement pass. Call this
 * fire-and-forget; the credits/escrow numbers are already committed by the
 * time it runs.
 */
export async function checkSpike(input) {
  if (!client) return { status: "disabled", checkedAt: Date.now() };
  try {
    const response = await client.messages.create(
      {
        model: MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        thinking: { type: "adaptive" },
        output_config: { effort: "low" },
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 3 }],
        messages: [{ role: "user", content: buildUserMessage(input) }],
      },
      { timeout: 45_000 }
    );

    if (response.stop_reason === "refusal") {
      return { status: "error", error: "refused", checkedAt: Date.now() };
    }

    // The pages Claude actually consulted, not just what it claims in prose -
    // pulled straight from the search tool's own result blocks.
    const citations = [];
    const seenUrls = new Set();
    for (const block of response.content) {
      if (block.type !== "web_search_tool_result" || !Array.isArray(block.content)) continue;
      for (const r of block.content) {
        if (r.type === "web_search_result" && !seenUrls.has(r.url)) {
          seenUrls.add(r.url);
          citations.push({ url: r.url, title: r.title });
        }
      }
    }

    const textBlocks = response.content.filter((b) => b.type === "text");
    const finalText = textBlocks.length ? textBlocks[textBlocks.length - 1].text : "";
    const match = finalText.match(/VERDICT:\s*(\w+)/i);
    const verdict = match && VERDICTS.has(match[1].toUpperCase()) ? match[1].toUpperCase() : "UNCLEAR";
    const explanation = match ? finalText.slice(match.index + match[0].length).trim() : finalText.trim();

    return {
      status: "done",
      verdict,
      explanation: explanation || "(no explanation returned)",
      citations: citations.slice(0, 5),
      checkedAt: Date.now(),
    };
  } catch (err) {
    console.error("Spike check failed:", err);
    return { status: "error", error: err.message || String(err), checkedAt: Date.now() };
  }
}
