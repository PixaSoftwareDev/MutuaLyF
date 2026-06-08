"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  MessageSquare, Loader2, Send, UserCheck, UserMinus, XCircle, User, Bot,
  Info, ChevronDown, ChevronLeft, Search, Flame, ArrowRightLeft, Eye, Wifi, WifiOff,
  RotateCcw, MoreVertical, Paperclip, X,
} from "lucide-react";
import { api, type ConversationRow } from "@/lib/api";
import { renderWithLinks } from "@/lib/render-with-links";
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
const COLLAPSED_KEY = "ia_ops_collapsed_v2";

// La bandeja muestra solo lo accionable. Cerradas viven en /historial
// para no mezclar y evitar que el operador piense que tiene que hacer algo.
type SectionKey = "handoff_requested" | "human_attending";

const SECTION_DEFS: Array<{ key: SectionKey; label: string; tone: string; badge: string; defaultOpen: boolean }> = [
  { key: "handoff_requested", label: "En espera",   tone: "text-warning", badge: "bg-warning/15 text-warning", defaultOpen: true },
  { key: "human_attending",   label: "En atención", tone: "text-success", badge: "bg-success/15 text-success", defaultOpen: true },
];

export type ConversationsPanelMode = "operator" | "admin-readonly";

// ── Main component ────────────────────────────────────────────────────────────

export function ConversationsPanel({ mode }: { mode: ConversationsPanelMode }) {
  const qc = useQueryClient();
  const [selectedId, setSelectedId]     = useState<string | null>(null);
  const [replyText, setReplyText]       = useState("");
  const [search, setSearch]             = useState("");
  const [sectorFilter, setSectorFilter] = useState<string>("all");
  const [showTransfer, setShowTransfer] = useState(false);
  const [transferSector, setTransferSector] = useState("");
  const [confirmRelease, setConfirmRelease] = useState(false);
  const [sseConnected, setSseConnected] = useState(false);
  const [now, setNow] = useState<number>(() => Date.now());
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef    = useRef<HTMLTextAreaElement>(null);
  const fileInputRef   = useRef<HTMLInputElement>(null);
  const handoffIds     = useRef<Set<string>>(new Set());
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

  // Collapsed sections
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    if (typeof window === "undefined") return {};
    try { return JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "{}"); } catch { return {}; }
  });
  useEffect(() => {
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsed)); } catch { /* ignore */ }
  }, [collapsed]);

  const isCollapsed  = (k: SectionKey) => {
    if (k in collapsed) return collapsed[k];
    const def = SECTION_DEFS.find(s => s.key === k);
    return def ? !def.defaultOpen : false;
  };
  const toggleSection = (k: SectionKey) => setCollapsed(p => ({ ...p, [k]: !isCollapsed(k) }));

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
      try {
        const ctx  = new AudioContext();
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        osc.frequency.setValueAtTime(660, ctx.currentTime + 0.12);
        gain.gain.setValueAtTime(0.25, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);
        osc.start(); osc.stop(ctx.currentTime + 0.45);
      } catch { /* blocked until user interaction */ }
    });

    const activeIds = new Set(waiting.map(c => c.id));
    handoffIds.current.forEach(id => { if (!activeIds.has(id)) handoffIds.current.delete(id); });
  }, [data, mode]);

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
      const d = err?.response?.data?.detail || "No se pudo devolver al bot.";
      toast({ title: "Error", description: typeof d === "string" ? d : "Intentá de nuevo.", variant: "destructive" });
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
      const d = err?.response?.data?.detail;
      toast({ title: "No se pudo enviar el archivo", description: typeof d === "string" ? d : "Intentá de nuevo.", variant: "destructive" });
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
      const detail = err?.response?.data?.detail || "Error al enviar el mensaje.";
      toast({
        title: "No se pudo enviar",
        description: typeof detail === "string" ? detail : "Intentá de nuevo.",
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

  const sectorOptions = useMemo(
    () => Array.from(new Set(allConvs.map(c => c.sector_nombre).filter(Boolean) as string[])).sort(),
    [allConvs],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allConvs.filter(c => {
      if (sectorFilter !== "all" && c.sector_nombre !== sectorFilter) return false;
      if (!q) return true;
      return (c.afiliado_nombre || "").toLowerCase().includes(q) ||
             (c.sector_nombre   || "").toLowerCase().includes(q);
    });
  }, [allConvs, search, sectorFilter]);

  const sections = useMemo(() => segmentAndSort(filtered, now), [filtered, now]);
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
    <div className="flex h-full overflow-hidden">

      {/* ── LEFT: queue ──────────────────────────────────────────────────── */}
      <div className={cn(
        "border-r flex flex-col shrink-0 bg-card",
        "w-full sm:w-72",
        selectedId ? "hidden sm:flex" : "flex"
      )}>

        {/* Title bar — solo en modo operador (admin lo identifica por el sidebar) */}
        {!readOnly && (
          <div className="h-16 px-4 flex items-center justify-between border-b shrink-0">
            <h1 className="font-semibold text-sm flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-primary" />
              Panel Operador
            </h1>
            <div className="flex items-center gap-1.5" title={sseConnected ? "Tiempo real activo" : "Reconectando..."}>
              {sseConnected
                ? <Wifi    className="h-3.5 w-3.5 text-emerald-500" />
                : <WifiOff className="h-3.5 w-3.5 text-muted-foreground animate-pulse" />}
              <span className="text-[10px] text-muted-foreground">{sseConnected ? "En vivo" : "..."}</span>
            </div>
          </div>
        )}

        {/* Filters + stats */}
        <div className="px-4 pt-3 pb-3 space-y-3">
          {/* Stats pills */}
          {!readOnly && (
            <div className="flex gap-2">
              <span className={cn(
                "flex-1 text-center text-xs font-semibold rounded-md py-1.5",
                waitingCount > 0 ? "bg-warning/10 text-warning" : "bg-muted text-muted-foreground"
              )}>
                {waitingCount} en espera
              </span>
              <span className={cn(
                "flex-1 text-center text-xs font-semibold rounded-md py-1.5",
                attendingCount > 0 ? "bg-success/10 text-success" : "bg-muted text-muted-foreground"
              )}>
                {attendingCount} en atención
              </span>
            </div>
          )}

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <input
              type="text"
              placeholder="Buscar…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full h-8 pl-8 pr-3 rounded-md border border-input bg-background text-xs focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          {/* Sector filter — dropdown */}
          {sectorOptions.length > 1 && (
            <div className="relative">
              <select
                value={sectorFilter}
                onChange={e => setSectorFilter(e.target.value)}
                className={cn(
                  "w-full h-8 pl-3 pr-8 rounded-md border bg-background text-xs cursor-pointer appearance-none focus:outline-none focus:ring-1 focus:ring-primary transition-colors",
                  sectorFilter === "all"
                    ? "border-input text-muted-foreground"
                    : "border-primary/60 text-foreground font-medium"
                )}
              >
                <option value="all">Todos los sectores</option>
                {sectorOptions.map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            </div>
          )}
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {isLoading ? (
            Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-16 rounded-lg" />)
          ) : error ? (
            <p className="text-xs text-destructive text-center py-8">Error al cargar</p>
          ) : allConvs.length === 0 && !search && sectorFilter === "all" && !readOnly ? (
            <div className="text-center py-12 px-4 text-muted-foreground space-y-2">
              <MessageSquare className="h-8 w-8 mx-auto opacity-20" />
              <p className="text-sm font-medium text-foreground/70">Sin sectores asignados</p>
              <p className="text-xs leading-relaxed">
                No tenés sectores asignados. Pedile al administrador que te asigne los sectores que vas a atender.
              </p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <MessageSquare className="h-8 w-8 mx-auto mb-2 opacity-20" />
              <p className="text-xs">{search ? "Sin resultados" : "Sin conversaciones activas"}</p>
            </div>
          ) : (
            <>
              {SECTION_DEFS.map(def => {
                const items = sections[def.key];
                if (items.length === 0) return null;
                const open = !isCollapsed(def.key);
                return (
                  <div key={def.key}>
                    <button
                      onClick={() => toggleSection(def.key)}
                      className="w-full flex items-center gap-1.5 px-2 py-1.5 hover:bg-muted/40 rounded-md transition-colors"
                    >
                      <ChevronDown className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", !open && "-rotate-90")} />
                      <span className={cn("text-[11px] font-bold uppercase tracking-wide", def.tone)}>{def.label}</span>
                      <span className={cn("ml-auto text-[11px] font-semibold rounded-full px-1.5 min-w-[20px] text-center", def.badge)}>
                        {items.length}
                      </span>
                    </button>
                    {open && (
                      <div className="space-y-1 mb-2">
                        {items.map(conv => (
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
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}

            </>
          )}
        </div>
      </div>

      {/* ── RIGHT: detail ────────────────────────────────────────────────── */}
      <div className={cn(
        "flex-1 flex flex-col min-w-0 bg-background",
        !selectedId && "hidden sm:flex"
      )}>
        {!selectedId ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <div className="text-center space-y-2">
              <MessageSquare className="h-10 w-10 mx-auto opacity-15" />
              <p className="text-sm">Seleccioná una conversación</p>
            </div>
          </div>
        ) : detailLoading ? (
          // Skeleton de chat (no un panel vacío): al saltar entre conversaciones
          // el operador ve la estructura cargando, no un parpadeo en blanco.
          <div className="flex-1 flex flex-col">
            <div className="px-4 py-3 border-b bg-card">
              <Skeleton className="h-4 w-40" />
            </div>
            <div className="flex-1 p-4 space-y-3 bg-muted/30">
              <Skeleton className="h-12 w-2/3 rounded-2xl" />
              <Skeleton className="h-12 w-1/2 rounded-2xl ml-auto" />
              <Skeleton className="h-10 w-3/5 rounded-2xl" />
            </div>
          </div>
        ) : detail ? (
          <>
            {/* ── Header ── */}
            <div className="px-4 py-3 border-b flex items-center justify-between gap-3 bg-card">
              <div className="flex items-center gap-2 min-w-0">
                <button
                  onClick={() => setSelectedId(null)}
                  className="sm:hidden flex items-center justify-center w-7 h-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
                  aria-label="Volver"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <div className="min-w-0">
                  <p className="font-semibold text-sm truncate">{detail.afiliado_nombre || (detail.afiliado_ip ? `IP ${detail.afiliado_ip}` : "Afiliado anónimo")}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {[
                      detail.sector_nombre,
                      detail.afiliado_dni   && `DNI ${detail.afiliado_dni}`,
                      detail.afiliado_email,
                      // IP solo si ya mostramos un nombre arriba (si no, el nombre YA es la IP)
                      (detail.afiliado_ip && detail.afiliado_nombre) ? `IP ${detail.afiliado_ip}` : null,
                    ].filter(Boolean).join(" · ") || "Sin datos de contacto"}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <StatusBadge status={detail.status} />
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
                            <span className="text-[10px] text-muted-foreground">
                              Lo atiende otro equipo
                            </span>
                          </div>
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => setConfirmRelease(true)}>
                          <UserMinus className="h-4 w-4 mr-2" />
                          <div className="flex flex-col">
                            <span>Liberar a la cola</span>
                            <span className="text-[10px] text-muted-foreground">
                              Otro operador del mismo sector la toma
                            </span>
                          </div>
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => returnToBotM.mutate(detail.id)}>
                          <RotateCcw className="h-4 w-4 mr-2" />
                          <div className="flex flex-col">
                            <span>Pasar al asistente automático</span>
                            <span className="text-[10px] text-muted-foreground">
                              El bot retoma la conversación
                            </span>
                          </div>
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </>
                )}
                {readOnly && <Eye className="h-4 w-4 text-muted-foreground" />}
              </div>
            </div>

            {/* Transfer panel */}
            {showTransfer && (
              <div className="px-4 py-3 border-b bg-muted/40 flex items-center gap-2">
                <select
                  value={transferSector}
                  onChange={e => setTransferSector(e.target.value)}
                  className="flex-1 h-8 rounded-md border border-input bg-background px-2 text-sm"
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
            <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-muted/30">
              {/* Bot phase — shown inline, no collapsible box */}
              {botMessages.map(m => <MessageBubble key={m.id} msg={m} conversationId={detail.id} />)}

              {/* Separator marking the handoff */}
              {operatorMessages.length > 0 && botMessages.length > 0 && (
                <div className="flex items-center gap-2 py-1">
                  <div className="flex-1 border-t border-dashed border-border" />
                  <span className="text-[10px] text-muted-foreground shrink-0 flex items-center gap-1">
                    <UserCheck className="h-3 w-3" /> Operador tomó la conversación
                  </span>
                  <div className="flex-1 border-t border-dashed border-border" />
                </div>
              )}

              {/* Operator phase */}
              {operatorMessages.map(m => <MessageBubble key={m.id} msg={m} conversationId={detail.id} />)}

              <div ref={messagesEndRef} />
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
                  isStale ? "bg-red-50 text-red-800 border-red-200" : "bg-amber-50 text-amber-800 border-amber-200",
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
                    className="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary min-h-[60px] max-h-40"
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
                level === "critical" ? "bg-red-50 border-t border-red-200"     :
                level === "urgent"   ? "bg-amber-100/60 border-t border-amber-200" :
                "bg-amber-50/60 border-t border-amber-100";

              const messageClass =
                level === "critical" ? "text-red-700"   :
                level === "urgent"   ? "text-amber-800" :
                "text-amber-700";

              // Botón estable (la urgencia la lleva el fondo del banner, no el botón).
              const buttonClass = "bg-primary hover:bg-primary/90 text-primary-foreground";

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
  const map: Record<string, { label: string; cls: string }> = {
    bot_active:        { label: "Bot activo",   cls: "bg-muted text-muted-foreground" },
    handoff_requested: { label: "En espera",    cls: "bg-warning/10 text-warning" },
    human_attending:   { label: "En atención",  cls: "bg-success/10 text-success" },
    closed:            { label: "Cerrada",       cls: "bg-muted text-muted-foreground" },
  };
  const s = map[status] ?? { label: status, cls: "bg-muted text-muted-foreground" };
  return <span className={cn("text-xs font-medium px-2 py-0.5 rounded-full", s.cls)}>{s.label}</span>;
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

  const cardBg =
    urgencyLevel === "critical" ? "bg-red-100/70 hover:bg-red-100"        :
    urgencyLevel === "urgent"   ? "bg-amber-100/70 hover:bg-amber-100"    :
    yourTurn                    ? "bg-orange-50/70 hover:bg-orange-50"    :
    attending                   ? "bg-emerald-50/60 hover:bg-emerald-50"  :
    "hover:bg-muted/40";

  const dotColor =
    urgencyLevel === "critical" ? "bg-red-500"     :
    urgencyLevel === "urgent"   ? "bg-amber-500"   :
    urgencyLevel === "warn"     ? "bg-amber-400"   :
    yourTurn                    ? "bg-orange-500"  :
    attending                   ? "bg-emerald-500" :
    "bg-transparent";

  const dotPulse = urgencyLevel === "critical" || yourTurn;

  const timeClass =
    urgencyLevel === "critical" ? "font-semibold text-red-700"     :
    urgencyLevel === "urgent"   ? "font-semibold text-amber-800"   :
    urgencyLevel === "warn"     ? "font-medium text-amber-700"     :
    yourTurn                    ? "font-semibold text-orange-700"  :
    attending                   ? "font-medium text-emerald-700"   :
    "text-muted-foreground";

  // El botón "Atender" mantiene un color de acción ESTABLE (no cambia por
  // urgencia): un botón que se vuelve rojo se lee como destructivo. La presión
  // de tiempo ya la comunican el punto y el fondo de la tarjeta.
  const acceptClass = "bg-primary hover:bg-primary/90";

  // Unread count only while operator is actively attending — for "en espera"
  // every message is unread by definition, so the badge adds no information.
  const showUnread = conv.unread_count > 0 && conv.status === "human_attending";

  return (
    <div
      className={cn(
        "rounded-lg transition-colors group",
        selected ? "bg-accent ring-1 ring-primary/20" : cardBg,
      )}
    >
      <div className="flex items-center gap-2.5 px-3 py-2">
        <span
          className={cn(
            "w-2 h-2 rounded-full shrink-0 mt-0.5 self-start",
            dotColor,
            dotPulse && "animate-pulse",
          )}
          aria-hidden
        />

        <button onClick={onSelect} className="flex-1 min-w-0 text-left">
          <p className="text-sm font-medium truncate leading-tight flex items-center gap-1.5">
            {conv.is_test && <span className="shrink-0 text-[9px] font-bold bg-violet-100 text-violet-700 rounded px-1 py-0.5 uppercase tracking-wide">TEST</span>}
            {conv.afiliado_nombre || (conv.afiliado_ip ? `IP ${conv.afiliado_ip}` : "Anónimo")}
          </p>
          <p className="text-[11px] text-muted-foreground truncate mt-0.5">
            {conv.sector_nombre || "Sin sector"}
          </p>
          {/* Operator name only matters cross-operator (admin view). Hidden
              in the operator's own inbox where every card is theirs. */}
          {readOnly && conv.operator_name && (
            <p className="text-[10px] mt-0.5 flex items-center gap-1">
              <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", operatorOnline ? "bg-emerald-500" : "bg-slate-300")} />
              <span className={cn("truncate", operatorOnline ? "text-emerald-600 font-medium" : "text-muted-foreground")}>
                {conv.operator_name}
              </span>
            </p>
          )}
        </button>

        <div className="shrink-0 flex flex-col items-end gap-1">
          <span className={cn("text-[11px] tabular-nums", timeClass)}>
            {ageStr}
          </span>

          {showUnread && (
            <span className="bg-foreground/85 text-background rounded-full text-[10px] min-w-4 h-4 px-1 flex items-center justify-center font-semibold">
              {conv.unread_count > 9 ? "9+" : conv.unread_count}
            </span>
          )}

          {yourTurn && (
            <span className="text-[10px] font-semibold text-orange-600">tu turno</span>
          )}

          {!readOnly && isHandoff && (
            <button
              onClick={e => { e.stopPropagation(); onAccept(); }}
              disabled={accepting}
              className={cn(
                "inline-flex items-center gap-1 rounded-md text-primary-foreground text-[11px] font-medium px-2 h-6 transition-colors disabled:opacity-60",
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
  const [err, setErr] = useState(false);
  useEffect(() => {
    let active = true;
    let created: string | null = null;
    api.operator.attachmentBlobUrl(conversationId, messageId)
      .then(u => { if (active) { created = u; setUrl(u); } else { URL.revokeObjectURL(u); } })
      .catch(() => { if (active) setErr(true); });
    return () => { active = false; if (created) URL.revokeObjectURL(created); };
  }, [conversationId, messageId]);
  if (err) return <span className="text-[11px] opacity-60 mt-1">No se pudo cargar el adjunto</span>;
  if (!url) return (
    <span className="text-[11px] opacity-60 mt-1 inline-flex items-center gap-1">
      <Loader2 className="h-3 w-3 animate-spin" />{name}
    </span>
  );
  if (mime.startsWith("image/")) return (
    <img src={url} alt={name} title={name} onClick={() => window.open(url, "_blank")}
         className="mt-1 max-w-[220px] max-h-[220px] rounded-lg border cursor-pointer" />
  );
  return (
    <a href={url} download={name}
       className="mt-1 inline-flex items-center gap-1.5 px-3 py-2 bg-black/5 rounded-lg text-xs hover:bg-black/10 break-all">
      <Paperclip className="h-3.5 w-3.5 shrink-0" />{name}
    </a>
  );
}

export function MessageBubble({ msg, conversationId }:
  { msg: { id: string; sender_type: string; content: string; created_at: string;
           attachment_name?: string | null; attachment_mime?: string | null; pending?: boolean }; conversationId: string }) {
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

  return (
    <div className={cn("flex gap-3 items-end", isUser ? "flex-row-reverse" : "flex-row")}>
      {!isUser && (
        <div className={cn(
          "w-8 h-8 rounded-xl flex items-center justify-center shrink-0 shadow-sm",
          isOperator
            ? "bg-gradient-to-br from-emerald-400 to-teal-600"
            : "bg-gradient-to-br from-brand-light to-brand",
        )}>
          {isOperator
            ? <UserCheck className="h-4 w-4 text-white" />
            : <Bot       className="h-4 w-4 text-brand-foreground" />}
        </div>
      )}
      <div className="max-w-[85%] min-w-[120px] flex flex-col">
        <div className={cn(
          "rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed break-words transition-opacity",
          isUser     && "bg-brand text-brand-foreground rounded-br-sm shadow-sm",
          isOperator && "bg-white border border-emerald-200 text-slate-800 rounded-bl-sm shadow-sm",
          !isUser && !isOperator && "bg-white border border-slate-200 text-slate-800 rounded-bl-sm shadow-sm",
          msg.pending && "opacity-65",
        )}>
          {msg.content && <p className="whitespace-pre-wrap break-words">{renderWithLinks(msg.content)}</p>}
          {msg.attachment_name && (
            <AttachmentView conversationId={conversationId} messageId={msg.id}
                            name={msg.attachment_name} mime={msg.attachment_mime || ""} />
          )}
          <p className={cn("text-[11px] mt-1 opacity-60 flex items-center gap-1", isUser ? "justify-end" : "justify-start")}>
            {msg.pending ? <><Loader2 className="h-2.5 w-2.5 animate-spin" /> enviando…</> : time}
          </p>
        </div>
        {isOperator && (
          <p className="text-[10px] text-emerald-600 mt-1 ml-1 font-medium">Operador</p>
        )}
      </div>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────────

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
  return `${h}h ${m % 60}m`;
}
