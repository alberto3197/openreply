// A "specific post" campaign can listen on several posts. They are stored in
// `postIds`, primary first, and `postId` always mirrors that primary post so
// the thumbnail, the report and clients that only know `postId` keep working.

// Each post is swept by the polling reconciler on every run, so the list is
// capped to keep one campaign from eating the account's API budget.
export const MAX_CAMPAIGN_POSTS = 30;

/**
 * The stored post fields for the given input. Either field may be sent alone:
 * a lone `postId` (older clients) becomes a one-post list, a lone `postIds`
 * sets the primary to its first entry. Duplicates and blanks are dropped.
 */
export function resolvePostTargets({
  postId,
  postIds,
}: {
  postId?: string | null;
  postIds?: string[] | null;
}): { postId: string | null; postIds: string[] } {
  const ids = [
    ...new Set(
      [postId, ...(postIds ?? [])]
        .map((id) => id?.trim())
        .filter((id): id is string => Boolean(id))
    ),
  ];
  return { postId: ids[0] ?? null, postIds: ids };
}

/** Every post a campaign listens on, including rows written before `postIds`. */
export function campaignPostIds(campaign: {
  postId: string | null;
  postIds?: string[] | null;
}): string[] {
  return resolvePostTargets(campaign).postIds;
}
