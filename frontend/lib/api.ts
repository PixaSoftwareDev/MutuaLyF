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
  quality_gate_confidence: number | null;
  quality_gate_reason: string | null;
  manually_reviewed?: boolean;
  reviewed_by?: string;
}

export interface PendingChunkResponse extends ChunkResponse {
  document_id: string;
  document_title: string;
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

export interface TrainingExample {
  id: string;
  question_text: string | null;
  is_auto_learned: boolean;
  is_approved: boolean;
  version_id: string | null;
  created_at: string;
}

export interface RecentMatch {
  id: string;
  question_text: string | null;
  intent_confidence: number | null;
  auto_learning_blocked: boolean;
  from_cache: boolean;
  latency_ms: number | null;
  created_at: string;
}

export interface IntentionDetail {
  intention_id: string;
  label: string;
  training_examples: TrainingExample[];
  recent_matches: RecentMatch[];
}

export interface ConversationRow {
  id: string;
  status: "bot_active" | "handoff_requested" | "human_attending" | "closed";
  afiliado_nombre: string | null;
  afiliado_email: string | null;
  sector_id: string | null;
  sector_nombre: string | null;
  operator_name: string | null;
  unread_count: number;
  last_message_at: string | null;
  last_message_sender: "user" | "bot" | "operator" | "system" | null;
  created_at: string;
}

export interface ConversationDetail extends ConversationRow {
  messages: Array<{ id: string; sender_type: string; content: string; created_at: string }>;
}

export interface ConversationHistoryRow {
  id: string;
  status: "bot_active" | "handoff_requested" | "human_attending" | "closed";
  sector_id: string | null;
  sector_nombre: string | null;
  afiliado_nombre: string | null;
  afiliado_email: string | null;
  operator_name: string | null;
  message_count: number;
  created_at: string | null;
  updated_at: string | null;
  closed_at: string | null;
  last_message_at: string | null;
}

export interface ConversationHistoryFilters {
  status?: string;
  sectorId?: string;
  q?: string;
  dateFrom?: string;  // YYYY-MM-DD
  dateTo?: string;
  page?: number;
  pageSize?: number;
}

export interface ConversationHistoryResponse {
  items: ConversationHistoryRow[];
  total: number;
  page: number;
  page_size: number;
}

export interface SectorRow {
  id: string;
  nombre: string;
  descripcion: string | null;
  is_active: boolean;
  is_default: boolean;
  operator_count: number;
  open_conversations: number;
}

export interface PublicSector {
  id: string;
  nombre: string;
  descripcion: string | null;
  is_default: boolean;
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
  bot_name: string | null;
  bot_description: string | null;
  bot_scope: string | null;
  min_retrieval_score: number;
  greeting_message: string | null;
  prompt_query: string | null;
  prompt_quality_gate: string | null;
  prompt_cluster_label: string | null;
  onboarding_completed: boolean;
}

export interface OnboardingGenerateRequest {
  org_name: string;
  org_type: string;
  serves: string;
  main_topics: string;
  excluded_topics: string;
  tone: string;
  bot_name: string;
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
      const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
      // Clear stale localStorage so the interceptor doesn't inject an old tenant header
      if (typeof window !== "undefined") {
        localStorage.removeItem("access_token");
        localStorage.removeItem("tenant_id");
      }
      // No tenant → super-admin login against platform_users table
      if (tenantId) headers["X-Tenant-ID"] = tenantId;
      const { data } = await apiClient.post<LoginResponse>("/auth/login", form, { headers });
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
    reviewChunk: async (
      documentId: string,
      chunkId: string,
      action: "approve" | "reject",
    ): Promise<{ quality_gate_status: string; document_quality_gate_status: string }> => {
      const { data } = await apiClient.patch(
        `/documents/${documentId}/chunks/${chunkId}/quality`,
        { action },
      );
      return data;
    },
    pendingChunks: async (): Promise<PendingChunkResponse[]> => {
      const { data } = await apiClient.get<PendingChunkResponse[]>("/chunks/pending");
      return data;
    },
  },

  intentions: {
    list: async (): Promise<IntentionResponse> => {
      const { data } = await apiClient.get<IntentionResponse>("/intentions");
      return data;
    },
    getExamples: async (intentionId: string): Promise<IntentionDetail> => {
      const { data } = await apiClient.get<IntentionDetail>(`/intentions/${intentionId}/examples`);
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
    platformTraffic: async () => {
      const { data } = await apiClient.get("/tenants/platform/traffic");
      return data as {
        daily: Array<{ day: string; event_type: string; total: number }>;
        per_tenant: Array<{ id: string; name: string; plan: string; status: string; queries_30d: number; ingests_30d: number; tokens_30d: number }>;
      };
    },
    platformHealth: async () => {
      const { data } = await apiClient.get("/tenants/platform/health");
      return data as {
        active_tenants: number;
        total_tenants: number;
        queries_today: number;
        anomalies: Array<{ tenant_id: string; tenant_name: string; type: string; pct: number; detail: string }>;
      };
    },
    platformSystem: async () => {
      const { data } = await apiClient.get("/tenants/platform/system");
      return data as {
        postgres: { up: boolean; connections: number; db_size_bytes: number; cache_hit_rate: number | null; deadlocks_total: number };
        redis: { up: boolean; memory_used_bytes: number; memory_max_bytes: number; connected_clients: number; keyspace_hit_rate: number | null; evicted_keys: number; fragmentation_ratio: number; slowlog_length: number; keys_by_db: Record<string, number> };
        backend: { up: boolean; total_requests: number; error_rate_5m: number; latency_p95_ms: number | null };
        groq: { by_model: Array<{ model: string; calls: Record<string, number>; total: number; errors: number }>; total_calls: number };
        app: { active_tenants: number; total_queries: number; total_cache_hits: number; total_ingests: number; quality: Record<string, number> };
        sparklines: { http_req_rate: Array<{ t: number; v: number }>; query_rate: Array<{ t: number; v: number }> };
      };
    },
    metrics: async (tenantId: string) => {
      const { data } = await apiClient.get(`/tenants/${tenantId}/metrics`);
      return data as {
        tenant: { id: string; name: string; plan: string; status: string; admin_email: string; created_at: string; limits: Record<string, number> };
        usage: { queries_today: number; queries_7d: number; queries_30d: number; ingests_30d: number; llm_tokens_30d: number; daily_30d: Array<{ day: string; total: number }> };
        docs: { total: number; ready: number; failed: number; processing: number; storage_bytes: number };
        performance: { latency_p50: number | null; latency_p95: number | null; cache_hit_rate: number | null; avg_confidence: number | null; total_logged: number };
        quality: { passed: number; pending: number; skipped: number };
        quota: { queries_month: { used: number; limit: number; pct: number | null }; documents: { used: number; limit: number; pct: number | null } };
        recent_queries: Array<{ question_text: string | null; intent_label: string | null; intent_confidence: number | null; latency_ms: number; from_cache: boolean; created_at: string }>;
        top_intents: Array<{ label: string; count: number; avg_confidence: number | null }>;
      };
    },
    createAdmin: async (tenantId: string, payload: { email: string; name: string; password: string }) => {
      const { data } = await apiClient.post(`/tenants/${tenantId}/admin`, payload);
      return data;
    },
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
    onboardingGenerate: async (tenantId: string, payload: OnboardingGenerateRequest): Promise<{ bot_description: string }> => {
      const { data } = await apiClient.post(`/tenants/${tenantId}/onboarding/generate`, payload);
      return data;
    },
    onboardingComplete: async (tenantId: string, payload: { bot_name: string; bot_description: string }): Promise<void> => {
      await apiClient.post(`/tenants/${tenantId}/onboarding/complete`, payload);
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
    presence: async () => {
      const { data } = await apiClient.get("/operator/presence");
      return data as { operators: Array<{ user_id: string; name: string }>; count: number };
    },
    listHistory: async (filters: ConversationHistoryFilters = {}) => {
      const params = new URLSearchParams();
      if (filters.status)    params.set("status_filter", filters.status);
      if (filters.sectorId)  params.set("sector_id",     filters.sectorId);
      if (filters.q)         params.set("q",             filters.q);
      if (filters.dateFrom)  params.set("date_from",     filters.dateFrom);
      if (filters.dateTo)    params.set("date_to",       filters.dateTo);
      params.set("page",      String(filters.page      ?? 1));
      params.set("page_size", String(filters.pageSize  ?? 20));
      const { data } = await apiClient.get(`/operator/conversations/history?${params}`);
      return data as ConversationHistoryResponse;
    },
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
    setDefault: async (id: string) => { await apiClient.patch(`/admin/sectors/${id}/set-default`); },
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

  promptTemplates: {
    // Super admin
    list: async () => {
      const { data } = await apiClient.get("/superadmin/prompt-templates");
      return data as PromptTemplate[];
    },
    get: async (id: string) => {
      const { data } = await apiClient.get(`/superadmin/prompt-templates/${id}`);
      return data as PromptTemplateDetail;
    },
    create: async (body: { nombre: string; descripcion?: string; contenido: string; categoria: string; plan_minimo: string }) => {
      const { data } = await apiClient.post("/superadmin/prompt-templates", body);
      return data as PromptTemplateDetail;
    },
    update: async (id: string, body: Partial<{ nombre: string; descripcion: string; contenido: string; categoria: string; plan_minimo: string; is_active: boolean }>) => {
      const { data } = await apiClient.patch(`/superadmin/prompt-templates/${id}`, body);
      return data;
    },
    delete: async (id: string) => {
      await apiClient.delete(`/superadmin/prompt-templates/${id}`);
    },
    assignToTenants: async (id: string, tenant_ids: string[]) => {
      const { data } = await apiClient.post(`/superadmin/prompt-templates/${id}/assign`, { tenant_ids });
      return data as { assigned: string[]; errors: { tenant_id: string; error: string }[] };
    },
    unassign: async (tenant_id: string, template_id: string) => {
      await apiClient.delete(`/superadmin/tenants/${tenant_id}/prompt-assignments/${template_id}`);
    },
    setMaxTemplates: async (tenant_id: string, max: number) => {
      const { data } = await apiClient.patch(`/superadmin/tenants/${tenant_id}/max-templates`, { max_prompt_templates: max });
      return data;
    },
    listCategories: async () => {
      const { data } = await apiClient.get("/superadmin/prompt-categories");
      return data.categories as string[];
    },
    listSystemComponents: async () => {
      const { data } = await apiClient.get("/superadmin/system-components");
      return data as { id: string; nombre: string; descripcion: string | null; categoria: string; contenido: string; updated_at: string | null }[];
    },
    // Admin
    listAssigned: async () => {
      const { data } = await apiClient.get("/admin/prompt-templates");
      return data as { max_prompt_templates: number; templates: AssignedTemplate[] };
    },
    activate: async (template_id: string) => {
      const { data } = await apiClient.post(`/admin/prompt-templates/${template_id}/activate`);
      return data;
    },
    deactivate: async () => {
      const { data } = await apiClient.post("/admin/prompt-templates/deactivate");
      return data;
    },
  },

  tenantBots: {
    list: async (tenantId: string) => {
      const { data } = await apiClient.get(`/superadmin/tenants/${tenantId}/bots`);
      return data as { bots: TenantBot[] };
    },
    activate: async (tenantId: string, templateId: string) => {
      const { data } = await apiClient.post(`/superadmin/tenants/${tenantId}/bots/${templateId}/activate`);
      return data;
    },
    deactivate: async (tenantId: string) => {
      const { data } = await apiClient.delete(`/superadmin/tenants/${tenantId}/bots/active`);
      return data;
    },
  },

  entities: {
    stats: async () => {
      const { data } = await apiClient.get<EntityStats[]>("/entities/stats");
      return data;
    },
    list: async (params?: { label?: string; search?: string; limit?: number }) => {
      const q = new URLSearchParams();
      if (params?.label)  q.set("label",  params.label);
      if (params?.search) q.set("search", params.search);
      if (params?.limit)  q.set("limit",  String(params.limit));
      const { data } = await apiClient.get<EntitySummary[]>(`/entities?${q}`);
      return data;
    },
    detail: async (label: string, nombre: string) => {
      const { data } = await apiClient.get<EntityDetail>(`/entities/${label}/${encodeURIComponent(nombre)}`);
      return data;
    },
  },

  audit: {
    list: async (params?: { limit?: number; offset?: number; action?: string }) => {
      const q = new URLSearchParams();
      if (params?.limit)  q.set("limit",  String(params.limit));
      if (params?.offset) q.set("offset", String(params.offset));
      if (params?.action) q.set("action", params.action);
      const { data } = await apiClient.get(`/audit?${q}`);
      return data as {
        total: number; offset: number; limit: number;
        events: AuditEvent[];
      };
    },
    globalList: async (params?: { limit?: number; offset?: number; action?: string; tenant_filter?: string }) => {
      const q = new URLSearchParams();
      if (params?.limit)         q.set("limit",         String(params.limit));
      if (params?.offset)        q.set("offset",        String(params.offset));
      if (params?.action)        q.set("action",        params.action);
      if (params?.tenant_filter) q.set("tenant_filter", params.tenant_filter);
      const { data } = await apiClient.get(`/superadmin/audit?${q}`);
      return data as {
        total: number; offset: number; limit: number;
        tenants: string[];
        events: (AuditEvent & { tenant_id: string })[];
      };
    },
  },
};

interface PromptTemplate {
  id: string; nombre: string; descripcion: string | null; categoria: string;
  plan_minimo: string; is_active: boolean; created_at: string; updated_at: string;
  assigned_count: number; active_count: number;
}
interface PromptTemplateDetail extends Omit<PromptTemplate, "assigned_count" | "active_count"> {
  contenido: string;
  assignments: { id: string; tenant_id: string; tenant_name: string; is_active: boolean; assigned_at: string }[];
}
interface AssignedTemplate {
  id: string; assignment_id: string; nombre: string; descripcion: string | null;
  categoria: string; is_active: boolean; assigned_at: string;
}

interface TenantBot {
  id: string; nombre: string; descripcion: string | null; categoria: string;
  is_active: boolean; assigned_at: string;
}

interface AuditEvent {
  id: string;
  actor_id: string;
  actor_email: string | null;
  actor_role: string;
  action: string;
  resource: string | null;
  detail: Record<string, unknown> | null;
  ip_address: string | null;
  created_at: string;
}

export interface EntityStats {
  label: string;
  count: number;
}

export interface EntitySummary {
  nombre: string;
  nombre_normalizado: string;
  label: string;
  mention_count: number;
  created_at: string | null;
}

export interface EntityChunk {
  chunk_id: string;
  doc_id: string;
  doc_filename: string | null;
}

export interface EntityDetail {
  nombre: string;
  label: string;
  chunks: EntityChunk[];
}
