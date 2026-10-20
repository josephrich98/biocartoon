// Keep in sync with biocartoon-app: app/src/submit.rs and data/uploads.py.
export const MAX_PNG_BYTES = 8 * 1024 * 1024;
export const MAX_SVG_BYTES = 4 * 1024 * 1024;
export const MAX_IMAGE_SIDE = 4096;
export const MAX_TEMPLATE_JSON_BYTES = 1024 * 1024;
export const MAX_TEMPLATE_ITEMS = 300;
export const MAX_TEMPLATE_IMAGES = 24;
/** Whole request (a template with its images). */
export const MAX_REQUEST_BYTES = 48 * 1024 * 1024;
/** Submissions per IP address per rolling day. */
export const MAX_PER_IP_PER_DAY = 20;
/** New submissions are refused while this many await review. */
export const MAX_PENDING = 1000;
export const LICENSES = ["CC0-1.0", "CC-BY-4.0"] as const;
export const LICENSE_URLS: Record<string, string> = { "CC-BY-4.0": "https://creativecommons.org/licenses/by/4.0/" };
/** New (asset, client) stars per IP address per rolling day; re-starring something is free. */
export const MAX_STARS_PER_IP_PER_DAY = 300;
/** Most ids one `GET /stars` may ask about (a screen of results). */
export const MAX_STAR_IDS = 300;
// Accounts (src/accounts.ts). Keep in sync with biocartoon-app: app/src/account.rs.
/** One project's .biocartoon file (images included). */
export const MAX_CLOUD_PROJECT_BYTES = 32 * 1024 * 1024;
/** Online space per account. */
export const MAX_CLOUD_USER_BYTES = 500 * 1024 * 1024;
export const MAX_CLOUD_PROJECTS = 1000;
/** New accounts per IP address per rolling day. */
export const MAX_SIGNUPS_PER_IP_PER_DAY = 10;
/** A session unused for this long ends; the online projects stay. */
export const SESSION_IDLE_DAYS = 180;
