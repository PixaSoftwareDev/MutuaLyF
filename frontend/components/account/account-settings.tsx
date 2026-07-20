"use client";

import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Eye, EyeOff, Check } from "lucide-react";
import { api } from "@/lib/api";
import { extractErrorMessage } from "@/lib/errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardHeader, CardContent, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

const ROLE_LABEL: Record<string, string> = {
  operator: "Operador",
  admin: "Administrador",
  super_admin: "Super admin",
};

type Props = {
  /** Hint bajo el campo Nombre (el operador explica que lo ven los afiliados). */
  nameHint?: string;
  /** Nota sobre el email en la card de identidad. */
  emailHint: string;
  /** Mostrar los sectores asignados en la identidad (solo operador). */
  showSectors?: boolean;
};

/**
 * Cuerpo compartido de "Mi cuenta" (admin y operador). Mismo riel de dos
 * columnas que Configuración: formularios a la izquierda, card de identidad
 * sticky a la derecha. Las páginas solo aportan PageShell + PageHeader.
 */
export function AccountSettings({ nameHint, emailHint, showSectors }: Props) {
  const qc = useQueryClient();

  const { data: me, isLoading } = useQuery({
    queryKey: ["me"],
    queryFn: api.auth.me,
    staleTime: 60_000,
  });

  // ── Profile form ──────────────────────────────────────────────────────────
  const [name, setName] = useState("");
  useEffect(() => { if (me) setName(me.name); }, [me]);
  const dirty = me ? name.trim() !== me.name : false;

  const saveProfileM = useMutation({
    mutationFn: () => api.auth.updateMe(name.trim()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["me"] });
      toast({ title: "Perfil actualizado", variant: "success" });
    },
    onError: (err: any) => {
      toast({ title: extractErrorMessage(err, "No se pudo guardar."), variant: "destructive" });
    },
  });

  // ── Password form ─────────────────────────────────────────────────────────
  const [currentPwd, setCurrentPwd] = useState("");
  const [newPwd, setNewPwd]         = useState("");
  const [confirmPwd, setConfirmPwd] = useState("");
  const [showPwd, setShowPwd]       = useState(false);

  const pwdLengthOk  = newPwd.length >= 8;
  const pwdMatch     = newPwd.length > 0 && newPwd === confirmPwd;
  const pwdDifferent = newPwd.length > 0 && newPwd !== currentPwd;
  const pwdReady     = currentPwd.length > 0 && pwdLengthOk && pwdMatch && pwdDifferent;

  const changePwdM = useMutation({
    mutationFn: () => api.auth.changePassword(currentPwd, newPwd),
    onSuccess: () => {
      setCurrentPwd(""); setNewPwd(""); setConfirmPwd("");
      toast({ title: "Contraseña actualizada", variant: "success" });
    },
    onError: (err: any) => {
      toast({ title: extractErrorMessage(err, "No se pudo cambiar la contraseña."), variant: "destructive" });
    },
  });

  const initial = (me?.name?.trim()?.[0] ?? me?.email?.[0] ?? "?").toUpperCase();

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header bar consistente con el resto de la app */}
      <div className="flex h-12 shrink-0 items-center border-b px-4 sm:px-6">
        <h1 className="text-[15px] font-semibold tracking-tight text-foreground">Mi cuenta</h1>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-slim p-4 sm:p-6">
        {/* Una sola columna centrada (patrón de ajustes): simple y prolijo tanto
            en monitor como en notebook chica. Sin grillas ni columnas laterales. */}
        <div className="mx-auto w-full max-w-2xl space-y-4 sm:space-y-6">
          {isLoading || !me ? (
            <>
              <Skeleton className="h-24 rounded-2xl" />
              <Skeleton className="h-44 rounded-2xl" />
              <Skeleton className="h-80 rounded-2xl" />
            </>
          ) : (
            <>
              {/* Identidad — fila compacta: avatar + datos + rol */}
              <div className="relative overflow-hidden rounded-2xl border bg-card">
                <div className="pointer-events-none absolute inset-x-0 top-0 h-20 bg-gradient-to-b from-action/[0.09] to-transparent" aria-hidden />
                <div className="relative flex items-center gap-4 p-5">
                  <div
                    className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl text-xl font-bold text-white shadow-md"
                    style={{ background: "linear-gradient(135deg, #22d3ee 0%, #6366f1 55%, #7A2DFF 100%)" }}
                  >
                    {initial}
                  </div>
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate text-base font-semibold tracking-tight text-foreground">{me.name}</h2>
                    <p className="truncate text-sm text-muted-foreground">{me.email}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <span className="inline-flex items-center rounded-full border border-action/30 bg-action/[0.06] px-2.5 py-0.5 text-[11px] font-semibold text-action">
                        {ROLE_LABEL[me.role] ?? me.role}
                      </span>
                      {showSectors && me.sectors.map(s => (
                        <span key={s.id} className="inline-flex items-center rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[11px] font-medium text-foreground/70">
                          {s.nombre}
                        </span>
                      ))}
                      {showSectors && me.sectors.length === 0 && (
                        <span className="text-[11px] text-muted-foreground">Sin sectores asignados</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* Perfil */}
              <Card className="rounded-2xl">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Perfil</CardTitle>
                  <CardDescription>Cómo aparecés en la plataforma.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="account-name">Nombre completo</Label>
                    <Input
                      id="account-name"
                      type="text"
                      value={name}
                      onChange={e => setName(e.target.value)}
                      maxLength={120}
                      placeholder="Ej: María García"
                    />
                    {nameHint && (
                      <p className="text-[11px] text-muted-foreground/80">{nameHint}</p>
                    )}
                  </div>
                  <div className="flex justify-end pt-1">
                    <Button
                      onClick={() => saveProfileM.mutate()}
                      disabled={!dirty || !name.trim() || saveProfileM.isPending}
                    >
                      {saveProfileM.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                      Guardar cambios
                    </Button>
                  </div>
                </CardContent>
              </Card>

              {/* Contraseña */}
              <Card className="rounded-2xl">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Cambiar contraseña</CardTitle>
                  <CardDescription>Tu nueva clave de acceso a la plataforma.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-4">
                    <div className="space-y-1.5">
                      <Label htmlFor="pwd-current">Contraseña actual</Label>
                      <PasswordInput
                        id="pwd-current"
                        value={currentPwd}
                        onChange={setCurrentPwd}
                        show={showPwd}
                        onToggleShow={() => setShowPwd(v => !v)}
                        placeholder="Tu contraseña actual"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="pwd-new">Contraseña nueva</Label>
                      <PasswordInput
                        id="pwd-new"
                        value={newPwd}
                        onChange={setNewPwd}
                        show={showPwd}
                        onToggleShow={() => setShowPwd(v => !v)}
                        placeholder="Mínimo 8 caracteres"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="pwd-confirm">Confirmar nueva</Label>
                      <PasswordInput
                        id="pwd-confirm"
                        value={confirmPwd}
                        onChange={setConfirmPwd}
                        show={showPwd}
                        onToggleShow={() => setShowPwd(v => !v)}
                        placeholder="Repetí la nueva contraseña"
                      />
                    </div>
                  </div>

                  {/* Checklist en vivo — reemplaza los mensajes de error sueltos */}
                  <ul className="space-y-1.5">
                    <Requirement ok={pwdLengthOk} label="Al menos 8 caracteres" />
                    <Requirement ok={pwdLengthOk && pwdDifferent} label="Distinta de la actual" />
                    <Requirement ok={pwdMatch} label="Las contraseñas coinciden" />
                  </ul>

                  <div className="flex justify-end pt-1">
                    <Button
                      onClick={() => changePwdM.mutate()}
                      disabled={!pwdReady || changePwdM.isPending}
                    >
                      {changePwdM.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                      Actualizar contraseña
                    </Button>
                  </div>
                </CardContent>
              </Card>

              <p className="px-1 text-[11px] leading-snug text-muted-foreground/70">{emailHint}</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Requisito de contraseña (checklist en vivo) ──────────────────────────────

function Requirement({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className={cn(
      "flex items-center gap-2 text-xs transition-colors",
      ok ? "text-success" : "text-muted-foreground/70",
    )}>
      {ok
        ? <Check className="h-3.5 w-3.5 shrink-0" />
        : <span className="h-3.5 w-3.5 shrink-0 flex items-center justify-center">
            <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
          </span>}
      {label}
    </li>
  );
}

// ── Input de contraseña con toggle de visibilidad ────────────────────────────

function PasswordInput({
  id, value, onChange, show, onToggleShow, placeholder,
}: {
  id?: string;
  value: string; onChange: (v: string) => void;
  show: boolean; onToggleShow: () => void; placeholder?: string;
}) {
  return (
    <div className="relative">
      <Input
        id={id}
        type={show ? "text" : "password"}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="pr-9"
        autoComplete="off"
      />
      <button
        type="button"
        onClick={onToggleShow}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        aria-label={show ? "Ocultar contraseña" : "Mostrar contraseña"}
        tabIndex={-1}
      >
        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}
