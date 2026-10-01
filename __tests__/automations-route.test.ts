import { beforeEach, describe, expect, it, vi } from "vitest";

// Characterization tests for the campaign create (POST) and edit (PATCH)
// endpoints. They pin the exact status codes, response bodies and Prisma
// writes the live campaign builder relies on.

const { mockPrisma, mockWorkspaceContext } = vi.hoisted(() => ({
  mockPrisma: {
    workspace: {
      findUnique: vi.fn(),
    },
    instagramAccount: {
      findFirst: vi.fn(),
    },
    automation: {
      create: vi.fn(),
      update: vi.fn(),
      findFirst: vi.fn(),
    },
    trackedLink: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
  mockWorkspaceContext: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  prisma: mockPrisma,
}));

// The real modules pull in next-auth; only the session lookup matters here.
vi.mock("@/lib/auth", () => ({
  getCurrentWorkspaceId: vi.fn(),
}));

vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: mockWorkspaceContext,
  canManageWorkspace: (role: string) => role === "OWNER" || role === "ADMIN",
}));

// Deterministic slugs so the exact Prisma payloads can be asserted.
vi.mock("@/lib/tracking/server", () => ({
  generateTrackedLinkSlug: vi.fn(),
}));

vi.mock("@/lib/reports/share", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/reports/share")>()),
  generateReportShareSlug: () => "report_slug",
}));

import { NextRequest } from "next/server";
import { generateTrackedLinkSlug } from "@/lib/tracking/server";
import { PATCH, POST } from "../app/api/automations/route";

const BASE_URL = "https://openreply.test/api/automations";

function request(method: "POST" | "PATCH", body: unknown, query = "") {
  return new NextRequest(`${BASE_URL}${query}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function signIn(role: "OWNER" | "ADMIN" | "MEMBER" = "OWNER") {
  mockWorkspaceContext.mockResolvedValue({
    userId: "user_1",
    workspaceId: "workspace_1",
    role,
  });
}

// The smallest payload the create schema accepts.
const minimalCreate = {
  name: "Link drop",
  postId: "post_1",
  keywords: ["LINK"],
  dmMessage: "Here you go {link}",
};

// Every field the create handler writes, with the schema defaults applied.
const minimalCreateData = {
  name: "Link drop",
  goal: undefined,
  postId: "post_1",
  postUrl: undefined,
  pendingNextReel: false,
  matchAnyPost: false,
  keywords: ["LINK"],
  matchAnyWord: false,
  dmTriggerEnabled: false,
  dmMessage: "Here you go {link}",
  openingDmEnabled: false,
  openingDmMessage: null,
  openingDmButtonLabel: null,
  linkButtonLabel: null,
  requireFollow: false,
  followPromptMessage: null,
  followPromptButtonLabel: null,
  followUpEnabled: false,
  followUpMessage: null,
  followUpDelayMinutes: 0,
  publicReplyEnabled: false,
  publicReplyMessages: [],
  publicReplyMessage: null,
  isActive: true,
  wholeWordMatch: true,
  workspaceId: "workspace_1",
  instagramAccountId: "ig_1",
  reportShareSlug: "report_slug",
};

function invalidInput(fieldErrors: Record<string, string[]>) {
  return {
    success: false,
    error: "Invalid input",
    details: { formErrors: [], fieldErrors },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  let slugCount = 0;
  vi.mocked(generateTrackedLinkSlug).mockImplementation(
    () => `slug_${++slugCount}`
  );
});

describe("POST /api/automations", () => {
  beforeEach(() => {
    mockPrisma.workspace.findUnique.mockResolvedValue({ id: "workspace_1" });
    mockPrisma.instagramAccount.findFirst.mockResolvedValue({ id: "ig_1" });
    mockPrisma.automation.create.mockImplementation(async ({ data }) => ({
      id: "automation_1",
      ...data,
      trackedLinks: [],
    }));
  });

  it("answers 401 without a session", async () => {
    mockWorkspaceContext.mockResolvedValue(null);

    const response = await POST(request("POST", minimalCreate));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      success: false,
      error: "Unauthorized",
    });
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
  });

  it("answers 403 to members who cannot manage the workspace", async () => {
    signIn("MEMBER");

    const response = await POST(request("POST", minimalCreate));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      success: false,
      error: "Only owners and admins can create campaigns",
    });
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
  });

  it("lets admins create campaigns", async () => {
    signIn("ADMIN");

    const response = await POST(request("POST", minimalCreate));

    expect(response.status).toBe(201);
  });

  it("rejects missing required fields", async () => {
    signIn();

    const response = await POST(
      request("POST", { postId: "post_1", keywords: ["LINK"] })
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe("Invalid input");
    expect(Object.keys(body.details.fieldErrors).sort()).toEqual([
      "dmMessage",
      "name",
    ]);
    expect(mockPrisma.workspace.findUnique).not.toHaveBeenCalled();
  });

  it("requires a post, any post, or the next reel", async () => {
    signIn();

    const response = await POST(
      request("POST", { ...minimalCreate, postId: undefined })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(
      invalidInput({ postId: ["Choose which post(s) trigger the campaign"] })
    );
  });

  it("requires keywords unless any word matches", async () => {
    signIn();

    const response = await POST(
      request("POST", { ...minimalCreate, keywords: [] })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(
      invalidInput({ keywords: ["Add at least one keyword, or match any word"] })
    );
  });

  it("requires a message and a button label for the opening DM", async () => {
    signIn();

    const response = await POST(
      request("POST", {
        ...minimalCreate,
        openingDmEnabled: true,
        openingDmMessage: "Tap below",
        openingDmButtonLabel: "  ",
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(
      invalidInput({
        openingDmMessage: ["Opening DM needs a message and a button label"],
      })
    );
  });

  it("reports every failing rule at once", async () => {
    signIn();

    const response = await POST(
      request("POST", {
        name: "Link drop",
        dmMessage: "Hi",
        openingDmEnabled: true,
      })
    );

    expect(await response.json()).toEqual(
      invalidInput({
        postId: ["Choose which post(s) trigger the campaign"],
        keywords: ["Add at least one keyword, or match any word"],
        openingDmMessage: ["Opening DM needs a message and a button label"],
      })
    );
  });

  it("rejects a tracked link that is not a URL", async () => {
    signIn();

    const response = await POST(
      request("POST", { ...minimalCreate, trackedDestinationUrl: "nope" })
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(Object.keys(body.details.fieldErrors)).toEqual([
      "trackedDestinationUrl",
    ]);
  });

  it("answers 404 when the workspace no longer exists", async () => {
    signIn();
    mockPrisma.workspace.findUnique.mockResolvedValue(null);

    const response = await POST(request("POST", minimalCreate));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      success: false,
      error: "Workspace not found",
    });
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
  });

  it("asks to connect Instagram when the account is missing", async () => {
    signIn();
    mockPrisma.instagramAccount.findFirst.mockResolvedValue(null);

    const response = await POST(
      request("POST", { ...minimalCreate, instagramAccountId: "ig_other" })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      error: "Connect Instagram before creating campaigns",
    });
    expect(mockPrisma.instagramAccount.findFirst).toHaveBeenCalledWith({
      where: { id: "ig_other", workspaceId: "workspace_1" },
    });
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
  });

  it("falls back to the latest connected account", async () => {
    signIn();

    for (const instagramAccountId of [undefined, null, "all"]) {
      mockPrisma.instagramAccount.findFirst.mockClear();
      await POST(request("POST", { ...minimalCreate, instagramAccountId }));
      expect(mockPrisma.instagramAccount.findFirst).toHaveBeenCalledWith({
        where: { workspaceId: "workspace_1" },
        orderBy: { connectedAt: "desc" },
      });
    }
    expect(mockPrisma.workspace.findUnique).toHaveBeenCalledWith({
      where: { id: "workspace_1" },
      select: { id: true },
    });
  });

  it("creates a minimal campaign with the schema defaults", async () => {
    signIn();

    const response = await POST(request("POST", minimalCreate));

    expect(response.status).toBe(201);
    expect(mockPrisma.automation.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.automation.create).toHaveBeenCalledWith({
      data: minimalCreateData,
      include: { trackedLinks: true },
    });
    expect(await response.json()).toEqual({
      success: true,
      data: {
        id: "automation_1",
        ...JSON.parse(JSON.stringify(minimalCreateData)),
        trackedLinks: [],
      },
    });
  });

  it("creates both tracked links in position order", async () => {
    signIn();

    await POST(
      request("POST", {
        ...minimalCreate,
        trackedDestinationUrl: "https://example.com/a",
        secondaryDestinationUrl: "https://example.com/b",
        secondaryButtonLabel: "  Read guide  ",
      })
    );

    expect(mockPrisma.automation.create.mock.calls[0][0].data.trackedLinks).toEqual({
      create: [
        {
          workspaceId: "workspace_1",
          slug: "slug_1",
          label: "Primary campaign link",
          destinationUrl: "https://example.com/a",
          position: 0,
        },
        {
          workspaceId: "workspace_1",
          slug: "slug_2",
          label: "Read guide",
          destinationUrl: "https://example.com/b",
          position: 1,
        },
      ],
    });
  });

  it("labels the second link 'Open link' when no label is given", async () => {
    signIn();

    await POST(
      request("POST", {
        ...minimalCreate,
        secondaryDestinationUrl: "https://example.com/b",
        secondaryButtonLabel: "   ",
      })
    );

    expect(mockPrisma.automation.create.mock.calls[0][0].data.trackedLinks).toEqual({
      create: [
        {
          workspaceId: "workspace_1",
          slug: "slug_1",
          label: "Open link",
          destinationUrl: "https://example.com/b",
          position: 1,
        },
      ],
    });
  });

  it("skips tracked links for empty destination URLs", async () => {
    signIn();

    await POST(
      request("POST", {
        ...minimalCreate,
        trackedDestinationUrl: "",
        secondaryDestinationUrl: null,
      })
    );

    expect(mockPrisma.automation.create.mock.calls[0][0].data).not.toHaveProperty(
      "trackedLinks"
    );
    expect(generateTrackedLinkSlug).not.toHaveBeenCalled();
  });

  it("stores every option when all of them are enabled", async () => {
    signIn();

    await POST(
      request("POST", {
        name: "Everything",
        goal: "Sell",
        instagramAccountId: "ig_1",
        postId: "post_1",
        postUrl: "https://instagram.com/p/abc",
        keywords: ["LINK"],
        dmTriggerEnabled: true,
        dmMessage: "Link: {link}",
        openingDmEnabled: true,
        openingDmMessage: "Tap below",
        openingDmButtonLabel: "Send it",
        linkButtonLabel: "Get it",
        requireFollow: true,
        followPromptMessage: "Follow first",
        followPromptButtonLabel: "Following",
        followUpEnabled: true,
        followUpMessage: "Thanks!",
        followUpDelayMinutes: 30,
        publicReplyEnabled: true,
        publicReplyMessages: [" Sent! ", "", "Check DMs"],
        isActive: false,
        wholeWordMatch: false,
      })
    );

    const { data } = mockPrisma.automation.create.mock.calls[0][0];
    expect(data).toEqual({
      ...minimalCreateData,
      name: "Everything",
      goal: "Sell",
      postUrl: "https://instagram.com/p/abc",
      dmTriggerEnabled: true,
      dmMessage: "Link: {link}",
      openingDmEnabled: true,
      openingDmMessage: "Tap below",
      openingDmButtonLabel: "Send it",
      linkButtonLabel: "Get it",
      requireFollow: true,
      followPromptMessage: "Follow first",
      followPromptButtonLabel: "Following",
      followUpEnabled: true,
      followUpMessage: "Thanks!",
      followUpDelayMinutes: 30,
      publicReplyEnabled: true,
      publicReplyMessages: ["Sent!", "Check DMs"],
      publicReplyMessage: "Sent!",
      isActive: false,
      wholeWordMatch: false,
    });
  });

  it("drops dependent fields of disabled options and broad triggers", async () => {
    signIn();

    await POST(
      request("POST", {
        name: "Broad",
        postId: "post_1",
        postUrl: "https://instagram.com/p/abc",
        matchAnyPost: true,
        matchAnyWord: true,
        keywords: ["IGNORED"],
        dmMessage: "Hi",
        openingDmMessage: "Ignored",
        openingDmButtonLabel: "Ignored",
        followPromptMessage: "Ignored",
        followPromptButtonLabel: "Ignored",
        followUpMessage: "Ignored",
        followUpDelayMinutes: 45,
        publicReplyMessages: ["Ignored"],
      })
    );

    const { data } = mockPrisma.automation.create.mock.calls[0][0];
    expect(data).toMatchObject({
      postId: null,
      postUrl: null,
      matchAnyPost: true,
      matchAnyWord: true,
      keywords: [],
      openingDmMessage: null,
      openingDmButtonLabel: null,
      followPromptMessage: null,
      followPromptButtonLabel: null,
      followUpMessage: null,
      followUpDelayMinutes: 0,
      publicReplyMessages: [],
      publicReplyMessage: null,
    });
  });

  it("stores no post for a next-reel campaign", async () => {
    signIn();

    await POST(
      request("POST", {
        ...minimalCreate,
        pendingNextReel: true,
        postUrl: "https://instagram.com/p/abc",
      })
    );

    expect(mockPrisma.automation.create.mock.calls[0][0].data).toMatchObject({
      postId: null,
      postUrl: null,
      pendingNextReel: true,
    });
  });

  it("falls back to the legacy single public reply", async () => {
    signIn();

    await POST(
      request("POST", {
        ...minimalCreate,
        publicReplyEnabled: true,
        publicReplyMessage: "  Sent!  ",
      })
    );

    expect(mockPrisma.automation.create.mock.calls[0][0].data).toMatchObject({
      publicReplyMessages: ["Sent!"],
      publicReplyMessage: "Sent!",
    });
  });
});

describe("PATCH /api/automations", () => {
  const existing = { id: "automation_1", workspaceId: "workspace_1" };
  const updated = { id: "automation_1", name: "Updated" };

  beforeEach(() => {
    mockPrisma.automation.findFirst.mockResolvedValue(existing);
    mockPrisma.automation.update.mockResolvedValue(updated);
    mockPrisma.trackedLink.findFirst.mockResolvedValue(null);
  });

  function patch(body: unknown, id: string | null = "automation_1") {
    return PATCH(request("PATCH", body, id === null ? "" : `?id=${id}`));
  }

  it("answers 401 without a session", async () => {
    mockWorkspaceContext.mockResolvedValue(null);

    const response = await patch({ isActive: false });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      success: false,
      error: "Unauthorized",
    });
  });

  it("answers 403 to members who cannot manage the workspace", async () => {
    signIn("MEMBER");

    const response = await patch({ isActive: false });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      success: false,
      error: "Only owners and admins can update campaigns",
    });
    expect(mockPrisma.automation.update).not.toHaveBeenCalled();
  });

  it("requires the campaign ID", async () => {
    signIn();

    const response = await patch({ isActive: false }, null);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      error: "Missing campaign ID",
    });
    expect(mockPrisma.automation.findFirst).not.toHaveBeenCalled();
  });

  it("rejects invalid fields", async () => {
    signIn();

    const response = await patch({
      name: "",
      trackedDestinationUrl: "not a url",
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe("Invalid input");
    expect(body.details.formErrors).toEqual([]);
    expect(Object.keys(body.details.fieldErrors).sort()).toEqual([
      "name",
      "trackedDestinationUrl",
    ]);
    expect(mockPrisma.automation.findFirst).not.toHaveBeenCalled();
  });

  it("answers 404 for a campaign outside the workspace", async () => {
    signIn();
    mockPrisma.automation.findFirst.mockResolvedValue(null);

    const response = await patch({ isActive: false }, "automation_other");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      success: false,
      error: "Campaign not found",
    });
    expect(mockPrisma.automation.findFirst).toHaveBeenCalledWith({
      where: { id: "automation_other", workspaceId: "workspace_1" },
    });
    expect(mockPrisma.automation.update).not.toHaveBeenCalled();
  });

  it("toggles isActive alone without touching tracked links", async () => {
    signIn();

    const response = await patch({ isActive: false });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: updated });
    expect(mockPrisma.automation.update).toHaveBeenCalledWith({
      where: { id: "automation_1" },
      data: { isActive: false },
    });
    expect(mockPrisma.trackedLink.findFirst).not.toHaveBeenCalled();
  });

  it("ignores fields the update schema does not know", async () => {
    signIn();

    await patch({ name: "Renamed", instagramAccountId: "ig_2", id: "x" });

    expect(mockPrisma.automation.update).toHaveBeenCalledWith({
      where: { id: "automation_1" },
      data: { name: "Renamed" },
    });
  });

  it("clears dependent fields of disabled options and broad triggers", async () => {
    signIn();

    await patch({
      matchAnyWord: true,
      keywords: ["IGNORED"],
      openingDmEnabled: false,
      openingDmMessage: "Ignored",
      requireFollow: false,
      followUpEnabled: false,
      followUpDelayMinutes: 30,
      matchAnyPost: true,
      postId: "post_1",
      publicReplyEnabled: false,
      publicReplyMessages: ["Ignored"],
      reportShareEnabled: true,
    });

    expect(mockPrisma.automation.update).toHaveBeenCalledWith({
      where: { id: "automation_1" },
      data: {
        matchAnyWord: true,
        keywords: [],
        openingDmEnabled: false,
        openingDmMessage: null,
        openingDmButtonLabel: null,
        requireFollow: false,
        followPromptMessage: null,
        followPromptButtonLabel: null,
        followUpEnabled: false,
        followUpMessage: null,
        followUpDelayMinutes: 0,
        matchAnyPost: true,
        postId: null,
        postUrl: null,
        publicReplyEnabled: false,
        publicReplyMessages: [],
        publicReplyMessage: null,
        reportShareEnabled: true,
      },
    });
  });

  it("clears the post for next-reel campaigns", async () => {
    signIn();

    await patch({ pendingNextReel: true });

    expect(mockPrisma.automation.update.mock.calls[0][0].data).toEqual({
      pendingNextReel: true,
      postId: null,
      postUrl: null,
    });
  });

  it("syncs the legacy public reply with the variations list", async () => {
    signIn();

    await patch({ publicReplyMessages: [" Sent! ", "", "Check DMs"] });
    await patch({ publicReplyMessages: ["  "] });

    expect(mockPrisma.automation.update.mock.calls[0][0].data).toEqual({
      publicReplyMessages: ["Sent!", "Check DMs"],
      publicReplyMessage: "Sent!",
    });
    expect(mockPrisma.automation.update.mock.calls[1][0].data).toEqual({
      publicReplyMessages: [],
      publicReplyMessage: null,
    });
  });

  it("keeps link fields out of the campaign update", async () => {
    signIn();

    await patch({
      name: "Renamed",
      trackedDestinationUrl: "https://example.com/a",
      secondaryDestinationUrl: "https://example.com/b",
      secondaryButtonLabel: "Guide",
    });

    expect(mockPrisma.automation.update.mock.calls[0][0].data).toEqual({
      name: "Renamed",
    });
  });

  describe.each([
    {
      field: "trackedDestinationUrl",
      position: 0,
      createdLabel: "Primary campaign link",
    },
    {
      field: "secondaryDestinationUrl",
      position: 1,
      createdLabel: "Open link",
    },
  ])("$field (position $position)", ({ field, position, createdLabel }) => {
    const storedLink = {
      id: `link_${position}`,
      automationId: "automation_1",
      position,
      destinationUrl: "https://example.com/old",
    };

    it.each([undefined, null])("leaves the link alone for %s", async (value) => {
      signIn();

      await patch({ name: "Renamed", [field]: value });

      expect(mockPrisma.trackedLink.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.trackedLink.create).not.toHaveBeenCalled();
      expect(mockPrisma.trackedLink.update).not.toHaveBeenCalled();
      expect(mockPrisma.trackedLink.delete).not.toHaveBeenCalled();
    });

    it("deletes the existing link for an empty string", async () => {
      signIn();
      mockPrisma.trackedLink.findFirst.mockResolvedValue(storedLink);

      await patch({ [field]: "" });

      expect(mockPrisma.trackedLink.findFirst).toHaveBeenCalledWith({
        where: { automationId: "automation_1", position },
      });
      expect(mockPrisma.trackedLink.delete).toHaveBeenCalledWith({
        where: { id: storedLink.id },
      });
      expect(mockPrisma.trackedLink.create).not.toHaveBeenCalled();
      expect(mockPrisma.trackedLink.update).not.toHaveBeenCalled();
    });

    it("does nothing for an empty string when there is no link", async () => {
      signIn();

      await patch({ [field]: "" });

      expect(mockPrisma.trackedLink.findFirst).toHaveBeenCalledTimes(1);
      expect(mockPrisma.trackedLink.delete).not.toHaveBeenCalled();
      expect(mockPrisma.trackedLink.create).not.toHaveBeenCalled();
    });

    it("updates the existing link", async () => {
      signIn();
      mockPrisma.trackedLink.findFirst.mockResolvedValue(storedLink);

      await patch({ [field]: "https://example.com/new" });

      expect(mockPrisma.trackedLink.update).toHaveBeenCalledWith({
        where: { id: storedLink.id },
        data:
          position === 0
            ? { destinationUrl: "https://example.com/new" }
            : { destinationUrl: "https://example.com/new", label: "Open link" },
      });
      expect(mockPrisma.trackedLink.create).not.toHaveBeenCalled();
    });

    it("creates the link when it is missing", async () => {
      signIn();

      await patch({ [field]: "https://example.com/new" });

      expect(mockPrisma.trackedLink.create).toHaveBeenCalledWith({
        data: {
          workspaceId: "workspace_1",
          automationId: "automation_1",
          slug: "slug_1",
          label: createdLabel,
          destinationUrl: "https://example.com/new",
          position,
        },
      });
      expect(mockPrisma.trackedLink.update).not.toHaveBeenCalled();
    });
  });

  it("uses the trimmed secondary button label", async () => {
    signIn();
    mockPrisma.trackedLink.findFirst.mockResolvedValue({ id: "link_1" });

    await patch({
      secondaryDestinationUrl: "https://example.com/b",
      secondaryButtonLabel: "  Read guide ",
    });

    expect(mockPrisma.trackedLink.update).toHaveBeenCalledWith({
      where: { id: "link_1" },
      data: { destinationUrl: "https://example.com/b", label: "Read guide" },
    });
  });

  it("ignores a secondary label sent without a destination URL", async () => {
    signIn();

    await patch({ secondaryButtonLabel: "Read guide" });

    expect(mockPrisma.trackedLink.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.automation.update.mock.calls[0][0].data).toEqual({});
  });

  it("writes the campaign first, then the primary and the second link", async () => {
    signIn();

    await patch({
      name: "Renamed",
      trackedDestinationUrl: "https://example.com/a",
      secondaryDestinationUrl: "https://example.com/b",
    });

    const order = (fn: { mock: { invocationCallOrder: number[] } }) =>
      fn.mock.invocationCallOrder;
    const [findCampaign] = order(mockPrisma.automation.findFirst);
    const [updateCampaign] = order(mockPrisma.automation.update);
    const [findPrimary, findSecondary] = order(mockPrisma.trackedLink.findFirst);
    const [createPrimary, createSecondary] = order(mockPrisma.trackedLink.create);

    expect(findCampaign).toBeLessThan(updateCampaign);
    expect(updateCampaign).toBeLessThan(findPrimary);
    expect(findPrimary).toBeLessThan(createPrimary);
    expect(createPrimary).toBeLessThan(findSecondary);
    expect(findSecondary).toBeLessThan(createSecondary);
    expect(mockPrisma.trackedLink.create.mock.calls.map(([arg]) => arg.data.position)).toEqual([0, 1]);
  });
});
