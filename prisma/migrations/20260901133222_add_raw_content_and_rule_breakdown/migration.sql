-- CreateEnum
CREATE TYPE "ProofRadarClass" AS ENUM ('ALTA', 'MEDIA', 'DETALHE', 'EXCECAO', 'PEGADINHA');

-- CreateEnum
CREATE TYPE "NormativeSourceType" AS ENUM ('CF', 'CTN', 'LEI', 'LEI_COMPLEMENTAR', 'SUMULA', 'ATO_NORMATIVO');

-- CreateTable
CREATE TABLE "raw_contents" (
    "id" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "rawText" TEXT NOT NULL,
    "radarClass" "ProofRadarClass" NOT NULL,
    "sourceType" "NormativeSourceType",
    "sourceCitation" TEXT,
    "sourceUrl" TEXT,
    "lastEditedById" TEXT,
    "lastEditedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "raw_contents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_breakdowns" (
    "id" TEXT NOT NULL,
    "rawContentId" TEXT NOT NULL,
    "concept" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "object" TEXT NOT NULL,
    "condition" TEXT,
    "exception" TEXT,
    "essence" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rule_breakdowns_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "raw_contents_authorId_idx" ON "raw_contents"("authorId");

-- CreateIndex
CREATE INDEX "raw_contents_topicId_idx" ON "raw_contents"("topicId");

-- CreateIndex
CREATE INDEX "raw_contents_deletedAt_idx" ON "raw_contents"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "rule_breakdowns_rawContentId_key" ON "rule_breakdowns"("rawContentId");

-- AddForeignKey
ALTER TABLE "raw_contents" ADD CONSTRAINT "raw_contents_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "topics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_contents" ADD CONSTRAINT "raw_contents_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_contents" ADD CONSTRAINT "raw_contents_lastEditedById_fkey" FOREIGN KEY ("lastEditedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_breakdowns" ADD CONSTRAINT "rule_breakdowns_rawContentId_fkey" FOREIGN KEY ("rawContentId") REFERENCES "raw_contents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
