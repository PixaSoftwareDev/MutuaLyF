"use client";

import { useMemo, useState } from "react";
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
import { ChevronLeft, ChevronRight, Loader2, Search, ScrollText } from "lucide-react";
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

          {/* Mobile cards */}
          {filteredEvents.length > 0 && (
            <div className="sm:hidden divide-y">
              {filteredEvents.map(ev => {
                const isCritical = CRITICAL_ACTIONS.has(ev.action);
                return (
                  <div key={ev.id} className={cn("px-4 py-3 space-y-1.5", isCritical && "bg-warning/5")}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs text-muted-foreground">{fmtDate(ev.created_at)}</span>
                      <RoleBadge role={ev.actor_role} />
                    </div>
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-sm font-medium truncate">{ev.actor_email ?? "—"}</span>
                      <span className={cn(
                        "text-xs shrink-0",
                        isCritical ? "text-warning font-medium" : "text-muted-foreground"
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
            <div className="hidden sm:block">
              <Table className="min-w-[700px]">
                <TableHeader className="bg-muted/40">
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="px-4 w-[145px]">Fecha</TableHead>
                    <TableHead className="px-4">Usuario</TableHead>
                    <TableHead className="px-4 w-[100px]">Perfil</TableHead>
                    <TableHead className="px-4 w-[180px]">Acción</TableHead>
                    <TableHead className="px-4">Recurso</TableHead>
                    <TableHead className="px-4 w-[110px]">IP</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredEvents.map(ev => {
                    const isCritical = CRITICAL_ACTIONS.has(ev.action);
                    return (
                      <TableRow
                        key={ev.id}
                        className={cn(
                          isCritical && "bg-warning/5 hover:bg-warning/10",
                        )}
                      >
                        <TableCell className="px-4 py-2.5 align-top whitespace-nowrap font-mono text-xs text-muted-foreground">
                          {fmtDate(ev.created_at)}
                        </TableCell>
                        <TableCell className="px-4 py-2.5 align-top">
                          <div className="font-medium truncate max-w-[220px]">
                            {ev.actor_email ?? <span className="text-muted-foreground">—</span>}
                          </div>
                        </TableCell>
                        <TableCell className="px-4 py-2.5 align-top">
                          <RoleBadge role={ev.actor_role} />
                        </TableCell>
                        <TableCell className={cn(
                          "px-4 py-2.5 align-top",
                          isCritical && "text-warning font-medium"
                        )}>
                          {actionLabel(ev.action)}
                        </TableCell>
                        <TableCell className="px-4 py-2.5 align-top">
                          <div className="font-mono text-xs truncate max-w-[240px]">
                            {ev.resource ?? <span className="text-muted-foreground">—</span>}
                          </div>
                          {ev.detail && (
                            <div className="text-xs text-muted-foreground truncate max-w-[240px]">
                              {Object.entries(ev.detail).map(([k, v]) => `${k}: ${v}`).join(" · ")}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="px-4 py-2.5 align-top font-mono text-xs text-muted-foreground whitespace-nowrap">
                          {ev.ip_address ?? "—"}
                        </TableCell>
                      </TableRow>
                    );
                  })}
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
