"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuthStore } from "@/lib/store";
import { api } from "@/lib/api";
import { AuthShell, brandBtnStyle, BRAND_GRADIENT } from "@/components/auth/auth-shell";
import { Loader2, AlertTriangle, ShieldCheck, Eye, EyeOff } from "lucide-react";

export default function LoginSuperadminPage() {
  const router = useRouter();
  const { setAuth } = useAuthStore();

  const [email, setEmail]     = useState("");
  const [password, setPassword] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const data = await api.auth.login(email, password, "");
      const payload = JSON.parse(atob(data.access_token.split(".")[1]));
      const role = payload.role as string;
      const resolvedTenant = payload.tenant_id as string;

      setAuth(data.access_token, resolvedTenant, email, role);
      document.cookie = `ia_role=${role}; path=/; SameSite=strict`;
      document.cookie = `ia_tenant=${resolvedTenant}; path=/; SameSite=strict`;

      if (role === "super_admin") router.push("/superadmin");
      else setError("Esta página es solo para super administradores.");
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      setError(typeof detail === "string" ? detail : "Credenciales incorrectas.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell>
      {/* Insignia de plataforma: identidad Intellix (no un tenant). El escudo
          sobre el gradient de marca + el pill comunican "esta es la consola
          del equipo", con la misma jerarquía visual que el login normal. */}
      <div className="flex flex-col items-center text-center mb-7 lg:mb-8">
        <div
          className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl shadow-lg shadow-indigo-500/25"
          style={{ backgroundImage: BRAND_GRADIENT }}
        >
          <ShieldCheck className="h-7 w-7 text-white" />
        </div>
        <h1 className="text-2xl lg:text-[26px] font-semibold tracking-tight text-slate-900">
          Consola de plataforma
        </h1>
        <p className="text-[14px] lg:text-[15px] text-slate-500 leading-relaxed mt-1.5">
          Acceso exclusivo del equipo Intellix.
        </p>
        <span className="mt-4 inline-flex items-center gap-1.5 rounded-full border border-violet-200/70 bg-violet-50 px-3 py-1 text-[12px] font-semibold text-violet-700">
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundImage: BRAND_GRADIENT }} />
          Super administrador
        </span>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4 lg:space-y-5 xl:space-y-6">
        <div className="space-y-1.5">
          <Label htmlFor="email" className="text-[13px] font-medium text-slate-700">Email</Label>
          <Input
            id="email"
            type="email"
            placeholder="tu@email.com"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            autoComplete="email"
            className="h-11 lg:h-12 xl:h-[52px] text-[15px] focus-visible:ring-2 focus-visible:ring-indigo-500/30"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="password" className="text-[13px] font-medium text-slate-700">Contraseña</Label>
          <div className="relative">
            <Input
              id="password"
              type={showPwd ? "text" : "password"}
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              className="h-11 lg:h-12 xl:h-[52px] pr-10 text-[15px] focus-visible:ring-2 focus-visible:ring-indigo-500/30"
            />
            <button
              type="button"
              onClick={() => setShowPwd(v => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              tabIndex={-1}
              aria-label={showPwd ? "Ocultar contraseña" : "Mostrar contraseña"}
            >
              {showPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>

        {error && (
          <div className="rounded-md bg-destructive/10 border border-destructive/20 p-3 text-sm text-destructive flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        <Button type="submit" className="w-full h-11 lg:h-12 text-[15px] font-medium" style={brandBtnStyle} disabled={loading}>
          {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {loading ? "Ingresando…" : "Ingresar"}
        </Button>
      </form>
    </AuthShell>
  );
}
