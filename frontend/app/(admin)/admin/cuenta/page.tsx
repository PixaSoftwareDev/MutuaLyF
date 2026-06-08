"use client";

import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Eye, EyeOff } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardContent, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { PageShell } from "@/components/layout/page-shell";
import { PageHeader } from "@/components/layout/page-header";
import { FormColumn } from "@/components/layout/form-column";

const ROLE_LABEL: Record<string, string> = {
  operator: "Operador",
  admin: "Administrador",
  super_admin: "Super admin",
};

export default function AdminAccountPage() {
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
      const detail = err?.response?.data?.detail ?? "Error al guardar";
      toast({ title: detail, variant: "destructive" });
    },
  });

  // ── Password form ─────────────────────────────────────────────────────────
  const [currentPwd, setCurrentPwd] = useState("");
  const [newPwd, setNewPwd]         = useState("");
  const [confirmPwd, setConfirmPwd] = useState("");
  const [showPwd, setShowPwd]       = useState(false);

  const pwdLengthOk    = newPwd.length >= 8;
  const pwdMatch       = newPwd.length > 0 && newPwd === confirmPwd;
  const pwdDifferent   = newPwd.length > 0 && newPwd !== currentPwd;
  const pwdReady       = currentPwd.length > 0 && pwdLengthOk && pwdMatch && pwdDifferent;

  const changePwdM = useMutation({
    mutationFn: () => api.auth.changePassword(currentPwd, newPwd),
    onSuccess: () => {
      setCurrentPwd(""); setNewPwd(""); setConfirmPwd("");
      toast({ title: "Contraseña actualizada", variant: "success" });
    },
    onError: (err: any) => {
      const detail = err?.response?.data?.detail ?? "Error al cambiar la contraseña";
      toast({ title: detail, variant: "destructive" });
    },
  });

  if (isLoading || !me) {
    return (
      <PageShell>
        <Skeleton className="h-8 w-48" />
        <FormColumn>
          <Skeleton className="h-48 rounded-2xl" />
          <Skeleton className="h-64 rounded-2xl" />
        </FormColumn>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PageHeader
        title="Mi cuenta"
        description="Editá tu nombre y contraseña de administrador."
      />

      <FormColumn>
        {/* Profile */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold">Perfil</CardTitle>
            <CardDescription>Datos de tu cuenta</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field label="Nombre completo">
              <Input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                maxLength={120}
                placeholder="Ej: María García"
              />
            </Field>

            <Field label="Email">
              <Input
                type="email"
                value={me.email}
                disabled
                className="bg-muted text-muted-foreground"
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                El email es tu identificador de acceso y no se puede cambiar.
              </p>
            </Field>

            <Field label="Rol">
              <div className="h-9 rounded-md border border-input bg-muted/60 px-3 text-sm flex items-center text-muted-foreground">
                {ROLE_LABEL[me.role] ?? me.role}
              </div>
            </Field>

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

        {/* Password */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold">Cambiar contraseña</CardTitle>
            <CardDescription>Mínimo 8 caracteres. Distinta de la actual.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field label="Contraseña actual">
              <PasswordInput
                value={currentPwd}
                onChange={setCurrentPwd}
                show={showPwd}
                onToggleShow={() => setShowPwd(v => !v)}
                placeholder="Tu contraseña actual"
              />
            </Field>

            <Field label="Contraseña nueva">
              <PasswordInput
                value={newPwd}
                onChange={setNewPwd}
                show={showPwd}
                onToggleShow={() => setShowPwd(v => !v)}
                placeholder="Mínimo 8 caracteres"
              />
              {newPwd.length > 0 && !pwdLengthOk && (
                <p className="text-[11px] text-destructive mt-1">Debe tener al menos 8 caracteres</p>
              )}
              {newPwd.length > 0 && pwdLengthOk && !pwdDifferent && (
                <p className="text-[11px] text-destructive mt-1">Debe ser distinta de la actual</p>
              )}
            </Field>

            <Field label="Confirmar contraseña nueva">
              <PasswordInput
                value={confirmPwd}
                onChange={setConfirmPwd}
                show={showPwd}
                onToggleShow={() => setShowPwd(v => !v)}
                placeholder="Repetí la nueva contraseña"
              />
              {confirmPwd.length > 0 && !pwdMatch && (
                <p className="text-[11px] text-destructive mt-1">No coincide con la nueva contraseña</p>
              )}
            </Field>

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
      </FormColumn>
    </PageShell>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-foreground/80 mb-1.5">
        {label}
      </label>
      {children}
    </div>
  );
}

function PasswordInput({
  value, onChange, show, onToggleShow, placeholder,
}: {
  value: string; onChange: (v: string) => void;
  show: boolean; onToggleShow: () => void; placeholder?: string;
}) {
  return (
    <div className="relative">
      <Input
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
