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

export interface LegalConfig {
  /** Data controller: the person or company operating this instance. */
  controllerName: string;
  /** Monitored address where rights requests arrive. */
  contactEmail: string;
  /** Country where the server storing the data is located. */
  dataLocation: string;
  /** Date this text last changed, absolute. */
  updatedAt: string;
}

export function getLegalConfig(): LegalConfig {
  return {
    controllerName: fromEnv("LEGAL_CONTROLLER_NAME"),
    contactEmail: fromEnv("LEGAL_CONTACT_EMAIL"),
    dataLocation: fromEnv("LEGAL_DATA_LOCATION"),
    updatedAt: "September 14, 2026",
  };
}
