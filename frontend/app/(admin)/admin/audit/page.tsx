"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Shield, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";

const ACTION_COLORS: Record<string, string> = {
  "auth.login":              "bg-green-100 text-green-800",
  "auth.logout":             "bg-slate-100 text-slate-700",
  "document.upload":         "bg-blue-100 text-blue-800",
  "document.delete":         "bg-red-100 text-red-800",
  "config.bot_config_update":"bg-violet-100 text-violet-800",
};

const ACTION_LABELS: Record<string, string> = {
  "":                        "Todos",
  "auth.login":              "Login",
  "auth.logout":             "Logout",
  "document.upload":         "Subida de documento",
  "document.delete":         "Borrado de documento",
  "config.bot_config_update":"Configuración del bot",
};

function fmt(iso: string) {
  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "short", timeStyle: "medium",
  }).format(new Date(iso));
}

const PAGE_SIZE = 30;

export default function AuditPage() {
  const [page, setPage]     = useState(0);
  const [action, setAction] = useState("");

  const { data, isLoading, isError } = useQuery({
    queryKey: ["audit", page, action],
    queryFn: () => api.audit.list({ limit: PAGE_SIZE, offset: page * PAGE_SIZE, action: action || undefined }),
  });

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 1;

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Shield className="w-6 h-6 text-violet-500" />
            Registro de auditoría
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Acciones críticas realizadas por usuarios del tenant
          </p>
        </div>

        <select
          value={action}
          onChange={(e) => { setAction(e.target.value); setPage(0); }}
          className="h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
        >
          {Object.entries(ACTION_LABELS).map(([val, label]) => (
            <option key={val} value={val}>{label}</option>
          ))}
        </select>
      </div>

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
              No se pudo cargar el registro. Asegurate de que la tabla audit_log existe en este tenant.
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
                <div key={ev.id} className="px-6 py-3 flex items-start gap-4 hover:bg-muted/30 transition-colors">
                  <Badge
                    className={`shrink-0 text-xs font-medium ${ACTION_COLORS[ev.action] ?? "bg-slate-100 text-slate-700"}`}
                    variant="secondary"
                  >
                    {ACTION_LABELS[ev.action] ?? ev.action}
                  </Badge>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium">
                        {ev.actor_email ?? ev.actor_id}
                      </span>
                      <Badge variant="outline" className="text-xs capitalize">{ev.actor_role}</Badge>
                    </div>
                    {ev.resource && (
                      <p className="text-xs text-muted-foreground mt-0.5 font-mono truncate">
                        {ev.resource}
                      </p>
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
            <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <Button size="sm" variant="outline" disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)}>
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
