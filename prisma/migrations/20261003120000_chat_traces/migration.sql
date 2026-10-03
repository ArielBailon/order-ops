-- CreateEnum
CREATE TYPE "TraceStatus" AS ENUM ('ok', 'error', 'aborted');

-- CreateTable
CREATE TABLE "ChatTrace" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "route" TEXT,
    "tools" TEXT[],
    "status" "TraceStatus" NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatTrace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LlmCall" (
    "id" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "cacheReadTokens" INTEGER NOT NULL,
    "cacheWriteTokens" INTEGER NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "costUsd" DECIMAL(12,6),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LlmCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChatTrace_createdAt_idx" ON "ChatTrace"("createdAt");

-- CreateIndex
CREATE INDEX "ChatTrace_threadId_idx" ON "ChatTrace"("threadId");

-- CreateIndex
CREATE INDEX "LlmCall_traceId_idx" ON "LlmCall"("traceId");

-- AddForeignKey
ALTER TABLE "LlmCall" ADD CONSTRAINT "LlmCall_traceId_fkey" FOREIGN KEY ("traceId") REFERENCES "ChatTrace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
