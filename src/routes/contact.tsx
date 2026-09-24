import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

import { Section, StaticPage } from "@/components/site/StaticPage";
import { appConfig } from "@/lib/config";

const name = appConfig.brand.name;

export const Route = createFileRoute("/contact")({
  head: () => ({
    meta: [
      { title: `Contact — ${name}` },
      { name: "description", content: `Get help or reach the ${name} team.` },
      { property: "og:title", content: `Contact — ${name}` },
      { property: "og:description", content: `Get help or reach the ${name} team.` },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Contact,
});

function Contact() {
  const [form, setForm] = useState({ name: "", email: "", topic: "Support", message: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!form.name.trim()) next.name = "Please enter your name.";
    if (!/^\S+@\S+\.\S+$/.test(form.email)) next.email = "Please enter a valid email.";
    if (form.message.trim().length < 10) next.message = "Tell us a little more (10+ characters).";
    setErrors(next);
    if (Object.keys(next).length) return;
    const subject = encodeURIComponent(`[${form.topic}] from ${form.name}`);
    const body = encodeURIComponent(`${form.message}\n\n— ${form.name} <${form.email}>`);
    window.location.href = `mailto:${appConfig.brand.supportEmail}?subject=${subject}&body=${body}`;
    toast.success("Opening your email app…");
  }

  const field = "w-full rounded-xl border border-border bg-card px-4 py-3 text-sm outline-none focus:border-brand";

  return (
    <StaticPage eyebrow="Contact" title="We'd love to hear from you." intro="Support, feedback, partnerships or press — we usually reply within one business day.">
      <form onSubmit={submit} noValidate className="space-y-4 rounded-2xl border border-border bg-card/50 p-6">
        {(["name", "email"] as const).map((k) => (
          <div key={k}>
            <label htmlFor={k} className="mb-1 block text-sm font-semibold capitalize">{k}</label>
            <input id={k} type={k === "email" ? "email" : "text"} value={form[k]} maxLength={120}
              onChange={(e) => setForm({ ...form, [k]: e.target.value })} className={field} />
            {errors[k] && <p className="mt-1 text-xs text-destructive">{errors[k]}</p>}
          </div>
        ))}
        <div>
          <label htmlFor="topic" className="mb-1 block text-sm font-semibold">Topic</label>
          <select id="topic" value={form.topic} onChange={(e) => setForm({ ...form, topic: e.target.value })} className={field}>
            {["Support", "Billing", "Report a problem", "Partnerships", "Press"].map((t) => <option key={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="message" className="mb-1 block text-sm font-semibold">Message</label>
          <textarea id="message" rows={5} maxLength={2000} value={form.message}
            onChange={(e) => setForm({ ...form, message: e.target.value })} className={field} />
          {errors.message && <p className="mt-1 text-xs text-destructive">{errors.message}</p>}
        </div>
        <button type="submit" className="rounded-full bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90">
          Send message
        </button>
      </form>
      <Section title="Other ways to reach us">
        <p>Email: <a className="text-brand underline" href={`mailto:${appConfig.brand.supportEmail}`}>{appConfig.brand.supportEmail}</a></p>
      </Section>
    </StaticPage>
  );
}
