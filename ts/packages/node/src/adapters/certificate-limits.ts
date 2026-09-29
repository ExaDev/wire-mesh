// Kept apart from pinned-certificate.ts so the CLI can validate a lifetime without loading the certificate library.

export const MILLISECONDS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const MILLISECONDS_PER_DAY =
  HOURS_PER_DAY *
  MINUTES_PER_HOUR *
  SECONDS_PER_MINUTE *
  MILLISECONDS_PER_SECOND;
const MAX_PINNED_CERTIFICATE_LIFETIME_DAYS = 14;
const CLOCK_SKEW_ALLOWANCE_DAYS = 1;
/**
 * The longest validity a certificate may have for a browser to accept it by hash: the WebTransport specification limits `serverCertificateHashes` certificates to under two weeks, and a browser refuses a longer one.
 * https://www.w3.org/TR/webtransport/#dom-webtransportoptions-servercertificatehashes
 */
export const MAX_PINNED_CERTIFICATE_LIFETIME_MS =
  MAX_PINNED_CERTIFICATE_LIFETIME_DAYS * MILLISECONDS_PER_DAY;

/** Slack under the maximum, so clock skew between the node and a browser cannot push the certificate over the limit. */
export const PINNED_CERTIFICATE_LIFETIME_MS =
  MAX_PINNED_CERTIFICATE_LIFETIME_MS -
  CLOCK_SKEW_ALLOWANCE_DAYS * MILLISECONDS_PER_DAY;
