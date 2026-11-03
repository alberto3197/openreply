/**
 * Next-reel binding — a campaign waits for the first post published after it
 * was switched on, never one published while it was paused.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, getUserMedia } = vi.hoisted(() => ({
  mockPrisma: {
    automation: { findMany: vi.fn(), update: vi.fn() },
  },
  getUserMedia: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/instagram/provider", () => ({
  createInstagramContext: async () => ({ provider: "META", accessToken: "t" }),
  hasInstagramCredentials: () => true,
  getUserMedia,
}));

import { attachPendingNextReels } from "../lib/automation/attach-next-reel";

const account = { id: "ig_1", provider: "META", accessToken: "enc" };

function pending(overrides: Record<string, unknown> = {}) {
  return {
    id: "automation_1",
    instagramAccountId: "ig_1",
    instagramAccount: account,
    isActive: true,
    pendingNextReel: true,
    createdAt: new Date("2026-11-01T00:00:00.000Z"),
    nextReelArmedAt: new Date("2026-11-05T00:00:00.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.automation.update.mockResolvedValue({});
  // Newest first, as the Graph API returns them.
  getUserMedia.mockResolvedValue([
    { id: "after", timestamp: "2026-11-06T00:00:00+0000", permalink: "https://ig/after" },
    { id: "while_paused", timestamp: "2026-11-03T00:00:00+0000", permalink: "https://ig/paused" },
  ]);
});

describe("attachPendingNextReels", () => {
  it("only looks at active pending campaigns", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);

    await attachPendingNextReels();

    expect(mockPrisma.automation.findMany).toHaveBeenCalledWith({
      where: { pendingNextReel: true, isActive: true },
      include: { instagramAccount: true },
    });
  });

  it("skips a post published before the campaign was activated", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([pending()]);

    const result = await attachPendingNextReels();

    expect(result).toEqual({ checked: 1, bound: 1, failedAccounts: 0 });
    expect(mockPrisma.automation.update).toHaveBeenCalledWith({
      where: { id: "automation_1" },
      data: {
        postId: "after",
        postIds: ["after"],
        postUrl: "https://ig/after",
        pendingNextReel: false,
        nextReelArmedAt: null,
      },
    });
  });

  it("stays pending while nothing was published since activation", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      pending({ nextReelArmedAt: new Date("2026-11-07T00:00:00.000Z") }),
    ]);

    const result = await attachPendingNextReels();

    expect(result.bound).toBe(0);
    expect(mockPrisma.automation.update).not.toHaveBeenCalled();
  });

  it("falls back to the creation time for a campaign never armed", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      pending({ nextReelArmedAt: null }),
    ]);

    await attachPendingNextReels();

    expect(mockPrisma.automation.update.mock.calls[0][0].data.postId).toBe(
      "while_paused"
    );
  });
});
