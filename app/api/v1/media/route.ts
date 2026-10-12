import { json, route } from "@/lib/api/route";
import { validationFailed } from "@/lib/api/errors";
import { REP_ROLES } from "@/lib/auth/permissions";
import { MAX_UPLOAD_BYTES } from "@/lib/integrations/storage";
import { uploadMedia } from "@/lib/services/media";

// POST /api/v1/media: multipart { file, clientId, kind }. Reps upload before saving a visit.
export const POST = route({ access: { roles: REP_ROLES } }, async ({ req, user }) => {
  // Refuse oversized bodies before reading them (the multipart envelope adds a little to the file).
  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > MAX_UPLOAD_BYTES + 64 * 1024) throw validationFailed([{ path: "file", message: "Photo is over 5 MB. Take a smaller one or skip it." }], "Photo is over 5 MB. Take a smaller one or skip it.");
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw validationFailed([{ path: "file", message: "Send the photo as multipart form data" }]);
  }
  const file = form.get("file");
  if (!(file instanceof File)) throw validationFailed([{ path: "file", message: "Add a file" }]);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const result = await uploadMedia(user!.id, { clientId: form.get("clientId"), kind: form.get("kind") }, bytes);
  return json(result, 201);
});
