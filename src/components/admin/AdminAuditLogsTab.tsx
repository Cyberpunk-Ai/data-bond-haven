import { useState, useEffect } from "react";
import {
  FileText,
  Search,
  Filter,
  Download,
  Shield,
  Clock,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  AlertCircle,
  Terminal,
} from "lucide-react";
import { getAdminAuditLogs } from "@/lib/api-client";
import { useRealtime } from "@/lib/realtime";
import type { AuditLog, UserRole } from "@/lib/types";
import { cn } from "@/lib/utils";

interface AdminAuditLogsTabProps {
  activeRole: UserRole;
}

export function AdminAuditLogsTab({ activeRole }: AdminAuditLogsTabProps) {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedSeverity, setSelectedSeverity] = useState<string>("all");

  const fetchLogs = async () => {
    try {
      setLoading(true);
      const res = await getAdminAuditLogs({
        limit: 100,
        severity: selectedSeverity !== "all" ? selectedSeverity : undefined,
      });
      setLogs(res);
    } catch (err) {
      console.error("Failed to load audit logs", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLogs();
  }, [selectedSeverity]);

  useRealtime({
    "audit:created": (newLog: AuditLog) => {
      setLogs((prev) => [newLog, ...prev]);
    },
  });

  const filteredLogs = logs.filter((log) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      log.action.toLowerCase().includes(q) ||
      log.actor_name.toLowerCase().includes(q) ||
      log.details.toLowerCase().includes(q) ||
      log.target_type.toLowerCase().includes(q) ||
      log.ip_address.includes(q)
    );
  });

  const exportAsJSON = () => {
    const dataStr =
      "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(logs, null, 2));
    const downloadAnchor = document.createElement("a");
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute(
      "download",
      `spaces_audit_logs_${new Date().toISOString().slice(0, 10)}.json`,
    );
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  const exportAsCSV = () => {
    const headers = [
      "ID",
      "Timestamp",
      "Actor",
      "Role",
      "Action",
      "Target Type",
      "Target ID",
      "Severity",
      "Details",
      "IP",
    ];
    const rows = logs.map((l) => [
      l.id,
      l.created_at,
      `"${l.actor_name}"`,
      l.actor_role,
      l.action,
      l.target_type,
      l.target_id,
      l.severity,
      `"${l.details.replace(/"/g, '""')}"`,
      l.ip_address,
    ]);
    const csvContent =
      "data:text/csv;charset=utf-8," +
      [headers.join(","), ...rows.map((e) => e.join(","))].join("\n");
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `spaces_audit_logs_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  const severityBadge = (severity: AuditLog["severity"]) => {
    const config = {
      info: "bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30",
      warning: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
      danger: "bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/30",
      success: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
    }[severity || "info"];

    return (
      <span
        className={cn(
          "inline-flex items-center rounded-full border px-2 py-0.2 text-[0.65rem] font-extrabold uppercase tracking-wider",
          config,
        )}
      >
        {severity}
      </span>
    );
  };

  return (
    <div className="space-y-6">
      {/* Controls Bar */}
      <div className="glass-panel flex flex-col gap-3 rounded-3xl border border-border/80 p-4 shadow-soft md:flex-row md:items-center md:justify-between">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search action, actor, IP, or details..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-2xl border border-border bg-background/80 py-2 pl-9 pr-4 text-xs font-medium text-foreground placeholder:text-muted-foreground focus:outline-none"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={selectedSeverity}
            onChange={(e) => setSelectedSeverity(e.target.value)}
            className="rounded-2xl border border-border bg-background/80 px-3 py-2 text-xs font-semibold text-foreground focus:outline-none"
          >
            <option value="all">All Severities</option>
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="danger">Danger</option>
            <option value="success">Success</option>
          </select>

          <button
            onClick={fetchLogs}
            className="rounded-2xl border border-border bg-card p-2 text-foreground hover:bg-foreground/5"
            title="Refresh logs"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin text-brand")} />
          </button>

          <div className="flex items-center gap-1">
            <button
              onClick={exportAsJSON}
              className="flex items-center gap-1.5 rounded-2xl border border-border bg-card px-3 py-2 text-xs font-semibold text-foreground hover:bg-foreground/5"
              title="Download JSON Export"
            >
              <Download className="h-3.5 w-3.5" />
              <span>JSON</span>
            </button>
            <button
              onClick={exportAsCSV}
              className="flex items-center gap-1.5 rounded-2xl border border-border bg-card px-3 py-2 text-xs font-semibold text-foreground hover:bg-foreground/5"
              title="Download CSV Export"
            >
              <Download className="h-3.5 w-3.5" />
              <span>CSV</span>
            </button>
          </div>
        </div>
      </div>

      {/* Audit Log Table */}
      <div className="glass-panel overflow-hidden rounded-3xl border border-border/80 shadow-soft">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-border/60 bg-foreground/5 text-muted-foreground uppercase tracking-wider font-bold text-[0.68rem]">
              <tr>
                <th className="px-5 py-3.5">Timestamp</th>
                <th className="px-4 py-3.5">Severity</th>
                <th className="px-4 py-3.5">Actor & Role</th>
                <th className="px-4 py-3.5">Action</th>
                <th className="px-4 py-3.5">Target</th>
                <th className="px-4 py-3.5">Details</th>
                <th className="px-5 py-3.5 text-right">Origin IP</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60 font-mono text-[0.72rem]">
              {loading ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-muted-foreground font-sans">
                    <RefreshCw className="mx-auto h-5 w-5 animate-spin text-brand mb-2" />
                    Fetching audit trail...
                  </td>
                </tr>
              ) : filteredLogs.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-muted-foreground font-sans">
                    No matching audit records found.
                  </td>
                </tr>
              ) : (
                filteredLogs.map((log) => (
                  <tr key={log.id} className="transition-colors hover:bg-foreground/5">
                    <td className="px-5 py-3.5 text-muted-foreground whitespace-nowrap">
                      {new Date(log.created_at).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      })}
                    </td>
                    <td className="px-4 py-3.5 whitespace-nowrap">{severityBadge(log.severity)}</td>
                    <td className="px-4 py-3.5 whitespace-nowrap font-sans font-semibold text-foreground">
                      <span>{log.actor_name}</span>
                      <span className="text-[0.65rem] text-muted-foreground ml-1.5">
                        ({log.actor_role})
                      </span>
                    </td>
                    <td className="px-4 py-3.5 font-bold text-foreground whitespace-nowrap">
                      {log.action}
                    </td>
                    <td className="px-4 py-3.5 text-muted-foreground whitespace-nowrap">
                      <span className="capitalize">{log.target_type}</span>: {log.target_id}
                    </td>
                    <td className="px-4 py-3.5 max-w-xs truncate font-sans text-foreground">
                      {log.details}
                    </td>
                    <td className="px-5 py-3.5 text-right text-muted-foreground whitespace-nowrap">
                      {log.ip_address}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
