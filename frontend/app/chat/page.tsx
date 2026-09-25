import { ChatScreen } from "@/components/chat/chat-screen";

// /chat?tenant=X (compat y tester del panel con &test=1). La ruta corta del
// canal "Chat por link" es /c/[tenant].
export default function ChatPage() {
  return <ChatScreen />;
}
