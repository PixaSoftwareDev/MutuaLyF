import { ChatScreen } from "@/components/chat/chat-screen";

// Ruta corta del canal "Chat por link": app.intellix.com.ar/c/mutualyf.
// Es una ruta REAL (no un rewrite) para que la página reciba el tenant aunque
// la URL del navegador no tenga query. /chat?tenant= sigue por compatibilidad.
// Pública en middleware.ts (prefijo "/c/").
export default function ChatByLinkPage({ params }: { params: { tenant: string } }) {
  return <ChatScreen tenant={decodeURIComponent(params.tenant)} />;
}
