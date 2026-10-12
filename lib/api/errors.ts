// API error envelope (backend spec §10.1).
import { z } from "zod";

export const ERROR_CODES = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 400,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;
export type ErrorDetail = { path: string; message: string };

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: ErrorDetail[],
  ) {
    super(message);
    this.name = "ApiError";
  }

  get status(): number {
    return ERROR_CODES[this.code];
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) } };
  }
}

export const unauthenticated = () => new ApiError("UNAUTHENTICATED", "Sign in to continue.");
export const forbidden = (message = "You don't have access to this.") => new ApiError("FORBIDDEN", message);
export const notFound = (what = "That record") => new ApiError("NOT_FOUND", `${what} was not found.`);
export const conflict = (message: string) => new ApiError("CONFLICT", message);
export const validationFailed = (details: ErrorDetail[], message = "Some fields need attention.") =>
  new ApiError("VALIDATION_FAILED", message, details);

export function zodDetails(error: z.ZodError): ErrorDetail[] {
  return error.issues.map((i) => ({ path: i.path.join(".") || "(root)", message: i.message }));
}

/** Map anything thrown in a handler to an ApiError. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof z.ZodError) return validationFailed(zodDetails(error));
  return new ApiError("INTERNAL", "Something went wrong on our side. Try again in a minute.");
}
