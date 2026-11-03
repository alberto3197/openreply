import { prisma } from "@/lib/db/client";
import {
  buildInitialCampaignLinks,
  syncCampaignLinks,
} from "@/lib/campaigns/links";
import { generateReportShareSlug } from "@/lib/reports/share";
import { resolvePostTargets } from "@/lib/campaigns/post-targets";
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

/**
 * The next-reel reference an update should store, or undefined to leave it as
 * it is. Only a change in the campaign's armed state writes it.
 */
function nextReelArmedAt({
  existing,
  isActive,
  pendingNextReel,
}: {
  existing: {
    isActive?: boolean;
    pendingNextReel?: boolean;
    nextReelArmedAt?: Date | null;
  };
  isActive?: boolean;
  pendingNextReel?: boolean;
}): Date | null | undefined {
  const armed =
    (isActive ?? existing.isActive ?? false) &&
    (pendingNextReel ?? existing.pendingNextReel ?? false);
  const wasArmed = Boolean(existing.nextReelArmedAt);
  if (armed && !wasArmed) return new Date();
  if (!armed && wasArmed) return null;
  return undefined;
}

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

  const linkCreates = buildInitialCampaignLinks({
    workspaceId,
    primaryUrl: parsed.data.trackedDestinationUrl,
    secondaryUrl: parsed.data.secondaryDestinationUrl,
    secondaryLabel: parsed.data.secondaryButtonLabel,
  });

  const { pendingNextReel, matchAnyPost, matchAnyWord, openingDmEnabled } =
    parsed.data;
  // A post is only stored for the "specific post" trigger.
  const isSpecificPost = !pendingNextReel && !matchAnyPost;
  const postTargets = isSpecificPost
    ? resolvePostTargets(parsed.data)
    : resolvePostTargets({});
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
      postId: postTargets.postId,
      postIds: postTargets.postIds,
      postUrl: isSpecificPost ? parsed.data.postUrl : null,
      pendingNextReel,
      // A paused next-reel campaign is armed only once it is activated.
      nextReelArmedAt: pendingNextReel && parsed.data.isActive ? new Date() : null,
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

  // Moving a campaign to another account: it must be one of this workspace's.
  if (
    automationData.instagramAccountId !== undefined &&
    automationData.instagramAccountId !== existing.instagramAccountId
  ) {
    const account = await prisma.instagramAccount.findFirst({
      where: { id: automationData.instagramAccountId, workspaceId },
      select: { id: true },
    });
    if (!account) {
      return {
        ok: false,
        status: 404,
        error: "Instagram account not found",
      } satisfies CampaignMutationError;
    }
  }

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
  // Keep the post list and its primary in sync whenever either one is sent.
  if (automationData.postId !== undefined || automationData.postIds !== undefined) {
    Object.assign(automationData, resolvePostTargets(automationData));
  }
  // Any-post / next-reel campaigns carry no specific post.
  if (automationData.matchAnyPost === true || automationData.pendingNextReel === true) {
    automationData.postId = null;
    automationData.postIds = [];
    automationData.postUrl = null;
  }
  // A next-reel campaign waits for the first post published after it was
  // switched on, so the reference is set when it becomes active (or becomes a
  // next-reel campaign while active) and dropped while it is paused. Saving an
  // already armed campaign keeps its reference.
  const armedAt = nextReelArmedAt({
    existing,
    isActive: automationData.isActive,
    pendingNextReel: automationData.pendingNextReel,
  });
  if (armedAt !== undefined) {
    Object.assign(automationData, { nextReelArmedAt: armedAt });
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

  // One transaction, so a save never lands half applied. Updating the campaign
  // first locks its row, which makes a second save of the same campaign wait
  // for this one before it reads the links.
  const updated = await prisma.$transaction(async (tx) => {
    const campaign = await tx.automation.update({
      where: { id: automationId },
      data: automationData,
    });

    await syncCampaignLinks(tx, {
      workspaceId,
      automationId,
      primaryUrl: trackedDestinationUrl,
      secondaryUrl: secondaryDestinationUrl,
      secondaryLabel: secondaryButtonLabel,
    });

    return campaign;
  });

  return { ok: true, data: updated } as const;
}
