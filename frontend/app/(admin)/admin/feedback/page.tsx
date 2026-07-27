"use client";

// ── Cola de Feedback del afiliado (caritas al cierre) ─────────────────────────
// Lista-detalle: a la izquierda las conversaciones calificadas (pendientes
// primero), a la derecha la conversación completa con FOCOS (momentos
// sospechosos resaltados) y la botonera de resolución de causa raíz.
// Diseño: 10 minutos por semana — cada 😞 se resuelve con un click.

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Frown, Meh, Smile, Loader2, FileQuestion, FilePen, Bot, XCircle, Globe,
  Smartphone, User as UserIcon, FlaskConical,
} from "lucide-react";
import { api, type FeedbackItem, type FeedbackAction } from "@/lib/api";
import { MessageBubble } from "@/components/conversations/conversations-panel";
import { ListDetailShell, DetailPanelHeader, PanelIconButton } from "@/components/admin/list-detail-shell";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

const RATING_META: Record<number, { icon: typeof Smile; cls: string; label: string }> = {
  1: { icon: Frown, cls: "text-destructive", label: "Mal" },
  2: { icon: Meh,   cls: "text-warning",     label: "Más o menos" },
  3: { icon: Smile, cls: "text-success",     label: "Bien" },
};

const REASON_LABEL: Record<string, string> = {
  not_found:    "No encontró lo que buscaba",
  wrong_info:   "La información era incorrecta",
  slow_service: "Tardaron en atenderlo",
};

// Focos: señales deterministas de "acá pudo estar el problema". Patrones de
// los mensajes que el propio sistema genera (no-info del orquestador, ofertas
// de derivación). Barato y suficiente para guiar el ojo del admin.
const SUSPECT_PATTERNS = [
  "no encontré", "no encontre", "no tengo esa información", "no tengo información",
  "querés que te conecte con un operador", "se escapa de lo que puedo",
];
function isSuspect(m: { sender_type: string; content: string }): boolean {
  if (m.sender_type !== "bot" && m.sender_type !== "system") return false;
  const t = m.content.toLowerCase();
  return SUSPECT_PATTERNS.some(p => t.includes(p));
}

type StatusView = "pending" | "all";

export default function FeedbackPage() {
  const qc = useQueryClient();
  const [view, setView] = useState<StatusView>("pending");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);

  const { data, isLoading } = useQuery({
    queryKey: ["admin-feedback", view],
    queryFn: () => api.adminFeedback.list(view === "pending" ? { status_filter: "pending" } : {}),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
  const items = data?.items ?? [];
  const selected = items.find(i => i.conversation_id === selectedId) ?? null;

  return (
    <ListDetailShell
      title="Feedback"
      panelTitle="conversación"
      open={panelOpen}
      hasSelection={!!selected}
      onExpand={() => setPanelOpen(true)}
      panelWidth={480}
      actions={
        <div className="flex items-center gap-1 rounded-xl bg-muted/60 p-1">
          {([["pending", "Pendientes"], ["all", "Todas"]] as Array<[StatusView, string]>).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setView(k)}
              className={cn(
                "rounded-lg px-3 py-1 text-xs font-medium transition-all",
                view === k ? "bg-card font-semibold text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
              {k === "pending" && (data?.pending ?? 0) > 0 && (
                <span className="ml-1.5 tabular-nums text-warning">{data?.pending}</span>
              )}
            </button>
          ))}
        </div>
      }
      panel={selected ? (
        <FeedbackDetail
          key={selected.conversation_id}
          item={selected}
          onCollapse={() => setPanelOpen(false)}
          onResolved={() => {
            qc.invalidateQueries({ queryKey: ["admin-feedback"] });
            setSelectedId(null);
          }}
        />
      ) : null}
    >
      <div className="p-4 sm:p-6">
        {isLoading ? (
          <div className="space-y-2">{[1, 2, 3].map(i => <Skeleton key={i} className="h-16 rounded-xl" />)}</div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={Smile}
            title={view === "pending" ? "Nada pendiente" : "Todavía no hay calificaciones"}
            description={view === "pending"
              ? "Cuando un afiliado califique con 😞 o 😐, aparece acá para revisarlo."
              : "Las caritas que dejen los afiliados al cerrar sus conversaciones se listan acá."}
            className="rounded-2xl border border-dashed bg-card"
          />
        ) : (
          <ul className="divide-y">
            {items.map(item => {
              const meta = RATING_META[item.rating];
              const active = item.conversation_id === selectedId;
              return (
                <li key={item.conversation_id}>
                  <button
                    onClick={() => { setSelectedId(item.conversation_id); setPanelOpen(true); }}
                    className={cn(
                      "flex w-full items-start gap-3 rounded-lg px-2 py-3 text-left transition-colors",
                      active ? "bg-muted/60" : "hover:bg-muted/40",
                    )}
                  >
                    <meta.icon className={cn("mt-0.5 h-5 w-5 shrink-0", meta.cls)} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-sm">
                        <span className="truncate font-medium text-foreground">
                          {item.afiliado_nombre || (item.afiliado_ip ? `IP ${item.afiliado_ip}` : "Anónimo")}
                        </span>
                        {item.channel === "whatsapp"
                          ? <Smartphone className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          : <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                        {item.atendida_por_humano && <UserIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="Atendida por operador" />}
                        {item.is_test && (
                          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                            <FlaskConical className="h-3 w-3" /> prueba
                          </span>
                        )}
                        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                          {item.feedback_at ? new Date(item.feedback_at).toLocaleDateString("es-AR", { day: "2-digit", month: "short" }) : ""}
                        </span>
                      </div>
                      {item.reason && (
                        <p className="mt-0.5 text-xs font-medium text-warning">{REASON_LABEL[item.reason] ?? item.reason}</p>
                      )}
                      {item.ultima_pregunta && (
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">“{item.ultima_pregunta}”</p>
                      )}
                      {item.review_status && item.review_status !== "pending" && (
                        <p className="mt-0.5 text-[11px] text-muted-foreground">
                          {item.review_status === "dismissed" ? "Descartado" : "Resuelto"}
                          {item.review_action && item.review_action !== "dismissed" ? ` · ${ACTION_LABEL[item.review_action]}` : ""}
                        </p>
                      )}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </ListDetailShell>
  );
}

const ACTION_LABEL: Record<FeedbackAction, string> = {
  missing_content:   "Faltaba información",
  wrong_content:     "La info estaba mal",
  bot_misunderstood: "El bot entendió mal",
  dismissed:         "Descartado",
};

// ── Detalle: conversación con focos + botonera de resolución ─────────────────

function FeedbackDetail({ item, onCollapse, onResolved }: {
  item: FeedbackItem;
  onCollapse: () => void;
  onResolved: () => void;
}) {
  const { data: detail, isLoading } = useQuery({
    queryKey: ["conversation-detail", item.conversation_id],
    queryFn: () => api.operator.getConversation(item.conversation_id),
    staleTime: 60_000,
  });

  const resolveM = useMutation({
    mutationFn: (action: FeedbackAction) => api.adminFeedback.resolve(item.conversation_id, action),
    onSuccess: (_d, action) => {
      toast({ title: "Feedback resuelto", description: ACTION_LABEL[action], variant: "success" });
      onResolved();
    },
    onError: () => toast({ title: "No se pudo resolver", variant: "destructive" }),
  });

  const meta = RATING_META[item.rating];
  const suspects = useMemo(
    () => new Set((detail?.messages ?? []).filter(isSuspect).map(m => m.id)),
    [detail?.messages],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <DetailPanelHeader label="Conversación calificada">
        <PanelIconButton onClick={onCollapse} label="Contraer panel">
          <XCircle className="h-4 w-4" />
        </PanelIconButton>
      </DetailPanelHeader>

      {/* Ficha del feedback */}
      <div className="shrink-0 border-b px-4 py-3">
        <div className="flex items-center gap-2 text-sm">
          <meta.icon className={cn("h-5 w-5", meta.cls)} />
          <span className="font-semibold">{meta.label}</span>
          {item.reason && <span className="text-muted-foreground">· {REASON_LABEL[item.reason]}</span>}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {item.atendida_por_humano ? "Atendida por un operador" : "Resuelta por el bot"}
          {" · "}{item.channel === "whatsapp" ? "WhatsApp" : "Widget"}
          {item.is_test && " · conversación de prueba"}
        </p>
      </div>

      {/* Conversación con focos */}
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-slim bg-muted/20 px-3 py-4">
        {isLoading ? (
          <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="space-y-3">
            {(detail?.messages ?? []).map(m => (
              <div
                key={m.id}
                className={cn(suspects.has(m.id) && "rounded-xl ring-2 ring-warning/50 ring-offset-2 ring-offset-background")}
              >
                <MessageBubble
                  msg={m as any}
                  conversationId={item.conversation_id}
                  senderName={detail?.afiliado_nombre || "Afiliado"}
                />
              </div>
            ))}
            {suspects.size > 0 && (
              <p className="pt-1 text-center text-[11px] text-muted-foreground">
                Los mensajes marcados son los momentos donde el asistente no pudo resolver.
              </p>
            )}
          </div>
        )}
      </div>

      {/* Botonera de resolución — solo si está pendiente */}
      {item.review_status === "pending" && (
        <div className="shrink-0 space-y-1.5 border-t p-3">
          <p className="px-1 text-xs font-medium text-muted-foreground">¿Qué pasó acá?</p>
          <div className="grid grid-cols-2 gap-1.5">
            <ResolveBtn icon={FileQuestion} label="Faltaba información" hint="Hueco de conocimiento — subí o ampliá un documento"
                        onClick={() => resolveM.mutate("missing_content")} pending={resolveM.isPending} />
            <ResolveBtn icon={FilePen} label="La info está mal" hint="Corregir el documento en Conocimiento"
                        onClick={() => resolveM.mutate("wrong_content")} pending={resolveM.isPending} />
            <ResolveBtn icon={Bot} label="El bot entendió mal" hint="Se marca para el equipo de la plataforma"
                        onClick={() => resolveM.mutate("bot_misunderstood")} pending={resolveM.isPending} />
            <ResolveBtn icon={XCircle} label="Descartar" hint="Prueba, error del afiliado o injustificado"
                        onClick={() => resolveM.mutate("dismissed")} pending={resolveM.isPending} />
          </div>
          <Link href="/admin/documents" className="block px-1 pt-1 text-[11px] text-action underline-offset-2 hover:underline">
            Ir a Conocimiento para corregir documentos →
          </Link>
        </div>
      )}
    </div>
  );
}

function ResolveBtn({ icon: Icon, label, hint, onClick, pending }: {
  icon: typeof Bot; label: string; hint: string; onClick: () => void; pending: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={pending}
      title={hint}
      className="flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-xs font-medium text-foreground transition-colors hover:border-action/40 hover:bg-action/5 disabled:opacity-50"
    >
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}
