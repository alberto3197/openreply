import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  createCampaign,
  updateCampaign,
  type CampaignMutationError,
} from "@/lib/campaigns/mutations";
import {
  createCampaignFieldsSchema,
  updateCampaignSchema,
} from "@/lib/campaigns/schemas";
import {
  getCampaign,
  getCampaignStats,
  listCampaigns,
} from "@/lib/mcp/campaigns";
import { listInstagramAccounts, listRecentPosts } from "@/lib/mcp/instagram";
import { getApiTokenRole, type ApiTokenAuth } from "@/lib/mcp/tokens";
import { canManageWorkspace } from "@/lib/workspace-access";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

// Write tools only ever create or change campaigns; nothing here deletes data.
const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
} as const;

// Shared argument descriptions for the create and update tools.
const FIELD_DESCRIPTIONS: Record<string, string> = {
  name: "Campaign name shown in the dashboard",
  goal: "Short note on what the campaign is for",
  instagramAccountId:
    "Connected Instagram account ID from list_instagram_accounts. Defaults to the most recently connected account",
  postId:
    "Instagram post ID from list_recent_posts. Required unless matchAnyPost or pendingNextReel is true",
  postUrl: "Permalink of the post from list_recent_posts",
  pendingNextReel:
    "Trigger on the next post the account publishes; it is bound automatically once posted",
  matchAnyPost: "Trigger on comments under any post of the account",
  keywords:
    "Comment keywords that trigger the DM (max 10). Required unless matchAnyWord is true",
  matchAnyWord: "Trigger on every comment, regardless of keywords",
  wholeWordMatch: "Match keywords as whole words only",
  dmTriggerEnabled:
    "Also reply to direct messages containing the keywords (every DM when matchAnyWord is true)",
  dmMessage:
    "The DM sent to commenters. {link} inserts the tracked link; {username} personalizes",
  openingDmEnabled:
    "Send an opening DM with a button before the link DM; needs openingDmMessage and openingDmButtonLabel",
  openingDmMessage: "Text of the opening DM",
  openingDmButtonLabel: "Button title of the opening DM",
  linkButtonLabel: "Button title of the primary tracked link (max 20 characters)",
  requireFollow: "Ask commenters to follow the account before they get the link",
  followPromptMessage: "Text asking the commenter to follow",
  followPromptButtonLabel: "Button title for confirming the follow",
  followUpEnabled: "Send a follow-up DM after the link DM",
  followUpMessage: "Text of the follow-up DM",
  followUpDelayMinutes: "Minutes to wait before the follow-up (0-1440)",
  publicReplyEnabled: "Publicly reply to the triggering comment",
  publicReplyMessages:
    "Public reply variations for the triggering comment (max 10)",
  trackedDestinationUrl:
    "Destination of the primary tracked link inserted at {link}",
  secondaryDestinationUrl:
    "Destination of an optional second tracked link, sent as a second DM button",
  secondaryButtonLabel:
    "Button title of the second tracked link (max 20 characters, defaults to 'Open link')",
};

function describeFields<T extends Record<string, z.ZodType>>(shape: T): T {
  return Object.fromEntries(
    Object.entries(shape).map(([key, schema]) => [
      key,
      FIELD_DESCRIPTIONS[key] ? schema.describe(FIELD_DESCRIPTIONS[key]) : schema,
    ])
  ) as T;
}

// The create schema minus `isActive`: MCP-created campaigns always start paused.
// The legacy single public reply is left to the dashboard. The service re-runs
// the full create schema, cross-field rules included.
const createCampaignInput = z.object(
  describeFields(
    createCampaignFieldsSchema.omit({
      isActive: true,
      publicReplyMessage: true,
    }).shape
  )
);

// Partial update without `isActive` (set_campaign_active owns it) or the public
// report toggle. Link URLs must be real URLs: the dashboard API reads an empty
// string as "delete the link", which also drops its click history and breaks
// the link in DMs already sent, so clearing stays a dashboard-only action.
// Strict, so a stray `isActive` is rejected instead of silently ignored.
const updateCampaignInput = z
  .object(
    describeFields(
      updateCampaignSchema.omit({
        isActive: true,
        reportShareEnabled: true,
        publicReplyMessage: true,
        trackedDestinationUrl: true,
        secondaryDestinationUrl: true,
      }).shape
    )
  )
  .extend({
    id: z.string().min(1).describe("Campaign ID from list_campaigns"),
    trackedDestinationUrl: z
      .string()
      .url()
      .optional()
      .describe("New destination of the primary tracked link (added if missing)"),
    secondaryDestinationUrl: z
      .string()
      .url()
      .optional()
      .describe(
        "New destination of the second tracked link (added if missing). Send secondaryButtonLabel with it: the label is only applied together with this field, and resets to 'Open link' when omitted"
      ),
  })
  .strict();

function jsonResult(data: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

// Flattens the service's validation details into one readable line, e.g.
// "Invalid input: keywords: Add at least one keyword, or match any word".
function mutationErrorResult({ error, details }: CampaignMutationError) {
  if (!details) return errorResult(error);

  const issues = [
    ...details.formErrors,
    ...Object.entries(details.fieldErrors).flatMap(([field, messages]) =>
      (messages ?? []).map((message) => `${field}: ${message}`)
    ),
  ];
  return errorResult(issues.length > 0 ? `${error}: ${issues.join("; ")}` : error);
}

function campaignSummary(campaign: { id: string; name: string; isActive: boolean }) {
  return {
    id: campaign.id,
    name: campaign.name,
    isActive: campaign.isActive,
    dashboardPath: `/campaigns/${campaign.id}`,
  };
}

/**
 * Builds a fresh MCP server bound to one authenticated token. The endpoint is
 * stateless, so a server lives for exactly one HTTP request and every tool
 * reads the workspace from the closure rather than from tool arguments — a
 * client can never ask for another workspace's data.
 */
export function createMcpServer(auth: ApiTokenAuth) {
  const server = new McpServer({ name: "openreply", version: "0.1.0" });

  // Same rule as the dashboard's create/update endpoints: owners and admins
  // only. The role is read on every call, so demoting the token's creator
  // takes effect immediately.
  async function forbidUnlessManager(action: "create" | "update") {
    const role = await getApiTokenRole(auth);
    return role && canManageWorkspace(role)
      ? null
      : errorResult(`Only owners and admins can ${action} campaigns`);
  }

  server.registerTool(
    "list_campaigns",
    {
      title: "List campaigns",
      description:
        "List the comment-to-DM campaigns in this OpenReply workspace with their trigger summary (post, keywords) and status.",
      inputSchema: {
        instagramAccountId: z
          .string()
          .min(1)
          .optional()
          .describe("Only return campaigns for this connected Instagram account ID"),
        isActive: z
          .boolean()
          .optional()
          .describe("Only return active (true) or paused (false) campaigns"),
      },
      annotations: READ_ONLY,
    },
    async ({ instagramAccountId, isActive }) =>
      jsonResult({
        campaigns: await listCampaigns(auth.workspaceId, {
          instagramAccountId,
          isActive,
        }),
      })
  );

  server.registerTool(
    "get_campaign",
    {
      title: "Get campaign",
      description:
        "Get the full configuration of one campaign: trigger, DM messages, opening DM, follow gate, follow-up, public replies and tracked links.",
      inputSchema: {
        id: z.string().min(1).describe("Campaign ID from list_campaigns"),
      },
      annotations: READ_ONLY,
    },
    async ({ id }) => {
      const campaign = await getCampaign(auth.workspaceId, id);
      return campaign
        ? jsonResult(campaign)
        : errorResult(`Campaign ${id} not found in this workspace`);
    }
  );

  server.registerTool(
    "get_campaign_stats",
    {
      title: "Get campaign stats",
      description:
        "Get delivery and engagement stats for one campaign: DMs sent, skipped and failed, link clicks, click-through rate and top matched keywords.",
      inputSchema: {
        id: z.string().min(1).describe("Campaign ID from list_campaigns"),
      },
      annotations: READ_ONLY,
    },
    async ({ id }) => {
      const stats = await getCampaignStats(auth.workspaceId, id);
      return stats
        ? jsonResult(stats)
        : errorResult(`Campaign ${id} not found in this workspace`);
    }
  );

  server.registerTool(
    "list_instagram_accounts",
    {
      title: "List Instagram accounts",
      description:
        "List the Instagram accounts connected to this workspace (ID, username, provider), to choose which account a new campaign runs on.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () =>
      jsonResult({
        instagramAccounts: await listInstagramAccounts(auth.workspaceId),
      })
  );

  server.registerTool(
    "list_recent_posts",
    {
      title: "List recent posts",
      description:
        "List the most recent posts of a connected Instagram account (ID, permalink, caption excerpt, media type, timestamp), to choose the post a campaign triggers on.",
      inputSchema: {
        instagramAccountId: z
          .string()
          .min(1)
          .describe("Connected Instagram account ID from list_instagram_accounts"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .default(10)
          .describe("How many posts to return (1-50, default 10)"),
      },
      // Reads live from Instagram rather than from OpenReply's database.
      annotations: { ...READ_ONLY, openWorldHint: true },
    },
    async ({ instagramAccountId, limit }) => {
      try {
        const posts = await listRecentPosts(
          auth.workspaceId,
          instagramAccountId,
          limit
        );
        return posts
          ? jsonResult({ posts })
          : errorResult(
              `Instagram account ${instagramAccountId} not found in this workspace`
            );
      } catch (error) {
        console.error("[MCP] Failed to fetch Instagram posts", error);
        return errorResult("Failed to fetch Instagram posts");
      }
    }
  );

  server.registerTool(
    "create_campaign",
    {
      title: "Create campaign",
      description:
        "Create a comment-to-DM campaign. It is always created paused and sends nothing until it is activated with set_campaign_active. Target a specific post (postId from list_recent_posts), any post (matchAnyPost) or the next post (pendingNextReel), and match keywords or any word (matchAnyWord).",
      inputSchema: createCampaignInput,
      annotations: { ...WRITE, idempotentHint: false },
    },
    async (args) => {
      const forbidden = await forbidUnlessManager("create");
      if (forbidden) return forbidden;

      const result = await createCampaign({
        workspaceId: auth.workspaceId,
        input: { ...args, isActive: false },
      });
      return result.ok
        ? jsonResult(campaignSummary(result.data))
        : mutationErrorResult(result);
    }
  );

  server.registerTool(
    "update_campaign",
    {
      title: "Update campaign",
      description:
        "Change fields of an existing campaign; omitted fields stay unchanged. Tracked links can be changed or added, but removing a link is only possible from the OpenReply dashboard. Use set_campaign_active to pause or activate.",
      inputSchema: updateCampaignInput,
      annotations: { ...WRITE, idempotentHint: true },
    },
    async ({ id, ...fields }) => {
      const forbidden = await forbidUnlessManager("update");
      if (forbidden) return forbidden;

      const result = await updateCampaign({
        workspaceId: auth.workspaceId,
        campaignId: id,
        input: fields,
      });
      if (result.ok) return jsonResult(campaignSummary(result.data));
      return result.status === 404
        ? errorResult(`Campaign ${id} not found in this workspace`)
        : mutationErrorResult(result);
    }
  );

  server.registerTool(
    "set_campaign_active",
    {
      title: "Activate or pause campaign",
      description:
        "Activate or pause a campaign. Warning: activating makes the campaign start sending real Instagram DMs and public replies to people who comment, right away.",
      inputSchema: {
        id: z.string().min(1).describe("Campaign ID from list_campaigns"),
        active: z
          .boolean()
          .describe("true to activate (starts sending), false to pause"),
      },
      // Activation has real-world effects on Instagram users.
      annotations: { ...WRITE, idempotentHint: true, openWorldHint: true },
    },
    async ({ id, active }) => {
      const forbidden = await forbidUnlessManager("update");
      if (forbidden) return forbidden;

      const result = await updateCampaign({
        workspaceId: auth.workspaceId,
        campaignId: id,
        input: { isActive: active },
      });
      if (result.ok) return jsonResult(campaignSummary(result.data));
      return result.status === 404
        ? errorResult(`Campaign ${id} not found in this workspace`)
        : mutationErrorResult(result);
    }
  );

  return server;
}
