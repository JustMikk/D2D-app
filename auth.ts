// Auth.js v5: email + password (Credentials) with JWT sessions (PRD D-1, backend spec §11).
// The JWT carries the user's tokenVersion and a role-based expiry; lib/auth/session.ts checks both
// against the database on every request.
import NextAuth, { CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { clientIp } from "@/lib/api/rateLimit";
import { sessionDays } from "@/lib/auth/permissions";
import type { Role } from "@/lib/domain/enums";
import { verifyCredentials } from "@/lib/services/auth";

declare module "next-auth" {
  interface User {
    role: Role;
    tokenVersion: number;
  }
  interface Session {
    tokenVersion: number;
    roleExpiresAt: number;
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    role?: Role;
    tv?: number;
    roleExp?: number;
  }
}

class LockedError extends CredentialsSignin {
  override code = "locked";
}

class RateLimitedError extends CredentialsSignin {
  override code = "rate_limited";
}

const DAY_MS = 24 * 3600_000;

export const { handlers, auth, signIn, signOut } = NextAuth({
  // Self-hosted behind our own domain (PRD D-4).
  trustHost: true,
  session: { strategy: "jwt", maxAge: 30 * 24 * 3600 },
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      credentials: { email: { type: "email" }, password: { type: "password" } },
      async authorize(credentials, request) {
        const result = await verifyCredentials(String(credentials?.email ?? ""), String(credentials?.password ?? ""), clientIp(request.headers));
        if (result.kind === "locked") throw new LockedError();
        if (result.kind === "rate_limited") throw new RateLimitedError();
        if (result.kind !== "ok") return null;
        return result.user;
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user?.id) {
        token.sub = user.id;
        token.role = user.role;
        token.tv = user.tokenVersion;
        token.roleExp = Date.now() + sessionDays(user.role) * DAY_MS;
      }
      return token;
    },
    session({ session, token }) {
      if (token.sub) session.user.id = token.sub;
      session.tokenVersion = token.tv ?? -1;
      session.roleExpiresAt = token.roleExp ?? 0;
      return session;
    },
  },
});
