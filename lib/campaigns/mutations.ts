import { prisma } from "@/lib/db/client";
import { generateTrackedLinkSlug } from "@/lib/tracking/server";
import { generateReportShareSlug } from "@/lib/reports/share";
import {
  createCampaignSchema,
  updateCampaignSchema,
} from "@/lib/campaigns/schemas";

// Campaign create/edit business logic, shared by the dashboard API and the MCP
// write tools. Callers authenticate and authorize first; these functions only
// validate the input and write within the given workspace. Failures come back
// as values carrying the HTTP status the dashboard API answers with.

export type CampaignInputErrors = {
  formErrors: string[];
  fieldErrors: Record<string, string[] | undefined>;
};

export type CampaignMutationError = {
  ok: false;
  status: 400 | 404;
  error: string;
  details?: CampaignInputErrors;
};

export async function createCampaign({
  workspaceId,
  input,
}: {
  workspaceId: string;
  input: unknown;
}) {
  const parsed = createCampaignSchema.safeParse(input);

  if (!parsed.success) {
    return {
      ok: false,
      status: 400,
      error: "Invalid input",
      details: parsed.error.flatten(),
    } satisfies CampaignMutationError;
  }

  const requestedInstagramAccountId =
    parsed.data.instagramAccountId && parsed.data.instagramAccountId !== "all"
      ? parsed.data.instagramAccountId
      : null;

  const [workspace, instagramAccount] = await Promise.all([
    prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true },
    }),
    requestedInstagramAccountId
      ? prisma.instagramAccount.findFirst({
          where: { id: requestedInstagramAccountId, workspaceId },
        })
      : prisma.instagramAccount.findFirst({
          where: { workspaceId },
          orderBy: { connectedAt: "desc" },
        }),
  ]);

  if (!workspace) {
    return {
      ok: false,
      status: 404,
      error: "Workspace not found",
    } satisfies CampaignMutationError;
  }

  if (!instagramAccount) {
    return {
      ok: false,
      status: 400,
      error: "Connect Instagram before creating campaigns",
    } satisfies CampaignMutationError;
  }

  const { trackedDestinationUrl, secondaryDestinationUrl, secondaryButtonLabel } =
    parsed.data;

  // The primary link's button title comes from `linkButtonLabel`; the second
  // link stores its own button title in the tracked link's `label` field.
  const linkCreates: {
    workspaceId: string;
    slug: string;
    label: string;
    destinationUrl: string;
    position: number;
  }[] = [];
  if (trackedDestinationUrl) {
    linkCreates.push({
      workspaceId,
      slug: generateTrackedLinkSlug(),
      label: "Primary campaign link",
      destinationUrl: trackedDestinationUrl,
      position: 0,
    });
  }
  if (secondaryDestinationUrl) {
    linkCreates.push({
      workspaceId,
      slug: generateTrackedLinkSlug(),
      label: secondaryButtonLabel?.trim() || "Open link",
      destinationUrl: secondaryDestinationUrl,
      position: 1,
    });
  }

  const { pendingNextReel, matchAnyPost, matchAnyWord, openingDmEnabled } =
    parsed.data;
  // A post is only stored for the "specific post" trigger.
  const isSpecificPost = !pendingNextReel && !matchAnyPost;
  const publicReplyList = (
    parsed.data.publicReplyMessages.length > 0
      ? parsed.data.publicReplyMessages
      : parsed.data.publicReplyMessage
        ? [parsed.data.publicReplyMessage]
        : []
  )
    .map((m) => m.trim())
    .filter(Boolean);

  const automation = await prisma.automation.create({
    data: {
      name: parsed.data.name,
      goal: parsed.data.goal,
      // A next-reel campaign has no post yet; the cron binds it once a reel is posted.
      postId: isSpecificPost ? parsed.data.postId : null,
      postUrl: isSpecificPost ? parsed.data.postUrl : null,
      pendingNextReel,
      matchAnyPost,
      keywords: matchAnyWord ? [] : parsed.data.keywords,
      matchAnyWord,
      dmTriggerEnabled: parsed.data.dmTriggerEnabled,
      dmMessage: parsed.data.dmMessage,
      openingDmEnabled,
      openingDmMessage: openingDmEnabled
        ? parsed.data.openingDmMessage || null
        : null,
      openingDmButtonLabel: openingDmEnabled
        ? parsed.data.openingDmButtonLabel || null
        : null,
      linkButtonLabel: parsed.data.linkButtonLabel || null,
      requireFollow: parsed.data.requireFollow,
      followPromptMessage: parsed.data.requireFollow
        ? parsed.data.followPromptMessage || null
        : null,
      followPromptButtonLabel: parsed.data.requireFollow
        ? parsed.data.followPromptButtonLabel || null
        : null,
      followUpEnabled: parsed.data.followUpEnabled,
      followUpMessage: parsed.data.followUpEnabled
        ? parsed.data.followUpMessage || null
        : null,
      followUpDelayMinutes: parsed.data.followUpEnabled
        ? parsed.data.followUpDelayMinutes
        : 0,
      publicReplyEnabled: parsed.data.publicReplyEnabled,
      publicReplyMessages: parsed.data.publicReplyEnabled
        ? publicReplyList
        : [],
      publicReplyMessage: parsed.data.publicReplyEnabled
        ? publicReplyList[0] ?? parsed.data.publicReplyMessage ?? null
        : null,
      isActive: parsed.data.isActive,
      wholeWordMatch: parsed.data.wholeWordMatch,
      workspaceId,
      instagramAccountId: instagramAccount.id,
      reportShareSlug: generateReportShareSlug(),
      ...(linkCreates.length > 0
        ? { trackedLinks: { create: linkCreates } }
        : {}),
    },
    include: {
      trackedLinks: true,
    },
  });

  return { ok: true, data: automation } as const;
}

export async function updateCampaign({
  workspaceId,
  campaignId: automationId,
  input,
}: {
  workspaceId: string;
  campaignId: string;
  input: unknown;
}) {
  const parsed = updateCampaignSchema.safeParse(input);

  if (!parsed.success) {
    return {
      ok: false,
      status: 400,
      error: "Invalid input",
      details: parsed.error.flatten(),
    } satisfies CampaignMutationError;
  }

  const existing = await prisma.automation.findFirst({
    where: { id: automationId, workspaceId },
  });

  if (!existing) {
    return {
      ok: false,
      status: 404,
      error: "Campaign not found",
    } satisfies CampaignMutationError;
  }

  const {
    trackedDestinationUrl,
    secondaryDestinationUrl,
    secondaryButtonLabel,
    ...automationData
  } = parsed.data;

  // Keep dependent fields consistent: any-word clears keywords; a disabled
  // opening DM clears its message and button.
  if (automationData.matchAnyWord === true) automationData.keywords = [];
  if (automationData.openingDmEnabled === false) {
    automationData.openingDmMessage = null;
    automationData.openingDmButtonLabel = null;
  }
  if (automationData.requireFollow === false) {
    automationData.followPromptMessage = null;
    automationData.followPromptButtonLabel = null;
  }
  if (automationData.followUpEnabled === false) {
    automationData.followUpMessage = null;
    automationData.followUpDelayMinutes = 0;
  }
  // Any-post / next-reel campaigns carry no specific post.
  if (automationData.matchAnyPost === true || automationData.pendingNextReel === true) {
    automationData.postId = null;
    automationData.postUrl = null;
  }
  // Keep the public-reply variations list and the legacy single field in sync.
  if (automationData.publicReplyMessages !== undefined) {
    const list = automationData.publicReplyMessages
      .map((m) => m.trim())
      .filter(Boolean);
    automationData.publicReplyMessages = list;
    automationData.publicReplyMessage = list[0] ?? null;
  }
  if (automationData.publicReplyEnabled === false) {
    automationData.publicReplyMessages = [];
    automationData.publicReplyMessage = null;
  }

  const updated = await prisma.automation.update({
    where: { id: automationId },
    data: automationData,
  });

  // Update, create, or clear the campaign's primary tracked link when a
  // destination URL was supplied. `undefined` means "leave it alone".
  if (trackedDestinationUrl !== undefined && trackedDestinationUrl !== null) {
    const primaryLink = await prisma.trackedLink.findFirst({
      where: { automationId, position: 0 },
    });

    if (trackedDestinationUrl === "") {
      if (primaryLink) {
        await prisma.trackedLink.delete({ where: { id: primaryLink.id } });
      }
    } else if (primaryLink) {
      await prisma.trackedLink.update({
        where: { id: primaryLink.id },
        data: { destinationUrl: trackedDestinationUrl },
      });
    } else {
      await prisma.trackedLink.create({
        data: {
          workspaceId,
          automationId,
          slug: generateTrackedLinkSlug(),
          label: "Primary campaign link",
          destinationUrl: trackedDestinationUrl,
          position: 0,
        },
      });
    }
  }

  // Update, create, or clear the campaign's second tracked link. It is always
  // the link at position 1, and its `label` holds the second button's title.
  if (secondaryDestinationUrl !== undefined && secondaryDestinationUrl !== null) {
    const secondaryLink = await prisma.trackedLink.findFirst({
      where: { automationId, position: 1 },
    });
    const secondaryLabel = secondaryButtonLabel?.trim() || "Open link";

    if (secondaryDestinationUrl === "") {
      if (secondaryLink) {
        await prisma.trackedLink.delete({ where: { id: secondaryLink.id } });
      }
    } else if (secondaryLink) {
      await prisma.trackedLink.update({
        where: { id: secondaryLink.id },
        data: { destinationUrl: secondaryDestinationUrl, label: secondaryLabel },
      });
    } else {
      await prisma.trackedLink.create({
        data: {
          workspaceId,
          automationId,
          slug: generateTrackedLinkSlug(),
          label: secondaryLabel,
          destinationUrl: secondaryDestinationUrl,
          position: 1,
        },
      });
    }
  }

  return { ok: true, data: updated } as const;
}
