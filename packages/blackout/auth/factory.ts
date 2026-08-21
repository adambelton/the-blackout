import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

/**
 * Factory that creates a Better Auth instance from shared config.
 *
 * Both the web (`apps/blackout/client`) and the Blackout server (`apps/blackout/server`)
 * instantiate Better Auth from this factory so they agree on:
 *   - Cookie signing secret → sessions issued by one validate on the other
 *   - Table model names → both talk to the same `users` / `sessions` /
 *     `accounts` / `verifications` tables in the shared Postgres
 *   - Role field schema → `user.role` is visible on both sides
 *   - Cookie domain → the browser sends the session cookie to both
 *     sibling application and API hosts in a configured environment
 *
 * The web passes the admin-email database hook because user creation is a
 * web-only event; the server only needs to validate sessions.
 */

export interface CreateAuthOptions {
  /** Drizzle client. Must have the auth tables (users, sessions,
   * accounts, verifications) in its schema so Better Auth's drizzle
   * adapter can query them. */
  db: Parameters<typeof drizzleAdapter>[0];
  /** Cookie signing secret — identical on every caller for
   * cross-instance cookie validation. Required. */
  secret: string;
  /** Public URL of the Better Auth server surface (web's
   * `/api/auth/[...all]`). Used in redirect URLs and cookie origin. */
  baseURL: string;
  /** Set to a leading-dot parent domain to scope
   * the session cookie to every subdomain. Leave undefined in local
   * dev — Better Auth defaults to host-only cookies which work fine
   * on localhost. */
  cookieDomain?: string;
  /** Set of trusted origins the auth server will accept requests
   * from. In prod this is the web + api subdomains; in dev it's
   * http://localhost:3000 + http://localhost:4000. */
  trustedOrigins?: string[];
  /** Present on the web side only. Stamps `role: "admin"` onto the
   * user row when the email matches this value on first sign-in. */
  adminEmail?: string;
}

export function createAuth(options: CreateAuthOptions) {
  const adminEmail = options.adminEmail?.toLowerCase().trim();

  return betterAuth({
    secret: options.secret,
    baseURL: options.baseURL,
    ...(options.trustedOrigins ? { trustedOrigins: options.trustedOrigins } : {}),
    database: drizzleAdapter(options.db, { provider: "pg" }),
    ...(options.cookieDomain
      ? {
          advanced: {
            crossSubDomainCookies: {
              enabled: true,
              domain: options.cookieDomain,
            },
          },
        }
      : {}),
    // Accounts are provisioned explicitly; there is no public sign-up UI.
    emailAndPassword: { enabled: true },
    user: {
      modelName: "users",
      additionalFields: {
        role: {
          type: "string",
          required: false,
          defaultValue: null,
          input: false,
        },
      },
    },
    session: { modelName: "sessions" },
    account: { modelName: "accounts" },
    verification: { modelName: "verifications" },
    databaseHooks: adminEmail
      ? {
          user: {
            create: {
              before: async (user) => {
                const role =
                  user.email?.toLowerCase() === adminEmail ? "admin" : null;
                return { data: { ...user, role } };
              },
            },
          },
        }
      : undefined,
  });
}
