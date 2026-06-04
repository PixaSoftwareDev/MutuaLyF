"use client";

import { useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
      <AlertCircle className="h-12 w-12 text-amber-500 mx-auto" />
      <h1 className="text-lg font-semibold text-slate-900">Enlace inválido</h1>
      <p className="text-sm text-slate-500 leading-relaxed">El enlace no es válido o está incompleto. Pedí uno nuevo.</p>
      <Link href="/forgot-password" className="inline-flex items-center text-sm text-slate-600 hover:text-slate-900 underline">
        Pedir un enlace nuevo
      </Link>
    </div>
  );

  if (done) return (
    <div className="text-center space-y-3">
      <CheckCircle2 className="h-12 w-12 text-emerald-500 mx-auto" />
      <h1 className="text-lg font-semibold text-slate-900">¡Contraseña actualizada!</h1>
      <p className="text-sm text-slate-500">Te llevamos al inicio de sesión…</p>
    </div>
  );

  return (
    <>
      <h1 className="text-lg font-semibold text-slate-900 mb-1">Nueva contraseña</h1>
      <p className="text-sm text-slate-500 mb-5">Elegí una contraseña nueva para tu cuenta.</p>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Input type="password" value={pwd} onChange={(e) => { setPwd(e.target.value); if (err) setErr(null); }}
          placeholder="Nueva contraseña" autoComplete="new-password" autoFocus aria-label="Nueva contraseña" />
        <Input type="password" value={pwd2} onChange={(e) => { setPwd2(e.target.value); if (err) setErr(null); }}
          placeholder="Repetir contraseña" autoComplete="new-password" aria-label="Repetir contraseña" />
        {err && <p className="text-xs text-red-600">{err}</p>}
        <Button type="submit" className="w-full" disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Guardar contraseña"}
        </Button>
      </form>
    </>
  );
}

export default function ResetPasswordPage() {
  return (
    <div className="min-h-[100dvh] flex items-center justify-center bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 p-4">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-xl p-8">
        <Suspense fallback={<div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-slate-400" /></div>}>
          <ResetInner />
        </Suspense>
      </div>
    </div>
  );
}
