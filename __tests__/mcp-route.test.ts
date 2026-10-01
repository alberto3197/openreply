import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockWorkspaceContext, mockInstagram } = vi.hoisted(() => ({
  mockPrisma: {
    apiToken: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    workspaceMember: {
      findUnique: vi.fn(),
    },
    workspace: {
      findUnique: vi.fn(),
    },
    instagramAccount: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    automation: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    trackedLink: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
  mockWorkspaceContext: vi.fn(),
  mockInstagram: {
    createInstagramContext: vi.fn(),
    getUserMedia: vi.fn(),
  },
}));

vi.mock("@/lib/db/client", () => ({
  prisma: mockPrisma,
}));

// The real module pulls in next-auth; only the session lookup matters here.
vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: mockWorkspaceContext,
  canManageWorkspace: (role: string) => role === "OWNER" || role === "ADMIN",
}));

// Posts come from the Instagram provider; never call the real API in tests.
vi.mock("@/lib/instagram/provider", () => mockInstagram);

// `after` needs a live request scope; run the task inline instead.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => unknown) => {
    void task();
  },
}));

import { DELETE as mcpDelete, GET as mcpGet, POST as mcpPost } from "../app/api/mcp/route";
import {
  DELETE as tokensDelete,
  GET as tokensGet,
  POST as tokensPost,
} from "../app/api/mcp/tokens/route";
import { NextRequest } from "next/server";

const MCP_URL = "https://openreply.test/api/mcp";
const TOKEN = "or_test-token";

function rpc(body: unknown, headers: Record<string, string> = {}) {
  return new Request(MCP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${TOKEN}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

// `role` is the token creator's current role, read again by every write tool.
function allowToken(role: "OWNER" | "ADMIN" | "MEMBER" = "OWNER") {
  mockPrisma.apiToken.findUnique.mockResolvedValue({
    id: "token_1",
    workspaceId: "workspace_1",
    userId: "user_1",
    revokedAt: null,
    lastUsedAt: new Date(),
  });
  mockPrisma.workspaceMember.findUnique.mockResolvedValue({ id: "m_1", role });
}

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const response = await mcpPost(
    rpc(
      {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name, arguments: args },
      },
      { "mcp-protocol-version": "2025-06-18" }
    )
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  const result = body.result as {
    isError?: boolean;
    content: { type: string; text: string }[];
  };
  return { ...result, text: result.content[0].text };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("MCP endpoint while disabled", () => {
  it("answers 404 to every method without touching the database", async () => {
    for (const handler of [mcpPost, mcpGet, mcpDelete]) {
      const response = await handler(rpc({}));
      expect(response.status).toBe(404);
    }
    expect(mockPrisma.apiToken.findUnique).not.toHaveBeenCalled();
  });
});

describe("token management while disabled", () => {
  it("answers 404 without resolving the session", async () => {
    const request = new NextRequest("https://openreply.test/api/mcp/tokens", {
      method: "POST",
      body: JSON.stringify({ name: "Claude" }),
    });

    expect((await tokensGet()).status).toBe(404);
    expect((await tokensPost(request)).status).toBe(404);
    expect((await tokensDelete(request)).status).toBe(404);
    expect(mockWorkspaceContext).not.toHaveBeenCalled();
  });
});

describe("token management while enabled", () => {
  beforeEach(() => {
    vi.stubEnv("MCP_ENABLED", "true");
  });

  it("hides tokens from members who cannot manage the workspace", async () => {
    mockWorkspaceContext.mockResolvedValue({
      userId: "user_2",
      workspaceId: "workspace_1",
      role: "MEMBER",
    });

    expect((await tokensGet()).status).toBe(403);
    expect(mockPrisma.apiToken.findMany).not.toHaveBeenCalled();
  });

  it("lists active tokens without their hash", async () => {
    mockWorkspaceContext.mockResolvedValue({
      userId: "user_1",
      workspaceId: "workspace_1",
      role: "OWNER",
    });
    mockPrisma.apiToken.findMany.mockResolvedValue([]);

    const response = await tokensGet();

    expect(response.status).toBe(200);
    const query = mockPrisma.apiToken.findMany.mock.calls[0][0];
    expect(query.where).toEqual({ workspaceId: "workspace_1", revokedAt: null });
    expect(query.select.tokenHash).toBeUndefined();
  });
});

describe("MCP endpoint while enabled", () => {
  beforeEach(() => {
    vi.stubEnv("MCP_ENABLED", "true");
  });

  it("challenges requests without a valid token", async () => {
    const response = await mcpPost(rpc({}, { authorization: "" }));

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(/^Bearer/);
  });

  it("rejects GET with 405 since the endpoint is stateless", async () => {
    allowToken();
    const response = await mcpGet(rpc({}));

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("initializes and lists the tools", async () => {
    allowToken();

    const init = await mcpPost(
      rpc({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "vitest", version: "1.0.0" },
        },
      })
    );
    expect(init.status).toBe(200);
    expect(init.headers.get("mcp-session-id")).toBeNull();
    const initBody = await init.json();
    expect(initBody.result.serverInfo.name).toBe("openreply");

    const list = await mcpPost(
      rpc(
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        { "mcp-protocol-version": "2025-06-18" }
      )
    );
    const listBody = await list.json();
    expect(
      listBody.result.tools.map((tool: { name: string }) => tool.name).sort()
    ).toEqual([
      "create_campaign",
      "get_campaign",
      "get_campaign_stats",
      "list_campaigns",
      "list_instagram_accounts",
      "list_recent_posts",
      "set_campaign_active",
      "update_campaign",
    ]);

    const writeTools = ["create_campaign", "set_campaign_active", "update_campaign"];
    for (const tool of listBody.result.tools) {
      expect(tool.name).not.toMatch(/delete|remove/i);
      expect(tool.annotations.destructiveHint).toBe(false);
      expect(tool.annotations.readOnlyHint).toBe(!writeTools.includes(tool.name));
    }

    const byName = Object.fromEntries(
      listBody.result.tools.map((tool: { name: string }) => [tool.name, tool])
    );
    expect(byName.create_campaign.inputSchema.properties).not.toHaveProperty("isActive");
    expect(byName.update_campaign.inputSchema.properties).not.toHaveProperty("isActive");
    expect(byName.update_campaign.inputSchema.additionalProperties).toBe(false);
    expect(byName.create_campaign.description).toMatch(/paused/);
    expect(byName.create_campaign.description).toMatch(/set_campaign_active/);
    expect(byName.update_campaign.description).toMatch(/only possible from the OpenReply dashboard/);
    expect(byName.set_campaign_active.description).toMatch(/real Instagram DMs/);
  });

  it("scopes tool calls to the token's workspace", async () => {
    allowToken();
    mockPrisma.automation.findFirst.mockResolvedValue(null);

    const response = await mcpPost(
      rpc(
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "get_campaign", arguments: { id: "campaign_x" } },
        },
        { "mcp-protocol-version": "2025-06-18" }
      )
    );
    const body = await response.json();

    expect(body.result.isError).toBe(true);
    expect(mockPrisma.automation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "campaign_x", workspaceId: "workspace_1" },
      })
    );
  });
});

describe("MCP helper tools", () => {
  beforeEach(() => {
    vi.stubEnv("MCP_ENABLED", "true");
  });

  it("lists Instagram accounts without credentials", async () => {
    allowToken("MEMBER");
    mockPrisma.instagramAccount.findMany.mockResolvedValue([
      { id: "ig_1", username: "shop", provider: "META" },
    ]);

    const result = await callTool("list_instagram_accounts");

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.text)).toEqual({
      instagramAccounts: [{ id: "ig_1", username: "shop", provider: "META" }],
    });
    expect(mockPrisma.instagramAccount.findMany).toHaveBeenCalledWith({
      where: { workspaceId: "workspace_1" },
      orderBy: { connectedAt: "desc" },
      select: { id: true, username: true, provider: true },
    });
  });

  it("lists recent posts of a workspace account", async () => {
    allowToken("MEMBER");
    const account = { id: "ig_1", workspaceId: "workspace_1", provider: "META" };
    mockPrisma.instagramAccount.findFirst.mockResolvedValue(account);
    mockInstagram.createInstagramContext.mockResolvedValue({ provider: "META" });
    mockInstagram.getUserMedia.mockResolvedValue([
      {
        id: "media_1",
        caption: "x".repeat(250),
        media_type: "VIDEO",
        media_product_type: "REELS",
        permalink: "https://instagram.com/reel/abc",
        timestamp: "2026-09-30T10:00:00+0000",
        media_url: "https://cdn.example.com/1.mp4",
      },
    ]);

    const result = await callTool("list_recent_posts", {
      instagramAccountId: "ig_1",
      limit: 5,
    });

    expect(mockPrisma.instagramAccount.findFirst).toHaveBeenCalledWith({
      where: { id: "ig_1", workspaceId: "workspace_1" },
    });
    expect(mockInstagram.createInstagramContext).toHaveBeenCalledWith(account);
    expect(mockInstagram.getUserMedia).toHaveBeenCalledWith({
      context: { provider: "META" },
      limit: 5,
    });
    expect(JSON.parse(result.text)).toEqual({
      posts: [
        {
          id: "media_1",
          permalink: "https://instagram.com/reel/abc",
          caption: `${"x".repeat(200)}…`,
          mediaType: "VIDEO",
          mediaProductType: "REELS",
          timestamp: "2026-09-30T10:00:00+0000",
        },
      ],
    });
  });

  it("rejects accounts outside the workspace", async () => {
    allowToken();
    mockPrisma.instagramAccount.findFirst.mockResolvedValue(null);

    const result = await callTool("list_recent_posts", {
      instagramAccountId: "ig_other",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toBe("Instagram account ig_other not found in this workspace");
    expect(mockInstagram.getUserMedia).not.toHaveBeenCalled();
  });

  it("turns provider failures into a tool error", async () => {
    allowToken();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockPrisma.instagramAccount.findFirst.mockResolvedValue({ id: "ig_1" });
    mockInstagram.createInstagramContext.mockResolvedValue({ provider: "META" });
    mockInstagram.getUserMedia.mockRejectedValue(new Error("token expired"));

    const result = await callTool("list_recent_posts", {
      instagramAccountId: "ig_1",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toBe("Failed to fetch Instagram posts");
  });
});

describe("MCP write tools", () => {
  const validCreate = {
    name: "Link drop",
    instagramAccountId: "ig_1",
    postId: "media_1",
    keywords: ["LINK"],
    dmMessage: "Here you go {link}",
    trackedDestinationUrl: "https://example.com/a",
  };

  beforeEach(() => {
    vi.stubEnv("MCP_ENABLED", "true");
    mockPrisma.workspace.findUnique.mockResolvedValue({ id: "workspace_1" });
    mockPrisma.instagramAccount.findFirst.mockResolvedValue({ id: "ig_1" });
    mockPrisma.automation.create.mockImplementation(async ({ data }) => ({
      id: "automation_new",
      ...data,
      trackedLinks: [],
    }));
    mockPrisma.automation.findFirst.mockResolvedValue({
      id: "automation_1",
      workspaceId: "workspace_1",
    });
    mockPrisma.automation.update.mockImplementation(async ({ data }) => ({
      id: "automation_1",
      name: "Link drop",
      isActive: false,
      ...data,
    }));
    mockPrisma.trackedLink.findFirst.mockResolvedValue(null);
  });

  it("creates campaigns paused even when asked to activate them", async () => {
    allowToken();

    const result = await callTool("create_campaign", {
      ...validCreate,
      isActive: true,
      workspaceId: "workspace_other",
    });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.text)).toEqual({
      id: "automation_new",
      name: "Link drop",
      isActive: false,
      dashboardPath: "/campaigns/automation_new",
    });
    const { data } = mockPrisma.automation.create.mock.calls[0][0];
    expect(data.isActive).toBe(false);
    expect(data.workspaceId).toBe("workspace_1");
    expect(data.trackedLinks.create).toEqual([
      expect.objectContaining({
        workspaceId: "workspace_1",
        destinationUrl: "https://example.com/a",
        position: 0,
      }),
    ]);
    expect(mockPrisma.instagramAccount.findFirst).toHaveBeenCalledWith({
      where: { id: "ig_1", workspaceId: "workspace_1" },
    });
  });

  it("returns the create rules as a readable tool error", async () => {
    allowToken();

    const result = await callTool("create_campaign", {
      ...validCreate,
      postId: undefined,
      keywords: [],
    });

    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      "Invalid input: postId: Choose which post(s) trigger the campaign; keywords: Add at least one keyword, or match any word"
    );
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
  });

  it("reports a workspace without Instagram as a tool error", async () => {
    allowToken();
    mockPrisma.instagramAccount.findFirst.mockResolvedValue(null);

    const result = await callTool("create_campaign", validCreate);

    expect(result.isError).toBe(true);
    expect(result.text).toBe("Connect Instagram before creating campaigns");
  });

  it.each(["trackedDestinationUrl", "secondaryDestinationUrl"])(
    "refuses to clear %s through update",
    async (field) => {
      allowToken();

      const result = await callTool("update_campaign", {
        id: "automation_1",
        [field]: "",
      });

      expect(result.isError).toBe(true);
      expect(result.text).toMatch(field);
      expect(mockPrisma.automation.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.automation.update).not.toHaveBeenCalled();
      expect(mockPrisma.trackedLink.delete).not.toHaveBeenCalled();
    }
  );

  it("refuses isActive in update", async () => {
    allowToken();

    const result = await callTool("update_campaign", {
      id: "automation_1",
      name: "Renamed",
      isActive: true,
    });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/isActive/);
    expect(mockPrisma.automation.update).not.toHaveBeenCalled();
  });

  it("updates fields and changes tracked links", async () => {
    allowToken("ADMIN");
    mockPrisma.trackedLink.findFirst.mockImplementation(async ({ where }) =>
      where.position === 0 ? { id: "link_0" } : null
    );

    const result = await callTool("update_campaign", {
      id: "automation_1",
      name: "Renamed",
      trackedDestinationUrl: "https://example.com/new",
      secondaryDestinationUrl: "https://example.com/second",
      secondaryButtonLabel: "Guide",
    });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.text)).toEqual({
      id: "automation_1",
      name: "Renamed",
      isActive: false,
      dashboardPath: "/campaigns/automation_1",
    });
    expect(mockPrisma.automation.findFirst).toHaveBeenCalledWith({
      where: { id: "automation_1", workspaceId: "workspace_1" },
    });
    expect(mockPrisma.automation.update).toHaveBeenCalledWith({
      where: { id: "automation_1" },
      data: { name: "Renamed" },
    });
    expect(mockPrisma.trackedLink.update).toHaveBeenCalledWith({
      where: { id: "link_0" },
      data: { destinationUrl: "https://example.com/new" },
    });
    expect(mockPrisma.trackedLink.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace_1",
        automationId: "automation_1",
        label: "Guide",
        destinationUrl: "https://example.com/second",
        position: 1,
      }),
    });
  });

  it.each([true, false])("sets isActive to %s", async (active) => {
    allowToken();

    const result = await callTool("set_campaign_active", {
      id: "automation_1",
      active,
    });

    expect(JSON.parse(result.text)).toMatchObject({
      id: "automation_1",
      isActive: active,
    });
    expect(mockPrisma.automation.update).toHaveBeenCalledWith({
      where: { id: "automation_1" },
      data: { isActive: active },
    });
  });

  it.each([
    ["update_campaign", { id: "automation_other", name: "Renamed" }],
    ["set_campaign_active", { id: "automation_other", active: true }],
  ])("%s cannot reach another workspace's campaign", async (tool, args) => {
    allowToken();
    mockPrisma.automation.findFirst.mockResolvedValue(null);

    const result = await callTool(tool, args);

    expect(result.isError).toBe(true);
    expect(result.text).toBe("Campaign automation_other not found in this workspace");
    expect(mockPrisma.automation.findFirst).toHaveBeenCalledWith({
      where: { id: "automation_other", workspaceId: "workspace_1" },
    });
    expect(mockPrisma.automation.update).not.toHaveBeenCalled();
  });

  it.each([
    ["create_campaign", validCreate, "Only owners and admins can create campaigns"],
    [
      "update_campaign",
      { id: "automation_1", name: "Renamed" },
      "Only owners and admins can update campaigns",
    ],
    [
      "set_campaign_active",
      { id: "automation_1", active: true },
      "Only owners and admins can update campaigns",
    ],
  ])("%s is forbidden once the token's creator is only a member", async (tool, args, message) => {
    allowToken("MEMBER");

    const result = await callTool(tool, args);

    expect(result.isError).toBe(true);
    expect(result.text).toBe(message);
    expect(mockPrisma.workspaceMember.findUnique).toHaveBeenLastCalledWith({
      where: {
        workspaceId_userId: { workspaceId: "workspace_1", userId: "user_1" },
      },
      select: { role: true },
    });
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
    expect(mockPrisma.automation.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.automation.update).not.toHaveBeenCalled();
  });

  it("keeps read tools available to members", async () => {
    allowToken("MEMBER");
    mockPrisma.automation.findMany.mockResolvedValue([]);

    const result = await callTool("list_campaigns");

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.text)).toEqual({ campaigns: [] });
  });
});
