'use client';

/**
 * AEGIS client store — a module-level singleton that holds messages,
 * loading state, mode, and the active in-flight request OUTSIDE the
 * React component tree. AEGIS responses can take 30–120 s; users must
 * be able to navigate to /kb, /assess, etc. while a request is in
 * flight without losing it.
 *
 * The store is consumed via React's `useSyncExternalStore`. Because
 * `app/layout.tsx` does not unmount between SPA navigations and the
 * store lives at module scope, in-flight requests and accumulated
 * messages survive every internal navigation.
 *
 * No external state management library — just a Set<listener> and a
 * snapshot reference that gets replaced on every state mutation.
 */

import { vmark } from './voice-debug';
import { chunkText, extractSpeechChunks } from './speech-chunk';
import {
  ABNORMAL_END_DRAFT_NOTE_DE,
  TIMEOUT_DRAFT_NOTE_DE,
  SECTIONED_DEGRADED_REASON_DE,
  SECTIONED_FAILED_DE,
  SECTIONED_PAUSED_DE,
  SECTION_WRITING_DE,
  apiErrorMessageDe,
} from './statusLabels';

/**
 * Voice Mode sentence sink (Phase 1). AegisVoiceMode registers one of these so
 * the store can hand it COMPLETE sentences as the token stream arrives, letting
 * TTS start on the first sentence instead of waiting for the `done` event.
 *
 *  - onSentence(raw): a complete sentence is ready (raw — caller cleans/speaks).
 *  - onRetract():     streamed text was withdrawn (pre-tool reasoning dropped,
 *                     verify retry, or a full replace) — stop + clear the queue.
 *  - onComplete(rest): the turn finished; `rest` is the final incomplete tail
 *                     (may be ''), spoken to round off the answer.
 *
 * Null in text chat and whenever Voice Mode is not mounted, so this is inert for
 * every non-voice path.
 */
export type VoiceSink = {
  onSentence: (raw: string) => void;
  onRetract: () => void;
  onComplete: (rest: string) => void;
};

let voiceSink: VoiceSink | null = null;
// Tail of streamed text not yet closed into a sentence. Module-level so
// handleSseEvent can accumulate across token events without threading state.
let voiceSentenceBuffer = '';

export function setVoiceSink(sink: VoiceSink | null): void {
  voiceSink = sink;
}

export type AegisMode =
  | 'ASSESS'
  | 'GAP_ANALYZE'
  | 'CONTROL_ADVISE'
  | 'CONVERSATIONAL';

export type ToolCallSummary = {
  name: string;
  input: unknown;
  resultPreview: string;
};

export type MessageMeta = {
  mode: string;
  model: string;
  cost: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    usd: number;
  };
  latency: number;
  citations: string[];
  verification:
    | {
        ok: true;
        checks: Record<string, 'pass' | 'warn'>;
        warnings?: Array<{ check: string; reason: string }>;
      }
    | { ok: false; failed: string; reason: string }
    /**
     * The server response carried no verification metadata (older persisted
     * turns, unexpected payloads). Rendered amber as "Verifizierungsstatus
     * unbekannt" — NEVER fabricated as a green all-pass (finding F7).
     */
    | { ok: 'unknown' };
  toolCalls: ToolCallSummary[];
  iterations: number;
  /**
   * Graceful degradation: `'iteration'`/`'cost'` (forced out at the ceiling) or
   * `'verify'` (report complete but citation verification could not finish in
   * time — shown with a "Verifizierung unvollständig" banner; `verification.ok`
   * stays false, so the UI never renders it as a verified success).
   */
  degraded?: 'iteration' | 'cost' | 'verify';
};

export type MessageAttachment = {
  /** Internal download id — used to build the href, never shown to the user. */
  downloadId: string;
  /** Real filename shown to the user and used for the browser download. */
  filename: string;
};

export type ChatMessage = {
  id: string;
  role: 'user' | 'aegis' | 'error';
  content: string;
  timestamp: number;
  meta?: MessageMeta;
  /** A generated downloadable artifact (e.g. the filled Excel gap register). */
  attachment?: MessageAttachment;
};

export type LatestCompletion = {
  id: string;
  createdAt: number;
  mode: string;
  citations: number;
  latency: number;
};

export type ToolProgress = {
  iteration: number;
  toolName: string;
  /** preview is filled in once the tool result arrives */
  preview?: string;
  isError?: boolean;
};

export type UploadedDocument = {
  id: string;
  filename: string;
  type: 'policy' | 'template';
  /** Detected source language (DeepL 2-letter base, e.g. "ES"); set on upload. */
  originalLanguage?: string | null;
  /** True when this chip points at a DeepL machine-translation working copy. */
  isTranslation?: boolean;
};

export type AegisStoreState = {
  messages: ChatMessage[];
  isLoading: boolean;
  mode: AegisMode;
  input: string;
  /**
   * Server-side conversation id (Phase 2 memory). Set from the `done` event,
   * mirrored to localStorage so a reload resumes the conversation; the server
   * transcript is authoritative — we never send chat history from the client.
   */
  conversationId: string | null;
  /** Progressive text accumulated from `token` events; cleared on completion */
  streamingText: string;
  /** Coarse phase used to drive the UI status line during a request */
  streamingPhase: 'tools' | 'generating' | null;
  /** Last status update from the server (tool name, iteration) */
  toolProgress: ToolProgress | null;
  /** Optional human-readable progress message from the server (e.g. "Setze Bericht fort …") */
  streamingMessage: string | null;
  /** Set when the server tells us verify failed and a retry is starting */
  retryNotice: string | null;
  /**
   * Most-recently-arrived AEGIS message. Banner / browser-notification
   * consumers compare this against a locally-tracked "lastSeenId" to
   * decide whether to surface a notification.
   */
  latestCompletion: LatestCompletion | null;
  /** Documents uploaded in the current session (max 2: 1 policy + 1 template) */
  uploadedDocuments: UploadedDocument[];
  /** True while an upload is in progress */
  isUploading: boolean;
  /**
   * Active SECTIONED job (PR 3). Non-null from `job_created`/`job_state` until
   * the terminal `job_done`/`job_failed`. While non-null the sectioned
   * lifecycle owns the turn: stream ends without `done` are expected (pause →
   * reconnect), never surfaced as errors (iron rule).
   */
  job: ActiveJob | null;
};

// ─────────────────────── Sectioned jobs (PR 3) ───────────────────────

export type SectionProgress = {
  index: number;
  title: string;
  status: 'pending' | 'writing' | 'done' | 'degraded';
  /** Streamed tokens (live) or persisted contentMd (resume snapshot). */
  text: string;
};

export type ActiveJob = {
  jobId: string;
  sections: SectionProgress[];
  cursor: number;
  /** 'running' while events flow; 'reconnecting' after a clean pause. */
  phase: 'running' | 'reconnecting';
  /** Client-side reconnect counter — reset whenever a section completes. */
  resumeAttempts: number;
};

/** What the store must DO after applying a sectioned event (pure signal). */
export type SectionedEffect =
  | { kind: 'none' }
  | { kind: 'resume' }
  | { kind: 'finalize'; degradedSections: number }
  | { kind: 'fail'; code: string; message: string };

/**
 * Pure reducer for the SECTIONED event set (F5). Exported for vitest reducer
 * tests (F6 — no Playwright). Returns the next job slice plus the effect the
 * store must execute; it never touches module state itself.
 */
export function applySectionedEvent(
  job: ActiveJob | null,
  ev: { type: string } & Record<string, unknown>,
): { job: ActiveJob | null; effect: SectionedEffect } {
  const none: SectionedEffect = { kind: 'none' };
  switch (ev.type) {
    case 'job_created': {
      const sections = (ev.sections as Array<{ index: number; title: string }> | undefined) ?? [];
      return {
        job: {
          jobId: String(ev.jobId ?? ''),
          sections: sections.map((s) => ({
            index: s.index,
            title: s.title,
            status: 'pending',
            text: '',
          })),
          cursor: 0,
          phase: 'running',
          resumeAttempts: 0,
        },
        effect: none,
      };
    }
    case 'job_state': {
      // Resume snapshot: authoritative section state incl. persisted content.
      const sections =
        (ev.sections as Array<{ index: number; title: string; status: string; contentMd?: string }> | undefined) ?? [];
      return {
        job: {
          jobId: String(ev.jobId ?? job?.jobId ?? ''),
          sections: sections.map((s) => ({
            index: s.index,
            title: s.title,
            status:
              s.status === 'done' || s.status === 'degraded'
                ? (s.status as 'done' | 'degraded')
                : 'pending',
            text: s.contentMd ?? '',
          })),
          cursor: Number(ev.cursor ?? 0),
          phase: 'running',
          resumeAttempts: job?.resumeAttempts ?? 0,
        },
        effect: none,
      };
    }
    case 'section_start': {
      if (!job) return { job, effect: none };
      const index = Number(ev.index ?? -1);
      return {
        job: {
          ...job,
          phase: 'running',
          sections: job.sections.map((s) =>
            s.index === index ? { ...s, status: 'writing' } : s,
          ),
        },
        effect: none,
      };
    }
    case 'section_token': {
      if (!job) return { job, effect: none };
      const index = Number(ev.index ?? -1);
      const text = typeof ev.text === 'string' ? ev.text : '';
      return {
        job: {
          ...job,
          sections: job.sections.map((s) =>
            s.index === index ? { ...s, text: s.text + text } : s,
          ),
        },
        effect: none,
      };
    }
    case 'section_done': {
      if (!job) return { job, effect: none };
      const index = Number(ev.index ?? -1);
      const status = ev.status === 'degraded' ? 'degraded' : 'done';
      return {
        job: {
          ...job,
          cursor: index + 1,
          resumeAttempts: 0, // real progress → reset the reconnect budget
          sections: job.sections.map((s) =>
            s.index === index ? { ...s, status } : s,
          ),
        },
        effect: none,
      };
    }
    case 'job_paused': {
      if (!job) return { job, effect: none };
      return {
        job: { ...job, phase: 'reconnecting', resumeAttempts: job.resumeAttempts + 1 },
        effect: { kind: 'resume' },
      };
    }
    case 'job_done': {
      if (!job) return { job, effect: none };
      const degradedSections = job.sections.filter((s) => s.status === 'degraded').length;
      return { job: null, effect: { kind: 'finalize', degradedSections } };
    }
    case 'job_failed': {
      return {
        job: null,
        effect: {
          kind: 'fail',
          code: String(ev.code ?? 'internal_error'),
          message: typeof ev.message === 'string' && ev.message ? ev.message : SECTIONED_FAILED_DE,
        },
      };
    }
    default:
      return { job, effect: none };
  }
}

/** Assemble the client-side report view from the job's sections (pure). */
export function joinJobSections(job: ActiveJob): string {
  return job.sections
    .filter((s) => s.text.trim().length > 0)
    .map((s) => `## ${s.title}\n\n${s.text.trim()}`)
    .join('\n\n');
}

const INITIAL_STATE: AegisStoreState = {
  messages: [],
  isLoading: false,
  mode: 'CONVERSATIONAL',
  input: '',
  conversationId: null,
  streamingText: '',
  streamingPhase: null,
  toolProgress: null,
  streamingMessage: null,
  retryNotice: null,
  latestCompletion: null,
  uploadedDocuments: [],
  isUploading: false,
  job: null,
};

// ─────────────────────────── Store internals ───────────────────────────

let state: AegisStoreState = INITIAL_STATE;
const listeners = new Set<() => void>();

function setState(partial: Partial<AegisStoreState>): void {
  state = { ...state, ...partial };
  for (const l of listeners) l();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSnapshot(): AegisStoreState {
  return state;
}

export function getServerSnapshot(): AegisStoreState {
  // SSR: render the initial empty state so hydration matches.
  return INITIAL_STATE;
}

// ─────────────────────────── Notifications ───────────────────────────

let permissionAsked = false;

function maybeRequestNotificationPermission(): void {
  if (typeof window === 'undefined') return;
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'default') return;
  if (permissionAsked) return;
  permissionAsked = true;
  // Fire-and-forget; user can grant later from browser UI.
  Notification.requestPermission().catch(() => {
    /* user dismissed; fall back to in-app banner only */
  });
}

function fireBrowserNotification(opts: {
  mode: string;
  citations: number;
}): void {
  if (typeof window === 'undefined') return;
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  // Only fire when the tab is in the background — if the user is looking
  // at the tab we let the in-app UI do the work.
  if (!document.hidden) return;
  try {
    new Notification('AEGIS — Analyse fertig', {
      body: `${opts.mode}: ${opts.citations} Quellen gefunden`,
      icon: '/favicon.svg',
      tag: 'aegis-done', // collapses duplicates if multiple fire close together
    });
  } catch {
    // Some browsers throw on edge cases (e.g. permissions revoked mid-call).
  }
}

// ─────────────────────────── Actions ───────────────────────────

export function setMode(mode: AegisMode): void {
  setState({ mode });
}

export function setInput(input: string): void {
  setState({ input });
}

export function clearChat(): void {
  storeConversationId(null);
  // Reset/new session: drop the persisted upload + download state too, so a
  // refresh after a clear genuinely starts from zero.
  storeUploadedDocuments([]);
  storeLastAttachment(null);
  storeActiveJob(null);
  setState({
    messages: [],
    input: '',
    conversationId: null,
    streamingText: '',
    streamingPhase: null,
    toolProgress: null,
    retryNotice: null,
    latestCompletion: null,
    uploadedDocuments: [],
    isUploading: false,
    job: null,
  });
}

// ─────────────────────────── Conversation memory ───────────────────────────

const CONVERSATION_STORAGE_KEY = 'aegis-conversation-id';

function storeConversationId(id: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (id) window.localStorage.setItem(CONVERSATION_STORAGE_KEY, id);
    else window.localStorage.removeItem(CONVERSATION_STORAGE_KEY);
  } catch {
    /* storage unavailable (private mode) — in-memory state still works */
  }
}

function readStoredConversationId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(CONVERSATION_STORAGE_KEY);
  } catch {
    return null;
  }
}

// ─────────────────── Uploaded-document & download persistence ───────────────────
//
// The uploaded-document chips and the last generated download survive a browser
// refresh via localStorage so the user never lands on an empty UI after a reload.
//
// IMPORTANT: the browser `File` binaries themselves are NOT reliably
// reconstructable after a refresh (security + object lifecycle) — so we persist
// METADATA ONLY. The parsed document content and the generated Excel live
// server-side in Postgres, keyed by id, and stay downloadable within their TTL.
// We restore the chips + the download link from metadata; if a server-side
// document has since expired, the chip still shows but a re-analysis returns a
// clear "not found" rather than a blank screen.
const UPLOADS_STORAGE_KEY = 'aegis-uploaded-documents';
const ATTACHMENT_STORAGE_KEY = 'aegis-last-attachment';

type PersistedAttachment = MessageAttachment & { conversationId: string | null };

export function storeUploadedDocuments(docs: UploadedDocument[]): void {
  if (typeof window === 'undefined') return;
  try {
    if (docs.length > 0) window.localStorage.setItem(UPLOADS_STORAGE_KEY, JSON.stringify(docs));
    else window.localStorage.removeItem(UPLOADS_STORAGE_KEY);
  } catch {
    /* storage unavailable (private mode) — in-memory state still works */
  }
}

export function readStoredUploadedDocuments(): UploadedDocument[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(UPLOADS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (d): d is UploadedDocument =>
        !!d &&
        typeof (d as UploadedDocument).id === 'string' &&
        typeof (d as UploadedDocument).filename === 'string' &&
        ((d as UploadedDocument).type === 'policy' || (d as UploadedDocument).type === 'template'),
    );
  } catch {
    return [];
  }
}

export function storeLastAttachment(att: PersistedAttachment | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (att) window.localStorage.setItem(ATTACHMENT_STORAGE_KEY, JSON.stringify(att));
    else window.localStorage.removeItem(ATTACHMENT_STORAGE_KEY);
  } catch {
    /* storage unavailable */
  }
}

export function readStoredLastAttachment(): PersistedAttachment | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(ATTACHMENT_STORAGE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<PersistedAttachment>;
    if (p && typeof p.downloadId === 'string' && typeof p.filename === 'string') {
      return { downloadId: p.downloadId, filename: p.filename, conversationId: p.conversationId ?? null };
    }
    return null;
  } catch {
    return null;
  }
}

type TranscriptMessage = {
  id: string;
  seq: number;
  role: 'user' | 'assistant';
  content: string;
  citedIds: string[];
  status: 'complete' | 'failed';
  exitReason: string | null;
  createdAt: string;
};

/**
 * Resume the stored conversation on page load: fetch the server transcript
 * (authoritative) and hydrate the chat. No-ops when a chat is already live
 * in this tab; clears the stored id when the server says 404 (expired,
 * erased, or foreign).
 */
export async function hydrateConversation(): Promise<void> {
  // Restore uploaded-document chips first — independent of whether a conversation
  // exists (the user may have uploaded but not yet sent a message before reload).
  if (state.uploadedDocuments.length === 0) {
    const docs = readStoredUploadedDocuments();
    if (docs.length > 0) setState({ uploadedDocuments: docs });
  }

  const stored = readStoredConversationId();
  if (!stored || state.messages.length > 0 || state.isLoading) return;

  let res: Response;
  try {
    res = await fetch(`/api/aegis/conversations/${stored}`);
  } catch {
    return; // network hiccup — keep the id, try again next load
  }
  if (res.status === 404) {
    storeConversationId(null);
    return;
  }
  if (!res.ok) return;

  let payload: { messages?: TranscriptMessage[] };
  try {
    payload = (await res.json()) as { messages?: TranscriptMessage[] };
  } catch {
    return;
  }
  const messages = mapTranscriptRows(payload.messages ?? []);

  // Re-attach the last generated download (Excel) to the most recent assistant
  // message of THIS conversation, so the download button survives a refresh.
  const lastAtt = readStoredLastAttachment();
  if (lastAtt && lastAtt.conversationId === stored) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'aegis') {
        messages[i] = {
          ...messages[i],
          attachment: { downloadId: lastAtt.downloadId, filename: lastAtt.filename },
        };
        break;
      }
    }
  }

  // Re-check: a message may have been sent while the fetch was in flight.
  if (state.messages.length > 0 || state.isLoading) return;
  setState({ conversationId: stored, messages });
}

function mapTranscriptRows(rows: TranscriptMessage[]): ChatMessage[] {
  return rows.map((m) => {
    const timestamp = Date.parse(m.createdAt) || Date.now();
    if (m.role === 'user') {
      return { id: `u-${m.seq}`, role: 'user' as const, content: m.content, timestamp };
    }
    if (m.status === 'failed') {
      return {
        id: `e-${m.seq}`,
        role: 'error' as const,
        content: `Dieser Durchlauf ist fehlgeschlagen (${m.exitReason ?? 'unbekannt'}).`,
        timestamp,
      };
    }
    return { id: `a-${m.seq}`, role: 'aegis' as const, content: m.content, timestamp };
  });
}

/**
 * Open a specific past conversation (from the history list): fetch its
 * transcript and make it the live chat. Returns true on success. Callers
 * typically navigate to /aegis afterwards. Stops any in-flight playback state.
 */
export async function openConversation(id: string): Promise<boolean> {
  let res: Response;
  try {
    res = await fetch(`/api/aegis/conversations/${id}`);
  } catch {
    return false;
  }
  if (!res.ok) {
    if (res.status === 404 && readStoredConversationId() === id) storeConversationId(null);
    return false;
  }
  let payload: { messages?: TranscriptMessage[] };
  try {
    payload = (await res.json()) as { messages?: TranscriptMessage[] };
  } catch {
    return false;
  }
  storeConversationId(id);
  setState({
    conversationId: id,
    messages: mapTranscriptRows(payload.messages ?? []),
    isLoading: false,
    streamingText: '',
    streamingPhase: null,
    toolProgress: null,
    retryNotice: null,
  });
  return true;
}

export function dismissLatestCompletion(): void {
  setState({ latestCompletion: null });
}

// ─────────────────────────── File upload ───────────────────────────

// Note: legacy .xls is deliberately rejected server-side (exceljs reads OOXML
// only), so it is intentionally absent here. .md routes through the text parser.
const ACCEPT_EXTENSIONS = ['.pdf', '.docx', '.pptx', '.xlsx', '.txt', '.md'];
const MAX_UPLOAD_SIZE = 10 * 1024 * 1024;

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isExcelFile(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase();
  return ext === 'xlsx' || ext === 'xls';
}

function inferDocType(file: File): 'policy' | 'template' {
  return isExcelFile(file.name) ? 'template' : 'policy';
}

export { ACCEPT_EXTENSIONS, MAX_UPLOAD_SIZE, formatFileSize, isExcelFile, inferDocType };

export async function uploadDocument(
  file: File,
  typeOverride?: 'policy' | 'template',
): Promise<UploadedDocument | null> {
  if (file.size > MAX_UPLOAD_SIZE) {
    appendErrorMessage(`Datei zu gross: ${formatFileSize(file.size)} (max 10 MB)`);
    return null;
  }

  const docType = typeOverride ?? inferDocType(file);

  const existing = state.uploadedDocuments;
  if (existing.length >= 2) {
    appendErrorMessage('Maximal 2 Dateien (1 Policy + 1 Template) erlaubt.');
    return null;
  }
  if (existing.some((d) => d.type === docType)) {
    appendErrorMessage(
      docType === 'policy'
        ? 'Es wurde bereits eine Policy hochgeladen.'
        : 'Es wurde bereits ein Template hochgeladen.',
    );
    return null;
  }

  setState({ isUploading: true });

  const formData = new FormData();
  formData.append('file', file);
  formData.append('type', docType);

  try {
    const res = await fetch('/api/aegis/upload', {
      method: 'POST',
      body: formData,
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const j = (await res.json()) as { message?: string; detail?: string };
        // `message` is the user-facing reason (e.g. "PDF extraction failed — …").
        // `detail` is only present in development (parser error name + first line).
        if (j.message) detail = j.message;
        if (j.detail) detail += ` (${j.detail})`;
      } catch { /* not JSON */ }
      appendErrorMessage(`Upload fehlgeschlagen: ${detail}`);
      return null;
    }

    const data = (await res.json()) as {
      fileId: string;
      filename: string;
      type: 'policy' | 'template';
      originalLanguage?: string | null;
    };
    const doc: UploadedDocument = {
      id: data.fileId,
      filename: data.filename,
      type: data.type,
      originalLanguage: data.originalLanguage ?? null,
    };

    const nextDocs = [...state.uploadedDocuments, doc];
    setState({ uploadedDocuments: nextDocs, isUploading: false });
    storeUploadedDocuments(nextDocs); // survive a refresh

    return doc;
  } catch (err) {
    appendErrorMessage(
      `Upload fehlgeschlagen: ${err instanceof Error ? err.message : 'Netzwerkfehler'}`,
    );
    return null;
  }
}

/**
 * Translate an uploaded (policy) document into DE/EN and swap the chip to the
 * translated working copy. The original AegisDocument is preserved server-side
 * (linked via translatedFromId). AEGIS then analyses the translation; the
 * analyze prompt notes that it is machine-translated.
 */
export async function translateUploadedDocument(
  docId: string,
  target: string,
): Promise<UploadedDocument | null> {
  try {
    const res = await fetch('/api/aegis/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId: docId, target }),
    });
    if (!res.ok) {
      const detail = res.status === 503 ? 'DeepL ist nicht konfiguriert.' : 'Übersetzung fehlgeschlagen.';
      appendErrorMessage(detail);
      return null;
    }
    const data = (await res.json()) as { translatedDocumentId: string; filename: string; originalLanguage: string | null };
    const original = state.uploadedDocuments.find((d) => d.id === docId);
    const translated: UploadedDocument = {
      id: data.translatedDocumentId,
      filename: data.filename,
      type: 'policy',
      originalLanguage: data.originalLanguage,
      isTranslation: true,
    };
    // Swap the original chip for the translation working copy (original stays
    // on the server, linked via translatedFromId).
    const nextDocs = state.uploadedDocuments.map((d) => (d.id === docId ? translated : d));
    void original;
    setState({ uploadedDocuments: nextDocs });
    storeUploadedDocuments(nextDocs);
    return translated;
  } catch (err) {
    appendErrorMessage(`Übersetzung fehlgeschlagen: ${err instanceof Error ? err.message : 'Netzwerkfehler'}`);
    return null;
  }
}

export function buildAnalysisPrompt(userText?: string): { prompt: string; mode: AegisMode } | null {
  const docs = state.uploadedDocuments;
  if (docs.length === 0) return null;

  const policy = docs.find((d) => d.type === 'policy');
  const template = docs.find((d) => d.type === 'template');
  const translatedNote = policy?.isTranslation
    ? ` (maschinell übersetzt mit DeepL${policy.originalLanguage ? ` aus ${policy.originalLanguage}` : ''} — nicht kuratierte KB)`
    : '';

  let context = '';
  if (policy && template) {
    context =
      `Hochgeladene Dateien: Policy "${policy.filename}"${translatedNote} (ID: ${policy.id}), ` +
      `Template "${template.filename}" (ID: ${template.id}).`;
  } else if (policy) {
    context = `Hochgeladenes Dokument: "${policy.filename}"${translatedNote} (Document ID: ${policy.id}).`;
  } else if (template) {
    context = `Hochgeladenes Template: "${template.filename}" (Template ID: ${template.id}).`;
  }

  const trimmed = userText?.trim();
  let prompt: string;
  if (trimmed && trimmed.length >= 5) {
    prompt = `${context}\n\n${trimmed}`;
  } else if (policy && template) {
    // Both documents are already present → run the whole workflow in this turn:
    // analyze the policy (which saves the findings) and then fill the template
    // (which reuses those just-saved findings — no double analysis). Do NOT ask
    // the user to upload the template again; it is already here.
    prompt =
      `${context}\n\nAnalysiere die Policy gegen die relevanten Regulationen und fülle anschliessend ` +
      `im selben Schritt das Excel-Template "${template.filename}" mit den Findings aus. ` +
      `Frage NICHT nach einem erneuten Upload des Templates — es ist bereits hochgeladen.`;
  } else if (policy) {
    // Only a policy → analyze, then guide the user to upload the template.
    prompt =
      `${context}\n\nAnalysiere das Dokument gegen die relevanten Regulationen. Identifiziere Gaps und fehlende Anforderungen. ` +
      `Fülle noch KEIN Excel-Template aus — das ist ein separater zweiter Schritt.`;
  } else {
    prompt =
      `${context}\n\nFühre ein generisches Assessment auf dem Template durch. Identifiziere vorhandene Anforderungen und ergänze fehlende.`;
  }

  return { prompt, mode: 'GAP_ANALYZE' };
}

export function removeUploadedDocument(id: string): void {
  const next = state.uploadedDocuments.filter((d) => d.id !== id);
  setState({ uploadedDocuments: next });
  storeUploadedDocuments(next);
}

export function clearUploadedDocuments(): void {
  setState({ uploadedDocuments: [] });
  storeUploadedDocuments([]);
}

// ─────────────────────────── SSE parsing ───────────────────────────

type SseEvent = { event: string; data: string };

/**
 * Pulls complete `event:\ndata:\n\n` blocks out of a rolling buffer. Returns
 * the parsed events and the remaining buffer tail (incomplete event).
 */
function parseSseBuffer(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = [];
  let rest = buffer;
  while (true) {
    const sep = rest.indexOf('\n\n');
    if (sep === -1) break;
    const block = rest.slice(0, sep);
    rest = rest.slice(sep + 2);
    let eventName = 'message';
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    events.push({ event: eventName, data: dataLines.join('\n') });
  }
  return { events, rest };
}

/**
 * Draft preservation on abnormal stream end (pure, exported for tests): when
 * a non-empty draft has already been streamed, return it with the central
 * German truncation note appended — the caller keeps it as an assistant
 * message and shows the error row AFTER it. EVERY abnormal end preserves
 * (LP-2): server timeout, server error events, client idle abort, transport
 * failure, and a stream that closes without a terminal event. An empty draft
 * returns null → only the normal error row is shown.
 */
export function preserveAbnormalEndDraft(
  code: string,
  streamingText: string,
): string | null {
  const draft = streamingText.trim();
  if (draft.length === 0) return null;
  return `${draft}${code === 'timeout' ? TIMEOUT_DRAFT_NOTE_DE : ABNORMAL_END_DRAFT_NOTE_DE}`;
}

/**
 * Terminate the in-flight turn with an error, preserving any streamed draft
 * first (LP-2). The draft lands as an assistant message with the truncation
 * note; the German error row follows it — never replaces it.
 */
function endWithError(code: string, germanMessage: string): void {
  const preserved = preserveAbnormalEndDraft(code, state.streamingText);
  if (preserved !== null) {
    setState({
      messages: [
        ...state.messages,
        {
          id: `a-${Date.now()}`,
          role: 'aegis',
          content: preserved,
          timestamp: Date.now(),
        },
      ],
      streamingText: '',
    });
  }
  appendErrorMessage(germanMessage);
}

/**
 * Build MessageMeta from a server response's meta payload (pure, exported for
 * tests). When verification metadata is absent, the result is `{ ok:
 * 'unknown' }` — an honest amber state. It must never default to a
 * fabricated all-pass green badge (finding F7): a missing field is not a
 * passed check.
 */
export function buildMessageMeta(
  metaRaw: Record<string, unknown>,
  citations: string[],
): MessageMeta {
  return {
    mode: String(metaRaw.mode ?? ''),
    model: String(metaRaw.model ?? ''),
    cost: (metaRaw.cost as MessageMeta['cost']) ?? {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      usd: 0,
    },
    latency: Number(metaRaw.latency ?? 0),
    citations,
    verification:
      (metaRaw.verification as MessageMeta['verification']) ?? { ok: 'unknown' },
    toolCalls: (metaRaw.toolCalls as MessageMeta['toolCalls'] | undefined) ?? [],
    iterations: Number(metaRaw.iterations ?? 0),
    degraded: metaRaw.degraded as MessageMeta['degraded'],
  };
}

function appendErrorMessage(content: string): void {
  setState({
    messages: [
      ...state.messages,
      {
        id: `e-${Date.now()}`,
        role: 'error',
        content,
        timestamp: Date.now(),
      },
    ],
    isLoading: false,
    streamingText: '',
    streamingPhase: null,
    toolProgress: null,
    retryNotice: null,
  });
}

// ─────────────── Sectioned job orchestration (PR 3) ───────────────

const ACTIVE_JOB_KEY = 'aegis-active-job-v1';
/** Client-side reconnect budget per stretch without progress (server caps at 12 anyway). */
const MAX_CLIENT_RESUMES = 15;
const RESUME_DELAY_MS = 750;

function storeActiveJob(jobId: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (jobId) window.localStorage.setItem(ACTIVE_JOB_KEY, jobId);
    else window.localStorage.removeItem(ACTIVE_JOB_KEY);
  } catch {
    /* storage unavailable (private mode) — resume-on-reload just won't work */
  }
}

export function readStoredActiveJob(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(ACTIVE_JOB_KEY);
  } catch {
    return null;
  }
}

const SECTIONED_EVENT_TYPES = new Set([
  'job_created',
  'job_state',
  'section_start',
  'section_token',
  'section_done',
  'job_paused',
  'job_done',
  'job_failed',
]);

function handleSectionedEvent(data: { type: string } & Record<string, unknown>): void {
  const { job, effect } = applySectionedEvent(state.job, data);

  // Live progress mirrors into the existing streaming UI fields so the chat
  // panel shows the report growing exactly like a single-pass answer.
  if (data.type === 'section_token' && job) {
    setState({ job, streamingText: joinJobSections(job), streamingPhase: 'generating' });
    return;
  }
  if (data.type === 'job_created') {
    if (job) storeActiveJob(job.jobId);
    setState({ job, isLoading: true, streamingPhase: 'generating', streamingMessage: null });
    return;
  }
  if (data.type === 'job_state' && job) {
    storeActiveJob(job.jobId);
    setState({
      job,
      isLoading: true,
      streamingPhase: 'generating',
      streamingText: joinJobSections(job),
      streamingMessage: null,
    });
    return;
  }
  if (data.type === 'section_start' && job) {
    const total = job.sections.length;
    const current = job.sections.find((s) => s.status === 'writing');
    setState({
      job,
      streamingMessage: current
        ? SECTION_WRITING_DE(current.index, total, current.title)
        : null,
    });
    return;
  }

  switch (effect.kind) {
    case 'resume': {
      if (!job) return;
      if (job.resumeAttempts > MAX_CLIENT_RESUMES) {
        // Reconnect budget exhausted without progress — honest German error;
        // completed sections are persisted server-side.
        storeActiveJob(null);
        setState({ job: null });
        endWithError('resume_cap_exceeded', SECTIONED_FAILED_DE);
        return;
      }
      setState({ job, streamingMessage: SECTIONED_PAUSED_DE });
      const jobId = job.jobId;
      setTimeout(() => {
        // Only reconnect if this job is still the active one.
        if (state.job?.jobId === jobId && state.job.phase === 'reconnecting') {
          void resumeJob(jobId);
        }
      }, RESUME_DELAY_MS);
      return;
    }
    case 'finalize': {
      const finished = state.job;
      storeActiveJob(null);
      if (!finished) {
        setState({ job: null, isLoading: false });
        return;
      }
      const content = joinJobSections(finished);
      const citations = [...new Set(content.match(/\[R-[A-Z0-9]+-[A-Z0-9-]+\]/g) ?? [])];
      const degraded = effect.degradedSections;
      const total = finished.sections.length;
      const aegisId = `a-${Date.now()}`;
      const meta: MessageMeta = {
        mode: state.mode,
        model: 'claude-sonnet (sektioniert)',
        cost: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, usd: 0 },
        latency: 0,
        citations,
        // Honesty (F7/D9): all-done ⇒ every section passed its verify run;
        // any degraded section ⇒ the report is NOT presented as verified.
        verification:
          degraded === 0
            ? {
                ok: true,
                checks: {
                  citation_coverage: 'pass',
                  no_hallucinated_regulations: 'pass',
                  unsupported_regulatory_claim: 'pass',
                  language_consistency: 'pass',
                  non_empty_response: 'pass',
                  no_false_ignorance: 'pass',
                },
              }
            : {
                ok: false,
                failed: 'sectioned_degraded',
                reason: SECTIONED_DEGRADED_REASON_DE(degraded, total),
              },
        toolCalls: [],
        iterations: total,
        degraded: degraded > 0 ? 'verify' : undefined,
      };
      setState({
        messages: [
          ...state.messages,
          { id: aegisId, role: 'aegis', content, timestamp: Date.now(), meta },
        ],
        job: null,
        isLoading: false,
        streamingText: '',
        streamingPhase: null,
        streamingMessage: null,
        toolProgress: null,
        retryNotice: null,
        latestCompletion: {
          id: aegisId,
          createdAt: Date.now(),
          mode: state.mode,
          citations: citations.length,
          latency: 0,
        },
      });
      fireBrowserNotification({ mode: state.mode, citations: citations.length });
      return;
    }
    case 'fail': {
      storeActiveJob(null);
      setState({ job: null, streamingMessage: null });
      // Streamed section text is preserved as a draft above the error row
      // (LP-2 semantics); finished sections additionally live server-side.
      endWithError(effect.code, apiErrorMessageDe(effect.code, effect.message));
      return;
    }
    case 'none':
      if (job !== state.job) setState({ job });
      return;
  }
}

/** Shared SSE pump: reads a stream response and feeds events to the handler. */
async function pumpSse(
  res: Response,
  resetIdleTimer: () => void,
): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    resetIdleTimer();
    buffer += decoder.decode(value, { stream: true });
    const { events, rest } = parseSseBuffer(buffer);
    buffer = rest;
    for (const ev of events) handleSseEvent(ev);
  }
  if (buffer.length > 0) {
    const { events } = parseSseBuffer(buffer + '\n\n');
    for (const ev of events) handleSseEvent(ev);
  }
}

/**
 * Reconnect to a paused/running job (F2: jobId is the cursor). Opens the
 * resume SSE endpoint and feeds the same event handler; the `job_state`
 * snapshot rebuilds finished sections, then live events continue. A clean
 * pause at the server's time floor triggers another auto-resume — the user
 * only ever sees calm progress (iron rule).
 */
export async function resumeJob(jobId: string): Promise<void> {
  const IDLE_TIMEOUT_MS = 90_000;
  const abort = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => abort.abort(), IDLE_TIMEOUT_MS);
  };

  setState({ isLoading: true, streamingMessage: SECTIONED_PAUSED_DE });
  let res: Response;
  try {
    resetIdleTimer();
    res = await fetch(`/api/aegis/jobs/${encodeURIComponent(jobId)}/stream`, {
      headers: { Accept: 'text/event-stream' },
      signal: abort.signal,
    });
  } catch (err) {
    if (idleTimer) clearTimeout(idleTimer);
    console.error('[aegis] job resume failed:', err);
    storeActiveJob(null);
    setState({ job: null });
    endWithError('network_error', 'Netzwerkfehler: Verbindung fehlgeschlagen. Bitte erneut versuchen.');
    return;
  }

  if (!res.ok) {
    if (idleTimer) clearTimeout(idleTimer);
    let detail = apiErrorMessageDe(undefined, undefined, res.status);
    try {
      const j = (await res.json()) as { error?: string; message?: string } | null;
      if (j && typeof j === 'object') detail = apiErrorMessageDe(j.error, j.message, res.status);
    } catch {
      /* body not JSON */
    }
    storeActiveJob(null);
    setState({ job: null });
    appendErrorMessage(detail);
    return;
  }

  try {
    await pumpSse(res, resetIdleTimer);
  } catch (err) {
    console.error('[aegis] job resume stream failed:', err);
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }

  // Stream ended without a terminal event and without a pause → treat like a
  // pause and let the auto-resume budget decide (crash-safe reconnect).
  if (state.job?.jobId === jobId && state.job.phase === 'running') {
    handleSectionedEvent({ type: 'job_paused', jobId, cursor: state.job.cursor });
  }
}

/**
 * Hydration (PR 3): if a reload interrupted an active job, silently resume it.
 * Called from the chat panel on mount; a no-op when nothing is stored or a
 * request is already in flight.
 */
export function maybeResumeStoredJob(): void {
  if (state.isLoading || state.job) return;
  const jobId = readStoredActiveJob();
  if (!jobId) return;
  void resumeJob(jobId);
}

export type SendMessageOpts = {
  /** Voice channel marker — backend lowers maxIterations/maxTokens. */
  voice?: boolean;
};

// Voice latency tracing (gated by the aegis-voice-debug flag). Module-level so
// handleSseEvent can mark first-token / completion without threading state.
let voiceTurn = false;
let firstTokenSeen = false;
// Download produced during the current turn (fill_template). Captured from the
// `attachment` event and attached to the assistant message on `done`.
let pendingAttachment: MessageAttachment | null = null;

export async function sendMessage(
  text: string,
  modeOverride?: AegisMode,
  opts?: SendMessageOpts,
): Promise<void> {
  const trimmed = text.trim();
  if (trimmed.length < 5 || state.isLoading) return;

  const usedMode = modeOverride ?? state.mode;
  const voice = opts?.voice === true;
  voiceTurn = voice;
  firstTokenSeen = false;
  pendingAttachment = null;
  // Fresh slate for the streamed-sentence pipeline; clear any prior queue.
  voiceSentenceBuffer = '';
  if (voice) voiceSink?.onRetract();
  if (voice) vmark('sendMessageAt');

  // Request permission on the first send. Non-blocking.
  maybeRequestNotificationPermission();

  const userMsg: ChatMessage = {
    id: `u-${Date.now()}`,
    role: 'user',
    content: trimmed,
    timestamp: Date.now(),
  };

  setState({
    mode: usedMode,
    messages: [...state.messages, userMsg],
    isLoading: true,
    input: '',
    streamingText: '',
    streamingPhase: 'tools',
    toolProgress: null,
    retryNotice: null,
  });

  // Abort the request if the server goes silent: without this, a stream that
  // dies without a terminal event leaves the UI stuck on "generating" forever.
  const IDLE_TIMEOUT_MS = 90_000;
  const abort = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => abort.abort(), IDLE_TIMEOUT_MS);
  };
  const clearIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  };

  let res: Response;
  try {
    resetIdleTimer();
    res = await fetch('/api/aegis', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        mode: usedMode,
        message: trimmed,
        language: 'de',
        voice,
        // Resume the server-side conversation; the server transcript is
        // authoritative, so no chat history is ever sent from the client.
        conversationId: state.conversationId ?? undefined,
      }),
      signal: abort.signal,
    });
  } catch (err) {
    clearIdleTimer();
    // Browser fetch errors carry English internals ("Failed to fetch") —
    // German text for the UI, raw detail to the console (LP-6).
    console.error('[aegis] request failed:', err);
    endWithError(
      abort.signal.aborted ? 'timeout' : 'network_error',
      abort.signal.aborted
        ? 'Zeitüberschreitung: Der Server hat zu lange nicht geantwortet.'
        : 'Netzwerkfehler: Verbindung fehlgeschlagen. Bitte erneut versuchen.',
    );
    return;
  }

  if (!res.ok || !res.body) {
    clearIdleTimer();
    let detail = apiErrorMessageDe(undefined, undefined, res.status);
    try {
      const j = (await res.json()) as { error?: string; message?: string } | null;
      if (j && typeof j === 'object') {
        detail = apiErrorMessageDe(j.error, j.message, res.status);
      }
    } catch {
      /* body not JSON */
    }
    appendErrorMessage(detail);
    return;
  }

  try {
    await pumpSse(res, resetIdleTimer);
  } catch (err) {
    console.error('[aegis] stream read failed:', err);
    // An active sectioned job survives a transport hiccup: the pause/resume
    // path owns recovery (iron rule) — no error surfaces here.
    if (!state.job) {
      endWithError(
        abort.signal.aborted ? 'timeout' : 'stream_interrupted',
        abort.signal.aborted
          ? 'Zeitüberschreitung: Der Server hat zu lange nicht geantwortet.'
          : 'Die Verbindung wurde unterbrochen. Bitte erneut versuchen.',
      );
    }
  } finally {
    clearIdleTimer();
  }

  // A sectioned job that is still active when the POST stream closes (pause at
  // the time floor, or a dropped connection) reconnects via the resume
  // endpoint — never a user-facing error (F3: reconnect = new invocation).
  if (state.job) {
    if (state.job.phase === 'running') {
      handleSectionedEvent({
        type: 'job_paused',
        jobId: state.job.jobId,
        cursor: state.job.cursor,
      });
    }
    return;
  }

  // If isLoading is still true at this point the stream ended without a
  // `done` or `error` event — surface that as a soft error.
  if (state.isLoading) {
    endWithError(
      'stream_closed',
      'Der Stream wurde geschlossen, bevor eine vollständige Antwort vorlag.',
    );
  }
}

function handleSseEvent(ev: SseEvent): void {
  let payload: unknown = null;
  try {
    payload = ev.data ? JSON.parse(ev.data) : null;
  } catch {
    return;
  }
  if (!payload || typeof payload !== 'object') return;
  const data = payload as Record<string, unknown>;

  // SECTIONED event set (F5) — routed to the sectioned reducer; the named SSE
  // event and the payload's `type` field are identical by contract.
  if (SECTIONED_EVENT_TYPES.has(ev.event)) {
    handleSectionedEvent({ ...data, type: ev.event });
    return;
  }

  switch (ev.event) {
    case 'status': {
      const phase = data.phase === 'generating' ? 'generating' : 'tools';
      const iteration =
        typeof data.iteration === 'number' ? data.iteration : 0;
      const toolName =
        typeof data.toolName === 'string' ? data.toolName : undefined;
      setState({
        streamingPhase: phase,
        streamingMessage: typeof data.message === 'string' && data.message ? data.message : null,
        toolProgress: toolName
          ? { iteration, toolName }
          : phase === 'generating'
            ? null
            : state.toolProgress,
      });
      return;
    }
    case 'tool_result': {
      // Attach preview to the current toolProgress for the UI.
      if (state.toolProgress && data.name === state.toolProgress.toolName) {
        setState({
          toolProgress: {
            ...state.toolProgress,
            preview:
              typeof data.preview === 'string' ? data.preview : undefined,
            isError: !!data.isError,
          },
        });
      }
      return;
    }
    case 'attachment': {
      // A generated download (e.g. the filled Excel). Hold it until `done`, then
      // attach to the assistant message so the UI shows a real download link.
      if (typeof data.downloadId === 'string' && typeof data.filename === 'string') {
        pendingAttachment = { downloadId: data.downloadId, filename: data.filename };
      }
      return;
    }
    case 'thinking_clear': {
      // Server detected a tool_use after some text was streamed. The text
      // was pre-tool reasoning, not the final answer — drop it. For voice, also
      // withdraw anything already queued/spoken from that reasoning.
      if (voiceTurn) {
        voiceSentenceBuffer = '';
        voiceSink?.onRetract();
      }
      setState({ streamingText: '' });
      return;
    }
    case 'token': {
      const text = typeof data.text === 'string' ? data.text : '';
      if (!text) return;
      if (voiceTurn && !firstTokenSeen) {
        firstTokenSeen = true;
        vmark('aegisFirstTokenAt');
      }
      // Voice: feed the streamed tail to the speech chunker and speak every
      // confident chunk right away. `rest` carries the unfinished tail.
      if (voiceTurn && voiceSink) {
        voiceSentenceBuffer += text;
        const { chunks, rest } = extractSpeechChunks(voiceSentenceBuffer);
        voiceSentenceBuffer = rest;
        for (const c of chunks) voiceSink.onSentence(c);
      }
      setState({
        streamingPhase: 'generating',
        streamingText: state.streamingText + text,
        retryNotice: null,
      });
      return;
    }
    case 'replace_text': {
      const text = typeof data.text === 'string' ? data.text : '';
      // The streamed text is being replaced wholesale — what we already spoke is
      // now stale, so stop/clear and let the `done` path read the final answer.
      if (voiceTurn) {
        voiceSentenceBuffer = '';
        voiceSink?.onRetract();
      }
      setState({ streamingText: text });
      return;
    }
    case 'verify_retry': {
      // The answer is being regenerated — discard the streamed (and possibly
      // already-spoken) attempt so only the new answer is read aloud.
      if (voiceTurn) {
        voiceSentenceBuffer = '';
        voiceSink?.onRetract();
      }
      const reason =
        typeof data.reason === 'string'
          ? data.reason
          : 'Qualitätsprüfung fehlgeschlagen';
      setState({
        streamingText: '',
        streamingPhase: 'tools',
        toolProgress: null,
        retryNotice: `Qualitätsprüfung fehlgeschlagen — generiere neue Antwort: ${reason}`,
      });
      return;
    }
    case 'done': {
      if (voiceTurn) vmark('aegisCompletedAt');
      // Flush the final incomplete tail BEFORE the message lands in the store,
      // so the auto-read effect that follows sees the turn as already-streamed
      // and won't re-speak. Chunk it too, so a long unpunctuated tail isn't one
      // big clip: all but the last chunk go via onSentence, the last via
      // onComplete (which finalizes the turn).
      if (voiceTurn && voiceSink) {
        const tail = chunkText(voiceSentenceBuffer);
        voiceSentenceBuffer = '';
        for (let k = 0; k < tail.length - 1; k++) voiceSink.onSentence(tail[k]);
        voiceSink.onComplete(tail.length > 0 ? tail[tail.length - 1] : '');
      }
      const response = typeof data.response === 'string' ? data.response : '';
      const citations = Array.isArray(data.citations)
        ? (data.citations.filter((c) => typeof c === 'string') as string[])
        : [];
      const metaRaw =
        data.meta && typeof data.meta === 'object'
          ? (data.meta as Record<string, unknown>)
          : null;
      if (!metaRaw) {
        appendErrorMessage('Server hat eine ungültige Antwort gesendet.');
        return;
      }

      const aegisId = `a-${Date.now()}`;
      const meta = buildMessageMeta(metaRaw, citations);

      const completion: LatestCompletion = {
        id: aegisId,
        createdAt: Date.now(),
        mode: meta.mode,
        citations: meta.citations.length,
        latency: meta.latency,
      };

      // Adopt the server's conversation id so follow-ups resume server-side.
      const conversationId =
        typeof metaRaw.conversationId === 'string'
          ? metaRaw.conversationId
          : state.conversationId;
      if (conversationId && metaRaw.persisted !== false) {
        storeConversationId(conversationId);
      }

      // Persist the generated download so it reappears after a refresh, keyed to
      // the conversation it belongs to (re-attached on hydration).
      if (pendingAttachment) {
        storeLastAttachment({ ...pendingAttachment, conversationId: conversationId ?? null });
      }

      setState({
        messages: [
          ...state.messages,
          {
            id: aegisId,
            role: 'aegis',
            content: response,
            timestamp: Date.now(),
            meta,
            attachment: pendingAttachment ?? undefined,
          },
        ],
        isLoading: false,
        conversationId,
        streamingText: '',
        streamingPhase: null,
        toolProgress: null,
        retryNotice: null,
        latestCompletion: completion,
      });

      if (metaRaw.persisted === false) {
        console.warn(
          '[aegis] Antwort wurde nicht in der Unterhaltung gespeichert (persisted=false).',
        );
      }

      fireBrowserNotification({
        mode: meta.mode,
        citations: meta.citations.length,
      });
      return;
    }
    case 'error': {
      const code = typeof data.code === 'string' ? data.code : 'error';
      const message =
        typeof data.message === 'string' ? data.message : 'Unbekannter Fehler';
      // Timeout with a non-empty streamed draft: keep the draft as an
      // assistant message with an explicit truncation note instead of wiping
      // minutes of streamed report and showing only an error row.
      // German rendering, no raw `code: message` internals (LP-6); any
      // streamed draft is preserved above the error row (LP-2). Original
      // detail stays available in the console for debugging.
      console.error('[aegis] stream error event:', code, message);
      endWithError(code, apiErrorMessageDe(code, message));
      return;
    }
  }
}
