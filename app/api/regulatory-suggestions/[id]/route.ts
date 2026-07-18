import { NextResponse, after, type NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { getUserFromCookies, requireAdmin } from '@/lib/auth';
import { createIngestionJob, inferJurisdiction, runIngestion } from '@/lib/regulatory/ingest';

/**
 * Admin-only: accept or reject a KB-update suggestion.
 *
 * IMPORTANT: accepting NEVER writes to the production knowledge base. It only
 * flips the suggestion's status to ACCEPTED and records the reviewer — the
 * suggestion row IS the structured, human-approved draft (regulation, proposed
 * requirement id/text, relevance, binding level). Promoting it into
 * lib/kb/requirements.json remains a deliberate, separate human step.
 *
 * On ACCEPT we ALSO kick off best-effort document ingestion (fetch + convert
 * the source document into a runtime RegulatoryDocument) so the regulation
 * appears in the Bibliothek and becomes searchable by AEGIS — still only as an
 * UNVERIFIED raw source. Ingestion runs AFTER the response via `after()` so the
 * Accept click stays instant; its status (INGESTING → INGESTED/FAILED) is
 * polled by the UI and retryable.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUserFromCookies();
  if (!requireAdmin(user)) {
    return NextResponse.json({ error: 'forbidden', message: 'Nur für Admins.' }, { status: 403 });
  }

  const { id } = await params;
  let body: { action?: string };
  try {
    body = (await req.json()) as { action?: string };
  } catch {
    return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
  }

  const status = body.action === 'accept' ? 'ACCEPTED' : body.action === 'reject' ? 'REJECTED' : null;
  if (!status) {
    return NextResponse.json({ error: 'invalid_input', message: "action muss 'accept' oder 'reject' sein." }, { status: 400 });
  }

  try {
    const updated = await db.regulatoryKbSuggestion.update({
      where: { id },
      data: { status, reviewedAt: new Date(), reviewedBy: user.email },
    });

    let documentId: string | null = null;
    if (status === 'ACCEPTED') {
      // Create the INGESTING row now (fast), run the fetch/convert after the
      // response. Ingestion never throws into the request — failures are
      // persisted onto the row and surfaced as retryable in the UI.
      try {
        documentId = await createIngestionJob({
          suggestionId: updated.id,
          sourceName: updated.sourceName,
          sourceUrl: updated.sourceUrl,
          regulation: updated.regulation,
          title: `${updated.regulation} — ${updated.sourceName}`,
          jurisdiction: inferJurisdiction(updated.sourceUrl),
        });
        const docId = documentId;
        after(async () => {
          try {
            await runIngestion(docId);
          } catch (err) {
            console.error(
              JSON.stringify({
                event: 'regulatory_ingest_failed',
                documentId: docId,
                detail: err instanceof Error ? err.message : String(err),
              }),
            );
          }
        });
      } catch (err) {
        // Creating the ingestion job must not fail the Accept itself.
        console.error(
          JSON.stringify({
            event: 'regulatory_ingest_job_failed',
            suggestionId: updated.id,
            detail: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }

    return NextResponse.json({ item: updated, documentId });
  } catch {
    return NextResponse.json({ error: 'not_found', message: 'Vorschlag nicht gefunden.' }, { status: 404 });
  }
}
