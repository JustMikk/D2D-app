// The rep app's offline outbox (PRD REP-7, backend spec §1): every rep action is written to IndexedDB
// first and sent later, in order. Nothing is removed until the server has acknowledged it, so a phone
// that dies, reloads or sits in a basement never loses a visit.
import { openDB, type IDBPDatabase } from "idb";
import type { VisitCreate } from "@/lib/services/visits";

export type Fix = { lat: number; lng: number; accuracyM?: number; capturedAt: string };

export type ShiftPayload = { clientId: string; location: Fix | null; recordedAt: string };
export type ArrivePayload = ShiftPayload & { assignmentId: string };
export type PingPayload = Fix & { clientId: string; source: "START_DAY" | "ARRIVED" | "VISIT" | "FOREGROUND" | "END_DAY" };
export type MediaPayload = { clientId: string; kind: "PHOTO" | "SIGNATURE" };
/** A visit as queued: photos and the signature are referenced by their upload clientIds, resolved to media IDs when sent. */
export type VisitPayload = Omit<VisitCreate, "photoMediaIds" | "signatureMediaId"> & { photoClientIds?: string[]; signatureClientId?: string };

export type SkipPayload = { clientId: string; assignmentId: string; reason: "CLOSED" | "UNSAFE" | "OUT_OF_TIME" | "OTHER"; note?: string; recordedAt: string };
/** Analytics only the phone knows (PRD §10). Sent in batches, best effort. */
export type EventPayload = { clientId: string; name: "rep.visit_form_opened" | "rep.navigate_tapped" | "rep.offline_queue_flushed"; at: string; data?: Record<string, string | number | boolean | null> };

export type PayloadByKind = {
  "shift.start": ShiftPayload;
  "shift.end": ShiftPayload;
  arrive: ArrivePayload;
  skip: SkipPayload;
  event: EventPayload;
  ping: PingPayload;
  media: MediaPayload;
  visit: VisitPayload;
};
export type OutboxKind = keyof PayloadByKind;

export type OutboxItem<K extends OutboxKind = OutboxKind> = {
  [P in K]: {
    /** Order of arrival; the key of the record. */
    seq: number;
    kind: P;
    payload: PayloadByKind[P];
    createdAt: number;
    attempts: number;
    status: "pending" | "failed";
    lastError: string | null;
  };
}[K];

export type NewItem = { [P in OutboxKind]: { kind: P; payload: PayloadByKind[P] } }[OutboxKind];

type Listener = () => void;

export class Outbox {
  private db: Promise<IDBPDatabase>;
  private listeners = new Set<Listener>();
  private channel: BroadcastChannel | null = null;

  constructor(private readonly name = "canvass-rep") {
    this.db = openDB(name, 1, {
      upgrade(db) {
        db.createObjectStore("outbox", { keyPath: "seq", autoIncrement: true });
        db.createObjectStore("blobs", { keyPath: "id" });
        db.createObjectStore("cache", { keyPath: "key" });
      },
    });
    // Other tabs of the app learn about changes too.
    if (typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel(`${name}-changes`);
      this.channel.onmessage = () => this.emit(false);
    }
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(broadcast = true) {
    for (const fn of this.listeners) fn();
    if (broadcast) this.channel?.postMessage("changed");
  }

  /** Queue items (and the files they need) in one transaction, so a visit never exists without its photos. */
  async add(items: NewItem[], blobs: { id: string; blob: Blob }[] = [], now = Date.now()): Promise<void> {
    const db = await this.db;
    const tx = db.transaction(["outbox", "blobs"], "readwrite");
    for (const b of blobs) await tx.objectStore("blobs").put(b);
    for (const item of items) await tx.objectStore("outbox").add({ ...item, createdAt: now, attempts: 0, status: "pending", lastError: null });
    await tx.done;
    this.emit();
  }

  async list(): Promise<OutboxItem[]> {
    return (await (await this.db).getAll("outbox")) as OutboxItem[];
  }

  async remove(seq: number): Promise<void> {
    await (await this.db).delete("outbox", seq);
    this.emit();
  }

  /** Remove several items at once (a batch of pings). */
  async removeMany(seqs: number[]): Promise<void> {
    const tx = (await this.db).transaction("outbox", "readwrite");
    for (const s of seqs) await tx.store.delete(s);
    await tx.done;
    this.emit();
  }

  private async update(seq: number, fn: (item: OutboxItem) => OutboxItem): Promise<void> {
    const tx = (await this.db).transaction("outbox", "readwrite");
    const item = (await tx.store.get(seq)) as OutboxItem | undefined;
    if (item) await tx.store.put(fn(item));
    await tx.done;
    this.emit();
  }

  /** The item could not be sent right now (server error): count the try and keep it pending. */
  bump(seq: number, error: string): Promise<void> {
    return this.update(seq, (i) => ({ ...i, attempts: i.attempts + 1, lastError: error }));
  }

  /** The server refused the item for good. It stays in the outbox, visible, until the rep retries or discards it. */
  fail(seq: number, error: string): Promise<void> {
    return this.update(seq, (i) => ({ ...i, attempts: i.attempts + 1, status: "failed", lastError: error }));
  }

  async retryFailed(): Promise<number> {
    const tx = (await this.db).transaction("outbox", "readwrite");
    let n = 0;
    for (const item of (await tx.store.getAll()) as OutboxItem[]) {
      if (item.status === "failed") {
        await tx.store.put({ ...item, status: "pending", lastError: null });
        n++;
      }
    }
    await tx.done;
    this.emit();
    return n;
  }

  async getBlob(id: string): Promise<Blob | undefined> {
    return ((await (await this.db).get("blobs", id)) as { blob: Blob } | undefined)?.blob;
  }

  async deleteBlob(id: string): Promise<void> {
    await (await this.db).delete("blobs", id);
  }

  async getCache<T>(key: string): Promise<T | undefined> {
    return ((await (await this.db).get("cache", key)) as { value: T } | undefined)?.value;
  }

  async setCache(key: string, value: unknown): Promise<void> {
    await (await this.db).put("cache", { key, value });
  }

  /** Drop queued items of the given kinds (location pings and analytics are best effort, and belong to whoever is leaving). */
  async discardKinds(kinds: OutboxKind[]): Promise<number> {
    const tx = (await this.db).transaction("outbox", "readwrite");
    let n = 0;
    for (const item of (await tx.store.getAll()) as OutboxItem[]) {
      if (kinds.includes(item.kind)) {
        await tx.store.delete(item.seq);
        n++;
      }
    }
    await tx.done;
    if (n) this.emit();
    return n;
  }

  /** Forget cached server data (on sign-out). Visits and other real work in the outbox are never cleared here. */
  async clearCache(): Promise<void> {
    await (await this.db).clear("cache");
  }

  async close(): Promise<void> {
    this.channel?.close();
    (await this.db).close();
  }
}

let shared: Outbox | null = null;
export function outbox(): Outbox {
  return (shared ??= new Outbox());
}
