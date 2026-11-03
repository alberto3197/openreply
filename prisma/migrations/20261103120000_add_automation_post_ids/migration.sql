-- AlterTable
ALTER TABLE "Automation" ADD COLUMN     "postIds" TEXT[] NOT NULL DEFAULT '{}';

-- Backfill: every existing specific-post campaign listens on its one post.
UPDATE "Automation"
SET "postIds" = ARRAY["postId"]
WHERE "postId" IS NOT NULL;

-- CreateIndex
CREATE INDEX "Automation_postIds_idx" ON "Automation" USING GIN ("postIds");
