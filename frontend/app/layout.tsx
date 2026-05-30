import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";
import { Toaster } from "@/components/ui/toast";
import { BRANDING_PRELOAD_SCRIPT } from "./branding-preload";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Intellix",
  description: "Plataforma de conocimiento institucional con IA",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" suppressHydrationWarning>
      <head>
        {/* Aplica el branding del tenant ANTES del primer paint para evitar
            cualquier flash al refrescar. Lee localStorage sincronicamente y
            setea las CSS vars en <html>. Si no hay cache o estamos en /login,
            no toca nada y queda el branding generico. */}
        <script dangerouslySetInnerHTML={{ __html: BRANDING_PRELOAD_SCRIPT }} />
      </head>
      <body className={inter.className}>
        <Providers>
          {children}
          <Toaster />
        </Providers>
      </body>
    </html>
  );
}
