-- AlterEnum
ALTER TYPE "ProductionStageType" ADD VALUE 'TIRA_MNEMONICA';

-- CreateTable
CREATE TABLE "mnemonic_strips" (
    "id" TEXT NOT NULL,
    "ruleBreakdownId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mnemonic_strips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mnemonic_frames" (
    "id" TEXT NOT NULL,
    "stripId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "originBlock" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mnemonic_frames_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mnemonic_strips_ruleBreakdownId_key" ON "mnemonic_strips"("ruleBreakdownId");

-- CreateIndex
CREATE UNIQUE INDEX "mnemonic_frames_stripId_position_key" ON "mnemonic_frames"("stripId", "position");

-- AddForeignKey
ALTER TABLE "mnemonic_strips" ADD CONSTRAINT "mnemonic_strips_ruleBreakdownId_fkey" FOREIGN KEY ("ruleBreakdownId") REFERENCES "rule_breakdowns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mnemonic_frames" ADD CONSTRAINT "mnemonic_frames_stripId_fkey" FOREIGN KEY ("stripId") REFERENCES "mnemonic_strips"("id") ON DELETE CASCADE ON UPDATE CASCADE;
