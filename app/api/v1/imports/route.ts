import { json, route } from "@/lib/api/route";
import { validationFailed } from "@/lib/api/errors";
import { ADMIN_ROLES } from "@/lib/auth/permissions";
import { MAX_IMPORT_BYTES } from "@/lib/domain/importFile";
import { listImports, previewImport } from "@/lib/services/imports";

// GET /api/v1/imports (history) and POST /api/v1/imports (multipart `file`; returns the preview): Admin.
export const GET = route({ access: { roles: ADMIN_ROLES } }, async () => ({ items: await listImports() }));

export const POST = route({ access: { roles: ADMIN_ROLES } }, async ({ req, user }) => {
  // A body with no declared length cannot be size-checked before it is read.
  const length = Number(req.headers.get("content-length") ?? NaN);
  if (!Number.isFinite(length)) throw validationFailed([{ path: "file", message: "Upload the file as a normal form submission" }]);
  if (length > MAX_IMPORT_BYTES + 64 * 1024) throw validationFailed([{ path: "file", message: "The file is over 5 MB." }], "The file is over 5 MB.");
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw validationFailed([{ path: "file", message: "Send the file as multipart form data" }]);
  }
  const file = form.get("file");
  if (!(file instanceof File)) throw validationFailed([{ path: "file", message: "Choose a file" }]);
  return json(await previewImport(user!.id, file.name || "import", await file.text()), 201);
});
