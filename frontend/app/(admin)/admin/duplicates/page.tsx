"use client";

import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, Loader2, Pencil, CopyCheck, FileText, Check } from "lucide-react";
import { api, type ChunkDuplicatePair } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

// ── LCS-based word diff ────────────────────────────────────────────────────────

type DiffToken = { word: string; type: "common" | "only_a" | "only_b" };

function lcs(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  return dp;
}

function diffWords(textA: string, textB: string): [DiffToken[], DiffToken[]] {
  const wordsA = textA.split(/\s+/).filter(Boolean);
  const wordsB = textB.split(/\s+/).filter(Boolean);
  const dp = lcs(wordsA, wordsB);

  const tokensA: DiffToken[] = [];
  const tokensB: DiffToken[] = [];

  let i = wordsA.length;
  let j = wordsB.length;
  const commonPairs: Array<[number, number]> = [];

  while (i > 0 && j > 0) {
    if (wordsA[i - 1] === wordsB[j - 1]) {
      commonPairs.unshift([i - 1, j - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  const commonA = new Set(commonPairs.map(([ai]) => ai));
  const commonB = new Set(commonPairs.map(([, bi]) => bi));

  wordsA.forEach((word, idx) => {
    tokensA.push({ word, type: commonA.has(idx) ? "common" : "only_a" });
  });
  wordsB.forEach((word, idx) => {
    tokensB.push({ word, type: commonB.has(idx) ? "common" : "only_b" });
  });

  return [tokensA, tokensB];
}

// ── Diff rendering ─────────────────────────────────────────────────────────────

/** Renderiza un lado del diff. Las palabras que NO están en el otro texto se
 *  resaltan igual en ambos lados (en el color de la tarjeta) — el usuario lee
 *  de un vistazo "en esto se diferencian", sin insinuar que un lado sea el
 *  correcto. `highlight` viene del nivel de parecido para unificar la paleta. */
function DiffText({ tokens, highlight }: { tokens: DiffToken[]; highlight: string }) {
  return (
    <p className="text-[13.5px] leading-relaxed text-foreground/85">
      {tokens.map((tok, idx) => (
        <span
          key={idx}
          className={tok.type === "common" ? "" : cn("rounded-[3px] px-1 py-px font-medium", highlight)}
        >
          {tok.word}{" "}
        </span>
      ))}
    </p>
  );
}

// ── Match summary ──────────────────────────────────────────────────────────────

type MatchKind = "identical" | "semantic" | "similar";

function classifyMatch(pair: ChunkDuplicatePair): { kind: MatchKind; label: string } {
  const cosine = pair.cosine_score ?? 0;
  const jaccard = pair.jaccard_score ?? 0;
  if (jaccard >= 0.7)  return { kind: "identical", label: "Casi idéntico" };
  if (cosine  >= 0.92) return { kind: "semantic",  label: "Dicen lo mismo" };
  return                      { kind: "similar",   label: "Parecidos"      };
}

// El nivel de parecido se muestra sobrio: un punto de color + la etiqueta. El
// resaltado de las diferencias es universal (ámbar tipo marcador) — su rol es
// "mirá acá difieren", no repetir la severidad. Menos color = más legible.
const MATCH_DOT: Record<MatchKind, string> = {
  identical: "bg-attention",
  semantic:  "bg-warning",
  similar:   "bg-info",
};
const DIFF_HL = "bg-warning/20 text-foreground";

// ── Pair card ──────────────────────────────────────────────────────────────────

/** Una de las dos columnas: documento de origen + texto (con diffs, recortable
 *  si es largo) + la acción "Quedarme con este". Todo inline:
 *  - Editar: reemplaza el texto por un campo editable en el lugar (sin modal).
 *  - Quedarme: acción destructiva (elimina el otro), con confirmación inline. */
function SideColumn({ pairId, which, docTitle, text, tokens, onSaved, tone = "idle" }: {
  pairId: string;
  which: "a" | "b";
  docTitle: string | null;
  text: string;
  tokens: DiffToken[];
  onSaved: (t: string) => void;
  // Efecto de selección: "keep" = el lado que se conserva (resaltado),
  // "discard" = el que se elimina (atenuado), "idle" = normal.
  tone?: "keep" | "discard" | "idle";
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);

  // Sincronizo el borrador si el texto cambia desde afuera (refetch/otra edición)
  useEffect(() => { if (!editing) setDraft(text); }, [text, editing]);

  const saveM = useMutation({
    mutationFn: () => api.duplicates.editChunk(pairId, which, draft.trim()),
    onSuccess: ({ text: saved }) => {
      onSaved(saved);
      setEditing(false);
      toast({ title: "Texto actualizado", description: "El bot re-indexa el fragmento para buscar con la versión nueva.", variant: "success" });
    },
    onError: (err: any) => {
      const detail = err?.response?.data?.detail || "No se pudo guardar el cambio.";
      toast({ title: "Error al guardar", description: typeof detail === "string" ? detail : "Intentá de nuevo.", variant: "destructive" });
    },
  });

  const dirty = draft.trim() !== text.trim();
  const tooShort = draft.trim().length < 1;

  return (
    <div className={cn(
      "group/col flex min-h-0 min-w-0 flex-col p-4 transition-[background-color,opacity] duration-150 sm:p-5",
      tone === "keep" && "bg-success/[0.06]",
      tone === "discard" && "opacity-40",
    )}>
      {/* Documento de origen + editar (aparece al pasar el mouse) */}
      <div className="mb-2.5 flex shrink-0 items-center justify-between gap-2">
        <span className="inline-flex min-w-0 items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <FileText className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{docTitle ?? "Documento sin título"}</span>
        </span>
        {!editing && (
          <button
            onClick={() => setEditing(true)}
            className="inline-flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-[11px] font-medium text-muted-foreground opacity-0 transition-all hover:text-action focus-visible:opacity-100 focus-visible:outline-none group-hover/col:opacity-100"
            title="Editar este texto"
          >
            <Pencil className="h-3 w-3" /> Editar
          </button>
        )}
      </div>

      {/* Texto completo con diffs (scrollea adentro), o edición inline */}
      {editing ? (
        <>
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={8000}
            autoFocus
            className="min-h-0 flex-1 resize-none text-[13.5px] leading-relaxed"
            disabled={saveM.isPending}
          />
          <div className="mt-2 flex shrink-0 items-center justify-between gap-2">
            <span className="text-[11px] tabular-nums text-muted-foreground">{draft.length} / 8000</span>
            <div className="flex items-center gap-1.5">
              <Button variant="ghost" size="sm" className="h-8 px-2.5 text-xs" onClick={() => { setEditing(false); setDraft(text); }} disabled={saveM.isPending}>Cancelar</Button>
              <Button size="sm" className="h-8 px-3 text-xs" onClick={() => saveM.mutate()} disabled={!dirty || tooShort || saveM.isPending}>
                {saveM.isPending
                  ? <><Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> Guardando…</>
                  : <><Check className="mr-1 h-3.5 w-3.5" /> Guardar</>}
              </Button>
            </div>
          </div>
        </>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-slim">
          <DiffText tokens={tokens} highlight={DIFF_HL} />
        </div>
      )}
    </div>
  );
}

// ── Fila de la lista (master) ───────────────────────────────────────────────────

function PairListRow({ pair, selected, onSelect }: {
  pair: ChunkDuplicatePair;
  selected: boolean;
  onSelect: () => void;
}) {
  const { kind, label } = classifyMatch(pair);
  const pct = pair.cosine_score !== null ? Math.round(pair.cosine_score * 100) : null;
  const sameDoc = pair.doc_id_a === pair.doc_id_b;
  return (
    <button
      onClick={onSelect}
      aria-selected={selected}
      className={cn(
        "flex w-full items-start gap-2.5 border-b px-4 py-3 text-left transition-colors sm:px-5",
        selected ? "bg-muted/60" : "hover:bg-muted/40",
      )}
    >
      <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", MATCH_DOT[kind])} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2">
          <span className="text-[13px] font-semibold text-foreground">{label}</span>
          {pct !== null && <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{pct}%</span>}
        </span>
        <span className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
          <FileText className="h-3 w-3 shrink-0" />
          <span className="truncate">
            {sameDoc ? "Mismo documento" : `${pair.doc_title_a ?? "Sin título"} · ${pair.doc_title_b ?? "Sin título"}`}
          </span>
        </span>
      </span>
    </button>
  );
}

// ── Comparación (detalle, ocupa el área principal) ──────────────────────────────

function PairComparison({ pair, onResolve, resolving, onClose }: {
  pair: ChunkDuplicatePair;
  onResolve: (action: "keep_a" | "keep_b" | "keep_both") => void;
  resolving: boolean;
  onClose?: () => void;   // solo mobile (Sheet)
}) {
  // Override local de los textos cuando el admin edita, para recalcular el diff
  // sin esperar el refetch.
  const [textA, setTextA] = useState(pair.text_a);
  const [textB, setTextB] = useState(pair.text_b);
  useEffect(() => { setTextA(pair.text_a); }, [pair.text_a]);
  useEffect(() => { setTextB(pair.text_b); }, [pair.text_b]);

  const [confirming, setConfirming] = useState<"a" | "b" | null>(null);
  const [preview, setPreview] = useState<"a" | "b" | null>(null);   // hover del botón
  useEffect(() => { setConfirming(null); setPreview(null); }, [pair.id]);   // resetear al cambiar de par

  // Lado "activo" = el que se va a conservar (confirmando o pre-viendo al hover).
  const active = confirming ?? preview;
  const toneFor = (side: "a" | "b"): "keep" | "discard" | "idle" =>
    !active ? "idle" : active === side ? "keep" : "discard";

  const [tokensA, tokensB] = diffWords(textA, textB);
  const { kind, label } = classifyMatch(pair);
  const cosinePct = pair.cosine_score !== null ? Math.round(pair.cosine_score * 100) : null;

  // Nombre de cada lado para las acciones. Si el par es del mismo documento, los
  // títulos no distinguen → usamos el orden.
  const sameDoc = pair.doc_id_a === pair.doc_id_b;
  const nameA = sameDoc ? "la primera versión" : (pair.doc_title_a ?? "el primero");
  const nameB = sameDoc ? "la segunda versión" : (pair.doc_title_b ?? "el segundo");

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4 sm:px-6">
        {onClose && (
          <button onClick={onClose} aria-label="Volver a la lista" className="-ml-1.5 flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:hidden">
            <ChevronLeft className="h-4 w-4" />
          </button>
        )}
        <span className={cn("h-2 w-2 shrink-0 rounded-full", MATCH_DOT[kind])} />
        <span className="text-[15px] font-semibold tracking-tight text-foreground">{label}</span>
        {cosinePct !== null && <span className="text-xs tabular-nums text-muted-foreground">· {cosinePct}% de coincidencia</span>}
      </div>

      {/* Body scrolleable: intro + los dos textos completos (comparados). Ancho
          fluido: aprovecha todo el panel (al desfijar el sidebar, se ensancha). */}
      <div className="flex min-h-0 flex-1 flex-col">
        <p className="shrink-0 border-b px-4 py-4 text-sm leading-relaxed text-muted-foreground sm:px-5">
          El bot encontró dos textos que dicen casi lo mismo. Elegí con cuál quedarte —el otro se elimina— o conservá ambos si en realidad son distintos.
          Lo <span className="rounded-[3px] bg-warning/20 px-1 font-medium text-foreground">resaltado</span> marca en qué se diferencian.
        </p>
        {/* La grilla llena la altura; el texto scrollea DENTRO de cada columna,
            así el marco y el divisor vertical quedan fijos (sin scroll del panel). */}
        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden md:grid-cols-2 md:divide-x">
          <SideColumn pairId={pair.id} which="a" docTitle={pair.doc_title_a} text={textA} tokens={tokensA} onSaved={setTextA} tone={toneFor("a")} />
          <SideColumn pairId={pair.id} which="b" docTitle={pair.doc_title_b} text={textB} tokens={tokensB} onSaved={setTextB} tone={toneFor("b")} />
        </div>
      </div>

      {/* Barra de decisión fija abajo: dos "quedarme" + conservar ambos, con una
          sola confirmación en la misma barra. */}
      <div className="shrink-0 border-t bg-card">
        {confirming ? (
          <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
            <span className="min-w-0 text-xs text-foreground">
              Te quedás con <span className="font-semibold">{confirming === "a" ? nameA : nameB}</span> y se elimina el otro texto.
            </span>
            <div className="flex shrink-0 items-center gap-1.5">
              <Button variant="ghost" size="sm" onClick={() => setConfirming(null)} disabled={resolving}>Cancelar</Button>
              <Button size="sm" onClick={() => onResolve(confirming === "a" ? "keep_a" : "keep_b")} disabled={resolving}>
                {resolving ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1 h-3.5 w-3.5" />}
                Sí, eliminar el otro
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:px-5">
            <Button
              variant="outline" size="sm"
              className="min-w-0 flex-1 gap-1.5 transition-colors hover:border-success/40 hover:bg-success/[0.06] hover:text-success"
              onMouseEnter={() => setPreview("a")} onMouseLeave={() => setPreview(null)}
              onFocus={() => setPreview("a")} onBlur={() => setPreview(null)}
              onClick={() => setConfirming("a")} disabled={resolving}
            >
              <Check className="h-4 w-4 shrink-0" /> <span className="truncate">Quedarme con {nameA}</span>
            </Button>
            <Button
              variant="outline" size="sm"
              className="min-w-0 flex-1 gap-1.5 transition-colors hover:border-success/40 hover:bg-success/[0.06] hover:text-success"
              onMouseEnter={() => setPreview("b")} onMouseLeave={() => setPreview(null)}
              onFocus={() => setPreview("b")} onBlur={() => setPreview(null)}
              onClick={() => setConfirming("b")} disabled={resolving}
            >
              <Check className="h-4 w-4 shrink-0" /> <span className="truncate">Quedarme con {nameB}</span>
            </Button>
            <Button variant="ghost" size="sm" className="shrink-0 text-muted-foreground hover:text-foreground" onClick={() => onResolve("keep_both")} disabled={resolving}>
              Conservar ambos
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function DuplicatesPage() {
  const queryClient = useQueryClient();
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);

  // Detalle inline en desktop, Sheet en mobile (mismo patrón que Conversaciones).
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 1023px)");
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["duplicates"],
    queryFn: api.duplicates.list,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const resolveMutation = useMutation({
    mutationFn: ({ pairId, action }: { pairId: string; action: "keep_a" | "keep_b" | "keep_both" }) =>
      api.duplicates.resolve(pairId, action),
    onMutate: ({ pairId }) => setResolvingId(pairId),
    onSuccess: (_, { pairId }) => {
      setHiddenIds((prev) => new Set([...prev, pairId]));
      setResolvingId(null);
      setMobileOpen(false);
      queryClient.invalidateQueries({ queryKey: ["duplicates"] });
      queryClient.invalidateQueries({ queryKey: ["duplicates-stats"] });
      toast({ title: "Duplicado resuelto", variant: "success" });
    },
    onError: () => {
      setResolvingId(null);
      toast({ title: "Error al resolver", description: "Intentá de nuevo.", variant: "destructive" });
    },
  });

  const allPairs = data?.pairs ?? [];
  const pendingPairs = useMemo(
    () => allPairs.filter((p) => p.status === "pending" && !hiddenIds.has(p.id)),
    [allPairs, hiddenIds]
  );

  const selected = pendingPairs.find((p) => p.id === selectedId) ?? null;

  // Auto-selección (desktop): el primero disponible; al resolver, salta al
  // siguiente. En mobile no auto-seleccionamos (la lista es la vista principal).
  useEffect(() => {
    if (isMobile) return;
    if (pendingPairs.length === 0) { if (selectedId) setSelectedId(null); return; }
    if (!selectedId || !pendingPairs.some((p) => p.id === selectedId)) {
      setSelectedId(pendingPairs[0].id);
    }
  }, [pendingPairs, selectedId, isMobile]);

  const openPair = (id: string) => { setSelectedId(id); setMobileOpen(true); };

  const comparison = (onClose?: () => void) =>
    selected && (
      <PairComparison
        pair={selected}
        resolving={resolvingId === selected.id}
        onResolve={(action) => resolveMutation.mutate({ pairId: selected.id, action })}
        onClose={onClose}
      />
    );

  return (
    <div className="flex h-full min-h-0">
      {/* ── Lista (master) ─────────────────────────────────────────────────── */}
      <section className="flex min-h-0 w-full flex-col lg:w-[340px] lg:shrink-0 lg:border-r" aria-label="Lista de duplicados">
        <div className="flex h-12 shrink-0 items-center border-b px-4 sm:px-6">
          <h1 className="text-[15px] font-semibold tracking-tight text-foreground">Duplicados</h1>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-slim">
          {isLoading ? (
            <div className="space-y-2 p-4">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-12 w-full rounded-lg" />)}</div>
          ) : error ? (
            <div className="p-4">
              <ErrorState title="Error al cargar duplicados" description="No pudimos traer los pares. Probá de nuevo." onRetry={() => refetch()} />
            </div>
          ) : pendingPairs.length === 0 ? (
            <div className="p-4">
              <EmptyState
                icon={CopyCheck}
                title="No hay duplicados pendientes"
                description="Cuando el sistema detecte fragmentos muy similares entre documentos, vas a poder revisarlos acá."
              />
            </div>
          ) : (
            pendingPairs.map((pair) => (
              <PairListRow key={pair.id} pair={pair} selected={selectedId === pair.id} onSelect={() => openPair(pair.id)} />
            ))
          )}
        </div>
      </section>

      {/* ── Comparación (desktop, área principal) ──────────────────────────── */}
      <section className="hidden min-h-0 flex-1 flex-col lg:flex" aria-label="Comparación">
        {selected ? comparison() : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">
            <CopyCheck className="h-10 w-10 opacity-30" />
            <p className="text-sm">{pendingPairs.length ? "Elegí un duplicado de la lista para revisarlo" : "No hay duplicados pendientes"}</p>
          </div>
        )}
      </section>

      {/* ── Comparación (mobile, Sheet) ────────────────────────────────────── */}
      <Sheet open={mobileOpen && isMobile && !!selected} onOpenChange={(o) => setMobileOpen(o)}>
        <SheetContent side="right" hideClose aria-describedby={undefined} className="w-full p-0 sm:max-w-xl">
          <SheetTitle className="sr-only">Comparar duplicado</SheetTitle>
          {comparison(() => setMobileOpen(false))}
        </SheetContent>
      </Sheet>
    </div>
  );
}
