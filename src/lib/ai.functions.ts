import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requireFlag } from "@/lib/feature-flags.server";
import { getPlanLimits } from "@/lib/plan-guard.server";
import { aiDailyLimitOrThrow } from "@/lib/plan-limits";
import { PLAN_DETAILS } from "@/lib/plans";
import { env } from "@/lib/env.server";

/**
 * The console's "AI Drafting & Gemini Services" switch, enforced before a token
 * is ever spent: a disabled subsystem must not quietly fall back to a paid call.
 * Quotas and key errors below stay the business of those functions.
 */
function requireAiEnabled() {
  return requireFlag(
    "ai_generation_enabled",
    "AI drafting is turned off platform-wide right now. Try again later.",
  );
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

type AdminClient = Awaited<typeof import("@/integrations/supabase/client.server")>["supabaseAdmin"];

async function getAdmin(): Promise<AdminClient> {
  const mod = await import("@/integrations/supabase/client.server");
  return mod.supabaseAdmin;
}

/**
 * Server-side quota. The counter lives in `subscriptions` and is written with
 * the admin client so a signed-in user cannot reset their own usage.
 */
async function consumeQuota(authUserId: string) {
  const admin = await getAdmin();

  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("id")
    .eq("auth_user_id", authUserId)
    .maybeSingle();

  if (profileError) {
    // A rejected service key surfaces as a query *error*, not as an empty row.
    // Saying "Profile not found" here sent everyone hunting the wrong bug —
    // this reads exactly like what it is: the server cannot reach its own DB.
    throw new Error(
      "The AI service can't reach the account database. Check that SUPABASE_SERVICE_ROLE_KEY in .env matches this Supabase project.",
    );
  }
  if (!profile) throw new Error("Profile not found");

  // The allowance is read from `plan_limits` through the same resolver every
  // other guard uses — not from the `PLAN_DETAILS` copy that ships in the
  // client bundle. A hard-coded number here silently outranks the console: an
  // operator lowering a quota would see the pricing page change while real
  // generation kept allowing the old, higher count (and it cost gateway money).
  const limits = await getPlanLimits(profile.id);
  const limit = aiDailyLimitOrThrow(limits.ai_drafts_per_day);
  const planName = PLAN_DETAILS[limits.plan]?.name ?? limits.plan;

  const { data: sub, error: subError } = await admin
    .from("subscriptions")
    .select("ai_drafts_used, ai_usage_date")
    .eq("user_id", profile.id)
    .maybeSingle();
  if (subError) {
    throw new Error(
      "The AI service can't read your usage counter. Check that SUPABASE_SERVICE_ROLE_KEY in .env matches this Supabase project.",
    );
  }

  const sameDay = sub?.ai_usage_date === today();
  const used = sameDay ? Number(sub?.ai_drafts_used ?? 0) : 0;

  if (limit === 0) {
    // `0` is configuration, not an outage: the plan simply does not include it.
    throw new Error(`AI drafting isn't included in the ${planName} plan. Upgrade for more.`);
  }
  if (used >= limit) {
    throw new Error(
      `You've used all ${limit} AI generations for today on the ${planName} plan. Upgrade for more.`,
    );
  }

  const { error: usageError } = await admin.from("subscriptions").upsert(
    {
      user_id: profile.id,
      plan: limits.plan,
      ai_drafts_used: used + 1,
      ai_usage_date: today(),
    },
    { onConflict: "user_id" },
  );
  if (usageError) {
    // This write *is* the quota. If it is dropped, every later call still reads
    // yesterday's counter, the daily limit never trips, and each pass-through
    // costs real gateway money — so refuse the generation rather than allow it.
    throw new Error(usageError.message || "Could not record that generation.");
  }

  return { profileId: profile.id, plan: limits.plan, used: used + 1, limit };
}

async function chat(system: string, user: string): Promise<string> {
  const { apiKey, gatewayUrl, textModel } = env().ai;
  if (!apiKey) {
    throw new Error("The AI assistant isn't configured yet. Add an AI key to enable it.");
  }
  if (!gatewayUrl) {
    throw new Error(
      "AI_GATEWAY_URL is not configured — set it to any OpenAI-compatible chat completions endpoint.",
    );
  }

  // Model and gateway are environment-configurable so the same build can be
  // pointed at a different assistant without a code change.
  const model = textModel;
  const gateway = gatewayUrl;

  const res = await fetch(gateway, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      // Every prompt below demands JSON-only output. Without this, reasoning
      // models wrap the object in prose or code fences (and Gemini-2.5-flash
      // happily writes a short novel instead of a 90-char caption); the fence
      // scraper in parseJson then falls back to sliced gibberish. The gateways
      // we support all honour the OpenAI-compatible json_object mode.
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  if (res.status === 429) throw new Error("AI is busy right now — try again in a moment.");
  if (res.status === 402) {
    throw new Error("AI credits have run out for this workspace. Top up to keep generating.");
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error("The AI assistant isn't authorised. Check the AI key settings.");
  }
  if (res.status === 400) throw new Error(`The AI model "${model}" isn't available.`);
  if (!res.ok) throw new Error(`AI request failed (${res.status})`);

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return json.choices?.[0]?.message?.content?.trim() ?? "";
}

function parseJson<T>(raw: string, fallback: T): T {
  const cleaned = raw
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]) as T;
      } catch {
        /* fall through */
      }
    }
    return fallback;
  }
}

export const aiDraftPost = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    z
      .object({ prompt: z.string().min(1).max(500), currentDraft: z.string().max(2000).optional() })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    await requireAiEnabled();
    const quota = await consumeQuota(context.userId);

    const raw = await chat(
      "You write short, high-signal social posts for a creator network. " +
        'Reply ONLY with JSON: {"content": string, "suggestedTags": string[]}. ' +
        "content is at most 280 characters, human, specific, no hashtags inside the text, no emoji spam. " +
        "suggestedTags is 2-4 lowercase single-word tags without the # symbol.",
      data.currentDraft
        ? `Rewrite and improve this draft about "${data.prompt}":\n\n${data.currentDraft}`
        : `Write a post about: ${data.prompt}`,
    );

    const parsed = parseJson<{ content: string; suggestedTags: string[] }>(raw, {
      content: raw,
      suggestedTags: [],
    });

    return {
      content: parsed.content?.slice(0, 500) ?? "",
      suggestedTags: (parsed.suggestedTags ?? []).slice(0, 4),
      usage: { used: quota.used, limit: quota.limit },
    };
  });

export const aiStoryCaption = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => z.object({ prompt: z.string().min(1).max(300) }).parse(data))
  .handler(async ({ data, context }) => {
    await requireAiEnabled();
    const quota = await consumeQuota(context.userId);

    const raw = await chat(
      "You write captions for 24-hour photo/video stories. " +
        'Reply ONLY with JSON: {"text": string, "mood": string, "suggestedStickers": string[]}. ' +
        "text is ONE sentence, at most 90 characters, poetic but concrete. " +
        'mood is a single emoji followed by up to two capitalized words, e.g. "✨ Inspired". ' +
        "suggestedStickers is exactly 3 emoji.",
      `Story about: ${data.prompt}`,
    );

    const parsed = parseJson<{ text: string; mood: string; suggestedStickers: string[] }>(raw, {
      text: raw.slice(0, 90),
      mood: "✨ Inspired",
      suggestedStickers: ["✨", "🔥", "💫"],
    });

    return {
      text: parsed.text?.slice(0, 90) ?? "",
      mood: parsed.mood ?? "✨ Inspired",
      suggestedStickers: (parsed.suggestedStickers ?? []).slice(0, 3),
      usage: { used: quota.used, limit: quota.limit },
    };
  });

export const aiSummarizeSpace = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    z
      .object({
        title: z.string().min(1).max(200),
        topic: z.string().max(200).default(""),
        messages: z.array(z.string().max(500)).max(120).default([]),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    await requireAiEnabled();
    const quota = await consumeQuota(context.userId);

    const transcript = data.messages.slice(-80).join("\n");
    const raw = await chat(
      "You summarize live audio rooms. " +
        'Reply ONLY with JSON: {"summary": string, "keyTakeaways": string[]}. ' +
        "summary is 2-3 sentences. keyTakeaways is 3-5 short bullet strings.",
      `Room title: ${data.title}\nTopic: ${data.topic}\n\nRoom chat:\n${transcript || "(no chat messages)"}`,
    );

    const parsed = parseJson<{ summary: string; keyTakeaways: string[] }>(raw, {
      summary: raw,
      keyTakeaways: [],
    });

    return {
      summary: parsed.summary ?? "",
      keyTakeaways: (parsed.keyTakeaways ?? []).slice(0, 5),
      usage: { used: quota.used, limit: quota.limit },
    };
  });
