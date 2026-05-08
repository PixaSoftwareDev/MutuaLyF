"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { GitMerge, CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { api, type ChunkDuplicatePair } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
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

// ── Score badge helpers ────────────────────────────────────────────────────────

function scoreBadgeVariant(score: number): string {
  if (score >= 0.9) return "bg-red-100 text-red-800 border-red-200";
  if (score >= 0.75) return "bg-amber-100 text-amber-800 border-amber-200";
  return "bg-yellow-50 text-yellow-700 border-yellow-200";
}

function ScoreBadge({ label, score }: { label: string; score: number | null }) {
  if (score === null) return null;
  const pct = Math.round(score * 100);
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${scoreBadgeVariant(score)}`}
    >
      {label}: {pct}%
    </span>
  );
}

function statusBadgeVariant(status: ChunkDuplicatePair["status"]) {
  switch (status) {
    case "pending":   return "secondary";
    case "keep_a":    return "default";
    case "keep_b":    return "default";
    case "keep_both": return "outline";
  }
}

const STATUS_LABELS: Record<ChunkDuplicatePair["status"], string> = {
  pending:   "Pendiente",
  keep_a:    "Mantener A",
  keep_b:    "Mantener B",
  keep_both: "Mantener ambos",
};

function matchTypeBadge(pair: ChunkDuplicatePair) {
  const cosine = pair.cosine_score ?? 0;
  const jaccard = pair.jaccard_score ?? 0;
  if (jaccard >= 0.7) {
    return <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium bg-red-100 text-red-800 border-red-200">Texto casi idéntico</span>;
  }
  if (cosine >= 0.92) {
    return <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium bg-purple-100 text-purple-800 border-purple-200">Mismo significado</span>;
  }
  return <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium bg-amber-100 text-amber-800 border-amber-200">Contenido similar</span>;
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
  const titleA = pair.doc_title_a ?? pair.doc_id_a.slice(0, 8) + "…";
  const titleB = pair.doc_title_b ?? pair.doc_id_b.slice(0, 8) + "…";
  const sameDoc = pair.doc_id_a === pair.doc_id_b;

  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-2 space-y-2">
        {/* Top row: type badge + scores + status */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 flex-1 min-w-0 flex-wrap">
            {matchTypeBadge(pair)}
            <ScoreBadge label="Semántica" score={pair.cosine_score} />
            {(pair.jaccard_score !== null && pair.jaccard_score > 0) && (
              <ScoreBadge label="Texto" score={pair.jaccard_score} />
            )}
            <Badge variant={statusBadgeVariant(pair.status)}>
              {STATUS_LABELS[pair.status]}
            </Badge>
          </div>
        </div>

        {/* Document origin row */}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>
            <span className="font-medium text-foreground">A:</span>{" "}
            <span className="font-mono">{titleA}</span>
          </span>
          <span>·</span>
          <span>
            <span className="font-medium text-foreground">B:</span>{" "}
            <span className="font-mono">{titleB}</span>
          </span>
          {sameDoc && (
            <span className="text-amber-600 font-medium">mismo documento</span>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-1 flex-wrap">
          <span className="text-xs text-muted-foreground mr-1">Resolución:</span>
          <Button
            size="sm"
            variant="outline"
            disabled={resolving}
            onClick={() => onResolve("keep_a")}
            className="h-7 text-xs"
          >
            {resolving ? <Loader2 className="h-3 w-3 animate-spin" /> : "Mantener A"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={resolving}
            onClick={() => onResolve("keep_b")}
            className="h-7 text-xs"
          >
            Mantener B
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={resolving}
            onClick={() => onResolve("keep_both")}
            className="h-7 text-xs"
          >
            Mantener ambos
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <DiffView textA={pair.text_a} textB={pair.text_b} />
      </CardContent>
    </Card>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function DuplicatesPage() {
  const queryClient = useQueryClient();
  // Optimistic: track pair IDs hidden after resolution
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const [resolvingId, setResolvingId] = useState<string | null>(null);

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
  const pendingPairs = visiblePairs.filter((p) => p.status === "pending");
  const resolvedCount = (data?.total ?? 0) - (data?.pending ?? 0) + hiddenIds.size;

  return (
    <div className="p-6 space-y-6">
      {/* Page header — always visible */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-primary/10">
            <GitMerge className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">Fragmentos Duplicados</h1>
            <p className="text-sm text-muted-foreground">
              Revisá y resolvé pares de fragmentos con contenido similar
            </p>
          </div>
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
          {pendingPairs.map((pair) => (
            <PairCard
              key={pair.id}
              pair={pair}
              resolving={resolvingId === pair.id}
              onResolve={(action) => resolveMutation.mutate({ pairId: pair.id, action })}
            />
          ))}
        </div>
      )}

    </div>
  );
}
