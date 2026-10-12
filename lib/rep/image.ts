"use client";
// Photos are shrunk on the phone before they are queued (PRD REP-6): at most 1600 px on the long side, JPEG.
// A 12-megapixel photo becomes a few hundred kilobytes, which matters on a weak connection.
import { fitWithin } from "./helpers";

export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

export async function compressImage(file: Blob, maxDimension = 1600, quality = 0.82): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height, maxDimension);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This phone can't process photos.");
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (!blob) throw new Error("This photo couldn't be processed.");
    return blob;
  } finally {
    bitmap.close();
  }
}
