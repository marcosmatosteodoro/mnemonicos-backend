-- CreateEnum
CREATE TYPE "ProductionStageType" AS ENUM ('CONTEUDO_BRUTO', 'QUEBRA_DA_REGRA');

-- CreateEnum
CREATE TYPE "ProductionEventTransition" AS ENUM ('ABERTURA', 'CONCLUSAO', 'RETRABALHO');

-- CreateTable
CREATE TABLE "production_stage_events" (
    "id" TEXT NOT NULL,
    "rawContentId" TEXT NOT NULL,
    "stageType" "ProductionStageType" NOT NULL,
    "transitionType" "ProductionEventTransition" NOT NULL,
    "actorId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sequence" BIGSERIAL NOT NULL,

    CONSTRAINT "production_stage_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "production_stage_events_rawContentId_sequence_idx" ON "production_stage_events"("rawContentId", "sequence");

-- AddForeignKey
ALTER TABLE "production_stage_events" ADD CONSTRAINT "production_stage_events_rawContentId_fkey" FOREIGN KEY ("rawContentId") REFERENCES "raw_contents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_stage_events" ADD CONSTRAINT "production_stage_events_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
