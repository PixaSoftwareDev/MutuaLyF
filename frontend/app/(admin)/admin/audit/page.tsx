"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";

const ACTION_LABELS: Record<string, string> = {
  "":                          "Todas las acciones",
  "auth.login":                "Login",
  "auth.logout":               "Logout",
  "document.upload":           "Subió documento",
  "document.delete":           "Eliminó documento",
  "config.bot_config_update":  "Modificó config del bot",
};

const CRITICAL_ACTIONS = new Set(["document.delete", "auth.login_failed", "auth.brute_force_alert"]);

function actionLabel(a: string) {
  return ACTION_LABELS[a] ?? a;
}

function fmtDate(iso: string) {
  const d = new Date(iso);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${dd}/${mm} ${hh}:${mi}:${ss}`;
}

const PAGE_SIZE = 30;

export default function AuditPage() {
  const [page, setPage]     = useState(0);
  const [action, setAction] = useState("");
  const [search, setSearch] = useState("");

  const { data, isLoading, isError } = useQuery({
    queryKey: ["audit", page, action],
    queryFn: () => api.audit.list({ limit: PAGE_SIZE, offset: page * PAGE_SIZE, action: action || undefined }),
  });

  // Stats query — separate, larger window, sin filtros, para KPIs estables
  const { data: statsData } = useQuery({
    queryKey: ["audit-stats"],
    queryFn: () => api.audit.list({ limit: 500, offset: 0 }),
    staleTime: 60_000,
  });

  const kpis = useMemo(() => {
    const events = statsData?.events ?? [];
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const ts = todayStart.getTime();

    let today = 0, last24 = 0, logins = 0, failed = 0;
    for (const e of events) {
      const t = new Date(e.created_at).getTime();
      if (t >= ts) today++;
      if (now - t <= dayMs) last24++;
      if (e.action === "auth.login") logins++;
      if (e.action === "auth.login_failed") failed++;
    }
    return { today, last24, logins, failed, total: statsData?.total ?? 0 };
  }, [statsData]);

  const filteredEvents = useMemo(() => {
    if (!data) return [];
    if (!search.trim()) return data.events;
    const q = search.trim().toLowerCase();
    return data.events.filter(e =>
      (e.actor_email ?? "").toLowerCase().includes(q) ||
      (e.actor_id ?? "").toLowerCase().includes(q) ||
      (e.resource ?? "").toLowerCase().includes(q) ||
      (e.ip_address ?? "").toLowerCase().includes(q)
    );
  }, [data, search]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto space-y-4 sm:space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-lg sm:text-xl font-semibold tracking-tight">Registro de auditoría</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Acciones realizadas por usuarios de este tenant
          {kpis.total > 0 && <> · <span className="font-medium text-foreground">{kpis.total}</span> eventos en total</>}
        </p>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
        <Kpi label="Hoy"             value={kpis.today} />
        <Kpi label="Últimas 24h"     value={kpis.last24} />
        <Kpi label="Logins"          value={kpis.logins} />
        <Kpi label="Logins fallidos" value={kpis.failed} tone={kpis.failed > 0 ? "warn" : "neutral"} />
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
        <Input
          placeholder="Buscar por usuario, recurso o IP…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="sm:max-w-sm h-9"
        />
        <select
          value={action}
          onChange={e => { setAction(e.target.value); setPage(0); }}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
        >
          {Object.entries(ACTION_LABELS).map(([val, label]) => (
            <option key={val} value={val}>{label}</option>
          ))}
        </select>
      </div>

      {/* Table — scroll on mobile, full on desktop */}
      <div className="rounded-md border overflow-hidden">
        {isLoading && (
          <div className="py-12 text-center text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin inline" />
          </div>
        )}
        {isError && (
          <div className="py-8 text-center text-destructive text-sm">No se pudo cargar el registro.</div>
        )}
        {data && filteredEvents.length === 0 && (
          <div className="py-8 text-center text-muted-foreground text-sm">
            {search ? "Ningún evento coincide con la búsqueda." : "No hay eventos registrados."}
          </div>
        )}

        {/* Mobile cards */}
        {filteredEvents.length > 0 && (
          <div className="sm:hidden divide-y">
            {filteredEvents.map(ev => {
              const isCritical = CRITICAL_ACTIONS.has(ev.action);
              return (
                <div key={ev.id} className={`px-4 py-3 space-y-1.5 ${isCritical ? "bg-red-50/60" : ""}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs text-muted-foreground">{fmtDate(ev.created_at)}</span>
                    <RoleBadge role={ev.actor_role} />
                  </div>
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-sm font-medium truncate">{ev.actor_email ?? "—"}</span>
                    <span className={`text-xs shrink-0 ${isCritical ? "text-red-700 font-medium" : "text-muted-foreground"}`}>
                      {actionLabel(ev.action)}
                    </span>
                  </div>
                  {(ev.resource || ev.detail) && (
                    <div className="text-xs text-muted-foreground font-mono truncate">
                      {ev.resource ?? ""}
                      {ev.detail && <span className="ml-1 not-italic">
                        {Object.entries(ev.detail).map(([k, v]) => `${k}: ${v}`).join(" · ")}
                      </span>}
                    </div>
                  )}
                  {ev.ip_address && (
                    <div className="text-xs text-muted-foreground font-mono">{ev.ip_address}</div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Desktop table */}
        {filteredEvents.length > 0 && (
          <div className="hidden sm:block overflow-x-auto">
            <table className="w-full text-sm min-w-[700px]">
              <thead className="bg-muted/40">
                <tr className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="px-4 py-2 font-medium w-[145px]">Fecha</th>
                  <th className="px-4 py-2 font-medium">Usuario</th>
                  <th className="px-4 py-2 font-medium w-[100px]">Perfil</th>
                  <th className="px-4 py-2 font-medium w-[180px]">Acción</th>
                  <th className="px-4 py-2 font-medium">Recurso</th>
                  <th className="px-4 py-2 font-medium w-[110px]">IP</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {filteredEvents.map(ev => {
                  const isCritical = CRITICAL_ACTIONS.has(ev.action);
                  return (
                    <tr key={ev.id} className={isCritical ? "bg-red-50/60 hover:bg-red-50" : "hover:bg-muted/30"}>
                      <td className="px-4 py-2.5 align-top whitespace-nowrap font-mono text-xs text-muted-foreground">
                        {fmtDate(ev.created_at)}
                      </td>
                      <td className="px-4 py-2.5 align-top">
                        <div className="font-medium truncate max-w-[220px]">
                          {ev.actor_email ?? <span className="text-muted-foreground">—</span>}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 align-top">
                        <RoleBadge role={ev.actor_role} />
                      </td>
                      <td className={`px-4 py-2.5 align-top ${isCritical ? "text-red-700 font-medium" : ""}`}>
                        {actionLabel(ev.action)}
                      </td>
                      <td className="px-4 py-2.5 align-top">
                        <div className="font-mono text-xs truncate max-w-[240px]">
                          {ev.resource ?? <span className="text-muted-foreground">—</span>}
                        </div>
                        {ev.detail && (
                          <div className="text-xs text-muted-foreground truncate max-w-[240px]">
                            {Object.entries(ev.detail).map(([k, v]) => `${k}: ${v}`).join(" · ")}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2.5 align-top font-mono text-xs text-muted-foreground whitespace-nowrap">
                        {ev.ip_address ?? "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pagination */}
      {data && totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>Página {page + 1} de {totalPages}</span>
          <div className="flex gap-1">
            <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(p => p - 1)}>
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <Button size="sm" variant="outline" disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Kpi({ label, value, tone = "neutral" }: { label: string; value: number; tone?: "neutral" | "warn" | "danger" }) {
  const accent =
    tone === "danger" ? "before:bg-red-700" :
    tone === "warn"   ? "before:bg-red-500" :
                        "before:bg-primary";
  const numColor = tone === "neutral" ? "text-foreground" : "text-red-700";
  return (
    <div
      className={`relative bg-card border border-border rounded-md pl-4 pr-4 py-3 shadow-[0_1px_0_rgba(0,0,0,0.02)] before:content-[''] before:absolute before:left-0 before:top-0 before:bottom-0 before:w-1 before:rounded-l-md ${accent}`}
    >
      <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums leading-none ${numColor}`}>
        {value.toLocaleString("es-AR")}
      </div>
    </div>
  );
}

function RoleBadge({ role }: { role: string }) {
  if (!role) return <span className="text-xs text-muted-foreground">—</span>;
  const styles: Record<string, string> = {
    super_admin: "border-primary/30 bg-primary/5 text-primary",
    admin:       "border-slate-300 bg-slate-50 text-slate-700",
    operator:    "border-blue-200 bg-blue-50 text-blue-700",
  };
  const label: Record<string, string> = {
    super_admin: "Super admin",
    admin:       "Admin",
    operator:    "Operador",
  };
  return (
    <span className={`inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[11px] font-medium ${styles[role] ?? "border-slate-300 bg-slate-50 text-slate-700"}`}>
      {label[role] ?? role}
    </span>
  );
}
