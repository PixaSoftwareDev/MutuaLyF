"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Upload, Trash2, Loader2, Save, MoreVertical, Edit2,
} from "lucide-react";
import { api, type TenantBranding } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
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

  // Modo edición por sección — read-only por default. Se entra con el dropdown
  // 3 puntos, se sale con Guardar o Cancelar.
  const [editingName,  setEditingName]  = useState(false);
  const [editingColor, setEditingColor] = useState(false);

  useEffect(() => {
    if (!branding) return;
    setDisplayName(branding.display_name);
    setPrimary(branding.primary_color || DEFAULT_COLOR);
  }, [branding]);

  const nameDirty  = !!branding && displayName.trim() !== branding.display_name;
  const colorDirty = !!branding && primary !== (branding.primary_color || DEFAULT_COLOR);

  const cancelName = () => {
    if (branding) setDisplayName(branding.display_name);
    setEditingName(false);
  };
  const cancelColor = () => {
    if (branding) setPrimary(branding.primary_color || DEFAULT_COLOR);
    setEditingColor(false);
  };

  // ── Mutations ─────────────────────────────────────────────────────────────
  const saveNameM = useMutation({
    mutationFn: () => api.branding.update({
      display_name: displayName.trim() || branding!.display_name,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-branding"] });
      qc.invalidateQueries({ queryKey: ["tenant-branding"] });
      setEditingName(false);
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
      setEditingColor(false);
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

      <div className="space-y-6">
          {/* Identity */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-base">Identidad</CardTitle>
                {!editingName && <SectionMenu onEdit={() => setEditingName(true)} />}
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-1.5 max-w-md">
                <Label htmlFor="display_name" className="text-xs">Nombre visible</Label>
                {editingName ? (
                  <>
                    <Input
                      id="display_name"
                      value={displayName}
                      onChange={e => setDisplayName(e.target.value)}
                      maxLength={200}
                      placeholder="Ej. Mutualyf S.A."
                      autoFocus
                    />
                    <div className="flex gap-2 pt-2">
                      <Button
                        size="sm"
                        onClick={() => saveNameM.mutate()}
                        disabled={!nameDirty || !displayName.trim() || saveNameM.isPending}
                      >
                        {saveNameM.isPending
                          ? <Loader2 className="h-4 w-4 animate-spin mr-1" />
                          : <Save className="h-4 w-4 mr-1" />}
                        Guardar
                      </Button>
                      <Button size="sm" variant="outline" onClick={cancelName} disabled={saveNameM.isPending}>
                        Cancelar
                      </Button>
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground leading-relaxed rounded-md border bg-muted/30 px-3 py-2">
                    {displayName}
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Colors */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-base">Color institucional</CardTitle>
                {!editingColor && <SectionMenu onEdit={() => setEditingColor(true)} />}
              </div>
            </CardHeader>
            <CardContent>
              <div className="max-w-md">
                {editingColor ? (
                  <>
                    <ColorField
                      value={primary}
                      onChange={setPrimary}
                      presets={PALETTE_PRESETS}
                      required
                    />
                    <div className="flex gap-2 pt-3">
                      <Button
                        size="sm"
                        onClick={() => saveColorM.mutate()}
                        disabled={!colorDirty || saveColorM.isPending}
                      >
                        {saveColorM.isPending
                          ? <Loader2 className="h-4 w-4 animate-spin mr-1" />
                          : <Save className="h-4 w-4 mr-1" />}
                        Guardar
                      </Button>
                      <Button size="sm" variant="outline" onClick={cancelColor} disabled={saveColorM.isPending}>
                        Cancelar
                      </Button>
                    </div>
                  </>
                ) : (
                  <div className="flex items-center gap-3 rounded-md border bg-muted/30 px-3 py-2">
                    <span
                      className="h-7 w-7 rounded-md border shrink-0"
                      style={{ backgroundColor: primary }}
                      aria-label="Vista previa del color"
                    />
                    <code className="text-sm font-mono uppercase text-foreground">{primary}</code>
                  </div>
                )}
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
              <p className="text-[11px] text-muted-foreground mt-3">
                PNG, JPG, SVG o WEBP — hasta 2 MB.
              </p>
            </CardContent>
          </Card>

      </div>
    </PageShell>
  );
}

// ── Dropdown 3 puntos compartido por sección editable ────────────────────────

function SectionMenu({ onEdit }: { onEdit: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" variant="ghost" className="h-8 w-8 -mr-1" aria-label="Acciones">
          <MoreVertical className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-32">
        <DropdownMenuItem onSelect={onEdit}>
          <Edit2 className="h-4 w-4 mr-2" />
          Editar
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ── Color picker field ───────────────────────────────────────────────────────

function ColorField({
  value, onChange, presets, required,
}: {
  value: string;
  onChange: (v: string) => void;
  presets: string[];
  required?: boolean;
}) {
  const isValid = !value || /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.test(value);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={value || "#ffffff"}
          onChange={e => onChange(e.target.value)}
          className="w-10 h-9 rounded-md border border-input bg-background cursor-pointer p-0.5"
          aria-label="Color picker"
        />
        <input
          type="text"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder="#RRGGBB"
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

