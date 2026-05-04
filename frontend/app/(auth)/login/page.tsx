"use client";

import { useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { useAuthStore } from "@/lib/store";
import { api } from "@/lib/api";
import { Loader2, AlertTriangle } from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "";

const SSO_ERROR_MESSAGES: Record<string, string> = {
  invalid_state:         "El enlace de inicio de sesión expiró. Intentá de nuevo.",
  token_exchange_failed: "Error al comunicarse con el proveedor. Intentá de nuevo.",
  userinfo_failed:       "No se pudo obtener tu información de cuenta.",
  no_email:              "Tu cuenta no tiene un email verificado.",
  email_not_verified:    "El email de tu cuenta no está verificado en el proveedor.",
  provision_failed:      "Error al configurar tu cuenta. Contactá al administrador.",
};

export default function LoginPage() {
  const router = useRouter();
  const params = useSearchParams();
  const { setAuth } = useAuthStore();

  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [tenantId, setTenantId] = useState("");
  const [error, setError]       = useState<string | null>(null);
  const [loading, setLoading]   = useState(false);
  const [providers, setProviders] = useState({ google: false, azure: false });

  // Check SSO error from redirect
  useEffect(() => {
    const ssoError = params.get("sso_error");
    if (ssoError) {
      setError(SSO_ERROR_MESSAGES[ssoError] ?? "Error en el inicio de sesión con SSO.");
    }
  }, [params]);

  // Load available SSO providers
  useEffect(() => {
    fetch(`${API_URL}/api/v1/auth/sso/providers`)
      .then((r) => r.json())
      .then((data) => setProviders(data))
      .catch(() => {});
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const data = await api.auth.login(email, password, tenantId);
      const payload = JSON.parse(atob(data.access_token.split(".")[1]));
      setAuth(data.access_token, tenantId, email, payload.role ?? "user");
      router.push("/dashboard");
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      setError(typeof detail === "string" ? detail : "Credenciales incorrectas. Verificá email, contraseña y organización.");
    } finally {
      setLoading(false);
    }
  };

  const handleSso = (provider: "google" | "azure") => {
    if (!tenantId.trim()) {
      setError("Ingresá el nombre de tu organización antes de usar SSO.");
      return;
    }
    setError(null);
    window.location.href = `${API_URL}/api/v1/auth/sso/${provider}?tenant_id=${encodeURIComponent(tenantId)}`;
  };

  const hasSso = providers.google || providers.azure;

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
          <CardDescription>Accedé a tu plataforma de conocimiento institucional</CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {/* Tenant field — always visible, needed for both SSO and form */}
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

          {/* SSO buttons */}
          {hasSso && (
            <>
              <div className="space-y-2">
                {providers.google && (
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full gap-2"
                    onClick={() => handleSso("google")}
                  >
                    <GoogleIcon />
                    Continuar con Google
                  </Button>
                )}
                {providers.azure && (
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full gap-2"
                    onClick={() => handleSso("azure")}
                  >
                    <MicrosoftIcon />
                    Continuar con Microsoft
                  </Button>
                )}
              </div>

              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <Separator className="w-full" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-background px-2 text-muted-foreground">o con email</span>
                </div>
              </div>
            </>
          )}

          {/* Email/password form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="admin@empresa.com"
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
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
    </svg>
  );
}

function MicrosoftIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 23 23">
      <rect x="1"  y="1"  width="10" height="10" fill="#f25022"/>
      <rect x="12" y="1"  width="10" height="10" fill="#7fba00"/>
      <rect x="1"  y="12" width="10" height="10" fill="#00a4ef"/>
      <rect x="12" y="12" width="10" height="10" fill="#ffb900"/>
    </svg>
  );
}
