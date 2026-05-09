"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuthStore } from "@/lib/store";
import { api } from "@/lib/api";
import { Loader2, AlertTriangle, Shield } from "lucide-react";

export default function LoginPage() {
  const router = useRouter();
  const { setAuth } = useAuthStore();

  const [email, setEmail]         = useState("");
  const [password, setPassword]   = useState("");
  const [tenantId, setTenantId]   = useState("");
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [loading, setLoading]     = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      // Super-admin sends no tenantId → backend checks platform_users table
      const effectiveTenant = isSuperAdmin ? "" : tenantId;
      const data = await api.auth.login(email, password, effectiveTenant);
      const payload = JSON.parse(atob(data.access_token.split(".")[1]));
      const role = payload.role as string;
      const resolvedTenant = payload.tenant_id as string;

      setAuth(data.access_token, resolvedTenant, email, role);
      document.cookie = `ia_role=${role}; path=/; SameSite=strict`;
      document.cookie = `ia_tenant=${resolvedTenant}; path=/; SameSite=strict`;

      if (role === "super_admin") router.push("/superadmin");
      else if (role === "operator") router.push("/operator");
      else router.push("/admin/documents");
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      setError(typeof detail === "string" ? detail : "Credenciales incorrectas. Verificá email y contraseña.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100 p-4">
      <Card className="w-full max-w-md shadow-lg">
        <CardHeader className="space-y-1 pb-4">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
              <span className="text-white text-sm font-bold">IA</span>
            </div>
            <span className="font-semibold text-lg">IA Inteligent</span>
          </div>
          <CardTitle className="text-2xl font-bold">Iniciar sesión</CardTitle>
          <CardDescription>
            {isSuperAdmin
              ? "Acceso de administrador de plataforma"
              : "Accedé a tu plataforma de conocimiento institucional"}
          </CardDescription>
        </CardHeader>

        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Tenant field — hidden for super-admin */}
            {!isSuperAdmin && (
              <div className="space-y-2">
                <Label htmlFor="tenant">Organización</Label>
                <Input
                  id="tenant"
                  placeholder="mi-empresa"
                  value={tenantId}
                  onChange={(e) => setTenantId(e.target.value)}
                  required
                  autoComplete="organization"
                />
              </div>
            )}

            {isSuperAdmin && (
              <div className="flex items-center gap-2 rounded-md bg-violet-50 border border-violet-200 px-3 py-2">
                <Shield className="h-4 w-4 text-violet-600 shrink-0" />
                <span className="text-sm text-violet-700 font-medium">Modo super administrador</span>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder={isSuperAdmin ? "pixs@gmail.com" : "admin@empresa.com"}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">Contraseña</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
            </div>

            {error && (
              <div className="rounded-md bg-destructive/10 border border-destructive/20 p-3 text-sm text-destructive flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <Button type="submit" className="w-full" disabled={loading}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {loading ? "Ingresando..." : "Ingresar"}
            </Button>

            <button
              type="button"
              onClick={() => { setIsSuperAdmin(v => !v); setError(null); setTenantId(""); }}
              className="w-full text-xs text-muted-foreground hover:text-foreground transition-colors text-center"
            >
              {isSuperAdmin ? "← Volver a login de organización" : "Soy administrador de la plataforma"}
            </button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
