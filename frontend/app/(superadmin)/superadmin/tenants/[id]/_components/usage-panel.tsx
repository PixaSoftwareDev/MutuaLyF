"use client";

// Uso del cliente: los 4 números que importan + las cuotas con barra.

import { MeterRow, Panel } from "@/components/superadmin/panel";
import { quotaTone, rowTone } from "@/components/superadmin/status";

function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000)     return (n / 1_000).toFixed(1)     + "K";
  return String(n);
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-4 py-3.5">
      <p className="text-2xl font-semibold leading-none tabular-nums tracking-tight">{value}</p>
      <p className="mt-1.5 text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

type Quota = { used: number; limit: number; pct: number | null };

export function UsagePanel({ usage, quotaQ, quotaD }: {
  usage: { queries_today: number; queries_30d: number; ingests_30d: number; llm_tokens_30d: number };
  quotaQ: Quota;
  quotaD: Quota;
}) {
  const meter = (label: string, q: Quota) => (
    <MeterRow
      label={label}
      pct={q.limit === -1 ? null : q.pct}
      valueLabel={q.limit === -1 ? `${fmtNum(q.used)} · sin límite` : `${fmtNum(q.used)} / ${fmtNum(q.limit)}`}
      tone={q.limit === -1 ? undefined : rowTone(quotaTone(q.pct))}
    />
  );
  return (
    <Panel title="Uso" sub="últimos 30 días">
      <div className="grid grid-cols-2 divide-x divide-y divide-border/50 sm:grid-cols-4 sm:divide-y-0">
        <Stat label="Consultas · 30 días" value={fmtNum(usage.queries_30d)} />
        <Stat label="Consultas hoy" value={fmtNum(usage.queries_today)} />
        <Stat label="Tokens de IA" value={fmtNum(usage.llm_tokens_30d)} />
        <Stat label="Ingestas" value={fmtNum(usage.ingests_30d)} />
      </div>
      <div className="divide-y divide-border/50 border-t">
        {meter("Cuota de consultas / mes", quotaQ)}
        {meter("Cuota de documentos", quotaD)}
      </div>
    </Panel>
  );
}
