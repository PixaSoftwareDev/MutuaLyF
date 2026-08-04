/**
 * Typed API client for the IA Inteligent backend.
 * All requests include the Authorization header from the auth store.
 */

import axios, { AxiosError, type AxiosInstance } from "axios";
import { decodeJwtPayload } from "./jwt";

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

// 401 → wipe auth + redirect a /login. 429 → mostrar toast, NO tocar auth.
// F1.7: antes cualquier 4xx mataba la sesion. Bajo stress test, nginx tira
// 429 (rate limit) y el frontend lo trataba como sesion invalida → falso
// positivo "token revocado". Ahora 429 es ruidoso pero no destructivo.
let _rateLimitToastShownAt = 0;

// Refresh token: una sola promesa compartida entre requests concurrentes que
// caen 401 al mismo tiempo (evita N refreshes en paralelo). La cookie HttpOnly
// refresh_token viaja sola; el endpoint devuelve un access_token nuevo.
let _refreshing: Promise<string | null> | null = null;

function refreshAccessToken(): Promise<string | null> {
  if (!_refreshing) {
    _refreshing = apiClient
      // _skipAuthRetry evita que un 401 del propio /refresh entre de nuevo al retry.
      .post("/auth/refresh", null, { withCredentials: true, _skipAuthRetry: true } as never)
      .then((res) => {
        const token = (res.data as { access_token?: string })?.access_token;
        if (token && typeof window !== "undefined") {
          localStorage.setItem("access_token", token);
          scheduleProactiveRefresh(token);  // reprograma el próximo refresh
        }
        return token ?? null;
      })
      .catch(() => null)
      .finally(() => { _refreshing = null; });
  }
  return _refreshing;
}

// ── Refresh PROACTIVO ────────────────────────────────────────────────────────
// Renueva el access token ~60s ANTES de que venza (lee el `exp` del JWT), así
// ningún request sale con el token muerto. Sin esto, cada ~60min una tanda de
// requests concurrentes caía en 401 → refresh → retry: funcionaba (el operador
// no lo notaba) pero ensuciaba los logs con "jwt_decode_failed" y metía un
// micro-blip. Complementa, NO reemplaza, al refresh reactivo del 401 de arriba
// (que sigue cubriendo el caso de que la pestaña estuvo dormida/suspendida).
let _proactiveTimer: ReturnType<typeof setTimeout> | null = null;

export function scheduleProactiveRefresh(token: string | null): void {
  if (typeof window === "undefined") return;
  if (_proactiveTimer) { clearTimeout(_proactiveTimer); _proactiveTimer = null; }
  if (!token) return;
  const payload = decodeJwtPayload<{ exp?: number }>(token);
  if (!payload?.exp) return;  // sin exp / no decodificable → lo cubre el 401 reactivo
  const msLeft = payload.exp * 1000 - Date.now();
  if (msLeft <= 0) return;  // ya vencido → lo cubre el 401 del próximo request
  const delay = Math.max(msLeft - 60_000, 5_000);  // 60s antes de vencer, mínimo 5s
  _proactiveTimer = setTimeout(() => { void refreshAccessToken(); }, delay);
}

// Arranque en el cliente: si ya hay token guardado (recarga de página, pestaña
// reabierta), programa el refresh proactivo desde su exp.
if (typeof window !== "undefined") {
  scheduleProactiveRefresh(localStorage.getItem("access_token"));
}

function wipeAndRedirect() {
  if (typeof window === "undefined" || window.location.pathname.startsWith("/login")) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("./store").useAuthStore.getState().clearAuth();
  } catch {
    localStorage.removeItem("access_token");
    localStorage.removeItem("tenant_id");
    document.cookie = "ia_role=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT";
    document.cookie = "ia_tenant=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT";
  }
  window.location.href = "/login";
}

apiClient.interceptors.response.use(
  (res) => res,
  async (err: AxiosError) => {
    const status = err.response?.status;
    const original = err.config as (typeof err.config & { _retried?: boolean; _skipAuthRetry?: boolean }) | undefined;

    // ── 429 Too Many Requests — rate limit ──────────────────────────────────
    if (status === 429 && typeof window !== "undefined") {
      const now = Date.now();
      if (now - _rateLimitToastShownAt > 3000) {
        _rateLimitToastShownAt = now;
        import("@/components/ui/toast").then(({ toast }) => {
          toast({
            title: "Demasiadas solicitudes",
            description: "Esperá un momento y volvé a intentar.",
            variant: "destructive",
          });
        }).catch(() => {/* toast no disponible — silencioso */});
      }
      // No tocar el token: la sesión sigue siendo válida, solo hay backpressure.
      return Promise.reject(err);
    }

    // ── 401 Unauthorized — intentar refresh UNA vez, luego wipe + redirect ───
    if (status === 401 && typeof window !== "undefined" && original) {
      const onLogin = window.location.pathname.startsWith("/login");
      const isRefreshCall = original._skipAuthRetry || (original.url ?? "").includes("/auth/refresh");
      if (!original._retried && !isRefreshCall && !onLogin) {
        original._retried = true;
        const newToken = await refreshAccessToken();
        if (newToken) {
          // Reintentar la request original con el access token renovado.
          original.headers = original.headers ?? {};
          (original.headers as Record<string, string>).Authorization = `Bearer ${newToken}`;
          return apiClient(original);
        }
      }
      // El refresh falló o no aplica → recién acá cerramos la sesión.
      wipeAndRedirect();
    }
    return Promise.reject(err);
  }
);

// ── Types ──────────────────────────────────────────────────────────────────────

// Fila del listado de organizaciones (GET /tenants).
export interface TenantListRow {
  id: string; name: string; plan: string; status: string;
  admin_email: string; created_at: string;
  limits: { users: number; documents: number; queries_month: number };
  usage_30d: { queries: number; ingests: number };
  queries_this_month: number;
  last_activity_at: string | null;
}

export interface PlanRow {
  id: string;
  name: string;
  users: number;
  documents: number;
  queries_month: number;
  max_mb: number;
  price_usd: number | null;
  is_active: boolean;
  sort_order: number;
}
export type PlanBody = Omit<PlanRow, "id">;

export interface LoginResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export interface LookupTenantMatch {
  tenant_id:     string;
  display_name:  string;
  logo_url:      string | null;
  primary_color: string | null;
  role:          string;
  match_via:     string;
}

export interface LookupTenantResponse {
  matches: LookupTenantMatch[];
}

export interface MeResponse {
  id:         string;
  email:      string;
  name:       string;
  role:       string;
  tenant_id:  string | null;
  sectors:    Array<{ id: string; nombre: string }>;
}

export interface TenantBranding {
  tenant_id:        string;
  display_name:     string;
  logo_url:         string | null;
  primary_color:    string;
  secondary_color:  string | null;
  favicon_url:      string | null;
  bot_name:         string | null;
  greeting_message: string | null;
  /** Tema del widget embebido: 'light' (default) o 'dark'. */
  widget_theme?: "light" | "dark";
  /** Esquina del widget embebido: 'right' (default) o 'left'. */
  widget_position?: "right" | "left";
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
  storage_key: string | null;
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

export interface ConversationRow {
  id: string;
  status: "bot_active" | "handoff_requested" | "human_attending" | "closed";
  afiliado_nombre: string | null;
  afiliado_email: string | null;
  afiliado_dni: string | null;
  afiliado_ip: string | null;
  is_test: boolean;
  sector_id: string | null;
  sector_nombre: string | null;
  operator_name: string | null;
  unread_count: number;
  last_message_at: string | null;
  last_message_sender: "user" | "bot" | "operator" | "system" | null;
  created_at: string;
  // Momento en que entró a la cola de operador. El "tiempo esperando" se mide
  // desde acá (no desde last_message_at). null en conversaciones que nunca pidieron operador.
  handoff_requested_at: string | null;
  channel?: string | null;      // 'widget' | 'whatsapp'
  external_id?: string | null;  // wa_id (teléfono) cuando channel='whatsapp'
}

export interface ConversationDetail extends ConversationRow {
  messages: Array<{ id: string; sender_type: string; content: string; created_at: string;
                    attachment_name?: string | null; attachment_mime?: string | null; attachment_size?: number | null;
                    delivery_status?: string | null }>;
}

export interface ConversationHistoryRow {
  id: string;
  status: "bot_active" | "handoff_requested" | "human_attending" | "closed";
  sector_id: string | null;
  sector_nombre: string | null;
  channel: string | null;
  external_id: string | null;
  afiliado_nombre: string | null;
  afiliado_email: string | null;
  afiliado_dni: string | null;
  afiliado_ip: string | null;
  is_test: boolean;
  operator_name: string | null;
  message_count: number;
  created_at: string | null;
  updated_at: string | null;
  closed_at: string | null;
  last_message_at: string | null;
  last_message_preview: string | null;
  last_message_sender: "user" | "bot" | "operator" | "system" | null;
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

// ── Conectores de terceros (pantalla /admin/connectors) ───────────────────────
export interface ConnectorHealth {
  status: "ok" | "failing";
  last_call_at: string;
  last_ok_at: string | null;
  failing_since: string | null;
  calls_24h: number;
  errors_24h: number;
}

export interface ConnectorRow {
  id: string;
  slug: string;
  display_name: string;
  base_url: string;
  egress_allow: string[];
  auth_type: string;
  auth_validate_path: string | null;
  is_active: boolean;
  // Inactivo con solicitud de activación esperando al super-admin (hosts sin aprobar).
  pending_approval?: boolean;
  timeout_ms: number;
  has_secret: boolean;
  tool_count: number;
  health: ConnectorHealth | null;
}

export interface ConnectorTool {
  id: string;
  slug: string;
  display_name: string;
  description: string | null;
  /** Consultas de ejemplo (capability profile) que ayudan al router a elegir esta operación. */
  examples: string[];
  http_method: string;
  path_template: string;
  params_schema: Record<string, unknown>;
  response_map: Record<string, unknown>;
  identity_kind: string;
  is_read_only: boolean;
  is_active: boolean;
  // Última prueba persistida: null = nunca probada (gris) · true = verde · false = rojo.
  last_test_ok: boolean | null;
  last_test_at: string | null;
  last_test_detail: string | null;
  roles: string[];
}

export interface ActivationRequest {
  tenant_id: string;
  tenant_name: string;
  connector_id: string;
  connector_name: string;
  base_url: string;
  hosts: Array<{ host: string; approved: boolean }>;
  requested_by: string | null;
  requested_at: string | null;
  tools: Array<{ display_name: string; http_method: string; path_template: string; is_active: boolean }>;
}

export interface PlatformConnector {
  tenant_id: string;
  tenant_name: string;
  id: string;
  display_name: string;
  base_url: string;
  is_active: boolean;
  auth_type: string;
  egress_allow: string[];
  tools: Array<{ display_name: string; http_method: string; path_template: string; is_active: boolean }>;
}

export interface ConnectorChange {
  tenant_id: string;
  tenant_name: string;
  action: string;
  resource: string | null;
  /** Nombre humano del recurso (conector u operación), resuelto por el backend. */
  resource_label: string | null;
  actor_email: string | null;
  detail: Record<string, unknown>;
  created_at: string | null;
}

export interface ToolTestAllResult {
  results: Array<{
    tool_id: string; slug: string; display_name: string;
    skipped: boolean; ok: boolean | null;
    status?: number | null; error?: string | null; detail?: string | null; latency_ms?: number;
  }>;
  total: number; ok: number; failed: number; skipped: number;
}

export interface ConnectorDetail extends Omit<ConnectorRow, "tool_count"> {
  auth_config: Record<string, unknown>;
  tools: ConnectorTool[];
}

export interface ConnectorPayload {
  slug: string;
  display_name: string;
  base_url: string;
  egress_allow: string[];
  auth_type: string;
  auth_config?: Record<string, unknown>;
  auth_validate_path?: string | null;
  timeout_ms?: number;
}

export interface ExampleCandidate {
  id: string;
  query: string;
  hits: number;
  last_seen_at: string | null;
}

export interface ConnectorToolPayload {
  slug: string;
  display_name: string;
  description?: string | null;
  examples?: string[];
  http_method: string;
  path_template: string;
  params_schema?: Record<string, unknown>;
  response_map?: Record<string, unknown>;
  identity_kind: string;
  is_read_only?: boolean;
  roles?: string[];
}

// Usuario autorizado por conector (registro de identidad, modo platform_registry).
export interface ConnectorUserRow {
  id: string;
  documento: string;
  email: string;
  nombre: string;
  is_active: boolean;
  created_at: string;
}

export interface ConnectorUserPayload {
  documento: string;
  email: string;
  nombre: string;
  is_active?: boolean;
}

export interface ConnectorTestResult {
  url: string | null;
  method: string;
  ok: boolean;
  status?: number;
  latency_ms?: number;
  raw?: unknown;
  mapped?: { outcome: string; data: unknown };
  suggested_response_map?: Record<string, unknown>;
  error?: string;
  detail?: string;
  /** Ids de recurso conseguidos automáticamente (recorrido lista→detalle del backend). */
  auto_filled?: Array<{ param: string; value: string; label?: string | null; from: string }>;
  /** El backend aplicó solo el response_map sugerido (prueba OK + tool sin mapeo). */
  response_map_applied?: boolean;
}

export interface DiscoveryRoute {
  path: string;
  include: boolean;
  discard_reason?: string | null;
  slug?: string;
  display_name?: string;
  description?: string | null;
  http_method?: string;
  path_template?: string;
  params_schema?: Record<string, unknown>;
  response_map?: Record<string, unknown>;
  identity_kind?: string;
  identity_param?: string | null;
  is_lookup?: boolean;
  test?: { ok: boolean; status?: number; latency_ms?: number; url?: string; error?: string };
}

export interface DiscoveryProposal {
  spec_found: boolean;
  spec_url?: string;
  hint?: string;
  routes: DiscoveryRoute[];
}

export interface PublicSector {
  id: string;
  nombre: string;
  descripcion: string | null;
  is_default: boolean;
}

// ── Feedback del afiliado (caritas al cierre) ────────────────────────────────
export type FeedbackAction = "missing_content" | "wrong_content" | "bot_misunderstood" | "dismissed";

export interface FeedbackItem {
  conversation_id: string;
  rating: 1 | 2 | 3;
  reason: "not_found" | "wrong_info" | "slow_service" | null;
  feedback_at: string | null;
  review_status: "pending" | "resolved" | "dismissed" | null;
  review_action: FeedbackAction | null;
  afiliado_nombre: string | null;
  afiliado_ip: string | null;
  channel: string;
  is_test: boolean;
  atendida_por_humano: boolean;
  sector_nombre: string | null;
  ultima_pregunta: string | null;
}

export interface FeedbackListResponse {
  total: number;
  pending: number;
  page: number;
  page_size: number;
  items: FeedbackItem[];
}

export interface KeywordTriggerGroup {
  words: string[];
  message: string;
}

export interface HandoffConfig {
  id: string;
  inactivity_timeout_minutes: number;
  consecutive_insufficient_count: number;
  attention_hours: string | null;
  contact_info: string | null;
  transition_messages: Record<string, string>;
  /** Regla 5: temas que ofrecen derivación proactiva (el bot responde igual). */
  keyword_triggers: KeywordTriggerGroup[];
  updated_at: string;
}

export interface WidgetTokenResponse {
  widget_token: string;
  tenant_id: string;
}

export interface BotConfig {
  bot_name: string | null;
  bot_description: string | null;
  bot_scope: string | null;
  min_retrieval_score: number;
  greeting_message: string | null;
  prompt_quality_gate: string | null;
  prompt_cluster_label: string | null;
  onboarding_completed: boolean;
}

/** 5 respuestas curadas del wizard hibrido. */
export interface OnboardingFixedAnswers {
  audience:          string;
  typical_questions: string;
  excluded_topics:   string;
  fallback:          "suggest_contact" | "offer_handoff" | "request_contact" | "suggest_business_hours";
  additional_notes:  string;
}

export interface OnboardingGenerateRequest {
  org_name:           string;
  org_type?:          string;
  /** "A qué se dedica / qué ofrece" — contexto principal del wizard simple. */
  description?:       string;
  tone:               string;
  bot_name?:          string;
  answers?:           OnboardingFixedAnswers;
  followup_question?: string;
  followup_answer?:   string;
}

export interface OnboardingFollowupRequest {
  org_name: string;
  org_type: string;
  tone:     string;
  bot_name: string;
  answers:  OnboardingFixedAnswers;
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

// ── Métricas del tenant ─────────────────────────────────────────────────────────

export interface TenantMetrics {
  tenant: { id: string; name: string | null; plan: string | null; limits: Record<string, number> };
  usage: {
    queries_today: number; queries_7d: number; queries_30d: number;
    queries_this_month: number; queries_prev_month: number; mom_pct: number | null;
    ingests_30d: number; llm_tokens_30d: number;
    queries_prev_30d: number; llm_tokens_prev_30d: number;
    daily: Array<{ day: string; total: number }>;
    ingest_daily: Array<{ day: string; total: number }>;
    tokens_daily: Array<{ day: string; total: number }>;
  };
  performance: {
    latency_p50: number | null; latency_p95: number | null;
    cache_hit_rate: number | null; total_logged: number;
  };
  docs: { total: number; ready: number; failed: number; processing: number; storage_bytes: number };
  quality: { passed: number; pending: number; skipped: number };
  conversations: {
    total: number; widget: number; whatsapp: number;
    handoffs: number; handoff_rate: number | null; bot_resolved_pct: number | null;
    avg_resolution_seconds: number | null;
    prev_total: number; avg_wait_seconds: number | null;
    daily: Array<{ day: string; total: number; handoffs: number }>;
    by_sector: Array<{ nombre: string; total: number }>;
    feedback: {
      rated: number; happy: number; neutral: number; sad: number;
      satisfaction_pct: number | null; satisfaction_bot_pct: number | null;
      response_rate_pct: number | null; pending_review: number;
    };
  };
  recent_queries: Array<{
    question_text: string | null;
    latency_ms: number | null; from_cache: boolean; created_at: string;
  }>;
  quota: {
    queries_month: { used: number; limit: number; pct: number | null };
    documents: { used: number; limit: number; pct: number | null };
    users: { used: number; limit: number; pct: number | null };
  };
}

// ── API functions ──────────────────────────────────────────────────────────────

export const api = {
  metrics: {
    // `days` (7 | 30 | 90) acota la ventana de los informes Asistente/Atención y
    // la serie de actividad. Las cuotas del plan no dependen de este parámetro.
    get: async (days?: number): Promise<TenantMetrics> => {
      const { data } = await apiClient.get<TenantMetrics>("/metrics", {
        params: days ? { days } : undefined,
      });
      return data;
    },
  },

  auth: {
    /** Email-first lookup. Devuelve los tenants donde existe ese email. */
    lookupTenant: async (email: string): Promise<LookupTenantResponse> => {
      // El interceptor inyecta tenant_id stale del localStorage; lo limpiamos
      // primero para que el lookup sea totalmente anonimo (sino el backend
      // recibe un X-Tenant-ID basura del login previo).
      if (typeof window !== "undefined") {
        localStorage.removeItem("access_token");
        localStorage.removeItem("tenant_id");
      }
      const { data } = await apiClient.post<LookupTenantResponse>("/auth/lookup-tenant", { email });
      return data;
    },
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
      scheduleProactiveRefresh(null);  // cancela el timer de refresh
      await apiClient.post("/auth/logout");
      localStorage.removeItem("access_token");
      localStorage.removeItem("tenant_id");
    },
    /** Inicia el reset. Respuesta uniforme: no revela si el email existe. */
    forgotPassword: async (email: string): Promise<void> => {
      await apiClient.post("/auth/forgot-password", { email });
    },
    /** Canjea el token del email por una contraseña nueva. */
    resetPassword: async (token: string, newPassword: string): Promise<void> => {
      await apiClient.post("/auth/reset-password", { token, new_password: newPassword });
    },
    me: async (): Promise<MeResponse> => {
      const { data } = await apiClient.get<MeResponse>("/auth/me");
      return data;
    },
    updateMe: async (name: string): Promise<MeResponse> => {
      const { data } = await apiClient.patch<MeResponse>("/auth/me", { name });
      return data;
    },
    changePassword: async (currentPassword: string, newPassword: string): Promise<void> => {
      await apiClient.post("/auth/me/password", {
        current_password: currentPassword,
        new_password:     newPassword,
      });
    },
  },

  branding: {
    /** Public endpoint — no auth required. Used by login and pre-auth pages. */
    get: async (tenantId: string): Promise<TenantBranding> => {
      // bypass interceptor headers; this is a public endpoint
      const url = `${API_URL}/api/v1/public/tenant-branding?tenant_id=${encodeURIComponent(tenantId)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Branding HTTP ${res.status}`);
      return res.json();
    },

    /** Admin: load own branding (or other tenant if super-admin). */
    getAdmin: async (tenantId?: string): Promise<TenantBranding> => {
      const url = tenantId
        ? `/admin/branding?tenant_id=${encodeURIComponent(tenantId)}`
        : "/admin/branding";
      const { data } = await apiClient.get<TenantBranding>(url);
      return data;
    },

    /** Admin: patch branding fields. Send only the fields you want to change. */
    update: async (
      patch: Partial<Pick<TenantBranding, "display_name" | "primary_color" | "secondary_color" | "favicon_url" | "widget_theme" | "widget_position">>,
      tenantId?: string,
    ): Promise<TenantBranding> => {
      const url = tenantId
        ? `/admin/branding?tenant_id=${encodeURIComponent(tenantId)}`
        : "/admin/branding";
      const { data } = await apiClient.patch<TenantBranding>(url, patch);
      return data;
    },

    /** Admin: upload logo file. Returns the new logo_url. */
    uploadLogo: async (file: File, tenantId?: string): Promise<{ logo_url: string }> => {
      const fd = new FormData();
      fd.append("file", file);
      const url = tenantId
        ? `/admin/branding/logo?tenant_id=${encodeURIComponent(tenantId)}`
        : "/admin/branding/logo";
      const { data } = await apiClient.post<{ logo_url: string }>(url, fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      return data;
    },

    /** Admin: remove logo. */
    deleteLogo: async (tenantId?: string): Promise<void> => {
      const url = tenantId
        ? `/admin/branding/logo?tenant_id=${encodeURIComponent(tenantId)}`
        : "/admin/branding/logo";
      await apiClient.delete(url);
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
    upload: async (
      file: File,
      onUploadProgress?: (pct: number) => void,
    ): Promise<DocumentIngestResponse> => {
      const form = new FormData();
      form.append("file", file);
      const { data } = await apiClient.post<DocumentIngestResponse>("/ingest", form, {
        headers: { "Content-Type": "multipart/form-data" },
        timeout: 120_000,
        onUploadProgress: (e) => {
          if (onUploadProgress && e.total) {
            onUploadProgress(Math.round((e.loaded / e.total) * 100));
          }
        },
      });
      return data;
    },
    status: async (documentId: string): Promise<{ status: string; chunk_count: number; quality_gate_status: string }> => {
      const { data } = await apiClient.get(`/documents/${documentId}/status`);
      return data;
    },
    chunks: async (documentId: string): Promise<ChunkResponse[]> => {
      const { data } = await apiClient.get<ChunkResponse[]>(`/documents/${documentId}/chunks`);
      return data;
    },
    delete: async (documentId: string): Promise<void> => {
      await apiClient.delete(`/documents/${documentId}`);
    },
    /**
     * Edita el texto de un chunk del documento. Backend re-embeddea el texto
     * automáticamente y actualiza Qdrant + parent_chunks (si aplica).
     */
    editChunkText: async (
      documentId: string,
      chunkId: string,
      newText: string,
    ): Promise<{ chunk_id: string; document_id: string; text: string; parent_id: string | null }> => {
      const { data } = await apiClient.patch(
        `/documents/${documentId}/chunks/${chunkId}`,
        { text: newText },
      );
      return data;
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
    /** Busca dentro del contenido de los documentos. Devuelve doc ids con nº de coincidencias. */
    searchContent: async (q: string): Promise<Array<{ document_id: string; matches: number }>> => {
      const { data } = await apiClient.get("/documents/search", { params: { q } });
      return data;
    },
    /** variant "original" = archivo tal como se subió; "edited" = partes vigentes (.txt). */
    download: async (documentId: string, variant: "original" | "edited" = "original"): Promise<void> => {
      const path = variant === "edited"
        ? `/documents/${documentId}/download/edited`
        : `/documents/${documentId}/download`;
      const response = await apiClient.get(path, { responseType: "blob" });
      const blob = new Blob([response.data], { type: response.headers["content-type"] || "application/octet-stream" });
      const cd = response.headers["content-disposition"] || "";
      const match = cd.match(/filename="?([^"]+)"?/);
      const filename = match ? match[1] : "archivo";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    },
    /**
     * Exporta la KB completa como JSON descargable (portable, re-importable).
     * Devuelve un Blob — el caller arma el download del navegador.
     */
    exportJson: async (opts: {
      includeConversations?: boolean;
      includeEmbeddings?: boolean;
    } = {}): Promise<{ blob: Blob; filename: string }> => {
      const params = new URLSearchParams({
        include_conversations: String(opts.includeConversations ?? false),
        include_embeddings:    String(opts.includeEmbeddings ?? false),
      });
      const res = await apiClient.get(`/admin/export/json?${params.toString()}`, {
        responseType: "blob",
        timeout: 300_000, // 5min para exports grandes con embeddings
      });
      // Filename viene del Content-Disposition header
      const cd = (res.headers["content-disposition"] || "") as string;
      const match = cd.match(/filename="?([^"]+)"?/);
      const filename = match?.[1] ?? `kb-export-${Date.now()}.json`;
      return { blob: res.data as Blob, filename };
    },
  },

  connectors: {
    list: async (): Promise<{ connectors: ConnectorRow[] }> => {
      const { data } = await apiClient.get("/admin/connectors");
      return data;
    },
    get: async (id: string): Promise<ConnectorDetail> => {
      const { data } = await apiClient.get(`/admin/connectors/${id}`);
      return data;
    },
    create: async (body: ConnectorPayload): Promise<{ id: string }> => {
      const { data } = await apiClient.post("/admin/connectors", body);
      return data;
    },
    update: async (id: string, body: Partial<ConnectorPayload>) => {
      const { data } = await apiClient.put(`/admin/connectors/${id}`, body);
      return data as { ok: boolean; deactivated: boolean };
    },
    delete: async (id: string) => {
      await apiClient.delete(`/admin/connectors/${id}`);
    },
    setSecret: async (id: string, secret: string) => {
      await apiClient.put(`/admin/connectors/${id}/secret`, { secret });
    },
    /** Valida la credencial sin tocar las operaciones. oauth2 → emisión real de token. */
    testAuth: async (id: string) => {
      const { data } = await apiClient.post(`/admin/connectors/${id}/test-auth`, {}, { timeout: 30_000 });
      return data as { ok: boolean; detail?: string; latency_ms?: number; note?: string | null };
    },
    setActive: async (id: string, isActive: boolean) => {
      const { data } = await apiClient.patch(`/admin/connectors/${id}/active`, { is_active: isActive });
      // pending_approval: la activación no falló — quedó esperando que el
      // super-admin apruebe los hosts (pending_hosts dice cuáles).
      return data as { ok: boolean; is_active: boolean; pending_approval?: boolean; pending_hosts?: string[] };
    },
    approvedHosts: async (): Promise<{ hosts: Array<{ host: string; approved_by: string | null; note: string | null; created_at: string | null }> }> => {
      const { data } = await apiClient.get("/admin/connectors/approved-hosts");
      return data;
    },
    addApprovedHost: async (host: string, note?: string) => {
      const { data } = await apiClient.post("/admin/connectors/approved-hosts", { host, note: note || null });
      return data as { host: string; approved: boolean };
    },
    removeApprovedHost: async (host: string) => {
      await apiClient.delete(`/admin/connectors/approved-hosts/${encodeURIComponent(host)}`);
    },
    // Solicitudes de activación pendientes (super-admin): qué tenant pide activar
    // qué conector, con sus hosts y rutas a la vista para aprobar con fundamento.
    activationRequests: async (): Promise<{ requests: ActivationRequest[] }> => {
      const { data } = await apiClient.get("/admin/connectors/activation-requests");
      return data;
    },
    // Oversight de plataforma: todos los conectores de todos los tenants con sus
    // rutas, más el feed de cambios de configuración (30 días).
    platformOverview: async (): Promise<{ connectors: PlatformConnector[]; changes: ConnectorChange[] }> => {
      const { data } = await apiClient.get("/admin/connectors/overview");
      return data;
    },
    // Usuarios autorizados por conector (modo platform_registry): lista blanca
    // documento + email + nombre. El login busca por documento y manda OTP al email.
    listConnectorUsers: async (connectorId: string) => {
      const { data } = await apiClient.get(`/admin/connectors/${connectorId}/users`);
      return data as { users: Array<{ id: string; documento: string; email: string; nombre: string; is_active: boolean }> };
    },
    createConnectorUser: async (connectorId: string, body: { documento: string; email: string; nombre: string }) => {
      const { data } = await apiClient.post(`/admin/connectors/${connectorId}/users`, body);
      return data as { id: string };
    },
    updateConnectorUser: async (userId: string, body: Partial<{ documento: string; email: string; nombre: string; is_active: boolean }>) => {
      await apiClient.patch(`/admin/connectors/users/${userId}`, body);
    },
    deleteConnectorUser: async (userId: string) => {
      await apiClient.delete(`/admin/connectors/users/${userId}`);
    },
    createTool: async (connectorId: string, body: ConnectorToolPayload): Promise<{ id: string }> => {
      const { data } = await apiClient.post(`/admin/connectors/${connectorId}/tools`, body);
      return data;
    },
    updateTool: async (toolId: string, body: Partial<ConnectorToolPayload> & { is_active?: boolean }) => {
      await apiClient.put(`/admin/connectors/tools/${toolId}`, body);
    },
    // Data flywheel: candidatos a ejemplo (consultas reales que rutearon OK).
    exampleCandidates: async (toolId: string): Promise<{ candidates: ExampleCandidate[] }> => {
      const { data } = await apiClient.get(`/admin/connectors/tools/${toolId}/example-candidates`);
      return data;
    },
    approveExampleCandidate: async (candidateId: string) => {
      const { data } = await apiClient.post(`/admin/connectors/example-candidates/${candidateId}/approve`);
      return data as { ok: boolean; query: string };
    },
    dismissExampleCandidate: async (candidateId: string) => {
      await apiClient.post(`/admin/connectors/example-candidates/${candidateId}/dismiss`);
    },
    deleteTool: async (toolId: string) => {
      await apiClient.delete(`/admin/connectors/tools/${toolId}`);
    },
    testTool: async (connectorId: string, toolId: string, body: { identity?: string; params?: Record<string, unknown> }) => {
      const { data } = await apiClient.post(`/admin/connectors/${connectorId}/tools/${toolId}/test`, body);
      return data as ConnectorTestResult;
    },
    testAllTools: async (connectorId: string, identity: string) => {
      const { data } = await apiClient.post(`/admin/connectors/${connectorId}/tools/test-all`,
        { identity }, { timeout: 120_000 });
      return data as ToolTestAllResult;
    },
    // Detección: la clasificación LLM del backend puede colgarse y reintentar
    // (hasta ~60s por intento) + dry-runs contra el proveedor. El cliente tiene
    // que esperar más que el peor caso del backend — cortar antes deja al admin
    // con un error genérico mientras el backend sigue trabajando.
    discover: async (connectorId: string, testIdentity: string) => {
      const { data } = await apiClient.post(`/admin/connectors/${connectorId}/discover`,
        { test_identity: testIdentity }, { timeout: 300_000 });
      return data as DiscoveryProposal;
    },
    /** Mismo wizard pero desde la documentación subida (PDF/Word/TXT/MD/JSON). */
    discoverFromFile: async (connectorId: string, file: File, testIdentity: string) => {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("test_identity", testIdentity);
      // multipart explícito: el default "application/json" pisa el boundary del FormData.
      const { data } = await apiClient.post(`/admin/connectors/${connectorId}/discover-file`, fd, {
        headers: { "Content-Type": "multipart/form-data" }, timeout: 300_000,
      });
      return data as DiscoveryProposal;
    },
    apply: async (connectorId: string, tools: DiscoveryRoute[]) => {
      const { data } = await apiClient.post(`/admin/connectors/${connectorId}/apply`, {
        tools: tools.map(t => ({
          slug: t.slug, display_name: t.display_name, description: t.description ?? null,
          http_method: t.http_method ?? "GET",
          path_template: t.path_template, params_schema: t.params_schema ?? {},
          response_map: t.response_map ?? {}, identity_kind: t.identity_kind,
          is_lookup: t.is_lookup, identity_param: t.identity_param,
        })),
      });
      return data as { created: string[]; kept: string[]; identity_lookup_path: string | null };
    },
    // Usuarios autorizados por conector (registro de identidad, modo platform_registry).
    listUsers: async (connectorId: string): Promise<{ users: ConnectorUserRow[] }> => {
      const { data } = await apiClient.get(`/admin/connectors/${connectorId}/users`);
      return data;
    },
    createUser: async (connectorId: string, body: ConnectorUserPayload): Promise<{ id: string }> => {
      const { data } = await apiClient.post(`/admin/connectors/${connectorId}/users`, body);
      return data;
    },
    updateUser: async (userId: string, body: Partial<ConnectorUserPayload>) => {
      await apiClient.patch(`/admin/connectors/users/${userId}`, body);
    },
    deleteUser: async (userId: string) => {
      await apiClient.delete(`/admin/connectors/users/${userId}`);
    },
  },

  tenants: {
    // ── CRUD de organizaciones (antes: apiClient crudo esparcido en las páginas) ──
    list: async () => {
      const { data } = await apiClient.get("/tenants");
      return data as TenantListRow[];
    },
    create: async (body: {
      id: string; name: string; plan: string;
      admin_email: string; admin_name: string; admin_password: string; personality_id: string;
    }) => {
      const { data } = await apiClient.post("/tenants", body);
      return data;
    },
    changePlan: async (id: string, plan: string) => {
      const { data } = await apiClient.patch(`/tenants/${id}`, { plan });
      return data;
    },
    suspend: async (id: string) => {
      const { data } = await apiClient.post(`/tenants/${id}/suspend`);
      return data;
    },
    activateTenant: async (id: string) => {
      const { data } = await apiClient.post(`/tenants/${id}/activate`);
      return data;
    },
    resetOnboarding: async (id: string) => {
      const { data } = await apiClient.post(`/tenants/${id}/reset-onboarding`);
      return data;
    },
    // Destructivo e irreversible — exige el tenant suspendido y el id como confirmación.
    deleteTenant: async (id: string) => {
      const { data } = await apiClient.delete(`/tenants/${id}`, { params: { confirm: id } });
      return data;
    },
    deletePlan: async (id: string) => {
      const { data } = await apiClient.delete(`/tenants/platform/plans/${id}`);
      return data;
    },
    platformTraffic: async () => {
      const { data } = await apiClient.get("/tenants/platform/traffic");
      return data as {
        daily: Array<{ day: string; event_type: string; total: number }>;
        per_tenant: Array<{ id: string; name: string; plan: string; status: string; queries_30d: number; ingests_30d: number; tokens_30d: number }>;
      };
    },
    platformCosts: async () => {
      const { data } = await apiClient.get("/tenants/platform/costs");
      return data as {
        available: boolean;
        total_usd: number;
        currency: string;
        daily: Array<{ ts: number; usd: number }>;
        reason?: string;
      };
    },
    listPlans: async () => {
      const { data } = await apiClient.get("/tenants/platform/plans");
      return data as { plans: PlanRow[] };
    },
    updatePlan: async (id: string, body: PlanBody) => {
      const { data } = await apiClient.patch(`/tenants/platform/plans/${id}`, body);
      return data;
    },
    createPlan: async (id: string, body: PlanBody) => {
      const { data } = await apiClient.post(`/tenants/platform/plans/${encodeURIComponent(id)}`, body);
      return data;
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
        // up: true = sano, false = caído, null = sin monitoreo (Prometheus no está).
        monitoring_available?: boolean;
        postgres: { up: boolean | null; connections: number; db_size_bytes: number; cache_hit_rate: number | null; deadlocks_total: number };
        redis: { up: boolean | null; memory_used_bytes: number; memory_max_bytes: number; connected_clients: number; keyspace_hit_rate: number | null; evicted_keys: number; fragmentation_ratio: number; slowlog_length: number; keys_by_db: Record<string, number> };
        backend: { up: boolean; total_requests: number; error_rate_5m: number; latency_p95_ms: number | null };
        groq: { by_model: Array<{ model: string; calls: Record<string, number>; total: number; errors: number }>; total_calls: number };
        app: { active_tenants: number; total_queries: number; total_cache_hits: number; total_ingests: number; quality: Record<string, number> };
        sparklines: { http_req_rate: Array<{ t: number; v: number }>; query_rate: Array<{ t: number; v: number }> };
        storage: { total_bytes: number | null; used_bytes: number | null; free_bytes: number | null; used_pct: number | null };
        backups: {
          daily: { filename: string; completed_at: number; size_bytes: number; age_hours: number; healthy: boolean; count: number } | null;
          weekly: { filename: string; completed_at: number; size_bytes: number; age_hours: number; healthy: boolean; count: number } | null;
          daily_history?: Array<{ filename: string; completed_at: number; size_bytes: number }>;
        } | null;
        // Memoria y carga del host (leídas de /proc — sin depender de Prometheus).
        server?: {
          mem_total_bytes: number | null; mem_available_bytes: number | null; mem_used_pct: number | null;
          load_1m: number | null; cpus: number | null; load_pct: number | null;
        };
      };
    },
    platformAlerts: async () => {
      const { data } = await apiClient.get("/tenants/platform/alerts");
      return data as {
        available: boolean;
        alerts: Array<{ name: string; severity: string; summary: string; since: string | null }>;
      };
    },
    platformErrors: async (limit = 50) => {
      const { data } = await apiClient.get(`/tenants/platform/errors?limit=${limit}`);
      return data as {
        errors: Array<{ ts: number; level: string; logger: string; message: string; detail?: string; count?: number }>;
      };
    },
    tenantHealth: async (tenantId: string) => {
      const { data } = await apiClient.get(`/tenants/${tenantId}/health`);
      return data as {
        activity: {
          last_query_at: string | null; last_ingest_at: string | null;
          queries_7d: number; ingests_7d: number; tokens_7d: number;
          queries_by_day: Array<{ day: string; queries: number }>;
        };
        ops: { waiting: number; attending: number; oldest_wait_min: number; handoffs_today: number };
        errors: Array<{ ts: number; level: string; logger: string; message: string; detail?: string; count?: number; tenant?: string | null }>;
        storage: {
          documents: number | null; schema_bytes: number;
          minio_bytes: number | null; minio_objects: number | null;
        };
      };
    },
    platformOps: async () => {
      const { data } = await apiClient.get("/tenants/platform/ops");
      return data as {
        queues: Array<{ tenant_id: string; tenant_name: string; waiting: number; attending: number; oldest_wait_min: number }>;
        handoffs_today: number;
      };
    },
    metrics: async (tenantId: string) => {
      const { data } = await apiClient.get(`/tenants/${tenantId}/metrics`);
      return data as {
        tenant: { id: string; name: string; plan: string; status: string; admin_email: string; created_at: string; limits: Record<string, number> };
        usage: { queries_today: number; queries_7d: number; queries_30d: number; ingests_30d: number; llm_tokens_30d: number; daily: Array<{ day: string; total: number }> };
        docs: { total: number; ready: number; failed: number; processing: number; storage_bytes: number };
        performance: { latency_p50: number | null; latency_p95: number | null; cache_hit_rate: number | null; total_logged: number };
        quality: { passed: number; pending: number; skipped: number };
        quota: { queries_month: { used: number; limit: number; pct: number | null }; documents: { used: number; limit: number; pct: number | null } };
        recent_queries: Array<{ question_text: string | null; latency_ms: number; from_cache: boolean; created_at: string }>;
      };
    },
    listUsers: async (tenantId: string): Promise<Array<{ id: string; email: string; name: string; role: string; is_active: boolean; created_at: string | null }>> => {
      const { data } = await apiClient.get(`/tenants/${tenantId}/users`);
      return data;
    },
    updateUser: async (tenantId: string, userId: string, payload: { name?: string; role?: string; is_active?: boolean; password?: string }) => {
      const { data } = await apiClient.patch(`/tenants/${tenantId}/users/${userId}`, payload);
      return data;
    },
    createAdmin: async (tenantId: string, payload: { email: string; name: string; password?: string }) => {
      const { data } = await apiClient.post(`/tenants/${tenantId}/admin`, payload);
      return data;
    },
    generateWidgetToken: async (tenantId: string): Promise<WidgetTokenResponse> => {
      const { data } = await apiClient.post<WidgetTokenResponse>(`/tenants/${tenantId}/widget-token`);
      return data;
    },
    // Token ACTUAL (descifrado) sin regenerar. 404 si fue generado antes de
    // guardarse cifrado (hay que regenerar una vez).
    getWidgetToken: async (tenantId: string): Promise<WidgetTokenResponse> => {
      const { data } = await apiClient.get<WidgetTokenResponse>(`/tenants/${tenantId}/widget-token`);
      return data;
    },
    listEmailDomains: async (tenantId: string): Promise<Array<{ domain: string; is_primary: boolean; created_at: string | null }>> => {
      const { data } = await apiClient.get(`/tenants/${tenantId}/email-domains`);
      return data;
    },
    addEmailDomain: async (tenantId: string, domain: string, is_primary = false) => {
      const { data } = await apiClient.post(`/tenants/${tenantId}/email-domains`, { domain, is_primary });
      return data;
    },
    removeEmailDomain: async (tenantId: string, domain: string) => {
      await apiClient.delete(`/tenants/${tenantId}/email-domains/${encodeURIComponent(domain)}`);
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
    onboardingTestQuery: async (tenantId: string, payload: { question: string; bot_description: string }): Promise<{ answer: string }> => {
      const { data } = await apiClient.post(`/tenants/${tenantId}/onboarding/test-query`, payload);
      return data;
    },
    onboardingFollowup: async (
      tenantId: string,
      payload: OnboardingFollowupRequest,
    ): Promise<{ question: string | null }> => {
      const { data } = await apiClient.post(`/tenants/${tenantId}/onboarding/followup`, payload);
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
    uploadAttachment: async (id: string, file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      // multipart explícito: el default "application/json" del apiClient pisa el
      // boundary del FormData y el backend recibe el form vacío (422 "file required").
      // Mismo patrón que documents.upload y branding logo.
      const { data } = await apiClient.post(`/operator/conversations/${id}/attachment`, fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      return data as { message_id: string; attachment_name: string; attachment_mime: string };
    },
    /** Descarga el adjunto como blob (con el header de auth) y devuelve un object URL. */
    attachmentBlobUrl: async (id: string, messageId: string) => {
      const { data } = await apiClient.get(`/operator/conversations/${id}/attachment/${messageId}`, { responseType: "blob" });
      return URL.createObjectURL(data as Blob);
    },
    transfer: async (id: string, sectorId: string, message?: string) => {
      await apiClient.post(`/operator/conversations/${id}/transfer`, { sector_id: sectorId, message });
    },
    release: async (id: string) => { await apiClient.post(`/operator/conversations/${id}/release`); },
    /** Cierra el handoff humano y devuelve la conversación al bot. La sesión sigue activa. */
    returnToBot: async (id: string) => { await apiClient.post(`/operator/conversations/${id}/return-to-bot`); },
    close:   async (id: string) => { await apiClient.post(`/operator/conversations/${id}/close`); },
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
    // Mapa operador_id -> sectores para todo el tenant en una sola request
    // (evita el N+1 de pedir los sectores de cada operador por separado).
    getOperatorsSectorsMap: async () => {
      const { data } = await apiClient.get(`/admin/operators/sectors-map`);
      return data as Record<string, Array<{ id: string; nombre: string }>>;
    },
    getSectorOperators: async (sectorId: string) => {
      const { data } = await apiClient.get(`/admin/sectors/${sectorId}/operators`);
      return data as Array<{ id: string; name: string; email: string; is_active: boolean }>;
    },
    assignOperatorSectors: async (operatorId: string, sectorIds: string[]) => {
      await apiClient.post(`/admin/operators/${operatorId}/sectors`, { sector_ids: sectorIds });
    },
  },

  handoffConfig: {
    get: async () => { const { data } = await apiClient.get("/admin/handoff-config"); return data as HandoffConfig; },
    update: async (payload: Partial<HandoffConfig>) => { await apiClient.patch("/admin/handoff-config", payload); },
  },

  // Feedback del afiliado (caritas al cierre) — cola de revisión del admin
  adminFeedback: {
    list: async (params?: { status_filter?: string; rating?: number; page?: number; page_size?: number }) => {
      const { data } = await apiClient.get("/admin/feedback", { params });
      return data as FeedbackListResponse;
    },
    resolve: async (conversationId: string, action: FeedbackAction) => {
      const { data } = await apiClient.post(`/admin/feedback/${conversationId}/resolve`, { action });
      return data as { status: string; action: string };
    },
  },

  duplicates: {
    list: async () => { const { data } = await apiClient.get<DuplicatesResponse>("/duplicates?page_size=100"); return data; },
    resolve: async (pairId: string, action: "keep_a" | "keep_b" | "keep_both") => {
      await apiClient.post(`/duplicates/${pairId}/resolve`, { action });
    },
    /**
     * Edita el texto de uno de los chunks (A o B) en un par de duplicados.
     * Backend re-embeddea el texto y actualiza Qdrant + snapshot del par.
     */
    editChunk: async (
      pairId: string,
      which: "a" | "b",
      newText: string,
    ): Promise<{ pair_id: string; which: "a" | "b"; chunk_id: string; text: string }> => {
      const { data } = await apiClient.patch(
        `/duplicates/${pairId}/chunks/${which}`,
        { text: newText },
      );
      return data;
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
    test: async (contenido: string, messages: { role: "user" | "bot"; content: string }[]) => {
      const { data } = await apiClient.post("/superadmin/prompt-templates/test", { contenido, messages });
      return data as { answer: string; latency_ms: number };
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
      return data as SystemComponent[];
    },
    // Override de un módulo del registro (pisa el default del código).
    saveComponentOverride: async (slug: string, contenido: string) => {
      const { data } = await apiClient.put(`/superadmin/system-components/${slug}/override`, { contenido });
      return data as { slug: string; has_override: boolean };
    },
    // Borra el override → el módulo vuelve al default versionado en código.
    deleteComponentOverride: async (slug: string) => {
      const { data } = await apiClient.delete(`/superadmin/system-components/${slug}/override`);
      return data as { slug: string; has_override: boolean };
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
      return data as { max_prompt_templates: number; bots: TenantBot[] };
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

  // NOTA: el cliente de /entities se eliminó junto con la página /admin/entities
  // (backend ENTITIES_DISABLED). Si la feature vuelve, está en el historial de git.

  audit: {
    list: async (params?: { limit?: number; offset?: number; action?: string; search?: string; dateFrom?: string; dateTo?: string }) => {
      const q = new URLSearchParams();
      if (params?.limit)    q.set("limit",     String(params.limit));
      if (params?.offset)   q.set("offset",    String(params.offset));
      if (params?.action)   q.set("action",    params.action);
      if (params?.search)   q.set("search",    params.search);
      if (params?.dateFrom) q.set("date_from", params.dateFrom);
      if (params?.dateTo)   q.set("date_to",   params.dateTo);
      const { data } = await apiClient.get(`/audit?${q}`);
      return data as {
        total: number; offset: number; limit: number;
        events: AuditEvent[];
      };
    },
    globalList: async (params?: { limit?: number; offset?: number; action?: string; tenant_filter?: string; dateFrom?: string; dateTo?: string }) => {
      const q = new URLSearchParams();
      if (params?.limit)         q.set("limit",         String(params.limit));
      if (params?.offset)        q.set("offset",        String(params.offset));
      if (params?.action)        q.set("action",        params.action);
      if (params?.tenant_filter) q.set("tenant_filter", params.tenant_filter);
      if (params?.dateFrom)      q.set("date_from",     params.dateFrom);
      if (params?.dateTo)        q.set("date_to",       params.dateTo);
      const { data } = await apiClient.get(`/superadmin/audit?${q}`);
      return data as {
        total: number; offset: number; limit: number;
        tenants: string[];
        events: (AuditEvent & { tenant_id: string })[];
      };
    },
  },

  // ── Canales de atención (widget / WhatsApp) ────────────────────────────────
  channels: {
    get: async (): Promise<ChannelsState> => {
      const { data } = await apiClient.get<ChannelsState>("/admin/channels");
      return data;
    },
    toggleWidget: async (enabled: boolean): Promise<void> => {
      await apiClient.put("/admin/channels/widget", { enabled });
    },
    saveWhatsApp: async (payload: {
      phone_number_id: string;
      waba_id?: string | null;
      access_token?: string | null;  // vacío en edición = mantener el guardado
      app_secret?: string | null;    // vacío = mantener el guardado
    }): Promise<{ status: string; verify_token: string; webhook_url: string }> => {
      const { data } = await apiClient.put("/admin/channels/whatsapp", payload);
      return data;
    },
    testWhatsApp: async (): Promise<{ status: string; display_phone: string | null; verified_name: string | null }> => {
      const { data } = await apiClient.post("/admin/channels/whatsapp/test");
      return data;
    },
    toggleWhatsApp: async (enabled: boolean): Promise<void> => {
      await apiClient.put("/admin/channels/whatsapp/toggle", { enabled });
    },
    deleteWhatsApp: async (): Promise<void> => {
      await apiClient.delete("/admin/channels/whatsapp");
    },
  },
};

export interface ChannelsState {
  widget: { enabled: boolean; has_token: boolean };
  whatsapp: null | {
    configured: boolean;
    enabled: boolean;
    status: "pending" | "active" | "error" | "disabled" | string;
    phone_number_id: string;
    waba_id: string | null;
    display_phone: string | null;
    verify_token: string;
    has_app_secret: boolean;
    last_verified_at: string | null;
  };
  webhook_url: string;
}

export interface PromptTemplate {
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
// Prompt del motor servido desde el registro en código (prompt_registry.py).
// contenido = texto efectivo (override si hay, default si no); null en los
// internos que viven junto a su consumidor (solo se lista su ubicación).
export interface SystemComponent {
  slug: string; nombre: string; descripcion: string | null; consumer: string;
  editable: boolean; has_override: boolean;
  default_text: string | null; contenido: string | null;
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

