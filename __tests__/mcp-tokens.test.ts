import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    apiToken: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    workspaceMember: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("@/lib/db/client", () => ({
  prisma: mockPrisma,
}));

import {
  authenticateApiToken,
  generateApiToken,
  getApiTokenDisplayPrefix,
  hashApiToken,
  isMcpEnabled,
  parseBearerToken,
} from "../lib/mcp/tokens";

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("API token primitives", () => {
  it("generates prefixed, url-safe, unique tokens", () => {
    const first = generateApiToken();
    const second = generateApiToken();

    expect(first).toMatch(/^or_[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
  });

  it("hashes tokens to a stable sha256 hex digest", () => {
    const hash = hashApiToken("or_example");

    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hashApiToken("or_example")).toBe(hash);
    expect(hashApiToken("or_other")).not.toBe(hash);
  });

  it("keeps only a short display prefix", () => {
    expect(getApiTokenDisplayPrefix("or_AbCd1234567890")).toBe("or_AbCd123");
  });

  it("is disabled unless MCP_ENABLED is exactly true", () => {
    expect(isMcpEnabled()).toBe(false);
    vi.stubEnv("MCP_ENABLED", "1");
    expect(isMcpEnabled()).toBe(false);
    vi.stubEnv("MCP_ENABLED", "true");
    expect(isMcpEnabled()).toBe(true);
  });
});

describe("bearer header parsing", () => {
  it("accepts an OpenReply bearer token", () => {
    expect(parseBearerToken("Bearer or_abc123")).toBe("or_abc123");
    expect(parseBearerToken("bearer   or_abc123  ")).toBe("or_abc123");
  });

  it("rejects missing, malformed, and foreign credentials", () => {
    expect(parseBearerToken(null)).toBeNull();
    expect(parseBearerToken(undefined)).toBeNull();
    expect(parseBearerToken("")).toBeNull();
    expect(parseBearerToken("or_abc123")).toBeNull();
    expect(parseBearerToken("Basic or_abc123")).toBeNull();
    expect(parseBearerToken("Bearer sk_live_abc")).toBeNull();
    expect(parseBearerToken("Bearer or_abc 123")).toBeNull();
    expect(parseBearerToken(`Bearer or_${"a".repeat(200)}`)).toBeNull();
  });
});

describe("authenticateApiToken", () => {
  const token = "or_valid-token";
  const record = {
    id: "token_1",
    workspaceId: "workspace_1",
    userId: "user_1",
    revokedAt: null,
    lastUsedAt: null,
  };

  it("resolves a valid token to its workspace by hash", async () => {
    mockPrisma.apiToken.findUnique.mockResolvedValue(record);
    mockPrisma.workspaceMember.findUnique.mockResolvedValue({ id: "m_1" });
    mockPrisma.apiToken.update.mockResolvedValue({});
    const tasks: Array<() => Promise<void>> = [];

    const auth = await authenticateApiToken(`Bearer ${token}`, (task) => {
      tasks.push(task);
    });

    expect(auth).toEqual({
      workspaceId: "workspace_1",
      userId: "user_1",
      tokenId: "token_1",
    });
    expect(mockPrisma.apiToken.findUnique).toHaveBeenCalledWith({
      where: { tokenHash: hashApiToken(token) },
      select: expect.any(Object),
    });

    // lastUsedAt is deferred to the scheduler, not awaited inline.
    expect(mockPrisma.apiToken.update).not.toHaveBeenCalled();
    expect(tasks).toHaveLength(1);
    await tasks[0]();
    expect(mockPrisma.apiToken.update).toHaveBeenCalledWith({
      where: { id: "token_1" },
      data: { lastUsedAt: expect.any(Date) },
    });
  });

  it("does not query the database for a malformed header", async () => {
    expect(await authenticateApiToken("Bearer nope")).toBeNull();
    expect(mockPrisma.apiToken.findUnique).not.toHaveBeenCalled();
  });

  it("rejects unknown and revoked tokens", async () => {
    mockPrisma.apiToken.findUnique.mockResolvedValueOnce(null);
    expect(await authenticateApiToken(`Bearer ${token}`)).toBeNull();

    mockPrisma.apiToken.findUnique.mockResolvedValueOnce({
      ...record,
      revokedAt: new Date(),
    });
    expect(await authenticateApiToken(`Bearer ${token}`)).toBeNull();
    expect(mockPrisma.workspaceMember.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a token whose creator left the workspace", async () => {
    mockPrisma.apiToken.findUnique.mockResolvedValue(record);
    mockPrisma.workspaceMember.findUnique.mockResolvedValue(null);

    expect(await authenticateApiToken(`Bearer ${token}`)).toBeNull();
  });

  it("skips the lastUsedAt write when the token was used moments ago", async () => {
    mockPrisma.apiToken.findUnique.mockResolvedValue({
      ...record,
      lastUsedAt: new Date(Date.now() - 5_000),
    });
    mockPrisma.workspaceMember.findUnique.mockResolvedValue({ id: "m_1" });
    const schedule = vi.fn();

    expect(await authenticateApiToken(`Bearer ${token}`, schedule)).not.toBeNull();
    expect(schedule).not.toHaveBeenCalled();
  });

  it("never fails the request when recording usage fails", async () => {
    mockPrisma.apiToken.findUnique.mockResolvedValue(record);
    mockPrisma.workspaceMember.findUnique.mockResolvedValue({ id: "m_1" });
    mockPrisma.apiToken.update.mockRejectedValue(new Error("db down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tasks: Array<() => Promise<void>> = [];

    const auth = await authenticateApiToken(`Bearer ${token}`, (task) => {
      tasks.push(task);
    });

    expect(auth?.tokenId).toBe("token_1");
    await expect(tasks[0]()).resolves.toBeUndefined();
    warn.mockRestore();
  });
});
