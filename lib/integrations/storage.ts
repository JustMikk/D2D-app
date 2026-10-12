// Media storage (backend spec §9.5): files go to UPLOAD_DIR/{yyyy}/{mm}/{mediaId}.{ext}. JPEG, PNG or WebP
// only, at most 5 MB, and the type is read from the file's magic bytes, never from its name. The interface
// (put, get) allows a later switch to S3-compatible storage without changes elsewhere.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export type ImageType = { mime: "image/jpeg" | "image/png" | "image/webp"; ext: "jpg" | "png" | "webp" };

/** Identify an image from its first bytes. Anything else returns null. */
export function sniffImage(bytes: Uint8Array): ImageType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)) return { mime: "image/png", ext: "png" };
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.slice(from, to));
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return { mime: "image/webp", ext: "webp" };
  return null;
}

export type StoredFile = { path: string; mimeType: string; sizeBytes: number; sha256: string };

export interface MediaStorage {
  put(id: string, bytes: Uint8Array, type: ImageType, now?: Date): Promise<StoredFile>;
  get(path: string): Promise<Buffer>;
}

export class UploadError extends Error {
  constructor(
    readonly reason: "too_large" | "not_an_image" | "empty",
    message: string,
  ) {
    super(message);
  }
}

/** Check size and type; returns the detected type. Messages are written for the rep. */
export function checkUpload(bytes: Uint8Array): ImageType {
  if (bytes.length === 0) throw new UploadError("empty", "The photo is empty. Take it again.");
  if (bytes.length > MAX_UPLOAD_BYTES) throw new UploadError("too_large", "Photo is over 5 MB. Take a smaller one or skip it.");
  const type = sniffImage(bytes);
  if (!type) throw new UploadError("not_an_image", "Only JPEG, PNG or WebP photos can be uploaded.");
  return type;
}

export class LocalDiskStorage implements MediaStorage {
  constructor(private readonly root: string) {}

  async put(id: string, bytes: Uint8Array, type: ImageType, now = new Date()): Promise<StoredFile> {
    const path = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${id}.${type.ext}`;
    const full = this.fullPath(path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, bytes);
    return { path, mimeType: type.mime, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }

  async get(path: string): Promise<Buffer> {
    return readFile(this.fullPath(path));
  }

  /** Stored paths are relative; refuse anything that would escape the upload directory. */
  private fullPath(path: string): string {
    const root = resolve(this.root);
    const full = resolve(join(root, path));
    if (full !== root && !full.startsWith(root + sep)) throw new Error("Path escapes the upload directory");
    return full;
  }
}

let override: MediaStorage | null = null;
export function setMediaStorage(storage: MediaStorage | null): void {
  override = storage;
}

export function mediaStorage(): MediaStorage {
  if (override) return override;
  const dir = process.env.UPLOAD_DIR;
  if (!dir) throw new Error("UPLOAD_DIR is not set");
  return new LocalDiskStorage(dir);
}
