-- AlterTable
ALTER TABLE "User" ADD COLUMN "aegisProvider" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AegisUsageLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "traceId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "servedModel" TEXT,
    "language" TEXT NOT NULL DEFAULT 'de',
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "cachedTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheCreationTokens" INTEGER NOT NULL DEFAULT 0,
    "provider" TEXT NOT NULL DEFAULT 'anthropic',
    "priceStatus" TEXT NOT NULL DEFAULT 'priced',
    "costCents" REAL,
    "pricingVersion" TEXT NOT NULL DEFAULT 'legacy',
    "exitReason" TEXT NOT NULL DEFAULT 'unknown',
    "latencyMs" INTEGER NOT NULL,
    "iterations" INTEGER NOT NULL DEFAULT 1,
    "toolCalls" INTEGER NOT NULL DEFAULT 0,
    "verifyPassed" BOOLEAN NOT NULL,
    "citationCount" INTEGER NOT NULL DEFAULT 0,
    "guardrailsTriggered" TEXT NOT NULL DEFAULT '[]',
    "kbVersion" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_AegisUsageLog" ("cacheCreationTokens", "cachedTokens", "citationCount", "conversationId", "costCents", "createdAt", "exitReason", "guardrailsTriggered", "id", "inputTokens", "iterations", "kbVersion", "language", "latencyMs", "mode", "model", "outputTokens", "pricingVersion", "servedModel", "toolCalls", "traceId", "verifyPassed") SELECT "cacheCreationTokens", "cachedTokens", "citationCount", "conversationId", "costCents", "createdAt", "exitReason", "guardrailsTriggered", "id", "inputTokens", "iterations", "kbVersion", "language", "latencyMs", "mode", "model", "outputTokens", "pricingVersion", "servedModel", "toolCalls", "traceId", "verifyPassed" FROM "AegisUsageLog";
DROP TABLE "AegisUsageLog";
ALTER TABLE "new_AegisUsageLog" RENAME TO "AegisUsageLog";
CREATE INDEX "AegisUsageLog_createdAt_idx" ON "AegisUsageLog"("createdAt");
CREATE INDEX "AegisUsageLog_mode_idx" ON "AegisUsageLog"("mode");
CREATE INDEX "AegisUsageLog_model_idx" ON "AegisUsageLog"("model");
CREATE INDEX "AegisUsageLog_conversationId_idx" ON "AegisUsageLog"("conversationId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

