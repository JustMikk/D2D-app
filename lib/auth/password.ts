// Password policy and hashing (backend spec §11): argon2id, at least 10 characters,
// checked against a list of common passwords.
import { hash, verify } from "@node-rs/argon2";

export const MIN_PASSWORD_LENGTH = 10;

// Common passwords that meet the length rule. Shorter ones already fail on length.
const COMMON = new Set([
  "1234567890", "12345678910", "123456789a", "0987654321", "1111111111", "0000000000", "1q2w3e4r5t",
  "1qaz2wsx3edc", "qwertyuiop", "qwerty1234", "qwerty12345", "qwertyuiop123", "asdfghjkl1", "zxcvbnm123",
  "password12", "password123", "password1234", "password!1", "passw0rd12", "p@ssword123", "p@ssw0rd123",
  "iloveyou12", "iloveyou123", "letmein123", "welcome123", "welcome1234", "admin12345", "administrator",
  "changeme123", "changeme!1", "football12", "baseball12", "basketball", "sunshine12", "princess12",
  "dragon1234", "monkey1234", "starwars12", "superman12", "trustno1234", "abc1234567", "abcdefghij",
  "abcd123456", "a1b2c3d4e5", "mypassword", "mypassword1", "secret1234", "canvass123", "canvass2026",
  "doortodoor", "summer2026", "winter2026", "spring2026", "autumn2026", "fall2026!!", "company123",
  "computer12", "internet12", "whatever12", "michael123", "jennifer12", "charlie123", "liverpool1",
]);

export type PasswordProblem = "too_short" | "too_common" | "matches_email";

export function passwordProblem(password: string, email?: string): PasswordProblem | null {
  if (password.length < MIN_PASSWORD_LENGTH) return "too_short";
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) return "too_common";
  if (email && lower === email.toLowerCase()) return "matches_email";
  return null;
}

export const PASSWORD_MESSAGES: Record<PasswordProblem, string> = {
  too_short: `Use at least ${MIN_PASSWORD_LENGTH} characters.`,
  too_common: "That password is too common. Pick something harder to guess.",
  matches_email: "Don't use your email address as your password.",
};

export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

// A real argon2id hash of a random string, verified against for unknown users so a failed
// login takes the same time whether or not the account exists.
let dummyHash: Promise<string> | undefined;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hash(crypto.randomUUID());
  await verifyPassword(await dummyHash, password);
}
