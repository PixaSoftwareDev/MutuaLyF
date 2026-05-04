"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, CheckCircle, XCircle } from "lucide-react";
import { useAuthStore } from "@/lib/store";
import { Button } from "@/components/ui/button";
import Link from "next/link";

const SSO_ERROR_MESSAGES: Record<string, string> = {
  invalid_state:         "El enlace de inicio de sesión expiró. Intentá de nuevo.",
  token_exchange_failed: "No se pudo completar la autenticación con el proveedor.",
  userinfo_failed:       "No se pudo obtener la información de tu cuenta.",
  no_email:              "Tu cuenta no tiene un email asociado verificado.",
  email_not_verified:    "El email de tu cuenta no está verificado.",
  provision_failed:      "Ocurrió un error al configurar tu cuenta.",
};

export default function SsoCallbackPage() {
  const router = useRouter();
  const params = useSearchParams();
  const { setAuth } = useAuthStore();
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    const token    = params.get("token");
    const tenantId = params.get("tenant_id");
    const email    = params.get("email");
    const role     = params.get("role");

    if (!token || !tenantId || !email) {
      setStatus("error");
      setErrorMsg("Respuesta del proveedor incompleta. Intentá de nuevo.");
      return;
    }

    // Store JWT and user info
    setAuth(token, tenantId, email, role ?? "user");

    // Clean sensitive params from URL before redirecting
    if (typeof window !== "undefined") {
      window.history.replaceState({}, "", "/auth/sso-callback");
    }

    setStatus("success");
    setTimeout(() => router.push("/dashboard"), 800);
  }, [params, setAuth, router]);

  if (status === "loading" || status === "success") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100">
        <div className="text-center space-y-4">
          {status === "success" ? (
            <CheckCircle className="h-12 w-12 text-green-500 mx-auto" />
          ) : (
            <Loader2 className="h-12 w-12 text-primary mx-auto animate-spin" />
          )}
          <p className="text-muted-foreground text-sm">
            {status === "success" ? "¡Sesión iniciada! Redirigiendo..." : "Completando inicio de sesión…"}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100 p-4">
      <div className="text-center space-y-4 max-w-sm">
        <XCircle className="h-12 w-12 text-destructive mx-auto" />
        <h1 className="text-xl font-semibold">Error de autenticación</h1>
        <p className="text-muted-foreground text-sm">{errorMsg}</p>
        <Button asChild>
          <Link href="/login">Volver al login</Link>
        </Button>
      </div>
    </div>
  );
}
