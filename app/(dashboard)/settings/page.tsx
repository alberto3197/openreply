"use client";

import { Suspense, useEffect, useState } from "react";
import type { AccountOption } from "@/components/account-select";
import { ZernioConnection } from "@/components/zernio-connection";
import { InstagramConnectNotice } from "@/components/instagram-connect-notice";

interface SettingsData {
  workspace: {
    name: string;
    dmsSentThisPeriod: number;
  };
  instagramAccount: {
    id: string;
    username: string;
    instagramId: string;
    tokenExpiresAt: string | null;
    webhookSubscribed: boolean;
  } | null;
  instagramAccounts: Array<
    AccountOption & {
      provider?: "META" | "ZERNIO";
      tokenExpiresAt: string | null;
      webhookSubscribed: boolean;
    }
  >;
}

/** Per-account human delays, keyed by account id. */
type AccountDelays = Record<
  string,
  { publicReplyDelaySeconds: number; dmDelaySeconds: number }
>;

const MAX_PUBLIC_REPLY_DELAY_SECONDS = 120;
const MAX_DM_DELAY_SECONDS = 60;

interface WorkspaceMembersData {
  currentUserRole: "OWNER" | "ADMIN" | "MEMBER";
  members: Array<{
    id: string;
    role: "OWNER" | "ADMIN" | "MEMBER";
    createdAt: string;
    user: {
      id: string;
      email: string | null;
      name: string | null;
    };
  }>;
  invitations: Array<{
    id: string;
    email: string;
    role: "OWNER" | "ADMIN" | "MEMBER";
    inviteUrl: string;
    expiresAt: string;
  }>;
}

export default function SettingsPage() {
  const [data, setData] = useState<SettingsData | null>(null);
  const [membersData, setMembersData] = useState<WorkspaceMembersData | null>(
    null
  );
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"ADMIN" | "MEMBER">("MEMBER");
  const [memberError, setMemberError] = useState<string | null>(null);
  const [delays, setDelays] = useState<AccountDelays>({});
  const [delayError, setDelayError] = useState<{
    accountId: string;
    message: string;
  } | null>(null);
  // The id of the account whose delays were just saved, so the form can say so.
  // Cleared on the next edit or save attempt rather than on a timer, so the
  // confirmation never contradicts what is currently on screen.
  const [delaySaved, setDelaySaved] = useState<string | null>(null);
  // Distinguishes "this account has no delay settings loaded" from "the request
  // for them failed". Without it a failed fetch would just render nothing.
  const [delaysUnavailable, setDelaysUnavailable] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch("/api/dashboard/stats").then((res) => res.json()),
      fetch("/api/workspace/members").then((res) => res.json()),
      // The stats payload carries the account list, but not these settings;
      // the accounts route is where they are read and written.
      fetch("/api/instagram/accounts").then((res) => res.json()),
    ])
      .then(([statsPayload, membersPayload, accountsPayload]) => {
        if (statsPayload.success) setData(statsPayload.data);
        if (membersPayload.success) setMembersData(membersPayload.data);
        if (!accountsPayload.success) {
          setDelaysUnavailable(true);
        } else {
          setDelays(
            Object.fromEntries(
              accountsPayload.data.instagramAccounts.map(
                (account: {
                  id: string;
                  publicReplyDelaySeconds: number;
                  dmDelaySeconds: number;
                }) => [
                  account.id,
                  {
                    publicReplyDelaySeconds: account.publicReplyDelaySeconds,
                    dmDelaySeconds: account.dmDelaySeconds,
                  },
                ]
              )
            )
          );
        }
      })
      .catch(() => setDelaysUnavailable(true))
      .finally(() => setLoading(false));
  }, []);

  async function refreshMembers() {
    const res = await fetch("/api/workspace/members");
    const payload = await res.json();
    if (payload.success) setMembersData(payload.data);
  }

  async function disconnectInstagram(instagramAccountId: string) {
    if (!confirm("Disconnect Instagram? Campaigns for this account will stop sending DMs.")) {
      return;
    }

    setBusy(`disconnect:${instagramAccountId}`);
    await fetch("/api/instagram/disconnect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instagramAccountId }),
    });
    window.location.reload();
  }

  // Clamp in the input itself so what the operator sees is always what the API
  // will accept — a number input lets anything be typed, arrows included.
  function updateDelay(
    accountId: string,
    field: "publicReplyDelaySeconds" | "dmDelaySeconds",
    raw: string
  ) {
    const max =
      field === "publicReplyDelaySeconds"
        ? MAX_PUBLIC_REPLY_DELAY_SECONDS
        : MAX_DM_DELAY_SECONDS;
    const parsed = Number.parseInt(raw, 10);
    const value = Number.isNaN(parsed)
      ? 0
      : Math.min(Math.max(Math.trunc(parsed), 0), max);

    setDelaySaved((current) => (current === accountId ? null : current));
    setDelays((current) => ({
      ...current,
      [accountId]: { ...current[accountId], [field]: value },
    }));
  }

  async function saveDelays(event: React.FormEvent, accountId: string) {
    event.preventDefault();
    setDelayError(null);
    setDelaySaved(null);
    setBusy(`delays:${accountId}`);
    try {
      const res = await fetch(
        `/api/instagram/accounts?id=${encodeURIComponent(accountId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(delays[accountId]),
        }
      );
      const payload = await res.json();
      if (payload.success) {
        setDelaySaved(accountId);
      } else {
        setDelayError({
          accountId,
          message: payload.error ?? "Could not save the delays",
        });
      }
    } catch {
      // A network failure or a non-JSON response must not leave the form
      // looking as though the save went through.
      setDelayError({ accountId, message: "Could not reach the server" });
    } finally {
      setBusy(null);
    }
  }

  async function inviteMember(event: React.FormEvent) {
    event.preventDefault();
    setMemberError(null);
    setBusy("invite");
    const res = await fetch("/api/workspace/members", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
    });
    const payload = await res.json();
    if (payload.success) {
      setMembersData(payload.data);
      setInviteEmail("");
    } else {
      setMemberError(payload.error ?? "Could not invite member");
    }
    setBusy(null);
  }

  async function removeInvitation(invitationId: string) {
    setBusy(`invite:${invitationId}`);
    await fetch("/api/workspace/members", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invitationId }),
    });
    await refreshMembers();
    setBusy(null);
  }

  if (loading) {
    return <div className="panel rounded p-8 h-64" />;
  }

  const accounts = data?.instagramAccounts ?? [];
  const canManageMembers =
    membersData?.currentUserRole === "OWNER" ||
    membersData?.currentUserRole === "ADMIN";

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      {/* Surfaces the ?instagram= code the OAuth routes redirect back with.
          Needs a Suspense boundary: useSearchParams in a prerendered client
          page fails the production build without one. */}
      <Suspense fallback={null}>
        <InstagramConnectNotice />
      </Suspense>

      <ZernioConnection canManage={canManageMembers} />

      <section className="panel rounded p-4 sm:p-6">
        <h2 className="text-base font-semibold mb-6">Instagram Connection</h2>

        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3 py-3 border-b border-border">
            <div>
              <p className="text-sm font-medium text-foreground">Status</p>
              <p className="text-xs text-muted mt-0.5">
                Comment webhooks and private replies depend on this connection.
              </p>
            </div>
            <span
              className={`px-3 py-1.5 rounded-full text-xs font-medium ${
                accounts.length > 0
                  ? "bg-success/10 text-success"
                  : "bg-warning/10 text-warning"
              }`}
            >
              {accounts.length > 0 ? "Connected" : "Not connected"}
            </span>
          </div>

          <div className="flex items-center justify-between gap-3 py-3 border-b border-border">
            <div>
              <p className="text-sm font-medium text-foreground">Accounts</p>
              <p className="text-xs text-muted mt-0.5">
                {accounts.length} connected Instagram profile
                {accounts.length === 1 ? "" : "s"}
              </p>
            </div>
            <span className="text-sm text-muted">
              {accounts.length > 0 ? `${accounts.length} connected` : "None"}
            </span>
          </div>

          <div className="space-y-3 py-3">
            {accounts.length === 0 && (
              <p className="text-sm text-muted">
                Connect an Instagram professional account to launch campaigns.
              </p>
            )}
            {accounts.map((account) => (
              <div
                key={account.id}
                className="rounded border border-border bg-surface/70 p-4"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-semibold text-foreground">
                      @{account.username}
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      {account.provider === "ZERNIO" ? "Connected via Zernio" : <>Token expires{" "}
                      {account.tokenExpiresAt
                        ? new Date(account.tokenExpiresAt).toLocaleDateString()
                        : "not available"}</>}{" "}
                      · {account.webhookSubscribed ? "Webhook ready" : "Webhook pending"}
                    </p>
                  </div>
                  <button
                    onClick={() => disconnectInstagram(account.id)}
                    disabled={busy === `disconnect:${account.id}`}
                    className="inline-flex items-center justify-center rounded border border-error/20 px-4 py-2 text-sm font-medium text-error transition-all hover:border-error/40 hover:bg-error/10 disabled:opacity-50"
                  >
                    {busy === `disconnect:${account.id}`
                      ? "Disconnecting..."
                      : "Disconnect"}
                  </button>
                </div>

                {delays[account.id] ? (
                  <form
                    onSubmit={(event) => saveDelays(event, account.id)}
                    className="mt-4 border-t border-border pt-4"
                  >
                    <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                      <label className="flex flex-col gap-1.5">
                        <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                          Wait before replying to the comment
                        </span>
                        <input
                          type="number"
                          min={0}
                          max={MAX_PUBLIC_REPLY_DELAY_SECONDS}
                          value={delays[account.id].publicReplyDelaySeconds}
                          onChange={(event) =>
                            updateDelay(
                              account.id,
                              "publicReplyDelaySeconds",
                              event.target.value
                            )
                          }
                          className="rounded border border-border bg-surface px-4 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent/40"
                        />
                      </label>
                      <label className="flex flex-col gap-1.5">
                        <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                          Wait before sending the DM
                        </span>
                        <input
                          type="number"
                          min={0}
                          max={MAX_DM_DELAY_SECONDS}
                          value={delays[account.id].dmDelaySeconds}
                          onChange={(event) =>
                            updateDelay(
                              account.id,
                              "dmDelaySeconds",
                              event.target.value
                            )
                          }
                          className="rounded border border-border bg-surface px-4 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent/40"
                        />
                      </label>
                      <button
                        type="submit"
                        disabled={busy === `delays:${account.id}`}
                        className="rounded bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
                      >
                        {busy === `delays:${account.id}` ? "Saving..." : "Save"}
                      </button>
                    </div>
                    <p className="mt-2 text-xs text-muted">
                      Seconds to wait before answering — up to{" "}
                      {MAX_PUBLIC_REPLY_DELAY_SECONDS} for the comment reply and{" "}
                      {MAX_DM_DELAY_SECONDS} for the DM. A short pause makes the
                      replies feel less automated, and only applies to comments
                      received in real time.
                    </p>
                    {delaySaved === account.id && (
                      <p className="mt-2 text-sm text-success">
                        Delays saved.
                      </p>
                    )}
                    {delayError?.accountId === account.id && (
                      <p className="mt-2 text-sm text-error">
                        {delayError.message}
                      </p>
                    )}
                  </form>
                ) : delaysUnavailable ? (
                  <p className="mt-4 border-t border-border pt-4 text-xs text-muted">
                    Reply delays could not be loaded, so they cannot be changed
                    here right now. Reload the page to try again — the delays
                    already saved for this account are unaffected.
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        </div>

        <div className="mt-6 pt-4 border-t border-border flex gap-3">
          <a
            href="/api/instagram/connect"
            className="px-4 py-2 rounded text-sm font-medium transition-colors bg-accent text-white hover:bg-accent-hover"
          >
            Connect using your own Meta app
          </a>
        </div>
      </section>

      <section className="panel rounded p-4 sm:p-6">
        <h2 className="text-base font-semibold mb-6">Team</h2>
        <div className="space-y-3">
          {membersData?.members.map((member) => (
            <div
              key={member.id}
              className="flex items-center justify-between gap-4 border-b border-border py-3 last:border-0"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">
                  {member.user.name ?? member.user.email ?? "Unknown member"}
                </p>
                <p className="text-xs text-muted">{member.user.email}</p>
              </div>
              <span className="rounded-full border border-border px-3 py-1 text-xs font-semibold text-muted">
                {member.role}
              </span>
            </div>
          ))}
        </div>

        {membersData?.invitations.length ? (
          <div className="mt-6 border-t border-border pt-4">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Pending invites
            </p>
            <div className="space-y-3">
              {membersData.invitations.map((invitation) => (
                <div
                  key={invitation.id}
                  className="flex flex-col gap-3 rounded border border-border bg-surface/70 p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {invitation.email}
                    </p>
                    <p className="truncate text-xs text-muted">
                      {invitation.role} · {invitation.inviteUrl}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        void navigator.clipboard?.writeText(invitation.inviteUrl)
                      }
                      className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-border-hover hover:text-foreground"
                    >
                      Copy
                    </button>
                    <button
                      type="button"
                      onClick={() => removeInvitation(invitation.id)}
                      disabled={busy === `invite:${invitation.id}`}
                      className="rounded-lg border border-error/20 px-3 py-1.5 text-xs font-medium text-error transition-colors hover:bg-error/10 disabled:opacity-50"
                    >
                      Revoke
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {canManageMembers && (
          <form
            onSubmit={inviteMember}
            className="mt-6 grid gap-3 border-t border-border pt-4 sm:grid-cols-[1fr_140px_auto]"
          >
            <input
              type="email"
              value={inviteEmail}
              onChange={(event) => setInviteEmail(event.target.value)}
              placeholder="teammate@agency.com"
              className="rounded border border-border bg-surface px-4 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent/40"
              required
            />
            <select
              value={inviteRole}
              onChange={(event) =>
                setInviteRole(event.target.value as "ADMIN" | "MEMBER")
              }
              className="rounded border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent/40"
            >
              <option value="MEMBER">Member</option>
              <option value="ADMIN">Admin</option>
            </select>
            <button
              type="submit"
              disabled={busy === "invite"}
              className="rounded bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              {busy === "invite" ? "Inviting..." : "Invite"}
            </button>
            {memberError && (
              <p className="sm:col-span-3 text-sm text-error">{memberError}</p>
            )}
          </form>
        )}
      </section>

      <section className="panel rounded p-4 sm:p-6">
        <h2 className="text-base font-semibold mb-6">Usage</h2>
        <div className="flex items-center justify-between gap-3 py-3">
          <div>
            <p className="text-sm font-medium text-foreground">
              DMs sent this month
            </p>
            <p className="text-xs text-muted mt-0.5">
              Self-hosted — no plan limits.
            </p>
          </div>
          <span className="text-sm font-semibold text-foreground">
            {data?.workspace.dmsSentThisPeriod ?? 0}
          </span>
        </div>
      </section>
    </div>
  );
}
