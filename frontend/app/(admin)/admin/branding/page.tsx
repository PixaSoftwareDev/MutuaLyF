import { redirect } from "next/navigation";

// Branding ahora vive como pestaña "Apariencia" dentro de Configuración.
// Mantenemos la ruta vieja para no romper links guardados.
export default function BrandingRedirect() {
  redirect("/admin/settings?tab=apariencia");
}
