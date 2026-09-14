-- CreateEnum
CREATE TYPE "PublicationVariant" AS ENUM ('TIRA', 'RESUMO');

-- AlterEnum
ALTER TYPE "ProductionStageType" ADD VALUE 'PUBLICACAO_PDF';

-- CreateTable
CREATE TABLE "publication_events" (
    "id" TEXT NOT NULL,
    "rawContentId" TEXT NOT NULL,
    "variant" "PublicationVariant" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "publication_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "publication_events_occurredAt_idx" ON "publication_events"("occurredAt");
