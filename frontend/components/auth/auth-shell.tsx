"use client";

import Image from "next/image";

// Paleta de marca Intellix — espejo del login para que las pantallas de auth
// (olvidé contraseña, restablecer/bienvenida) compartan exactamente el mismo
// lenguaje visual. Este shell REPLICA el layout del login rediseñado: fondo
// premium claro con volumen, logo mark+wordmark arriba a la izquierda, card
// blanca centrada y pie institucional.
const PLATFORM_NAME = "Intellix";
const BRAND_CYAN   = "#4FC3F7";
const BRAND_INDIGO = "#5B5BFF";
const BRAND_VIOLET = "#7A2DFF";

export const BRAND_GRADIENT = `linear-gradient(135deg, ${BRAND_CYAN} 0%, ${BRAND_INDIGO} 50%, ${BRAND_VIOLET} 100%)`;
export const brandBtnStyle: React.CSSProperties = { backgroundImage: BRAND_GRADIENT, color: "#fff" };

export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-slate-50 p-4 sm:p-6">
      {/* Fondo premium claro con volumen — mismas capas que el login. */}
      <div
        className="pointer-events-none absolute inset-0"
        aria-hidden="true"
        style={{ background: "radial-gradient(125% 95% at 50% -6%, #ffffff 0%, #f2f4f8 52%, #e8ecf2 100%)" }}
      />
      <div className="pointer-events-none absolute -left-48 -top-44 h-[44rem] w-[44rem] rounded-full blur-[160px]" aria-hidden="true" style={{ background: BRAND_CYAN, opacity: 0.08 }} />
      <div className="pointer-events-none absolute -right-48 -top-40 h-[42rem] w-[42rem] rounded-full blur-[160px]" aria-hidden="true" style={{ background: BRAND_VIOLET, opacity: 0.07 }} />
      <div className="pointer-events-none absolute left-1/2 top-[46%] h-[600px] w-[860px] -translate-x-1/2 -translate-y-1/2 rounded-[50%] blur-[150px]" aria-hidden="true" style={{ background: BRAND_INDIGO, opacity: 0.05 }} />
      <div
        className="pointer-events-none absolute inset-0"
        aria-hidden="true"
        style={{ background: "radial-gradient(118% 118% at 50% 42%, transparent 55%, rgba(15,23,42,0.06) 100%)" }}
      />
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.09] mix-blend-multiply"
        aria-hidden="true"
        style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")" }}
      />

      {/* Logo: ícono + wordmark (versión oscura), arriba a la izquierda. */}
      <div className="absolute left-10 top-11 z-20 flex items-center gap-2.5 sm:left-16 sm:top-14 lg:left-20 lg:top-16">
        <Image
          src="/brand/intellix-mark.png"
          alt=""
          width={160}
          height={160}
          priority
          className="h-8 w-8 sm:h-9 sm:w-9"
        />
        <Image
          src="/brand/intellix-wordmark.png"
          alt={PLATFORM_NAME}
          width={520}
          height={170}
          priority
          className="h-auto w-[118px] sm:w-[132px]"
        />
      </div>

      {/* Card centrada única — misma sombra y proporciones que el login. */}
      <main className="relative z-10 w-full max-w-[420px]">
        <div className="relative overflow-hidden rounded-2xl border border-slate-200/70 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04),0_10px_30px_rgba(15,23,42,0.06),0_30px_70px_rgba(15,23,42,0.09)]">
          <div className="px-6 py-11 sm:px-8 sm:py-14">
            {children}
          </div>
        </div>
        <p className="mt-4 text-center text-[11px] text-slate-400">
          ¿Problemas para ingresar?{" "}
          <span className="font-medium text-slate-600">Contactá al administrador de tu organización.</span>
        </p>
      </main>

      <footer className="relative z-10 mt-9 text-center text-[11px] text-slate-400">
        © {new Date().getFullYear()} {PLATFORM_NAME} · Plataforma de conocimiento institucional
      </footer>
    </div>
  );
}
