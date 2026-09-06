-- CreateIndex
CREATE INDEX "raw_contents_authorId_createdAt_idx" ON "raw_contents"("authorId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "raw_contents_createdAt_idx" ON "raw_contents"("createdAt" DESC);
