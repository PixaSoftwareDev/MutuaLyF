"use client";

import Image from "next/image";

// Paleta de marca Intellix — espejo del login para que las pantallas de auth
// (login, olvidé contraseña, restablecer) compartan exactamente el mismo fondo.
const PLATFORM_NAME = "Intellix";
const BRAND_CYAN   = "#4FC3F7";
const BRAND_INDIGO = "#5B5BFF";
const BRAND_VIOLET = "#7A2DFF";

export const BRAND_GRADIENT = `linear-gradient(135deg, ${BRAND_CYAN} 0%, ${BRAND_INDIGO} 50%, ${BRAND_VIOLET} 100%)`;
export const brandBtnStyle: React.CSSProperties = { backgroundImage: BRAND_GRADIENT, color: "#fff" };

/**
 * Contenedor visual compartido por las pantallas de autenticación.
 * Reproduce el fondo del login: slate-50 + mesh de marca + grid sutil,
 * wordmark Intellix arriba y card blanco centrado.
 */
export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen relative flex flex-col items-center justify-center p-4 sm:p-6 overflow-hidden bg-slate-50">
      {/* Gradient mesh de marca — cyan / indigo / violet en puntos opuestos. */}
      <div
        className="absolute inset-0 pointer-events-none"
        aria-hidden="true"
        style={{
          backgroundImage: `
            radial-gradient(circle at 12% 18%, ${BRAND_CYAN}26 0%, transparent 42%),
            radial-gradient(circle at 88% 12%, ${BRAND_VIOLET}20 0%, transparent 45%),
            radial-gradient(circle at 50% 95%, ${BRAND_INDIGO}1f 0%, transparent 50%),
            radial-gradient(circle at 92% 88%, ${BRAND_CYAN}18 0%, transparent 40%)
          `,
        }}
      />

      {/* Grid pattern ultra-sutil — textura tech que se desvanece hacia los bordes. */}
      <div
        className="absolute inset-0 pointer-events-none opacity-[0.04]"
        aria-hidden="true"
        style={{
          backgroundImage: `linear-gradient(to right, #000 1px, transparent 1px),
                            linear-gradient(to bottom, #000 1px, transparent 1px)`,
          backgroundSize: "32px 32px",
          maskImage: "radial-gradient(ellipse 80% 80% at center, black 30%, transparent 80%)",
          WebkitMaskImage: "radial-gradient(ellipse 80% 80% at center, black 30%, transparent 80%)",
        }}
      />

      {/* Wordmark oficial. */}
      <div className="relative z-10 mb-8 lg:mb-10">
        <Image
          src="/brand/intellix-wordmark-white.png"
          alt={PLATFORM_NAME}
          width={520}
          height={170}
          priority
          className="w-[170px] sm:w-[200px] lg:w-[220px] xl:w-[240px] h-auto"
        />
      </div>

      {/* Card. */}
      <main className="relative z-10 w-full max-w-[400px] sm:max-w-[420px] lg:max-w-[440px]">
        <div className="relative bg-white rounded-2xl shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_rgba(15,23,42,0.06),0_24px_64px_rgba(15,23,42,0.08)] border border-slate-200/70 overflow-hidden">
          <div className="px-6 py-7 sm:px-8 sm:py-9 lg:px-9 lg:py-11 xl:py-12">
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}
