"use client";

// Equipo del cliente: quiénes entran al panel, con alta por invitación y
// edición (rol, activo, contraseña). Los sheets son los que ya funcionaban —
// solo cambiaron de casa.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, Loader2, Settings2, UserPlus, Users } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { FormSheet } from "@/components/layout/form-sheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatePill } from "@/components/ui/state-pill";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { EmptyState } from "@/components/ui/empty-state";
import { Panel } from "@/components/superadmin/panel";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

type TenantUser = { id: string; email: string; name: string; role: string; is_active: boolean };

export function TeamPanel({ tenantId, tenantName }: { tenantId: string; tenantName: string }) {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<TenantUser | null>(null);

  const { data: users = [], isLoading } = useQuery({
    queryKey: ["tenant-users", tenantId],
    queryFn: () => api.tenants.listUsers(tenantId),
    staleTime: 30_000,
  });

  const inv = () => qc.invalidateQueries({ queryKey: ["tenant-users", tenantId] });

  return (
    <>
      <Panel
        title="Equipo"
        sub={`${users.length} en total`}
        action={
          <Button size="sm" variant="outline" className="h-7 gap-1.5 px-2.5 text-xs" onClick={() => setShowCreate(true)}>
            <UserPlus className="h-3.5 w-3.5" /> Nuevo usuario
          </Button>
        }
      >
        {isLoading ? (
          <div className="space-y-2 p-4">
            {[1, 2].map(i => <Skeleton key={i} className="h-10 rounded-lg" />)}
          </div>
        ) : users.length === 0 ? (
          <EmptyState icon={Users} title="Sin usuarios registrados" />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Usuario</TableHead>
                  <TableHead className="hidden md:table-cell">Email</TableHead>
                  <TableHead>Rol</TableHead>
                  <TableHead className="hidden sm:table-cell">Estado</TableHead>
                  <TableHead className="w-[70px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map(u => (
                  <TableRow key={u.id} className="cursor-pointer hover:bg-muted/40" onClick={() => setEditing(u)}>
                    <TableCell>
                      <p className="max-w-[160px] truncate text-sm font-medium">{u.name || "—"}</p>
                      <p className="mt-0.5 max-w-[200px] truncate text-[11px] text-muted-foreground md:hidden">{u.email}</p>
                    </TableCell>
                    <TableCell className="hidden max-w-[240px] truncate text-xs text-muted-foreground md:table-cell">{u.email}</TableCell>
                    <TableCell>
                      <StatePill tone={u.role === "operator" ? "info" : "muted"}>
                        {u.role === "admin" ? "Admin" : u.role === "operator" ? "Operador" : u.role}
                      </StatePill>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <StatePill tone={u.is_active ? "success" : "destructive"}>{u.is_active ? "Activo" : "Inactivo"}</StatePill>
                    </TableCell>
                    <TableCell className="text-right">
                      <Settings2 className="inline-block h-3.5 w-3.5 text-muted-foreground/40" />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Panel>

      {showCreate && (
        <CreateUserSheet
          tenantId={tenantId}
          tenantName={tenantName}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); inv(); }}
        />
      )}
      {editing && (
        <EditUserSheet
          tenantId={tenantId}
          user={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); inv(); }}
        />
      )}
    </>
  );
}

// ── Alta (invitación por email o contraseña manual) ──────────────────────────
function CreateUserSheet({ tenantId, tenantName, onClose, onCreated }: {
  tenantId: string; tenantName: string; onClose: () => void; onCreated: () => void;
}) {
  const [form, setForm] = useState({ email: "", name: "", password: "" });
  const [inviteMode, setInviteMode] = useState(true);
  const [error, setError] = useState("");
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }));

  const createM = useMutation({
    mutationFn: () => api.tenants.createAdmin(tenantId, {
      email: form.email, name: form.name,
      ...(inviteMode ? {} : { password: form.password }),
    }),
    onSuccess: (data: any) => {
      onCreated();
      if (data?.invitation_sent === true) {
        toast({ title: "Invitación enviada", description: `${form.email} va a recibir un email para definir su contraseña.`, variant: "success" });
      } else if (data?.invitation_sent === false) {
        toast({ title: "Usuario creado, pero el email no salió", description: "Puede usar «¿Olvidaste tu contraseña?» en el login.", variant: "destructive" });
      } else {
        toast({ title: "Usuario creado", description: `${form.email} puede iniciar sesión en '${tenantId}'.`, variant: "success" });
      }
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.detail ?? "Error al crear el usuario.";
      setError(typeof msg === "string" ? msg : JSON.stringify(msg));
    },
  });

  return (
    <FormSheet
      open
      onOpenChange={v => !v && onClose()}
      icon={UserPlus}
      title="Nuevo usuario"
      description={<>Para <span className="font-medium text-foreground">{tenantName}</span></>}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button
            disabled={createM.isPending || !form.email || (!inviteMode && form.password.length < 8)}
            onClick={() => { setError(""); createM.mutate(); }}
          >
            {createM.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {inviteMode ? "Crear e invitar" : "Crear usuario"}
          </Button>
        </>
      }
    >
      <div className="space-y-3 py-1">
        {([
          { key: "email", label: "Email",  placeholder: "admin@empresa.com", type: "email" },
          { key: "name",  label: "Nombre", placeholder: "Nombre Apellido",   type: "text" },
        ] as const).map(f => (
          <div key={f.key} className="space-y-1">
            <Label className="text-xs font-medium">{f.label}</Label>
            <Input type={f.type} placeholder={f.placeholder} value={(form as any)[f.key]} onChange={set(f.key)} className="h-9" />
          </div>
        ))}

        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Acceso</Label>
          <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5 transition-colors has-[:checked]:border-action/40 has-[:checked]:bg-action/[0.04]">
            <input type="radio" name="adm-access" checked={inviteMode} onChange={() => setInviteMode(true)} className="mt-0.5" />
            <span className="text-xs">
              <span className="text-sm font-medium">Enviar invitación por email</span>
              <span className="mt-0.5 block text-muted-foreground">Define su contraseña desde el enlace (72 hs). Verifica el email.</span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5 transition-colors has-[:checked]:border-action/40 has-[:checked]:bg-action/[0.04]">
            <input type="radio" name="adm-access" checked={!inviteMode} onChange={() => setInviteMode(false)} className="mt-0.5" />
            <span className="text-xs">
              <span className="text-sm font-medium">Definir contraseña ahora</span>
            </span>
          </label>
          {!inviteMode && (
            <Input type="password" placeholder="Mínimo 8 caracteres" value={form.password} onChange={set("password")} className="h-9 animate-fade-in" />
          )}
        </div>

        {error && (
          <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2">
            <p className="text-xs text-destructive">{error}</p>
          </div>
        )}
      </div>
    </FormSheet>
  );
}

// ── Edición (nombre, rol, activo, contraseña opcional) ───────────────────────
function EditUserSheet({ tenantId, user, onClose, onSaved }: {
  tenantId: string; user: TenantUser; onClose: () => void; onSaved: () => void;
}) {
  const [name, setName]         = useState(user.name);
  const [role, setRole]         = useState(user.role);
  const [isActive, setIsActive] = useState(user.is_active);
  const [password, setPassword] = useState("");
  const [showPwd, setShowPwd]   = useState(false);
  const [error, setError]       = useState("");

  const saveM = useMutation({
    mutationFn: () => api.tenants.updateUser(tenantId, user.id, {
      name: name.trim(),
      role,
      is_active: isActive,
      ...(password ? { password } : {}),
    }),
    onSuccess: () => { toast({ title: "Usuario actualizado", variant: "success" }); onSaved(); },
    onError: (e: any) => {
      const detail = e?.response?.data?.detail;
      setError(typeof detail === "string" ? detail : "Error al guardar. Verificá los datos.");
    },
  });

  return (
    <FormSheet
      open
      onOpenChange={v => !v && onClose()}
      icon={Settings2}
      title="Editar usuario"
      description={user.email}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={() => saveM.mutate()} disabled={saveM.isPending || !name.trim()}>
            {saveM.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            Guardar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="eu-name" className="text-xs font-medium">Nombre</Label>
          <Input id="eu-name" value={name} onChange={e => setName(e.target.value)} placeholder="Nombre completo" />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="eu-role" className="text-xs font-medium">Rol</Label>
          <Select value={role} onValueChange={setRole}>
            <SelectTrigger id="eu-role"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="admin">Admin</SelectItem>
              <SelectItem value="operator">Operador</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-4 py-3">
          <div className="space-y-0.5">
            <p className="text-sm font-medium">Activo</p>
            <p className="text-xs text-muted-foreground">{isActive ? "Puede iniciar sesión" : "Acceso bloqueado"}</p>
          </div>
          <button
            type="button"
            onClick={() => setIsActive(v => !v)}
            className={cn(
              "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors",
              isActive ? "bg-success" : "bg-muted-foreground/30",
            )}
          >
            <span className={cn(
              "inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform",
              isActive ? "translate-x-6" : "translate-x-1",
            )} />
          </button>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="eu-pwd" className="text-xs font-medium">
            Nueva contraseña <span className="font-normal text-muted-foreground">(opcional)</span>
          </Label>
          <div className="relative">
            <Input
              id="eu-pwd"
              type={showPwd ? "text" : "password"}
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Mínimo 8 caracteres"
              className="pr-9"
            />
            <button
              type="button"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => setShowPwd(v => !v)}
              tabIndex={-1}
            >
              {showPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    </FormSheet>
  );
}
