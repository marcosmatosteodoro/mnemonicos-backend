-- AlterEnum
ALTER TYPE "ProductionStageType" ADD VALUE 'APROVACAO_VERSAO';

-- AlterTable
ALTER TABLE "content_versions" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedById" TEXT;

-- AddForeignKey
ALTER TABLE "content_versions" ADD CONSTRAINT "content_versions_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
