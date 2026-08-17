"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuthStore } from "@/lib/store";
import { api, scheduleProactiveRefresh } from "@/lib/api";
import { decodeJwtPayload } from "@/lib/jwt";
import { domFieldValue, useAutofillSync } from "@/lib/use-autofill-sync";
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

  // Autofill de Chrome / tipeo pre-hidratación: llenan el DOM sin disparar
  // onChange y el estado controlado queda atrás. El hook empuja DOM → estado
  // durante toda esa ventana; `fieldValue` es la red de seguridad al enviar,
  // donde lo que el usuario tiene a la vista manda. Ver lib/use-autofill-sync.ts.
  useAutofillSync({ email: setEmail, password: setPassword });
  const fieldValue = (id: string, fallback: string) => domFieldValue(id) || fallback;

  // Núcleo del login: recibe los valores explícitos para que el replay
  // pre-hidratación pueda pasar lo que realmente hay en el DOM.
  const submitCredentials = async (emailVal: string, pwdVal: string) => {
    setError(null);
    setLoading(true);
    try {
      const data = await api.auth.login(emailVal, pwdVal, "");
      const payload = decodeJwtPayload<{ role?: string; tenant_id?: string }>(data.access_token);
      if (!payload?.role || !payload?.tenant_id) throw new Error("Token de sesión inválido");
      const role = payload.role;
      const resolvedTenant = payload.tenant_id;

      setAuth(data.access_token, resolvedTenant, emailVal, role);
      scheduleProactiveRefresh(data.access_token);  // renueva ~60s antes de vencer
      // max-age alineado al refresh_token del backend (30 días) — sin él son
      // cookies de sesión y el middleware pierde el rol al reabrir el navegador.
      const maxAge = 60 * 60 * 24 * 30;
      document.cookie = `ia_role=${role}; path=/; max-age=${maxAge}; SameSite=strict`;
      document.cookie = `ia_tenant=${resolvedTenant}; path=/; max-age=${maxAge}; SameSite=strict`;

      // Navegación completa por el mismo motivo que en login/page.tsx: el
      // router del cliente puede tener cacheado el redirect de sesión vencida
      // y un push rebota en silencio (ruedita infinita).
      if (role === "super_admin") window.location.assign("/superadmin");
      else setError("Esta página es solo para super administradores.");
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      setError(typeof detail === "string" ? detail : "Credenciales incorrectas.");
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Si el estado quedó atrás del DOM (autofill sin eventos), el DOM manda.
    const emailVal = fieldValue("email", email);
    const pwdVal   = fieldValue("password", password);
    if (emailVal !== email)  setEmail(emailVal);
    if (pwdVal !== password) setPassword(pwdVal);
    await submitCredentials(emailVal, pwdVal);
  };

  // Rescate de la ventana pre-hidratación (esta página va SSR completa en prod):
  // reenvía el submit que el script del layout (auth) tragó antes de que React
  // montara. El DOM → estado lo hace useAutofillSync de arriba.
  useEffect(() => {
    const w = window as unknown as { __iaHydrated?: boolean; __iaPendingSubmit?: boolean };
    w.__iaHydrated = true;
    if (w.__iaPendingSubmit) {
      w.__iaPendingSubmit = false;
      const emailDom = domFieldValue("email");
      const pwdDom = domFieldValue("password");
      // Con campos vacíos igual se envía: el backend responde 401 y el usuario
      // ve un error, en vez de un click que se perdió en silencio.
      void submitCredentials(emailDom, pwdDom);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
