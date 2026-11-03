-- AlterTable
ALTER TABLE "Automation" ADD COLUMN     "nextReelArmedAt" TIMESTAMP(3);

-- Backfill: active pending campaigns keep the reference they had until now
-- (their creation time). Paused ones stay unarmed until they are activated.
UPDATE "Automation"
SET "nextReelArmedAt" = "createdAt"
WHERE "pendingNextReel" = true AND "isActive" = true;
