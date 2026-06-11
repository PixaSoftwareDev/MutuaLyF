"use client";

import { Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "@/components/ui/select";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table";
import { EmptyState } from "@/components/ui/empty-state";
import {
  ChevronLeft, ChevronRight, ChevronDown, Loader2, Search, ScrollText,
  KeyRound, FileText, Settings2, Users, Building2, Tags, AlertTriangle,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { PageShell } from "@/components/layout/page-shell";
import { PageHeader, CountChip } from "@/components/layout/page-header";

// ── Catálogo de acciones ─────────────────────────────────────────────────────

const ACTION_LABELS: Record<string, string> = {
  "":                                "Todas las acciones",
  "auth.login":                      "Login",
  "auth.login_failed":               "Login fallido",
  "auth.logout":                     "Logout",
  "auth.brute_force_alert":          "Alerta de fuerza bruta",
  "document.upload":                 "Subió documento",
  "document.delete":                 "Eliminó documento",
  "document.chunk_reviewed":         "Revisó fragmento",
  "documents.chunk_text_edited":     "Editó fragmento",
  "config.bot_config_update":        "Modificó config del bot",
  "config.onboarding_completed":     "Completó onboarding",
  "config.branding_update":          "Modificó branding",
  "config.handoff_update":           "Modificó derivación",
  "operator.created":                "Creó operador",
  "operator.deactivated":            "Desactivó operador",
  "sector.created":                  "Creó sector",
  "sector.updated":                  "Modificó sector",
  "intention.approved":              "Aprobó tema",
  "intention.rejected":              "Descartó tema",
};

const CRITICAL_ACTIONS = new Set([
  "document.delete",
  "auth.login_failed",
  "auth.brute_force_alert",
  "operator.deactivated",
]);

// Categoría visual por prefijo de la acción ("auth.login" → auth). Da un
// icono escaneable por fila sin necesidad de leer cada label.
const CATEGORY_META: Record<string, { icon: LucideIcon; label: string }> = {
  auth:      { icon: KeyRound,  label: "Seguridad" },
  document:  { icon: FileText,  label: "Documentos" },
  documents: { icon: FileText,  label: "Documentos" },
  config:    { icon: Settings2, label: "Configuración" },
  operator:  { icon: Users,     label: "Equipo" },
  sector:    { icon: Building2, label: "Equipo" },
  intention: { icon: Tags,      label: "Temas" },
};

function categoryOf(action: string) {
  const prefix = action.split(".")[0];
  return CATEGORY_META[prefix] ?? { icon: ScrollText, label: "Sistema" };
}

function actionLabel(a: string) {
  if (ACTION_LABELS[a]) return ACTION_LABELS[a];
  // Fallback legible: "document.upload" → "Document upload"
  const clean = a.replace(/[._-]/g, " ");
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

// ── Fechas ───────────────────────────────────────────────────────────────────

function fmtTime(iso: string) {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mi}:${ss}`;
}

function dayKey(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (dayKey(iso) === dayKey(today.toISOString())) return "Hoy";
  if (dayKey(iso) === dayKey(yesterday.toISOString())) return "Ayer";
  const label = d.toLocaleDateString("es-AR", { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

const PAGE_SIZE = 30;

type AuditEvent = Awaited<ReturnType<typeof api.audit.list>>["events"][number];

export default function AuditPage() {
  const [page, setPage]     = useState(0);
  const [action, setAction] = useState("");
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo]     = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["audit", page, action, dateFrom, dateTo],
    queryFn: () => api.audit.list({
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      action: action || undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
    }),
  });

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

  // Grupos por día preservando el orden del servidor (descendente).
  const dayGroups = useMemo(() => {
    const groups: Array<{ label: string; events: AuditEvent[] }> = [];
    for (const ev of filteredEvents) {
      const label = dayLabel(ev.created_at);
      const last = groups[groups.length - 1];
      if (last && last.label === label) last.events.push(ev);
      else groups.push({ label, events: [ev] });
    }
    return groups;
  }, [filteredEvents]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <PageShell>
      <PageHeader
        title="Auditoría"
        badge={data ? <CountChip>{data.total} eventos</CountChip> : undefined}
        description="Registro de acciones críticas: logins, documentos, configuración y equipo. Hacé clic en una fila para ver el detalle."
      />

      {/* Lista de eventos */}
      <Card className="rounded-2xl">
        <CardHeader className="pb-3">
          {/* Una sola fila de filtros: búsqueda + acción + fechas. flex-wrap
              hace que en anchos chicos los grupos bajen enteros y prolijos. */}
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-base mr-auto">Eventos</CardTitle>

            <div className="relative w-full sm:w-56">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Buscar usuario, recurso, IP…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="pl-8 h-8 text-sm"
              />
            </div>

            <Select
              value={action || "all"}
              onValueChange={v => { setAction(v === "all" ? "" : v); setPage(0); }}
            >
              <SelectTrigger className="h-8 w-auto shrink-0 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(ACTION_LABELS).map(([val, label]) => (
                  <SelectItem key={val || "all"} value={val || "all"} className="text-xs">
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Rango de fechas — filtra en el servidor (acota el conjunto completo) */}
            <div className="flex items-center gap-1.5">
              <Input
                type="date" aria-label="Desde" value={dateFrom} max={dateTo || undefined}
                onChange={e => { setDateFrom(e.target.value); setPage(0); }}
                className="h-8 w-[8.25rem] px-2 text-xs"
              />
              <span className="text-xs text-muted-foreground" aria-hidden>→</span>
              <Input
                type="date" aria-label="Hasta" value={dateTo} min={dateFrom || undefined}
                onChange={e => { setDateTo(e.target.value); setPage(0); }}
                className="h-8 w-[8.25rem] px-2 text-xs"
              />
              {(dateFrom || dateTo) && (
                <Button
                  variant="ghost" size="sm" className="h-8 px-2 text-xs text-muted-foreground"
                  onClick={() => { setDateFrom(""); setDateTo(""); setPage(0); }}
                >
                  Limpiar
                </Button>
              )}
            </div>
          </div>
          {search.trim() && (
            <p className="text-[11px] text-muted-foreground mt-1.5">
              La búsqueda filtra los {PAGE_SIZE} eventos de esta página. Para acotar en todo el historial usá el filtro de acción.
            </p>
          )}
        </CardHeader>

        <CardContent className="p-0">
          {isLoading && (
            <div className="py-12 text-center text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin inline" />
            </div>
          )}
          {isError && (
            <div className="py-8 text-center text-destructive text-sm">No se pudo cargar el registro.</div>
          )}
          {data && filteredEvents.length === 0 && !isLoading && (
            <EmptyState
              icon={ScrollText}
              title={search ? "Sin coincidencias" : "No hay eventos registrados"}
              description={
                search
                  ? "Ningún evento coincide con la búsqueda."
                  : "Las acciones de los usuarios aparecerán acá a medida que ocurran."
              }
            />
          )}

          {/* Mobile: lista agrupada por día */}
          {filteredEvents.length > 0 && (
            <div className="sm:hidden">
              {dayGroups.map(group => (
                <Fragment key={group.label}>
                  <div className="px-4 py-1.5 bg-muted/50 border-y text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {group.label}
                  </div>
                  <div className="divide-y">
                    {group.events.map(ev => {
                      const isCritical = CRITICAL_ACTIONS.has(ev.action);
                      const { icon: Icon } = categoryOf(ev.action);
                      const isOpen = expanded === ev.id;
                      return (
                        <div
                          key={ev.id}
                          className={cn("px-4 py-3 space-y-1.5", isCritical && "bg-warning/5")}
                          onClick={() => setExpanded(isOpen ? null : ev.id)}
                        >
                          <div className="flex items-center gap-2">
                            <span className={cn(
                              "flex h-6 w-6 shrink-0 items-center justify-center rounded-md",
                              isCritical ? "bg-warning/15 text-warning" : "bg-muted text-muted-foreground",
                            )}>
                              {isCritical ? <AlertTriangle className="h-3.5 w-3.5" /> : <Icon className="h-3.5 w-3.5" />}
                            </span>
                            <span className={cn("text-sm flex-1 min-w-0 truncate", isCritical ? "text-warning font-semibold" : "font-medium")}>
                              {actionLabel(ev.action)}
                            </span>
                            <span className="font-mono text-[11px] text-muted-foreground shrink-0">{fmtTime(ev.created_at)}</span>
                          </div>
                          <div className="flex items-center justify-between gap-2 pl-8">
                            <span className="text-xs text-muted-foreground truncate">{ev.actor_email ?? "—"}</span>
                            <RoleBadge role={ev.actor_role} />
                          </div>
                          {isOpen && <EventDetail ev={ev} className="ml-8 mt-2" />}
                        </div>
                      );
                    })}
                  </div>
                </Fragment>
              ))}
            </div>
          )}

          {/* Desktop: tabla agrupada por día con filas expandibles */}
          {filteredEvents.length > 0 && (
            <div className="hidden sm:block">
              <Table className="min-w-[760px]">
                <TableHeader className="bg-muted/40">
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="px-4 w-[90px]">Hora</TableHead>
                    <TableHead className="px-4 w-[230px]">Acción</TableHead>
                    <TableHead className="px-4">Usuario</TableHead>
                    <TableHead className="px-4">Recurso</TableHead>
                    <TableHead className="px-4 w-[120px]">IP</TableHead>
                    <TableHead className="px-2 w-[40px]"><span className="sr-only">Detalle</span></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {dayGroups.map(group => (
                    <Fragment key={group.label}>
                      <TableRow className="hover:bg-transparent border-b-0">
                        <TableCell colSpan={6} className="px-4 py-1.5 bg-muted/50 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                          {group.label}
                        </TableCell>
                      </TableRow>
                      {group.events.map(ev => {
                        const isCritical = CRITICAL_ACTIONS.has(ev.action);
                        const { icon: Icon } = categoryOf(ev.action);
                        const isOpen = expanded === ev.id;
                        return (
                          <Fragment key={ev.id}>
                            <TableRow
                              onClick={() => setExpanded(isOpen ? null : ev.id)}
                              className={cn(
                                "cursor-pointer",
                                isCritical && "bg-warning/5 hover:bg-warning/10",
                                isOpen && !isCritical && "bg-muted/30",
                              )}
                            >
                              <TableCell className="px-4 py-2.5 whitespace-nowrap font-mono text-xs text-muted-foreground">
                                {fmtTime(ev.created_at)}
                              </TableCell>
                              <TableCell className="px-4 py-2.5">
                                <div className="flex items-center gap-2.5 min-w-0">
                                  <span className={cn(
                                    "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg",
                                    isCritical ? "bg-warning/15 text-warning" : "bg-muted text-muted-foreground",
                                  )}>
                                    {isCritical ? <AlertTriangle className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
                                  </span>
                                  <span className={cn("truncate text-sm", isCritical ? "text-warning font-semibold" : "font-medium")}>
                                    {actionLabel(ev.action)}
                                  </span>
                                </div>
                              </TableCell>
                              <TableCell className="px-4 py-2.5">
                                <div className="flex items-center gap-2 min-w-0">
                                  <span className="truncate max-w-[220px] text-sm">
                                    {ev.actor_email ?? <span className="text-muted-foreground">—</span>}
                                  </span>
                                  <RoleBadge role={ev.actor_role} />
                                </div>
                              </TableCell>
                              <TableCell className="px-4 py-2.5">
                                <div className="font-mono text-xs truncate max-w-[240px] text-muted-foreground">
                                  {ev.resource ?? "—"}
                                </div>
                              </TableCell>
                              <TableCell className="px-4 py-2.5 font-mono text-xs text-muted-foreground whitespace-nowrap">
                                {ev.ip_address ?? "—"}
                              </TableCell>
                              <TableCell className="px-2 py-2.5 text-muted-foreground">
                                <ChevronDown className={cn("h-4 w-4 transition-transform", isOpen && "rotate-180")} />
                              </TableCell>
                            </TableRow>
                            {isOpen && (
                              <TableRow className="hover:bg-transparent">
                                <TableCell colSpan={6} className="px-4 py-0 bg-muted/20">
                                  <EventDetail ev={ev} className="py-3 pl-[26px]" />
                                </TableCell>
                              </TableRow>
                            )}
                          </Fragment>
                        );
                      })}
                    </Fragment>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
      {data && totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>Página {page + 1} de {totalPages}</span>
          <div className="flex gap-1">
            <Button size="sm" variant="outline" className="h-8 w-8 p-0" disabled={page === 0} onClick={() => setPage(p => p - 1)}>
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <Button size="sm" variant="outline" className="h-8 w-8 p-0" disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}
    </PageShell>
  );
}

// ── Detalle expandido ────────────────────────────────────────────────────────
// Todo lo que la fila trunca, legible: detail completo, actor, IP y el código
// crudo de la acción (útil para soporte / correlación con logs del backend).

function EventDetail({ ev, className }: { ev: AuditEvent; className?: string }) {
  const entries: Array<[string, string]> = [];
  if (ev.detail) {
    for (const [k, v] of Object.entries(ev.detail)) {
      entries.push([k, typeof v === "object" ? JSON.stringify(v) : String(v)]);
    }
  }
  return (
    <div className={cn("text-xs space-y-2", className)}>
      {entries.length > 0 && (
        <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
          {entries.map(([k, v]) => (
            <div key={k} className="flex gap-2 min-w-0">
              <dt className="text-muted-foreground shrink-0">{k}:</dt>
              <dd className="font-medium break-all">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-muted-foreground pt-1 border-t border-border/60">
        <span>Acción: <code className="font-mono">{ev.action}</code></span>
        {ev.resource && <span>Recurso: <code className="font-mono break-all">{ev.resource}</code></span>}
        <span>Actor: <code className="font-mono">{ev.actor_id}</code></span>
        {ev.ip_address && <span>IP: <code className="font-mono">{ev.ip_address}</code></span>}
        <span>{new Date(ev.created_at).toLocaleString("es-AR")}</span>
      </div>
    </div>
  );
}

// ── RoleBadge ────────────────────────────────────────────────────────────────

const ROLE_LABELS: Record<string, string> = {
  super_admin: "Super admin",
  admin:       "Admin",
  operator:    "Operador",
};

function RoleBadge({ role }: { role: string }) {
  if (!role) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <Badge variant="secondary" className="text-[11px] font-normal h-5 px-1.5 shrink-0">
      {ROLE_LABELS[role] ?? role}
    </Badge>
  );
}
