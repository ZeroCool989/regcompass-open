-- CreateTable
CREATE TABLE "UserAiCredential" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "encryptedApiKey" TEXT NOT NULL,
    "keyFingerprint" TEXT NOT NULL,
    "preferredModel" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastValidatedAt" DATETIME,
    "lastValidationError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UserAiCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UserClaudeOAuth" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "encryptedAccessToken" TEXT NOT NULL,
    "encryptedRefreshToken" TEXT,
    "tokenType" TEXT NOT NULL DEFAULT 'Bearer',
    "scope" TEXT,
    "expiresAt" DATETIME,
    "connectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastRefreshAt" DATETIME,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UserClaudeOAuth_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "username" TEXT,
    "passwordHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "role" TEXT NOT NULL DEFAULT 'USER',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" DATETIME,
    "emailVerifiedAt" DATETIME,
    "voiceId" TEXT,
    "voicePrefs" JSONB,
    "preferredAiProvider" TEXT
);

-- CreateTable
CREATE TABLE "SoulEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "signalCount" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "lastConfirmedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SoulEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SoulProposal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "evidence" JSONB,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" DATETIME,
    CONSTRAINT "SoulProposal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SoulAudit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SoulAudit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AegisDocument" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "textContent" TEXT NOT NULL,
    "excelData" JSONB,
    "excelBuffer" BLOB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "originalLanguage" TEXT,
    "isTranslation" BOOLEAN NOT NULL DEFAULT false,
    "translatedFromId" TEXT,
    "targetLanguage" TEXT,
    "qualityWarnings" JSONB
);

-- CreateTable
CREATE TABLE "AegisConversation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT,
    "mode" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'de',
    "title" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastTurnAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "digest" JSONB,
    "digestThroughSeq" INTEGER,
    "digestAt" DATETIME
);

-- CreateTable
CREATE TABLE "AegisMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "citedIds" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'complete',
    "exitReason" TEXT,
    "model" TEXT,
    "mode" TEXT,
    "toolCalls" JSONB,
    "traceId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AegisMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AegisConversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AegisUsageLog" (
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
    "costCents" REAL NOT NULL,
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

-- CreateTable
CREATE TABLE "AegisJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "planJson" JSONB NOT NULL,
    "vocabJson" JSONB NOT NULL,
    "cursor" INTEGER NOT NULL DEFAULT 0,
    "resumeCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "expiresAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AegisJobSection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "scopeJson" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "contentMd" TEXT,
    "digestJson" JSONB,
    "citationsJson" JSONB,
    "verifyJson" JSONB,
    "firstPassOk" BOOLEAN,
    CONSTRAINT "AegisJobSection_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "AegisJob" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RegulatorySource" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "jurisdiction" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "RegulatoryNewsItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "relevance" TEXT NOT NULL,
    "sourceName" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "publishedAt" DATETIME,
    "jurisdiction" TEXT NOT NULL,
    "tags" TEXT NOT NULL DEFAULT '[]',
    "dedupeKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "RegulatoryKbSuggestion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceName" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "regulation" TEXT NOT NULL,
    "proposedRequirementId" TEXT,
    "proposedRequirementText" TEXT NOT NULL,
    "relevanceForFinancialSector" TEXT NOT NULL,
    "bindingLevel" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "dedupeKey" TEXT NOT NULL,
    "reviewedBy" TEXT,
    "reviewedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "RegulatoryRunLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "newsFound" INTEGER NOT NULL DEFAULT 0,
    "suggestionsCreated" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'OK',
    "error" TEXT
);

-- CreateTable
CREATE TABLE "RegulatoryDocument" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "suggestionId" TEXT,
    "sourceName" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "documentUrl" TEXT,
    "regulation" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "jurisdiction" TEXT NOT NULL,
    "contentType" TEXT,
    "rawText" TEXT,
    "markdown" TEXT,
    "byteSize" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'INGESTING',
    "error" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "fetchedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "originalLanguage" TEXT,
    "isTranslation" BOOLEAN NOT NULL DEFAULT false,
    "originalDocumentId" TEXT,
    "targetLanguage" TEXT,
    "translationProvider" TEXT,
    "translatedAt" DATETIME,
    "translatedBy" TEXT,
    "translationStatus" TEXT,
    "qualityWarnings" JSONB
);

-- CreateIndex
CREATE INDEX "UserAiCredential_userId_enabled_idx" ON "UserAiCredential"("userId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "UserAiCredential_userId_provider_key" ON "UserAiCredential"("userId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "UserClaudeOAuth_userId_key" ON "UserClaudeOAuth"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE INDEX "User_status_idx" ON "User"("status");

-- CreateIndex
CREATE INDEX "SoulEntry_userId_section_idx" ON "SoulEntry"("userId", "section");

-- CreateIndex
CREATE INDEX "SoulEntry_userId_status_idx" ON "SoulEntry"("userId", "status");

-- CreateIndex
CREATE INDEX "SoulProposal_userId_status_idx" ON "SoulProposal"("userId", "status");

-- CreateIndex
CREATE INDEX "SoulAudit_userId_createdAt_idx" ON "SoulAudit"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AegisDocument_sessionId_idx" ON "AegisDocument"("sessionId");

-- CreateIndex
CREATE INDEX "AegisDocument_expiresAt_idx" ON "AegisDocument"("expiresAt");

-- CreateIndex
CREATE INDEX "AegisConversation_sessionId_lastTurnAt_idx" ON "AegisConversation"("sessionId", "lastTurnAt");

-- CreateIndex
CREATE INDEX "AegisConversation_userId_lastTurnAt_idx" ON "AegisConversation"("userId", "lastTurnAt");

-- CreateIndex
CREATE INDEX "AegisConversation_expiresAt_idx" ON "AegisConversation"("expiresAt");

-- CreateIndex
CREATE INDEX "AegisMessage_conversationId_seq_idx" ON "AegisMessage"("conversationId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "AegisMessage_conversationId_seq_key" ON "AegisMessage"("conversationId", "seq");

-- CreateIndex
CREATE INDEX "AegisUsageLog_createdAt_idx" ON "AegisUsageLog"("createdAt");

-- CreateIndex
CREATE INDEX "AegisUsageLog_mode_idx" ON "AegisUsageLog"("mode");

-- CreateIndex
CREATE INDEX "AegisUsageLog_model_idx" ON "AegisUsageLog"("model");

-- CreateIndex
CREATE INDEX "AegisUsageLog_conversationId_idx" ON "AegisUsageLog"("conversationId");

-- CreateIndex
CREATE INDEX "AegisJob_conversationId_idx" ON "AegisJob"("conversationId");

-- CreateIndex
CREATE INDEX "AegisJob_expiresAt_idx" ON "AegisJob"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AegisJobSection_jobId_index_key" ON "AegisJobSection"("jobId", "index");

-- CreateIndex
CREATE UNIQUE INDEX "RegulatorySource_name_key" ON "RegulatorySource"("name");

-- CreateIndex
CREATE UNIQUE INDEX "RegulatoryNewsItem_dedupeKey_key" ON "RegulatoryNewsItem"("dedupeKey");

-- CreateIndex
CREATE INDEX "RegulatoryNewsItem_jurisdiction_idx" ON "RegulatoryNewsItem"("jurisdiction");

-- CreateIndex
CREATE INDEX "RegulatoryNewsItem_createdAt_idx" ON "RegulatoryNewsItem"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RegulatoryKbSuggestion_dedupeKey_key" ON "RegulatoryKbSuggestion"("dedupeKey");

-- CreateIndex
CREATE INDEX "RegulatoryKbSuggestion_status_idx" ON "RegulatoryKbSuggestion"("status");

-- CreateIndex
CREATE INDEX "RegulatoryKbSuggestion_createdAt_idx" ON "RegulatoryKbSuggestion"("createdAt");

-- CreateIndex
CREATE INDEX "RegulatoryRunLog_startedAt_idx" ON "RegulatoryRunLog"("startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RegulatoryDocument_dedupeKey_key" ON "RegulatoryDocument"("dedupeKey");

-- CreateIndex
CREATE INDEX "RegulatoryDocument_status_idx" ON "RegulatoryDocument"("status");

-- CreateIndex
CREATE INDEX "RegulatoryDocument_regulation_idx" ON "RegulatoryDocument"("regulation");

-- CreateIndex
CREATE INDEX "RegulatoryDocument_isTranslation_idx" ON "RegulatoryDocument"("isTranslation");

-- CreateIndex
CREATE UNIQUE INDEX "RegulatoryDocument_originalDocumentId_targetLanguage_key" ON "RegulatoryDocument"("originalDocumentId", "targetLanguage");

