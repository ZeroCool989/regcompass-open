/**
 * Zentrale deutsche Status- und Hinweistexte für die AEGIS-UI. Client-safe
 * (keine Server-Imports). PR 3 (Sectioned Generation) zieht alle verstreuten
 * Status-Strings hierher; bis dahin landen NEUE user-sichtbare Texte bereits
 * in dieser Datei (CLAUDE.md-Invariante 6).
 */

/**
 * An einen bei Timeout erhaltenen Teil-Entwurf angehängter Hinweis — der
 * gestreamte Text bleibt sichtbar, statt durch die Fehlermeldung ersetzt zu
 * werden. Als `>`-Callout gerendert wie die übrigen AEGIS-Banner.
 *
 * Der Hinweis MUSS den Unverifiziert-Status benennen: ein Timeout schlägt zu,
 * bevor `verifyResponse` laufen konnte — der erhaltene Entwurf ist also nie
 * gegen die Wissensbasis geprüft worden (anders als die Degradation-Banner
 * aus loop.ts, die NACH gelaufenem Verify ausgeliefert werden).
 */
export const TIMEOUT_DRAFT_NOTE_DE =
  '\n\n> ⚠️ **Antwort unvollständig — nicht verifiziert:** Die Generierung ' +
  'wurde wegen Zeitüberschreitung beendet, bevor die Verifikation gegen die ' +
  'Wissensbasis laufen konnte. Bitte Zitate und Regulierungsangaben im ' +
  'obigen Entwurf vor Verwendung manuell prüfen und den fehlenden Teil ' +
  'gezielt anfordern.';

// ── fill_template / Conversation-Quelle (Tool-Fehlertexte, deutsch) ────────

/** Weder Dokument noch Conversation-Kontext als Quelle verfügbar. */
export const FILL_NO_SOURCE_DE =
  'Keine Quelle für die Befüllung: Es liegt weder ein Policy-Dokument noch ' +
  'eine Unterhaltung mit Analyse-Ergebnissen vor.';

/** Unbekannte/fremde/abgelaufene Conversation — bewusst identisch für alle drei Fälle (kein Existenz-Orakel). */
export const FILL_CONVERSATION_NOT_FOUND_DE =
  'Unterhaltung nicht gefunden oder abgelaufen.';

/** Conversation-Quelle enthielt keine übertragbaren Findings. */
export const FILL_NO_FINDINGS_DE =
  'In der Unterhaltung wurden keine übertragbaren Findings gefunden. Bitte ' +
  'zuerst eine Analyse durchführen oder ein Policy-Dokument hochladen.';

/** Kennzeichnung für Zellen/Findings aus nicht abschließend verifizierten Quellen. */
export const UNVERIFIED_SOURCE_NOTE_DE =
  'Quelle nicht abschließend verifiziert — vor Verwendung manuell prüfen.';

// ── API-Fehlertexte (deutsch, LP-6/F5) ─────────────────────────────────────

/**
 * Deutsche Texte je Fehlercode. Für die INTERNAL_ERROR_CODES ersetzt die Map
 * die Server-Message IMMER (dort stehen englische Interna wie "Anthropic API
 * returned 5xx" — Detail gehört ins Server-Log, nicht in die Chat-UI); für
 * alle übrigen Codes greift sie nur, wenn die Server-Message fehlt.
 */
export const API_ERROR_DE: Record<string, string> = {
  rate_limited: 'Anfrage-Limit erreicht. Bitte später erneut versuchen.',
  unauthorized: 'Bitte melden Sie sich an, um AEGIS zu nutzen.',
  not_approved: 'Ihr Konto wartet auf Freigabe durch einen Administrator.',
  invalid_input: 'Die Anfrage war ungültig. Bitte Eingaben prüfen.',
  not_found: 'Nicht gefunden oder abgelaufen.',
  parse_error: 'Das Dokument konnte nicht gelesen werden.',
  no_extractable_text:
    'Kein auswertbarer Text im Dokument gefunden — vermutlich ein gescanntes PDF.',
  timeout: 'Die Anfrage hat das Zeitlimit überschritten. Bitte erneut versuchen.',
  upstream_error:
    'Der KI-Dienst ist derzeit nicht erreichbar oder überlastet. Bitte in Kürze erneut versuchen.',
  internal_error: 'Unerwarteter Fehler. Bitte erneut versuchen.',
};

/** Codes, deren Server-Message technische Interna trägt — nie roh anzeigen. */
const INTERNAL_ERROR_CODES = new Set(['upstream_error', 'internal_error']);

/**
 * Deutsche Fehlermeldung für eine API-/Stream-Fehlerantwort. Nie rohe
 * `code: message`-Interna (LP-6): interne Codes werden immer übersetzt,
 * ansonsten gilt die (inzwischen deutsche) Server-Message, dann die Map,
 * dann ein generischer deutscher Fallback.
 */
export function apiErrorMessageDe(
  code: string | undefined,
  message: string | undefined,
  status?: number,
): string {
  if (code && INTERNAL_ERROR_CODES.has(code)) return API_ERROR_DE[code];
  const m = message?.trim();
  if (m) return m;
  if (code && API_ERROR_DE[code]) return API_ERROR_DE[code];
  return status
    ? `Fehler (HTTP ${status}). Bitte erneut versuchen.`
    : 'Unerwarteter Fehler. Bitte erneut versuchen.';
}

// ── Sectioned Generation (PR 2/PR 3, deutsch) ──────────────────────────────

/**
 * F8-Fußnote unter einem Abschnitt, der allowlistete externe Standards
 * referenziert: die Standards existieren, sind aber NICHT Teil der
 * Wissensbasis — der Verweis ist nicht quellen-verifiziert. Kein Silent-Pass.
 */
export function EXTERNAL_STANDARDS_FOOTNOTE_DE(refs: string[]): string {
  return (
    `> ℹ️ **Externe Standards referenziert:** ${refs.join(', ')} — nicht Teil ` +
    'der RegCompass-Wissensbasis; Verweis nicht quellen-verifiziert.'
  );
}

/** Kennzeichnung von Beratungs-Abschnitten (grounded=false) im Gesamtreport. */
export const ADVISORY_SECTION_NOTE_DE =
  '*Beratungsinhalt — ohne Anker in der Wissensbasis, nicht zitatgeprüft.*';

/**
 * Hinweis unter einem `degraded` Abschnitt im Gesamtreport: Verify ist
 * GELAUFEN und hat nicht bestanden (anders als die Timeout-Notizen oben, bei
 * denen Verify nie lief). Ehrlichkeit vor Glanz — D9: der Hinweis erscheint
 * nur bei echten Verify-Fehlschlägen, nie aus Zeitdruck.
 */
export const DEGRADED_SECTION_NOTE_DE =
  '> ⚠️ **Abschnitt nicht vollständig verifiziert** — Zitate und ' +
  'Regulierungsangaben in diesem Abschnitt vor Verwendung manuell prüfen.';

/** Statuszeile, solange der Plan-Pass läuft (zwischen job_created und erster Section). */
export const SECTIONED_PLANNING_DE = 'Gliederung wird erstellt …';

/** Statuszeile während eine Section geschrieben wird. */
export function SECTION_WRITING_DE(index: number, total: number, title: string): string {
  return `Abschnitt ${index + 1}/${total}: ${title}`;
}

/**
 * Pausen-Status (P3-Zeitgate oder Reconnect) — bewusst OHNE Fehlerton: die
 * Fortsetzung ist der Normalfall (Eiserne Regel; Client reconnected sofort).
 */
export const SECTIONED_PAUSED_DE = 'Wird fortgesetzt …';

/** Meta-Grund für einen Report mit mindestens einem degraded Abschnitt. */
export function SECTIONED_DEGRADED_REASON_DE(degraded: number, total: number): string {
  return `${degraded} von ${total} Abschnitten nicht vollständig verifiziert.`;
}

/** Fehlerzeile, wenn ein Job endgültig scheitert (fertige Abschnitte bleiben erhalten). */
export const SECTIONED_FAILED_DE =
  'Der Report konnte nicht fortgesetzt werden. Bereits fertige Abschnitte sind gespeichert.';

/**
 * Wie TIMEOUT_DRAFT_NOTE_DE, aber für alle übrigen abnormalen Stream-Enden
 * (Verbindungsabbruch, Server-Fehler, fehlendes Terminal-Event): der bereits
 * gestreamte Entwurf bleibt erhalten statt durch die Fehlerzeile ersetzt zu
 * werden (LP-2). Auch hier gilt: Verify ist nie gelaufen — der Entwurf ist
 * nicht verifiziert und muss manuell geprüft werden.
 */
export const ABNORMAL_END_DRAFT_NOTE_DE =
  '\n\n> ⚠️ **Antwort unvollständig — nicht verifiziert:** Die Generierung ' +
  'wurde unerwartet unterbrochen, bevor die Verifikation gegen die ' +
  'Wissensbasis laufen konnte. Bitte Zitate und Regulierungsangaben im ' +
  'obigen Entwurf vor Verwendung manuell prüfen und den fehlenden Teil ' +
  'gezielt anfordern.';
