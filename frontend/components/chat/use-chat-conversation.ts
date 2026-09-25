"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { ChatProtocol, type ChatProtocolOptions, type ChatState } from "@/lib/chat-protocol";

/**
 * Puente React sobre el protocolo de conversación (lib/chat-protocol.ts).
 * Crea UNA instancia por (tenant, sesión) y expone su estado con
 * useSyncExternalStore; el resto de la pantalla es puro render.
 */
export function useChatConversation(opts: ChatProtocolOptions | null): { chat: ChatProtocol | null; state: ChatState | null } {
  // Se recrea solo si cambia la identidad de la conversación (tenant/sesión/canal).
  const chat = useMemo(
    () => (opts ? new ChatProtocol(opts) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [opts?.tenantId, opts?.sessionId, opts?.channel, opts?.apiBase],
  );

  const state = useSyncExternalStore(
    (fn) => (chat ? chat.subscribe(() => fn()) : () => {}),
    () => (chat ? chat.getState() : null),
    () => (chat ? chat.getState() : null),
  );

  useEffect(() => {
    if (!chat) return;
    chat.loadSectors();
    chat.start();
    return () => chat.stop();
  }, [chat]);

  return { chat, state };
}
