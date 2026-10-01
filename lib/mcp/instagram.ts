import { prisma } from "@/lib/db/client";
import { createInstagramContext, getUserMedia } from "@/lib/instagram/provider";

// Read-only Instagram lookups behind the MCP tools, so a client can pick the
// account and post a new campaign should target. Like lib/mcp/campaigns.ts,
// every query is scoped to the token's workspace and never returns credentials.

const CAPTION_EXCERPT_LENGTH = 200;

export async function listInstagramAccounts(workspaceId: string) {
  return prisma.instagramAccount.findMany({
    where: { workspaceId },
    orderBy: { connectedAt: "desc" },
    select: { id: true, username: true, provider: true },
  });
}

/**
 * Recent posts of one connected account, through the same provider call the
 * dashboard's post picker uses. Returns null when the account is not part of
 * the workspace.
 */
export async function listRecentPosts(
  workspaceId: string,
  instagramAccountId: string,
  limit: number
) {
  const account = await prisma.instagramAccount.findFirst({
    where: { id: instagramAccountId, workspaceId },
  });
  if (!account) return null;

  const context = await createInstagramContext(account);
  const media = await getUserMedia({ context, limit });

  return media.map((post) => ({
    id: post.id,
    permalink: post.permalink ?? null,
    caption:
      post.caption && post.caption.length > CAPTION_EXCERPT_LENGTH
        ? `${post.caption.slice(0, CAPTION_EXCERPT_LENGTH)}…`
        : post.caption ?? null,
    mediaType: post.media_type,
    mediaProductType: post.media_product_type ?? null,
    timestamp: post.timestamp,
  }));
}
