// Route-handler wrapper (backend spec §10.1): authentication by session or API key, role checks,
// rate limits, zod body/query parsing, Idempotency-Key replay and the error envelope.
import { NextResponse, type NextRequest } from "next/server";
import type { z } from "zod";
import { sha256Hex } from "@/lib/auth/tokens";
import { getSessionUser, type SessionUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import type { Role } from "@/lib/domain/enums";
import { forbidden, toApiError, unauthenticated, ApiError, zodDetails, validationFailed } from "./errors";
import { findStoredResponse, storeResponse } from "./idempotency";
import { clientIp, LIMITS, rateLimiter, type Limit } from "./rateLimit";

export type Access =
  | { public: true }
  | { roles: readonly Role[] }
  /** Viewers may call GETs; mutations need the listed roles (backend spec §10.2, console). */
  | { roles: readonly Role[]; viewerReads: true }
  | { apiScope: string };

export type ApiKeyPrincipal = { id: string; name: string; scopes: string[] };

type Ctx<B, Q, P> = {
  req: NextRequest;
  params: P;
  body: B;
  query: Q;
  user: SessionUser | null;
  apiKey: ApiKeyPrincipal | null;
};

type Options<BS extends z.ZodType | undefined, QS extends z.ZodType | undefined> = {
  access: Access;
  body?: BS;
  query?: QS;
  limit?: Limit;
  /** Store and replay responses for a repeated Idempotency-Key header (console mutations). */
  idempotent?: boolean;
};

type Infer<S> = S extends z.ZodType ? z.infer<S> : undefined;

/** Return this from a handler to choose the status code. */
export function json(body: unknown, status = 200) {
  return { __json: true as const, body, status };
}
type JsonResult = ReturnType<typeof json>;

function isJsonResult(v: unknown): v is JsonResult {
  return typeof v === "object" && v !== null && "__json" in v;
}

async function apiKeyFrom(req: NextRequest): Promise<ApiKeyPrincipal | null> {
  const header = req.headers.get("authorization");
  const m = header?.match(/^Bearer\s+(cvs_[A-Za-z0-9_-]+)$/);
  if (!m) return null;
  const key = await db().apiKey.findUnique({ where: { keyHash: sha256Hex(m[1]!) } });
  if (!key || key.revokedAt) return null;
  await db().apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } });
  return { id: key.id, name: key.name, scopes: key.scopes.split(",").map((s) => s.trim()) };
}

async function authorize(req: NextRequest, access: Access) {
  if ("public" in access) return { user: null, apiKey: null };
  if ("apiScope" in access) {
    const apiKey = await apiKeyFrom(req);
    if (!apiKey) throw unauthenticated();
    if (!apiKey.scopes.includes(access.apiScope)) throw forbidden("This API key does not have the required scope.");
    return { user: null, apiKey };
  }
  const user = await getSessionUser();
  if (!user) throw unauthenticated();
  const isRead = req.method === "GET" || req.method === "HEAD";
  const allowed = access.roles.includes(user.role) || ("viewerReads" in access && isRead && user.role === "VIEWER");
  if (!allowed) throw forbidden();
  return { user, apiKey: null };
}

function parseWith<S extends z.ZodType>(schema: S, value: unknown, where: "body" | "query"): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw validationFailed(zodDetails(r.error), where === "query" ? "Some query parameters are invalid." : undefined);
  return r.data;
}

export function route<P extends Record<string, string> = Record<string, never>, BS extends z.ZodType | undefined = undefined, QS extends z.ZodType | undefined = undefined>(
  options: Options<BS, QS>,
  handler: (ctx: Ctx<Infer<BS>, Infer<QS>, P>) => Promise<unknown>,
) {
  return async (req: NextRequest, context: { params: Promise<P> }): Promise<Response> => {
    try {
      const { user, apiKey } = await authorize(req, options.access);

      const limitKey = apiKey ? `key:${apiKey.id}` : user ? `user:${user.id}` : `ip:${clientIp(req.headers)}`;
      if (!rateLimiter.take(`${req.nextUrl.pathname}|${limitKey}`, options.limit ?? LIMITS.default)) {
        throw new ApiError("RATE_LIMITED", "Too many requests. Wait a moment and try again.");
      }

      const idemKey = options.idempotent && user ? req.headers.get("idempotency-key") : null;
      if (idemKey && user) {
        const stored = await findStoredResponse(user.id, idemKey);
        if (stored) return NextResponse.json(stored.body, { status: stored.status });
      }

      let rawBody: unknown = undefined;
      if (options.body) {
        try {
          rawBody = await req.json();
        } catch {
          throw validationFailed([{ path: "(root)", message: "Send a JSON body" }]);
        }
      }
      const body = (options.body ? parseWith(options.body, rawBody, "body") : undefined) as Infer<BS>;
      const query = (options.query ? parseWith(options.query, Object.fromEntries(req.nextUrl.searchParams), "query") : undefined) as Infer<QS>;
      const params = (await context.params) ?? ({} as P);

      const result = await handler({ req, params, body, query, user, apiKey });
      if (result instanceof Response) return result;
      const { body: out, status } = isJsonResult(result) ? result : { body: result ?? { ok: true }, status: 200 };
      if (idemKey && user) await storeResponse(user.id, idemKey, req.method, req.nextUrl.pathname, { status, body: out });
      return NextResponse.json(out, { status });
    } catch (error) {
      const apiError = toApiError(error);
      if (apiError.code === "INTERNAL") console.error(`[api] ${req.method} ${req.nextUrl.pathname}`, error);
      return NextResponse.json(apiError.toJSON(), { status: apiError.status });
    }
  };
}
