'use client';

import Link from 'next/link';
import { AEGIS_MESSAGE_MAX_CHARS_DEFAULT } from '@/lib/aegis/limits';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  ACCEPT_EXTENSIONS,
  buildAnalysisPrompt,
  clearChat as storeClearChat,
  clearUploadedDocuments,
  removeUploadedDocument,
  getServerSnapshot,
  getSnapshot,
  hydrateConversation,
  maybeResumeStoredJob,
  sendMessage as storeSendMessage,
  setInput as storeSetInput,
  setMode as storeSetMode,
  subscribe,
  translateUploadedDocument,
  uploadDocument as storeUploadDocument,
  type AegisMode,
  type ChatMessage,
  type MessageMeta,
  type ToolCallSummary,
} from '@/lib/aegis/client-store';
import ReportProgress from '@/components/aegis/ReportProgress';
import { parseBlocks, parseCriticality, type Block } from '@/lib/aegis/markdown-blocks';
import { AegisTtsButton, stopAegisTts } from '@/components/AegisTtsButton';
import { AegisExportMenu } from '@/components/AegisExportMenu';
import { TRANSLATION_TARGETS } from '@/lib/translate/targets';
import { AegisVoicePicker } from '@/components/AegisVoicePicker';
import { AegisContextHealth } from '@/components/AegisContextHealth';
import { AegisVoiceMode } from '@/components/AegisVoiceMode';
import { primeSpeech } from '@/lib/aegis/speak';
import { AegisOrb } from '@/components/AegisOrb';
import { AegisMark } from '@/components/AegisMark';
import { GlossaryTooltip } from '@/components/GlossaryTooltip';
import { GLOSSARY_TERMS } from '@/lib/glossary';

const MODES: Array<{
  id: AegisMode;
  label: string;
  short: string;
  desc: string;
}> = [
  {
    id: 'CONVERSATIONAL',
    label: 'Conversational',
    short: 'CONV',
    desc: 'Freie Compliance-Fragen',
  },
  {
    id: 'ASSESS',
    label: 'Assess',
    short: 'ASS',
    desc: 'KI-System Risikoeinstufung',
  },
  {
    id: 'GAP_ANALYZE',
    label: 'Gap Analyze',
    short: 'GAP',
    desc: 'Policy-Vergleich gegen Regulationen',
  },
];

// Onboarding cards — one per capability. Control recommendations are a
// capability of the conversational mode (its card starts a CONVERSATIONAL
// chat), not a separate mode.
const MODE_CARDS: Array<{
  key: string;
  mode: AegisMode;
  icon: string;
  title: string;
  desc: string;
  example: string;
  hint?: string;
}> = [
  {
    key: 'conversational',
    mode: 'CONVERSATIONAL',
    icon: '\u{1F4AC}',
    title: 'Conversational',
    desc: 'Stellen Sie freie Compliance-Fragen. AEGIS antwortet mit Quellen aus der Wissensbasis.',
    example: 'Was fordert FINMA 08/2024 zur KI-Governance?',
  },
  {
    key: 'assess',
    mode: 'ASSESS',
    icon: '\u{1F50D}',
    title: 'Assess',
    desc: 'Beschreiben Sie Ihr KI-System — AEGIS sagt Ihnen, welche Regulationen gelten und wie hoch das Risiko ist.',
    example: 'Welche Regulationen gelten für KI-Kreditentscheidungen einer Schweizer Bank?',
  },
  {
    key: 'gap',
    mode: 'GAP_ANALYZE',
    icon: '\u{1F4CB}',
    title: 'Gap Analyze',
    desc: 'Laden Sie Ihre Policy oder ein Assessment-Template hoch — AEGIS zeigt, was fehlt und was erfüllt ist.',
    example: 'Analysiere unsere KI-Richtlinie gegen EU AI Act und FINMA 08/2024',
    hint: 'Policy hochladen',
  },
  {
    key: 'control',
    mode: 'CONVERSATIONAL',
    icon: '\u{1F6E1}️',
    title: 'Control Advise',
    desc: 'AEGIS empfiehlt konkrete Massnahmen mit Verantwortlichkeiten, Fristen und Prioritäten für Ihre Gaps.',
    example: 'Wir haben kein KI-Inventar und keine DSFA — was müssen wir konkret tun?',
  },
];

// ─────────────────────────── Markdown rendering ───────────────────────────

type InlineToken =
  | { type: 'text'; value: string }
  | { type: 'bold'; value: string }
  | { type: 'italic'; value: string }
  | { type: 'code'; value: string }
  | { type: 'citation'; value: string };

const INLINE_PATTERNS: Array<{ type: InlineToken['type']; re: RegExp }> = [
  { type: 'citation', re: /\[(R-[A-Z0-9]+(?:-[A-Z0-9]+)+)\]/ },
  { type: 'bold', re: /\*\*([^*\n]+)\*\*/ },
  { type: 'italic', re: /(?<![*\w])\*([^*\n]+)\*(?!\*)/ },
  { type: 'code', re: /`([^`\n]+)`/ },
];

function tokenizeInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    let earliest: { type: InlineToken['type']; index: number; match: RegExpMatchArray } | null = null;
    for (const { type, re } of INLINE_PATTERNS) {
      const m = remaining.match(re);
      if (m && m.index !== undefined) {
        if (!earliest || m.index < earliest.index) {
          earliest = { type, index: m.index, match: m };
        }
      }
    }
    if (!earliest) {
      tokens.push({ type: 'text', value: remaining });
      break;
    }
    if (earliest.index > 0) {
      tokens.push({ type: 'text', value: remaining.slice(0, earliest.index) });
    }
    tokens.push({ type: earliest.type, value: earliest.match[1] });
    remaining = remaining.slice(earliest.index + earliest.match[0].length);
  }
  return tokens;
}

function CitationBadge({ id }: { id: string }) {
  return (
    <Link
      href={`/kb/${id}`}
      className="inline-flex items-center align-baseline px-1.5 py-0.5 mx-0.5 text-[0.72rem] font-mono rounded bg-brand-primary/15 text-brand-primary border border-brand-primary/30 hover:bg-brand-primary/25 hover:border-brand-primary/60 transition-colors no-underline"
    >
      [{id}]
    </Link>
  );
}

const CRITICALITY_TONE: Record<string, string> = {
  critical: 'bg-red-500/15 text-red-300 border-red-500/40',
  high: 'bg-orange-500/15 text-orange-300 border-orange-500/40',
  medium: 'bg-yellow-500/15 text-yellow-200 border-yellow-500/40',
  low: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
};

function CriticalityBadge({ severity, label }: { severity: string; label: string }) {
  const tone = CRITICALITY_TONE[severity] ?? CRITICALITY_TONE.medium;
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border whitespace-nowrap ${tone}`}
    >
      <span aria-hidden className="w-1.5 h-1.5 rounded-full bg-current opacity-80" />
      {label}
    </span>
  );
}

function splitTextWithGlossary(
  text: string,
  seen: Set<string>,
  keyPrefix: string,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let remaining = text;
  let idx = 0;
  while (remaining.length > 0) {
    let earliest: { term: string; pos: number } | null = null;
    for (const term of GLOSSARY_TERMS) {
      if (seen.has(term)) continue;
      const pos = remaining.indexOf(term);
      if (pos !== -1 && (!earliest || pos < earliest.pos)) {
        earliest = { term, pos };
      }
    }
    if (!earliest) {
      nodes.push(<span key={`${keyPrefix}-g${idx}`}>{remaining}</span>);
      break;
    }
    if (earliest.pos > 0) {
      nodes.push(<span key={`${keyPrefix}-g${idx++}`}>{remaining.slice(0, earliest.pos)}</span>);
    }
    seen.add(earliest.term);
    nodes.push(
      <GlossaryTooltip key={`${keyPrefix}-g${idx++}`} term={earliest.term}>
        {earliest.term}
      </GlossaryTooltip>,
    );
    remaining = remaining.slice(earliest.pos + earliest.term.length);
  }
  return nodes;
}

function renderInline(text: string, keyPrefix: string, glossarySeen?: Set<string>): ReactNode {
  const seen = glossarySeen ?? new Set<string>();
  return tokenizeInline(text).map((tok, i) => {
    const k = `${keyPrefix}-${i}`;
    if (tok.type === 'text') return <span key={k}>{splitTextWithGlossary(tok.value, seen, k)}</span>;
    if (tok.type === 'bold') return <strong key={k}>{tok.value}</strong>;
    if (tok.type === 'italic') return <em key={k}>{tok.value}</em>;
    if (tok.type === 'code')
      return (
        <code
          key={k}
          className="px-1 py-0.5 text-[0.85em] font-mono rounded bg-background/60 border border-border-brand text-brand-primary"
        >
          {tok.value}
        </code>
      );
    if (tok.type === 'citation') return <CitationBadge key={k} id={tok.value} />;
    return null;
  });
}

function renderBlock(block: Block, key: string, seen: Set<string>): ReactNode {
  const ri = (t: string, kp: string) => renderInline(t, kp, seen);
  if (block.type === 'warning') {
    return (
      <div
        key={key}
        role="note"
        className="my-4 px-4 py-3 rounded-lg border border-yellow-500/40 bg-yellow-500/10 text-sm text-yellow-200"
      >
        <div className="font-semibold mb-1">
          ⚠️ Quelle: Gesetzestext (nicht in KB verifiziert)
        </div>
        <div className="text-yellow-100/90 whitespace-pre-wrap">
          {ri(block.text.replace(/^\s*[⚠️]\s*[^:\n]+:\s*/, '').trim(), `${key}-warn`)}
        </div>
      </div>
    );
  }
  if (block.type === 'quote') {
    // Callout with a left accent bar. Amber for ⚠️ notes (e.g. the
    // "Verifizierung unvollständig" banner, "> ⚠️ Hinweis" blocks), brand-cyan
    // otherwise. Keeps inline markdown (citations, bold) intact.
    const tone = block.warn
      ? 'border-yellow-500/60 bg-yellow-500/10 text-yellow-100/90'
      : 'border-brand-primary/50 bg-brand-primary/5 text-foreground/90';
    const lines = block.text.split(/\r?\n/);
    return (
      <div
        key={key}
        role="note"
        className={`my-4 border-l-4 pl-4 pr-3 py-2.5 rounded-r-lg ${tone}`}
      >
        {lines.map((line, i) => (
          <span key={i} className="block leading-7">
            {ri(line, `${key}-q${i}`)}
          </span>
        ))}
      </div>
    );
  }
  if (block.type === 'hr') {
    return <hr key={key} className="my-8 border-t border-border-brand/40" />;
  }
  if (block.type === 'heading') {
    const sizes = ['text-3xl', 'text-2xl', 'text-xl', 'text-lg'];
    const spacing = ['mt-8 mb-4', 'mt-6 mb-3', 'mt-5 mb-2.5', 'mt-4 mb-2'];
    const idx = Math.max(0, Math.min(block.level - 1, 3));
    const cls = `${sizes[idx]} ${spacing[idx]} font-bold font-heading text-foreground first:mt-0`;
    if (block.level === 1) return <h1 key={key} className={cls}>{ri(block.text, key)}</h1>;
    if (block.level === 2) return <h2 key={key} className={cls}>{ri(block.text, key)}</h2>;
    if (block.level === 3) return <h3 key={key} className={cls}>{ri(block.text, key)}</h3>;
    return <h4 key={key} className={cls}>{ri(block.text, key)}</h4>;
  }
  if (block.type === 'ul') {
    return (
      <ul
        key={key}
        className="list-disc list-outside pl-6 my-4 space-y-2 leading-7 marker:text-brand-primary"
      >
        {block.items.map((item, i) => (
          <li key={`${key}-${i}`} className="pl-1">
            {ri(item, `${key}-${i}`)}
          </li>
        ))}
      </ul>
    );
  }
  if (block.type === 'ol') {
    return (
      <ol
        key={key}
        className="list-decimal list-outside pl-6 my-4 space-y-2 leading-7 marker:text-brand-primary marker:font-mono"
      >
        {block.items.map((item, i) => (
          <li key={`${key}-${i}`} className="pl-1">
            {ri(item, `${key}-${i}`)}
          </li>
        ))}
      </ol>
    );
  }
  if (block.type === 'table') {
    return (
      <div
        key={key}
        className="my-4 overflow-x-auto rounded-lg border border-border-brand bg-background/30"
      >
        <table className="min-w-full text-sm border-collapse">
          <thead className="bg-background/60">
            <tr>
              {block.headers.map((h, i) => (
                <th
                  key={i}
                  className="px-4 py-2.5 text-left font-semibold whitespace-nowrap border-b border-border-brand min-w-[6rem]"
                >
                  {ri(h, `${key}-h-${i}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIdx) => (
              <tr
                key={rowIdx}
                className="odd:bg-background/30 even:bg-background/10 align-top"
              >
                {row.map((cell, ci) => {
                  const crit = parseCriticality(cell);
                  return (
                    <td
                      key={ci}
                      className="px-4 py-2.5 border-b border-border-brand/30 min-w-[8rem]"
                    >
                      {crit ? (
                        <CriticalityBadge severity={crit.severity} label={crit.label} />
                      ) : (
                        ri(cell, `${key}-r${rowIdx}c${ci}`)
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  const lines = block.text.split(/\r?\n/);
  return (
    <p key={key} className="my-4 leading-7">
      {lines.map((line, i) => (
        <span key={i}>
          {ri(line, `${key}-${i}`)}
          {i < lines.length - 1 ? <br /> : null}
        </span>
      ))}
    </p>
  );
}

function MarkdownView({ text }: { text: string }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  const seen = useMemo(() => new Set<string>(), [text]);
  return (
    <div className="text-[0.95rem] leading-7 text-foreground">
      {blocks.map((b, i) => renderBlock(b, `b${i}`, seen))}
    </div>
  );
}

// ─────────────────────────── Helpers ───────────────────────────

function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function formatUsd(usd: number): string {
  if (usd < 0.01) return `$${(usd * 100).toFixed(2)}¢`;
  return `$${usd.toFixed(4)}`;
}

function modelShortName(model: string): string {
  if (model.includes('haiku')) return 'Haiku 4.5';
  if (model.includes('sonnet')) return 'Sonnet 4.6';
  if (model.includes('opus')) return 'Opus 4.7';
  return model;
}

function groupToolCalls(calls: ToolCallSummary[]): Array<{ name: string; count: number }> {
  const map = new Map<string, number>();
  for (const c of calls) map.set(c.name, (map.get(c.name) ?? 0) + 1);
  return Array.from(map.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

// ─────────────────────────── Subcomponents ───────────────────────────

function ModeButton({
  mode,
  active,
  onClick,
}: {
  mode: (typeof MODES)[number];
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left px-3 py-2.5 rounded-lg border transition-colors ${
        active
          ? 'border-brand-primary bg-brand-primary/10 text-foreground'
          : 'border-border-brand/60 text-text-secondary hover:border-brand-primary/60 hover:text-foreground'
      }`}
      aria-pressed={active}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold">{mode.label}</span>
        <span
          className={`text-[0.65rem] font-mono px-1.5 py-0.5 rounded ${
            active
              ? 'bg-brand-primary/30 text-brand-primary'
              : 'bg-background/60 text-text-secondary/80'
          }`}
        >
          {mode.short}
        </span>
      </div>
      <div className="text-xs text-text-secondary mt-0.5 leading-snug">{mode.desc}</div>
    </button>
  );
}

function Dot() {
  return <span className="opacity-50">·</span>;
}

function MetaLine({ meta }: { meta: MessageMeta }) {
  const grouped = groupToolCalls(meta.toolCalls);
  // Missing verification metadata is an honest amber "unbekannt" — never a
  // fabricated green (F7) and never a red failure (nothing failed).
  const verifyUnknown = meta.verification.ok === 'unknown';
  const verifyFailed = meta.verification.ok === false;
  // 3.2 — "verified with warnings": hard checks passed but a soft check tripped.
  const warnings = meta.verification.ok === true ? (meta.verification.warnings ?? []) : [];
  const warned = warnings.length > 0;
  // Time-pressure degradation: the report is complete but citation verification
  // could not finish in the wall-clock budget. verifyOk is false (honest), but
  // we present it as amber "unvollständig" — distinct from a hard red ✗ and
  // never a green ✓ (the user kept a real, banner-flagged report).
  const timeDegraded = meta.degraded === 'verify';
  const passedCount =
    meta.verification.ok === true
      ? Object.values(meta.verification.checks).filter((s) => s === 'pass').length
      : 0;

  return (
    <div className="mt-6 pt-3 border-t border-border-brand/30 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-text-secondary">
      <span className="font-mono">{modelShortName(meta.model)}</span>
      <Dot />
      <span>{formatUsd(meta.cost.usd)}</span>
      <Dot />
      <span>{formatLatency(meta.latency)}</span>
      <Dot />
      <span>{meta.citations.length} Quellen</span>
      <Dot />
      <span
        className={
          verifyUnknown
            ? 'text-amber-400'
            : verifyFailed
              ? timeDegraded
                ? 'text-amber-400'
                : 'text-red-400'
              : warned
                ? 'text-amber-400'
                : 'text-emerald-400'
        }
      >
        {verifyUnknown
          ? '⚠ Verifizierungsstatus unbekannt'
          : meta.verification.ok === false
            ? timeDegraded
              ? '⚠ Verifizierung unvollständig'
              : `✗ ${meta.verification.failed}`
            : warned
              ? `⚠ Verifiziert mit Warnung (${passedCount}/5)`
              : `✓ Verifiziert (${passedCount}/5)`}
      </span>
      {meta.degraded ? (
        <>
          <Dot />
          <span
            className="text-amber-400"
            title={
              timeDegraded
                ? 'Der vollständige Bericht wird angezeigt, aber die Zitat-Verifizierung konnte im Zeitlimit nicht abgeschlossen werden — bitte markierte Stellen manuell prüfen.'
                : 'Antwort wurde am Iterations-/Kostenlimit vorzeitig abgeschlossen.'
            }
          >
            {timeDegraded ? '⚠ ungeprüft (Zeitlimit)' : '⚠ ggf. unvollständig'}
          </span>
        </>
      ) : null}
      {grouped.length > 0 ? (
        <>
          <Dot />
          <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-mono">
            {grouped.map((g, i) => (
              <span key={g.name} className="text-text-secondary/80">
                {g.name}×{g.count}
                {i < grouped.length - 1 ? (
                  <span className="opacity-40 ml-1.5">·</span>
                ) : null}
              </span>
            ))}
          </span>
        </>
      ) : null}
      {meta.verification.ok === false ? (
        <div
          className={`basis-full text-[0.7rem] mt-0.5 ${
            timeDegraded ? 'text-amber-400' : 'text-red-400'
          }`}
        >
          {meta.verification.reason}
        </div>
      ) : warned ? (
        <div className="basis-full text-amber-400 text-[0.7rem] mt-0.5">
          {warnings.map((w) => `${w.check}: ${w.reason}`).join(' · ')}
        </div>
      ) : null}
    </div>
  );
}

function UserMessage({ content }: { content: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[70%] px-4 py-3 rounded-2xl rounded-br-md bg-brand-primary text-black whitespace-pre-wrap text-[0.95rem] leading-relaxed">
        {content}
      </div>
    </div>
  );
}

function AegisMessage({ message }: { message: ChatMessage }) {
  // Prefer the structured attachment from the server (real filename, no id
  // scraping). Fall back to parsing the prose for a download id only when the
  // backend did not provide one (attachment generation failed / older turns).
  const download = useMemo(() => {
    if (message.attachment) {
      return { id: message.attachment.downloadId, filename: message.attachment.filename };
    }
    return extractDownloadInfo(message.content);
  }, [message.attachment, message.content]);

  // When we have a structured attachment, never let an internal id leak through
  // the prose — strip the exact download id from the rendered text.
  const displayText = useMemo(() => {
    if (message.attachment) {
      return stripDownloadId(message.content, message.attachment.downloadId);
    }
    return message.content;
  }, [message.attachment, message.content]);

  return (
    <article className="w-full border-t border-border-brand/30 pt-6 first:border-t-0 first:pt-0">
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2.5 text-[0.72rem] font-mono uppercase tracking-wider text-text-secondary">
          <AegisMark className="w-8 h-8" />
          <span>AEGIS — KI-Regulatorik-Berater</span>
        </div>
        <AegisTtsButton text={displayText} />
      </div>
      <MarkdownView text={displayText} />
      {download && (
        <DownloadAttachment
          downloadId={download.id}
          filename={download.filename}
          structured={!!message.attachment}
        />
      )}
      {message.meta ? <MetaLine meta={message.meta} /> : null}
    </article>
  );
}

function ErrorMessage({ content }: { content: string }) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[70%] px-4 py-3 rounded-2xl rounded-bl-md bg-red-500/10 border border-red-500/40 text-sm text-red-300">
        <div className="font-semibold mb-1">Fehler</div>
        <div className="whitespace-pre-wrap">{content}</div>
      </div>
    </div>
  );
}

function LoadingMessage() {
  return (
    <div className="flex justify-start">
      <div className="px-4 py-3 rounded-2xl rounded-bl-md bg-surface border border-border-brand/60 inline-flex items-center gap-2.5 text-sm text-text-secondary">
        <AegisMark className="w-6 h-6" spin />
        <span className="loading-dots">AEGIS analysiert</span>
      </div>
    </div>
  );
}

// Inline-only renderer for partial text: handles citations and bold/italic/code
// but skips block-level constructs (tables, headings, lists). Used during
// streaming where the full markdown may not be complete yet.
function StreamingInline({ text }: { text: string }) {
  return (
    <span className="whitespace-pre-wrap leading-relaxed">
      {renderInline(text, 'stream')}
    </span>
  );
}

type ToolProgressView = {
  iteration: number;
  toolName: string;
  preview?: string;
  isError?: boolean;
};

function StreamingProgressLine({
  phase,
  toolProgress,
  message,
}: {
  phase: 'tools' | 'generating';
  toolProgress: ToolProgressView | null;
  message?: string | null;
}) {
  if (phase === 'generating' && !toolProgress) {
    return (
      <span className="inline-flex items-center gap-2 text-xs text-text-secondary">
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-brand-primary opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-brand-primary" />
        </span>
        <span className="loading-dots">{message ?? 'Generiere Analyse'}</span>
      </span>
    );
  }
  if (!toolProgress) {
    return (
      <span className="inline-flex items-center gap-2 text-xs text-text-secondary">
        <span className="loading-dots">{message ?? 'AEGIS analysiert'}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2 text-xs text-text-secondary">
      <span className="font-mono text-brand-primary">{toolProgress.toolName}</span>
      <span className="opacity-50">·</span>
      <span>Iteration {toolProgress.iteration + 1}</span>
      {toolProgress.preview ? (
        <>
          <span className="opacity-50">·</span>
          <span className="text-text-secondary/70 max-w-[40ch] truncate">
            {toolProgress.preview}
          </span>
        </>
      ) : (
        <span className="loading-dots opacity-70" />
      )}
    </span>
  );
}

function StreamingMessage({
  text,
  phase,
  toolProgress,
  message,
}: {
  text: string;
  phase: 'tools' | 'generating';
  toolProgress: ToolProgressView | null;
  message?: string | null;
}) {
  return (
    <article className="w-full border-t border-border-brand/30 pt-6 first:border-t-0 first:pt-0">
      <div className="flex items-center gap-2.5 mb-3 text-[0.72rem] font-mono uppercase tracking-wider text-text-secondary">
        <AegisMark className="w-8 h-8" spin />
        <span>AEGIS — KI-Regulatorik-Berater</span>
      </div>
      {text.length > 0 ? (
        <div className="text-[0.95rem] text-foreground">
          <StreamingInline text={text} />
          <span
            className="inline-block w-1.5 h-4 ml-0.5 align-middle bg-brand-primary animate-pulse"
            aria-hidden="true"
          />
        </div>
      ) : null}
      <div className="mt-4 pt-3 border-t border-border-brand/30">
        <StreamingProgressLine phase={phase} toolProgress={toolProgress} message={message} />
      </div>
    </article>
  );
}

function RetryNotice({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-yellow-500/40 bg-yellow-500/10 px-4 py-2.5 text-xs text-yellow-200"
    >
      <span className="font-semibold">⚠️ {message}</span>
    </div>
  );
}

const DOWNLOAD_RE = /(?:Download|Herunterladen|download)[^{]*\{?\s*(?:downloadId|id)\s*[:=]\s*"?([0-9a-f-]{36})"?/i;
const DOWNLOAD_ID_RE = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b.*?\.xlsx/i;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Render a generated download as a proper attachment. With a structured
 * attachment (`structured`), show the success header + the real filename. The
 * internal download id is only ever used to build the href, never displayed.
 */
function DownloadAttachment({
  downloadId,
  filename,
  structured,
}: {
  downloadId: string;
  filename: string;
  structured: boolean;
}) {
  const label = filename || 'AEGIS_assessment.xlsx';
  return (
    <div className="mt-4">
      {structured && (
        <div className="mb-2 text-sm font-semibold text-emerald-300">
          &#x2705; Lückenanalyse erstellt
        </div>
      )}
      <a
        href={`/api/aegis/download/${downloadId}`}
        download={label}
        className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-emerald-600/20 border border-emerald-500/50 text-emerald-300 hover:bg-emerald-600/30 hover:border-emerald-400/70 transition-colors text-sm font-semibold"
      >
        <span className="text-lg">&#x2B07;</span>
        <span>{label}</span>
      </a>
    </div>
  );
}

function extractDownloadInfo(text: string): { id: string; filename: string } | null {
  const m1 = text.match(DOWNLOAD_RE);
  if (m1) return { id: m1[1], filename: 'AEGIS_assessment.xlsx' };
  const m2 = text.match(DOWNLOAD_ID_RE);
  if (m2) return { id: m2[1], filename: 'AEGIS_assessment.xlsx' };
  return null;
}

/**
 * Remove the internal download id (and any "Download-ID: …" label around it)
 * from the assistant prose so it is never shown — the download link carries it.
 */
function stripDownloadId(text: string, downloadId: string): string {
  return text
    .split(downloadId)
    .join('')
    .replace(/Download[-\s]?ID\s*[:=]?\s*/gi, '')
    .replace(UUID_RE, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function DragOverlay() {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm border-2 border-dashed border-brand-primary rounded-xl pointer-events-none">
      <div className="text-center">
        <div className="text-4xl mb-2">&#x1F4CE;</div>
        <div className="text-lg font-semibold text-brand-primary">Datei hier ablegen</div>
        <div className="text-sm text-text-secondary mt-1">PDF, DOCX, PPTX, XLSX oder TXT · max. 4 MB</div>
      </div>
    </div>
  );
}

const MODE_TAG_CLS: Record<AegisMode, string> = {
  ASSESS: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  CONVERSATIONAL: 'bg-sky-500/15 text-sky-400 border-sky-500/30',
  GAP_ANALYZE: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
};

const MODE_SHORT: Record<AegisMode, string> = {
  ASSESS: 'ASSESS',
  CONVERSATIONAL: 'CONV',
  GAP_ANALYZE: 'GAP',
};

function SectionDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-4 my-8">
      <div className="flex-1 h-px bg-border-brand" />
      <span className="text-xs font-mono uppercase tracking-wider text-text-secondary/70">{label}</span>
      <div className="flex-1 h-px bg-border-brand" />
    </div>
  );
}

function EmptyState({
  onPick,
  onModeSelect,
  totalRequirements,
  totalRegulations,
}: {
  onPick: (prompt: string, mode: AegisMode) => void;
  onModeSelect: (mode: AegisMode) => void;
  totalRequirements: number;
  totalRegulations: number;
}) {
  return (
    <div className="flex flex-col items-center min-h-full py-10 px-4 overflow-y-auto">
      <div className="w-full max-w-3xl">
        {/* Hero */}
        <div className="text-center mb-6">
          <div className="flex justify-center mb-5">
            <AegisOrb state="idle" size="lg" />
          </div>
          <h1 className="text-5xl md:text-6xl font-bold font-heading mb-2 tracking-tight">
            AEGIS
          </h1>
          <p className="text-brand-primary text-base md:text-lg font-semibold mb-3">
            Der KI-Regulatorik-Berater von RegCompass
          </p>
          <p className="text-text-secondary text-sm md:text-base">
            Gestützt auf{' '}
            <span className="text-foreground font-semibold">{totalRequirements} verifizierte Anforderungen</span>{' '}
            aus{' '}
            <span className="text-foreground font-semibold">{totalRegulations} Gesetzen</span>.
          </p>
        </div>

        {/* Mode cards with integrated example */}
        <SectionDivider label="Was kann AEGIS?" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {MODE_CARDS.map((m) => (
            <div
              key={m.key}
              className="rounded-xl border border-border-brand bg-surface/50 hover:border-brand-primary/60 transition-colors overflow-hidden"
            >
              <button
                type="button"
                onClick={() => onModeSelect(m.mode)}
                className="w-full text-left p-5 pb-3"
              >
                <div className="flex items-center gap-2.5 mb-2">
                  <span className="text-xl">{m.icon}</span>
                  <span className="text-sm font-semibold font-heading">{m.title}</span>
                  <span className={`ml-auto px-1.5 py-0.5 text-[0.6rem] font-mono rounded border ${MODE_TAG_CLS[m.mode]}`}>
                    {MODE_SHORT[m.mode]}
                  </span>
                </div>
                <p className="text-xs text-text-secondary leading-relaxed">{m.desc}</p>
              </button>
              <div className="px-5 pb-4">
                <button
                  type="button"
                  onClick={() => onPick(m.example, m.mode)}
                  className="group w-full text-left px-3 py-2 rounded-lg bg-background/50 border border-border-brand/60 hover:border-brand-primary/50 hover:bg-brand-primary/5 transition-colors"
                >
                  <span className="text-xs text-text-secondary/70 group-hover:text-brand-primary transition-colors">
                    &ldquo;{m.example}&rdquo;
                  </span>
                  {m.hint && (
                    <span className="ml-1.5 text-[0.65rem] text-text-secondary/50">
                      &#x1F4CE; {m.hint}
                    </span>
                  )}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────── Main panel ───────────────────────────

export function AegisChatPanel({
  totalRequirements,
  totalRegulations,
  isAdmin = false,
}: {
  totalRequirements: number;
  totalRegulations: number;
  isAdmin?: boolean;
}) {
  // All chat state (messages, isLoading, mode, input) lives in a module-level
  // store so it survives navigation to /kb, /assess, etc. while a long-running
  // AEGIS request is in flight. See lib/aegis/client-store.ts.
  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const {
    messages,
    isLoading,
    mode,
    input,
    streamingText,
    streamingPhase,
    toolProgress,
    streamingMessage,
    retryNotice,
    uploadedDocuments,
    isUploading,
    conversationId,
    job,
  } = state;

  const [isDragging, setIsDragging] = useState(false);
  const [voiceMode, setVoiceMode] = useState(false);
  // Inline voice (composer strip) — mutually exclusive with the fullscreen
  // `voiceMode`; only one AegisVoiceMode may own the shared voice sink at a time.
  const [inlineVoice, setInlineVoice] = useState(false);
  // AEGIS Translate: per-document translation state for the pre-analysis offer.
  const [translatingDocId, setTranslatingDocId] = useState<string | null>(null);
  const [dismissedTranslate, setDismissedTranslate] = useState<Set<string>>(new Set());
  const dragCounterRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Stop any in-progress TTS whenever a new request kicks off — nothing more
  // annoying than the previous answer still being read while the new one
  // streams in.
  useEffect(() => {
    if (isLoading) stopAegisTts();
  }, [isLoading]);

  // Resume the persisted conversation (Phase 2 memory): fetch the server
  // transcript on first mount. No-op when a chat is already live in the tab.
  useEffect(() => {
    void hydrateConversation();
    // PR 3: a reload during a sectioned report silently reconnects to the job.
    maybeResumeStoredJob();
  }, []);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Tracks whether the user is reading the bottom of the chat. If they have
  // scrolled up, we don't yank them back to the bottom on every render —
  // only their own messages or the very next-message-after-they-return.
  const isNearBottomRef = useRef(true);

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: 'smooth',
      });
    });
  }, []);

  // Track scroll position to decide whether auto-scroll should fire.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    function onScroll() {
      if (!el) return;
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      isNearBottomRef.current = distFromBottom < 100;
    }
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // Auto-scroll rules: always for the user's own message (they expect to see
  // their input appear), and for AEGIS replies only if the user is still
  // near the bottom.
  useEffect(() => {
    const lastMsg = messages[messages.length - 1];
    if (!lastMsg) return;
    if (lastMsg.role === 'user') {
      isNearBottomRef.current = true;
      scrollToBottom();
    } else if (isNearBottomRef.current) {
      scrollToBottom();
    }
  }, [messages, scrollToBottom]);

  useEffect(() => {
    if (isLoading && isNearBottomRef.current) scrollToBottom();
  }, [isLoading, scrollToBottom]);

  // Keep the chat pinned to the bottom while tokens stream in (same
  // near-bottom heuristic — do not yank the user back if they scrolled up).
  useEffect(() => {
    if (streamingText && isNearBottomRef.current) scrollToBottom();
  }, [streamingText, scrollToBottom]);

  // When the user lands on /aegis with an in-flight or finished request,
  // scroll to bottom so they see the freshest state.
  useEffect(() => {
    isNearBottomRef.current = true;
    scrollToBottom();
    // Run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cmd+K / Ctrl+K to clear
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        storeClearChat();
        inputRef.current?.focus();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const handleFileUpload = useCallback(async (file: File) => {
    await storeUploadDocument(file);
  }, []);

  const sendWithDocuments = useCallback(() => {
    if (uploadedDocuments.length > 0) {
      const prompt = buildAnalysisPrompt(input);
      if (prompt) {
        void storeSendMessage(prompt.prompt, prompt.mode);
        clearUploadedDocuments();
        storeSetInput('');
        return;
      }
    }
    void storeSendMessage(input);
  }, [input, uploadedDocuments]);

  const onDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (dragCounterRef.current === 1) setIsDragging(true);
  }, []);

  const onDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) setIsDragging(false);
  }, []);

  const onDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const onDrop = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) void handleFileUpload(file);
  }, [handleFileUpload]);

  function onTextareaKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendWithDocuments();
    }
  }

  const activeMode = MODES.find((m) => m.id === mode)!;

  return (
    <>
    {voiceMode ? <AegisVoiceMode onClose={() => setVoiceMode(false)} /> : null}
    <div className="h-[calc(100vh-3.5rem)] flex">
      {/* Sidebar */}
      <aside className="hidden md:flex md:w-56 flex-col border-r border-border-brand bg-surface/30 shrink-0">
        <div className="px-5 py-5 border-b border-border-brand">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-8 h-8 rounded-lg bg-brand-primary/15 border border-brand-primary/40 flex items-center justify-center text-brand-primary font-mono text-xs">
              AE
            </div>
            <div>
              <div className="font-heading font-bold text-base leading-none">AEGIS</div>
              <div className="text-[0.7rem] text-text-secondary mt-0.5 leading-none">
                KI-Regulatorik auf einen Blick
              </div>
            </div>
          </div>
        </div>
        <div className="px-5 py-4 flex-1 overflow-y-auto">
          <div className="text-xs font-mono uppercase tracking-wider text-text-secondary/70 mb-2.5">
            Modus
          </div>
          <div className="space-y-2">
            {MODES.map((m) => (
              <ModeButton
                key={m.id}
                mode={m}
                active={m.id === mode}
                onClick={() => storeSetMode(m.id)}
              />
            ))}
          </div>
        </div>
        <div className="px-5 py-4 border-t border-border-brand text-[0.7rem] text-text-secondary/70 space-y-1">
          <div>
            <kbd className="font-mono px-1 py-0.5 rounded bg-background/60 border border-border-brand">
              Enter
            </kbd>{' '}
            senden ·{' '}
            <kbd className="font-mono px-1 py-0.5 rounded bg-background/60 border border-border-brand">
              Shift+Enter
            </kbd>{' '}
            Zeilenumbruch
          </div>
          <div>
            <kbd className="font-mono px-1 py-0.5 rounded bg-background/60 border border-border-brand">
              ⌘K
            </kbd>{' '}
            Chat leeren
          </div>
        </div>
      </aside>

      {/* Chat area */}
      <div
        className="flex-1 flex flex-col min-w-0 relative"
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        {isDragging && <DragOverlay />}
        {/* Header */}
        <header className="px-4 md:px-6 py-3 border-b border-border-brand flex items-center justify-between gap-3 bg-background/80 backdrop-blur">
          <div className="flex items-center gap-3 min-w-0">
            <Link
              href="/"
              aria-label="Zurück zur Startseite"
              title="Zurück zur Startseite"
              className="shrink-0 -ml-1 p-1.5 rounded-lg text-text-secondary hover:text-brand-primary hover:bg-surface/60 transition-colors no-underline"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M19 12H5" />
                <path d="M12 19l-7-7 7-7" />
              </svg>
            </Link>
            <span className="md:hidden w-2 h-2 rounded-full bg-brand-primary shrink-0" />
            <div className="min-w-0">
              <div className="text-sm font-semibold truncate">
                {activeMode.label}{' '}
                <span className="text-text-secondary font-normal">— {activeMode.desc}</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => {
                // Unlock audio inside this tap so the greeting + replies can
                // play from async callbacks later (iOS/Safari autoplay policy).
                primeSpeech();
                setInlineVoice(false); // never run both voice presentations at once
                setVoiceMode(true);
              }}
              title="Sprachmodus — mit AEGIS sprechen"
              className="inline-flex items-center gap-1.5 rounded-full border border-brand-primary/40 bg-brand-primary/10 px-2.5 py-1 text-xs font-semibold text-brand-primary hover:bg-brand-primary/20 transition-colors shrink-0"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4" />
              </svg>
              <span className="hidden sm:inline">Sprachmodus</span>
            </button>
            <AegisExportMenu conversationId={conversationId} />
            <AegisContextHealth />
            <AegisVoicePicker />
            {messages.length > 0 ? (
              <button
                type="button"
                onClick={() => storeClearChat()}
                className="text-xs text-text-secondary hover:text-brand-primary transition-colors shrink-0"
              >
                Chat leeren
              </button>
            ) : null}
          </div>
        </header>

        {/* Mobile mode selector */}
        <div className="md:hidden border-b border-border-brand bg-surface/30 overflow-x-auto">
          <div className="flex gap-2 px-4 py-2 min-w-max">
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => storeSetMode(m.id)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-full border whitespace-nowrap transition-colors ${
                  m.id === mode
                    ? 'border-brand-primary bg-brand-primary/15 text-brand-primary'
                    : 'border-border-brand text-text-secondary'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          {messages.length === 0 ? (
            <EmptyState
              onPick={(prompt, exampleMode) => {
                void storeSendMessage(prompt, exampleMode);
              }}
              onModeSelect={(m) => storeSetMode(m)}
              totalRequirements={totalRequirements}
              totalRegulations={totalRegulations}
            />
          ) : (
            <div className="max-w-4xl mx-auto px-6 md:px-10 py-6 space-y-5">
              {messages.map((m) => {
                if (m.role === 'user')
                  return <UserMessage key={m.id} content={m.content} />;
                if (m.role === 'error')
                  return <ErrorMessage key={m.id} content={m.content} />;
                return <AegisMessage key={m.id} message={m} />;
              })}
              {job ? <ReportProgress job={job} /> : null}
              {isLoading && streamingPhase ? (
                <StreamingMessage
                  text={streamingText}
                  phase={streamingPhase}
                  toolProgress={toolProgress}
                  message={streamingMessage}
                />
              ) : isLoading ? (
                <LoadingMessage />
              ) : null}
              {retryNotice ? <RetryNotice message={retryNotice} /> : null}
            </div>
          )}
        </div>

        {/* Input */}
        <div className="border-t border-border-brand bg-background/80 backdrop-blur">
          <div className="max-w-4xl mx-auto px-6 md:px-10 py-3">
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPT_EXTENSIONS.join(',')}
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFileUpload(file);
                e.target.value = '';
              }}
            />
            {(() => {
              if (!isAdmin) return null; // Übersetzung ist eine Admin-Funktion.
              const foreign = uploadedDocuments.find(
                (d) =>
                  d.type === 'policy' &&
                  !d.isTranslation &&
                  d.originalLanguage &&
                  !['DE', 'EN'].includes(d.originalLanguage.toUpperCase()) &&
                  !dismissedTranslate.has(d.id),
              );
              if (!foreign) return null;
              const busy = translatingDocId === foreign.id;
              const run = async (target: string) => {
                setTranslatingDocId(foreign.id);
                await translateUploadedDocument(foreign.id, target);
                setTranslatingDocId(null);
              };
              return (
                <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-xs text-sky-200">
                  <span>
                    Dieses Dokument ist auf <strong>{foreign.originalLanguage}</strong>. Vor der Analyse übersetzen?
                  </span>
                  <button disabled={busy} onClick={() => void run('DE')} className="rounded bg-sky-500/20 px-2 py-0.5 font-medium hover:bg-sky-500/30 disabled:opacity-50">🇩🇪 Deutsch</button>
                  <button disabled={busy} onClick={() => void run('EN')} className="rounded bg-sky-500/20 px-2 py-0.5 font-medium hover:bg-sky-500/30 disabled:opacity-50">🇬🇧 English</button>
                  <select
                    disabled={busy}
                    defaultValue=""
                    onChange={(e) => { const v = e.target.value; if (v) void run(v); e.target.value = ''; }}
                    className="rounded border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-sky-100 disabled:opacity-50"
                    aria-label="Weitere Zielsprache"
                  >
                    <option value="">Weitere Sprache …</option>
                    {TRANSLATION_TARGETS.filter((t) => t.code !== 'DE' && t.code !== 'EN').map((t) => (
                      <option key={t.code} value={t.code} className="text-black">{t.flag} {t.label}</option>
                    ))}
                  </select>
                  <button disabled={busy} onClick={() => setDismissedTranslate((s) => new Set(s).add(foreign.id))} className="rounded px-2 py-0.5 text-sky-200/80 hover:text-sky-100 disabled:opacity-50">Original behalten</button>
                  {busy && <span className="text-sky-200/80">Übersetzung läuft … (DeepL)</span>}
                </div>
              );
            })()}
            {uploadedDocuments.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {uploadedDocuments.map((doc) => (
                  <span
                    key={doc.id}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg bg-brand-primary/10 border border-brand-primary/30 text-brand-primary"
                  >
                    <span>{doc.isTranslation ? '\u{1F310}' : doc.type === 'template' ? '\u{1F4CA}' : '\u{1F4C4}'}</span>
                    <span className="max-w-[150px] truncate">{doc.filename}</span>
                    <button
                      type="button"
                      onClick={() => removeUploadedDocument(doc.id)}
                      className="hover:text-red-400 transition-colors"
                      aria-label="Entfernen"
                    >
                      &#x2715;
                    </button>
                  </span>
                ))}
                {uploadedDocuments.length < 2 && (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="px-2 py-1 text-xs rounded-lg border border-dashed border-brand-primary/40 text-brand-primary/70 hover:text-brand-primary hover:border-brand-primary/60 transition-colors"
                  >
                    + Datei
                  </button>
                )}
              </div>
            )}
            {inlineVoice ? (
              <div className="mb-2">
                <AegisVoiceMode variant="inline" onClose={() => setInlineVoice(false)} />
              </div>
            ) : null}
            <div className="flex items-end gap-2">
              <button
                type="button"
                onClick={() => {
                  if (inlineVoice) {
                    setInlineVoice(false);
                    return;
                  }
                  // Unlock audio inside the tap (autoplay policy); close the
                  // fullscreen variant so only one voice session is ever active.
                  primeSpeech();
                  setVoiceMode(false);
                  setInlineVoice(true);
                }}
                aria-pressed={inlineVoice}
                aria-label="Sprachmodus"
                title="Sprachmodus — mit AEGIS sprechen"
                className={`p-2.5 rounded-xl border transition-colors shrink-0 ${
                  inlineVoice
                    ? 'border-brand-primary text-brand-primary bg-brand-primary/15'
                    : 'border-border-brand bg-surface/60 text-text-secondary hover:border-brand-primary hover:text-brand-primary'
                }`}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4" />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={isLoading || isUploading || uploadedDocuments.length >= 2}
                className="p-2.5 rounded-xl border border-border-brand bg-surface/60 text-text-secondary hover:border-brand-primary hover:text-brand-primary disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
                aria-label="Datei hochladen"
                title="PDF, DOCX, PPTX, XLSX oder TXT hochladen (max. 4 MB)"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
                </svg>
              </button>
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => storeSetInput(e.target.value)}
                onKeyDown={onTextareaKey}
                maxLength={AEGIS_MESSAGE_MAX_CHARS_DEFAULT}
                placeholder={uploadedDocuments.length > 0 ? 'Anweisung zur Datei (optional — Enter für Standard-Analyse)...' : `Frage in Modus ${activeMode.short}...`}
                rows={1}
                disabled={isLoading}
                className="flex-1 resize-none px-4 py-2.5 rounded-xl border border-border-brand bg-surface/60 text-sm text-foreground placeholder:text-text-secondary/60 focus:outline-none focus:border-brand-primary focus:bg-surface transition-colors disabled:opacity-50 max-h-40"
                style={{ minHeight: '2.75rem' }}
              />
              <button
                type="button"
                onClick={sendWithDocuments}
                disabled={isLoading || (input.trim().length < 5 && uploadedDocuments.length === 0)}
                className="px-4 py-2.5 rounded-xl bg-brand-primary text-black text-sm font-semibold hover:bg-cyan-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
                aria-label="Senden"
              >
                Senden
              </button>
            </div>
            <div className="mt-1.5 text-[0.7rem] text-text-secondary/70 flex items-center gap-2">
              <span>
                AEGIS gibt regulatorische Informationen wieder — keine Rechtsberatung.
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
    </>
  );
}
