"use client";

import { useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthShell, brandBtnStyle } from "@/components/auth/auth-shell";

function ResetInner() {
  const params = useSearchParams();
  const router = useRouter();
  const token  = params.get("token") || "";

  const [pwd, setPwd]       = useState("");
  const [pwd2, setPwd2]     = useState("");
  const [err, setErr]       = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone]     = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (pwd.length < 8) { setErr("La contraseña debe tener al menos 8 caracteres."); return; }
    if (pwd !== pwd2)   { setErr("Las contraseñas no coinciden."); return; }
    setLoading(true);
    try {
      await api.auth.resetPassword(token, pwd);
      setDone(true);
      setTimeout(() => router.push("/login"), 2500);
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setErr(typeof detail === "string" ? detail : "No se pudo restablecer. Pedí un enlace nuevo.");
      setLoading(false);
    }
  };

  if (!token) return (
    <div className="text-center space-y-3">
      <AlertCircle className="h-12 w-12 text-warning mx-auto" />
      <h1 className="text-2xl lg:text-[26px] font-semibold tracking-tight text-slate-900">Enlace inválido</h1>
      <p className="text-[14px] lg:text-[15px] text-slate-500 leading-relaxed">El enlace no es válido o está incompleto. Pedí uno nuevo.</p>
      <div className="pt-2">
        <Link href="/forgot-password" className="inline-flex items-center text-sm text-slate-500 hover:text-slate-800 underline transition-colors">
          Pedir un enlace nuevo
        </Link>
      </div>
    </div>
  );

  if (done) return (
    <div className="text-center space-y-3">
      <CheckCircle2 className="h-12 w-12 text-success mx-auto" />
      <h1 className="text-2xl lg:text-[26px] font-semibold tracking-tight text-slate-900">¡Contraseña actualizada!</h1>
      <p className="text-[14px] lg:text-[15px] text-slate-500">Te llevamos al inicio de sesión…</p>
    </div>
  );

  return (
    <>
      <div className="text-center space-y-2 mb-7 lg:mb-8">
        <h1 className="text-2xl lg:text-[26px] font-semibold tracking-tight text-slate-900">Nueva contraseña</h1>
        <p className="text-[14px] lg:text-[15px] text-slate-500 leading-relaxed">Elegí una contraseña nueva para tu cuenta.</p>
      </div>
      <form onSubmit={submit} className="space-y-4 lg:space-y-5 xl:space-y-6" noValidate>
        <div className="space-y-1.5">
          <Label htmlFor="new-pwd" className="text-[13px] font-medium text-slate-700">Contraseña nueva</Label>
          <Input
            id="new-pwd"
            type="password"
            value={pwd}
            onChange={(e) => { setPwd(e.target.value); if (err) setErr(null); }}
            placeholder="Mínimo 8 caracteres"
            autoComplete="new-password"
            autoFocus
            className="h-11 lg:h-12 xl:h-[52px] text-[15px] focus-visible:ring-2 focus-visible:ring-indigo-500/30"
            aria-label="Nueva contraseña"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="confirm-pwd" className="text-[13px] font-medium text-slate-700">Repetir contraseña</Label>
          <Input
            id="confirm-pwd"
            type="password"
            value={pwd2}
            onChange={(e) => { setPwd2(e.target.value); if (err) setErr(null); }}
            placeholder="Repetí la contraseña"
            autoComplete="new-password"
            className="h-11 lg:h-12 xl:h-[52px] text-[15px] focus-visible:ring-2 focus-visible:ring-indigo-500/30"
            aria-label="Repetir contraseña"
          />
        </div>
        {err && (
          <div className="flex items-start gap-2 rounded-lg bg-destructive/10 border border-destructive/20 px-3 py-2.5 text-[13px] text-destructive">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{err}</span>
          </div>
        )}
        <Button
          type="submit"
          className="w-full h-11 lg:h-12 xl:h-[52px] font-medium text-[15px] shadow-md hover:shadow-lg transition-shadow border-0"
          style={brandBtnStyle}
          disabled={loading}
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Guardar contraseña"}
        </Button>
      </form>
    </>
  );
}

export default function ResetPasswordPage() {
  return (
    <AuthShell>
      <Suspense fallback={<div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-slate-400" /></div>}>
        <ResetInner />
      </Suspense>
    </AuthShell>
  );
}
