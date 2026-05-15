"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ChevronLeft, ChevronRight, Loader2, AlertTriangle } from "lucide-react";

const ACTION_LABELS: Record<string, string> = {
  "":                          "Todas las acciones",
  "auth.login":                "Login",
  "auth.login_failed":         "Login fallido",
  "auth.brute_force_alert":    "Alerta de fuerza bruta",
  "auth.logout":               "Logout",
  "document.upload":           "Subió documento",
  "document.delete":           "Eliminó documento",
  "user.created":              "Usuario creado",
  "user.deactivated":          "Usuario desactivado",
  "sector.created":            "Sector creado",
  "sector.deleted":            "Sector eliminado",
  "handoff.accepted":          "Handoff aceptado",
  "handoff.transferred":       "Conversación transferida",
  "handoff.closed":            "Conversación cerrada",
  "config.bot_config_update":  "Modificó config del bot",
};

const CRITICAL_ACTIONS = new Set([
  "auth.login_failed",
  "auth.brute_force_alert",
  "document.delete",
  "user.deactivated",
  "sector.deleted",
]);

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

const PAGE_SIZE = 50;

export default function GlobalAuditPage() {
  const [page, setPage]             = useState(0);
  const [action, setAction]         = useState("");
  const [tenantFilter, setTenantFilter] = useState("");
  const [search, setSearch]         = useState("");

  const { data, isLoading, isError } = useQuery({
    queryKey: ["global-audit", page, action, tenantFilter],
    queryFn: () => api.audit.globalList({
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      action: action || undefined,
      tenant_filter: tenantFilter || undefined,
    }),
  });

  // Stats query — separate, larger window, sin filtros
  const { data: statsData } = useQuery({
    queryKey: ["global-audit-stats"],
    queryFn: () => api.audit.globalList({ limit: 500, offset: 0 }),
    staleTime: 60_000,
  });

  const kpis = useMemo(() => {
    const events = statsData?.events ?? [];
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const ts = todayStart.getTime();

    let today = 0, last24 = 0, logins = 0, failed = 0, alerts = 0;
    for (const e of events) {
      const t = new Date(e.created_at).getTime();
      if (t >= ts) today++;
      if (now - t <= dayMs) last24++;
      if (e.action === "auth.login") logins++;
      if (e.action === "auth.login_failed") failed++;
      if (e.action === "auth.brute_force_alert") alerts++;
    }
    return { today, last24, logins, failed, alerts, total: statsData?.total ?? 0 };
  }, [statsData]);

  const filteredEvents = useMemo(() => {
    if (!data) return [];
    if (!search.trim()) return data.events;
    const q = search.trim().toLowerCase();
    return data.events.filter(e =>
      (e.actor_email ?? "").toLowerCase().includes(q) ||
      (e.actor_id ?? "").toLowerCase().includes(q) ||
      (e.resource ?? "").toLowerCase().includes(q) ||
      (e.tenant_id ?? "").toLowerCase().includes(q) ||
      (e.ip_address ?? "").toLowerCase().includes(q)
    );
  }, [data, search]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const hasAlertsOnPage = data?.events.some(e => e.action === "auth.brute_force_alert");

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Auditoría global</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Actividad de todas las organizaciones de la plataforma
          {kpis.total > 0 && <> · <span className="font-medium text-foreground">{kpis.total}</span> eventos en total</>}
        </p>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <Kpi label="Hoy"             value={kpis.today} />
        <Kpi label="Últimas 24h"     value={kpis.last24} />
        <Kpi label="Logins"          value={kpis.logins} />
        <Kpi label="Logins fallidos" value={kpis.failed} tone={kpis.failed > 0 ? "warn" : "neutral"} />
        <Kpi label="Alertas"         value={kpis.alerts} tone={kpis.alerts > 0 ? "danger" : "neutral"} />
      </div>

      {/* Brute force banner */}
      {hasAlertsOnPage && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-2.5 flex items-center gap-2 text-sm text-red-700">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          Hay intentos de fuerza bruta en esta página. Revisá las filas marcadas en rojo.
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
        <Input
          placeholder="Buscar por usuario, recurso, org o IP…"
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
        {data?.tenants && data.tenants.length > 1 && (
          <select
            value={tenantFilter}
            onChange={e => { setTenantFilter(e.target.value); setPage(0); }}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="">Todas las orgs</option>
            {data.tenants.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        )}
      </div>

      {/* Table */}
      <div className="rounded-md border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40">
              <tr className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-2 font-medium w-[160px]">Fecha</th>
                <th className="px-4 py-2 font-medium w-[120px]">Org</th>
                <th className="px-4 py-2 font-medium">Usuario</th>
                <th className="px-4 py-2 font-medium w-[110px]">Perfil</th>
                <th className="px-4 py-2 font-medium w-[200px]">Acción</th>
                <th className="px-4 py-2 font-medium">Recurso</th>
                <th className="px-4 py-2 font-medium w-[120px]">IP</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading && (
                <tr><td colSpan={7} className="py-12 text-center text-muted-foreground">
                  <Loader2 className="w-5 h-5 animate-spin inline" />
                </td></tr>
              )}
              {isError && (
                <tr><td colSpan={7} className="py-8 text-center text-destructive">
                  No se pudo cargar el registro global.
                </td></tr>
              )}
              {data && filteredEvents.length === 0 && (
                <tr><td colSpan={7} className="py-8 text-center text-muted-foreground">
                  {search ? "Ningún evento coincide con la búsqueda." : "No hay eventos registrados."}
                </td></tr>
              )}
              {filteredEvents.map(ev => {
                const isCritical = CRITICAL_ACTIONS.has(ev.action);
                return (
                  <tr key={ev.id} className={isCritical ? "bg-red-50/60 hover:bg-red-50" : "hover:bg-muted/30"}>
                    <td className="px-4 py-2.5 align-top whitespace-nowrap font-mono text-xs text-muted-foreground">
                      {fmtDate(ev.created_at)}
                    </td>
                    <td className="px-4 py-2.5 align-top">
                      <span className="inline-block rounded-sm border border-border bg-muted/60 px-1.5 py-0.5 text-[11px] font-mono text-foreground">
                        {ev.tenant_id}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 align-top">
                      <div className="font-medium truncate max-w-[260px]">
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
                      <div className="font-mono text-xs truncate max-w-[280px]">
                        {ev.resource ?? <span className="text-muted-foreground">—</span>}
                      </div>
                      {ev.detail && (
                        <div className="text-xs text-muted-foreground truncate max-w-[280px]">
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
