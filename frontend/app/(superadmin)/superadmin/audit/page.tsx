"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { EmptyState } from "@/components/ui/empty-state";
import { ChevronLeft, ChevronRight, Loader2, AlertTriangle, FileSearch, Search } from "lucide-react";
import { PageShell } from "@/components/layout/page-shell";
import { PageHeader, CountChip } from "@/components/layout/page-header";

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
  const [dateFrom, setDateFrom]     = useState("");
  const [dateTo, setDateTo]         = useState("");

  const { data, isLoading, isError } = useQuery({
    queryKey: ["global-audit", page, action, tenantFilter, dateFrom, dateTo],
    queryFn: () => api.audit.globalList({
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      action: action || undefined,
      tenant_filter: tenantFilter || undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
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

    // Todas las señales acotadas a 24h — un número sin ventana temporal no
    // dice nada ("Logins 160" ¿de cuándo?).
    let today = 0, logins24 = 0, failed24 = 0, alerts24 = 0;
    for (const e of events) {
      const t = new Date(e.created_at).getTime();
      if (t >= ts) today++;
      if (now - t <= dayMs) {
        if (e.action === "auth.login") logins24++;
        if (e.action === "auth.login_failed") failed24++;
        if (e.action === "auth.brute_force_alert") alerts24++;
      }
    }
    return { today, logins24, failed24, alerts24, total: statsData?.total ?? 0 };
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
    <PageShell>
      <PageHeader
        eyebrow="Plataforma"
        title="Auditoría global"
        badge={kpis.total > 0
          ? <CountChip>{kpis.total.toLocaleString("es-AR")} eventos</CountChip>
          : undefined}
        description="Actividad de todas las organizaciones de la plataforma."
      />

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
        <Kpi label="Eventos hoy"          value={kpis.today} />
        <Kpi label="Logins · 24h"         value={kpis.logins24} />
        <Kpi label="Logins fallidos · 24h" value={kpis.failed24} tone={kpis.failed24 > 0 ? "warn" : "neutral"} />
        <Kpi label="Fuerza bruta · 24h"   value={kpis.alerts24} tone={kpis.alerts24 > 0 ? "danger" : "neutral"} />
      </div>

      {/* Brute force banner */}
      {hasAlertsOnPage && (
        <div className="rounded-xl border border-destructive/20 bg-destructive/10 px-4 py-2.5 flex items-center gap-2 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          Se detectaron alertas de fuerza bruta en estos resultados — son las filas marcadas en rojo.
        </div>
      )}

      {/* Filters — una sola fila; flex-wrap baja grupos enteros en anchos chicos */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Buscar por usuario, recurso, org o IP…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="h-9 pl-8"
          />
        </div>
        <Select
          value={action || "__all__"}
          onValueChange={v => { setAction(v === "__all__" ? "" : v); setPage(0); }}
        >
          <SelectTrigger className="h-9 w-auto min-w-[180px] text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(ACTION_LABELS).map(([val, label]) => (
              <SelectItem key={val || "__all__"} value={val || "__all__"}>{label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {data?.tenants && data.tenants.length > 1 && (
          <Select
            value={tenantFilter || "__all__"}
            onValueChange={v => { setTenantFilter(v === "__all__" ? "" : v); setPage(0); }}
          >
            <SelectTrigger className="h-9 w-auto min-w-[140px] text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">Todas las orgs</SelectItem>
              {data.tenants.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
            </SelectContent>
          </Select>
        )}

        {/* Rango de fechas — filtra en el servidor (no solo la página actual) */}
        <div className="flex items-center gap-1.5">
          <Input
            type="date" aria-label="Desde" value={dateFrom} max={dateTo || undefined}
            onChange={e => { setDateFrom(e.target.value); setPage(0); }}
            className="h-9 w-[8.5rem] px-2 text-sm"
          />
          <span className="text-xs text-muted-foreground" aria-hidden>→</span>
          <Input
            type="date" aria-label="Hasta" value={dateTo} min={dateFrom || undefined}
            onChange={e => { setDateTo(e.target.value); setPage(0); }}
            className="h-9 w-[8.5rem] px-2 text-sm"
          />
          {(dateFrom || dateTo) && (
            <Button
              variant="ghost" size="sm" className="h-9 px-2 text-muted-foreground"
              onClick={() => { setDateFrom(""); setDateTo(""); setPage(0); }}
            >
              Limpiar
            </Button>
          )}
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground -mt-2">
        La búsqueda de texto mira solo la página actual; acción, organización y fechas filtran el conjunto completo.
      </p>

      {/* Table */}
      <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
        {isLoading && (
          <div className="py-12 text-center text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin inline" />
          </div>
        )}
        {isError && (
          <EmptyState
            icon={AlertTriangle}
            title="No se pudo cargar el registro global"
          />
        )}
        {data && filteredEvents.length === 0 && (
          <EmptyState
            icon={FileSearch}
            title={search ? "Sin coincidencias" : "No hay eventos registrados"}
            description={search ? "Ningún evento coincide con la búsqueda." : undefined}
          />
        )}

        {/* Mobile cards */}
        {filteredEvents.length > 0 && (
          <div className="sm:hidden divide-y">
            {filteredEvents.map(ev => {
              const isCritical = CRITICAL_ACTIONS.has(ev.action);
              return (
                <div key={ev.id} className={`px-4 py-3 space-y-1.5 ${isCritical ? "bg-destructive/5" : ""}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs text-muted-foreground">{fmtDate(ev.created_at)}</span>
                    <div className="flex items-center gap-1.5">
                      <span className="inline-block rounded-sm border border-border bg-muted/60 px-1.5 py-0.5 text-[11px] font-mono text-foreground">
                        {ev.tenant_id}
                      </span>
                      <RoleBadge role={ev.actor_role} />
                    </div>
                  </div>
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-sm font-medium truncate">{ev.actor_email ?? "—"}</span>
                    <span className={`text-xs shrink-0 ${isCritical ? "text-destructive font-medium" : "text-muted-foreground"}`}>
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
            <Table className="min-w-[800px]">
              <TableHeader className="bg-muted/40">
                <TableRow className="hover:bg-muted/40">
                  <TableHead className="w-[145px]">Fecha</TableHead>
                  <TableHead className="w-[110px]">Org</TableHead>
                  <TableHead>Usuario</TableHead>
                  <TableHead className="w-[100px]">Perfil</TableHead>
                  <TableHead className="w-[190px]">Acción</TableHead>
                  <TableHead>Recurso</TableHead>
                  <TableHead className="w-[110px]">IP</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="divide-y">
                {filteredEvents.map(ev => {
                  const isCritical = CRITICAL_ACTIONS.has(ev.action);
                  return (
                    <TableRow key={ev.id} className={isCritical ? "bg-destructive/5 hover:bg-destructive/10" : ""}>
                      <TableCell className="align-top whitespace-nowrap font-mono text-xs text-muted-foreground">
                        {fmtDate(ev.created_at)}
                      </TableCell>
                      <TableCell className="align-top">
                        <span className="inline-block rounded-sm border border-border bg-muted/60 px-1.5 py-0.5 text-[11px] font-mono text-foreground">
                          {ev.tenant_id}
                        </span>
                      </TableCell>
                      <TableCell className="align-top">
                        <div className="font-medium truncate max-w-[260px]">
                          {ev.actor_email ?? <span className="text-muted-foreground">—</span>}
                        </div>
                      </TableCell>
                      <TableCell className="align-top">
                        <RoleBadge role={ev.actor_role} />
                      </TableCell>
                      <TableCell className={`align-top ${isCritical ? "text-destructive font-medium" : ""}`}>
                        {actionLabel(ev.action)}
                      </TableCell>
                      <TableCell className="align-top">
                        <div className="font-mono text-xs truncate max-w-[280px]">
                          {ev.resource ?? <span className="text-muted-foreground">—</span>}
                        </div>
                        {ev.detail && (
                          <div className="text-xs text-muted-foreground truncate max-w-[280px]">
                            {Object.entries(ev.detail).map(([k, v]) => `${k}: ${v}`).join(" · ")}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="align-top font-mono text-xs text-muted-foreground whitespace-nowrap">
                        {ev.ip_address ?? "—"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
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
    </PageShell>
  );
}

function Kpi({ label, value, tone = "neutral" }: { label: string; value: number; tone?: "neutral" | "warn" | "danger" }) {
  const accent =
    tone === "danger" ? "before:bg-destructive" :
    tone === "warn"   ? "before:bg-warning" :
                        "before:bg-primary";
  const numColor =
    tone === "danger" ? "text-destructive" :
    tone === "warn"   ? "text-warning" :
                        "text-foreground";
  return (
    <div
      className={`relative bg-card border border-border rounded-xl pl-4 pr-4 py-3 shadow-sm overflow-hidden before:content-[''] before:absolute before:left-0 before:top-0 before:bottom-0 before:w-1 ${accent}`}
    >
      <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
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
    admin:       "border-border bg-muted text-muted-foreground",
    operator:    "border-info/20 bg-info/10 text-info",
  };
  const label: Record<string, string> = {
    super_admin: "Super admin",
    admin:       "Admin",
    operator:    "Operador",
  };
  return (
    <span className={`inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[11px] font-medium ${styles[role] ?? "border-border bg-muted text-muted-foreground"}`}>
      {label[role] ?? role}
    </span>
  );
}
