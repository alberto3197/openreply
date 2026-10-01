import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/db/client";

export const API_TOKEN_PREFIX = "or_";

// "or_" plus 7 random characters: enough to tell tokens apart in the settings
// list without giving away a meaningful part of the secret.
const DISPLAY_PREFIX_LENGTH = 10;

// 32 random bytes encode to 43 base64url characters. Anything far longer is not
// one of our tokens, so it is rejected before hashing.
const MAX_TOKEN_LENGTH = 128;

// Every MCP session sends several requests in a row (initialize, tools/list,
// tools/call...). Recording each one would only churn the row.
const LAST_USED_RESOLUTION_MS = 60_000;

export type ApiTokenAuth = {
  workspaceId: string;
  userId: string;
  tokenId: string;
};

/**
 * The MCP endpoint and its token management ship dark: nothing is reachable
 * until an operator opts in with MCP_ENABLED=true.
 */
export function isMcpEnabled() {
  return process.env.MCP_ENABLED === "true";
}

export function generateApiToken() {
  return `${API_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function hashApiToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function getApiTokenDisplayPrefix(token: string) {
  return token.slice(0, DISPLAY_PREFIX_LENGTH);
}

/** Extracts an OpenReply token from an `Authorization: Bearer or_...` header. */
export function parseBearerToken(header: string | null | undefined) {
  if (!header) return null;

  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match) return null;

  const token = match[1];
  if (!token.startsWith(API_TOKEN_PREFIX) || token.length > MAX_TOKEN_LENGTH) {
    return null;
  }
  return token;
}

type BackgroundScheduler = (task: () => Promise<void>) => void;

// Fallback when the caller has no request-scoped scheduler (tests, scripts).
const runDetached: BackgroundScheduler = (task) => {
  void task();
};

/**
 * Resolves a bearer header to the workspace the token belongs to, or null when
 * the token is missing, unknown, revoked, or its creator has since left the
 * workspace. The lookup goes through the SHA-256 hash, so the plaintext token
 * is never compared directly.
 *
 * lastUsedAt is refreshed through `schedule` (route handlers pass Next's
 * `after`) and any failure there is swallowed: bookkeeping must never reject
 * an otherwise valid request.
 */
export async function authenticateApiToken(
  authorizationHeader: string | null | undefined,
  schedule: BackgroundScheduler = runDetached
): Promise<ApiTokenAuth | null> {
  const token = parseBearerToken(authorizationHeader);
  if (!token) return null;

  const record = await prisma.apiToken.findUnique({
    where: { tokenHash: hashApiToken(token) },
    select: {
      id: true,
      workspaceId: true,
      userId: true,
      revokedAt: true,
      lastUsedAt: true,
    },
  });
  if (!record || record.revokedAt) return null;

  const membership = await prisma.workspaceMember.findUnique({
    where: {
      workspaceId_userId: {
        workspaceId: record.workspaceId,
        userId: record.userId,
      },
    },
    select: { id: true },
  });
  if (!membership) return null;

  const now = new Date();
  if (
    !record.lastUsedAt ||
    now.getTime() - record.lastUsedAt.getTime() >= LAST_USED_RESOLUTION_MS
  ) {
    schedule(async () => {
      try {
        await prisma.apiToken.update({
          where: { id: record.id },
          data: { lastUsedAt: now },
        });
      } catch (error) {
        console.warn("Could not record API token usage", error);
      }
    });
  }

  return {
    workspaceId: record.workspaceId,
    userId: record.userId,
    tokenId: record.id,
  };
}

/**
 * The token creator's current role in the token's workspace, or null once they
 * have left it. Write tools look this up on every call instead of trusting the
 * role at token creation, so a demoted admin's tokens lose write access on the
 * very next request.
 */
export async function getApiTokenRole(auth: ApiTokenAuth) {
  const membership = await prisma.workspaceMember.findUnique({
    where: {
      workspaceId_userId: {
        workspaceId: auth.workspaceId,
        userId: auth.userId,
      },
    },
    select: { role: true },
  });
  return membership?.role ?? null;
}
