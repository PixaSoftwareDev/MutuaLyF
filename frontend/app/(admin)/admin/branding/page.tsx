"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Palette, Upload, Trash2, Loader2, Check, Eye, Shield, Building2,
} from "lucide-react";
import { api, type TenantBranding } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { PageShell } from "@/components/layout/page-shell";
import { PageHeader } from "@/components/layout/page-header";
import { cn } from "@/lib/utils";

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
  const [displayName, setDisplayName]   = useState("");
  const [primary, setPrimary]           = useState(DEFAULT_COLOR);
  const [secondary, setSecondary]       = useState("");

  useEffect(() => {
    if (!branding) return;
    setDisplayName(branding.display_name);
    setPrimary(branding.primary_color || DEFAULT_COLOR);
    setSecondary(branding.secondary_color || "");
  }, [branding]);

  const dirty = !!branding && (
    displayName.trim() !== branding.display_name ||
    primary !== (branding.primary_color || DEFAULT_COLOR) ||
    (secondary || null) !== (branding.secondary_color || null)
  );

  // ── Mutations ─────────────────────────────────────────────────────────────
  const saveM = useMutation({
    mutationFn: () => api.branding.update({
      display_name:    displayName.trim() || branding!.display_name,
      primary_color:   primary,
      secondary_color: secondary || null,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-branding"] });
      qc.invalidateQueries({ queryKey: ["tenant-branding"] });
      toast({ title: "Branding actualizado", variant: "success" });
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
        <Skeleton className="h-72 rounded-lg" />
        <Skeleton className="h-48 rounded-lg" />
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PageHeader
        title="Branding"
        description="Personalizá el nombre, el color y el logo que ven tus afiliados y operadores."
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* ── LEFT (2/3): form ──────────────────────────────────────────── */}
        <div className="lg:col-span-2 space-y-6">
          {/* Identity */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Building2 className="h-4 w-4" /> Identidad
              </CardTitle>
              <CardDescription>Nombre visible de tu organización</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="display_name" className="text-xs">Nombre visible</Label>
                <Input
                  id="display_name"
                  value={displayName}
                  onChange={e => setDisplayName(e.target.value)}
                  maxLength={200}
                  placeholder="Ej: Mutualyf S.A."
                />
                <p className="text-[11px] text-muted-foreground">
                  Es el nombre que aparece en el login y en el chat de los afiliados.
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Colors */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Palette className="h-4 w-4" /> Colores
              </CardTitle>
              <CardDescription>Tu color principal se aplica a botones, headers y acentos</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <ColorField
                label="Color principal"
                value={primary}
                onChange={setPrimary}
                presets={PALETTE_PRESETS}
                required
              />
              <ColorField
                label="Color secundario (opcional)"
                value={secondary}
                onChange={setSecondary}
                placeholder="vacío = automático"
                presets={PALETTE_PRESETS}
              />
            </CardContent>
          </Card>

          {/* Logo */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Upload className="h-4 w-4" /> Logo
              </CardTitle>
              <CardDescription>PNG, JPG, SVG o WEBP — hasta 2 MB. Se ve en login y topbars.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-4">
                <div
                  className="w-20 h-20 rounded-lg border bg-muted/30 flex items-center justify-center shrink-0 overflow-hidden"
                  style={{ background: !branding.logo_url ? primary : undefined }}
                >
                  {branding.logo_url ? (
                    <Image
                      src={fullLogoUrl(branding.logo_url)!}
                      alt={branding.display_name}
                      width={80}
                      height={80}
                      className="object-contain w-full h-full"
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
            </CardContent>
          </Card>

          {/* Save bar */}
          <div className="flex items-center justify-between bg-card border rounded-lg px-4 py-3 sticky bottom-0 shadow-sm">
            <p className="text-xs text-muted-foreground">
              {dirty ? "Tenés cambios sin guardar" : "Sin cambios"}
            </p>
            <Button
              onClick={() => saveM.mutate()}
              disabled={!dirty || saveM.isPending || !displayName.trim()}
            >
              {saveM.isPending
                ? <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                : <Check className="h-4 w-4 mr-2" />}
              Guardar cambios
            </Button>
          </div>
        </div>

        {/* ── RIGHT (1/3): preview ──────────────────────────────────────── */}
        <div className="lg:col-span-1">
          <div className="sticky top-6 space-y-3">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <Eye className="h-3.5 w-3.5" />
              Vista previa del login
            </div>
            <LoginPreview
              displayName={displayName || branding.display_name}
              primaryColor={primary}
              logoUrl={fullLogoUrl(branding.logo_url)}
            />
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              Así se ve aproximadamente la pantalla de login de tu organización con los cambios actuales.
              Recargá <code>/login</code> después de guardar para ver el resultado real.
            </p>
          </div>
        </div>
      </div>
    </PageShell>
  );
}

// ── Color picker field ───────────────────────────────────────────────────────

function ColorField({
  label, value, onChange, presets, placeholder, required,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  presets: string[];
  placeholder?: string;
  required?: boolean;
}) {
  const isValid = !value || /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.test(value);
  return (
    <div className="space-y-2">
      <Label className="text-xs">{label}</Label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={value || "#ffffff"}
          onChange={e => onChange(e.target.value)}
          className="w-10 h-9 rounded-md border border-input bg-background cursor-pointer p-0.5"
          aria-label={`Color picker ${label}`}
        />
        <input
          type="text"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder ?? "#RRGGBB"}
          className={cn(
            "flex-1 h-9 rounded-md border bg-background px-3 text-sm font-mono uppercase",
            "focus:outline-none focus:ring-1 focus:ring-primary",
            isValid ? "border-input" : "border-destructive",
          )}
          required={required}
        />
        {!required && value && (
          <button
            type="button"
            onClick={() => onChange("")}
            className="text-xs text-muted-foreground hover:text-foreground px-2"
          >
            Limpiar
          </button>
        )}
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

// ── Login preview (miniatura del split layout) ───────────────────────────────

function LoginPreview({
  displayName, primaryColor, logoUrl,
}: {
  displayName: string;
  primaryColor: string;
  logoUrl: string | null;
}) {
  const shaded = shade(primaryColor, -30);
  return (
    <div className="rounded-lg border overflow-hidden shadow-sm bg-white">
      <div className="flex h-56">
        {/* Hero */}
        <div
          className="w-1/2 p-4 flex flex-col justify-between text-white text-[10px]"
          style={{ background: `linear-gradient(135deg, ${primaryColor} 0%, ${shaded} 100%)` }}
        >
          <div className="flex items-center gap-1.5">
            <div className="w-7 h-7 rounded-md bg-white/15 backdrop-blur flex items-center justify-center overflow-hidden">
              {logoUrl
                ? <Image src={logoUrl} alt="logo" width={28} height={28} className="object-contain w-full h-full" unoptimized />
                : <span className="font-bold text-[11px]">{(displayName[0] ?? "?").toUpperCase()}</span>}
            </div>
            <span className="font-semibold text-[11px] truncate">{displayName}</span>
          </div>
          <p className="font-bold text-sm leading-tight">Tu conocimiento, a un mensaje de distancia.</p>
          <div className="flex items-center gap-1 text-white/60 text-[9px]">
            <Shield className="h-2.5 w-2.5" /> Cifrado · Multi-tenant
          </div>
        </div>
        {/* Form */}
        <div className="w-1/2 p-4 space-y-2 text-[10px]">
          <p className="font-bold text-sm">Iniciar sesión</p>
          <p className="text-muted-foreground text-[10px]">Accedé a {displayName}</p>
          <div className="space-y-1 pt-1">
            <div className="h-1.5 w-12 bg-muted rounded" />
            <div className="h-5 rounded border border-input bg-background" />
            <div className="h-1.5 w-8 bg-muted rounded" />
            <div className="h-5 rounded border border-input bg-background" />
            <div className="h-1.5 w-10 bg-muted rounded" />
            <div className="h-5 rounded border border-input bg-background" />
          </div>
          <div className="h-6 rounded text-white font-medium text-[10px] flex items-center justify-center" style={{ background: primaryColor }}>
            Ingresar
          </div>
        </div>
      </div>
    </div>
  );
}

function shade(hex: string, pct: number): string {
  const h = hex.replace("#", "");
  if (h.length !== 6) return hex;
  const num = parseInt(h, 16);
  let r = (num >> 16) + Math.round(2.55 * pct);
  let g = ((num >> 8) & 0xff) + Math.round(2.55 * pct);
  let b = (num & 0xff) + Math.round(2.55 * pct);
  r = Math.max(0, Math.min(255, r));
  g = Math.max(0, Math.min(255, g));
  b = Math.max(0, Math.min(255, b));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}
