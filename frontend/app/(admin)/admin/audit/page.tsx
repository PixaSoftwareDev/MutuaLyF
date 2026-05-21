"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChevronLeft, ChevronRight, Loader2, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { PageShell } from "@/components/layout/page-shell";
import { PageHeader } from "@/components/layout/page-header";

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

function actionLabel(a: string) {
  if (ACTION_LABELS[a]) return ACTION_LABELS[a];
  // Fallback legible: "document.upload" → "Document upload"
  const clean = a.replace(/[._-]/g, " ");
  return clean.charAt(0).toUpperCase() + clean.slice(1);
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
    <PageShell>
      <PageHeader
        title="Auditoría"
        description="Registro de acciones realizadas por los usuarios."
      />

      {/* Lista de eventos */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle className="text-base">
              Eventos {data && `(${data.total})`}
            </CardTitle>

            <div className="flex items-center gap-2 sm:max-w-md w-full">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Buscar usuario, recurso, IP…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="pl-8 h-8 text-sm"
                />
              </div>
              <select
                value={action}
                onChange={e => { setAction(e.target.value); setPage(0); }}
                className="h-8 rounded-md border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring shrink-0"
              >
                {Object.entries(ACTION_LABELS).map(([val, label]) => (
                  <option key={val} value={val}>{label}</option>
                ))}
              </select>
            </div>
          </div>
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
            <p className="py-8 text-center text-muted-foreground text-sm">
              {search ? "Ningún evento coincide con la búsqueda." : "No hay eventos registrados."}
            </p>
          )}

          {/* Mobile cards */}
          {filteredEvents.length > 0 && (
            <div className="sm:hidden divide-y">
              {filteredEvents.map(ev => {
                const isCritical = CRITICAL_ACTIONS.has(ev.action);
                return (
                  <div key={ev.id} className={cn("px-4 py-3 space-y-1.5", isCritical && "bg-amber-50/60")}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs text-muted-foreground">{fmtDate(ev.created_at)}</span>
                      <RoleBadge role={ev.actor_role} />
                    </div>
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-sm font-medium truncate">{ev.actor_email ?? "—"}</span>
                      <span className={cn(
                        "text-xs shrink-0",
                        isCritical ? "text-amber-900 font-medium" : "text-muted-foreground"
                      )}>
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
                      <tr
                        key={ev.id}
                        className={cn(
                          isCritical ? "bg-amber-50/50 hover:bg-amber-50" : "hover:bg-muted/30",
                        )}
                      >
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
                        <td className={cn(
                          "px-4 py-2.5 align-top",
                          isCritical && "text-amber-900 font-medium"
                        )}>
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

// ── RoleBadge ────────────────────────────────────────────────────────────────

const ROLE_LABELS: Record<string, string> = {
  super_admin: "Super admin",
  admin:       "Admin",
  operator:    "Operador",
};

function RoleBadge({ role }: { role: string }) {
  if (!role) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <Badge variant="secondary" className="text-[11px] font-normal h-5 px-1.5">
      {ROLE_LABELS[role] ?? role}
    </Badge>
  );
}
