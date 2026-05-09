/**
 * Zustand stores for client-side state.
 * Server state (queries, documents) is handled by React Query.
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

// ── Auth store ─────────────────────────────────────────────────────────────────

interface AuthState {
  accessToken: string | null;
  tenantId: string | null;
  userEmail: string | null;
  userRole: string | null;
  isAuthenticated: boolean;
  _hasHydrated: boolean;
  setAuth: (token: string, tenantId: string, email: string, role: string) => void;
  clearAuth: () => void;
  setHasHydrated: (v: boolean) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      accessToken: null,
      tenantId: null,
      userEmail: null,
      userRole: null,
      isAuthenticated: false,
      _hasHydrated: false,

      setAuth: (token, tenantId, email, role) => {
        if (typeof window !== "undefined") {
          localStorage.setItem("access_token", token);
          localStorage.setItem("tenant_id", tenantId);
        }
        set({ accessToken: token, tenantId, userEmail: email, userRole: role, isAuthenticated: true });
      },

      clearAuth: () => {
        if (typeof window !== "undefined") {
          localStorage.removeItem("access_token");
          localStorage.removeItem("tenant_id");
          // Clear edge-middleware cookies
          document.cookie = "ia_role=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT";
          document.cookie = "ia_tenant=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT";
        }
        set({ accessToken: null, tenantId: null, userEmail: null, userRole: null, isAuthenticated: false });
      },

      setHasHydrated: (v) => set({ _hasHydrated: v }),
    }),
    {
      name: "ia-auth",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        accessToken: state.accessToken,
        tenantId: state.tenantId,
        userEmail: state.userEmail,
        userRole: state.userRole,
        isAuthenticated: state.isAuthenticated,
      }),
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
      },
    }
  )
);

// ── Chat store ─────────────────────────────────────────────────────────────────

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: Array<{
    chunk_id: string;
    document_title: string;
    content_excerpt: string;
    score: number;
  }>;
  intent_label?: string | null;
  from_cache?: boolean;
  latency_ms?: number;
  timestamp: number;
  isLoading?: boolean;
}

interface ChatState {
  messages: ChatMessage[];
  isTyping: boolean;
  addMessage: (msg: Omit<ChatMessage, "id" | "timestamp">) => string;
  updateMessage: (id: string, updates: Partial<ChatMessage>) => void;
  clearMessages: () => void;
  setTyping: (v: boolean) => void;
}

let _msgCounter = 0;

export const useChatStore = create<ChatState>()((set) => ({
  messages: [],
  isTyping: false,

  addMessage: (msg) => {
    const id = `msg-${Date.now()}-${++_msgCounter}`;
    set((state) => ({
      messages: [...state.messages, { ...msg, id, timestamp: Date.now() }],
    }));
    return id;
  },

  updateMessage: (id, updates) => {
    set((state) => ({
      messages: state.messages.map((m) => (m.id === id ? { ...m, ...updates } : m)),
    }));
  },

  clearMessages: () => set({ messages: [] }),
  setTyping: (v) => set({ isTyping: v }),
}));

// ── UI store ───────────────────────────────────────────────────────────────────

interface UIState {
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  setSidebarOpen: (v: boolean) => void;
}

export const useUIStore = create<UIState>()((set) => ({
  sidebarOpen: true,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarOpen: (v) => set({ sidebarOpen: v }),
}));
