/**
 * Shared request-size limits. Client-safe (no server-only imports) so the chat
 * panel's `maxLength` and the server's Zod bound come from ONE constant and
 * cannot drift apart. The server side may still be raised per deployment via
 * `AEGIS_MESSAGE_MAX_CHARS` (see types.ts); the client default then simply
 * stops short of the server bound, which is safe in that direction.
 *
 * 32k chars ≈ 9k tokens (de) — large enough for multi-section report prompts
 * (sectioned generation), small enough to stay far below the context window.
 */
export const AEGIS_MESSAGE_MAX_CHARS_DEFAULT = 32_000;
