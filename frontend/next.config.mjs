/** @type {import('next').NextConfig} */

// Proxy de desarrollo local: si DEV_API_PROXY está seteado (solo en tu máquina),
// Next reenvía /api/* al backend remoto indicado, server-side. Así podés correr
// `next dev` local con hot-reload instantáneo pegándole a la API de staging SIN
// problemas de CORS ni cookies cross-site (para el browser es same-origin).
// En prod/staging la variable NO existe → rewrites vacío → comportamiento idéntico
// al de siempre. No afecta el build de producción.
const DEV_API_PROXY = process.env.DEV_API_PROXY || "";

const nextConfig = {
  output: "standalone",
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || "",
  },
  ...(DEV_API_PROXY
    ? {
        async rewrites() {
          return [
            { source: "/api/:path*", destination: `${DEV_API_PROXY}/api/:path*` },
          ];
        },
      }
    : {}),
};

export default nextConfig;
