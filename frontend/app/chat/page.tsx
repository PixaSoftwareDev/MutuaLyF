import { ChatScreen } from "@/components/chat/chat-screen";

// /chat?tenant=X (compat y tester del panel con &test=1). La ruta del canal
// "Chat por link" es /chat/[tenant].
export default function ChatPage() {
  return <ChatScreen />;
}
