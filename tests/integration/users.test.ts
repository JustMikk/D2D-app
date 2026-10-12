import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { acknowledgeMonitoring, getMe, listUsers, updatePreferences, updateUser } from "@/lib/services/users";
import { createUser } from "./helpers";

describe("users", () => {
  it("deactivating a user bumps tokenVersion and deactivates the rep profile", async () => {
    const admin = await createUser("ADMIN");
    const rep = await createUser("REP");
    expect(await updateUser(admin.id, rep.id, { active: false })).toEqual({ id: rep.id, role: "REP", active: false });
    const after = await db().user.findUniqueOrThrow({ where: { id: rep.id }, include: { rep: true } });
    expect(after.tokenVersion).toBe(1);
    expect(after.rep?.active).toBe(false);

    await updateUser(admin.id, rep.id, { active: true });
    const back = await db().user.findUniqueOrThrow({ where: { id: rep.id }, include: { rep: true } });
    expect(back.tokenVersion).toBe(2);
    expect(back.rep?.active).toBe(true);

    const audits = await db().auditLog.findMany({ where: { action: "user.updated", entityId: rep.id } });
    expect(JSON.parse(audits[0]!.data!)).toEqual({ before: { role: "REP", active: true }, after: { role: "REP", active: false } });
  });

  it("does not bump tokenVersion when nothing changes", async () => {
    const admin = await createUser("ADMIN");
    const viewer = await createUser("VIEWER");
    await updateUser(admin.id, viewer.id, { active: true, role: "VIEWER" });
    expect((await db().user.findUniqueOrThrow({ where: { id: viewer.id } })).tokenVersion).toBe(0);
  });

  it("keeps at least one active admin", async () => {
    const admin = await createUser("ADMIN");
    // Admins created by earlier tests in this file would otherwise count.
    await db().user.updateMany({ where: { role: "ADMIN", id: { not: admin.id } }, data: { active: false } });
    await expect(updateUser(admin.id, admin.id, { active: false })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(updateUser(admin.id, admin.id, { role: "MANAGER" })).rejects.toMatchObject({ code: "CONFLICT" });
    const second = await createUser("ADMIN");
    await expect(updateUser(second.id, admin.id, { role: "MANAGER" })).resolves.toMatchObject({ role: "MANAGER" });
  });

  it("does not turn reps into console users or back", async () => {
    const admin = await createUser("ADMIN");
    const rep = await createUser("REP");
    const manager = await createUser("MANAGER");
    await expect(updateUser(admin.id, rep.id, { role: "MANAGER" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(updateUser(admin.id, manager.id, { role: "REP" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(updateUser(admin.id, manager.id, { role: "VIEWER" })).resolves.toMatchObject({ role: "VIEWER" });
    await expect(updateUser(admin.id, "missing", { active: false })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("merges preferences and records the monitoring acknowledgment", async () => {
    const rep = await createUser("REP");
    expect(await updatePreferences(rep.id, { theme: "dusk" })).toEqual({ theme: "dusk" });
    expect(await updatePreferences(rep.id, { mapsApp: "google" })).toEqual({ theme: "dusk", mapsApp: "google" });
    await expect(updatePreferences(rep.id, { theme: "neon" })).rejects.toThrow();

    const ack = await acknowledgeMonitoring(rep.id);
    expect(ack.monitoringAckAt).toBeInstanceOf(Date);

    const me = await getMe(rep.id);
    expect(me.user).toMatchObject({ role: "REP", preferences: { theme: "dusk", mapsApp: "google" } });
    expect(me.rep).toMatchObject({ timeZone: "America/Chicago", workdays: ["MON", "TUE", "WED", "THU", "FRI", "SAT"], dayStartLocal: "09:00" });
    expect(me.client).toMatchObject({ foregroundPingSeconds: 120, arrivalRadiusMeters: 200 });
  });

  it("lists active users first", async () => {
    await createUser("VIEWER", { active: false });
    await createUser("MANAGER");
    const users = await listUsers();
    expect(users.map((u) => u.active)).toEqual([...users.map((u) => u.active)].sort((a, b) => Number(b) - Number(a)));
  });
});
