/**
 * Deployment-specific identity shown on the legal pages.
 *
 * This deployment is a single-operator instance, not the hosted SaaS the
 * upstream pages describe. The values below identify the data controller and
 * differ per deployment, so they are supplied as environment variables rather
 * than committed to the repository.
 *
 * The legal routes opt out of static rendering (`force-dynamic`) so these are
 * read per request. Without that, Next.js would inline whatever was present in
 * the build environment.
 */

const NOT_CONFIGURED = "[NOT CONFIGURED]";

function fromEnv(name: string): string {
  const value = process.env[name]?.trim();
  return value ? value : NOT_CONFIGURED;
}

function optionalFromEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

export interface LegalConfig {
  /**
   * Data controller, when the operator chooses to publish a name.
   *
   * Optional: leaving it unset drops the named-controller sentence and leaves
   * the contact address as the route to the operator. Setting it later needs
   * only an environment change, since these routes render per request.
   */
  controllerName: string | null;
  /** Monitored address where rights requests arrive. */
  contactEmail: string;
  /** Country where the server storing the data is located. */
  dataLocation: string;
  /** Date this text last changed, absolute. */
  updatedAt: string;
}

export function getLegalConfig(): LegalConfig {
  return {
    controllerName: optionalFromEnv("LEGAL_CONTROLLER_NAME"),
    contactEmail: fromEnv("LEGAL_CONTACT_EMAIL"),
    dataLocation: fromEnv("LEGAL_DATA_LOCATION"),
    updatedAt: "September 14, 2026",
  };
}
