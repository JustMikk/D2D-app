// Environment validation (backend spec §12). Parsed lazily on first use so that tests and
// scripts that only need part of the environment (e.g. the seed) can validate just that part.
import { z } from "zod";

const secret = z.string().min(32, "must be at least 32 characters");

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().startsWith("file:", "must be a SQLite file: URL"),
  AUTH_SECRET: secret,
  APP_BASE_URL: z.url(),
  GOOGLE_MAPS_API_KEY: z.string().min(1),
  GOOGLE_CLOUD_PROJECT_ID: z.string().optional(),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),
  VAPID_PUBLIC_KEY: z.string().min(1),
  VAPID_PRIVATE_KEY: z.string().min(1),
  VAPID_SUBJECT: z.string().startsWith("mailto:"),
  OUTBOUND_WEBHOOK_SECRET: secret,
  MEDIA_SIGNING_SECRET: secret,
  UPLOAD_DIR: z.string().min(1),
  SEED_ADMIN_EMAIL: z.email().optional(),
  SEED_ADMIN_PASSWORD: z.string().min(10).optional(),
  NEXT_PUBLIC_MAP_STYLE_URL: z.url().optional(),
  WORKER_ID: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
}

/** Validate a subset of the environment and exit with a readable error if anything is missing. */
export function parseEnv<K extends keyof Env>(keys: readonly K[], source: NodeJS.ProcessEnv = process.env): Pick<Env, K> {
  // The mask only names the requested keys; the cast satisfies zod's per-key mask type.
  const mask = Object.fromEntries(keys.map((k) => [k, true])) as Record<keyof Env, true>;
  // An empty value in .env means "not set", so optional variables can be left blank.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ""));
  const result = envSchema.pick(mask).safeParse(cleaned);
  if (!result.success) {
    const message = `Invalid environment configuration:\n${formatIssues(result.error)}`;
    if (process.env.NODE_ENV === "test") throw new Error(message);
    console.error(message);
    process.exit(1);
  }
  return result.data as unknown as Pick<Env, K>;
}

let cached: Env | undefined;

/** The full validated environment, as the web and worker processes need it. */
export function env(): Env {
  cached ??= parseEnv(Object.keys(envSchema.shape) as (keyof Env)[]) as Env;
  return cached;
}
