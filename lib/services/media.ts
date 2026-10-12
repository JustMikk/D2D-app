// Media upload and access (backend spec §9.5, §10.2): a rep uploads before saving the visit (works offline,
// because the app queues it); the visit then attaches the IDs.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { conflict, forbidden, notFound, validationFailed } from "@/lib/api/errors";
import { db } from "@/lib/db";
import { MediaKind } from "@/lib/domain/enums";
import { checkUpload, mediaStorage, UploadError } from "@/lib/integrations/storage";

export const MediaUploadFields = z.object({ clientId: z.uuid("clientId must be a UUID"), kind: MediaKind });

/** Idempotent on clientId: a retried upload returns the original media ID. */
export async function uploadMedia(userId: string, fields: unknown, bytes: Uint8Array, now = new Date()) {
  const { clientId, kind } = MediaUploadFields.parse(fields);
  const existing = await db().media.findUnique({ where: { clientId } });
  if (existing) {
    if (existing.uploadedById !== userId) throw forbidden();
    return { mediaId: existing.id };
  }
  let type;
  try {
    type = checkUpload(bytes);
  } catch (error) {
    if (error instanceof UploadError) throw validationFailed([{ path: "file", message: error.message }], error.message);
    throw error;
  }
  const id = randomUUID();
  const stored = await mediaStorage().put(id, bytes, type, now);
  try {
    await db().media.create({ data: { id, clientId, uploadedById: userId, kind, path: stored.path, mimeType: stored.mimeType, sizeBytes: stored.sizeBytes, sha256: stored.sha256, createdAt: now } });
  } catch (error) {
    // Two uploads with the same clientId raced: the other one won.
    const winner = await db().media.findUnique({ where: { clientId } });
    if (winner && winner.uploadedById === userId) return { mediaId: winner.id };
    throw error;
  }
  return { mediaId: id };
}

export type MediaAccess = { userId: string; role: string } | { signed: true };

/** The file for a media ID. Uploader and console roles may read; a valid signed URL is checked by the route. */
export async function readMedia(mediaId: string, access: MediaAccess) {
  const media = await db().media.findUnique({ where: { id: mediaId } });
  if (!media) throw notFound("That file");
  if (!("signed" in access)) {
    const consoleRole = ["ADMIN", "MANAGER", "VIEWER"].includes(access.role);
    if (!consoleRole && media.uploadedById !== access.userId) throw notFound("That file"); // not 403, so IDs cannot be probed
  }
  let bytes: Buffer;
  try {
    bytes = await mediaStorage().get(media.path);
  } catch {
    throw conflict("The file is missing from storage.");
  }
  return { bytes, mimeType: media.mimeType };
}
