import type { Metadata } from "next";
import LegalShell from "@/components/legal-shell";
import { getLegalConfig } from "@/lib/legal-config";

// Read the controller identity per request instead of inlining it at build time.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Data Deletion - OpenReply",
  description:
    "How to request deletion of data held by this OpenReply instance, whether or not you have an account.",
};

export default function DataDeletionPage() {
  const { controllerName, contactEmail, updatedAt } = getLegalConfig();

  return (
    <LegalShell
      title="Data Deletion"
      description="How to have your data removed from this OpenReply instance."
      updatedAt={updatedAt}
    >
      <section>
        <h2 className="text-xl font-bold text-white">
          If You Commented Or Sent A Message
        </h2>
        <p className="mt-3">
          You do not have an account here and you do not need one. Write to{" "}
          {contactEmail} from any address, including your Instagram username and
          roughly when you commented, and ask for your data to be deleted. Your
          username, the text of your comment or message, the replies sent to
          you, and any recorded link clicks will be removed.
        </p>
        <p className="mt-3">
          You can also simply delete your comment on Instagram. That removes it
          from Instagram, but it does not remove the copy already processed
          here, so write in as well if that is what you want.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-white">
          If You Operate This Instance
        </h2>
        <p className="mt-3">
          Sign in, open Settings, and select Disconnect. This removes the stored
          Instagram connection token and stops campaigns from sending private
          replies for that workspace. To remove the workspace, campaigns, logs,
          and diagnostics as well, delete them from the dashboard or remove the
          database records directly.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-white">Verification</h2>
        <p className="mt-3">
          Enough detail may be requested to be sure the right records are
          deleted and that the request comes from the person concerned — for
          example, confirming the Instagram username from that account.
          Deletion requests are processed as quickly as practical unless
          retention is required for a legal reason.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-white">Contact</h2>
        <p className="mt-3">
          {controllerName} — {contactEmail}
        </p>
      </section>
    </LegalShell>
  );
}
