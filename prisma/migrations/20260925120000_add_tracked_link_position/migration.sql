-- AlterTable
ALTER TABLE "TrackedLink" ADD COLUMN     "position" INTEGER NOT NULL DEFAULT 0;

-- Backfill: links created together share a `createdAt`, so the timestamp alone
-- cannot tell which one is primary. The primary link always carries the
-- "Primary campaign link" label, so it goes first; the rest keep creation order.
UPDATE "TrackedLink" AS t
SET "position" = ranked.rn - 1
FROM (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "automationId"
      ORDER BY
        COALESCE("label" = 'Primary campaign link', false) DESC,
        "createdAt" ASC,
        "id" ASC
    ) AS rn
  FROM "TrackedLink"
) AS ranked
WHERE t."id" = ranked."id";

-- CreateIndex
CREATE UNIQUE INDEX "TrackedLink_automationId_position_key" ON "TrackedLink"("automationId", "position");
