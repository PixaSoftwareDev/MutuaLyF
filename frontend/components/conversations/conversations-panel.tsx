"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  MessageSquare, Loader2, Send, UserCheck, UserMinus, XCircle, User, Bot,
  Info, ChevronLeft, Search, ArrowRightLeft, Eye,
  RotateCcw, MoreVertical, Paperclip, X, Globe, PanelRight, Download,
} from "lucide-react";
import { api, type ConversationRow } from "@/lib/api";
import { ConversationContextPanel } from "@/components/conversations/conversation-context-panel";
import { extractErrorMessage } from "@/lib/errors";
import { renderWithLinks } from "@/lib/render-with-links";
import { WhatsAppIcon } from "@/components/ui/whatsapp-icon";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

// ── Constants ─────────────────────────────────────────────────────────────────

const URGENT_MS       = 120_000; // 2 min waiting → urgent (amber)
const VERY_URGENT_MS  = 300_000; // 5 min waiting → very urgent (red)

// La bandeja muestra solo lo accionable. Cerradas viven en /historial
// para no mezclar y evitar que el operador piense que tiene que hacer algo.
type SectionKey = "handoff_requested" | "human_attending";

// Vistas por estado — el estado activo vive en la URL (?status=), lo escribe el
// submenú (OperatorSidebar) y este panel lo lee para filtrar la lista. Mismo
// patrón que el inbox del admin. "all" muestra las dos secciones combinadas.
type StatusView = "all" | SectionKey;

const VIEW_LABELS: Record<StatusView, string> = {
  all:               "Todas",
  handoff_requested: "En espera",
  human_attending:   "En atención",
};

// Vistas para el segmented control mobile (en desktop viven en el submenú).
const MOBILE_VIEWS: Array<{ key: StatusView; label: string }> = [
  { key: "all",               label: "Todas" },
  { key: "handoff_requested", label: "En espera" },
  { key: "human_attending",   label: "En atención" },
];

export type ConversationsPanelMode = "operator" | "admin-readonly";

// ── Sonidos de notificación (Web Audio) ───────────────────────────────────────
// Se libera el AudioContext al terminar: el browser limita ~6 simultáneos; sin
// cerrarlos, tras varias notificaciones el beep deja de sonar.
function _playTone(steps: Array<[number, number]>, peak: number, durationS: number) {
  try {
    const ctx  = new AudioContext();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    steps.forEach(([freq, at]) => osc.frequency.setValueAtTime(freq, ctx.currentTime + at));
    gain.gain.setValueAtTime(peak, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + durationS);
    osc.start(); osc.stop(ctx.currentTime + durationS);
    osc.onended = () => { ctx.close().catch(() => {}); };
  } catch { /* bloqueado hasta que haya interacción del usuario */ }
}
// Nueva derivación entrante: dos tonos, más presente.
function playHandoffBeep() { _playTone([[880, 0], [660, 0.12]], 0.25, 0.45); }
// Mensaje nuevo en una conversación que ya atendés: un solo tono, corto y suave.
function playMessageBeep() { _playTone([[520, 0]], 0.10, 0.16); }

// ── Main component ────────────────────────────────────────────────────────────

export function ConversationsPanel({ mode }: { mode: ConversationsPanelMode }) {
  const qc = useQueryClient();
  const [selectedId, setSelectedId]     = useState<string | null>(null);
  const [replyText, setReplyText]       = useState("");
  const [search, setSearch]             = useState("");
  const [showTransfer, setShowTransfer] = useState(false);

  // Vista y sector activos — desde la URL (los escribe el submenú OperatorSidebar
  // en desktop y el segmented control en mobile). Mismo patrón que el admin.
  const params = useSearchParams();
  const statusView = (params.get("status") ?? "all") as StatusView;
  const sectorFilter = params.get("sector") ?? "";
  const [transferSector, setTransferSector] = useState("");
  const [confirmRelease, setConfirmRelease] = useState(false);
  // Panel de contexto del afiliado (columna 3) — colapsable con pin, igual que el
  // inbox del admin. Arranca abierto en pantallas anchas.
  const [contextOpen, setContextOpen] = useState(true);
  const [sseConnected, setSseConnected] = useState(false);
  const [now, setNow] = useState<number>(() => Date.now());
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef    = useRef<HTMLTextAreaElement>(null);
  const fileInputRef   = useRef<HTMLInputElement>(null);
  const handoffIds     = useRef<Set<string>>(new Set());
  // Último unread_count visto por conversación atendida, para detectar mensajes
  // nuevos y sonar aunque el operador no la tenga abierta. unreadInit evita sonar
  // por el estado inicial al cargar la página.
  const unreadSeen     = useRef<Map<string, number>>(new Map());
  const unreadInit     = useRef(false);
  const readOnly = mode === "admin-readonly";

  // Adjunto pendiente: el operador elige el archivo y lo PREVISUALIZA antes de
  // enviarlo (antes se subía y mandaba al instante, sin chance de verificar).
  const [pendingFile, setPendingFile]       = useState<File | null>(null);
  const [pendingPreview, setPendingPreview] = useState<string | null>(null);

  // Tick for relative timestamps + urgency
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(id);
  }, []);

  // ── Queries ────────────────────────────────────────────────────────────────

  // Polling de respaldo: aunque el SSE este conectado, si se cae el cliente
  // se entera tarde. Refetch periodico garantiza que el operador siempre vea
  // los mensajes nuevos sin tener que recargar manualmente.
  const { data, isLoading, error } = useQuery({
    queryKey: ["operator-conversations", "all", mode],
    queryFn:  () => api.operator.listConversations(),
    staleTime: 5_000,
    refetchInterval: 6_000,
    refetchIntervalInBackground: false,
  });

  const { data: detail, isLoading: detailLoading } = useQuery({
    queryKey: ["conversation-detail", selectedId],
    queryFn:  () => api.operator.getConversation(selectedId!),
    enabled:  !!selectedId,
    staleTime: 2_000,
    // 2s cuando hay conv seleccionada: el operador necesita ver mensajes del
    // afiliado al instante. SSE sigue siendo el camino "rapido" cuando funciona.
    refetchInterval: 2_500,
    refetchIntervalInBackground: false,
  });

  const { data: sectorsData } = useQuery({
    queryKey: ["sectors"],
    queryFn:  api.sectors.list,
    staleTime: 60_000,
    enabled:  !readOnly,
  });

  const { data: presenceData } = useQuery({
    queryKey: ["operator-presence"],
    queryFn:  api.operator.presence,
    refetchInterval: 20_000,
    enabled: !readOnly,
  });

  const inv = () => {
    qc.invalidateQueries({ queryKey: ["operator-conversations"] });
    qc.invalidateQueries({ queryKey: ["conversation-detail", selectedId] });
  };

  // ── SSE ────────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (mode !== "operator") return;
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission();
    }

    const base    = process.env.NEXT_PUBLIC_API_URL || "";
    const token   = localStorage.getItem("access_token") ?? "";
    const tenantId = localStorage.getItem("tenant_id") ?? "";
    const es = new EventSource(
      `${base}/api/v1/operator/events?token=${encodeURIComponent(token)}&tenant_id=${encodeURIComponent(tenantId)}`
    );

    es.onopen = () => setSseConnected(true);
    es.onerror = () => setSseConnected(false);

    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        qc.invalidateQueries({ queryKey: ["operator-conversations"] });
        qc.invalidateQueries({ queryKey: ["operator-presence"] });
        if (event.conversation_id && event.conversation_id === selectedId) {
          qc.invalidateQueries({ queryKey: ["conversation-detail", selectedId] });
        }
      } catch { /* ignore */ }
    };

    return () => { es.close(); setSseConnected(false); };
  }, [mode, qc, selectedId]);

  // ── Notifications + sound on new handoff ──────────────────────────────────

  useEffect(() => {
    if (mode !== "operator") return;
    const all: ConversationRow[] = data?.sectors.flatMap((s: any) => s.conversations) ?? [];
    const waiting = all.filter(c => c.status === "handoff_requested");

    waiting.forEach(c => {
      if (handoffIds.current.has(c.id)) return;
      handoffIds.current.add(c.id);

      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        new Notification("Nueva derivación", {
          body: `${c.afiliado_nombre || "Usuario"} — ${c.sector_nombre || ""}`,
          icon: "/favicon.ico",
          tag: c.id,
        });
      }
      playHandoffBeep();
    });

    const activeIds = new Set(waiting.map(c => c.id));
    handoffIds.current.forEach(id => { if (!activeIds.has(id)) handoffIds.current.delete(id); });
  }, [data, mode]);

  // ── Sonido en mensaje nuevo de una conversación que atendés pero no tenés abierta ──

  useEffect(() => {
    if (mode !== "operator") return;
    const all: ConversationRow[] = data?.sectors.flatMap((s: any) => s.conversations) ?? [];
    const attending = all.filter(c => c.status === "human_attending");

    if (unreadInit.current) {
      attending.forEach(c => {
        const prev = unreadSeen.current.get(c.id) ?? 0;
        // Mensaje nuevo (subió el no-leído) en una conversación que NO es la abierta.
        if (c.unread_count > prev && c.id !== selectedId) {
          if (typeof Notification !== "undefined" && Notification.permission === "granted") {
            new Notification("Nuevo mensaje", {
              body: `${c.afiliado_nombre || "Usuario"} te escribió`,
              icon: "/favicon.ico",
              tag: c.id,
            });
          }
          playMessageBeep();
        }
      });
    }

    const next = new Map<string, number>();
    attending.forEach(c => next.set(c.id, c.unread_count));
    unreadSeen.current = next;
    unreadInit.current = true;
  }, [data, mode, selectedId]);

  // ── Mutations ──────────────────────────────────────────────────────────────

  // Helper para mutaciones optimistas en la lista de conversaciones.
  // El cache es { sectors: [{ conversations: [...] }] } — clonamos y mutamos
  // la conv que matchea por id. Si el backend rechaza, restauramos el snapshot.
  const _patchConv = (id: string, patch: Partial<ConversationRow>) => {
    qc.setQueryData(["operator-conversations"], (old: any) => {
      if (!old) return old;
      return {
        ...old,
        sectors: old.sectors.map((s: any) => ({
          ...s,
          conversations: s.conversations.map((c: ConversationRow) =>
            c.id === id ? { ...c, ...patch } : c
          ),
        })),
      };
    });
  };
  const _removeConv = (id: string) => {
    qc.setQueryData(["operator-conversations"], (old: any) => {
      if (!old) return old;
      return {
        ...old,
        sectors: old.sectors.map((s: any) => ({
          ...s,
          conversations: s.conversations.filter((c: ConversationRow) => c.id !== id),
        })),
      };
    });
  };

  const acceptM = useMutation({
    mutationFn: (id: string) => api.operator.accept(id),
    onMutate: async (id) => {
      // Optimistic: marca atendiendo + selecciona al instante. Si falla,
      // onError revierte. Sin esto el operador veia 200-400ms de "nada pasa"
      // tras clickear "Atender".
      await qc.cancelQueries({ queryKey: ["operator-conversations"] });
      const snapshot = qc.getQueryData(["operator-conversations"]);
      _patchConv(id, { status: "human_attending" as any });
      const prevSelected = selectedId;
      setSelectedId(id);
      return { snapshot, prevSelected };
    },
    onError: (_e, _id, ctx) => {
      if (ctx?.snapshot !== undefined) qc.setQueryData(["operator-conversations"], ctx.snapshot);
      if (ctx?.prevSelected !== undefined) setSelectedId(ctx.prevSelected);
      toast({ title: "No se pudo aceptar la conversación", variant: "destructive" });
    },
    onSuccess: () => {
      toast({ title: "Conversación aceptada — ya podés responder", variant: "success" });
    },
    onSettled: () => inv(),
  });

  const closeM = useMutation({
    mutationFn: (id: string) => api.operator.close(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ["operator-conversations"] });
      const snapshot = qc.getQueryData(["operator-conversations"]);
      _removeConv(id);
      const prevSelected = selectedId;
      const prevReply    = replyText;
      setSelectedId(null);
      setReplyText("");
      return { snapshot, prevSelected, prevReply };
    },
    onError: (_e, _id, ctx) => {
      if (ctx?.snapshot !== undefined) qc.setQueryData(["operator-conversations"], ctx.snapshot);
      if (ctx?.prevSelected !== undefined) setSelectedId(ctx.prevSelected);
      if (ctx?.prevReply !== undefined) setReplyText(ctx.prevReply);
      toast({ title: "No se pudo cerrar la conversación", variant: "destructive" });
    },
    onSuccess: () => toast({ title: "Conversación cerrada" }),
    onSettled: () => inv(),
  });

  const returnToBotM = useMutation({
    mutationFn: (id: string) => api.operator.returnToBot(id),
    onSuccess: () => {
      // Igual que el cierre: el operador ya no atiende esta conv, sacarla
      // de la vista para que vuelva a la bandeja.
      setSelectedId(null);
      setReplyText("");
      inv();
      toast({
        title: "Devuelta al bot",
        description: "El asistente automático va a seguir la conversación.",
        variant: "success",
      });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: extractErrorMessage(err, "No se pudo devolver al bot."), variant: "destructive" });
    },
  });

  const releaseM = useMutation({
    mutationFn: (id: string) => api.operator.release(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ["operator-conversations"] });
      const snapshot = qc.getQueryData(["operator-conversations"]);
      // Vuelve a "esperando operador": status handoff_requested + se saca del slot
      // de este operador. La UI re-renderiza al instante.
      // assigned_operator_id no esta en el type — pasamos solo status (suficiente para
      // que el conv salga del slot del operador en la UI).
      _patchConv(id, { status: "handoff_requested" as any });
      const prevSelected = selectedId;
      setSelectedId(null);
      setConfirmRelease(false);
      return { snapshot, prevSelected };
    },
    onError: (_e, _id, ctx) => {
      if (ctx?.snapshot !== undefined) qc.setQueryData(["operator-conversations"], ctx.snapshot);
      if (ctx?.prevSelected !== undefined) setSelectedId(ctx.prevSelected);
      toast({ title: "Error al devolver", variant: "destructive" });
    },
    onSuccess: () => toast({ title: "Conversación devuelta a la cola", variant: "success" }),
    onSettled: () => inv(),
  });

  const attachM = useMutation({
    mutationFn: ({ id, file }: { id: string; file: File }) => api.operator.uploadAttachment(id, file),
    onSuccess: () => { inv(); toast({ title: "Archivo enviado", variant: "success" }); },
    onError:   (err: any) => {
      toast({ title: "No se pudo enviar el archivo", description: extractErrorMessage(err, "Intentá de nuevo."), variant: "destructive" });
    },
  });

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !detail) return;
    const ok = ["image/png", "image/jpeg", "image/jpg", "image/webp", "application/pdf"];
    if (!ok.includes(file.type)) { toast({ title: "Formato no permitido", description: "Solo imágenes (PNG/JPG/WEBP) o PDF.", variant: "destructive" }); return; }
    if (file.size > 10 * 1024 * 1024) { toast({ title: "Archivo muy grande", description: "El máximo es 10 MB.", variant: "destructive" }); return; }
    // No se envía todavía: queda como adjunto pendiente con preview.
    if (pendingPreview) URL.revokeObjectURL(pendingPreview);
    setPendingFile(file);
    setPendingPreview(file.type.startsWith("image/") ? URL.createObjectURL(file) : null);
  }

  function clearPending() {
    if (pendingPreview) URL.revokeObjectURL(pendingPreview);
    setPendingFile(null);
    setPendingPreview(null);
  }

  // Envía el mensaje: primero el adjunto pendiente (si hay), luego el texto (si hay).
  function handleSend() {
    if (!detail) return;
    if (pendingFile) { attachM.mutate({ id: detail.id, file: pendingFile }); clearPending(); }
    const t = replyText.trim();
    if (t) replyM.mutate({ id: detail.id, content: t });
  }

  const replyM = useMutation({
    mutationFn: ({ id, content }: { id: string; content: string }) => api.operator.reply(id, content),
    // Optimista: insertamos la burbuja del operador al instante con estado
    // "enviando" y limpiamos el textarea. Antes el operador escribía, apretaba
    // Enter y no veía nada hasta el refetch (~2s) — dudaba si se había enviado.
    onMutate: async ({ id, content }) => {
      await qc.cancelQueries({ queryKey: ["conversation-detail", id] });
      const snapshot = qc.getQueryData(["conversation-detail", id]);
      const tempId = `temp-${Date.now()}`;
      qc.setQueryData(["conversation-detail", id], (old: any) => {
        if (!old) return old;
        return {
          ...old,
          messages: [...(old.messages ?? []), {
            id: tempId, sender_type: "operator", content,
            created_at: new Date().toISOString(), pending: true,
          }],
        };
      });
      const prevReply = replyText;
      setReplyText("");
      return { snapshot, prevReply, id };
    },
    onError: (err: any, _vars, ctx) => {
      // Revertir la burbuja optimista y restaurar el texto para que no se pierda.
      if (ctx?.snapshot !== undefined) qc.setQueryData(["conversation-detail", ctx.id], ctx.snapshot);
      if (ctx?.prevReply !== undefined) setReplyText(ctx.prevReply);
      // Backend devuelve 409 con detail descriptivo cuando la conversación
      // está cerrada o el afiliado abandonó (>12h inactivo).
      toast({
        title: "No se pudo enviar",
        description: extractErrorMessage(err, "No se pudo enviar el mensaje."),
        variant: "destructive",
      });
    },
    onSuccess: () => { textareaRef.current?.focus(); },
    // Refetch siempre: reemplaza la burbuja temporal por el mensaje real del backend.
    onSettled: (_d, _e, vars) => {
      qc.invalidateQueries({ queryKey: ["conversation-detail", vars.id] });
      qc.invalidateQueries({ queryKey: ["operator-conversations"] });
    },
  });

  const transferM = useMutation({
    mutationFn: ({ id, sectorId }: { id: string; sectorId: string }) =>
      api.operator.transfer(id, sectorId),
    onSuccess: () => {
      // Transferir mueve la conv a otro sector — este operador ya no la
      // atiende. Deseleccionar para volver a la bandeja, igual que close
      // y returnToBot.
      setSelectedId(null);
      setReplyText("");
      setShowTransfer(false);
      setTransferSector("");
      inv();
      toast({ title: "Conversación transferida", variant: "success" });
    },
  });

  // ── Auto-scroll to bottom on new messages ─────────────────────────────────

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [detail?.messages?.length]);

  // ── Tab title ──────────────────────────────────────────────────────────────

  const allConvs: ConversationRow[] = data?.sectors.flatMap((s: any) => s.conversations) ?? [];
  const waitingCount    = allConvs.filter(c => c.status === "handoff_requested").length;
  const attendingCount  = allConvs.filter(c => c.status === "human_attending").length;

  useEffect(() => {
    if (mode !== "operator") return;
    const original = document.title;
    document.title = waitingCount > 0 ? `(${waitingCount}) Panel Operador` : "Panel Operador";
    return () => { document.title = original; };
  }, [waitingCount, mode]);

  // ── Filtered + segmented ───────────────────────────────────────────────────

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allConvs.filter(c => {
      if (sectorFilter && c.sector_id !== sectorFilter) return false;
      if (!q) return true;
      return (c.afiliado_nombre || "").toLowerCase().includes(q) ||
             (c.sector_nombre   || "").toLowerCase().includes(q);
    });
  }, [allConvs, search, sectorFilter]);

  const sections = useMemo(() => segmentAndSort(filtered, now), [filtered, now]);

  // Lista plana según la vista activa (las secciones ahora viven en el submenú).
  // "all" combina espera + atención (espera primero, ya viene ordenado por urgencia).
  const displayed = useMemo<ConversationRow[]>(() => {
    if (statusView === "handoff_requested") return sections.handoff_requested;
    if (statusView === "human_attending")   return sections.human_attending;
    return [...sections.handoff_requested, ...sections.human_attending];
  }, [sections, statusView]);

  // href para el segmented control mobile (preserva el sector activo).
  const viewHref = (key: StatusView) => {
    const p = new URLSearchParams();
    if (key !== "all")   p.set("status", key);
    if (sectorFilter)    p.set("sector", sectorFilter);
    const q = p.toString();
    return "/operator" + (q ? `?${q}` : "");
  };
  const onlineNames = useMemo(
    () => new Set((presenceData?.operators ?? []).map(o => o.name)),
    [presenceData],
  );

  // Split messages into bot-phase and operator-phase for context separation
  const { botMessages, operatorMessages } = useMemo(() => {
    if (!detail?.messages) return { botMessages: [], operatorMessages: [] };
    const msgs = detail.messages;
    // Split ONLY at the first real operator message — system messages stay in bot phase
    const firstOperatorIdx = msgs.findIndex(m => m.sender_type === "operator");
    if (firstOperatorIdx === -1) return { botMessages: msgs, operatorMessages: [] };
    return { botMessages: msgs.slice(0, firstOperatorIdx), operatorMessages: msgs.slice(firstOperatorIdx) };
  }, [detail?.messages]);

  const availableSectors = (sectorsData as any)?.sectors ?? sectorsData ?? [];

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full min-h-0 overflow-hidden">

      {/* Anuncio para lectores de pantalla: el panel cambia en tiempo real (SSE),
          esta región avisa cuántas conversaciones esperan sin que el operador
          tenga que re-tabular la lista. */}
      {!readOnly && (
        <div aria-live="polite" className="sr-only">
          {waitingCount === 0
            ? "Sin conversaciones en espera"
            : `${waitingCount} ${waitingCount === 1 ? "conversación en espera" : "conversaciones en espera"}`}
        </div>
      )}

      {/* ── Columna 1: bandeja (misma estructura que el inbox del admin) ──── */}
      <div className={cn(
        "flex min-h-0 flex-col lg:w-[360px] lg:shrink-0 lg:border-r",
        selectedId ? "hidden w-full lg:flex" : "flex w-full"
      )}>

        {/* Header: vista activa + total (mismo patrón que el inbox del admin;
            las vistas por estado viven en el submenú OperatorSidebar). */}
        <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <h2 className="text-[15px] font-semibold tracking-tight text-foreground">{VIEW_LABELS[statusView]}</h2>
          {!isLoading && (
            <span className="text-xs tabular-nums text-muted-foreground">{displayed.length}</span>
          )}
        </div>

        {/* Segmented control de vistas — SOLO mobile (en desktop está el submenú). */}
        <div className="shrink-0 px-3 pt-2 lg:hidden">
          <div className="flex items-center gap-1 rounded-xl bg-muted/60 p-1">
            {MOBILE_VIEWS.map(v => {
              const active = statusView === v.key;
              const count = v.key === "handoff_requested" ? sections.handoff_requested.length
                          : v.key === "human_attending"   ? sections.human_attending.length
                          : displayed.length;
              return (
                <Link
                  key={v.key}
                  href={viewHref(v.key)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium transition-all",
                    active ? "bg-card text-foreground font-semibold shadow-xs" : "text-muted-foreground",
                  )}
                >
                  {v.label}
                  {count > 0 && <span className="tabular-nums opacity-70">{count}</span>}
                </Link>
              );
            })}
          </div>
        </div>

        {/* Búsqueda — subfila (igual que el inbox del admin). */}
        <div className="shrink-0 px-3 pb-2 pt-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              aria-label="Buscar conversaciones"
              placeholder="Buscar…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full h-8 pl-8 pr-3 rounded-lg bg-muted/60 text-[13px] placeholder:text-muted-foreground focus:bg-card focus:outline-none focus-visible:ring-2 focus-visible:ring-action/40 transition-colors"
            />
          </div>
        </div>

        {/* Lista plana de conversaciones (filtrada por la vista activa) */}
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-slim p-2 space-y-1.5">
          {isLoading ? (
            Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-16 rounded-lg" />)
          ) : error ? (
            <p className="text-xs text-destructive text-center py-8">Error al cargar</p>
          ) : (data?.sectors?.length ?? 0) === 0 && !readOnly ? (
            <div className="text-center py-12 px-4 text-muted-foreground space-y-2">
              <MessageSquare className="h-8 w-8 mx-auto opacity-20" />
              <p className="text-sm font-medium text-foreground/70">Sin sectores asignados</p>
              <p className="text-xs leading-relaxed">
                No tenés sectores asignados. Pedile al administrador que te asigne los sectores que vas a atender.
              </p>
            </div>
          ) : displayed.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <MessageSquare className="h-8 w-8 mx-auto mb-2 opacity-20" />
              <p className="text-xs">
                {search ? "Sin resultados"
                  : statusView === "handoff_requested" ? "Sin conversaciones en espera"
                  : statusView === "human_attending"   ? "No estás atendiendo ninguna conversación"
                  : "Sin conversaciones activas"}
              </p>
            </div>
          ) : (
            displayed.map(conv => (
              <ConvCard
                key={conv.id}
                conv={conv}
                now={now}
                selected={selectedId === conv.id}
                readOnly={readOnly}
                onlineNames={onlineNames}
                onSelect={() => setSelectedId(conv.id)}
                onAccept={() => acceptM.mutate(conv.id)}
                accepting={acceptM.isPending && acceptM.variables === conv.id}
              />
            ))
          )}
        </div>
      </div>

      {/* ── Columna 2: conversación ──────────────────────────────────────── */}
      <div className={cn(
        "flex min-h-0 flex-1 flex-col min-w-0",
        !selectedId && "hidden lg:flex"
      )}>
        {!selectedId ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <div className="text-center space-y-2 px-10">
              <MessageSquare className="h-10 w-10 mx-auto opacity-15" />
              <p className="text-sm">Elegí una conversación</p>
              <p className="text-xs opacity-70 max-w-xs mx-auto leading-relaxed">
                Seleccioná una conversación de la lista para ver los mensajes y atenderla.
              </p>
            </div>
          </div>
        ) : detailLoading ? (
          // Skeleton de chat (no un panel vacío): al saltar entre conversaciones
          // el operador ve la estructura cargando, no un parpadeo en blanco.
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex h-[53px] shrink-0 items-center border-b px-4">
              <Skeleton className="h-4 w-40" />
            </div>
            <div className="mx-auto w-full max-w-3xl flex-1 space-y-3 p-4">
              <Skeleton className="h-12 w-2/3 rounded-2xl" />
              <Skeleton className="h-12 w-1/2 rounded-2xl ml-auto" />
              <Skeleton className="h-10 w-3/5 rounded-2xl" />
            </div>
          </div>
        ) : detail ? (
          <>
            {/* ── Header ── (h-12: la línea divisoria alinea con la lista y el
                panel de contexto. Los datos del afiliado —sector, DNI, email—
                viven en el panel de la derecha, no acá, para no desalinear.) */}
            <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
              <button
                onClick={() => setSelectedId(null)}
                className="lg:hidden -ml-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                aria-label="Volver"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <p className="min-w-0 flex-1 truncate text-sm font-semibold">{detail.afiliado_nombre || (detail.afiliado_ip ? `IP ${detail.afiliado_ip}` : "Afiliado anónimo")}</p>
              <StatusBadge status={detail.status} />
              {detail.channel === "whatsapp" && <span aria-label="WhatsApp" className="shrink-0 inline-flex items-center gap-1 text-[10px] font-semibold bg-green-600/10 text-green-700 rounded px-1.5 py-0.5"><WhatsAppIcon className="h-2.5 w-2.5" />WhatsApp</span>}
              <div className="flex items-center gap-2 shrink-0">
                {!readOnly && detail.status === "human_attending" && (
                  <>
                    {/* Acción primaria — la más común al terminar una atención */}
                    <Button
                      size="sm" className="h-8"
                      onClick={() => closeM.mutate(detail.id)}
                      disabled={closeM.isPending}
                    >
                      {closeM.isPending
                        ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                        : <XCircle className="h-3.5 w-3.5 mr-1.5" />}
                      Cerrar conversación
                    </Button>

                    {/* Acciones secundarias agrupadas en dropdown — antes eran 3
                        botones sueltos, dos con label "Devolver" que confundian. */}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          size="icon"
                          variant="outline"
                          className="h-8 w-8"
                          aria-label="Más acciones"
                          disabled={releaseM.isPending || transferM.isPending || returnToBotM.isPending}
                        >
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-64">
                        <DropdownMenuItem onSelect={() => setShowTransfer(true)}>
                          <ArrowRightLeft className="h-4 w-4 mr-2" />
                          <div className="flex flex-col">
                            <span>Transferir a otro sector</span>
                            <span className="text-[11px] text-muted-foreground">
                              Lo atiende otro equipo
                            </span>
                          </div>
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => setConfirmRelease(true)}>
                          <UserMinus className="h-4 w-4 mr-2" />
                          <div className="flex flex-col">
                            <span>Liberar a la cola</span>
                            <span className="text-[11px] text-muted-foreground">
                              Otro operador del mismo sector la toma
                            </span>
                          </div>
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => returnToBotM.mutate(detail.id)}>
                          <RotateCcw className="h-4 w-4 mr-2" />
                          <div className="flex flex-col">
                            <span>Pasar al asistente automático</span>
                            <span className="text-[11px] text-muted-foreground">
                              El bot retoma la conversación
                            </span>
                          </div>
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </>
                )}
                {readOnly && <Eye className="h-4 w-4 text-muted-foreground" />}

                {/* Pin del panel de contexto: reaparece SOLO cuando está contraído,
                    en pantallas anchas (igual que el inbox del admin). */}
                {!contextOpen && (
                  <button
                    onClick={() => setContextOpen(true)}
                    className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground xl:flex focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring animate-fade-in"
                    aria-label="Mostrar información del afiliado"
                    title="Mostrar información del afiliado"
                  >
                    <PanelRight className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>

            {/* Transfer panel */}
            {showTransfer && (
              <div className="px-4 py-3 border-b bg-muted/40 flex items-center gap-2">
                <select
                  value={transferSector}
                  aria-label="Sector de destino para transferir"
                  onChange={e => setTransferSector(e.target.value)}
                  className="flex-1 h-8 rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="">Elegí un sector…</option>
                  {availableSectors
                    .filter((s: any) => s.id !== detail.sector_id)
                    .map((s: any) => <option key={s.id} value={s.id}>{s.nombre}</option>)}
                </select>
                <Button
                  size="sm" className="h-8" disabled={!transferSector || transferM.isPending}
                  onClick={() => transferM.mutate({ id: detail.id, sectorId: transferSector })}
                >
                  {transferM.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Confirmar"}
                </Button>
                <Button size="sm" variant="ghost" className="h-8" onClick={() => setShowTransfer(false)}>
                  Cancelar
                </Button>
              </div>
            )}

            {/* ── Messages ── */}
            <div className="min-h-0 flex-1 overflow-y-auto scrollbar-slim">
             <div className="mx-auto w-full max-w-3xl space-y-3 p-4">
              {/* Bot phase — shown inline, no collapsible box */}
              {botMessages.map(m => <MessageBubble key={m.id} msg={m} conversationId={detail.id} />)}

              {/* Separator marking the handoff */}
              {operatorMessages.length > 0 && botMessages.length > 0 && (
                <div className="flex items-center gap-2 py-1">
                  <div className="flex-1 border-t border-dashed border-border" />
                  <span className="text-[11px] text-muted-foreground shrink-0 flex items-center gap-1">
                    <UserCheck className="h-3 w-3" /> Operador tomó la conversación
                  </span>
                  <div className="flex-1 border-t border-dashed border-border" />
                </div>
              )}

              {/* Operator phase */}
              {operatorMessages.map(m => <MessageBubble key={m.id} msg={m} conversationId={detail.id} />)}

              <div ref={messagesEndRef} />
             </div>
            </div>

            {/* Banner cuando la conversación está cerrada — read-only explícito */}
            {detail.status === "closed" && (
              <div className="px-4 py-2.5 border-t bg-muted/50 flex items-center gap-2 text-xs text-muted-foreground">
                <XCircle className="h-3.5 w-3.5 shrink-0" />
                <span>
                  Conversación cerrada. No se pueden enviar mensajes — el afiliado ya no está
                  conectado a esta sesión.
                </span>
              </div>
            )}

            {/* Banner cuando el afiliado lleva mucho sin escribir (>2h) — warning preventivo */}
            {!readOnly && detail.status === "human_attending" && (() => {
              // Buscar el último mensaje del afiliado para calcular cuánto lleva sin actividad
              const userMsgs = detail.messages.filter(m => m.sender_type === "user");
              const lastUserMsg = userMsgs[userMsgs.length - 1];
              if (!lastUserMsg) return null;
              const ageMs = Date.now() - new Date(lastUserMsg.created_at).getTime();
              const HOURS_2 = 2 * 3600 * 1000;
              const HOURS_12 = 12 * 3600 * 1000;
              if (ageMs < HOURS_2) return null;
              const ageHr = Math.floor(ageMs / 3600000);
              const isStale = ageMs > HOURS_12;
              return (
                <div className={cn(
                  "px-4 py-2.5 border-t flex items-center gap-2 text-xs",
                  isStale ? "bg-destructive/10 text-destructive border-destructive/20" : "bg-warning/10 text-warning border-warning/20",
                )}>
                  <Info className="h-3.5 w-3.5 shrink-0" />
                  <span>
                    {isStale ? (
                      <>
                        El afiliado lleva <span className="font-semibold">{ageHr}h</span> sin escribir.
                        La sesión probablemente fue abandonada — el sistema la va a cerrar automáticamente.
                      </>
                    ) : (
                      <>
                        El afiliado lleva <span className="font-semibold">{ageHr}h</span> sin escribir.
                        Puede no estar disponible.
                      </>
                    )}
                  </span>
                </div>
              );
            })()}

            {/* ── Reply ── */}
            {!readOnly && detail.status === "human_attending" && (
              <div className="border-t bg-card">
                <div className="max-w-3xl mx-auto w-full">
                {/* Preview del adjunto pendiente — revisar antes de enviar */}
                {pendingFile && (
                  <div className="px-4 pt-3">
                    <div className="inline-flex items-center gap-2 rounded-lg border bg-muted/40 pl-2 pr-1.5 py-1.5 max-w-full">
                      {pendingPreview ? (
                        <img src={pendingPreview} alt={pendingFile.name} className="h-9 w-9 rounded object-cover shrink-0" />
                      ) : (
                        <span className="h-9 w-9 rounded bg-muted flex items-center justify-center shrink-0">
                          <Paperclip className="h-4 w-4 text-muted-foreground" />
                        </span>
                      )}
                      <span className="text-xs truncate max-w-[180px]">{pendingFile.name}</span>
                      <span className="text-[11px] text-muted-foreground shrink-0">{(pendingFile.size / 1024).toFixed(0)} KB</span>
                      <button onClick={clearPending}
                              className="ml-1 h-6 w-6 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
                              aria-label="Quitar adjunto">
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                )}
                <div className="px-4 py-3 flex gap-2 items-end">
                  <input ref={fileInputRef} type="file" className="hidden"
                         accept="image/png,image/jpeg,image/jpg,image/webp,application/pdf" onChange={onPickFile} />
                  <Button variant="ghost" size="icon" className="h-10 w-10 shrink-0"
                          disabled={attachM.isPending} title="Adjuntar imagen o PDF (máx. 10 MB)"
                          onClick={() => fileInputRef.current?.click()}>
                    {attachM.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
                  </Button>
                  <textarea
                    ref={textareaRef}
                    rows={2}
                    placeholder="Escribí tu mensaje…"
                    value={replyText}
                    onChange={e => setReplyText(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === "Enter" && !e.shiftKey && (replyText.trim() || pendingFile)) {
                        e.preventDefault();
                        handleSend();
                      }
                    }}
                    className="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/20 min-h-[60px] max-h-40"
                  />
                  <Button
                    className="h-10 px-3 shrink-0"
                    disabled={(!replyText.trim() && !pendingFile) || replyM.isPending || attachM.isPending}
                    onClick={handleSend}
                  >
                    {(replyM.isPending || attachM.isPending) ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  </Button>
                </div>
                </div>
              </div>
            )}

            {/* Prompt to accept — paints up with the same urgency scale as the inbox card */}
            {!readOnly && detail.status === "handoff_requested" && (() => {
              const waitMs = msSince(detail.handoff_requested_at ?? detail.last_message_at ?? detail.created_at, now);
              const waitStr = formatRelative(waitMs);
              const level: "warn" | "urgent" | "critical" =
                waitMs > VERY_URGENT_MS ? "critical" :
                waitMs > URGENT_MS      ? "urgent"   :
                "warn";

              const bannerBg =
                level === "critical" ? "bg-destructive/10 border-t border-destructive/20" :
                level === "urgent"   ? "bg-warning/10 border-t border-warning/20" :
                "bg-warning/5 border-t border-warning/20";

              const messageClass =
                level === "critical" ? "text-destructive" :
                level === "urgent"   ? "text-warning"     :
                "text-warning";

              // Mismo criterio que el "Atender" de la lista: el CTA acompaña
              // la urgencia (rojo fuerte / ámbar / acción normal).
              const buttonClass =
                level === "critical" ? "bg-destructive hover:bg-destructive/90 text-destructive-foreground" :
                level === "urgent"   ? "bg-warning hover:bg-warning/90 text-warning-foreground" :
                "bg-primary hover:bg-primary/90 text-primary-foreground";

              return (
                <div className={cn("px-4 py-3 text-center", bannerBg)}>
                  <p className={cn("text-xs mb-2", messageClass)}>
                    {level === "critical"
                      ? <>Este usuario lleva <strong>{waitStr}</strong> esperando atención humana.</>
                      : <>Este usuario está esperando atención humana <span className="opacity-70">· {waitStr}</span></>}
                  </p>
                  <button
                    onClick={() => acceptM.mutate(detail.id)}
                    disabled={acceptM.isPending}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md text-sm font-medium px-3 h-9 transition-colors disabled:opacity-60",
                      buttonClass,
                    )}
                  >
                    {acceptM.isPending
                      ? <Loader2 className="h-4 w-4 animate-spin" />
                      : <UserCheck className="h-4 w-4" />}
                    Atender ahora
                  </button>
                </div>
              );
            })()}
          </>
        ) : null}
      </div>

      {/* ── Columna 3: contexto del afiliado (pantallas anchas, colapsable) ── */}
      {/* Igual que el inbox del admin: el ancho anima entre 272px y 0; el contenido
          va en un wrapper de ancho FIJO para que no se reacomode durante el slide. */}
      {selectedId && (
        <aside
          className={cn(
            "hidden min-h-0 shrink-0 flex-col overflow-hidden xl:flex",
            "transition-[width,border-color] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
            contextOpen ? "w-[272px] border-l" : "w-0 border-l border-l-transparent",
          )}
          aria-label="Información del afiliado"
          aria-hidden={!contextOpen}
        >
          <div className="flex min-h-0 w-[272px] shrink-0 flex-1 flex-col overflow-y-auto scrollbar-slim">
            <ConversationContextPanel
              detail={detail ?? null}
              loading={detailLoading}
              onCollapse={() => setContextOpen(false)}
            />
          </div>
        </aside>
      )}

      {/* Release-to-queue confirmation */}
      <Dialog open={confirmRelease} onOpenChange={(open) => !open && setConfirmRelease(false)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>¿Devolver esta conversación a la cola?</DialogTitle>
            <DialogDescription>
              Volverá al estado de espera para que otro operador la atienda.
              Los mensajes enviados no se borran.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmRelease(false)}>
              Cancelar
            </Button>
            <Button
              onClick={() => detail && releaseM.mutate(detail.id)}
              disabled={releaseM.isPending}
            >
              {releaseM.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              Devolver a la cola
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Status badge ───────────────────────────────────────────────────────────────

export function StatusBadge({ status }: { status: string }) {
  // "Bot activo" y "Cerrada" eran ambos bg-muted → indistinguibles de un
  // vistazo. "Cerrada" pasa a borde sin relleno (estado terminal, apagado);
  // "Bot activo" mantiene el relleno suave (estado vivo).
  const map: Record<string, { label: string; cls: string }> = {
    bot_active:        { label: "Bot activo",   cls: "bg-muted text-muted-foreground" },
    handoff_requested: { label: "En espera",    cls: "bg-warning/15 text-warning" },
    human_attending:   { label: "En atención",  cls: "bg-success/15 text-success" },
    closed:            { label: "Cerrada",       cls: "border border-border bg-background text-muted-foreground/80" },
  };
  const s = map[status] ?? { label: status, cls: "bg-muted text-muted-foreground" };
  return <span className={cn("shrink-0 text-xs font-medium px-2 py-0.5 rounded-full", s.cls)}>{s.label}</span>;
}

// ── Conversation card ──────────────────────────────────────────────────────────

function ConvCard({ conv, now, selected, readOnly, onlineNames, onSelect, onAccept, accepting }: {
  conv: ConversationRow; now: number; selected: boolean; readOnly: boolean;
  onlineNames: Set<string>;
  onSelect: () => void; onAccept: () => void; accepting: boolean;
}) {
  // "Esperando operador" (handoff_requested) se mide desde que entró a la cola
  // (handoff_requested_at), no desde el último mensaje — así no se reinicia si el
  // afiliado sigue escribiendo. "En atención" sí se mide desde el último mensaje.
  // Fallback a last_message_at/created_at para conversaciones previas a la columna.
  const ms             = conv.status === "handoff_requested"
    ? msSince(conv.handoff_requested_at ?? conv.last_message_at ?? conv.created_at, now)
    : msSince(conv.last_message_at ?? conv.created_at, now);
  const ageStr         = formatRelative(ms);
  const yourTurn       = conv.status === "human_attending" && conv.last_message_sender === "user";
  const operatorOnline = conv.operator_name ? onlineNames.has(conv.operator_name) : false;

  const isHandoff = conv.status === "handoff_requested";

  // Three-tier urgency for waiting conversations. The whole card paints up
  // so an operator can spot pressure peripherally without scanning each row.
  // < 2min: calm amber accent (dot + time)
  // 2-5min: amber background
  // 5min+:  red background, pulsing dot — top priority
  const urgencyLevel: "none" | "warn" | "urgent" | "critical" =
    !isHandoff           ? "none" :
    ms > VERY_URGENT_MS  ? "critical" :
    ms > URGENT_MS       ? "urgent"   :
    "warn";

  const attending = conv.status === "human_attending";

  const dotColor =
    urgencyLevel === "critical" ? "bg-destructive" :
    urgencyLevel === "urgent"   ? "bg-warning"     :
    urgencyLevel === "warn"     ? "bg-warning"     :
    yourTurn                    ? "bg-attention"   :
    attending                   ? "bg-success"     :
    "bg-transparent";

  const dotPulse = urgencyLevel === "critical" || yourTurn;

  // El tiempo solo se tiñe cuando hay presión real (urgent/critical) o es tu
  // turno. En warn y attending el dot + fondo ya comunican el estado, así que
  // el tiempo queda neutro para no apilar tres señales del mismo color.
  const timeClass =
    urgencyLevel === "critical" ? "font-semibold text-destructive" :
    urgencyLevel === "urgent"   ? "font-semibold text-warning"     :
    yourTurn                    ? "font-semibold text-attention"   :
    "text-muted-foreground";

  // El botón "Atender" acompaña la urgencia: rojo fuerte en crítico, ámbar en
  // urgente, acción normal en calma. En una cola, el color del CTA es la señal
  // más directa de "esto primero" (decisión revisada: antes era estable para no
  // leerse como destructivo, pero el label "Atender" + contexto lo desambigua).
  const acceptClass =
    urgencyLevel === "critical" ? "bg-destructive hover:bg-destructive/90 text-destructive-foreground" :
    urgencyLevel === "urgent"   ? "bg-warning hover:bg-warning/90 text-warning-foreground" :
    "bg-primary hover:bg-primary/90 text-primary-foreground";

  // Unread count only while operator is actively attending — for "en espera"
  // every message is unread by definition, so the badge adds no information.
  const showUnread = conv.unread_count > 0 && conv.status === "human_attending";

  // Señal de triage: barra de acento a la izquierda (ancho FIJO 3px, transparente
  // cuando no hay estado → todas las filas alinean) + tinte suave del fondo según
  // urgencia. Fuerte en lo accionable (en espera / tu turno), calmo en lo que ya
  // se atiende. Corrés la vista por el borde y detectás qué requiere acción.
  const accentBar =
    urgencyLevel === "critical" ? "border-l-destructive" :
    urgencyLevel === "urgent"   ? "border-l-warning"     :
    urgencyLevel === "warn"     ? "border-l-warning"     :
    yourTurn                    ? "border-l-attention"   :
    attending                   ? "border-l-success"     :
    "border-l-transparent";
  const rowTint = selected
    ? "bg-muted/70"
    : urgencyLevel === "critical" ? "bg-destructive/[0.07] hover:bg-destructive/10" :
      urgencyLevel === "urgent"   ? "bg-warning/[0.08] hover:bg-warning/[0.12]"     :
      urgencyLevel === "warn"     ? "bg-warning/[0.05] hover:bg-warning/[0.09]"     :
      yourTurn                    ? "bg-attention/[0.07] hover:bg-attention/[0.11]" :
      attending                   ? "bg-success/[0.04] hover:bg-success/[0.08]"     :
      "hover:bg-muted/40";

  return (
    <div
      className={cn(
        "group rounded-lg border-l-[3px] transition-colors",
        accentBar,
        rowTint,
      )}
    >
      <div className="flex items-start gap-3 px-3 py-2.5">
        {/* Avatar con punto de estado en la esquina — misma fila limpia que el
            inbox del admin; el color de urgencia va en el punto y en la hora,
            sin teñir toda la burbuja. */}
        <span className="relative mt-0.5 shrink-0">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-muted text-sm font-semibold text-muted-foreground">
            {conv.afiliado_nombre?.trim()[0]?.toUpperCase()
              ?? (conv.channel === "whatsapp" ? <WhatsAppIcon className="h-4 w-4" /> : <User className="h-4 w-4" />)}
          </span>
          {dotColor !== "bg-transparent" && (
            <span
              className={cn(
                "absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-background",
                dotColor,
                dotPulse && "animate-pulse motion-reduce:animate-none",
              )}
              aria-hidden
            />
          )}
        </span>

        <button onClick={onSelect} className="flex-1 min-w-0 text-left">
          <p className="text-sm font-medium leading-tight flex items-center gap-1.5 min-w-0">
            {conv.is_test && <span aria-label="Conversación de prueba" className="shrink-0 text-[10px] font-bold bg-primary/10 text-primary rounded px-1 py-0.5 uppercase tracking-wide">TEST</span>}
            <span className="truncate min-w-0">{conv.afiliado_nombre || (conv.channel === "whatsapp" && conv.external_id ? formatWaNumber(conv.external_id) : (conv.afiliado_ip ? `IP ${conv.afiliado_ip}` : "Anónimo"))}</span>
            {conv.channel === "whatsapp"
              ? <span aria-label="WhatsApp" className="shrink-0 inline-flex items-center gap-0.5 text-[10px] font-semibold bg-green-600/10 text-green-700 rounded px-1.5 py-0.5"><WhatsAppIcon className="h-2.5 w-2.5" />WA</span>
              : !conv.afiliado_nombre
                ? <span aria-label="Web" className="shrink-0 inline-flex items-center gap-0.5 text-[10px] font-medium text-muted-foreground"><Globe className="h-2.5 w-2.5" />Web</span>
                : null}
          </p>
          <p className="text-[11px] text-muted-foreground truncate mt-0.5">
            {conv.sector_nombre || "Sin sector"}
          </p>
          {/* Operator name only matters cross-operator (admin view). Hidden
              in the operator's own inbox where every card is theirs. */}
          {readOnly && conv.operator_name && (
            <p className="text-[11px] mt-0.5 flex items-center gap-1">
              <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", operatorOnline ? "bg-success" : "bg-muted-foreground/40")} />
              <span className={cn("truncate", operatorOnline ? "text-success font-medium" : "text-muted-foreground")}>
                {conv.operator_name}
              </span>
            </p>
          )}
        </button>

        <div className="shrink-0 flex flex-col items-end gap-1">
          <span className={cn("text-[11px] tabular-nums flex items-center gap-1", timeClass)}>
            {ageStr}
          </span>

          {showUnread && (
            <span className="bg-action text-action-foreground rounded-full text-[10px] min-w-4 h-4 px-1 flex items-center justify-center font-semibold">
              {conv.unread_count > 9 ? "9+" : conv.unread_count}
            </span>
          )}

          {yourTurn && (
            <span className="text-[11px] font-semibold text-attention">tu turno</span>
          )}

          {!readOnly && isHandoff && (
            <button
              onClick={e => { e.stopPropagation(); onAccept(); }}
              disabled={accepting}
              className={cn(
                "inline-flex items-center gap-1 rounded-md text-[11px] font-medium px-2 h-6 transition-colors disabled:opacity-60",
                acceptClass,
              )}
            >
              {accepting
                ? <Loader2 className="h-3 w-3 animate-spin" />
                : <UserCheck className="h-3 w-3" />}
              Atender
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Message bubble ─────────────────────────────────────────────────────────────

function AttachmentView({ conversationId, messageId, name, mime }:
  { conversationId: string; messageId: string; name: string; mime: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<"expired" | "failed" | null>(null);
  const [preview, setPreview] = useState(false);
  useEffect(() => {
    let active = true;
    let created: string | null = null;
    api.operator.attachmentBlobUrl(conversationId, messageId)
      .then(u => { if (active) { created = u; setUrl(u); } else { URL.revokeObjectURL(u); } })
      .catch((e: any) => {
        // 410 = la retención (60 días) ya borró el archivo; el mensaje queda.
        if (active) setErr(e?.response?.status === 410 ? "expired" : "failed");
      });
    return () => { active = false; if (created) URL.revokeObjectURL(created); };
  }, [conversationId, messageId]);
  if (err === "expired") return (
    <span className="text-[11px] opacity-60 mt-1 inline-flex items-center gap-1">
      <Paperclip className="h-3 w-3 shrink-0" />El adjunto expiró ({name})
    </span>
  );
  if (err) return <span className="text-[11px] opacity-60 mt-1">No se pudo cargar el adjunto</span>;
  if (!url) return (
    <span className="text-[11px] opacity-60 mt-1 inline-flex items-center gap-1">
      <Loader2 className="h-3 w-3 animate-spin" />{name}
    </span>
  );
  const isImage = mime.startsWith("image/");
  const isPdf = mime === "application/pdf";
  return (
    <>
      {isImage ? (
        <img src={url} alt={name} title={name} onClick={() => setPreview(true)}
             className="mt-1 max-w-[220px] max-h-[220px] rounded-lg border cursor-pointer" />
      ) : (
        <button type="button" onClick={() => (isPdf ? setPreview(true) : undefined)}
                title={isPdf ? "Ver documento" : name}
                className={cn("mt-1 inline-flex items-center gap-1.5 px-3 py-2 bg-black/5 rounded-lg text-xs hover:bg-black/10 break-all text-left",
                              !isPdf && "cursor-default")}>
          <Paperclip className="h-3.5 w-3.5 shrink-0" />{name}
          {!isPdf && (
            <a href={url} download={name} onClick={e => e.stopPropagation()} title="Descargar"
               className="ml-1 opacity-60 hover:opacity-100">
              <Download className="h-3.5 w-3.5" />
            </a>
          )}
        </button>
      )}

      {preview && (
        <Dialog open onOpenChange={v => !v && setPreview(false)}>
          <DialogContent className="max-w-4xl w-[calc(100vw-2rem)] h-[85vh] flex flex-col gap-0 p-0 overflow-hidden">
            <DialogHeader className="flex-row items-center gap-2 space-y-0 border-b px-4 py-2.5">
              <DialogTitle className="text-sm font-medium truncate min-w-0 flex-1 text-left">{name}</DialogTitle>
              <a href={url} download={name}
                 className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs hover:bg-muted shrink-0 mr-6">
                <Download className="h-3.5 w-3.5" /> Descargar
              </a>
            </DialogHeader>
            {isImage ? (
              <div className="flex-1 min-h-0 flex items-center justify-center bg-muted/40 p-4 overflow-auto">
                <img src={url} alt={name} className="max-w-full max-h-full object-contain rounded" />
              </div>
            ) : (
              <iframe src={url} title={name} className="flex-1 min-h-0 w-full border-0" />
            )}
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

// Ticks de entrega para mensajes del operador en WhatsApp: ✓ enviado, ✓✓ entregado,
// ✓✓ azul leído, ! no entregado. delivery_status null (widget, o WA viejo) → sin tick.
function WaTicks({ status }: { status: string }) {
  if (status === "failed") return <span title="No se pudo entregar" className="text-destructive font-semibold">!</span>;
  const read = status === "read";
  const double = read || status === "delivered";
  return (
    <span title={read ? "Leído" : double ? "Entregado" : "Enviado"}
          className={cn("font-semibold leading-none", read && "text-sky-500")}>
      {double ? "✓✓" : "✓"}
    </span>
  );
}

/**
 * Burbuja de mensaje — lenguaje visual de la referencia (Text):
 *   Afiliado  → IZQUIERDA: avatar redondo gris + label con el nombre, burbuja
 *               gris sin borde ni sombra, hora chica adentro.
 *   Bot (IA)  → DERECHA: label "Asistente" + avatar violeta (violeta = IA en
 *               todo el sistema), burbuja con tinte violeta suave.
 *   Operador  → DERECHA: label + avatar verde, burbuja con tinte verde suave.
 * Es la perspectiva del inbox: "ellos" a la izquierda, "nosotros" a la derecha.
 */
export function MessageBubble({ msg, conversationId, senderName }:
  { msg: { id: string; sender_type: string; content: string; created_at: string;
           attachment_name?: string | null; attachment_mime?: string | null; pending?: boolean;
           delivery_status?: string | null }; conversationId: string;
    /** Nombre del afiliado — label y para la inicial del avatar. */
    senderName?: string | null }) {
  const isUser     = msg.sender_type === "user";
  const isSystem   = msg.sender_type === "system";
  const isOperator = msg.sender_type === "operator";
  const time = new Date(msg.created_at).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });

  if (isSystem) return (
    <div className="flex justify-center">
      <span className="text-[11px] bg-muted text-muted-foreground rounded-full px-3 py-1 flex items-center gap-1.5">
        <Info className="h-3 w-3 shrink-0" />
        {renderWithLinks(msg.content)}
      </span>
    </div>
  );

  const label = isUser
    ? (senderName || "Afiliado")
    : isOperator ? "Operador" : "Asistente";

  const avatar = (
    <span className={cn(
      "flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
      isUser     && "bg-muted text-muted-foreground",
      isOperator && "bg-success/15 text-success",
      !isUser && !isOperator && "bg-violet-100 text-violet-600 dark:bg-violet-500/20 dark:text-violet-300",
    )}>
      {isUser
        ? (senderName?.trim()[0]
            ? <span className="text-[11px] font-semibold uppercase">{senderName.trim()[0]}</span>
            : <UserCheck className="h-3.5 w-3.5" />)
        : isOperator
          ? <UserCheck className="h-3.5 w-3.5" />
          : <Bot className="h-3.5 w-3.5" />}
    </span>
  );

  return (
    <div className={cn("flex items-start gap-2.5", !isUser && "flex-row-reverse")}>
      {avatar}
      <div className={cn("flex max-w-[80%] flex-col", !isUser && "items-end")}>
        <span className="mb-1 px-0.5 text-[11px] font-semibold text-foreground/80">{label}</span>
        <div className={cn(
          "rounded-2xl px-4 py-2.5 text-sm leading-relaxed break-words text-foreground transition-opacity",
          isUser     && "rounded-tl-md bg-muted",
          isOperator && "rounded-tr-md bg-success/10",
          !isUser && !isOperator && "rounded-tr-md bg-gradient-to-br from-violet-100/70 to-indigo-100/50 dark:from-violet-500/15 dark:to-indigo-500/10",
          msg.pending && "opacity-65",
        )}>
          {msg.content && <p className="whitespace-pre-wrap break-words">{renderWithLinks(msg.content)}</p>}
          {msg.attachment_name && (
            <AttachmentView conversationId={conversationId} messageId={msg.id}
                            name={msg.attachment_name} mime={msg.attachment_mime || ""} />
          )}
          <p className={cn("mt-1 flex items-center gap-1 text-[11px] opacity-60", !isUser && "justify-end")}>
            {msg.pending ? <><Loader2 className="h-2.5 w-2.5 animate-spin" /> enviando…</> : time}
            {!msg.pending && isOperator && msg.delivery_status && <WaTicks status={msg.delivery_status} />}
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────────

// Formatea el wa_id de WhatsApp legible. AR móvil (549…): "+54 9 3400 154493".
function formatWaNumber(id: string | null | undefined): string {
  const d = (id ?? "").replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("549") && d.length >= 9) return `+54 9 ${d.slice(3, 7)} ${d.slice(7)}`;
  if (d.startsWith("54") && d.length >= 8) return `+54 ${d.slice(2, 6)} ${d.slice(6)}`;
  return "+" + d;
}

function segmentAndSort(convs: ConversationRow[], now: number): Record<SectionKey, ConversationRow[]> {
  const out: Record<SectionKey, ConversationRow[]> = {
    handoff_requested: [], human_attending: [],
  };
  for (const c of convs) {
    if (c.status in out) out[c.status as SectionKey].push(c);
  }
  // Más urgente (más tiempo esperando) arriba: msSince mide "cuánto hace que está esperando",
  // entonces queremos descendente — b - a, no a - b.
  out.handoff_requested.sort((a, b) =>
    msSince(b.handoff_requested_at ?? b.last_message_at ?? b.created_at, now) -
    msSince(a.handoff_requested_at ?? a.last_message_at ?? a.created_at, now)
  );
  out.human_attending.sort((a, b) => {
    const aW = a.last_message_sender === "user" ? 1 : 0;
    const bW = b.last_message_sender === "user" ? 1 : 0;
    if (aW !== bW) return bW - aW;
    return msSince(a.last_message_at ?? a.created_at, now) - msSince(b.last_message_at ?? b.created_at, now);
  });
  return out;
}

function msSince(iso: string | null | undefined, now: number): number {
  if (!iso) return Infinity;
  // Clamp a 0: handoff_requested_at se setea con NOW() del servidor (UTC). Si el
  // reloj del navegador está unos segundos atrás —o el `now` cacheado quedó viejo
  // entre ticks— la resta da negativo en los primeros segundos. Nunca mostramos
  // tiempos negativos: el mínimo es 0 ("ahora" / "0s").
  return Math.max(0, now - new Date(iso).getTime());
}

function formatRelative(ms: number): string {
  if (!isFinite(ms)) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60)  return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60)  return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}
