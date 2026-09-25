import { ChatScreen } from "@/components/chat/chat-screen";

// Canal "Chat por link": app.intellix.com.ar/chat/mutualyf. Es el link que el
// cliente difunde (mensajes, redes, QR) — legible y sin vencimiento: no lleva
// token, la página pide uno efímero al abrirse. Ruta REAL (no un rewrite) para
// que la página reciba el tenant aunque la URL no tenga query. /chat?tenant=
// sigue por compatibilidad y para el tester del panel. Pública en middleware.ts.
export default function ChatByLinkPage({ params }: { params: { tenant: string } }) {
  return <ChatScreen tenant={decodeURIComponent(params.tenant)} />;
}
