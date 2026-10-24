export interface Env {
  DB: D1Database;
  /** Private: submissions waiting for review, under `<id>/`. */
  PENDING: R2Bucket;
  /** The public asset bucket (what the app reads and publish_catalog.py publishes from). */
  PUBLIC: R2Bucket;
  /** Private: signed-in users' online projects, under `users/<user id>/` (src/accounts.ts). */
  USERS: R2Bucket;
  /** OAuth apps for signing in (secrets: `wrangler secret put GOOGLE_CLIENT_SECRET` etc.). */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** Comma-separated origins the app is served from (default https://app.biocartoon.com). */
  APP_ORIGINS?: string;
  /** Optional secret salting the IP hashes. */
  IP_SALT?: string;
  /** Optional secret: a submission sending it as `X-Upload-Key` gets MAX_PER_IP_PER_DAY_WITH_KEY. */
  UPLOAD_KEY?: string;
  ACCESS_TEAM?: string;
  ACCESS_AUD?: string;
  /** Local `wrangler dev` only (.dev.vars): skip the Access check on the review Worker. */
  DEV_NO_AUTH?: string;
}
