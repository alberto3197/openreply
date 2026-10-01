import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockWorkspaceContext } = vi.hoisted(() => ({
  mockPrisma: {
    apiToken: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    workspaceMember: {
      findUnique: vi.fn(),
    },
    automation: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
  },
  mockWorkspaceContext: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  prisma: mockPrisma,
}));

// The real module pulls in next-auth; only the session lookup matters here.
vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: mockWorkspaceContext,
  canManageWorkspace: (role: string) => role === "OWNER" || role === "ADMIN",
}));

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

function allowToken() {
  mockPrisma.apiToken.findUnique.mockResolvedValue({
    id: "token_1",
    workspaceId: "workspace_1",
    userId: "user_1",
    revokedAt: null,
    lastUsedAt: new Date(),
  });
  mockPrisma.workspaceMember.findUnique.mockResolvedValue({ id: "m_1" });
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

  it("initializes and lists the read-only tools", async () => {
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
    ).toEqual(["get_campaign", "get_campaign_stats", "list_campaigns"]);
    for (const tool of listBody.result.tools) {
      expect(tool.annotations.readOnlyHint).toBe(true);
    }
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
