"use client";

import { useEffect, useState } from "react";

interface ApiTokenRow {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  user: { name: string | null; email: string | null };
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString();
}

/**
 * Settings card for MCP access tokens. Renders nothing unless the token API
 * answers: it returns 404 while MCP_ENABLED is off and 403 for members who
 * cannot manage the workspace, and in both cases the card stays hidden.
 */
export function McpTokensCard() {
  const [tokens, setTokens] = useState<ApiTokenRow[] | null>(null);
  const [endpoint, setEndpoint] = useState("");
  const [name, setName] = useState("");
  const [newToken, setNewToken] = useState<string | null>(null);
  const [copied, setCopied] = useState<"token" | "endpoint" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/mcp/tokens", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) return;
        const payload = await res.json();
        if (!payload.success) return;
        setEndpoint(`${window.location.origin}/api/mcp`);
        setTokens(payload.data.tokens);
      })
      // A failed load keeps the card hidden, same as the feature being off.
      .catch(() => undefined);
  }, []);

  async function copy(value: string, target: "token" | "endpoint") {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(target);
    } catch {
      setError("Could not copy to the clipboard");
    }
  }

  async function createToken(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy("create");
    try {
      const res = await fetch("/api/mcp/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const payload = await res.json();
      if (payload.success) {
        setTokens(payload.data.tokens);
        setNewToken(payload.data.token);
        setCopied(null);
        setName("");
      } else {
        setError(payload.error ?? "Could not create the token");
      }
    } catch {
      setError("Could not reach the server");
    } finally {
      setBusy(null);
    }
  }

  async function revokeToken(token: ApiTokenRow) {
    if (
      !confirm(
        `Revoke "${token.name}"? Any MCP client using it will lose access immediately.`
      )
    ) {
      return;
    }

    setError(null);
    setBusy(`revoke:${token.id}`);
    try {
      const res = await fetch(
        `/api/mcp/tokens?id=${encodeURIComponent(token.id)}`,
        { method: "DELETE" }
      );
      const payload = await res.json();
      if (payload.success) {
        setTokens(payload.data.tokens);
      } else {
        setError(payload.error ?? "Could not revoke the token");
      }
    } catch {
      setError("Could not reach the server");
    } finally {
      setBusy(null);
    }
  }

  if (tokens === null) return null;

  return (
    <section className="panel rounded p-4 sm:p-6">
      <h2 className="text-base font-semibold mb-2">MCP access</h2>
      <p className="text-sm text-muted">
        Connect Claude or other MCP clients to manage campaigns. Each token
        gives read access to every campaign in this workspace.
      </p>

      <div className="mt-4 rounded border border-border bg-surface/70 p-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
          Server URL
        </p>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
          <code className="min-w-0 flex-1 break-all text-sm text-foreground">
            {endpoint}
          </code>
          <button
            type="button"
            onClick={() => copy(endpoint, "endpoint")}
            className="self-start rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-border-hover hover:text-foreground sm:self-auto"
          >
            {copied === "endpoint" ? "Copied" : "Copy"}
          </button>
        </div>
      </div>

      {newToken && (
        <div
          role="status"
          className="mt-4 rounded border border-warning/30 bg-warning/10 p-3"
        >
          <p className="text-sm font-medium text-foreground">
            Copy your new token now. It won&apos;t be shown again.
          </p>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
            <code className="min-w-0 flex-1 break-all rounded border border-border bg-surface px-2 py-1.5 text-xs text-foreground">
              {newToken}
            </code>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => copy(newToken, "token")}
                className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-border-hover hover:text-foreground"
              >
                {copied === "token" ? "Copied" : "Copy"}
              </button>
              <button
                type="button"
                onClick={() => setNewToken(null)}
                className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-border-hover hover:text-foreground"
              >
                Done
              </button>
            </div>
          </div>
          <p className="mt-2 text-xs text-muted">
            Send it as <code>Authorization: Bearer &lt;token&gt;</code>.
          </p>
        </div>
      )}

      <div className="mt-4 space-y-3">
        {tokens.length === 0 && (
          <p className="text-sm text-muted">No active tokens yet.</p>
        )}
        {tokens.map((token) => (
          <div
            key={token.id}
            className="flex flex-col gap-3 border-b border-border py-3 last:border-0 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">
                {token.name}
              </p>
              <p className="text-xs text-muted">
                <code>{token.tokenPrefix}…</code> · Created{" "}
                {formatDate(token.createdAt)}
                {token.user.name || token.user.email
                  ? ` by ${token.user.name ?? token.user.email}`
                  : ""}{" "}
                ·{" "}
                {token.lastUsedAt
                  ? `Last used ${formatDate(token.lastUsedAt)}`
                  : "Never used"}
              </p>
            </div>
            <button
              type="button"
              onClick={() => revokeToken(token)}
              disabled={busy === `revoke:${token.id}`}
              className="self-start rounded-lg border border-error/20 px-3 py-1.5 text-xs font-medium text-error transition-colors hover:bg-error/10 disabled:opacity-50 sm:self-auto"
            >
              {busy === `revoke:${token.id}` ? "Revoking..." : "Revoke"}
            </button>
          </div>
        ))}
      </div>

      <form
        onSubmit={createToken}
        className="mt-4 grid gap-3 border-t border-border pt-4 sm:grid-cols-[1fr_auto]"
      >
        <input
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Token name, e.g. Claude Desktop"
          maxLength={60}
          aria-label="Token name"
          className="rounded border border-border bg-surface px-4 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent/40"
          required
        />
        <button
          type="submit"
          disabled={busy === "create" || !name.trim()}
          className="rounded bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
        >
          {busy === "create" ? "Creating..." : "Create token"}
        </button>
        {error && <p className="sm:col-span-2 text-sm text-error">{error}</p>}
      </form>
    </section>
  );
}
