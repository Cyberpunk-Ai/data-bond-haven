import { useEffect, useMemo, useState } from "react";
import {
  TrendingUp,
  Users,
  Eye,
  MousePointerClick,
  Sparkles,
  Download,
  Lock,
  DollarSign,
  Clock,
  Zap,
  Target,
  Loader2,
  BarChart3,
} from "lucide-react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
} from "recharts";
import { usePlan, openUpgradeModal } from "@/lib/plan-state";
import { useMonetization } from "@/lib/monetization-state";
import { getCreatorAnalytics, type CreatorAnalytics } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const REGION_COLORS = [
  "bg-brand",
  "bg-violet-400",
  "bg-pink-500",
  "bg-amber-400",
  "bg-muted-foreground/40",
];

function money(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

function EmptyPanel({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-3xl border border-dashed border-border bg-card/60 px-6 py-12 text-center">
      <BarChart3 className="h-6 w-6 text-muted-foreground" />
      <p className="text-sm font-bold text-foreground">{title}</p>
      <p className="max-w-sm text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

export function AnalyticsDashboard() {
  const { currentPlan, isPlus, isPro } = usePlan();
  const { totalEarnings, pendingBalance } = useMonetization();
  const [timeframe, setTimeframe] = useState<"7d" | "30d">("7d");
  const [activeTab, setActiveTab] = useState<"overview" | "audience" | "revenue" | "ai_insights">(
    "overview",
  );
  const [data, setData] = useState<CreatorAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setFailed(false);
    getCreatorAnalytics(timeframe)
      .then((res) => {
        if (active) setData(res);
      })
      .catch(() => {
        if (active) setFailed(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [timeframe]);

  const chartData = data?.trend ?? [];
  const totals = data?.totals;
  const hasData = Boolean(data?.hasData);

  const peakLabel = useMemo(() => {
    if (!data?.hourly?.length) return null;
    const best = [...data.hourly].sort((a, b) => b.activity - a.activity)[0];
    return best && best.activity > 0 ? best.hour : null;
  }, [data]);

  const bestPost = useMemo(() => data?.topPosts?.[0] ?? null, [data]);

  const handleExportData = () => {
    if (!isPlus) {
      openUpgradeModal("Export Analytics Data");
      return;
    }
    if (chartData.length === 0) {
      toast.error("There's nothing to export yet.");
      return;
    }
    const csvContent =
      "data:text/csv;charset=utf-8," +
      ["Period,Impressions,Reach,EngagementRate"]
        .concat(chartData.map((r) => `${r.day},${r.impressions},${r.reach},${r.engagement}%`))
        .join("\n");
    const link = document.createElement("a");
    link.setAttribute("href", encodeURI(csvContent));
    link.setAttribute("download", `analytics_${timeframe}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    toast.success("Analytics exported to CSV");
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      {/* Top Header & Range Selector */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-black">Creator Analytics</h2>
            <span
              className={cn(
                "px-2.5 py-0.5 rounded-full text-[10px] font-extrabold uppercase tracking-wide",
                isPro
                  ? "bg-purple-500/15 text-purple-600 dark:text-purple-400 border border-purple-500/30"
                  : isPlus
                    ? "bg-brand/15 text-brand border border-brand/30"
                    : "bg-muted text-muted-foreground",
              )}
            >
              {currentPlan} Plan Insights
            </span>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {isPro
              ? "Full Pro analytics: monetization, peak hours and growth advice from your own data."
              : isPlus
                ? "Reach, audience locations and content performance from your own data."
                : "Standard impression overview. Upgrade to Plus or Pro for deeper metrics."}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex rounded-full border border-border bg-muted/40 p-1 text-xs">
            <button
              onClick={() => setTimeframe("7d")}
              className={cn(
                "rounded-full px-3 py-1 font-bold transition-all cursor-pointer",
                timeframe === "7d"
                  ? "bg-card text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              7 Days
            </button>
            <button
              onClick={() => {
                if (!isPlus) {
                  openUpgradeModal("30-Day Analytics Window");
                  return;
                }
                setTimeframe("30d");
              }}
              className={cn(
                "flex items-center gap-1 rounded-full px-3 py-1 font-bold transition-all cursor-pointer",
                timeframe === "30d"
                  ? "bg-card text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <span>30 Days</span>
              {!isPlus && <Lock className="h-2.5 w-2.5 text-muted-foreground" />}
            </button>
          </div>

          <button
            onClick={handleExportData}
            className="flex items-center gap-1.5 rounded-full border border-border bg-card px-3.5 py-1.5 text-xs font-bold hover:bg-muted transition-colors cursor-pointer"
          >
            <Download className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Export CSV</span>
            {!isPlus && <Lock className="h-2.5 w-2.5 text-muted-foreground ml-0.5" />}
          </button>
        </div>
      </div>

      {/* Tabs navigation */}
      <div className="flex items-center gap-2 border-b border-border/60 pb-2 overflow-x-auto [scrollbar-width:none]">
        <button
          onClick={() => setActiveTab("overview")}
          className={cn(
            "px-4 py-1.5 rounded-full text-xs font-bold transition-all whitespace-nowrap",
            activeTab === "overview"
              ? "bg-foreground text-background shadow-xs"
              : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
          )}
        >
          Performance & Reach
        </button>
        <button
          onClick={() => setActiveTab("audience")}
          className={cn(
            "px-4 py-1.5 rounded-full text-xs font-bold transition-all whitespace-nowrap",
            activeTab === "audience"
              ? "bg-foreground text-background shadow-xs"
              : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
          )}
        >
          Audience & Peak Hours
        </button>
        <button
          onClick={() => {
            if (!isPro && !isPlus) {
              openUpgradeModal("Monetization & Tips Analytics");
              return;
            }
            setActiveTab("revenue");
          }}
          className={cn(
            "flex items-center gap-1 px-4 py-1.5 rounded-full text-xs font-bold transition-all whitespace-nowrap",
            activeTab === "revenue"
              ? "bg-foreground text-background shadow-xs"
              : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
          )}
        >
          <DollarSign className="h-3 w-3" />
          <span>Tips & Revenue</span>
          {!isPlus && <Lock className="h-2.5 w-2.5 text-muted-foreground" />}
        </button>
        <button
          onClick={() => {
            if (!isPro) {
              openUpgradeModal("AI Growth Copilot");
              return;
            }
            setActiveTab("ai_insights");
          }}
          className={cn(
            "flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-bold transition-all whitespace-nowrap",
            activeTab === "ai_insights"
              ? "bg-gradient-to-r from-purple-600 to-pink-600 text-white shadow-xs"
              : "text-purple-600 dark:text-purple-400 bg-purple-500/10 hover:bg-purple-500/20",
          )}
        >
          <Sparkles className="h-3 w-3" />
          <span>Growth Advisor</span>
          {!isPro && <Lock className="h-2.5 w-2.5 text-purple-400" />}
        </button>
      </div>

      {loading && (
        <div className="flex items-center justify-center gap-2 rounded-3xl border border-border bg-card py-16 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading your analytics…
        </div>
      )}

      {!loading && failed && (
        <EmptyPanel
          title="We couldn't load your analytics"
          hint="Check your connection and try again in a moment."
        />
      )}

      {!loading && !failed && !hasData && (
        <EmptyPanel
          title="No analytics yet"
          hint="Once you post and people start viewing, liking and tipping, your numbers appear here."
        />
      )}

      {!loading && !failed && hasData && totals && (
        <>
          {activeTab === "overview" && (
            <div className="space-y-6">
              {/* KPI Cards Grid */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
                <div className="rounded-2xl border border-border/80 bg-card p-4 space-y-1 shadow-xs">
                  <div className="flex items-center justify-between text-muted-foreground">
                    <span className="text-xs font-bold uppercase tracking-wider">Impressions</span>
                    <Eye className="h-4 w-4 text-violet-500" />
                  </div>
                  <span className="text-2xl font-black tracking-tight">
                    {totals.impressions.toLocaleString()}
                  </span>
                  <p className="text-[0.7rem] text-muted-foreground">
                    Total post views across feeds
                  </p>
                </div>

                <div className="rounded-2xl border border-border/80 bg-card p-4 space-y-1 shadow-xs">
                  <div className="flex items-center justify-between text-muted-foreground">
                    <span className="text-xs font-bold uppercase tracking-wider">Unique Reach</span>
                    <Users className="h-4 w-4 text-pink-500" />
                  </div>
                  <span className="text-2xl font-black tracking-tight">
                    {totals.reach.toLocaleString()}
                  </span>
                  <p className="text-[0.7rem] text-muted-foreground">
                    Unique accounts in the last {timeframe === "7d" ? "7" : "30"} days
                  </p>
                </div>

                <div className="rounded-2xl border border-border/80 bg-card p-4 space-y-1 shadow-xs">
                  <div className="flex items-center justify-between text-muted-foreground">
                    <span className="text-xs font-bold uppercase tracking-wider">
                      Engagement Rate
                    </span>
                    <Sparkles className="h-4 w-4 text-amber-500" />
                  </div>
                  <span className="text-2xl font-black tracking-tight">
                    {totals.engagementRate}%
                  </span>
                  <p className="text-[0.7rem] text-muted-foreground">
                    Likes, replies &amp; reposts / views
                  </p>
                </div>

                <div className="rounded-2xl border border-border/80 bg-card p-4 space-y-1 shadow-xs">
                  <div className="flex items-center justify-between text-muted-foreground">
                    <span className="text-xs font-bold uppercase tracking-wider">Followers</span>
                    <MousePointerClick className="h-4 w-4 text-cyan-500" />
                  </div>
                  <span className="text-2xl font-black tracking-tight">
                    {totals.followers.toLocaleString()}
                  </span>
                  <p className="text-[0.7rem] text-muted-foreground">
                    Across {totals.posts.toLocaleString()} published posts
                  </p>
                </div>
              </div>

              {/* Main Impressions & Reach Chart */}
              <div className="rounded-3xl border border-border/80 bg-card p-5 md:p-6 space-y-4 shadow-soft">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-base font-bold">Impressions &amp; Reach Trends</h3>
                    <p className="text-xs text-muted-foreground">
                      Recorded views of your posts over time
                    </p>
                  </div>
                  <div className="flex items-center gap-4 text-xs font-semibold">
                    <div className="flex items-center gap-1.5">
                      <div className="h-2.5 w-2.5 rounded-full bg-violet-600" />
                      <span>Impressions</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <div className="h-2.5 w-2.5 rounded-full bg-pink-500" />
                      <span>Reach</span>
                    </div>
                  </div>
                </div>

                <div className="h-64 w-full pt-2">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart
                      data={chartData}
                      margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
                    >
                      <defs>
                        <linearGradient id="impressionGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.35} />
                          <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0.0} />
                        </linearGradient>
                        <linearGradient id="reachGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#ec4899" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="#ec4899" stopOpacity={0.0} />
                        </linearGradient>
                      </defs>
                      <XAxis
                        dataKey="day"
                        stroke="#888888"
                        fontSize={11}
                        tickLine={false}
                        axisLine={false}
                      />
                      <YAxis stroke="#888888" fontSize={11} tickLine={false} axisLine={false} />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: "rgba(23, 23, 23, 0.9)",
                          borderColor: "rgba(255, 255, 255, 0.1)",
                          borderRadius: "1rem",
                          color: "#fff",
                          fontSize: "12px",
                        }}
                      />
                      <Area
                        type="monotone"
                        dataKey="impressions"
                        stroke="#8b5cf6"
                        strokeWidth={2.5}
                        fillOpacity={1}
                        fill="url(#impressionGrad)"
                      />
                      <Area
                        type="monotone"
                        dataKey="reach"
                        stroke="#ec4899"
                        strokeWidth={2.5}
                        fillOpacity={1}
                        fill="url(#reachGrad)"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Top Posts Breakdown */}
              <div className="rounded-3xl border border-border/80 bg-card p-5 md:p-6 space-y-4 shadow-soft">
                <div>
                  <h3 className="text-base font-bold">Top Performing Posts</h3>
                  <p className="text-xs text-muted-foreground">Your posts ranked by views</p>
                </div>

                {data && data.topPosts.length > 0 ? (
                  <div className="space-y-3 pt-1">
                    {data.topPosts.map((post, idx) => (
                      <div
                        key={post.id}
                        className="rounded-2xl border border-border/60 bg-muted/20 p-3.5 space-y-2 hover:bg-muted/40 transition-colors"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-xs sm:text-sm font-bold text-foreground line-clamp-1">
                            {post.title}
                          </p>
                          <span className="text-[0.65rem] font-extrabold px-2 py-0.5 rounded bg-brand/10 text-brand">
                            Rank #{idx + 1}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                          <span>{post.views.toLocaleString()} views</span>
                          <span>{post.likes} likes</span>
                          <span>{post.reposts} reposts</span>
                          <span className="font-bold text-emerald-600 dark:text-emerald-400">
                            {post.ctr} engagement
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="py-6 text-center text-xs text-muted-foreground">
                    Publish your first post to see performance here.
                  </p>
                )}
              </div>
            </div>
          )}

          {activeTab === "audience" && (
            <div className="space-y-6">
              {/* Hourly Peak Engagement */}
              <div className="rounded-3xl border border-border/80 bg-card p-5 md:p-6 space-y-4 shadow-soft">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="text-base font-bold flex items-center gap-2">
                      <Clock className="h-4 w-4 text-brand" />
                      When your audience shows up
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      Based on when your posts were actually viewed
                    </p>
                  </div>
                  {peakLabel && (
                    <span className="text-xs font-bold text-emerald-500 bg-emerald-500/10 px-2.5 py-1 rounded-full">
                      Peak: around {peakLabel}
                    </span>
                  )}
                </div>

                {data && data.hourly.some((h) => h.activity > 0) ? (
                  <div className="h-56 w-full pt-2">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart
                        data={data.hourly}
                        margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
                      >
                        <XAxis
                          dataKey="hour"
                          stroke="#888888"
                          fontSize={11}
                          tickLine={false}
                          axisLine={false}
                        />
                        <YAxis stroke="#888888" fontSize={11} tickLine={false} axisLine={false} />
                        <Tooltip
                          contentStyle={{
                            backgroundColor: "rgba(23, 23, 23, 0.9)",
                            borderColor: "rgba(255, 255, 255, 0.1)",
                            borderRadius: "1rem",
                            color: "#fff",
                            fontSize: "12px",
                          }}
                        />
                        <Bar dataKey="activity" fill="#8b5cf6" radius={[6, 6, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <p className="py-8 text-center text-xs text-muted-foreground">
                    No views recorded in this period yet.
                  </p>
                )}
              </div>

              {/* Audience Geography */}
              <div className="rounded-3xl border border-border/80 bg-card p-5 md:p-6 space-y-4 shadow-soft">
                <div className="flex items-center justify-between">
                  <h3 className="text-base font-bold">Top Audience Locations</h3>
                  <span className="text-xs text-muted-foreground font-semibold">
                    From follower profiles
                  </span>
                </div>

                {data && data.regions.length > 0 ? (
                  <div className="space-y-3 pt-1">
                    {data.regions.map((region, i) => (
                      <div key={region.country} className="space-y-1.5">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-semibold text-foreground">{region.country}</span>
                          <span className="font-bold text-muted-foreground">
                            {region.percentage}%
                          </span>
                        </div>
                        <div className="h-2 w-full overflow-hidden rounded-full bg-muted/60">
                          <div
                            className={cn(
                              "h-full rounded-full",
                              REGION_COLORS[i] ?? "bg-muted-foreground/40",
                            )}
                            style={{ width: `${region.percentage}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="py-6 text-center text-xs text-muted-foreground">
                    When followers add a location to their profile, it shows up here.
                  </p>
                )}
              </div>
            </div>
          )}

          {activeTab === "revenue" && data && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-5 space-y-1">
                  <span className="text-xs font-bold uppercase text-amber-600 dark:text-amber-400">
                    Total Lifetime Tips
                  </span>
                  <p className="text-3xl font-black">
                    {money(totalEarnings || data.revenue.tipTotal, data.revenue.currency)}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {data.revenue.tipCount} tips from {data.revenue.supporters} supporters
                  </p>
                </div>
                <div className="rounded-2xl border border-border bg-card p-5 space-y-1">
                  <span className="text-xs font-bold uppercase text-muted-foreground">
                    Average Tip
                  </span>
                  <p className="text-3xl font-black">
                    {money(
                      data.revenue.tipCount > 0 ? data.revenue.tipTotal / data.revenue.tipCount : 0,
                      data.revenue.currency,
                    )}
                  </p>
                  <p className="text-[11px] text-muted-foreground">Across all received tips</p>
                </div>
                <div className="rounded-2xl border border-border bg-card p-5 space-y-1">
                  <span className="text-xs font-bold uppercase text-muted-foreground">
                    Available for Payout
                  </span>
                  <p className="text-3xl font-black text-emerald-500">
                    {money(pendingBalance, data.revenue.currency)}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    Request a transfer from Monetization
                  </p>
                </div>
              </div>

              <div className="rounded-3xl border border-border/80 bg-card p-5 md:p-6 space-y-4 shadow-soft">
                <h3 className="text-base font-bold">Recent Tips</h3>
                {data.revenue.recent.length > 0 ? (
                  <div className="space-y-3">
                    {data.revenue.recent.map((tip) => (
                      <div
                        key={tip.id}
                        className="flex items-center justify-between gap-3 p-3 rounded-2xl bg-muted/20"
                      >
                        <div className="min-w-0">
                          <p className="text-xs font-bold truncate">
                            {tip.message || "No message"}
                          </p>
                          <p className="text-[11px] text-muted-foreground">
                            {new Date(tip.created_at).toLocaleDateString()}
                          </p>
                        </div>
                        <span className="text-xs font-extrabold text-amber-600 dark:text-amber-400 whitespace-nowrap">
                          {money(tip.amount, tip.currency)}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="py-6 text-center text-xs text-muted-foreground">
                    No tips received yet. Turn on tips in Monetization so supporters can send them.
                  </p>
                )}
              </div>
            </div>
          )}

          {activeTab === "ai_insights" && (
            <div className="space-y-4">
              <div className="rounded-3xl border border-purple-500/30 bg-gradient-to-br from-purple-500/15 via-pink-500/10 to-transparent p-5 md:p-6 space-y-4">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-purple-500" />
                  <h3 className="text-base font-black">Growth Advisor</h3>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="p-4 rounded-2xl bg-card/80 border border-border/60 space-y-2">
                    <div className="flex items-center gap-2 text-xs font-bold text-foreground">
                      <Zap className="h-4 w-4 text-amber-500" />
                      <span>Your strongest post so far</span>
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      {bestPost
                        ? `“${bestPost.title}” reached ${bestPost.views.toLocaleString()} views with ${bestPost.ctr} engagement. Posting more in this style is your best lever right now.`
                        : "Publish a few posts and we'll point out which style performs best for you."}
                    </p>
                  </div>

                  <div className="p-4 rounded-2xl bg-card/80 border border-border/60 space-y-2">
                    <div className="flex items-center gap-2 text-xs font-bold text-foreground">
                      <Target className="h-4 w-4 text-emerald-500" />
                      <span>Best time to publish</span>
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      {peakLabel
                        ? `Most of your views land around ${peakLabel}. Schedule posts and live rooms just before then.`
                        : "Once your posts collect views we can tell you when your audience is most active."}
                    </p>
                  </div>

                  <div className="p-4 rounded-2xl bg-card/80 border border-border/60 space-y-2">
                    <div className="flex items-center gap-2 text-xs font-bold text-foreground">
                      <TrendingUp className="h-4 w-4 text-brand" />
                      <span>Engagement health</span>
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      {totals.engagementRate > 0
                        ? `${totals.engagementRate}% of views turn into a like, reply or repost — ${totals.likes + totals.comments + totals.reposts} interactions in total.`
                        : "No interactions recorded yet."}
                    </p>
                  </div>

                  <div className="p-4 rounded-2xl bg-card/80 border border-border/60 space-y-2">
                    <div className="flex items-center gap-2 text-xs font-bold text-foreground">
                      <DollarSign className="h-4 w-4 text-amber-500" />
                      <span>Supporter momentum</span>
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      {data && data.revenue.tipCount > 0
                        ? `${data.revenue.supporters} people have tipped you ${money(data.revenue.tipTotal, data.revenue.currency)} so far.`
                        : "No tips yet — mentioning tips in a post is usually what starts them."}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* Upgrade Banner for Free Users */}
      {!isPlus && (
        <div className="rounded-3xl border border-violet-500/30 bg-gradient-to-r from-violet-500/10 via-pink-500/10 to-transparent p-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="space-y-1 text-center sm:text-left">
            <div className="flex items-center justify-center sm:justify-start gap-2">
              <Lock className="h-4 w-4 text-violet-500" />
              <h4 className="text-sm font-black">Unlock full analytics with Plus &amp; Pro</h4>
            </div>
            <p className="text-xs text-muted-foreground">
              Get the 30-day window, audience locations, tip analytics and CSV exports.
            </p>
          </div>
          <button
            onClick={() => openUpgradeModal("Advanced Creator Analytics")}
            className="rounded-full bg-gradient-to-r from-brand to-brand-pink px-5 py-2.5 text-xs font-bold text-white shadow-soft hover:brightness-105 transition-all cursor-pointer whitespace-nowrap"
          >
            Upgrade to Plus
          </button>
        </div>
      )}
    </div>
  );
}
