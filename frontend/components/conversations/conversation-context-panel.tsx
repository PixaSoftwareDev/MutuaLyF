"use client";

import { useState } from "react";
import { Bot, ChevronRight, PanelRight } from "lucide-react";
import { type ConversationDetail } from "@/lib/api";
import { StatusBadge } from "@/components/conversations/conversations-panel";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Panel de contexto del afiliado (columna 3 del inbox, patrón referencia Text).
 * Compartido entre el inbox del admin y la bandeja del operador: mismo `detail`
 * de `api.operator.getConversation`, misma info (datos del afiliado, metadatos de
 * la conversación y métricas de actividad calculadas de los mensajes). El botón
 * de contraer vive DENTRO del cuadrante que se contrae.
 */
export function ConversationContextPanel({ detail, loading, onCollapse }: {
  detail: ConversationDetail | null;
  loading: boolean;
  onCollapse: () => void;
}) {
  // Header propio del panel, alineado con el header de la conversación.
  const header = (
    <div className="flex h-12 shrink-0 items-center justify-between border-b pl-4 pr-2">
      <span className="text-[13px] font-semibold text-foreground">Afiliado</span>
      <button
        onClick={onCollapse}
        className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="Ocultar información del afiliado"
        title="Ocultar información del afiliado"
      >
        <PanelRight className="h-4 w-4" />
      </button>
    </div>
  );

  if (loading || !detail) {
    return (
      <div className="flex flex-col">
        {header}
        <div className="space-y-3 p-4">
          <div className="flex items-center gap-3">
            <Skeleton className="h-10 w-10 rounded-full" />
            <div className="flex-1 space-y-1.5"><Skeleton className="h-3.5 w-28" /><Skeleton className="h-3 w-16" /></div>
          </div>
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
      </div>
    );
  }

  const name    = detail.afiliado_nombre || (detail.afiliado_ip ? `IP ${detail.afiliado_ip}` : "Anónimo");
  const initial = detail.afiliado_nombre?.trim()[0]?.toUpperCase() ?? null;
  const isWhatsApp = detail.channel === "whatsapp";

  // ── Métricas calculadas de los mensajes (sin backend extra) ────────────────
  const msgs = detail.messages ?? [];
  const lastMsgAt = msgs.length ? msgs[msgs.length - 1].created_at : null;

  // Duración: del inicio a la última actividad (mide la charla real).
  const durationMs = lastMsgAt ? new Date(lastMsgAt).getTime() - new Date(detail.created_at).getTime() : null;

  // Espera hasta atención humana: del pedido de operador al primer mensaje del
  // operador. El dato operativo más valioso del panel.
  let waitMs: number | null = null;
  if (detail.handoff_requested_at) {
    const handoffTs = new Date(detail.handoff_requested_at).getTime();
    const firstOp = msgs.find(m => m.sender_type === "operator" && new Date(m.created_at).getTime() >= handoffTs);
    if (firstOp) waitMs = new Date(firstOp.created_at).getTime() - handoffTs;
  }

  const byAfiliado = msgs.filter(m => m.sender_type === "user").length;
  const byBot      = msgs.filter(m => m.sender_type === "bot").length;
  const byOperator = msgs.filter(m => m.sender_type === "operator").length;

  return (
    <div className="flex flex-col">
      {header}
      {/* Identidad */}
      <div className="flex items-center gap-3 border-b px-4 py-4">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold text-muted-foreground">
          {initial ?? <Bot className="h-4 w-4" />}
        </span>
        <div className="min-w-0 leading-tight">
          <p className="truncate text-[13px] font-semibold text-foreground" title={name}>{name}</p>
          <div className="mt-1"><StatusBadge status={detail.status} /></div>
        </div>
      </div>

      <PanelSection title="Datos del afiliado">
        <PanelRow label="Email"    value={detail.afiliado_email} />
        <PanelRow label="DNI"      value={detail.afiliado_dni} />
        <PanelRow label="Teléfono" value={isWhatsApp ? detail.external_id ?? null : null} />
        <PanelRow label="IP"       value={detail.afiliado_ip} />
      </PanelSection>

      <PanelSection title="Conversación">
        <PanelRow label="Canal"    value={isWhatsApp ? "WhatsApp" : "Widget web"} />
        <PanelRow label="Sector"   value={detail.sector_nombre} />
        <PanelRow label="Operador" value={detail.operator_name} />
        <PanelRow label="Iniciada" value={fmtWhen(detail.created_at)} />
        <PanelRow label="Derivada" value={fmtWhen(detail.handoff_requested_at)} />
        {detail.is_test && <PanelRow label="Origen" value="Conversación de prueba" />}
      </PanelSection>

      <PanelSection title="Actividad">
        <PanelRow label="Duración"         value={durationMs != null ? fmtDuration(durationMs) : null} />
        <PanelRow label="Última actividad" value={fmtWhen(lastMsgAt)} />
        <PanelRow label="Espera operador"  value={waitMs != null ? fmtDuration(waitMs) : null} />
        <PanelRow label="Mensajes"         value={String(msgs.length)} />
        <PanelRow label="Del afiliado"     value={byAfiliado ? String(byAfiliado) : null} />
        <PanelRow label="Del asistente"    value={byBot ? String(byBot) : null} />
        <PanelRow label="Del operador"     value={byOperator ? String(byOperator) : null} />
      </PanelSection>
    </div>
  );
}

/** Sección colapsable del panel de contexto (chevron, abierta por defecto). */
function PanelSection({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="border-b">
      <button
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="flex h-10 w-full items-center justify-between px-4 text-[13px] font-semibold text-foreground transition-colors hover:bg-muted/40"
      >
        {title}
        <ChevronRight className={cn("h-4 w-4 text-muted-foreground transition-transform", open && "rotate-90")} />
      </button>
      {open && <div className="space-y-2.5 px-4 pb-4 pt-0.5">{children}</div>}
    </div>
  );
}

/** Fila label/valor — si no hay valor, no se muestra (sin "—" de relleno). */
function PanelRow({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right font-medium text-foreground" title={value}>{value}</span>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtWhen(iso: string | null): string | null {
  return iso
    ? new Date(iso).toLocaleString("es-AR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
    : null;
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}
