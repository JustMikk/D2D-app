import "fake-indexeddb/auto";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fitWithin, formatDistance, navigateUrl, nextStepIso } from "@/lib/rep/helpers";
import { Outbox, type NewItem } from "@/lib/rep/outbox";
import { applyOutbox, onShift, sections, summarize } from "@/lib/rep/overlay";
import { flush, mediaCacheKey } from "@/lib/rep/sync";
import type { TodayResponse } from "@/lib/services/repApp";

const T = "2026-10-07T15:00:00.000Z";
const fix = { lat: 32.78, lng: -96.8, capturedAt: T };
const uid = () => randomUUID();

function newBox() {
  return new Outbox(`test-${uid()}`);
}

const start = (): NewItem => ({ kind: "shift.start", payload: { clientId: uid(), location: fix, recordedAt: T } });
const arrive = (assignmentId: string): NewItem => ({ kind: "arrive", payload: { clientId: uid(), assignmentId, location: fix, recordedAt: T } });
const ping = (): NewItem => ({ kind: "ping", payload: { clientId: uid(), source: "FOREGROUND", ...fix } });
const skip = (assignmentId: string): NewItem => ({ kind: "skip", payload: { clientId: uid(), assignmentId, reason: "UNSAFE", note: "Dog", recordedAt: T } });
const event = (name: "rep.visit_form_opened" | "rep.navigate_tapped" = "rep.navigate_tapped"): NewItem => ({ kind: "event", payload: { clientId: uid(), name, at: T, data: { app: "google" } } });
const visit = (assignmentId: string, extra: Partial<Extract<NewItem, { kind: "visit" }>["payload"]> = {}): NewItem => ({
  kind: "visit",
  payload: { clientId: uid(), assignmentId, doorId: `door-${assignmentId}`, outcome: "NOT_HOME", notes: "", recordedAt: T, location: fix, ...extra },
});

/** A server stand-in: records each request and answers from a script. */
function fakeServer(answer: (url: string, body: unknown, index: number) => Response | Error = () => new Response(JSON.stringify({ ok: true }), { status: 200 })) {
  const calls: { url: string; body: unknown }[] = [];
  const doFetch = (async (url: string, init?: RequestInit) => {
    let body: unknown = init?.body;
    if (typeof body === "string") body = JSON.parse(body);
    else if (body instanceof FormData) body = { clientId: body.get("clientId"), kind: body.get("kind"), hasFile: body.get("file") instanceof Blob };
    calls.push({ url, body });
    const r = answer(url, body, calls.length - 1);
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;
  return { calls, doFetch };
}
const ok = (body: unknown = {}) => new Response(JSON.stringify(body), { status: 200 });
const err = (status: number, message = "nope") => new Response(JSON.stringify({ error: { code: "X", message } }), { status });

describe("outbox", () => {
  it("keeps items in arrival order and queues files with the items that need them, atomically", async () => {
    const box = newBox();
    await box.add([start(), ping()]);
    const clientId = uid();
    await box.add([{ kind: "media", payload: { clientId, kind: "PHOTO" } }, visit("a1", { photoClientIds: [clientId] })], [{ id: clientId, blob: new Blob(["jpg"]) }]);
    const items = await box.list();
    expect(items.map((i) => i.kind)).toEqual(["shift.start", "ping", "media", "visit"]);
    expect(items.map((i) => i.seq)).toEqual([...items.map((i) => i.seq)].sort((a, b) => a - b));
    expect(items.every((i) => i.status === "pending" && i.attempts === 0)).toBe(true);
    expect(await (await box.getBlob(clientId))!.text()).toBe("jpg");
  });

  it("survives a reload: a new instance over the same database sees the queue", async () => {
    const name = `test-${uid()}`;
    const a = new Outbox(name);
    await a.add([start(), visit("a1")]);
    await a.close();
    const b = new Outbox(name);
    expect((await b.list()).map((i) => i.kind)).toEqual(["shift.start", "visit"]);
  });

  it("counts tries, marks refused items failed and lets the rep retry them", async () => {
    const box = newBox();
    await box.add([visit("a1"), visit("a2")]);
    const [first, second] = await box.list();
    await box.bump(first!.seq, "HTTP 503");
    await box.fail(second!.seq, "Pick a future date");
    expect(await box.list()).toMatchObject([{ attempts: 1, status: "pending", lastError: "HTTP 503" }, { attempts: 1, status: "failed", lastError: "Pick a future date" }]);
    expect(await box.retryFailed()).toBe(1);
    expect((await box.list())[1]).toMatchObject({ status: "pending", lastError: null });
  });

  it("notifies subscribers of changes", async () => {
    const box = newBox();
    let n = 0;
    const off = box.subscribe(() => n++);
    await box.add([ping()]);
    await box.remove((await box.list())[0]!.seq);
    off();
    await box.add([ping()]);
    expect(n).toBe(2);
  });
});

describe("flush", () => {
  it("sends everything in order, resolving media IDs into the visit, and empties the queue", async () => {
    const box = newBox();
    const photo = uid();
    const sig = uid();
    await box.add([start(), arrive("a1"), ping()]);
    await box.add(
      [
        { kind: "media", payload: { clientId: photo, kind: "PHOTO" } },
        { kind: "media", payload: { clientId: sig, kind: "SIGNATURE" } },
        visit("a1", { outcome: "SOLD", photoClientIds: [photo], signatureClientId: sig }),
        { kind: "shift.end", payload: { clientId: uid(), location: fix, recordedAt: T } },
      ],
      [
        { id: photo, blob: new Blob(["p"]) },
        { id: sig, blob: new Blob(["s"]) },
      ],
    );
    const server = fakeServer((url, body) => (url === "/api/v1/media" ? ok({ mediaId: `m-${(body as { kind: string }).kind}` }) : ok()));
    const result = await flush(box, { fetch: server.doFetch });
    expect(result).toEqual({ sent: 7, failed: 0, remaining: 0, stopped: null });
    expect(server.calls.map((c) => c.url)).toEqual([
      "/api/v1/rep/shift/start",
      "/api/v1/rep/assignments/a1/arrive",
      "/api/v1/rep/locations",
      "/api/v1/media",
      "/api/v1/media",
      "/api/v1/rep/visits",
      "/api/v1/rep/shift/end",
    ]);
    const visitBody = server.calls[5]!.body as Record<string, unknown>;
    expect(visitBody).toMatchObject({ outcome: "SOLD", photoMediaIds: ["m-PHOTO"], signatureMediaId: "m-SIGNATURE" });
    expect(visitBody).not.toHaveProperty("photoClientIds");
    expect(await box.list()).toEqual([]);
    expect(await box.getBlob(photo)).toBeUndefined();
    expect(await box.getCache(mediaCacheKey(photo))).toBe("m-PHOTO");
  });

  it("while offline stops at once, loses nothing, and does not count the tries against the items", async () => {
    const box = newBox();
    await box.add([start(), visit("a1"), visit("a2")]);
    const down = fakeServer(() => new TypeError("Failed to fetch"));
    expect(await flush(box, { fetch: down.doFetch })).toEqual({ sent: 0, failed: 0, remaining: 3, stopped: "offline" });
    expect(down.calls).toHaveLength(1); // it did not hammer the dead connection
    expect((await box.list()).map((i) => i.attempts)).toEqual([0, 0, 0]);

    const up = fakeServer();
    expect(await flush(box, { fetch: up.doFetch })).toMatchObject({ sent: 3, remaining: 0, stopped: null });
  });

  it("removes an item only after it is acknowledged: a connection lost mid-way resumes where it stopped", async () => {
    const box = newBox();
    await box.add([visit("a1"), visit("a2"), visit("a3")]);
    const flaky = fakeServer((_u, _b, i) => (i === 1 ? new TypeError("Failed to fetch") : ok()));
    expect(await flush(box, { fetch: flaky.doFetch })).toMatchObject({ sent: 1, remaining: 2, stopped: "offline" });
    expect((await box.list()).map((i) => (i.payload as { assignmentId: string }).assignmentId)).toEqual(["a2", "a3"]);

    const second = fakeServer();
    await flush(box, { fetch: second.doFetch });
    expect(second.calls.map((c) => (c.body as { assignmentId: string }).assignmentId)).toEqual(["a2", "a3"]);
  });

  it("resends a lost acknowledgment with the same clientId, so the server can recognise it", async () => {
    const box = newBox();
    await box.add([visit("a1")]);
    const clientId = ((await box.list())[0]!.payload as { clientId: string }).clientId;
    // The server saved it, but the reply never reached the phone.
    const lostReply = fakeServer(() => new TypeError("Failed to fetch"));
    await flush(box, { fetch: lostReply.doFetch });
    const retry = fakeServer();
    await flush(box, { fetch: retry.doFetch });
    expect((lostReply.calls[0]!.body as { clientId: string }).clientId).toBe(clientId);
    expect((retry.calls[0]!.body as { clientId: string }).clientId).toBe(clientId);
  });

  it("on a server error keeps the item, counts the try and stops; on 401 stops and asks for sign-in", async () => {
    const box = newBox();
    await box.add([visit("a1"), visit("a2")]);
    expect(await flush(box, { fetch: fakeServer(() => err(503, "Busy")).doFetch })).toMatchObject({ sent: 0, remaining: 2, stopped: "server" });
    expect(await box.list()).toMatchObject([{ attempts: 1, lastError: "Busy" }, { attempts: 0 }]);
    expect(await flush(box, { fetch: fakeServer(() => err(429)).doFetch })).toMatchObject({ stopped: "server" });
    expect(await flush(box, { fetch: fakeServer(() => err(401, "Sign in")).doFetch })).toMatchObject({ remaining: 2, stopped: "auth" });
    expect(await box.list()).toHaveLength(2);
  });

  it("marks an item the server refuses for good as failed, and carries on with the rest", async () => {
    const box = newBox();
    await box.add([visit("a1"), visit("a2"), visit("a3")]);
    const server = fakeServer((_u, body) => ((body as { assignmentId: string }).assignmentId === "a2" ? err(400, "Pick a date in the future") : ok()));
    const result = await flush(box, { fetch: server.doFetch });
    expect(result).toEqual({ sent: 2, failed: 1, remaining: 0, stopped: null });
    expect(await box.list()).toMatchObject([{ status: "failed", lastError: "Pick a date in the future" }]);
    // A failed item is not sent again until the rep taps retry.
    const again = fakeServer();
    await flush(box, { fetch: again.doFetch });
    expect(again.calls).toHaveLength(0);
    await box.retryFailed();
    await flush(box, { fetch: again.doFetch });
    expect(again.calls).toHaveLength(1);
  });

  it("fails a visit whose photo never uploaded, without sending it", async () => {
    const box = newBox();
    const photo = uid();
    await box.add([{ kind: "media", payload: { clientId: photo, kind: "PHOTO" } }, visit("a1", { photoClientIds: [photo] })], [{ id: photo, blob: new Blob(["x"]) }]);
    const server = fakeServer((url) => (url === "/api/v1/media" ? err(400, "Photo is over 5 MB. Take a smaller one or skip it.") : ok()));
    const result = await flush(box, { fetch: server.doFetch });
    expect(result.failed).toBe(2);
    expect(server.calls.map((c) => c.url)).toEqual(["/api/v1/media"]);
    expect((await box.list()).map((i) => i.lastError)).toEqual(["Photo is over 5 MB. Take a smaller one or skip it.", "A photo or signature didn't upload, so this visit couldn't be sent."]);
  });

  it("sends location pings in batches of 100", async () => {
    const box = newBox();
    await box.add(Array.from({ length: 150 }, ping));
    const server = fakeServer();
    expect(await flush(box, { fetch: server.doFetch })).toMatchObject({ sent: 150, remaining: 0 });
    expect(server.calls.map((c) => (c.body as { pings: unknown[] }).pings.length)).toEqual([100, 50]);
  });

  it("tells the app about each acknowledged item before it leaves the queue", async () => {
    const box = newBox();
    await box.add([visit("a1")]);
    const order: string[] = [];
    await flush(box, {
      fetch: fakeServer().doFetch,
      onAck: async (item) => {
        order.push(`ack:${item.kind}:${(await box.list()).length}`);
      },
    });
    expect(order).toEqual(["ack:visit:1"]); // still queued while the app patches its cache
    expect(await box.list()).toEqual([]);
  });
});

describe("skip and analytics events", () => {
  it("sends a skip to the stop's own address, without the assignment ID in the body", async () => {
    const box = newBox();
    await box.add([skip("a7")]);
    const server = fakeServer();
    await flush(box, { fetch: server.doFetch });
    expect(server.calls[0]!.url).toBe("/api/v1/rep/assignments/a7/skip");
    expect(server.calls[0]!.body).toMatchObject({ reason: "UNSAFE", note: "Dog" });
    expect(server.calls[0]!.body).not.toHaveProperty("assignmentId");
  });

  it("batches analytics events (at most 50) and never lets a refusal reach the rep", async () => {
    const box = newBox();
    await box.add(Array.from({ length: 60 }, () => event()));
    const ok = fakeServer();
    await flush(box, { fetch: ok.doFetch });
    expect(ok.calls.map((c) => (c.body as { events: unknown[] }).events.length)).toEqual([50, 10]);

    await box.add([event(), event()]);
    const refused = fakeServer(() => err(400, "Unknown event"));
    expect(await flush(box, { fetch: refused.doFetch })).toMatchObject({ failed: 0, remaining: 0 });
    expect(await box.list()).toEqual([]); // dropped, not kept as failed
    expect(summarize([])).toMatchObject({ failed: 0 });
  });

  it("discards pings and events but keeps real work, for sign-out", async () => {
    const box = newBox();
    await box.add([ping(), event(), visit("a1"), skip("a2"), ping()]);
    expect(await box.discardKinds(["ping", "event"])).toBe(3);
    expect((await box.list()).map((i) => i.kind)).toEqual(["visit", "skip"]);
  });

  it("shows a skipped stop as skipped at once, in Done, and counts it as a change", async () => {
    const box = newBox();
    await box.add([skip("a2"), event(), ping()]);
    const items = await box.list();
    const today = {
      date: "2026-10-07", timeZone: "America/Chicago", shift: null, pendingServerVersion: "v", route: { planId: null, provider: null, totalDriveMinutes: null, plannedFinish: null, updatedAt: null },
      stops: ["a1", "a2"].map((id, i) => ({ assignmentId: id, status: "ACTIVE" as const, routeOrder: i + 1, plannedArrival: null, arrivedAt: null, outcome: null, door: { id: id, name: id, companyName: id, priority: "NORMAL" as const, address: "x", lat: 1, lng: 2, qualificationNotes: "", preferredVisitWindow: null, attempts: 0, contactName: null, lastVisit: null } })),
    };
    const merged = applyOutbox(today, items)!;
    expect(merged.stops.find((s) => s.assignmentId === "a2")?.status).toBe("SKIPPED");
    const s = sections(merged);
    expect(s.current?.assignmentId).toBe("a1");
    expect(s.done.map((x) => x.assignmentId)).toEqual(["a2"]);
    expect(summarize(items)).toMatchObject({ changes: 1, failed: 0 });
  });
});

describe("overlay", () => {
  const today = (): TodayResponse => ({
    date: "2026-10-07",
    timeZone: "America/Chicago",
    shift: null,
    route: { planId: "p", provider: "LOCAL", totalDriveMinutes: 30, plannedFinish: null, updatedAt: null },
    pendingServerVersion: "v1",
    stops: ["a1", "a2", "a3"].map((id, i) => ({
      assignmentId: id,
      status: "ACTIVE" as const,
      routeOrder: i + 1,
      plannedArrival: null,
      arrivedAt: null,
      outcome: null,
      door: { id: `d${id}`, name: id, companyName: id, priority: "NORMAL" as const, address: "1 Main St", lat: 1, lng: 2, qualificationNotes: "", preferredVisitWindow: null, attempts: 0, contactName: null, lastVisit: null },
    })),
  });
  const queue = async (...items: NewItem[]) => {
    const box = newBox();
    await box.add(items);
    return box.list();
  };

  it("shows a started day, an arrival and a saved visit before they sync", async () => {
    const merged = applyOutbox(today(), await queue(start(), arrive("a1"), visit("a1", { outcome: "FOLLOW_UP" })))!;
    expect(onShift(merged)).toBe(true);
    expect(merged.shift).toMatchObject({ startedAt: T, endedAt: null });
    expect(merged.stops.find((s) => s.assignmentId === "a1")).toMatchObject({ status: "COMPLETED", outcome: "FOLLOW_UP", arrivedAt: T });
    expect(merged.stops.find((s) => s.assignmentId === "a2")?.status).toBe("ACTIVE");
  });

  it("applies an end-of-day after a start, and leaves the server's data untouched", async () => {
    const base = today();
    const merged = applyOutbox(base, await queue(start(), { kind: "shift.end", payload: { clientId: uid(), location: null, recordedAt: "2026-10-07T20:00:00.000Z" } }))!;
    expect(merged.shift).toMatchObject({ endedAt: "2026-10-07T20:00:00.000Z" });
    expect(onShift(merged)).toBe(false);
    expect(base.shift).toBeNull();
    expect(base.stops[0]!.status).toBe("ACTIVE");
    expect(applyOutbox(null, [])).toBeNull();
  });

  it("does not start a second shift over a running one, and ignores stops it does not know", async () => {
    const running = { ...today(), shift: { id: "s1", startedAt: "2026-10-07T13:00:00.000Z", endedAt: null } };
    expect(applyOutbox(running, await queue(start(), visit("unknown")))!.shift?.id).toBe("s1");
  });

  it("splits the route into the current stop, up next and done", async () => {
    const merged = applyOutbox(today(), await queue(visit("a1")))!;
    const s = sections(merged);
    expect(s.current?.assignmentId).toBe("a2");
    expect(s.upNext.map((x) => x.assignmentId)).toEqual(["a3"]);
    expect(s.done.map((x) => x.assignmentId)).toEqual(["a1"]);
    expect(sections(null)).toEqual({ current: null, upNext: [], done: [] });
  });

  it("summarizes what is waiting, ignoring pings and photos", async () => {
    const box = newBox();
    await box.add([start(), ping(), visit("a1"), visit("a2")]);
    const [, , , second] = await box.list();
    await box.fail(second!.seq, "Pick a date");
    expect(summarize(await box.list())).toMatchObject({ visits: 2, changes: 1, failed: 1 });
  });
});

describe("helpers", () => {
  it("builds maps links for each app", () => {
    expect(navigateUrl("apple", 32.78, -96.8)).toBe("https://maps.apple.com/?daddr=32.78,-96.8&dirflg=d");
    expect(navigateUrl("google", 32.78, -96.8)).toBe("https://www.google.com/maps/dir/?api=1&destination=32.78,-96.8&travelmode=driving");
  });

  it("fits a photo within 1600 px without scaling up", () => {
    expect(fitWithin(4032, 3024, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(3024, 4032, 1600)).toEqual({ width: 1200, height: 1600 });
    expect(fitWithin(800, 600, 1600)).toEqual({ width: 800, height: 600 });
  });

  it("turns a next-step date and time into the rep's zone, across daylight saving", () => {
    expect(nextStepIso("2026-10-09", "10:30", "America/Chicago")).toBe("2026-10-09T15:30:00.000Z"); // CDT
    expect(nextStepIso("2026-11-02", "10:30", "America/Chicago")).toBe("2026-11-02T16:30:00.000Z"); // CST
    expect(nextStepIso("not a date", "10:30", "America/Chicago")).toBeNull();
  });

  it("formats distances for the off-site message", () => {
    expect(formatDistance(340.4)).toBe("340 m");
    expect(formatDistance(2100)).toBe("1.3 mi");
  });
});
