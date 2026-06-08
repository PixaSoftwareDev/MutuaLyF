"use client";

import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Loader2, Pencil, CopyCheck } from "lucide-react";
import { api, type ChunkDuplicatePair } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { PageShell } from "@/components/layout/page-shell";
import { PageHeader } from "@/components/layout/page-header";

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

// ── DiffView component ─────────────────────────────────────────────────────────

function DiffView({
  textA,
  textB,
  onEditA,
  onEditB,
}: {
  textA: string;
  textB: string;
  onEditA: () => void;
  onEditB: () => void;
}) {
  const [tokensA, tokensB] = diffWords(textA, textB);

  // Resalto las diferencias con un color distinto por lado para que se lea de un
  // vistazo qué texto es exclusivo de A (info/azul) vs exclusivo de B (warning).
  const renderTokens = (tokens: DiffToken[]) => (
    <p className="text-sm leading-relaxed">
      {tokens.map((tok, idx) => {
        const cls =
          tok.type === "only_a"
            ? "bg-info/10 text-info rounded px-0.5"
            : tok.type === "only_b"
            ? "bg-warning/10 text-warning rounded px-0.5"
            : "";
        return (
          <span key={idx} className={cls}>
            {tok.word}{" "}
          </span>
        );
      })}
    </p>
  );

  return (
    <>
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 text-[11px] text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full bg-info" />
        Solo en A
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full bg-warning" />
        Solo en B
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full bg-muted-foreground/30" />
        En ambos
      </span>
    </div>
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
      <div className="rounded-md border border-info/30 p-3 bg-info/5 relative">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-info inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-info" />
            Fragmento A
          </p>
          <button
            onClick={onEditA}
            className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
            title="Editar este fragmento antes de decidir"
          >
            <Pencil className="h-3 w-3" />
            Editar
          </button>
        </div>
        {renderTokens(tokensA)}
      </div>
      <div className="rounded-md border border-warning/30 p-3 bg-warning/5 relative">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-warning inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-warning" />
            Fragmento B
          </p>
          <button
            onClick={onEditB}
            className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
            title="Editar este fragmento antes de decidir"
          >
            <Pencil className="h-3 w-3" />
            Editar
          </button>
        </div>
        {renderTokens(tokensB)}
      </div>
    </div>
    </>
  );
}

// ── Edit chunk modal ───────────────────────────────────────────────────────────

function EditChunkModal({
  open,
  onClose,
  pairId,
  which,
  initialText,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  pairId: string;
  which: "a" | "b";
  initialText: string;
  onSaved: (newText: string) => void;
}) {
  const [text, setText] = useState(initialText);

  useEffect(() => {
    if (open) setText(initialText);
  }, [open, initialText]);

  const saveM = useMutation({
    mutationFn: () => api.duplicates.editChunk(pairId, which, text.trim()),
    onSuccess: ({ text: savedText }) => {
      onSaved(savedText);
      toast({
        title: "Fragmento actualizado",
        description: "Se re-procesó el embedding para que el bot lo encuentre con el nuevo texto.",
        variant: "success",
      });
      onClose();
    },
    onError: (err: any) => {
      const detail = err?.response?.data?.detail || "No se pudo guardar el cambio.";
      toast({
        title: "Error al guardar",
        description: typeof detail === "string" ? detail : "Intentá de nuevo.",
        variant: "destructive",
      });
    },
  });

  const dirty = text.trim() !== initialText.trim();
  const tooShort = text.trim().length < 1;

  return (
    <Dialog open={open} onOpenChange={(v) => !saveM.isPending && !v && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Editar fragmento {which.toUpperCase()}</DialogTitle>
          <DialogDescription>
            Cambiá el texto del fragmento. Al guardar, el bot lo re-indexa para que
            las búsquedas usen la versión nueva.
          </DialogDescription>
        </DialogHeader>

        <Textarea
          value={text}
          onChange={e => setText(e.target.value)}
          rows={14}
          maxLength={8000}
          className="font-mono text-xs resize-none"
          disabled={saveM.isPending}
        />
        <p className="text-[11px] text-muted-foreground">
          {text.length} / 8000 caracteres
        </p>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            disabled={saveM.isPending}
          >
            Cancelar
          </Button>
          <Button
            size="sm"
            onClick={() => saveM.mutate()}
            disabled={!dirty || tooShort || saveM.isPending}
          >
            {saveM.isPending ? (
              <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Guardando…</>
            ) : (
              "Guardar cambios"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Match summary ──────────────────────────────────────────────────────────────

type MatchKind = "identical" | "semantic" | "similar";

function classifyMatch(pair: ChunkDuplicatePair): { kind: MatchKind; label: string } {
  const cosine = pair.cosine_score ?? 0;
  const jaccard = pair.jaccard_score ?? 0;
  if (jaccard >= 0.7)  return { kind: "identical", label: "Texto casi idéntico" };
  if (cosine  >= 0.92) return { kind: "semantic",  label: "Mismo significado"   };
  return                      { kind: "similar",   label: "Contenido similar"   };
}

function MatchSummary({ pair }: { pair: ChunkDuplicatePair }) {
  const { label } = classifyMatch(pair);
  const cosinePct = pair.cosine_score !== null ? Math.round(pair.cosine_score * 100) : null;

  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="font-medium text-foreground">{label}</span>
      {cosinePct !== null && (
        <span className="text-muted-foreground tabular-nums">{cosinePct}%</span>
      )}
    </div>
  );
}

// ── Pair card ──────────────────────────────────────────────────────────────────

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

  const [editingWhich, setEditingWhich] = useState<"a" | "b" | null>(null);

  const titleA = pair.doc_title_a;
  const titleB = pair.doc_title_b;
  const sameDoc = pair.doc_id_a === pair.doc_id_b;
  const hasTitles = Boolean(titleA || titleB);

  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-3 space-y-2">
        {/* Header: match summary (left) + actions (right) */}
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1 min-w-0">
            <MatchSummary pair={pair} />
            {(hasTitles || sameDoc) && (
              <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                {hasTitles && (
                  <>
                    <span className="truncate max-w-[14rem]">{titleA ?? "—"}</span>
                    <span className="text-muted-foreground/40">↔</span>
                    <span className="truncate max-w-[14rem]">{titleB ?? "—"}</span>
                  </>
                )}
                {sameDoc && (
                  <span className="text-warning font-medium">{hasTitles ? "· " : ""}mismo documento</span>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <Button
              size="sm"
              disabled={resolving}
              onClick={() => onResolve("keep_both")}
              className="h-8 text-xs"
            >
              {resolving && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
              Mantener ambos
            </Button>
            <Button
              size="sm" variant="outline"
              disabled={resolving}
              onClick={() => onResolve("keep_a")}
              className="h-8 text-xs text-info border-info/40 hover:bg-info/10"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-info mr-1.5" />
              Mantener A
            </Button>
            <Button
              size="sm" variant="outline"
              disabled={resolving}
              onClick={() => onResolve("keep_b")}
              className="h-8 text-xs text-warning border-warning/40 hover:bg-warning/10"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-warning mr-1.5" />
              Mantener B
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <DiffView
          textA={textA}
          textB={textB}
          onEditA={() => setEditingWhich("a")}
          onEditB={() => setEditingWhich("b")}
        />
      </CardContent>
      <EditChunkModal
        open={editingWhich !== null}
        onClose={() => setEditingWhich(null)}
        pairId={pair.id}
        which={editingWhich ?? "a"}
        initialText={editingWhich === "a" ? textA : textB}
        onSaved={(newText) => {
          if (editingWhich === "a") setTextA(newText);
          else if (editingWhich === "b") setTextB(newText);
        }}
      />
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

  const { data, isLoading, error } = useQuery({
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
    <PageShell>
      <PageHeader
        title="Fragmentos duplicados"
        description="Pares de fragmentos con contenido similar entre documentos. Decidí cuál conservar."
      />

      {error && (
        <div className="text-destructive text-sm">
          Error al cargar duplicados.
        </div>
      )}

      {/* Pairs list */}
      {isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : pendingPairs.length === 0 ? (
        <EmptyState
          icon={CopyCheck}
          title="No hay duplicados pendientes"
          description="Cuando el sistema detecte fragmentos con contenido muy similar entre documentos, vas a poder revisarlos acá."
        />
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
          <Pagination
            page={page}
            totalPages={totalPages}
            totalItems={pendingPairs.length}
            pageSize={PAGE_SIZE}
            onChange={(p) => {
              setPage(p);
              window.scrollTo({ top: 0, behavior: "smooth" });
            }}
          />
        </div>
      )}

    </PageShell>
  );
}
