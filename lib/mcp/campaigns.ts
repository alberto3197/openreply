import { prisma } from "@/lib/db/client";
import {
  calculateCtr,
  normalizeTopKeywords,
  summarizeDmStatuses,
} from "@/lib/tracking/analytics";
import { buildTrackedUrl } from "@/lib/tracking/message";

// Read-only campaign queries behind the MCP tools. Every query is scoped to the
// token's workspace, and every select is explicit so secrets on related rows
// (Instagram access tokens, Zernio keys) can never leak into tool output.

export type CampaignListFilter = {
  instagramAccountId?: string;
  isActive?: boolean;
};

export async function listCampaigns(
  workspaceId: string,
  filter: CampaignListFilter = {}
) {
  const campaigns = await prisma.automation.findMany({
    where: {
      workspaceId,
      ...(filter.instagramAccountId
        ? { instagramAccountId: filter.instagramAccountId }
        : {}),
      ...(filter.isActive !== undefined ? { isActive: filter.isActive } : {}),
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      goal: true,
      isActive: true,
      createdAt: true,
      postId: true,
      postUrl: true,
      matchAnyPost: true,
      pendingNextReel: true,
      keywords: true,
      matchAnyWord: true,
      dmTriggerEnabled: true,
      instagramAccount: { select: { id: true, username: true } },
    },
  });

  return campaigns.map((campaign) => ({
    id: campaign.id,
    name: campaign.name,
    goal: campaign.goal,
    isActive: campaign.isActive,
    instagramAccount: campaign.instagramAccount,
    trigger: {
      postId: campaign.postId,
      postUrl: campaign.postUrl,
      matchAnyPost: campaign.matchAnyPost,
      pendingNextReel: campaign.pendingNextReel,
      keywords: campaign.keywords,
      matchAnyWord: campaign.matchAnyWord,
      dmTriggerEnabled: campaign.dmTriggerEnabled,
    },
    createdAt: campaign.createdAt,
  }));
}

export async function getCampaign(workspaceId: string, id: string) {
  const campaign = await prisma.automation.findFirst({
    where: { id, workspaceId },
    select: {
      id: true,
      name: true,
      goal: true,
      isActive: true,
      postId: true,
      postUrl: true,
      pendingNextReel: true,
      matchAnyPost: true,
      keywords: true,
      matchAnyWord: true,
      wholeWordMatch: true,
      dmTriggerEnabled: true,
      dmMessage: true,
      openingDmEnabled: true,
      openingDmMessage: true,
      openingDmButtonLabel: true,
      linkButtonLabel: true,
      requireFollow: true,
      followPromptMessage: true,
      followPromptButtonLabel: true,
      followUpEnabled: true,
      followUpMessage: true,
      followUpDelayMinutes: true,
      publicReplyEnabled: true,
      publicReplyMessage: true,
      publicReplyMessages: true,
      createdAt: true,
      updatedAt: true,
      instagramAccount: { select: { id: true, username: true } },
      trackedLinks: {
        orderBy: { position: "asc" },
        select: {
          label: true,
          destinationUrl: true,
          slug: true,
          position: true,
        },
      },
    },
  });
  if (!campaign) return null;

  return {
    ...campaign,
    trackedLinks: campaign.trackedLinks.map(({ slug, ...link }) => ({
      ...link,
      trackedUrl: buildTrackedUrl(slug),
    })),
  };
}

export async function getCampaignStats(workspaceId: string, id: string) {
  const campaign = await prisma.automation.findFirst({
    where: { id, workspaceId },
    select: { id: true, name: true },
  });
  if (!campaign) return null;

  // Same aggregation as the campaign list in the dashboard, narrowed to one
  // campaign. workspaceId stays in every where clause as defence in depth.
  const where = { workspaceId, automationId: campaign.id };
  const [statusCounts, clicks, keywordCounts] = await Promise.all([
    prisma.dmLog.groupBy({
      by: ["status"],
      where,
      _count: { _all: true },
    }),
    prisma.linkClick.count({ where }),
    prisma.dmLog.groupBy({
      by: ["matchedKeyword"],
      where: { ...where, matchedKeyword: { not: null } },
      _count: { _all: true },
    }),
  ]);

  const summary = summarizeDmStatuses(
    statusCounts.map((row) => ({
      status: row.status,
      _count: row._count._all,
    }))
  );

  return {
    campaignId: campaign.id,
    name: campaign.name,
    dms: {
      ...summary,
      byStatus: Object.fromEntries(
        statusCounts.map((row) => [row.status, row._count._all])
      ),
    },
    clicks,
    ctr: calculateCtr(clicks, summary.sent),
    topKeywords: normalizeTopKeywords(
      keywordCounts.map((row) => ({
        matchedKeyword: row.matchedKeyword,
        _count: row._count._all,
      }))
    ),
  };
}
