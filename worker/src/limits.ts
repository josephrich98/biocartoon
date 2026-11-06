// Keep in sync with biocartoon-app: app/src/submit.rs and data/uploads.py.
/** One image (an icon, or a template's picture), as PNG or SVG. */
export const MAX_PNG_BYTES = 2 * 1024 * 1024;
export const MAX_SVG_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGE_SIDE = 4096;
export const MAX_TEMPLATE_JSON_BYTES = 1024 * 1024;
export const MAX_TEMPLATE_ITEMS = 300;
export const MAX_TEMPLATE_IMAGES = 24;
/** Tags on one submission, and characters in one tag. */
export const MAX_TAGS = 20;
export const MAX_TAG_CHARS = 40;
/** Named colour layers on one SVG asset, characters in a layer's name, and colours in one layer. */
export const MAX_LAYERS = 8;
export const MAX_LAYER_NAME_CHARS = 40;
export const MAX_LAYER_COLORS = 16;
/** Whole request (a template with its images). */
export const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
/** Submissions per IP address per rolling day. */
export const MAX_PER_IP_PER_DAY = 20;
/** Submissions per IP address per rolling day with an upload key, master or shared (also past MAX_PENDING). */
export const MAX_PER_IP_PER_DAY_WITH_KEY = 9999;
/** Suggestions per IP address per rolling day. */
export const MAX_SUGGESTIONS_PER_IP_PER_DAY = 20;
/** Removal requests per IP address per rolling day. */
export const MAX_REMOVALS_PER_IP_PER_DAY = 20;
/** New removal requests are refused while this many are open. */
export const MAX_OPEN_REMOVALS = 2000;
/** New suggestions are refused while this many are open. */
export const MAX_OPEN_SUGGESTIONS = 2000;
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
/** One item of Your library online (an icon with its PNG and SVG, a template with its picture). */
export const MAX_CLOUD_LIBRARY_ITEM_BYTES = 8 * 1024 * 1024;
export const MAX_CLOUD_LIBRARY_ITEMS = 5000;
/** New accounts per IP address per rolling day. */
export const MAX_SIGNUPS_PER_IP_PER_DAY = 10;
/** A session unused for this long ends; the online projects stay. */
export const SESSION_IDLE_DAYS = 180;
// Share links (src/shares.ts). Keep in sync with biocartoon-app: app/src/share.rs.
/** One version of a shared project, encrypted (its images included). */
export const MAX_SHARE_BYTES = 32 * 1024 * 1024;
/** Versions of a shared project kept online, the latest included. */
export const MAX_SHARE_VERSIONS = 5;
/** A share link nobody has opened, checked or saved to for this long expires and is deleted. */
export const SHARE_IDLE_DAYS = 90;
/** New share links per IP address per rolling day. */
export const MAX_NEW_SHARES_PER_IP_PER_DAY = 30;
/** Share links alive at once, and their latest versions' total size: for a guest (by IP address)... */
export const MAX_ACTIVE_SHARES_GUEST = 50;
export const MAX_ACTIVE_SHARE_BYTES_GUEST = 500 * 1024 * 1024;
/** ...and for a signed-in account. */
export const MAX_ACTIVE_SHARES_USER = 200;
export const MAX_ACTIVE_SHARE_BYTES_USER = 2 * 1024 * 1024 * 1024;
