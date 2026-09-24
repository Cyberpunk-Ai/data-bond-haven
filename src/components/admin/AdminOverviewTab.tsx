import { useState } from "react";
import {
  Users,
  Eye,
  FileText,
  Radio,
  AlertCircle,
  Award,
  TrendingUp,
  Activity,
  ArrowUpRight,
  ShieldAlert,
  Sparkles,
  Zap,
} from "lucide-react";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import type { AdminOverviewData, UserRole } from "@/lib/types";
import { Avatar } from "@/components/social/Avatar";
import { cn } from "@/lib/utils";

interface AdminOverviewTabProps {
  overview: AdminOverviewData;
  activeRole: UserRole;
  onNavigateTab: (tab: string) => void;
}

export function AdminOverviewTab({ overview, activeRole, onNavigateTab }: AdminOverviewTabProps) {
  const { stats, charts, recent_activity, recent_reports } = overview;
  const [chartMetric, setChartMetric] = useState<"impressions" | "engagement">("impressions");

  const statCards = [
    {
      title: "Total Registered Users",
      value: stats.total_users.toLocaleString(),
      subtext: `${stats.active_24h_users} active in last 24h`,
      icon: Users,
      iconColor: "text-blue-600 dark:text-blue-400",
      bgGradient: "from-blue-500/10 to-indigo-500/10",
      borderColor: "border-blue-500/20",
      change: "+12.4%",
      tab: "users",
    },
    {
      title: "Total Content Impressions",
      value: stats.total_impressions.toLocaleString(),
      subtext: "Authoritative viewport tracking",
      icon: Eye,
      iconColor: "text-emerald-600 dark:text-emerald-400",
      bgGradient: "from-emerald-500/10 to-teal-500/10",
      borderColor: "border-emerald-500/20",
      change: "+28.1%",
      tab: "overview",
    },
    {
      title: "Posts & Stories Published",
      value: (stats.total_posts + stats.total_stories).toLocaleString(),
      subtext: `${stats.total_posts} posts · ${stats.total_stories} stories`,
      icon: FileText,
      iconColor: "text-violet-600 dark:text-violet-400",
      bgGradient: "from-violet-500/10 to-purple-500/10",
      borderColor: "border-violet-500/20",
      change: "+18.7%",
      tab: "content",
    },
    {
      title: "Audio Spaces Activity",
      value: `${stats.live_spaces_count} Live Now`,
      subtext: `${stats.total_spaces} total rooms created`,
      icon: Radio,
      iconColor: "text-rose-600 dark:text-rose-400",
      bgGradient: "from-rose-500/10 to-pink-500/10",
      borderColor: "border-rose-500/20",
      change: "+9.2%",
      tab: "content",
    },
    {
      title: "Pending Moderation Reports",
      value: stats.pending_reports_count.toString(),
      subtext: `${stats.suspended_users_count} suspended users`,
      icon: AlertCircle,
      iconColor:
        stats.pending_reports_count > 0 ? "text-amber-600 dark:text-amber-400" : "text-emerald-600",
      bgGradient: "from-amber-500/10 to-orange-500/10",
      borderColor: "border-amber-500/20",
      change: stats.pending_reports_count > 0 ? "Needs Triage" : "Clean",
      tab: "moderation",
    },
    {
      title: "Verified Creators",
      value: stats.verified_creators_count.toString(),
      subtext: "Verified public voices",
      icon: Award,
      iconColor: "text-brand",
      bgGradient: "from-brand/10 to-brand-pink/10",
      borderColor: "border-brand/20",
      change: "+3 this week",
      tab: "users",
    },
  ];

  return (
    <div className="space-y-6">
      {/* Top 6 KPI Metric Tiles */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {statCards.map((card) => {
          const Icon = card.icon;
          return (
            <div
              key={card.title}
              onClick={() => onNavigateTab(card.tab)}
              className={cn(
                "group glass-panel cursor-pointer rounded-3xl border p-5 transition-all duration-300 hover:shadow-soft hover:translate-y-[-2px]",
                card.borderColor,
                card.bgGradient,
              )}
            >
              <div className="flex items-start justify-between">
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-card shadow-xs">
                  <Icon className={cn("h-5 w-5", card.iconColor)} />
                </div>
                <span className="flex items-center gap-0.5 rounded-full bg-card/80 px-2.5 py-0.5 text-[0.7rem] font-bold text-foreground shadow-xs">
                  <TrendingUp className="h-3 w-3 text-emerald-500" />
                  {card.change}
                </span>
              </div>
              <div className="mt-4">
                <p className="text-xs font-semibold text-muted-foreground">{card.title}</p>
                <p className="text-2xl font-extrabold tracking-tight text-foreground mt-0.5">
                  {card.value}
                </p>
                <p className="text-[0.75rem] text-muted-foreground mt-1 flex items-center justify-between">
                  <span>{card.subtext}</span>
                  <ArrowUpRight className="h-3.5 w-3.5 opacity-0 transition-opacity group-hover:opacity-100" />
                </p>
              </div>
            </div>
          );
        })}
      </div>

      {/* Main Charts Row: Impressions Reach & Engagement Composition */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* 7-Day Impression Area Chart */}
        <div className="glass-panel rounded-3xl border border-border/80 p-5 shadow-soft lg:col-span-2">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
            <div>
              <h2 className="text-base font-bold text-foreground flex items-center gap-2">
                <Activity className="h-4 w-4 text-brand" />
                Audience Impression & Engagement Velocity
              </h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Authoritative 7-day metric tracking recorded through viewport intersection observers
              </p>
            </div>
            <div className="flex items-center gap-1 rounded-xl bg-foreground/5 p-1 text-xs">
              <button
                onClick={() => setChartMetric("impressions")}
                className={cn(
                  "rounded-lg px-2.5 py-1 font-semibold transition-colors",
                  chartMetric === "impressions"
                    ? "bg-card text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                Impressions
              </button>
              <button
                onClick={() => setChartMetric("engagement")}
                className={cn(
                  "rounded-lg px-2.5 py-1 font-semibold transition-colors",
                  chartMetric === "engagement"
                    ? "bg-card text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                Engagement
              </button>
            </div>
          </div>

          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={charts.daily_impressions}
                margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
              >
                <defs>
                  <linearGradient id="impressionGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="#ec4899" stopOpacity={0.0} />
                  </linearGradient>
                  <linearGradient id="reachGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#06b6d4" stopOpacity={0.0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="opacity-10" />
                <XAxis dataKey="date" stroke="currentColor" className="text-[0.7rem] opacity-50" />
                <YAxis stroke="currentColor" className="text-[0.7rem] opacity-50" />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "var(--card)",
                    borderColor: "var(--border)",
                    borderRadius: "1rem",
                    fontSize: "0.75rem",
                    boxShadow: "0 10px 25px -5px rgba(0,0,0,0.1)",
                  }}
                />
                {chartMetric === "impressions" ? (
                  <>
                    <Area
                      type="monotone"
                      dataKey="impressions"
                      stroke="#8b5cf6"
                      strokeWidth={2.5}
                      fillOpacity={1}
                      fill="url(#impressionGradient)"
                      name="Total Impressions"
                    />
                    <Area
                      type="monotone"
                      dataKey="unique_reach"
                      stroke="#06b6d4"
                      strokeWidth={2}
                      fillOpacity={1}
                      fill="url(#reachGradient)"
                      name="Unique Reach"
                    />
                  </>
                ) : (
                  <Area
                    type="monotone"
                    dataKey="engagement"
                    stroke="#ec4899"
                    strokeWidth={2.5}
                    fillOpacity={1}
                    fill="url(#impressionGradient)"
                    name="Interactions"
                  />
                )}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Engagement Distribution Donut */}
        <div className="glass-panel rounded-3xl border border-border/80 p-5 shadow-soft">
          <h2 className="text-base font-bold text-foreground">Engagement Breakdown</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Distribution of user actions</p>

          <div className="h-52 w-full mt-2">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={charts.engagement_distribution}
                  cx="50%"
                  cy="50%"
                  innerRadius={52}
                  outerRadius={78}
                  paddingAngle={5}
                  dataKey="value"
                >
                  {charts.engagement_distribution.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{
                    backgroundColor: "var(--card)",
                    borderColor: "var(--border)",
                    borderRadius: "0.75rem",
                    fontSize: "0.75rem",
                  }}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>

          <div className="space-y-2 mt-2">
            {charts.engagement_distribution.map((item) => (
              <div key={item.name} className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  <span
                    className="h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: item.color }}
                  />
                  <span className="text-muted-foreground">{item.name}</span>
                </div>
                <span className="font-bold text-foreground">{item.value.toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Second Charts Row: Hourly Traffic & System Telemetry */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Hourly Traffic Bar Chart */}
        <div className="glass-panel rounded-3xl border border-border/80 p-5 shadow-soft">
          <h2 className="text-base font-bold text-foreground flex items-center gap-2">
            <Zap className="h-4 w-4 text-amber-500" />
            24-Hour Request & Session Load
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">Peak traffic distribution by hour</p>

          <div className="h-56 w-full mt-4">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={charts.hourly_traffic}
                margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="opacity-10" />
                <XAxis dataKey="hour" stroke="currentColor" className="text-[0.7rem] opacity-50" />
                <YAxis stroke="currentColor" className="text-[0.7rem] opacity-50" />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "var(--card)",
                    borderColor: "var(--border)",
                    borderRadius: "0.75rem",
                    fontSize: "0.75rem",
                  }}
                />
                <Bar dataKey="requests" fill="#8b5cf6" radius={[6, 6, 0, 0]} name="Requests / Hr" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Real-time System Load Timeline */}
        <div className="glass-panel rounded-3xl border border-border/80 p-5 shadow-soft">
          <h2 className="text-base font-bold text-foreground flex items-center gap-2">
            <Activity className="h-4 w-4 text-emerald-500" />
            System Resource Timeline
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            CPU utilization and memory footprint
          </p>

          <div className="h-56 w-full mt-4">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={charts.system_load_timeline}
                margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="opacity-10" />
                <XAxis dataKey="time" stroke="currentColor" className="text-[0.7rem] opacity-50" />
                <YAxis stroke="currentColor" className="text-[0.7rem] opacity-50" />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "var(--card)",
                    borderColor: "var(--border)",
                    borderRadius: "0.75rem",
                    fontSize: "0.75rem",
                  }}
                />
                <Line type="monotone" dataKey="cpu" stroke="#f43f5e" strokeWidth={2} name="CPU %" />
                <Line
                  type="monotone"
                  dataKey="memory"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  name="Memory (MB)"
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Bottom Row: Top Creators & Category Velocity */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Top Creators Leaderboard */}
        <div className="glass-panel rounded-3xl border border-border/80 p-5 shadow-soft lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-base font-bold text-foreground flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-brand" />
                Creator Engagement Leaderboard
              </h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Top performing authors by verified impressions
              </p>
            </div>
            <button
              onClick={() => onNavigateTab("users")}
              className="text-xs font-bold text-brand hover:underline"
            >
              View all users →
            </button>
          </div>

          <div className="divide-y divide-border/60">
            {charts.top_creators.map((creator, i) => (
              <div key={creator.id} className="flex items-center justify-between py-3">
                <div className="flex items-center gap-3">
                  <span className="w-5 text-center text-xs font-black text-muted-foreground">
                    #{i + 1}
                  </span>
                  <Avatar name={creator.name} className="h-9 w-9 text-xs" />
                  <div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-bold text-foreground">{creator.name}</span>
                      {creator.verified && (
                        <span title="Verified Creator">
                          <Award className="h-3 w-3 text-brand" />
                        </span>
                      )}
                    </div>
                    <span className="text-[0.7rem] text-muted-foreground">@{creator.username}</span>
                  </div>
                </div>

                <div className="flex items-center gap-6 text-right">
                  <div>
                    <p className="text-xs font-bold text-foreground">
                      {creator.impressions.toLocaleString()}
                    </p>
                    <p className="text-[0.65rem] text-muted-foreground">Impressions</p>
                  </div>
                  <div>
                    <p className="text-xs font-bold text-foreground">
                      {creator.followers.toLocaleString()}
                    </p>
                    <p className="text-[0.65rem] text-muted-foreground">Followers</p>
                  </div>
                  <div>
                    <p className="text-xs font-bold text-foreground">{creator.posts}</p>
                    <p className="text-[0.65rem] text-muted-foreground">Posts</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Category Velocity & Quick Actions */}
        <div className="space-y-6">
          <div className="glass-panel rounded-3xl border border-border/80 p-5 shadow-soft">
            <h2 className="text-base font-bold text-foreground">Trending Category Velocity</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Fastest growing topic hubs</p>

            <div className="space-y-2.5 mt-4">
              {charts.category_velocity.map((cat) => (
                <div
                  key={cat.tag}
                  className="flex items-center justify-between rounded-2xl bg-foreground/5 p-2.5 text-xs"
                >
                  <span className="font-bold text-foreground">{cat.tag}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">{cat.count} posts</span>
                    <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 font-bold text-emerald-600 dark:text-emerald-400">
                      {cat.growth}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Quick Admin Actions */}
          <div className="glass-panel rounded-3xl border border-border/80 p-5 shadow-soft">
            <h2 className="text-base font-bold text-foreground">Governance Shortcuts</h2>
            <div className="grid grid-cols-2 gap-2 mt-3">
              <button
                onClick={() => onNavigateTab("moderation")}
                className="flex flex-col items-center gap-1.5 rounded-2xl border border-border/80 bg-card p-3 text-center transition-all hover:bg-foreground/5"
              >
                <ShieldAlert className="h-4 w-4 text-amber-500" />
                <span className="text-xs font-bold">Review Queue</span>
              </button>
              <button
                onClick={() => onNavigateTab("settings")}
                className="flex flex-col items-center gap-1.5 rounded-2xl border border-border/80 bg-card p-3 text-center transition-all hover:bg-foreground/5"
              >
                <Zap className="h-4 w-4 text-brand" />
                <span className="text-xs font-bold">Broadcast Banner</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
