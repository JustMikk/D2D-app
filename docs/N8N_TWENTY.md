# n8n and Twenty: connecting Canvass to the CRM

Canvass never calls Twenty. It posts signed events to one n8n webhook, and n8n writes to Twenty. The event list, envelope and field mapping are in `BACKEND_SPEC.md` §9.3 and §9.4. This page covers what to build in n8n and how to switch it on.

## 1. Switch the outbound webhook on

1. In n8n, create a workflow that starts with a **Webhook** node (method POST, "Raw Body" on). Copy its production URL.
2. In Canvass, open **Settings** and set `webhooks.outboundUrl` to that URL. Events queue while the URL is empty and send once it is set.
3. Set `OUTBOUND_WEBHOOK_SECRET` in `.env` (32 or more random bytes) and put the same value in n8n as a credential or environment variable. Restart web and worker.
4. Watch **Settings → Failed outbox**. Events that fail for about 24 hours land there with a retry button.

## 2. Verify every delivery

Reject anything that does not verify. In an n8n Code node placed straight after the webhook:

```js
const crypto = require("crypto");
const h = $input.first().json.headers;
const raw = $input.first().binary?.data ? Buffer.from($input.first().binary.data.data, "base64").toString() : $input.first().json.body;
const ts = h["x-canvass-timestamp"];
if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) throw new Error("Stale timestamp");
const want = "v1=" + crypto.createHmac("sha256", $env.OUTBOUND_WEBHOOK_SECRET).update(`${ts}.${raw}`).digest("hex");
const a = Buffer.from(want), b = Buffer.from(h["x-canvass-signature"] ?? "");
if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error("Bad signature");
return [{ json: { delivery: h["x-canvass-delivery"], event: JSON.parse(raw) } }];
```

The signature covers the raw bytes, so verify before parsing. Dedupe on `X-Canvass-Delivery`: retries send the same ID, and a 2xx response is what stops them.

## 3. Route by event type

Add a **Switch** on `event.type`:

| Event | Do |
| --- | --- |
| `door.created`, `door.upserted`, `door.assigned`, `door.needs_review`, `door.unassignable` | Upsert the Twenty `doorAssignments` record on `externalProspectId`, mapping fields per §9.4. Upsert the `companies` record on `company.crmId`, else by name. |
| `visit.recorded` | Create a `note` on the company with outcome, notes and photo links. Photo and signature URLs are signed and expire after 7 days, so copy the files into Twenty if you need them longer. |
| `visit.hot` | Create an `opportunity` (stage "Appointment" or "Won") and send the CEO alert. The same event also arrives as `visit.recorded`, so do not create the note twice. |
| `digest.daily` | Send or store the daily summary. |

## 4. Give the new IDs back

After creating Twenty records, call Canvass so later events carry `crmId` and upserts become direct:

```
PATCH {CANVASS_URL}/api/v1/integrations/crm-ids
Authorization: Bearer cvs_...        (an API key with the crm:write scope)
```

The body is `{ "items": [{ "entityType": "COMPANY" | "DOOR" | "REP", "id": "...", "crmId": "..." }] }` (1 to 500 items). The response gives one status per item (`updated`, `unchanged`, `not_found` or `conflict`), so a single bad ID does not fail the batch. Create the key under **Settings → API keys**. Rep records need their `crmId` set once so `door.assigned` can fill the `fieldRep` relation.

## 5. Before pilot data (decision D-9)

Delete the old test records in Twenty (`companies`, `doorAssignments`, `notes`, `opportunities`) before the first real event arrives, or the upserts will attach to junk. Do this in Twenty, not in Canvass.

## 6. Test it

1. Post one prospect with an intake API key (see the README or `docs/PILOT_RUNBOOK.md`).
2. In n8n, check the execution shows `door.created` and then `door.assigned`.
3. Confirm the Twenty record exists, and that the `crm-ids` call made the next event carry a `crmId`.
