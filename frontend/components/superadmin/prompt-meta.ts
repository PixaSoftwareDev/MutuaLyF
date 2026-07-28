// Metadatos compartidos de personalidades/prompts — antes duplicados en
// Personalidades, Motor y el detalle de tenant. Fuente única.

export const PLANS = [
  { value: "starter",      label: "Starter" },
  { value: "professional", label: "Professional" },
  { value: "enterprise",   label: "Enterprise" },
] as const;

export const PLAN_ORDER: Record<string, number> = { starter: 0, professional: 1, enterprise: 2 };

export const PLAN_COLORS: Record<string, string> = {
  starter:      "bg-muted text-muted-foreground",
  professional: "bg-info/10 text-info",
  enterprise:   "bg-muted text-muted-foreground",
};

const CAT_PALETTE = [
  "bg-muted text-muted-foreground",
  "bg-muted text-muted-foreground",
  "bg-info/10 text-info",
  "bg-success/10 text-success",
  "bg-warning/10 text-warning",
];

export function catColor(cat: string): string {
  let hash = 0;
  for (let i = 0; i < cat.length; i++) hash = (hash * 31 + cat.charCodeAt(i)) & 0xffffffff;
  return CAT_PALETTE[Math.abs(hash) % CAT_PALETTE.length];
}

export function catLabel(cat: string): string {
  return cat.charAt(0).toUpperCase() + cat.slice(1).replace(/[_-]/g, " ");
}
