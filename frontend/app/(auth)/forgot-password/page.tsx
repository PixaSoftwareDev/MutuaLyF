import { redirect } from "next/navigation";

// El flujo de "olvidé mi contraseña" ahora vive como un paso dentro del login
// (misma shell/diseño + animación de transición). Esta ruta se mantiene por
// compatibilidad con enlaces existentes y redirige al paso correspondiente.
export default function ForgotPasswordPage() {
  redirect("/login?forgot=1");
}
