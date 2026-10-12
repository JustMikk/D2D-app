import { describe, expect, it } from "vitest";
import { userActor } from "@/lib/api/audit";
import { findStoredResponse, storeResponse } from "@/lib/api/idempotency";
import { db } from "@/lib/db";
import { getSettings, updateSettings } from "@/lib/settings";
import { createUser } from "./helpers";

describe("settings", () => {
  it("returns defaults, stores validated changes and audits before and after", async () => {
    const admin = await createUser("ADMIN");
    expect((await getSettings())["assignment.maxDriveMinutes"]).toBe(120);

    const updated = await updateSettings(userActor(admin.id), { "assignment.maxDriveMinutes": 90, "routing.provider": "GOOGLE" });
    expect(updated["assignment.maxDriveMinutes"]).toBe(90);
    expect(updated["routing.provider"]).toBe("GOOGLE");
    // The cache was cleared, so a fresh read sees the change.
    expect((await getSettings())["assignment.maxDriveMinutes"]).toBe(90);

    const row = await db().appSetting.findUniqueOrThrow({ where: { key: "assignment.maxDriveMinutes" } });
    expect(row).toMatchObject({ value: "90", updatedById: admin.id });
    const log = await db().auditLog.findFirstOrThrow({ where: { action: "settings.updated" } });
    expect(JSON.parse(log.data!)).toEqual({
      "assignment.maxDriveMinutes": { before: 120, after: 90 },
      "routing.provider": { before: "LOCAL", after: "GOOGLE" },
    });
  });

  it("rejects the whole patch when any key is invalid", async () => {
    const admin = await createUser("ADMIN");
    await expect(updateSettings(userActor(admin.id), { "assignment.shortlistSize": 3, "assignment.cutoffLocalTime": "noon" })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: [{ path: "assignment.cutoffLocalTime" }],
    });
    expect(await db().appSetting.count({ where: { key: "assignment.shortlistSize" } })).toBe(0);
  });
});

describe("idempotency keys", () => {
  it("stores a response and replays it for 24 hours", async () => {
    const user = await createUser("MANAGER");
    expect(await findStoredResponse(user.id, "k1")).toBeNull();
    await storeResponse(user.id, "k1", "POST", "/api/v1/invites", { status: 201, body: { ok: 1 } });
    expect(await findStoredResponse(user.id, "k1")).toEqual({ status: 201, body: { ok: 1 } });
    expect(await findStoredResponse(user.id, "k1", new Date(Date.now() + 25 * 3600_000))).toBeNull();
  });
});
