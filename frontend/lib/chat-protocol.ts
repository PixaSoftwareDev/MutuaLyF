/**
 * Protocolo de conversación del chat — SIN React ni DOM.
 *
 * Una sola implementación de todo lo que hablan con el backend los clientes de
 * chat (pantalla /chat del link y del tester, y el widget embebido): token y
 * renovación ante 401, start/reanudar, long-poll con ancla monotónica (seq),
 * envío con mensaje optimista, adjuntos, sector elegido, derivación, feedback,
 * conversación cerrada (410) → nueva. Antes cada cliente lo reimplementaba y
 * divergían (auditoría 2026-09-25, docs/PLAN_CHAT_UX_CONSOLIDADO.md, bloque E).
 *
 * Estado observable: `subscribe(fn)` + `getState()`. Los mensajes locales
 * (errores, optimistas) viven aparte de los del servidor y se mezclan al
 * exponer el estado, así un poll nunca los borra.
 */

export type ChatRole = "user" | "bot" | "operator" | "system";
export type ChatStatus = "bot_active" | "handoff_requested" | "human_attending" | "closed";

export interface ChatMessage {
  id: string;
  /** Secuencia monotónica del servidor (null en mensajes locales). */
  seq: number | null;
  role: ChatRole | "error";
  content: string;
  createdAt: string;
  /** Cartel de oferta de derivación (se dibuja como tarjeta toda su vida). */
  handoffOffer: boolean;
  /** "Consulta dirigida al área X": píldora en su lugar de la cronología. */
  sectorNote: boolean;
  attachment: { name: string; mime: string; size?: number | null } | null;
  /** Solo en mensajes locales: optimista (aún no confirmado) o error. */
  local?: true;
  /** Acción de reintento para burbujas de error locales. */
  retry?: () => void;
}

export interface ChatSector { id: string; nombre: string; descripcion: string | null; is_default: boolean; }

export interface ChatState {
  conversationId: string | null;
  status: ChatStatus;
  operatorName: string | null;
  /** Sector vigente según el servidor (elegido o default). */
  sectorId: string | null;
  /** true si el afiliado ELIGIÓ un sector en esta conversación (hay nota). */
  sectorChosen: boolean;
  botTyping: boolean;
  afiliadoIdentified: boolean;
  feedbackGiven: boolean;
  /** Conversación anterior cerrada sin calificar (reapertura), para ofrecer las caritas una vez. */
  prevFeedbackConvId: string | null;
  /** Mensajes del servidor + locales, en orden. */
  messages: ChatMessage[];
  /** Cantidad de envíos en vuelo (texto o adjunto). */
  sending: number;
  /** Fallo fatal (token, canal apagado, red al arrancar): la pantalla muestra el error grande. */
  fatal: { status: number | null } | null;
  sectors: ChatSector[];
  sectorsLoaded: boolean;
}

export interface ChatProtocolOptions {
  apiBase: string;
  tenantId: string;
  /** widget_session_id estable por navegador. */
  sessionId: string;
  /** Canal con el que nacen las conversaciones. */
  channel: "widget" | "link";
  /** Emite un token (público del canal, del tester o el del widget). Puede lanzar { status }. */
  getToken: () => Promise<string>;
  /** Textos para las burbujas de error locales (i18n simple). */
  texts?: Partial<typeof DEFAULT_TEXTS>;
}

export const DEFAULT_TEXTS = {
  sendFailed: "No se pudo enviar el mensaje.",
  sendRetry: "Reintentar",
  networkDown: "Sin conexión. Revisá tu internet e intentá de nuevo.",
  rateLimited: "Se alcanzó el límite de consultas por ahora. Esperá unos minutos e intentá de nuevo.",
  serverError: "El servicio está teniendo un problema temporal. Intentá de nuevo en unos minutos.",
  attachType: "Solo se pueden enviar imágenes (PNG/JPG/WEBP) o PDF.",
  attachSize: "El archivo supera el máximo de 10 MB.",
  attachFailed: "No se pudo enviar el archivo. Probá de nuevo.",
  handoffFailed: "No se pudo conectar con un operador. Probá de nuevo.",
};

export const ALLOWED_ATTACHMENT_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/webp", "application/pdf"];
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

type Listener = (state: ChatState) => void;

interface ServerMessage {
  id: string; seq?: number | null; sender_type: string; content: string; created_at?: string;
  is_handoff_offer?: boolean; is_sector_note?: boolean;
  attachment_name?: string | null; attachment_mime?: string | null; attachment_size?: number | null;
}

let localCounter = 0;
const localId = (prefix: string) => `local-${prefix}-${Date.now()}-${++localCounter}`;

export class ChatProtocol {
  private readonly opts: ChatProtocolOptions;
  private readonly texts: typeof DEFAULT_TEXTS;
  private listeners = new Set<Listener>();
  private token = "";
  private renewing: Promise<string> | null = null;

  private serverMessages: ChatMessage[] = [];
  private localMessages: ChatMessage[] = [];
  private lastSeq: number | null = null;
  private lastMessageId: string | null = null;
  /** id del servidor → id del optimista que confirmó (los clientes reusan la fila). */
  readonly confirmedLocal = new Map<string, string>();

  // Long-poll: una versión por loop para que un loop viejo (conversación
  // renovada) muera al despertar en vez de correr en paralelo.
  private pollVersion = 0;
  private pollAlive = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollErrors = 0;
  private starting: Promise<void> | null = null;
  // Generación de vida: stop() la incrementa y un _start en curso, al despertar
  // de cada await, ve que quedó viejo y no arranca el poll (antes el long-poll
  // seguía vivo si la pantalla se cerraba durante el arranque).
  private lifeGen = 0;
  private startingGen = -1;

  private state: ChatState = {
    conversationId: null,
    status: "bot_active",
    operatorName: null,
    sectorId: null,
    sectorChosen: false,
    botTyping: false,
    afiliadoIdentified: false,
    feedbackGiven: false,
    prevFeedbackConvId: null,
    messages: [],
    sending: 0,
    fatal: null,
    sectors: [],
    sectorsLoaded: false,
  };

  constructor(opts: ChatProtocolOptions) {
    this.opts = opts;
    this.texts = { ...DEFAULT_TEXTS, ...(opts.texts || {}) };
  }

  // ── Observable ─────────────────────────────────────────────────────────────

  getState(): ChatState { return this.state; }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private set(partial: Partial<ChatState>) {
    this.state = { ...this.state, ...partial };
    this.listeners.forEach(fn => fn(this.state));
  }

  private emitMessages() {
    this.set({ messages: [...this.serverMessages, ...this.localMessages] });
  }

  // ── Token ──────────────────────────────────────────────────────────────────

  private async ensureToken(): Promise<string> {
    if (this.token) return this.token;
    this.token = await this.opts.getToken();
    return this.token;
  }

  private renewToken(): Promise<string> {
    if (!this.renewing) {
      this.renewing = this.opts.getToken()
        .then(t => { this.token = t; return t; })
        .finally(() => { this.renewing = null; });
    }
    return this.renewing;
  }

  /** fetch con Bearer + X-Tenant-ID; ante 401 renueva el token UNA vez y reintenta. */
  async authFetch(url: string, init: RequestInit = {}, json = true): Promise<Response> {
    await this.ensureToken();
    const build = (): Record<string, string> => ({
      ...((init.headers as Record<string, string>) || {}),
      ...(json ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${this.token}`,
      "X-Tenant-ID": this.opts.tenantId,
    });
    let r = await fetch(url, { ...init, headers: build() });
    if (r.status === 401) {
      try { await this.renewToken(); } catch { return r; }
      r = await fetch(url, { ...init, headers: build() });
    }
    return r;
  }

  private url(path: string): string { return `${this.opts.apiBase}/api/v1${path}`; }

  attachmentUrl(messageId: string): string | null {
    const cid = this.state.conversationId;
    if (!cid) return null;
    return this.url(`/widget/conversation/${cid}/attachment/${messageId}?widget_session_id=${encodeURIComponent(this.opts.sessionId)}`);
  }

  // ── Sectores ───────────────────────────────────────────────────────────────

  async loadSectors(): Promise<void> {
    try {
      const r = await this.authFetch(this.url("/widget/sectors"));
      if (!r.ok) throw new Error(String(r.status));
      const data = await r.json();
      this.set({ sectors: (data.sectors || []) as ChatSector[], sectorsLoaded: true });
    } catch {
      // Los sectores son opcionales (solo importan al derivar): no bloquean el chat.
      this.set({ sectorsLoaded: true });
    }
  }

  // ── Conversación ───────────────────────────────────────────────────────────

  /** Arranca (o reanuda) la conversación. Si ya hay un arranque en curso, lo reusa. */
  start(pendingMessage?: string): Promise<void> {
    if (this.starting && this.startingGen === this.lifeGen) {
      // Ya hay un arranque de esta vida: se reusa, y el mensaje pendiente se
      // envía cuando termine (antes se descartaba en silencio).
      const running = this.starting;
      return pendingMessage ? running.then(() => this.send(pendingMessage)) : running;
    }
    const gen = this.lifeGen;
    this.startingGen = gen;
    const p: Promise<void> = this._start(pendingMessage, gen).finally(() => {
      if (this.starting === p) this.starting = null;
    });
    this.starting = p;
    return p;
  }

  private async _start(pendingMessage: string | undefined, gen: number): Promise<void> {
    const alive = () => gen === this.lifeGen;
    this.stopPolling();
    this.serverMessages = [];
    this.localMessages = [];
    this.lastSeq = null;
    this.lastMessageId = null;
    this.set({
      conversationId: null, status: "bot_active", operatorName: null, sectorId: null,
      sectorChosen: false, botTyping: false, afiliadoIdentified: false, feedbackGiven: false,
      messages: [], fatal: null,
    });
    try {
      await this.ensureToken();
    } catch (e) {
      if (alive()) this.set({ fatal: { status: (e as { status?: number })?.status ?? null } });
      return;
    }
    if (!alive()) return;
    try {
      const r = await this.authFetch(this.url("/widget/conversation/start"), {
        method: "POST",
        body: JSON.stringify({ widget_session_id: this.opts.sessionId, channel: this.opts.channel }),
      });
      if (!alive()) return;
      if (!r.ok) { this.set({ fatal: { status: r.status } }); return; }
      const data = await r.json();
      if (!alive()) return;
      this.set({
        conversationId: data.conversation_id,
        status: (data.status || "bot_active") as ChatStatus,
        prevFeedbackConvId: data.prev_feedback_pending ?? null,
      });
      await this.poll(data.conversation_id, true);
      if (!alive()) return;
      this.startPolling(data.conversation_id);
      if (pendingMessage) await this.send(pendingMessage);
    } catch {
      if (alive()) this.set({ fatal: { status: null } });
    }
  }

  /** Nueva conversación explícita (botón "Nueva consulta" tras un cierre). */
  async restart(): Promise<void> {
    await this.start();
  }

  stop(): void {
    this.lifeGen++;
    this.stopPolling();
    this.pollVersion++;
  }

  private stopPolling() {
    this.pollAlive = false;
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
  }

  private startPolling(convId: string) {
    this.stopPolling();
    this.pollAlive = true;
    this.pollErrors = 0;
    const myVersion = ++this.pollVersion;
    const loop = async () => {
      if (!this.pollAlive || this.pollVersion !== myVersion) return;
      const ok = await this.poll(convId);
      if (!this.pollAlive || this.pollVersion !== myVersion) return;
      // Backoff ante errores (red caída, 5xx): 1 s, 2 s, 4 s… hasta 30 s.
      // Backoff ante errores (red caída, 5xx): 1 s, 2 s, 4 s… hasta 30 s. Con la
      // pestaña/app oculta el poll se espacia (15 s); al volver, los clientes
      // llaman refresh() y el loop retoma el ritmo normal.
      const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
      const delay = !ok ? Math.min(30000, 1000 * 2 ** Math.min(this.pollErrors, 5)) : hidden ? 15000 : 250;
      this.pollTimer = setTimeout(loop, delay);
    };
    loop();
  }

  /** Un ciclo de poll. `force` pide el snapshot ya (sin esperar novedades). */
  async poll(convId: string, force = false): Promise<boolean> {
    try {
      const qs = new URLSearchParams({ widget_session_id: this.opts.sessionId });
      if (force) qs.set("force", "1");
      else if (this.lastSeq !== null) qs.set("last_seq", String(this.lastSeq));
      // El servidor también responde ya si el estado cambió (operador tomó la
      // charla entre dos polls): sin esto el cambio esperaba el próximo evento.
      if (!force) qs.set("last_status", this.state.status);
      else if (this.lastMessageId) qs.set("last_message_id", this.lastMessageId);
      const r = await this.authFetch(this.url(`/widget/conversation/${convId}/poll?${qs.toString()}`));
      if (!r.ok) {
        this.pollErrors++;
        return false;
      }
      this.pollErrors = 0;
      const data = await r.json();
      if (this.state.conversationId !== convId) return true; // llegó tarde, de otra conversación
      this.applySnapshot(data);
      return true;
    } catch {
      this.pollErrors++;
      return false;
    }
  }

  /** "Volví a la app": snapshot inmediato, sin abrir otro long-poll paralelo. */
  async refresh(): Promise<void> {
    const cid = this.state.conversationId;
    if (cid) await this.poll(cid, true);
  }

  private applySnapshot(data: {
    status?: string; operator_name?: string | null; sector_id?: string | null; bot_typing?: boolean;
    afiliado_identified?: boolean; feedback_given?: boolean; messages?: ServerMessage[];
  }) {
    const msgs: ChatMessage[] = (data.messages || []).map(m => ({
      id: m.id,
      seq: typeof m.seq === "number" ? m.seq : null,
      role: (m.sender_type as ChatRole) || "bot",
      content: m.content,
      createdAt: m.created_at || new Date().toISOString(),
      handoffOffer: Boolean(m.is_handoff_offer),
      sectorNote: Boolean(m.is_sector_note),
      attachment: m.attachment_name ? { name: m.attachment_name, mime: m.attachment_mime || "", size: m.attachment_size ?? null } : null,
    }));
    this.serverMessages = msgs;
    if (msgs.length) {
      const last = msgs[msgs.length - 1];
      this.lastMessageId = last.id;
      const maxSeq = msgs.reduce((acc, m) => (m.seq !== null && m.seq > acc ? m.seq : acc), -1);
      this.lastSeq = maxSeq >= 0 ? maxSeq : null;
    }
    // Los optimistas se retiran cuando el servidor ya trae ese mensaje del
    // usuario (mismo contenido, posterior a cuando se envió). Cada mensaje del
    // servidor confirma A LO SUMO un optimista: con "hola" dos veces seguidas,
    // el primero confirmado ya no se lleva también al segundo.
    const used = new Set<string>();
    this.localMessages = this.localMessages.filter(l => {
      if (l.role !== "user") return true;
      const match = msgs.find(m =>
        !used.has(m.id) && m.role === "user" && m.content === l.content
        && (l.seq === null || (m.seq ?? 0) > l.seq));
      if (match) { used.add(match.id); this.confirmedLocal.set(match.id, l.id); return false; }
      return true;
    });
    const status = (data.status || this.state.status) as ChatStatus;
    this.set({
      status,
      operatorName: data.operator_name ?? null,
      sectorId: data.sector_id ?? null,
      sectorChosen: msgs.some(m => m.sectorNote),
      botTyping: Boolean(data.bot_typing),
      afiliadoIdentified: Boolean(data.afiliado_identified),
      feedbackGiven: Boolean(data.feedback_given),
      messages: [...this.serverMessages, ...this.localMessages],
    });
  }

  // ── Mensajes locales ───────────────────────────────────────────────────────

  private pushLocal(msg: Omit<ChatMessage, "local" | "seq" | "createdAt" | "handoffOffer" | "sectorNote" | "attachment"> & Partial<ChatMessage>) {
    this.localMessages.push({
      seq: this.lastSeq, createdAt: new Date().toISOString(),
      handoffOffer: false, sectorNote: false, attachment: null,
      ...msg, local: true,
    });
    this.emitMessages();
  }

  private removeLocal(id: string) {
    this.localMessages = this.localMessages.filter(m => m.id !== id);
    this.emitMessages();
  }

  private pushError(content: string, retry?: () => void) {
    this.pushLocal({ id: localId("err"), role: "error", content, retry });
  }

  /** Descarta una burbuja de error local (p. ej. al reintentar). */
  dismissLocal(id: string) { this.removeLocal(id); }

  private errorTextFor(status: number): string {
    if (status === 429) return this.texts.rateLimited;
    if (status >= 500) return this.texts.serverError;
    return this.texts.sendFailed;
  }

  // ── Enviar ─────────────────────────────────────────────────────────────────

  async send(text: string): Promise<void> {
    const content = text.trim();
    if (!content) return;
    const optimisticId = localId("user");
    this.pushLocal({ id: optimisticId, role: "user", content });
    this.set({ sending: this.state.sending + 1 });
    try {
      // Enviado mientras la conversación arranca (o se reinicia tras un 410):
      // se espera el arranque en vez de descartar el texto en silencio.
      let cid = this.state.conversationId;
      if (!cid && this.starting) {
        await this.starting;
        cid = this.state.conversationId;
      }
      if (!cid) {
        this.removeLocal(optimisticId);
        this.pushError(this.texts.networkDown, () => this.send(content));
        return;
      }
      const r = await this.authFetch(this.url(`/widget/conversation/${cid}/message`), {
        method: "POST",
        body: JSON.stringify({ content, widget_session_id: this.opts.sessionId }),
      });
      if (r.status === 410) {
        // Cerrada por el operador/inactividad: nueva conversación y reenvío.
        this.removeLocal(optimisticId);
        await this.start(content);
        return;
      }
      if (r.status === 401 || r.status === 403) {
        this.set({ fatal: { status: r.status } });
        return;
      }
      if (!r.ok) {
        this.removeLocal(optimisticId);
        this.pushError(this.errorTextFor(r.status), () => this.send(content));
        return;
      }
      const data = await r.json().catch(() => ({}));
      if (data && typeof data.status === "string") this.set({ status: data.status as ChatStatus });
      // La respuesta del bot y los carteles llegan por el poll.
    } catch {
      this.removeLocal(optimisticId);
      this.pushError(this.texts.networkDown, () => this.send(content));
    } finally {
      this.set({ sending: Math.max(0, this.state.sending - 1) });
    }
  }

  // ── Adjuntos ───────────────────────────────────────────────────────────────

  async uploadAttachment(file: File): Promise<void> {
    const cid = this.state.conversationId;
    if (!cid) return;
    if (!ALLOWED_ATTACHMENT_TYPES.includes(file.type)) { this.pushError(this.texts.attachType); return; }
    if (file.size > MAX_ATTACHMENT_BYTES) { this.pushError(this.texts.attachSize); return; }
    this.set({ sending: this.state.sending + 1 });
    try {
      const fd = new FormData();
      fd.append("widget_session_id", this.opts.sessionId);
      fd.append("file", file);
      const r = await this.authFetch(this.url(`/widget/conversation/${cid}/attachment`), { method: "POST", body: fd }, false);
      if (r.status === 410) { await this.start(); return; }
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        const detail = typeof data?.detail === "string" ? data.detail : this.texts.attachFailed;
        this.pushError(detail);
        return;
      }
      await this.poll(cid, true);
    } catch {
      this.pushError(this.texts.networkDown);
    } finally {
      this.set({ sending: Math.max(0, this.state.sending - 1) });
    }
  }

  // ── Sector ─────────────────────────────────────────────────────────────────

  /** Persiste el sector elegido (sin derivar). La píldora llega por el poll. */
  async setSector(sectorId: string): Promise<boolean> {
    const cid = this.state.conversationId;
    if (!cid) return false;
    try {
      const r = await this.authFetch(this.url(`/widget/conversation/${cid}/sector`), {
        method: "PATCH",
        body: JSON.stringify({ widget_session_id: this.opts.sessionId, sector_id: sectorId }),
      });
      if (r.status === 410) { await this.start(); return false; }
      if (!r.ok) return false;
      this.set({ sectorId, sectorChosen: true });
      await this.poll(cid, true);
      return true;
    } catch {
      return false;
    }
  }

  // ── Derivación ─────────────────────────────────────────────────────────────

  async confirmHandoff(identif?: { afiliado_nombre?: string; afiliado_dni?: string; sector_id?: string }): Promise<boolean> {
    const cid = this.state.conversationId;
    if (!cid) return false;
    const payload = { ...(identif || {}) };
    if (!payload.sector_id && this.state.sectorChosen && this.state.sectorId) payload.sector_id = this.state.sectorId;
    const hasBody = Boolean(payload.afiliado_nombre || payload.afiliado_dni || payload.sector_id);
    try {
      const r = await this.authFetch(
        this.url(`/widget/conversation/${cid}/confirm-handoff?widget_session_id=${encodeURIComponent(this.opts.sessionId)}`),
        { method: "POST", body: hasBody ? JSON.stringify(payload) : undefined },
        hasBody,
      );
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        const detail =
          typeof data?.detail === "string" ? data.detail :
          Array.isArray(data?.detail) ? (data.detail[0]?.msg ?? "") : "";
        this.pushError(detail || this.texts.handoffFailed);
        return false;
      }
      if (typeof data.status === "string") this.set({ status: data.status as ChatStatus });
      // El mensaje de confirmación lo persiste el backend: llega por el poll.
      await this.poll(cid, true);
      return true;
    } catch {
      this.pushError(this.texts.networkDown);
      return false;
    }
  }

  // ── Feedback ───────────────────────────────────────────────────────────────

  async submitFeedback(rating: number, reason: string | null, targetConvId?: string): Promise<boolean> {
    const cid = targetConvId ?? this.state.conversationId;
    if (!cid) return false;
    try {
      const r = await this.authFetch(
        this.url(`/widget/conversation/${cid}/feedback?widget_session_id=${encodeURIComponent(this.opts.sessionId)}`),
        { method: "POST", body: JSON.stringify({ rating, ...(reason ? { reason } : {}) }) },
      );
      if (r.ok || r.status === 409) {
        if (targetConvId) this.set({ prevFeedbackConvId: null });
        else this.set({ feedbackGiven: true });
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  clearPrevFeedback() { this.set({ prevFeedbackConvId: null }); }
}

/** widget_session_id estable por navegador y por tenant (y por modo prueba). */
export function getOrCreateSessionId(storageKey: string): string {
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored) return stored;
    const id = "cs_" + Date.now() + "_" + Math.random().toString(36).slice(2, 9);
    localStorage.setItem(storageKey, id);
    return id;
  } catch {
    return "cs_" + Date.now() + "_" + Math.random().toString(36).slice(2, 9);
  }
}
