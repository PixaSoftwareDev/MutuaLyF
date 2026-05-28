"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuthStore } from "@/lib/store";
import { api } from "@/lib/api";
import { DEFAULT_PRIMARY } from "@/lib/use-tenant-branding";
import { Loader2, AlertTriangle, Shield, Eye, EyeOff } from "lucide-react";

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

const PLATFORM_NAME = "IA Inteligent";
const PLATFORM_ACCENT = DEFAULT_PRIMARY;

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
    <div className="min-h-screen flex flex-col lg:flex-row bg-slate-50">
      <aside
        className="hidden lg:flex lg:w-1/2 relative overflow-hidden text-white"
        style={{ background: `linear-gradient(135deg, ${PLATFORM_ACCENT} 0%, ${shade(PLATFORM_ACCENT, -30)} 100%)` }}
      >
        <div className="absolute inset-0 opacity-10 bg-[radial-gradient(circle_at_top_right,white_0%,transparent_50%)]" />
        <div className="relative z-10 flex flex-col justify-between p-12 w-full">
          <div className="flex items-center gap-3">
            <span className="font-semibold text-lg">{PLATFORM_NAME}</span>
          </div>
          <div className="space-y-4 max-w-md">
            <h1 className="text-4xl font-bold leading-tight">Panel de plataforma</h1>
            <p className="text-white/80 text-base leading-relaxed">
              Acceso exclusivo para administradores de la plataforma.
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs text-white/60">
            <Shield className="h-3.5 w-3.5" />
            <span>Acceso restringido · Solo super administradores</span>
          </div>
        </div>
      </aside>

      <main className="flex-1 flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-sm">
          <div className="lg:hidden flex items-center justify-center gap-2 mb-8">
            <span className="font-semibold text-lg">{PLATFORM_NAME}</span>
          </div>

          <div className="space-y-1 mb-6">
            <div className="flex items-center gap-2 mb-2">
              <Shield className="h-5 w-5 text-violet-600" />
              <h2 className="text-2xl font-bold tracking-tight">Super Admin</h2>
            </div>
            <p className="text-sm text-muted-foreground">Acceso de plataforma</p>
          </div>

          <div className="flex items-center gap-2 rounded-md bg-violet-50 border border-violet-200 px-3 py-2.5 mb-4">
            <Shield className="h-4 w-4 text-violet-600 shrink-0" />
            <span className="text-sm text-violet-700 font-medium">Modo super administrador</span>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email" className="text-xs font-medium">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="tu@email.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                autoComplete="email"
                className="h-10"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="password" className="text-xs font-medium">Contraseña</Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPwd ? "text" : "password"}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                  className="h-10 pr-9"
                />
                <button
                  type="button"
                  onClick={() => setShowPwd(v => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  tabIndex={-1}
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

            <Button
              type="submit"
              className="w-full h-10 font-medium"
              style={{ backgroundColor: PLATFORM_ACCENT }}
              disabled={loading}
            >
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {loading ? "Ingresando..." : "Ingresar"}
            </Button>
          </form>
        </div>
      </main>
    </div>
  );
}
