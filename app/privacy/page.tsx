import type { Metadata } from "next";
import LegalShell from "@/components/legal-shell";
import { getLegalConfig } from "@/lib/legal-config";

// Read the controller identity per request instead of inlining it at build time.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Privacy Policy - OpenReply",
  description:
    "How this OpenReply instance handles Instagram account data, webhook payloads, and campaign information.",
  // Reachable by anyone who needs it, but kept out of search indexes.
  robots: { index: false, follow: false },
};

export default function PrivacyPage() {
  const { controllerName, contactEmail, dataLocation, updatedAt } =
    getLegalConfig();

  return (
    <LegalShell
      title="Privacy Policy"
      description="This OpenReply instance sends Meta-compliant private replies when people comment on the connected Instagram posts or reels."
      updatedAt={updatedAt}
    >
      <section>
        <h2 className="text-xl font-bold text-white">Who Is Responsible</h2>
        <p className="mt-3">
          {controllerName ? `The data controller for this instance is ${controllerName}. ` : ""}
          This instance is a private deployment, run by the operator of the
          connected Instagram professional accounts and reachable at the address
          below. It is not a hosted service offered to third parties, and it has
          no customers, subscriptions, or billing.
        </p>
        <p className="mt-3">
          For any question about your data, or to exercise the rights described
          below, write to {contactEmail}.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-white">Data We Collect</h2>
        <p className="mt-3">
          If you comment on one of the connected posts or send a direct message
          to one of the connected accounts, this instance processes your
          Instagram username and account identifier, the text of your comment or
          message, the replies sent to you, delivery logs, and — where tracked
          links are used in a campaign — the fact that a link was clicked.
        </p>
        <p className="mt-3">
          For the operator account itself, it stores an email address for
          authentication, the connected Instagram account identifiers, encrypted
          Instagram access tokens, campaign settings, and operational
          diagnostics.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-white">How We Use Data</h2>
        <p className="mt-3">
          This data is used to match comment keywords, send private replies
          through the official Meta APIs, prevent duplicate sends, troubleshoot
          failures, and protect the service. It is not sold, and it is not used
          to build advertising profiles.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-white">Instagram And Meta Data</h2>
        <p className="mt-3">
          OpenReply does not ask for Instagram passwords, scrape Instagram, or
          use browser automation. Instagram tokens are encrypted at rest and are
          used only to perform actions authorized by the connected business
          account.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-white">Where Data Is Stored</h2>
        <p className="mt-3">
          The application and its database run on a single private server
          operated by the controller, located in {dataLocation}. Meta is the
          source of the comments and the channel for the replies. Resend
          delivers the sign-in emails for the operator account. There are no
          other processors: this instance does not use Vercel, Railway, or any
          managed platform provider.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-white">Retention And Deletion</h2>
        <p className="mt-3">
          Comment and message records are kept only as long as they are needed
          to run and audit the automation. You can ask for your data to be
          deleted at any time — see the Data Deletion page linked from the
          footer, or write to {contactEmail}.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-white">Your Rights</h2>
        <p className="mt-3">
          You may request access to your data, its correction or deletion, a
          restriction of its processing, or object to the processing altogether.
          Write to {contactEmail} and the request will be answered. If you
          believe your request has not been handled properly, you can lodge a
          complaint with your national data protection authority — in Spain,
          the Agencia Española de Protección de Datos.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-white">Contact</h2>
        <p className="mt-3">
          {controllerName ? `${controllerName} — ` : ""}
          {contactEmail}
        </p>
      </section>
    </LegalShell>
  );
}
