-- Freeze the selected runtime provider on each sectioned job.
--
-- Forward-only, data-safe. The column is added NULLABLE so the ALTER cannot fail
-- on a table with existing rows and no default is silently applied. The backfill
-- then sets every existing job to the only provider the pre-provider runtime
-- could have used: Anthropic. Justification — the sectioned pipeline is
-- flag-gated (AEGIS_SECTIONED_ENABLED=0 by default) and, before provider
-- selection existed, the runtime dispatched Anthropic only (non-Anthropic was
-- D4-gated), so any AegisJob on disk executed through Anthropic. New jobs always
-- set the provider explicitly in application code; a NULL on resume fails closed.
ALTER TABLE "AegisJob" ADD COLUMN "provider" TEXT;

UPDATE "AegisJob" SET "provider" = 'anthropic-api' WHERE "provider" IS NULL;
