import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

export const runtime = "nodejs";

// Seconds the webhook path waits before each leg of the reaction. The public
// reply is visible to everyone, so it gets the wider range; the DM has to stay
// well inside Instagram's private-reply window.
const updateAccountSchema = z.object({
  publicReplyDelaySeconds: z.number().int().min(0).max(120).optional(),
  dmDelaySeconds: z.number().int().min(0).max(60).optional(),
});

/**
 * The workspace's connected Instagram accounts — just enough for an account
 * selector. This is a single indexed query, unlike /api/dashboard/stats which
 * runs the full analytics aggregation. Pages that only need the account list
 * (e.g. the inbox) should use this so they aren't gated on heavy stats.
 */
export async function GET() {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const instagramAccounts = await prisma.instagramAccount.findMany({
    where: { workspaceId },
    orderBy: { connectedAt: "desc" },
    select: {
      id: true,
      username: true,
      instagramId: true,
      name: true,
      publicReplyDelaySeconds: true,
      dmDelaySeconds: true,
    },
  });

  return NextResponse.json({
    success: true,
    data: {
      instagramAccounts,
      selectedInstagramAccountId: instagramAccounts[0]?.id ?? null,
    },
  });
}

/** Per-account settings an operator can tune: today, the human delays. */
export async function PATCH(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only owners and admins can update accounts" },
      { status: 403 }
    );
  }

  const instagramAccountId = request.nextUrl.searchParams.get("id");
  if (!instagramAccountId) {
    return NextResponse.json(
      { success: false, error: "Missing account ID" },
      { status: 400 }
    );
  }

  const body = await request.json();
  const parsed = updateAccountSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        error: "Invalid input",
        details: parsed.error.flatten(),
      },
      { status: 400 }
    );
  }

  // Scope the update through workspaceId rather than trusting the id alone, so
  // one workspace can never retune another workspace's account.
  const updated = await prisma.instagramAccount.updateMany({
    where: { id: instagramAccountId, workspaceId: context.workspaceId },
    data: parsed.data,
  });

  if (updated.count === 0) {
    return NextResponse.json(
      { success: false, error: "Account not found" },
      { status: 404 }
    );
  }

  const account = await prisma.instagramAccount.findUnique({
    where: { id: instagramAccountId },
    select: {
      id: true,
      username: true,
      instagramId: true,
      name: true,
      publicReplyDelaySeconds: true,
      dmDelaySeconds: true,
    },
  });

  return NextResponse.json({ success: true, data: { instagramAccount: account } });
}
