"use client";

import { useState } from "react";
import Link from "next/link";
import { Loader2, Mail, ArrowLeft, CheckCircle2 } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthShell, brandBtnStyle } from "@/components/auth/auth-shell";

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
    <AuthShell>
      {sent ? (
        <div className="text-center space-y-3">
          <CheckCircle2 className="h-12 w-12 text-success mx-auto" />
          <h1 className="text-2xl lg:text-[26px] font-semibold tracking-tight text-slate-900">Revisá tu correo</h1>
          <p className="text-[14px] lg:text-[15px] text-slate-500 leading-relaxed">
            Si ese email tiene una cuenta, te enviamos un enlace para restablecer tu contraseña. Vence en 1 hora.
          </p>
          <div className="pt-2">
            <Link href="/login" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 transition-colors">
              <ArrowLeft className="h-4 w-4" /> Volver al inicio
            </Link>
          </div>
        </div>
      ) : (
        <>
          <div className="text-center space-y-2 mb-7 lg:mb-8">
            <h1 className="text-2xl lg:text-[26px] font-semibold tracking-tight text-slate-900">
              ¿Olvidaste tu contraseña?
            </h1>
            <p className="text-[14px] lg:text-[15px] text-slate-500 leading-relaxed">
              Ingresá tu email y te enviamos un enlace para crear una nueva.
            </p>
          </div>
          <form onSubmit={submit} className="space-y-4 lg:space-y-5 xl:space-y-6" noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="email" className="text-[13px] font-medium text-slate-700">Email</Label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 pointer-events-none z-10" />
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="tu@email.com"
                  className="h-11 lg:h-12 xl:h-[52px] pl-9 text-[15px] focus-visible:ring-2 focus-visible:ring-indigo-500/30"
                  autoFocus
                  aria-label="Email"
                />
              </div>
            </div>
            <Button
              type="submit"
              className="w-full h-11 lg:h-12 xl:h-[52px] font-medium text-[15px] shadow-md hover:shadow-lg transition-shadow border-0"
              style={brandBtnStyle}
              disabled={loading || !email.trim()}
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Enviar enlace"}
            </Button>
          </form>
          <div className="text-center mt-6">
            <Link href="/login" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 transition-colors">
              <ArrowLeft className="h-4 w-4" /> Volver al inicio
            </Link>
          </div>
        </>
      )}
    </AuthShell>
  );
}
