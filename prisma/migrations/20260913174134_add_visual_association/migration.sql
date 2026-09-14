-- AlterEnum
ALTER TYPE "ProductionStageType" ADD VALUE 'ASSOCIACAO_VISUAL';

-- AlterTable
ALTER TABLE "mnemonic_frames" ADD COLUMN     "visualAssociationId" TEXT;

-- CreateTable
CREATE TABLE "visual_associations" (
    "id" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "cognitiveDescription" TEXT NOT NULL,
    "imageData" BYTEA NOT NULL,
    "mimeType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "visual_associations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visual_association_link_events" (
    "id" TEXT NOT NULL,
    "visualAssociationId" TEXT NOT NULL,
    "wasReuse" BOOLEAN NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "visual_association_link_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "visual_association_link_events_occurredAt_idx" ON "visual_association_link_events"("occurredAt");

-- AddForeignKey
ALTER TABLE "mnemonic_frames" ADD CONSTRAINT "mnemonic_frames_visualAssociationId_fkey" FOREIGN KEY ("visualAssociationId") REFERENCES "visual_associations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visual_associations" ADD CONSTRAINT "visual_associations_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
