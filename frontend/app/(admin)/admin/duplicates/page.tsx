"use client";

import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, ChevronDown, ChevronUp, Loader2, Pencil, CopyCheck, FileText, Check, Copy } from "lucide-react";
import { api, type ChunkDuplicatePair } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { CountChip } from "@/components/layout/page-header";
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

/**
 * Una sola historia cromática por tarjeta, según qué tan parecidos son los
 * textos. El mismo color tiñe la barra lateral, el punto del encabezado y el
 * resaltado de las diferencias — así el color significa "qué tan duplicado es"
 * y no es mera decoración. Escala de calor: casi idéntico (naranja, lo más
 * urgente de resolver) → dicen lo mismo (ámbar) → parecidos (azul, más leve).
 * Clases literales completas para que Tailwind las genere (no concatenar).
 */
const MATCH_STYLES: Record<MatchKind, {
  band: string;        // banda de color del encabezado (fondo + borde inferior)
  chip: string;        // chip del ícono en el encabezado
  pct: string;         // color del número grande de %
  diff: string;        // resaltado de las palabras que difieren
  consequence: string; // texto de la consecuencia al confirmar
}> = {
  identical: {
    band: "bg-attention/[0.08] border-attention/20",
    chip: "bg-attention/15 text-attention",
    pct: "text-attention",
    diff: "bg-attention/15 text-attention",
    consequence: "text-attention",
  },
  semantic: {
    band: "bg-warning/[0.08] border-warning/20",
    chip: "bg-warning/15 text-warning",
    pct: "text-warning",
    diff: "bg-warning/15 text-warning",
    consequence: "text-warning",
  },
  similar: {
    band: "bg-info/[0.08] border-info/20",
    chip: "bg-info/15 text-info",
    pct: "text-info",
    diff: "bg-info/15 text-info",
    consequence: "text-info",
  },
};

// ── Pair card ──────────────────────────────────────────────────────────────────

/** Una de las dos columnas: documento de origen + texto (con diffs, recortable
 *  si es largo) + la acción "Quedarme con este". Todo inline:
 *  - Editar: reemplaza el texto por un campo editable en el lugar (sin modal).
 *  - Quedarme: acción destructiva (elimina el otro), con confirmación inline. */
function SideColumn({
  pairId, which, docTitle, text, tokens, highlight, consequence, clamp,
  onSaved, onKeep, confirming, onAskConfirm, onCancelConfirm, busy,
}: {
  pairId: string;
  which: "a" | "b";
  docTitle: string | null;
  text: string;
  tokens: DiffToken[];
  highlight: string;
  consequence: string;
  clamp: boolean;
  onSaved: (t: string) => void;
  onKeep: () => void;
  confirming: boolean;
  onAskConfirm: () => void;
  onCancelConfirm: () => void;
  busy: boolean;
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
    <div className="group/col flex flex-col overflow-hidden rounded-xl border bg-card shadow-sm transition-shadow hover:shadow-md">
      {/* Cabecera: el documento del que viene este texto + editar */}
      <div className="flex items-center justify-between gap-2 border-b bg-muted/20 px-4 py-2.5">
        <span className="inline-flex min-w-0 items-center gap-2">
          <FileText className="h-4 w-4 shrink-0 text-muted-foreground/70" />
          <span className="truncate text-[13px] font-semibold tracking-tight text-foreground">
            {docTitle ?? "Documento sin título"}
          </span>
        </span>
        {!editing && (
          <button
            onClick={() => setEditing(true)}
            className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium text-muted-foreground opacity-0 transition-all hover:bg-muted hover:text-action focus-visible:opacity-100 focus-visible:outline-none group-hover/col:opacity-100"
            title="Editar este texto"
          >
            <Pencil className="h-3 w-3" />
            Editar
          </button>
        )}
      </div>

      {/* Cuerpo: lectura (con recorte si es largo) o edición inline */}
      {editing ? (
        <div className="px-4 py-3.5">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={8000}
            autoFocus
            className="min-h-[200px] resize-y text-[13.5px] leading-relaxed"
            disabled={saveM.isPending}
          />
          <p className="mt-1.5 text-[11px] text-muted-foreground tabular-nums">{draft.length} / 8000</p>
        </div>
      ) : (
        <div className={cn("relative flex-1 px-4 py-3.5", clamp && "max-h-[13rem] overflow-hidden")}>
          <DiffText tokens={tokens} highlight={highlight} />
          {clamp && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-card to-transparent" />
          )}
        </div>
      )}

      {/* Pie: guardar edición | confirmar descarte del otro | quedarme con este */}
      <div className="flex min-h-[56px] items-center border-t bg-muted/10 px-3 py-2.5">
        {editing ? (
          <div className="flex w-full items-center justify-end gap-1.5">
            <Button
              variant="ghost" size="sm" className="h-8 px-2.5 text-xs"
              onClick={() => { setEditing(false); setDraft(text); }}
              disabled={saveM.isPending}
            >
              Cancelar
            </Button>
            <Button
              size="sm" className="h-8 px-3 text-xs"
              onClick={() => saveM.mutate()}
              disabled={!dirty || tooShort || saveM.isPending}
            >
              {saveM.isPending
                ? <><Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> Guardando…</>
                : <><Check className="mr-1 h-3.5 w-3.5" /> Guardar</>}
            </Button>
          </div>
        ) : confirming ? (
          <div className="flex w-full items-center justify-between gap-2">
            <span className={cn("inline-flex items-center gap-1 text-xs font-medium", consequence)}>
              Se elimina el otro
            </span>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" className="h-8 px-2.5 text-xs" onClick={onCancelConfirm} disabled={busy}>
                Cancelar
              </Button>
              <Button size="sm" className="h-8 px-3 text-xs" onClick={onKeep} disabled={busy}>
                {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1 h-3.5 w-3.5" />}
                Confirmar
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="h-9 w-full gap-1.5 text-xs font-semibold shadow-sm"
            onClick={onAskConfirm}
            disabled={busy}
          >
            <Check className="h-4 w-4" />
            Quedarme con este
          </Button>
        )}
      </div>
    </div>
  );
}

function PairCard({
  pair,
  onResolve,
  resolving,
}: {
  pair: ChunkDuplicatePair;
  onResolve: (action: "keep_a" | "keep_b" | "keep_both") => void;
  resolving: boolean;
}) {
  // Local override de los textos cuando el admin edita un fragmento.
  // Mantengo el texto editado en el state local para que el diff se recalcule
  // inmediatamente sin esperar al refetch del query.
  const [textA, setTextA] = useState(pair.text_a);
  const [textB, setTextB] = useState(pair.text_b);
  useEffect(() => { setTextA(pair.text_a); }, [pair.text_a]);
  useEffect(() => { setTextB(pair.text_b); }, [pair.text_b]);

  const [confirming, setConfirming] = useState<"a" | "b" | null>(null);
  const [expanded, setExpanded] = useState(false);

  const [tokensA, tokensB] = diffWords(textA, textB);
  const sameDoc = pair.doc_id_a === pair.doc_id_b;
  const { kind, label } = classifyMatch(pair);
  const cosinePct = pair.cosine_score !== null ? Math.round(pair.cosine_score * 100) : null;
  const s = MATCH_STYLES[kind];

  // Texto largo → recorto ambas columnas por igual (quedan alineadas al
  // comparar) y ofrezco expandirlas juntas. Umbral por longitud del más largo.
  const isLong = textA.length > 360 || textB.length > 360;
  const clamp = isLong && !expanded;

  return (
    <Card className="overflow-hidden rounded-2xl border shadow-sm transition-shadow hover:shadow-md">
      {/* Banda del encabezado — teñida por severidad. Chip + nivel a la izquierda,
          el % grande como dato ancla a la derecha. Da color y jerarquía de una. */}
      <div className={cn("flex items-center justify-between gap-3 border-b px-5 py-3.5", s.band)}>
        <div className="flex min-w-0 items-center gap-3">
          <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-xl", s.chip)}>
            <Copy className="h-[18px] w-[18px]" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold leading-tight tracking-tight text-foreground">{label}</p>
            {sameDoc && (
              <p className="mt-0.5 inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
                <FileText className="h-3 w-3" /> del mismo documento
              </p>
            )}
          </div>
        </div>
        {cosinePct !== null && (
          <div className="shrink-0 text-right leading-none">
            <span className={cn("text-2xl font-bold tabular-nums", s.pct)}>{cosinePct}</span>
            <span className={cn("text-sm font-semibold", s.pct)}>%</span>
            <p className="mt-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">coincidencia</p>
          </div>
        )}
      </div>

      {/* Cuerpo sobre fondo tenue → las columnas blancas flotan (figura/fondo) */}
      <div className="space-y-4 bg-muted/40 p-4 sm:p-5">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <SideColumn
            pairId={pair.id}
            which="a"
            docTitle={pair.doc_title_a}
            text={textA}
            tokens={tokensA}
            highlight={s.diff}
            consequence={s.consequence}
            clamp={clamp}
            onSaved={setTextA}
            onKeep={() => onResolve("keep_a")}
            confirming={confirming === "a"}
            onAskConfirm={() => setConfirming("a")}
            onCancelConfirm={() => setConfirming(null)}
            busy={resolving}
          />
          <SideColumn
            pairId={pair.id}
            which="b"
            docTitle={pair.doc_title_b}
            text={textB}
            tokens={tokensB}
            highlight={s.diff}
            consequence={s.consequence}
            clamp={clamp}
            onSaved={setTextB}
            onKeep={() => onResolve("keep_b")}
            confirming={confirming === "b"}
            onAskConfirm={() => setConfirming("b")}
            onCancelConfirm={() => setConfirming(null)}
            busy={resolving}
          />
        </div>

        {/* Texto largo → expandir/contraer ambas columnas a la vez */}
        {isLong && (
          <div className="flex items-center justify-center">
            <button
              onClick={() => setExpanded((v) => !v)}
              className="inline-flex items-center gap-1 text-xs font-semibold text-action transition-colors hover:text-action-dark"
            >
              {expanded
                ? <>Contraer textos <ChevronUp className="h-3.5 w-3.5" /></>
                : <>Ver textos completos <ChevronDown className="h-3.5 w-3.5" /></>}
            </button>
          </div>
        )}

        {/* Opción neutral (no borra nada), discreta y separada de las decisiones fuertes */}
        <div className="flex items-center justify-center border-t pt-3">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-xs font-medium text-muted-foreground hover:text-foreground"
            disabled={resolving}
            onClick={() => onResolve("keep_both")}
          >
            {resolving && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
            Los dos son distintos — conservar ambos
          </Button>
        </div>
      </div>
    </Card>
  );
}

// ── Pagination ─────────────────────────────────────────────────────────────────

const PAGE_SIZE = 10;

/** Build a compact page list: [1, '…', 4, 5, 6, '…', 12] */
function paginationRange(current: number, total: number): (number | "…")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const range: (number | "…")[] = [1];
  const start = Math.max(2, current - 1);
  const end   = Math.min(total - 1, current + 1);
  if (start > 2) range.push("…");
  for (let i = start; i <= end; i++) range.push(i);
  if (end < total - 1) range.push("…");
  range.push(total);
  return range;
}

function Pagination({
  page,
  totalPages,
  totalItems,
  pageSize,
  onChange,
}: {
  page: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  onChange: (p: number) => void;
}) {
  if (totalPages <= 1) return null;
  const from = (page - 1) * pageSize + 1;
  const to   = Math.min(page * pageSize, totalItems);

  return (
    <div className="flex flex-col-reverse sm:flex-row items-center justify-between gap-3 pt-2">
      <p className="text-xs text-muted-foreground tabular-nums">
        Mostrando <span className="font-medium text-foreground">{from}–{to}</span> de{" "}
        <span className="font-medium text-foreground">{totalItems}</span>
      </p>
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="sm"
          className="h-8 w-8 p-0"
          disabled={page === 1}
          onClick={() => onChange(page - 1)}
          aria-label="Página anterior"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        {paginationRange(page, totalPages).map((item, idx) =>
          item === "…" ? (
            <span key={`gap-${idx}`} className="px-1 text-muted-foreground text-xs select-none">…</span>
          ) : (
            <Button
              key={item}
              variant={item === page ? "default" : "outline"}
              size="sm"
              className="h-8 w-8 p-0 text-xs tabular-nums"
              onClick={() => onChange(item)}
              aria-current={item === page ? "page" : undefined}
            >
              {item}
            </Button>
          )
        )}
        <Button
          variant="outline"
          size="sm"
          className="h-8 w-8 p-0"
          disabled={page === totalPages}
          onClick={() => onChange(page + 1)}
          aria-label="Página siguiente"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function DuplicatesPage() {
  const queryClient = useQueryClient();
  // Optimistic: track pair IDs hidden after resolution
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["duplicates"],
    queryFn: api.duplicates.list,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const resolveMutation = useMutation({
    mutationFn: ({ pairId, action }: { pairId: string; action: "keep_a" | "keep_b" | "keep_both" }) =>
      api.duplicates.resolve(pairId, action),
    onMutate: ({ pairId }) => {
      setResolvingId(pairId);
    },
    onSuccess: (_, { pairId }) => {
      setHiddenIds((prev) => new Set([...prev, pairId]));
      setResolvingId(null);
      queryClient.invalidateQueries({ queryKey: ["duplicates"] });
      queryClient.invalidateQueries({ queryKey: ["duplicates-stats"] });
      toast({ title: "Par resuelto", variant: "success" });
    },
    onError: () => {
      setResolvingId(null);
      toast({ title: "Error al resolver", description: "Intentá de nuevo.", variant: "destructive" });
    },
  });

  const allPairs = data?.pairs ?? [];
  const visiblePairs = allPairs.filter((p) => !hiddenIds.has(p.id));
  const pendingPairs = useMemo(
    () => visiblePairs.filter((p) => p.status === "pending"),
    [visiblePairs]
  );

  const totalPages = Math.max(1, Math.ceil(pendingPairs.length / PAGE_SIZE));

  // Clamp current page when items disappear (e.g. last item on last page resolved)
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const pagedPairs = pendingPairs.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2.5 border-b px-4 sm:px-6">
        <h1 className="text-[15px] font-semibold tracking-tight text-foreground">Fragmentos duplicados</h1>
        {!isLoading && pendingPairs.length > 0 && (
          <CountChip>{pendingPairs.length} {pendingPairs.length === 1 ? "pendiente" : "pendientes"}</CountChip>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-slim p-4 sm:p-6">
        <div className="mx-auto w-full max-w-5xl">
          {pendingPairs.length > 0 && (
            <p className="mb-4 max-w-3xl text-sm leading-relaxed text-muted-foreground">
              El bot encontró textos que dicen casi lo mismo. Si no los resolvés, puede responder distinto según cuál use.
              Elegí con cuál quedarte —el otro se elimina— o conservá ambos. Lo resaltado marca en qué se diferencian.
            </p>
          )}

          {error ? (
            <div className="rounded-2xl border">
              <ErrorState title="Error al cargar duplicados" description="No pudimos traer los pares de fragmentos. Probá de nuevo." onRetry={() => refetch()} />
            </div>
          ) : isLoading ? (
            <div className="space-y-4">
              <Skeleton className="h-48 w-full rounded-2xl" />
              <Skeleton className="h-48 w-full rounded-2xl" />
            </div>
          ) : pendingPairs.length === 0 ? (
            <div className="rounded-2xl border">
              <EmptyState
                icon={CopyCheck}
                title="No hay duplicados pendientes"
                description="Cuando el sistema detecte fragmentos con contenido muy similar entre documentos, vas a poder revisarlos acá."
              />
            </div>
          ) : (
            <div className="space-y-4">
              {pagedPairs.map((pair) => (
                <PairCard
                  key={pair.id}
                  pair={pair}
                  resolving={resolvingId === pair.id}
                  onResolve={(action) => resolveMutation.mutate({ pairId: pair.id, action })}
                />
              ))}
              <Pagination page={page} totalPages={totalPages} totalItems={pendingPairs.length} pageSize={PAGE_SIZE} onChange={setPage} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
