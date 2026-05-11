"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Shield, ChevronLeft, ChevronRight, Loader2, AlertTriangle } from "lucide-react";

const ACTION_COLORS: Record<string, string> = {
  "auth.login":             "bg-green-100 text-green-800",
  "auth.login_failed":      "bg-orange-100 text-orange-800",
  "auth.brute_force_alert": "bg-red-100 text-red-800",
  "auth.logout":            "bg-slate-100 text-slate-700",
  "document.upload":        "bg-blue-100 text-blue-800",
  "document.delete":        "bg-red-100 text-red-800",
  "user.created":           "bg-violet-100 text-violet-800",
  "user.deactivated":       "bg-orange-100 text-orange-800",
  "sector.created":         "bg-teal-100 text-teal-800",
  "sector.deleted":         "bg-red-100 text-red-800",
  "handoff.accepted":       "bg-blue-100 text-blue-800",
  "handoff.transferred":    "bg-amber-100 text-amber-800",
  "handoff.closed":         "bg-slate-100 text-slate-700",
  "config.bot_config_update": "bg-violet-100 text-violet-800",
};

const ACTION_LABELS: Record<string, string> = {
  "":                         "Todos",
  "auth.login":               "Login exitoso",
  "auth.login_failed":        "Login fallido",
  "auth.brute_force_alert":   "⚠ Ataque de fuerza bruta",
  "auth.logout":              "Logout",
  "document.upload":          "Subida de documento",
  "document.delete":          "Borrado de documento",
  "user.created":             "Usuario creado",
  "user.deactivated":         "Usuario desactivado",
  "sector.created":           "Sector creado",
  "sector.deleted":           "Sector eliminado",
  "handoff.accepted":         "Handoff aceptado",
  "handoff.transferred":      "Conversación transferida",
  "handoff.closed":           "Conversación cerrada",
  "config.bot_config_update": "Config del bot",
};

function fmt(iso: string) {
  return new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeStyle: "medium" }).format(new Date(iso));
}

const PAGE_SIZE = 50;

export default function GlobalAuditPage() {
  const [page, setPage]             = useState(0);
  const [action, setAction]         = useState("");
  const [tenantFilter, setTenantFilter] = useState("");

  const { data, isLoading, isError } = useQuery({
    queryKey: ["global-audit", page, action, tenantFilter],
    queryFn: () => api.audit.globalList({
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      action: action || undefined,
      tenant_filter: tenantFilter || undefined,
    }),
  });

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 1;
  const hasAlerts = data?.events.some(e => e.action === "auth.brute_force_alert");

  return (
    <div className="space-y-6 p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Shield className="w-6 h-6 text-violet-500" />
            Auditoría global
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Actividad de todas las organizaciones
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {data?.tenants && data.tenants.length > 1 && (
            <select
              value={tenantFilter}
              onChange={e => { setTenantFilter(e.target.value); setPage(0); }}
              className="h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="">Todas las orgs</option>
              {data.tenants.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          )}
          <select
            value={action}
            onChange={e => { setAction(e.target.value); setPage(0); }}
            className="h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
          >
            {Object.entries(ACTION_LABELS).map(([val, label]) => (
              <option key={val} value={val}>{label}</option>
            ))}
          </select>
        </div>
      </div>

      {hasAlerts && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 flex items-center gap-2 text-sm text-red-700">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          Se detectaron intentos de fuerza bruta en esta página. Revisá los eventos marcados en rojo.
        </div>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Eventos</CardTitle>
          <CardDescription>{data ? `${data.total} total` : "Cargando…"}</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading && (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          )}
          {isError && (
            <div className="px-6 py-8 text-center text-sm text-destructive">
              No se pudo cargar el registro global.
            </div>
          )}
          {data && data.events.length === 0 && (
            <div className="px-6 py-8 text-center text-sm text-muted-foreground">
              No hay eventos registrados.
            </div>
          )}
          {data && data.events.length > 0 && (
            <div className="divide-y">
              {data.events.map((ev) => (
                <div
                  key={ev.id}
                  className={`px-6 py-3 flex items-start gap-4 hover:bg-muted/30 transition-colors ${
                    ev.action === "auth.brute_force_alert" ? "bg-red-50 hover:bg-red-100" : ""
                  }`}
                >
                  <Badge
                    className={`shrink-0 text-xs font-medium ${ACTION_COLORS[ev.action] ?? "bg-slate-100 text-slate-700"}`}
                    variant="secondary"
                  >
                    {ACTION_LABELS[ev.action] ?? ev.action}
                  </Badge>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium">{ev.actor_email ?? ev.actor_id}</span>
                      <Badge variant="outline" className="text-xs capitalize">{ev.actor_role}</Badge>
                      <Badge variant="outline" className="text-xs bg-violet-50 text-violet-700 border-violet-200">
                        {ev.tenant_id}
                      </Badge>
                    </div>
                    {ev.resource && (
                      <p className="text-xs text-muted-foreground mt-0.5 font-mono truncate">{ev.resource}</p>
                    )}
                    {ev.detail && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {Object.entries(ev.detail).map(([k, v]) => `${k}: ${v}`).join(" · ")}
                      </p>
                    )}
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-xs text-muted-foreground">{fmt(ev.created_at)}</p>
                    {ev.ip_address && (
                      <p className="text-xs text-muted-foreground/60 font-mono">{ev.ip_address}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {data && totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>Página {page + 1} de {totalPages}</span>
          <div className="flex gap-2">
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
