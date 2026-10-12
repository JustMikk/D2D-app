-- Imports keep the parsed rows between preview and commit, count rows blocked by the do-not-knock list,
-- and record when the commit finished.
ALTER TABLE "ImportBatch" ADD COLUMN "doNotKnock" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ImportBatch" ADD COLUMN "payload" TEXT;
ALTER TABLE "ImportBatch" ADD COLUMN "committedAt" DATETIME;
