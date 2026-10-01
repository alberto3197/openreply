import { after } from "next/server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "@/lib/mcp/server";
import {
  authenticateApiToken,
  isMcpEnabled,
  type ApiTokenAuth,
} from "@/lib/mcp/tokens";

// MCP Streamable HTTP endpoint, in stateless mode: serverless instances share
// no memory, so there are no sessions and no server-initiated SSE stream. Each
// POST gets its own server + transport and a plain JSON response.
export const dynamic = "force-dynamic";

function jsonRpcError(
  status: number,
  message: string,
  headers?: Record<string, string>
) {
  return Response.json(
    { jsonrpc: "2.0", error: { code: -32000, message }, id: null },
    { status, headers }
  );
}

async function authorize(request: Request): Promise<ApiTokenAuth | Response> {
  // While the feature is off the endpoint does not exist, even for valid tokens.
  if (!isMcpEnabled()) {
    return new Response("Not Found", { status: 404 });
  }

  const auth = await authenticateApiToken(
    request.headers.get("authorization"),
    after
  );
  if (!auth) {
    return jsonRpcError(401, "Missing or invalid API token", {
      "WWW-Authenticate": 'Bearer realm="OpenReply MCP"',
    });
  }
  return auth;
}

export async function POST(request: Request) {
  const auth = await authorize(request);
  if (auth instanceof Response) return auth;

  const server = createMcpServer(auth);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    // In JSON mode this resolves only once every response is ready, so the
    // server can be torn down right after.
    return await transport.handleRequest(request);
  } catch (error) {
    console.error("MCP request failed", error);
    return jsonRpcError(500, "Internal server error");
  } finally {
    await server.close().catch(() => undefined);
  }
}

// Without sessions there is no stream to open (GET) and nothing to terminate
// (DELETE). The spec allows answering both with 405; authenticating first keeps
// the endpoint from confirming anything to anonymous callers.
async function methodNotAllowed(request: Request) {
  const auth = await authorize(request);
  if (auth instanceof Response) return auth;

  return jsonRpcError(405, "Method not allowed", { Allow: "POST" });
}

export const GET = methodNotAllowed;
export const DELETE = methodNotAllowed;
