import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import {
  generateApiToken,
  getApiTokenDisplayPrefix,
  hashApiToken,
  isMcpEnabled,
} from "@/lib/mcp/tokens";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
  type WorkspaceContext,
} from "@/lib/workspace-access";

// Token lists are read-your-writes (a new token must show up immediately), so
// never cache this route.
export const dynamic = "force-dynamic";

const createTokenSchema = z.object({
  name: z.string().trim().min(1).max(60),
});

const revokeTokenSchema = z.object({
  id: z.string().min(1),
});

// Never select tokenHash: the list is all the settings card ever needs.
const tokenSelect = {
  id: true,
  name: true,
  tokenPrefix: true,
  createdAt: true,
  lastUsedAt: true,
  user: { select: { name: true, email: true } },
} as const;

/**
 * Shared gate for every method: 404 while the feature is off (so the route is
 * indistinguishable from one that does not exist), then session auth, then
 * owner/admin only — a token grants API access to the whole workspace.
 */
async function authorize(): Promise<WorkspaceContext | NextResponse> {
  if (!isMcpEnabled()) {
    return NextResponse.json(
      { success: false, error: "Not found" },
      { status: 404 }
    );
  }

  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }
  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only owners and admins can manage API tokens" },
      { status: 403 }
    );
  }

  return context;
}

function listTokens(workspaceId: string) {
  return prisma.apiToken.findMany({
    where: { workspaceId, revokedAt: null },
    orderBy: { createdAt: "desc" },
    select: tokenSelect,
  });
}

export async function GET() {
  const context = await authorize();
  if (context instanceof NextResponse) return context;

  return NextResponse.json(
    { success: true, data: { tokens: await listTokens(context.workspaceId) } },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(request: NextRequest) {
  const context = await authorize();
  if (context instanceof NextResponse) return context;

  const parsed = createTokenSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "Give the token a name (up to 60 characters)" },
      { status: 400 }
    );
  }

  const token = generateApiToken();
  const created = await prisma.apiToken.create({
    data: {
      workspaceId: context.workspaceId,
      userId: context.userId,
      name: parsed.data.name,
      tokenHash: hashApiToken(token),
      tokenPrefix: getApiTokenDisplayPrefix(token),
    },
    select: tokenSelect,
  });

  // The plaintext token leaves the server exactly once, in this response.
  return NextResponse.json(
    {
      success: true,
      data: {
        token,
        created,
        tokens: await listTokens(context.workspaceId),
      },
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function DELETE(request: NextRequest) {
  const context = await authorize();
  if (context instanceof NextResponse) return context;

  const body = await request.json().catch(() => ({}));
  const parsed = revokeTokenSchema.safeParse({
    id: request.nextUrl.searchParams.get("id") ?? body?.id,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "Missing token ID" },
      { status: 400 }
    );
  }

  // Scoped to the workspace so one workspace can never revoke another's token.
  const result = await prisma.apiToken.updateMany({
    where: {
      id: parsed.data.id,
      workspaceId: context.workspaceId,
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  });
  if (result.count === 0) {
    return NextResponse.json(
      { success: false, error: "Token not found" },
      { status: 404 }
    );
  }

  return NextResponse.json(
    { success: true, data: { tokens: await listTokens(context.workspaceId) } },
    { headers: { "Cache-Control": "no-store" } }
  );
}
