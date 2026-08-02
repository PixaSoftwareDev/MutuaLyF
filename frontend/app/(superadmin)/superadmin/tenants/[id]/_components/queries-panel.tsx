"use client";

// Últimas consultas — qué está preguntando la gente de este cliente.
// Desplegable, colapsado por defecto: la ficha se lee de un vistazo (cuántas
// y hace cuánto la última) y la tabla aparece solo a pedido. El backend corta
// en 10 — esto es un pulso del asistente, no un historial navegable.
// En móvil la latencia y el cuándo viajan bajo la pregunta.

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Panel } from "@/components/superadmin/panel";
import { StatePill } from "@/components/ui/state-pill";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { latencyTone } from "@/components/superadmin/status";
import { cn } from "@/lib/utils";

// Una latencia mala se tiñe sola — mismo criterio que el resto del panel.
function latencyCls(ms: number | null | undefined): string {
  const t = latencyTone(ms);
  return t === "down" ? "font-medium text-destructive" : t === "warn" ? "font-medium text-warning" : "text-muted-foreground";
}

function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms >= 1000) return (ms / 1000).toFixed(1) + "s";
  return ms + "ms";
}

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1)  return "ahora";
  if (m < 60) return `hace ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `hace ${h}h`;
  return `hace ${Math.floor(h / 24)}d`;
}

export function QueriesPanel({ queries }: {
  queries: Array<{ question_text: string | null; latency_ms: number | null; from_cache: boolean; created_at: string }>;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Panel
      title="Últimas consultas"
      sub={queries.length > 0 ? `la más reciente ${relTime(queries[0].created_at)}` : "qué pregunta la gente"}
      action={queries.length > 0 ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(o => !o)}
          className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {open ? "Ocultar" : `Ver ${queries.length === 1 ? "la última" : `las ${queries.length}`}`}
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform duration-200", open && "rotate-180")} />
        </button>
      ) : undefined}
    >
      {queries.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">Sin consultas registradas todavía.</p>
      ) : !open ? null : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Pregunta</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Latencia</TableHead>
                <TableHead className="hidden whitespace-nowrap text-right sm:table-cell">Cuándo</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {queries.map((q, i) => (
                <TableRow key={i} className="hover:bg-muted/40">
                  <TableCell className="w-full max-w-0">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className={cn("truncate text-sm", q.question_text ? "text-foreground" : "italic text-muted-foreground/70")}>
                        {q.question_text ?? "Consulta sin texto guardado"}
                      </span>
                      {q.from_cache && <StatePill tone="info">cache</StatePill>}
                    </span>
                    {/* Meta en móvil (las columnas están ocultas) */}
                    <span className="mt-0.5 block text-[11px] tabular-nums text-muted-foreground sm:hidden">
                      <span className={latencyCls(q.latency_ms)}>{fmtMs(q.latency_ms)}</span> · {relTime(q.created_at)}
                    </span>
                  </TableCell>
                  <TableCell className={cn("hidden text-right tabular-nums sm:table-cell", latencyCls(q.latency_ms))}>{fmtMs(q.latency_ms)}</TableCell>
                  <TableCell className="hidden whitespace-nowrap text-right tabular-nums text-muted-foreground sm:table-cell">{relTime(q.created_at)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Panel>
  );
}
