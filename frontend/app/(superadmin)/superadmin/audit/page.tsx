"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { EmptyState } from "@/components/ui/empty-state";
import { ChevronLeft, ChevronRight, Loader2, AlertTriangle, FileSearch, Search, ShieldCheck, Building2, Users, FileText, Settings2, Headphones, Activity, LogIn, ShieldAlert, ShieldX } from "lucide-react";
import { cn } from "@/lib/utils";
import { PageShell } from "@/components/layout/page-shell";
import { PageHeader, CountChip } from "@/components/layout/page-header";
import { Kpi } from "@/components/superadmin/shared";

// Categorías para escanear la actividad por tipo, cada una con ícono y color.
type Cat = "seguridad" | "empresa" | "usuario" | "contenido" | "config" | "operacion" | "otro";
const CAT_META: Record<Cat, { label: string; Icon: typeof ShieldCheck; color: string; bg: string }> = {
  seguridad: { label: "Seguridad", Icon: ShieldCheck, color: "text-slate-500",  bg: "bg-slate-500/10" },
  empresa:   { label: "Empresa",   Icon: Building2,   color: "text-violet-500", bg: "bg-violet-500/10" },
  usuario:   { label: "Usuario",   Icon: Users,       color: "text-blue-500",   bg: "bg-blue-500/10" },
  contenido: { label: "Contenido", Icon: FileText,    color: "text-amber-500",  bg: "bg-amber-500/10" },
  config:    { label: "Config",    Icon: Settings2,   color: "text-teal-500",   bg: "bg-teal-500/10" },
  operacion: { label: "Operación", Icon: Headphones,  color: "text-emerald-500",bg: "bg-emerald-500/10" },
  otro:      { label: "Otro",      Icon: Activity,    color: "text-muted-foreground", bg: "bg-muted" },
};

// Cada acción → etiqueta legible + categoría + tono (danger/warn resaltan lo
// sensible sobre el ruido de logins). El backend usa nombres como "auth.login".
type ActionMeta = { label: string; cat: Cat; danger?: boolean; warn?: boolean };
const ACTION_META: Record<string, ActionMeta> = {
  "auth.login":                  { label: "Inició sesión",           cat: "seguridad" },
  "auth.logout":                 { label: "Cerró sesión",            cat: "seguridad" },
  "auth.login_failed":           { label: "Login fallido",           cat: "seguridad", warn: true },
  "auth.brute_force_alert":      { label: "Alerta de fuerza bruta",  cat: "seguridad", danger: true },
  "auth.password_reset":         { label: "Restableció contraseña",  cat: "seguridad", warn: true },
  "auth.password_changed":       { label: "Cambió su contraseña",    cat: "seguridad" },
  "tenant.email_domain_added":   { label: "Agregó dominio de email", cat: "empresa" },
  "tenant.email_domain_removed": { label: "Quitó dominio de email",  cat: "empresa", warn: true },
  "user.created":                { label: "Creó un usuario",         cat: "usuario" },
  "user.updated":                { label: "Editó un usuario",        cat: "usuario" },
  "user.deactivated":            { label: "Desactivó un usuario",    cat: "usuario", warn: true },
  "document.upload":             { label: "Subió un documento",      cat: "contenido" },
  "document.delete":             { label: "Borró un documento",      cat: "contenido", warn: true },
  "documents.chunk_text_edited": { label: "Editó un fragmento",      cat: "contenido" },
  "chunk.review":                { label: "Revisó un fragmento",     cat: "contenido" },
  "admin.kb_export":             { label: "Exportó la base",         cat: "contenido", warn: true },
  "sector.created":              { label: "Creó un área",            cat: "config" },
  "sector.deleted":              { label: "Eliminó un área",         cat: "config", warn: true },
  "config.channel_update":       { label: "Actualizó un canal",      cat: "config" },
  "config.bot_config_update":    { label: "Modificó el bot",         cat: "config" },
  "config.onboarding_completed": { label: "Completó el onboarding",  cat: "config" },
  "bot.template_activated":      { label: "Activó una plantilla",    cat: "config" },
  "bot.template_deactivated":    { label: "Desactivó una plantilla", cat: "config" },
  "handoff.accepted":            { label: "Aceptó un handoff",       cat: "operacion" },
  "handoff.transferred":         { label: "Transfirió conversación", cat: "operacion" },
  "handoff.returned_to_bot":     { label: "Devolvió al bot",         cat: "operacion" },
  "handoff.released":            { label: "Liberó la conversación",  cat: "operacion" },
  "handoff.closed":              { label: "Cerró la conversación",   cat: "operacion" },
};

function metaFor(a: string): ActionMeta {
  return ACTION_META[a] ?? { label: a, cat: "otro" };
}

// Acción con su ícono de categoría + etiqueta legible. Lo sensible (danger/warn)
// tiñe el ícono y la letra para saltar sobre el ruido de logins.
function ActionTag({ action }: { action: string }) {
  const m = metaFor(action);
  const c = CAT_META[m.cat];
  const Icon = c.Icon;
  const iconCls = m.danger ? "bg-destructive/10 text-destructive"
    : m.warn ? "bg-warning/10 text-warning"
    : cn(c.bg, c.color);
  const textCls = m.danger ? "text-destructive font-medium"
    : m.warn ? "text-warning font-medium"
    : "text-foreground";
  return (
    <span className="inline-flex items-center gap-2">
      <span className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-md", iconCls)}>
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className={cn("text-sm", textCls)}>{m.label}</span>
    </span>
  );
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

    // Todas las señales acotadas a 24h — un número sin ventana temporal no
    // dice nada ("Logins 160" ¿de cuándo?).
    let events24 = 0, logins24 = 0, failed24 = 0, alerts24 = 0;
    for (const e of events) {
      const t = new Date(e.created_at).getTime();
      if (now - t <= dayMs) {
        events24++;
        if (e.action === "auth.login") logins24++;
        if (e.action === "auth.login_failed") failed24++;
        if (e.action === "auth.brute_force_alert") alerts24++;
      }
    }
    return { events24, logins24, failed24, alerts24, total: statsData?.total ?? 0 };
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
        <Kpi icon={Activity}    label="Eventos · 24h"        value={kpis.events24} loading={!statsData} />
        <Kpi icon={LogIn}       label="Logins · 24h"         value={kpis.logins24} loading={!statsData} />
        <Kpi icon={ShieldAlert} label="Logins fallidos · 24h" value={kpis.failed24} tone={kpis.failed24 > 0 ? "warn" : "neutral"} loading={!statsData} />
        <Kpi icon={ShieldX}     label="Fuerza bruta · 24h"   value={kpis.alerts24} tone={kpis.alerts24 > 0 ? "danger" : "neutral"} loading={!statsData} />
      </div>

      {/* Brute force banner */}
      {hasAlertsOnPage && (
        <div className="rounded-xl border border-destructive/20 bg-destructive/10 px-4 py-2.5 flex items-center gap-2 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          Se detectaron alertas de fuerza bruta en estos resultados — son las filas marcadas en rojo.
        </div>
      )}

      {/* Filters — barra agrupada; flex-wrap baja grupos enteros en anchos chicos */}
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border bg-card p-2.5 shadow-xs">
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
            <SelectItem value="__all__">Todas las acciones</SelectItem>
            {Object.entries(ACTION_META).map(([val, m]) => (
              <SelectItem key={val} value={val}>{m.label}</SelectItem>
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
      <div className="rounded-2xl border bg-card overflow-hidden">
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
              const isCritical = metaFor(ev.action).danger === true;
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
                    <ActionTag action={ev.action} />
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
                  const isCritical = metaFor(ev.action).danger === true;
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
                      <TableCell className="align-top">
                        <ActionTag action={ev.action} />
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
