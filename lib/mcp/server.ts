import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  getCampaign,
  getCampaignStats,
  listCampaigns,
} from "@/lib/mcp/campaigns";
import type { ApiTokenAuth } from "@/lib/mcp/tokens";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function jsonResult(data: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/**
 * Builds a fresh MCP server bound to one authenticated token. The endpoint is
 * stateless, so a server lives for exactly one HTTP request and every tool
 * reads the workspace from the closure rather than from tool arguments — a
 * client can never ask for another workspace's data.
 */
export function createMcpServer(auth: ApiTokenAuth) {
  const server = new McpServer({ name: "openreply", version: "0.1.0" });

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

  return server;
}
