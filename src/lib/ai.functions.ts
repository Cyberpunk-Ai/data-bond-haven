import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { PLAN_DETAILS, type PlanTier } from "@/lib/plans";

const MODEL = "google/gemini-2.5-flash";
const GATEWAY = "https://ai.gateway.lovable.dev/v1/chat/completions";

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

  const { data: profile } = await admin
    .from("profiles")
    .select("id, plan")
    .eq("auth_user_id", authUserId)
    .maybeSingle();

  if (!profile) throw new Error("Profile not found");

  const plan = ((profile.plan as PlanTier) || "free") as PlanTier;
  const limit = PLAN_DETAILS[plan]?.limits.aiDraftsPerDay ?? 3;

  const { data: sub } = await admin
    .from("subscriptions")
    .select("ai_drafts_used, ai_usage_date")
    .eq("user_id", profile.id)
    .maybeSingle();

  const sameDay = sub?.ai_usage_date === today();
  const used = sameDay ? Number(sub?.ai_drafts_used ?? 0) : 0;

  if (Number.isFinite(limit) && limit > 0 && used >= limit) {
    throw new Error(
      `You've used all ${limit} AI generations for today on the ${PLAN_DETAILS[plan].name} plan. Upgrade for more.`,
    );
  }

  await admin.from("subscriptions").upsert(
    {
      user_id: profile.id,
      plan,
      ai_drafts_used: used + 1,
      ai_usage_date: today(),
    },
    { onConflict: "user_id" },
  );

  return { profileId: profile.id, plan, used: used + 1, limit };
}

async function chat(system: string, user: string): Promise<string> {
  const apiKey = (process.env["AI_API_KEY"] || process.env["LOVABLE_API_KEY"]);
  if (!apiKey) {
    throw new Error("The AI assistant isn't configured yet. Add an AI key to enable it.");
  }

  // Model and gateway are environment-configurable so the same build can be
  // pointed at a different assistant without a code change.
  const model = process.env["AI_TEXT_MODEL"] || MODEL;
  const gateway = process.env["AI_GATEWAY_URL"] || GATEWAY;

  const res = await fetch(gateway, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
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
    const quota = await consumeQuota(context.userId);

    const raw = await chat(
      "You write captions for 24-hour photo/video stories. " +
        'Reply ONLY with JSON: {"text": string, "mood": string, "suggestedStickers": string[]}. ' +
        "text is at most 90 characters. mood is one lowercase word. suggestedStickers is 3 emoji.",
      `Story about: ${data.prompt}`,
    );

    const parsed = parseJson<{ text: string; mood: string; suggestedStickers: string[] }>(raw, {
      text: raw.slice(0, 90),
      mood: "inspired",
      suggestedStickers: ["✨", "🔥", "💫"],
    });

    return {
      text: parsed.text?.slice(0, 120) ?? "",
      mood: parsed.mood ?? "inspired",
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
