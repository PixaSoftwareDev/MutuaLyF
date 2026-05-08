/**
 * Typed API client for the IA Inteligent backend.
 * All requests include the Authorization header from the auth store.
 */

import axios, { AxiosError, type AxiosInstance } from "axios";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "";

export const apiClient: AxiosInstance = axios.create({
  baseURL: `${API_URL}/api/v1`,
  headers: { "Content-Type": "application/json" },
  timeout: 60_000,
});

// Attach JWT from localStorage on every request
apiClient.interceptors.request.use((config) => {
  if (typeof window !== "undefined") {
    const token = localStorage.getItem("access_token");
    if (token) config.headers.Authorization = `Bearer ${token}`;
    const tenantId = localStorage.getItem("tenant_id");
    if (tenantId) config.headers["X-Tenant-ID"] = tenantId;
  }
  return config;
});

// Redirect to /login on 401
apiClient.interceptors.response.use(
  (res) => res,
  (err: AxiosError) => {
    if (err.response?.status === 401 && typeof window !== "undefined") {
      localStorage.removeItem("access_token");
      window.location.href = "/login";
    }
    return Promise.reject(err);
  }
);

// ── Types ──────────────────────────────────────────────────────────────────────

export interface LoginResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export interface SourceChunk {
  chunk_id: string;
  document_id: string;
  document_title: string;
  content_excerpt: string;
  score: number;
}

export interface QueryResponse {
  answer: string;
  sources: SourceChunk[];
  intent_label: string | null;
  intent_confidence: number | null;
  from_cache: boolean;
  latency_ms: number;
}

export interface DocumentResponse {
  id: string;
  title: string;
  status: "pending" | "processing" | "ready" | "failed";
  chunk_count: number;
  quality_gate_status: "pending" | "passed" | "skipped";
  created_at: string;
  updated_at: string;
}

export interface DocumentIngestResponse {
  document_id: string;
  status: string;
  message: string;
}

export interface ChunkResponse {
  id: string;
  chunk_index: number;
  total_chunks: number;
  text: string;
  quality_gate_status: "pending" | "passed" | "skipped";
}

export interface Intention {
  id: string;
  label: string;
  description: string | null;
  example_count: number;
  auto_learned_count: number;
  is_active: boolean;
  model_version: string | null;
  queries_7d: number;
  avg_confidence_7d: number;
  created_at: string;
  updated_at: string;
}

export interface PendingIntention {
  id: string;
  label: string;
  query_count: number;
  avg_confidence: number;
  last_seen: string | null;
  auto_learning_blocked_count: number;
}

export interface ClusterQuery {
  id: string;
  text: string;
}

export interface DiscoveredCluster {
  id: string;
  cluster_id: string;
  query_count: number;
  first_seen: string | null;
  last_seen: string | null;
  queries: ClusterQuery[];
  suggested_label: string;
}

export interface IntentionResponse {
  intentions: Intention[];
  pending_review: PendingIntention[];
  discovered_clusters: DiscoveredCluster[];
  total: number;
  pending_total: number;
  clusters_total: number;
}

export interface ConversationRow {
  id: string;
  status: "bot_active" | "handoff_requested" | "human_attending" | "closed";
  afiliado_nombre: string | null;
  afiliado_email: string | null;
  sector_nombre: string | null;
  operator_name: string | null;
  unread_count: number;
  last_message_at: string | null;
  created_at: string;
}

export interface ConversationDetail extends ConversationRow {
  messages: Array<{ id: string; sender_type: string; content: string; created_at: string }>;
}

export interface SectorRow {
  id: string;
  nombre: string;
  descripcion: string | null;
  is_active: boolean;
  operator_count: number;
  open_conversations: number;
}

export interface HandoffConfig {
  id: string;
  inactivity_timeout_minutes: number;
  consecutive_insufficient_count: number;
  frustration_phrases: string[];
  transition_messages: Record<string, string>;
  updated_at: string;
}

export interface WidgetTokenResponse {
  widget_token: string;
  expires_in_days: number;
  tenant_id: string;
}

export interface BotConfig {
  bot_description: string | null;
  bot_scope: string | null;
  min_retrieval_score: number;
}

export interface ChunkDuplicatePair {
  id: string;
  chunk_id_a: string;
  chunk_id_b: string;
  doc_id_a: string;
  doc_id_b: string;
  doc_title_a: string | null;
  doc_title_b: string | null;
  text_a: string;
  text_b: string;
  jaccard_score: number | null;
  cosine_score: number | null;
  status: "pending" | "keep_a" | "keep_b" | "keep_both";
  created_at: string;
}

export interface DuplicatesResponse {
  pairs: ChunkDuplicatePair[];
  total: number;
  pending: number;
}

// ── API functions ──────────────────────────────────────────────────────────────

export const api = {
  auth: {
    login: async (username: string, password: string, tenantId: string): Promise<LoginResponse> => {
      const form = new URLSearchParams();
      form.append("username", username);
      form.append("password", password);
      const { data } = await apiClient.post<LoginResponse>("/auth/login", form, {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Tenant-ID": tenantId,
        },
      });
      return data;
    },
    logout: async () => {
      await apiClient.post("/auth/logout");
      localStorage.removeItem("access_token");
      localStorage.removeItem("tenant_id");
    },
  },

  query: {
    ask: async (question: string, language = "es"): Promise<QueryResponse> => {
      const { data } = await apiClient.post<QueryResponse>("/query", { question, language });
      return data;
    },
  },

  documents: {
    list: async (): Promise<DocumentResponse[]> => {
      const { data } = await apiClient.get<DocumentResponse[]>("/documents");
      return data;
    },
    upload: async (file: File): Promise<DocumentIngestResponse> => {
      const form = new FormData();
      form.append("file", file);
      const { data } = await apiClient.post<DocumentIngestResponse>("/ingest", form, {
        headers: { "Content-Type": "multipart/form-data" },
        timeout: 60_000,
      });
      return data;
    },
    chunks: async (documentId: string): Promise<ChunkResponse[]> => {
      const { data } = await apiClient.get<ChunkResponse[]>(`/documents/${documentId}/chunks`);
      return data;
    },
    delete: async (documentId: string): Promise<void> => {
      await apiClient.delete(`/documents/${documentId}`);
    },
  },

  intentions: {
    list: async (): Promise<IntentionResponse> => {
      const { data } = await apiClient.get<IntentionResponse>("/intentions");
      return data;
    },
    approve: async (intentionId: string) => {
      await apiClient.post(`/intentions/${intentionId}/approve`);
    },
    reject: async (intentionId: string) => {
      await apiClient.post(`/intentions/${intentionId}/reject`);
    },
    toggleActive: async (intentionId: string, isActive: boolean) => {
      await apiClient.patch(`/intentions/${intentionId}`, { is_active: !isActive });
    },
    delete: async (intentionId: string) => {
      await apiClient.delete(`/intentions/${intentionId}`);
    },
    create: async (label: string, description?: string, examples?: string[]) => {
      await apiClient.post("/intentions", { label, description, examples: examples ?? [] });
    },
    approveCluster: async (clusterId: string, label: string) => {
      const { data } = await apiClient.post(`/intentions/cluster/${clusterId}/approve`, { label });
      return data;
    },
    dismissCluster: async (clusterId: string) => {
      await apiClient.post(`/intentions/cluster/${clusterId}/dismiss`);
    },
    removeQueryFromCluster: async (clusterId: string, queryId: string) => {
      await apiClient.delete(`/intentions/cluster/${clusterId}/query/${queryId}`);
    },
    triggerClustering: async () => {
      const { data } = await apiClient.post("/intentions/cluster");
      return data;
    },
    triggerRetrain: async () => {
      const { data } = await apiClient.post("/intentions/retrain");
      return data;
    },
    trainingStatus: async () => {
      const { data } = await apiClient.get("/intentions/training/status");
      return data as { intentions: Array<{ label: string; model_version: string | null; last_accuracy: number | null; example_count: number }> };
    },
  },

  tenants: {
    generateWidgetToken: async (tenantId: string): Promise<WidgetTokenResponse> => {
      const { data } = await apiClient.post<WidgetTokenResponse>(`/tenants/${tenantId}/widget-token`);
      return data;
    },
    getBotConfig: async (tenantId: string): Promise<BotConfig> => {
      const { data } = await apiClient.get<BotConfig>(`/tenants/${tenantId}/bot-config`);
      return data;
    },
    updateBotConfig: async (tenantId: string, payload: Partial<BotConfig>): Promise<BotConfig> => {
      const { data } = await apiClient.patch<BotConfig>(`/tenants/${tenantId}/bot-config`, payload);
      return data;
    },
  },

  operator: {
    listConversations: async (statusFilter?: string, sectorId?: string) => {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status_filter", statusFilter);
      if (sectorId) params.set("sector_id", sectorId);
      const { data } = await apiClient.get(`/operator/conversations?${params}`);
      return data as { sectors: Array<{ sector: { id: string; nombre: string }; conversations: ConversationRow[] }>; total: number };
    },
    getConversation: async (id: string) => {
      const { data } = await apiClient.get(`/operator/conversations/${id}`);
      return data as ConversationDetail;
    },
    accept:   async (id: string)                => { await apiClient.post(`/operator/conversations/${id}/accept`); },
    reply:    async (id: string, content: string) => { await apiClient.post(`/operator/conversations/${id}/reply`, { content }); },
    transfer: async (id: string, sectorId: string, message?: string) => {
      await apiClient.post(`/operator/conversations/${id}/transfer`, { sector_id: sectorId, message });
    },
    close: async (id: string) => { await apiClient.post(`/operator/conversations/${id}/close`); },
  },

  sectors: {
    list: async () => { const { data } = await apiClient.get("/admin/sectors"); return data as SectorRow[]; },
    create: async (nombre: string, descripcion?: string) => {
      await apiClient.post("/admin/sectors", { nombre, descripcion });
    },
    update: async (id: string, nombre: string, descripcion?: string) => {
      await apiClient.patch(`/admin/sectors/${id}`, { nombre, descripcion });
    },
    delete: async (id: string) => { await apiClient.delete(`/admin/sectors/${id}`); },
    getOperatorSectors: async (operatorId: string) => {
      const { data } = await apiClient.get(`/admin/operators/${operatorId}/sectors`);
      return data as Array<{ id: string; nombre: string }>;
    },
    assignOperatorSectors: async (operatorId: string, sectorIds: string[]) => {
      await apiClient.post(`/admin/operators/${operatorId}/sectors`, { sector_ids: sectorIds });
    },
  },

  handoffConfig: {
    get: async () => { const { data } = await apiClient.get("/admin/handoff-config"); return data as HandoffConfig; },
    update: async (payload: Partial<HandoffConfig>) => { await apiClient.patch("/admin/handoff-config", payload); },
  },

  duplicates: {
    list: async () => { const { data } = await apiClient.get<DuplicatesResponse>("/duplicates"); return data; },
    resolve: async (pairId: string, action: "keep_a" | "keep_b" | "keep_both") => {
      await apiClient.post(`/duplicates/${pairId}/resolve`, { action });
    },
    stats: async () => { const { data } = await apiClient.get("/duplicates/stats"); return data; },
  },
};
