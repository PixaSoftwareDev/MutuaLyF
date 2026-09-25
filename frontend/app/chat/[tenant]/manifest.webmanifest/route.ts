import { NextRequest, NextResponse } from "next/server";

// Manifest del canal "Chat por link", uno por tenant, para que "Agregar a la
// pantalla de inicio" instale el chat con el nombre, color e ícono de la
// organización y lo abra como app (standalone), sin barras del navegador.
// Los datos vienen por query desde la página (que ya tiene el branding); acá
// solo se validan: nada de HTML, colores solo #rrggbb, íconos solo del mismo
// origen o https.
export const dynamic = "force-dynamic";

const HEX = /^#[0-9a-fA-F]{6}$/;

export function GET(req: NextRequest, { params }: { params: { tenant: string } }) {
  const tenant = params.tenant.replace(/[^a-z0-9_-]/gi, "").slice(0, 64);
  const q = req.nextUrl.searchParams;
  const name = (q.get("name") || "Chat").replace(/[<>]/g, "").trim().slice(0, 60) || "Chat";
  const colorRaw = q.get("color") || "";
  const color = HEX.test(colorRaw) ? colorRaw : "#6d28d9";
  const icon = q.get("icon") || "";
  const iconOk = icon.startsWith("/") || /^https:\/\//i.test(icon);
  const icons = [
    { src: iconOk ? icon : "/Logo.png", sizes: "any", type: "image/png", purpose: "any" },
  ];
  const manifest = {
    name,
    short_name: name.slice(0, 12),
    start_url: `/chat/${tenant}`,
    scope: `/chat/${tenant}`,
    display: "standalone",
    orientation: "portrait",
    background_color: "#ffffff",
    theme_color: color,
    icons,
  };
  return NextResponse.json(manifest, {
    headers: {
      "Content-Type": "application/manifest+json; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
