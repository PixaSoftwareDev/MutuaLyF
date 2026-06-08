"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Upload, Trash2, Loader2,
} from "lucide-react";
import { api, type TenantBranding } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { PageShell } from "@/components/layout/page-shell";
import { PageHeader } from "@/components/layout/page-header";
import { FormColumn } from "@/components/layout/form-column";
import { cn } from "@/lib/utils";
import { contrastRatio, pickReadableTextColor, pickLogoBackgroundColor } from "@/lib/use-tenant-branding";

const DEFAULT_COLOR = "#99323D";
const PALETTE_PRESETS = [
  "#99323D", "#1d4ed8", "#0ea5e9", "#10b981",
  "#f97316", "#a855f7", "#475569", "#0f172a",
];

const API_URL = process.env.NEXT_PUBLIC_API_URL || "";

function fullLogoUrl(url: string | null): string | null {
  if (!url) return null;
  if (url.startsWith("http")) return url;
  return `${API_URL}${url}`;
}

export default function BrandingPage() {
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: branding, isLoading } = useQuery({
    queryKey: ["admin-branding"],
    queryFn: () => api.branding.getAdmin(),
  });

  // ── Form state (mirrors branding, edited locally) ─────────────────────────
  // El form está siempre editable; el botón Guardar de cada card se habilita
  // solo cuando hay cambios respecto al branding del backend (dirty-check).
  const [displayName, setDisplayName]   = useState("");
  const [primary, setPrimary]           = useState(DEFAULT_COLOR);

  useEffect(() => {
    if (!branding) return;
    setDisplayName(branding.display_name);
    setPrimary(branding.primary_color || DEFAULT_COLOR);
  }, [branding]);

  const nameDirty  = !!branding && displayName.trim() !== branding.display_name;
  const colorDirty = !!branding && primary !== (branding.primary_color || DEFAULT_COLOR);

  // ── Mutations ─────────────────────────────────────────────────────────────
  const saveNameM = useMutation({
    mutationFn: () => api.branding.update({
      display_name: displayName.trim() || branding!.display_name,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-branding"] });
      qc.invalidateQueries({ queryKey: ["tenant-branding"] });
      toast({ title: "Nombre actualizado", variant: "success" });
    },
    onError: (err: any) => {
      const detail = err?.response?.data?.detail ?? "Error al guardar";
      toast({ title: detail, variant: "destructive" });
    },
  });

  const saveColorM = useMutation({
    mutationFn: () => api.branding.update({
      primary_color: primary,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-branding"] });
      qc.invalidateQueries({ queryKey: ["tenant-branding"] });
      toast({ title: "Color actualizado", variant: "success" });
    },
    onError: (err: any) => {
      const detail = err?.response?.data?.detail ?? "Error al guardar";
      toast({ title: detail, variant: "destructive" });
    },
  });

  const uploadM = useMutation({
    mutationFn: (file: File) => api.branding.uploadLogo(file),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-branding"] });
      qc.invalidateQueries({ queryKey: ["tenant-branding"] });
      toast({ title: "Logo subido", variant: "success" });
    },
    onError: (err: any) => {
      const detail = err?.response?.data?.detail ?? "Error al subir el logo";
      toast({ title: detail, variant: "destructive" });
    },
  });

  const deleteLogoM = useMutation({
    mutationFn: () => api.branding.deleteLogo(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-branding"] });
      qc.invalidateQueries({ queryKey: ["tenant-branding"] });
      toast({ title: "Logo eliminado" });
    },
  });

  const onFileSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) uploadM.mutate(f);
    e.target.value = "";
  };

  if (isLoading || !branding) {
    return (
      <PageShell>
        <PageHeader title="Branding" description="Personalizá la apariencia de tu organización" />
        <FormColumn>
          <Skeleton className="h-72 rounded-2xl" />
          <Skeleton className="h-48 rounded-2xl" />
        </FormColumn>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PageHeader
        title="Branding"
        description="Personalizá el nombre, el color y el logo que ven tus afiliados y operadores."
      />

      <FormColumn>
          {/* Identity */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Identidad</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="display_name" className="text-xs">Nombre visible</Label>
                <Input
                  id="display_name"
                  value={displayName}
                  onChange={e => setDisplayName(e.target.value)}
                  maxLength={200}
                  placeholder="Ej. Mutualyf S.A."
                />
              </div>
              <div className="flex justify-end">
                <Button
                  onClick={() => saveNameM.mutate()}
                  disabled={!nameDirty || !displayName.trim() || saveNameM.isPending}
                >
                  {saveNameM.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                  Guardar cambios
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Colors */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Color institucional</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <ColorField
                value={primary}
                onChange={setPrimary}
                presets={PALETTE_PRESETS}
                required
              />
              <ContrastFeedback primary={primary} />
              <div className="flex justify-end">
                <Button
                  onClick={() => saveColorM.mutate()}
                  disabled={!colorDirty || saveColorM.isPending}
                >
                  {saveColorM.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                  Guardar cambios
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Logo */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Logo</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-4">
                {/* Preview con el mismo tratamiento que en login/widget:
                    fondo = primary del tenant si es oscuro, slate-800 si es
                    claro. Asi el admin VE como se va a ver su logo en la
                    plataforma — incluyendo el caso PNG transparente blanco. */}
                <div
                  className="w-20 h-20 rounded-lg border flex items-center justify-center shrink-0 overflow-hidden"
                  style={{ background: branding.logo_url ? pickLogoBackgroundColor(primary) : primary }}
                >
                  {branding.logo_url ? (
                    <Image
                      src={fullLogoUrl(branding.logo_url)!}
                      alt={branding.display_name}
                      width={80}
                      height={80}
                      className="object-contain w-full h-full p-1"
                      unoptimized
                    />
                  ) : (
                    <span className="text-white font-bold text-2xl">
                      {(displayName.trim()[0] ?? "?").toUpperCase()}
                    </span>
                  )}
                </div>
                <div className="flex-1 flex flex-wrap gap-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/svg+xml,image/webp"
                    onChange={onFileSelected}
                    className="hidden"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploadM.isPending}
                  >
                    {uploadM.isPending
                      ? <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      : <Upload className="h-4 w-4 mr-2" />}
                    {branding.logo_url ? "Cambiar logo" : "Subir logo"}
                  </Button>
                  {branding.logo_url && (
                    <Button
                      type="button"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      onClick={() => deleteLogoM.mutate()}
                      disabled={deleteLogoM.isPending}
                    >
                      {deleteLogoM.isPending
                        ? <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        : <Trash2 className="h-4 w-4 mr-2" />}
                      Quitar logo
                    </Button>
                  )}
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground mt-3">
                PNG, JPG, SVG o WEBP — hasta 2 MB.
              </p>
            </CardContent>
          </Card>

      </FormColumn>
    </PageShell>
  );
}

// ── Color picker field ───────────────────────────────────────────────────────

// Normaliza cualquier color CSS (hex, rgb(), hsl(), nombre tipo "royalblue") a
// #rrggbb. Devuelve null si no es un color válido. Usa el parser del navegador para
// no mantener una lista de nombres ni regex frágiles; fallback a hex en SSR.
function cssColorToHex(input: string): string | null {
  const v = (input || "").trim();
  if (!v) return null;
  if (/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v)) {
    if (v.length === 4) return ("#" + v[1] + v[1] + v[2] + v[2] + v[3] + v[3]).toLowerCase();
    return v.toLowerCase();
  }
  if (typeof document === "undefined") return null;
  const probe = document.createElement("span").style;
  probe.color = "";
  probe.color = v;
  if (!probe.color) return null;  // el navegador no lo reconoció como color
  const m = probe.color.match(/\d+(?:\.\d+)?/g);
  if (!m || m.length < 3) return null;
  const [r, g, b] = m.map((n) => Math.max(0, Math.min(255, Math.round(Number(n)))));
  return "#" + [r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function ColorField({
  value, onChange, presets, required,
}: {
  value: string;
  onChange: (v: string) => void;
  presets: string[];
  required?: boolean;
}) {
  // Acepta cualquier color CSS válido (no solo hex); se normaliza a hex al salir del campo.
  const isValid = !value || cssColorToHex(value) !== null;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={cssColorToHex(value) || "#ffffff"}
          onChange={e => onChange(e.target.value)}
          className="w-10 h-9 rounded-md border border-input bg-background cursor-pointer p-0.5"
          aria-label="Color picker"
        />
        <input
          type="text"
          value={value}
          onChange={e => onChange(e.target.value)}
          onBlur={e => { const hex = cssColorToHex(e.target.value); if (hex) onChange(hex); }}
          placeholder="#RRGGBB, rgb(...) o nombre"
          className={cn(
            "flex-1 h-9 rounded-md border bg-background px-3 text-sm font-mono uppercase",
            "focus:outline-none focus:ring-1 focus:ring-primary",
            isValid ? "border-input" : "border-destructive",
          )}
          required={required}
        />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {presets.map(p => (
          <button
            key={p}
            type="button"
            onClick={() => onChange(p)}
            className={cn(
              "w-6 h-6 rounded-full border-2 transition-transform hover:scale-110",
              value.toLowerCase() === p.toLowerCase() ? "border-foreground" : "border-transparent",
            )}
            style={{ background: p }}
            aria-label={`Preset ${p}`}
          />
        ))}
      </div>
    </div>
  );
}


// ── Contraste WCAG ────────────────────────────────────────────────────────────
// Avisa al admin si el color elegido no cumple AA (>=4.5:1) contra blanco y
// contra texto oscuro. Sin esto, el cliente puede elegir #ffe000 y termina con
// botones primarios ilegibles en su propia plataforma. Mostramos:
//   - el contraste medido
//   - sample en vivo con el color de texto que el sistema usaria
//   - badge AA / AA Large / Insuficiente
function ContrastFeedback({ primary }: { primary: string }) {
  const textColor   = pickReadableTextColor(primary);
  const ratio       = contrastRatio(primary, textColor);
  const aaNormal    = ratio >= 4.5;
  const aaLarge     = ratio >= 3.0;
  const badge       = aaNormal
    ? { label: "AA ✓",       cls: "bg-success/10 text-success border-success/20" }
    : aaLarge
    ? { label: "AA Large",   cls: "bg-warning/10 text-warning border-warning/20" }
    : { label: "Insuficiente", cls: "bg-destructive/10 text-destructive border-destructive/20" };
  return (
    <div className="mt-3 rounded-md border bg-muted/30 p-3 text-xs">
      <div className="flex items-center gap-2">
        <span
          className="inline-flex items-center rounded px-2.5 py-1 text-xs font-medium"
          style={{ backgroundColor: primary, color: textColor }}
        >
          Acción primaria
        </span>
        <span className={cn("rounded border px-2 py-0.5 text-[11px] font-medium", badge.cls)}>
          {badge.label}
        </span>
        <span className="text-muted-foreground">
          Contraste: <code className="font-mono">{ratio.toFixed(2)}:1</code>
        </span>
      </div>
      {!aaNormal && (
        <p className="mt-2 text-muted-foreground">
          {aaLarge
            ? "Sirve solo para texto grande (≥18px). El texto chico en este color puede leerse mal."
            : "Este color no tiene suficiente contraste con texto blanco ni oscuro. Probá un tono más oscuro o más claro."}
        </p>
      )}
    </div>
  );
}
