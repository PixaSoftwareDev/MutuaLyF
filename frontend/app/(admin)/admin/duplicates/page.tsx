"use client";

import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ChevronLeft, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import { api, type ChunkDuplicatePair } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";

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

function DiffView({ textA, textB }: { textA: string; textB: string }) {
  const [tokensA, tokensB] = diffWords(textA, textB);

  const renderTokens = (tokens: DiffToken[]) => (
    <p className="text-sm leading-relaxed">
      {tokens.map((tok, idx) => {
        if (tok.type === "common") {
          return (
            <span key={idx} className="text-muted-foreground">
              {tok.word}{" "}
            </span>
          );
        }
        if (tok.type === "only_a") {
          return (
            <span key={idx} className="bg-green-100 text-green-800 rounded px-0.5">
              {tok.word}{" "}
            </span>
          );
        }
        return (
          <span key={idx} className="bg-red-100 text-red-800 rounded px-0.5">
            {tok.word}{" "}
          </span>
        );
      })}
    </p>
  );

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3">
      <div className="rounded-md border p-3 bg-muted/30">
        <p className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">
          Fragmento A
        </p>
        {renderTokens(tokensA)}
      </div>
      <div className="rounded-md border p-3 bg-muted/30">
        <p className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">
          Fragmento B
        </p>
        {renderTokens(tokensB)}
      </div>
    </div>
  );
}

// ── Match summary ──────────────────────────────────────────────────────────────

type MatchKind = "identical" | "semantic" | "similar";

function classifyMatch(pair: ChunkDuplicatePair): { kind: MatchKind; label: string; dot: string } {
  const cosine = pair.cosine_score ?? 0;
  const jaccard = pair.jaccard_score ?? 0;
  if (jaccard >= 0.7)  return { kind: "identical", label: "Texto casi idéntico", dot: "bg-rose-500" };
  if (cosine  >= 0.92) return { kind: "semantic",  label: "Mismo significado",   dot: "bg-violet-500" };
  return                      { kind: "similar",   label: "Contenido similar",   dot: "bg-amber-500" };
}

function MatchSummary({ pair }: { pair: ChunkDuplicatePair }) {
  const { label } = classifyMatch(pair);
  const cosinePct  = pair.cosine_score  !== null ? Math.round(pair.cosine_score  * 100) : null;
  const jaccardPct = pair.jaccard_score !== null ? Math.round(pair.jaccard_score * 100) : null;
  // Only surface the text score when it adds signal (≥ 30%) — below that it is noise.
  const showJaccard = jaccardPct !== null && jaccardPct >= 30;

  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="font-medium text-foreground">{label}</span>
      {cosinePct !== null && (
        <span className="text-muted-foreground tabular-nums">{cosinePct}%</span>
      )}
      {showJaccard && (
        <>
          <span className="text-muted-foreground/40">·</span>
          <span className="text-xs text-muted-foreground tabular-nums">texto {jaccardPct}%</span>
        </>
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
                  <span className="text-amber-600 font-medium">{hasTitles ? "· " : ""}mismo documento</span>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <Button
              size="sm"
              variant="outline"
              disabled={resolving}
              onClick={() => onResolve("keep_a")}
              className="h-8 text-xs gap-1"
            >
              {resolving ? <Loader2 className="h-3 w-3 animate-spin" /> : (
                <>
                  <span className="h-1.5 w-1.5 rounded-full bg-primary/70" />
                  Mantener A
                </>
              )}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={resolving}
              onClick={() => onResolve("keep_b")}
              className="h-8 text-xs gap-1"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-primary/70" />
              Mantener B
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={resolving}
              onClick={() => onResolve("keep_both")}
              className="h-8 text-xs text-muted-foreground hover:text-foreground"
            >
              Mantener ambos
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <DiffView textA={pair.text_a} textB={pair.text_b} />
      </CardContent>
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
      toast({ title: "Par resuelto", description: "El fragmento ha sido procesado correctamente.", variant: "success" });
    },
    onError: () => {
      setResolvingId(null);
      toast({ title: "Error al resolver", description: "No se pudo procesar la acción. Intentá de nuevo.", variant: "destructive" });
    },
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["duplicates"] });
    queryClient.invalidateQueries({ queryKey: ["duplicates-stats"] });
  };

  const allPairs = data?.pairs ?? [];
  const visiblePairs = allPairs.filter((p) => !hiddenIds.has(p.id));
  const pendingPairs = useMemo(
    () => visiblePairs.filter((p) => p.status === "pending"),
    [visiblePairs]
  );
  const resolvedCount = (data?.total ?? 0) - (data?.pending ?? 0) + hiddenIds.size;

  const totalPages = Math.max(1, Math.ceil(pendingPairs.length / PAGE_SIZE));

  // Clamp current page when items disappear (e.g. last item on last page resolved)
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const pagedPairs = pendingPairs.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="p-4 sm:p-6 space-y-4 sm:space-y-6">
      {/* Page header — always visible */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Fragmentos Duplicados</h1>
          <p className="text-sm text-muted-foreground">
            Revisá y resolvé pares de fragmentos con contenido similar
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh}>
          <RefreshCw className="h-4 w-4 mr-1" />
          Actualizar
        </Button>
      </div>

      {error && (
        <div className="text-destructive text-sm">
          Error al cargar duplicados. Intentá refrescar la página.
        </div>
      )}

      {/* Stats bar */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className="font-medium text-foreground">{data?.pending ?? 0} pendientes</span>
        <span>·</span>
        <span>{resolvedCount} resueltos</span>
        <span>·</span>
        <span>{data?.total ?? 0} total</span>
      </div>

      {/* Pairs list */}
      {isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : pendingPairs.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center gap-4">
          <div className="p-4 rounded-full bg-green-100">
            <CheckCircle2 className="h-10 w-10 text-green-600" />
          </div>
          <div>
            <p className="font-medium text-lg">Todo limpio</p>
            <p className="text-sm text-muted-foreground mt-1">
              No hay fragmentos duplicados pendientes de revisión.
            </p>
          </div>
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

    </div>
  );
}
