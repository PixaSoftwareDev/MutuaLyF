"use client";

import { useState } from "react";
import Link from "next/link";
import { Loader2, Mail, ArrowLeft, CheckCircle2 } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function ForgotPasswordPage() {
  const [email, setEmail]     = useState("");
  const [sent, setSent]       = useState(false);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || loading) return;
    setLoading(true);
    try {
      await api.auth.forgotPassword(email.trim());
    } catch {
      // Respuesta uniforme (anti-enumeración): mostramos "enviado" pase lo que pase.
    }
    setSent(true);
    setLoading(false);
  };

  return (
    <div className="min-h-[100dvh] flex items-center justify-center bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 p-4">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-xl p-8">
        {sent ? (
          <div className="text-center space-y-3">
            <CheckCircle2 className="h-12 w-12 text-emerald-500 mx-auto" />
            <h1 className="text-lg font-semibold text-slate-900">Revisá tu correo</h1>
            <p className="text-sm text-slate-500 leading-relaxed">
              Si ese email tiene una cuenta, te enviamos un enlace para restablecer tu contraseña. Vence en 1 hora.
            </p>
            <Link href="/login" className="inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900 mt-2">
              <ArrowLeft className="h-4 w-4" /> Volver al inicio
            </Link>
          </div>
        ) : (
          <>
            <h1 className="text-lg font-semibold text-slate-900 mb-1">¿Olvidaste tu contraseña?</h1>
            <p className="text-sm text-slate-500 mb-5">Ingresá tu email y te enviamos un enlace para crear una nueva.</p>
            <form onSubmit={submit} className="space-y-4" noValidate>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 pointer-events-none" />
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="tu@email.com"
                  className="pl-9"
                  autoFocus
                  aria-label="Email"
                />
              </div>
              <Button type="submit" className="w-full" disabled={loading || !email.trim()}>
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Enviar enlace"}
              </Button>
            </form>
            <Link href="/login" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 mt-5">
              <ArrowLeft className="h-4 w-4" /> Volver al inicio
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
