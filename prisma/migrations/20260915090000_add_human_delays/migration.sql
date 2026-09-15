-- AlterTable
ALTER TABLE "InstagramAccount" ADD COLUMN     "publicReplyDelaySeconds" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "dmDelaySeconds" INTEGER NOT NULL DEFAULT 0;
