import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
import type { ExcelData } from './parsers';

/**
 * Persistent store for uploaded documents (gap-analysis policies, Excel
 * templates, filled outputs). Postgres-backed so documents survive serverless
 * cold starts and are visible across instances — the previous in-memory Map
 * lost every upload whenever a new instance served the next request.
 *
 * Every read is scoped to the owning session (signed cookie, see
 * `lib/session.ts`): without the right `sessionId` a document id resolves to
 * nothing, which closes the unauthenticated-download hole.
 *
 * Rows expire after `EXPIRY_MS` (enforced on read); expired rows are cleaned
 * up lazily on each write.
 */

export type StoredDocument = {
  id: string;
  filename: string;
  // 'deck' = a generated PPTX management summary (binary held in `excelBuffer`).
  // 'export' = a generated deliverable from the export engine (xlsx/docx/pdf,
  // binary also in `excelBuffer` — the generic binary column).
  type: 'policy' | 'template' | 'deck' | 'export';
  textContent: string;
  excelData?: ExcelData;
  excelBuffer?: Buffer;
  uploadedAt: number;
};

// 24h: long enough that a browser refresh (or a short break) during a session
// keeps uploaded policies, templates and generated downloads available, while
// still bounding storage. Override via AEGIS_DOCUMENT_TTL_HOURS.
const EXPIRY_MS = (() => {
  const h = Number(process.env.AEGIS_DOCUMENT_TTL_HOURS);
  return (Number.isFinite(h) && h > 0 ? h : 24) * 60 * 60 * 1000;
})();

export async function storeDocument(
  doc: Omit<StoredDocument, 'id' | 'uploadedAt'>,
  sessionId: string,
): Promise<string> {
  const id = randomUUID();
  const now = Date.now();
  await db.aegisDocument.create({
    data: {
      id,
      sessionId,
      filename: doc.filename,
      type: doc.type,
      textContent: doc.textContent,
      excelData: doc.excelData
        ? (doc.excelData as unknown as object)
        : undefined,
      // Prisma 7's Bytes input wants a plain Uint8Array (Buffer's ArrayBufferLike
      // backing store doesn't satisfy it).
      excelBuffer: doc.excelBuffer ? new Uint8Array(doc.excelBuffer) : undefined,
      expiresAt: new Date(now + EXPIRY_MS),
    },
  });
  // Lazy cleanup — never blocks or fails the write it piggybacks on.
  void db.aegisDocument
    .deleteMany({ where: { expiresAt: { lt: new Date(now) } } })
    .catch(() => {});
  return id;
}

export async function getDocument(
  id: string,
  sessionId: string | null,
): Promise<StoredDocument | null> {
  if (!sessionId) return null;
  const row = await db.aegisDocument.findFirst({
    where: { id, sessionId, expiresAt: { gt: new Date() } },
  });
  if (!row) return null;
  return {
    id: row.id,
    filename: row.filename,
    type: row.type as StoredDocument['type'],
    textContent: row.textContent,
    excelData: (row.excelData ?? undefined) as ExcelData | undefined,
    excelBuffer: row.excelBuffer ? Buffer.from(row.excelBuffer) : undefined,
    uploadedAt: row.createdAt.getTime(),
  };
}

export async function deleteDocument(
  id: string,
  sessionId: string | null,
): Promise<boolean> {
  if (!sessionId) return false;
  const res = await db.aegisDocument.deleteMany({ where: { id, sessionId } });
  return res.count > 0;
}
