// Vocabulario ÚNICO de estado del superadmin y sus derivadores.
// Antes esta lógica vivía copy-pasteada en Inicio, Monitoreo (x4) y el
// detalle de tenant, con tres nomenclaturas distintas. Acá hay UNA:
//   ok      → sano (verde, discreto)
//   warn    → para vigilar (ámbar)
//   down    → roto (rojo, imposible de ignorar)
//   unknown → sin datos para afirmar nada (gris — típico sin Prometheus)

export type Tone = "ok" | "warn" | "down" | "unknown";

export const DOT: Record<Tone, string> = {
  ok:      "bg-success",
  warn:    "bg-warning",
  down:    "bg-destructive animate-pulse motion-reduce:animate-none",
  unknown: "bg-muted-foreground/40",
};

export const TEXT: Record<Tone, string> = {
  ok:      "text-success",
  warn:    "text-warning",
  down:    "text-destructive",
  unknown: "text-muted-foreground",
};

/** Tono de un gauge *_up de Prometheus: false = caído; null = sin monitoreo. */
export function svcTone(up: boolean | null | undefined): Tone {
  return up === false ? "down" : up == null ? "unknown" : "ok";
}

/** Servicio de IA: sano si nunca llamó o si los errores no dominan. */
export function iaTone(groq: { total_calls: number; by_model: Array<{ errors: number; total: number }> } | undefined): Tone {
  if (!groq) return "unknown";
  if (groq.total_calls === 0) return "ok";
  return (groq.by_model ?? []).every(m => m.errors === 0 || m.errors < m.total) ? "ok" : "down";
}

/** Tono por porcentaje con umbrales (memoria/CPU/disco/cuotas). */
export function pctTone(pct: number | null | undefined, warn: number, down: number): Tone {
  if (pct == null) return "unknown";
  if (pct >= down) return "down";
  if (pct >= warn) return "warn";
  return "ok";
}

export const serverMemTone  = (pct: number | null | undefined) => pctTone(pct, 80, 92);
export const serverLoadTone = (pct: number | null | undefined) => pctTone(pct, 80, 95);
export const diskTone       = (pct: number | null | undefined) => pctTone(pct, 70, 85);
export const quotaTone      = (pct: number | null | undefined) => pctTone(pct, 70, 90);

/** Latencia del bot (ms). >5s roto, >3s elevada. */
export function latencyTone(ms: number | null | undefined): Tone {
  if (ms == null) return "unknown";
  if (ms > 5000) return "down";
  if (ms > 3000) return "warn";
  return "ok";
}

/** Backups + disco combinados (la fila "Backups" del Inicio). */
export function backupTone(
  backups: { daily: { healthy: boolean } | null; weekly: { healthy: boolean } | null } | null | undefined,
  diskPct: number | null | undefined,
  monitoringAvailable: boolean,
): Tone {
  if (!monitoringAvailable && backups == null) return "unknown";
  if ((backups?.daily && !backups.daily.healthy) || (diskPct != null && diskPct >= 85)) return "down";
  if ((backups?.weekly && !backups.weekly.healthy) || (diskPct != null && diskPct >= 70) || backups == null) return "warn";
  return "ok";
}

/** El peor tono gana (down > warn > ok); unknown no alarma. */
export function worst(tones: Tone[]): Tone {
  if (tones.includes("down")) return "down";
  if (tones.includes("warn")) return "warn";
  return tones.every(t => t === "unknown") ? "unknown" : "ok";
}

/** MeterRow/KVRow usan "warn"|"down"|undefined — adaptador. */
export function rowTone(t: Tone): "warn" | "down" | undefined {
  return t === "warn" || t === "down" ? t : undefined;
}
