-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('STUDENT', 'EDITOR', 'ADMIN');

-- CreateEnum
CREATE TYPE "MnemonicTechnique" AS ENUM ('ACRONYM', 'ACROSTIC', 'STORY', 'MEMORY_PALACE', 'KEYWORD', 'RHYME', 'NUMBER_PEG');

-- CreateEnum
CREATE TYPE "ReviewRating" AS ENUM ('AGAIN', 'HARD', 'GOOD', 'EASY');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'STUDENT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disciplines" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "disciplines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "topics" (
    "id" TEXT NOT NULL,
    "disciplineId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "topics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mnemonics" (
    "id" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "technique" "MnemonicTechnique" NOT NULL,
    "hook" TEXT NOT NULL,
    "decoding" TEXT NOT NULL,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mnemonics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "flashcards" (
    "id" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "mnemonicId" TEXT,
    "front" TEXT NOT NULL,
    "back" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "flashcards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "card_states" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "flashcardId" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "intervalDays" INTEGER NOT NULL DEFAULT 0,
    "easeFactor" DOUBLE PRECISION NOT NULL DEFAULT 2.5,
    "repetitions" INTEGER NOT NULL DEFAULT 0,
    "lapses" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "card_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "flashcardId" TEXT NOT NULL,
    "rating" "ReviewRating" NOT NULL,
    "elapsedMs" INTEGER,
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "disciplines_slug_key" ON "disciplines"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "topics_disciplineId_slug_key" ON "topics"("disciplineId", "slug");

-- CreateIndex
CREATE INDEX "mnemonics_topicId_technique_idx" ON "mnemonics"("topicId", "technique");

-- CreateIndex
CREATE INDEX "flashcards_topicId_idx" ON "flashcards"("topicId");

-- CreateIndex
CREATE INDEX "card_states_userId_dueAt_idx" ON "card_states"("userId", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "card_states_userId_flashcardId_key" ON "card_states"("userId", "flashcardId");

-- CreateIndex
CREATE INDEX "reviews_userId_reviewedAt_idx" ON "reviews"("userId", "reviewedAt");

-- CreateIndex
CREATE INDEX "reviews_flashcardId_idx" ON "reviews"("flashcardId");

-- AddForeignKey
ALTER TABLE "topics" ADD CONSTRAINT "topics_disciplineId_fkey" FOREIGN KEY ("disciplineId") REFERENCES "disciplines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mnemonics" ADD CONSTRAINT "mnemonics_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "topics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flashcards" ADD CONSTRAINT "flashcards_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "topics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flashcards" ADD CONSTRAINT "flashcards_mnemonicId_fkey" FOREIGN KEY ("mnemonicId") REFERENCES "mnemonics"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_states" ADD CONSTRAINT "card_states_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_states" ADD CONSTRAINT "card_states_flashcardId_fkey" FOREIGN KEY ("flashcardId") REFERENCES "flashcards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_flashcardId_fkey" FOREIGN KEY ("flashcardId") REFERENCES "flashcards"("id") ON DELETE CASCADE ON UPDATE CASCADE;
