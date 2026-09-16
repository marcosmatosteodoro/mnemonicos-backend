-- AlterEnum
ALTER TYPE "ProductionStageType" ADD VALUE 'MATERIAL_REFORCO';

-- AlterTable
ALTER TABLE "raw_contents" ADD COLUMN     "pegadinhaText" TEXT;

-- CreateTable
CREATE TABLE "contrasts" (
    "id" TEXT NOT NULL,
    "rawContentId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "confusableText" TEXT NOT NULL,
    "distinctionText" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contrasts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_flashcards" (
    "id" TEXT NOT NULL,
    "rawContentId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "production_flashcards_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "contrasts_rawContentId_createdAt_idx" ON "contrasts"("rawContentId", "createdAt" ASC);

-- CreateIndex
CREATE INDEX "production_flashcards_rawContentId_createdAt_idx" ON "production_flashcards"("rawContentId", "createdAt" ASC);

-- AddForeignKey
ALTER TABLE "contrasts" ADD CONSTRAINT "contrasts_rawContentId_fkey" FOREIGN KEY ("rawContentId") REFERENCES "raw_contents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contrasts" ADD CONSTRAINT "contrasts_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_flashcards" ADD CONSTRAINT "production_flashcards_rawContentId_fkey" FOREIGN KEY ("rawContentId") REFERENCES "raw_contents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_flashcards" ADD CONSTRAINT "production_flashcards_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
