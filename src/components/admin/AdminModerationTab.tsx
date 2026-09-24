import { useState, useEffect } from "react";
import {
  AlertTriangle,
  ShieldCheck,
  ShieldAlert,
  Trash2,
  UserX,
  CheckCircle2,
  XCircle,
  Clock,
  Filter,
  Eye,
  MessageSquare,
  Radio,
  FileText,
  User,
  RefreshCw,
} from "lucide-react";
import {
  getAdminReports,
  updateReportStatus,
  forceDeletePostAdmin,
  updateUserAdmin,
} from "@/lib/api-client";
import { useRealtime } from "@/lib/realtime";
import type { ModerationReport, UserRole } from "@/lib/types";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface AdminModerationTabProps {
  activeRole: UserRole;
  currentUserId: string;
}

export function AdminModerationTab({ activeRole, currentUserId }: AdminModerationTabProps) {
  const [reports, setReports] = useState<ModerationReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedStatus, setSelectedStatus] = useState<string>("pending");
  const [selectedType, setSelectedType] = useState<string>("all");
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  const fetchReports = async () => {
    try {
      setLoading(true);
      const res = await getAdminReports({
        status: selectedStatus !== "all" ? selectedStatus : undefined,
        target_type: selectedType !== "all" ? selectedType : undefined,
      });
      setReports(res);
    } catch (err) {
      console.error("Failed to load reports", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchReports();
  }, [selectedStatus, selectedType]);

  useRealtime({
    "report:created": (newReport: ModerationReport) => {
      setReports((prev) => [newReport, ...prev]);
    },
    "report:updated": (updatedReport: ModerationReport) => {
      setReports((prev) => prev.map((r) => (r.id === updatedReport.id ? updatedReport : r)));
    },
  });

  const showToast = (msg: string) => {
    setActionNotice(msg);
    toast.success(msg);
    setTimeout(() => setActionNotice(null), 3500);
  };

  const handleUpdateReport = async (
    reportId: string,
    status: ModerationReport["status"],
    actionTaken: string,
  ) => {
    try {
      const updated = await updateReportStatus(reportId, status, actionTaken, currentUserId);
      setReports((prev) => prev.map((r) => (r.id === reportId ? updated : r)));
      showToast(`Report updated: ${actionTaken}`);
    } catch (err: any) {
      toast.error(err.message || "Failed to update report");
    }
  };

  const handleForceDeleteAndResolve = async (report: ModerationReport) => {
    try {
      if (report.target_type === "post") {
        await forceDeletePostAdmin(report.target_id, currentUserId);
      }
      await updateReportStatus(
        report.id,
        "resolved",
        `Content removed by moderator (${activeRole}).`,
        currentUserId,
      );
      setReports((prev) =>
        prev.map((r) =>
          r.id === report.id
            ? { ...r, status: "resolved", action_taken: "Content removed by moderator." }
            : r,
        ),
      );
      showToast(`Content purged and report marked resolved.`);
    } catch (err: any) {
      toast.error(err.message || "Action failed");
    }
  };

  const handleWarnAuthorAndResolve = async (report: ModerationReport) => {
    if (!report.author_id) {
      toast.error("Author not identified on this report");
      return;
    }
    try {
      await updateUserAdmin(report.author_id, { warning_count: 1 }, currentUserId);
      await updateReportStatus(
        report.id,
        "resolved",
        `Official warning issued to author.`,
        currentUserId,
      );
      showToast(`Warning issued to author and report resolved.`);
    } catch (err: any) {
      toast.error(err.message || "Action failed");
    }
  };

  const canModerate = ["superadmin", "admin", "moderator"].includes(activeRole);

  const getTargetIcon = (type: string) => {
    switch (type) {
      case "post":
        return FileText;
      case "user":
        return User;
      case "space":
        return Radio;
      case "comment":
        return MessageSquare;
      default:
        return AlertTriangle;
    }
  };

  const statusBadge = (status: ModerationReport["status"]) => {
    const config = {
      pending: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
      investigating: "bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30",
      resolved: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
      dismissed: "bg-muted/50 text-muted-foreground border-border",
    }[status];

    return (
      <span
        className={cn(
          "inline-flex items-center rounded-full border px-2.5 py-0.5 text-[0.68rem] font-bold capitalize",
          config,
        )}
      >
        {status}
      </span>
    );
  };

  return (
    <div className="space-y-6">
      {/* Toast Notice */}
      {actionNotice && (
        <div className="flex items-center gap-2 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-xs font-semibold text-emerald-800 dark:text-emerald-200 shadow-soft animate-in fade-in slide-in-from-top-2">
          <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
          <span>{actionNotice}</span>
        </div>
      )}

      {/* Filter Tabs */}
      <div className="glass-panel flex flex-col gap-4 rounded-3xl border border-border/80 p-4 shadow-soft md:flex-row md:items-center md:justify-between">
        <div className="flex flex-wrap items-center gap-1.5">
          {(["pending", "investigating", "resolved", "dismissed", "all"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setSelectedStatus(tab)}
              className={cn(
                "rounded-2xl px-3.5 py-2 text-xs font-bold capitalize transition-colors",
                selectedStatus === tab
                  ? "bg-brand text-white shadow-soft"
                  : "bg-foreground/5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground",
              )}
            >
              {tab}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-muted-foreground">Type:</span>
          <select
            value={selectedType}
            onChange={(e) => setSelectedType(e.target.value)}
            className="rounded-2xl border border-border bg-background/80 px-3 py-2 text-xs font-semibold text-foreground focus:outline-none"
          >
            <option value="all">All Content</option>
            <option value="post">Posts</option>
            <option value="user">Profiles</option>
            <option value="story">Stories</option>
            <option value="space">Spaces</option>
            <option value="comment">Comments</option>
          </select>

          <button
            onClick={fetchReports}
            className="flex items-center gap-1.5 rounded-2xl border border-border bg-card px-3 py-2 text-xs font-semibold text-foreground hover:bg-foreground/5"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin text-brand")} />
          </button>
        </div>
      </div>

      {/* Report Cards Queue */}
      <div className="space-y-4">
        {loading ? (
          <div className="glass-panel py-16 text-center text-muted-foreground rounded-3xl">
            <RefreshCw className="mx-auto h-6 w-6 animate-spin text-brand mb-2" />
            Loading moderation queue...
          </div>
        ) : reports.length === 0 ? (
          <div className="glass-panel rounded-3xl border border-border/80 py-16 text-center shadow-soft">
            <ShieldCheck className="mx-auto h-12 w-12 text-emerald-500/80 mb-3" />
            <h3 className="text-base font-extrabold text-foreground">Queue is Clear</h3>
            <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
              No reports currently match the selected status ({selectedStatus}) and content filter.
            </p>
          </div>
        ) : (
          reports.map((report) => {
            const TargetIcon = getTargetIcon(report.target_type);

            return (
              <div
                key={report.id}
                className="glass-panel rounded-3xl border border-border/80 p-5 shadow-soft transition-all"
              >
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  {/* Left Column: Report Context & Content Preview */}
                  <div className="space-y-3 min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="flex items-center gap-1 rounded-xl bg-foreground/5 px-2.5 py-1 text-[0.7rem] font-bold text-foreground capitalize">
                        <TargetIcon className="h-3 w-3 text-brand" />
                        {report.target_type}
                      </span>
                      <span className="rounded-xl bg-rose-500/15 border border-rose-500/30 px-2.5 py-1 text-[0.7rem] font-extrabold text-rose-700 dark:text-rose-300 uppercase tracking-wider">
                        {report.reason}
                      </span>
                      {statusBadge(report.status)}
                      <span className="text-[0.7rem] text-muted-foreground flex items-center gap-1 ml-auto">
                        <Clock className="h-3 w-3" />
                        {new Date(report.created_at).toLocaleString()}
                      </span>
                    </div>

                    {/* Reported Target Preview */}
                    <div className="rounded-2xl border border-border/80 bg-foreground/5 p-3.5">
                      <div className="flex items-center justify-between text-[0.72rem] text-muted-foreground mb-1">
                        <span>
                          Target Preview (ID:{" "}
                          <code className="font-mono text-foreground">{report.target_id}</code>)
                        </span>
                        {report.author_name && (
                          <span>
                            Author:{" "}
                            <strong className="text-foreground">{report.author_name}</strong>
                          </span>
                        )}
                      </div>
                      <p className="text-xs font-medium text-foreground italic">
                        "{report.target_preview || "(Target payload attached in review context)"}"
                      </p>
                    </div>

                    {/* Reporter context & notes */}
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span>
                        Reported by:{" "}
                        <strong className="text-foreground">{report.reporter_name}</strong>
                      </span>
                      {report.details && (
                        <span>
                          · Reason detail: <span className="text-foreground">{report.details}</span>
                        </span>
                      )}
                    </div>

                    {report.action_taken && (
                      <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/20 p-2.5 text-xs text-emerald-800 dark:text-emerald-300 flex items-center gap-2">
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                        <span>
                          <strong>Resolution:</strong> {report.action_taken}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Right Column: Moderation Action Controls */}
                  {canModerate && (
                    <div className="flex flex-wrap lg:flex-col items-stretch gap-2 shrink-0 lg:w-56 pt-2 lg:pt-0 border-t lg:border-t-0 lg:border-l border-border/60 lg:pl-4">
                      {report.status !== "resolved" && (
                        <>
                          <button
                            onClick={() => handleForceDeleteAndResolve(report)}
                            className="flex items-center justify-center gap-1.5 rounded-2xl bg-rose-600 px-3 py-2 text-xs font-bold text-white shadow-soft hover:bg-rose-700 active:scale-[0.98]"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            <span>Remove Content</span>
                          </button>

                          {report.author_id && (
                            <button
                              onClick={() => handleWarnAuthorAndResolve(report)}
                              className="flex items-center justify-center gap-1.5 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs font-bold text-amber-800 dark:text-amber-200 hover:bg-amber-500/20"
                            >
                              <ShieldAlert className="h-3.5 w-3.5 text-amber-600" />
                              <span>Issue Warning</span>
                            </button>
                          )}
                        </>
                      )}

                      {report.status === "pending" && (
                        <button
                          onClick={() =>
                            handleUpdateReport(
                              report.id,
                              "investigating",
                              "Investigating by moderator",
                            )
                          }
                          className="flex items-center justify-center gap-1.5 rounded-2xl border border-border bg-card px-3 py-2 text-xs font-semibold text-foreground hover:bg-foreground/5"
                        >
                          <Eye className="h-3.5 w-3.5 text-blue-500" />
                          <span>Mark Investigating</span>
                        </button>
                      )}

                      {report.status !== "dismissed" && (
                        <button
                          onClick={() =>
                            handleUpdateReport(
                              report.id,
                              "dismissed",
                              "Dismissed as false report / non-violative",
                            )
                          }
                          className="flex items-center justify-center gap-1.5 rounded-2xl border border-border/60 bg-transparent px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                        >
                          <XCircle className="h-3.5 w-3.5" />
                          <span>Dismiss Report</span>
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
