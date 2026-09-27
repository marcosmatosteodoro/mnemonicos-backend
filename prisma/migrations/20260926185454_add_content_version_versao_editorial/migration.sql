-- AlterEnum
ALTER TYPE "ProductionStageType" ADD VALUE 'VERSAO_EDITORIAL';

-- CreateTable
CREATE TABLE "content_versions" (
    "id" TEXT NOT NULL,
    "rawContentId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "legislativeClosureDate" TIMESTAMP(3) NOT NULL,
    "authorId" TEXT NOT NULL,
    "closedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "contentSnapshot" JSONB NOT NULL,

    CONSTRAINT "content_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "content_versions_rawContentId_number_key" ON "content_versions"("rawContentId", "number");

-- AddForeignKey
ALTER TABLE "content_versions" ADD CONSTRAINT "content_versions_rawContentId_fkey" FOREIGN KEY ("rawContentId") REFERENCES "raw_contents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_versions" ADD CONSTRAINT "content_versions_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
