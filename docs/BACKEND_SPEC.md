# Canvass — Backend Spec and Schemas

This is the engineering contract for the Canvass backend: runtime, data model, domain rules, background jobs, integrations and the HTTP API. Product behavior and priorities come from `docs/PRD.md`; the schema source of truth is `prisma/schema.prisma`. Requirement IDs in brackets (for example [ASN-1]) point to the PRD.

## 1. Stack

| Concern | Choice | Notes |
| --- | --- | --- |
| Framework | Next.js, App Router, TypeScript strict, current stable | One app serves the rep PWA, the manager console and the API |
| Runtime | Node.js current LTS | Route handlers run on the Node runtime (not Edge), because Prisma and SQLite need it |
| Database | SQLite through Prisma ORM | WAL mode. Portable to Postgres (section 14) |
| Validation | zod | Every API input, every JSON column, every env var |
| Auth | Auth.js v5 (`next-auth`), Credentials provider, JWT sessions | Passwords hashed with argon2id (`@node-rs/argon2`) |
| Time | Luxon | All time-zone math. Never use `Date` arithmetic for local days |
| Push | `web-push` with VAPID | |
| Service worker | Hand-written `public/sw.js`, no build step | Caches built assets and the Today page, runtime-caches map tiles, shows push notifications. (Serwist's Next plugin is tied to webpack; Next 16 builds with Turbopack.) |
| Client data | TanStack Query, plus an IndexedDB outbox (`idb`) for rep mutations | |
| Maps (client) | MapLibre GL JS with OpenFreeMap vector tiles | No key needed; styled with tokens (design doc 8.8) |
| Tests | Vitest (unit and integration against a temporary SQLite file), Playwright (end to end) | |

## 2. Architecture and runtime

```
                 prospecting workflow / n8n            n8n (CRM sync + alerts)
                          │  POST intake (API key)          ▲  signed webhooks
                          ▼                                 │
┌──────────────────────────────────────────────────────────────────────────┐
│ Next.js app (process: web)                                               │
│  /app/(rep)      rep PWA          /app/console   manager console          │
│  /app/api/v1/*   route handlers ──► lib/services ──► lib/domain (pure)     │
│                                       │ enqueue Job / write OutboxEvent    │
└───────────────────────────────────────┼──────────────────────────────────┘
                                        ▼
                         SQLite (WAL)  /data/canvass.db   uploads /data/uploads
                                        ▲
┌───────────────────────────────────────┼──────────────────────────────────┐
│ Worker (process: worker, `tsx worker/index.ts`)                          │
│  job runner (1 lane, sequential), scheduler tick (60 s), outbox loop (10 s)   │
│  ──► Google Maps Platform, web-push, outbound webhooks                   │
└──────────────────────────────────────────────────────────────────────────┘
```

- **Two processes, one database.** `web` serves HTTP; `worker` runs jobs, schedules and the outbox. Both open the same SQLite file. Run them as two services in one Docker Compose file, or two systemd units, on one host with a persistent volume.
- **Not serverless.** SQLite needs a persistent disk and a long-running worker.
- **SQLite pragmas**, applied on boot in both processes: `journal_mode=WAL`, `busy_timeout=5000`, `synchronous=NORMAL`, `foreign_keys=ON`.
- **Request handlers never call Google or n8n inline**, except the console's address-edit preview (one geocode call). Everything else goes through jobs so the API stays fast and retries are uniform.
- **Backups:** Litestream replicating to object storage (recommended), or a nightly `sqlite3 .backup` to off-host storage. Uploads are backed up alongside.

## 3. Repository layout

```
app/
  (auth)/login, invite/[token], install
  (rep)/today, map, stops/[assignmentId], settings          # rep PWA (role REP)
  console/map, review, doors, reps, reps/[id]/day/[date], metrics, imports, settings
  api/v1/...                                                # route handlers (section 10)
  manifest.ts, sw.ts, tokens.css, globals.css
lib/
  domain/        # pure, framework-free, fully unit-tested
    enums.ts normalize.ts intake.ts addressResolution.ts assignment.ts
    targetDate.ts routing/local.ts outcomes.ts geo.ts time.ts
  services/      # orchestration: Prisma + domain + enqueue jobs + emit events
  integrations/  # google/{geocoding,places,routeMatrix,routeOptimization}.ts push.ts webhooks.ts storage.ts
  api/           # handler helpers: auth guard, zod parse, error mapper, idempotency
  db.ts          # Prisma singleton + pragmas
  settings.ts    # typed settings registry (section 7)
  events.ts      # outbox event builders (section 9.3)
worker/
  index.ts runner.ts scheduler.ts outbox.ts handlers/*.ts
prisma/
  schema.prisma  seed.ts
tests/
  unit/ integration/ e2e/ fixtures/sample_apify_linkedin_jobs.json
```

The rule: `lib/domain` has no imports from Prisma, Next.js or `fetch`. Services pass plain data in and persist what comes out. That keeps the address, assignment, routing and outcome logic testable with fixtures.

## 4. Data model

The full schema is in `prisma/schema.prisma`. This section explains the conventions and the invariants code must keep.

### 4.1 Conventions

- IDs are cuid strings. All `DateTime` columns are UTC.
- **Enums are strings.** The allowed values are defined once in `lib/domain/enums.ts` as `as const` arrays with matching zod enums, and every write goes through them. (Native Prisma enums come with the Postgres migration.)
- **JSON columns are strings** (`reviewDetail`, `payload`, `value`, `data`, `preferences`). Each has a zod schema; parse on read, `JSON.stringify` on write.
- **Local dates are strings** in `YYYY-MM-DD` form, in the rep's time zone (`Assignment.scheduledFor`, `Shift.date`, `RoutePlan.date`). Never derive them from server time.
- Money is not stored in v1.

### 4.2 Entities

| Model | Purpose | Key relations |
| --- | --- | --- |
| User | Anyone who signs in | 0..1 Rep |
| Invite, ApiKey, PushSubscription | Access and devices | User |
| Rep | Field profile: time zone, deployment base, capacity, working days, last known location | User; many Assignments, Visits, Shifts, LocationPings, RoutePlans |
| RepUnavailability | Dates a rep is off | Rep |
| Company | The business; matched by domain or normalized name | many Doors |
| Door | One visitable place: the address and lifecycle status of a prospect | Company; many Assignments and Visits; optional preferred Rep |
| DoNotKnock | Opted-out companies and addresses | |
| Assignment | A door given to a rep for a local date, with route position | Door, Rep, optional RoutePlan |
| RoutePlan | One planning run for a rep and date | Rep; many Assignments |
| Shift | A working day between start and end | Rep |
| LocationPing | A GPS fix during a shift | Rep |
| Visit | Outcome at the door | Door, Rep, optional Assignment; many Media |
| Media | Photo or signature file | Visit, User |
| Job | Background work queue | |
| OutboxEvent | Outbound webhook queue | |
| IdempotencyKey | Stored responses for retried requests | User |
| AppSetting | Tunables (section 7) | |
| AuditLog | Who changed what | optional User |
| ImportBatch | Console imports | User |

### 4.3 Enum registry

| Field | Values |
| --- | --- |
| `User.role` | `ADMIN`, `MANAGER`, `REP`, `VIEWER` |
| `Door.status` | `NEW`, `NEEDS_REVIEW`, `GEOCODED`, `ASSIGNED`, `SCHEDULED`, `VISITED`, `CLOSED`, `UNASSIGNABLE` |
| `Door.reviewReason` | `PO_BOX`, `MISSING_ADDRESS`, `LOCATION_MISMATCH`, `REMOTE_JOB`, `LOW_GEOCODE_QUALITY`, `COVERAGE_GAP`, `BAD_ADDRESS`, `ROLLOVER_LIMIT` |
| `Door.closedReason` | `NOT_INTERESTED`, `SOLD`, `MAX_ATTEMPTS`, `NO_VISIT`, `DO_NOT_KNOCK`, `MANUAL` |
| `Door.priority` | `NORMAL`, `HOT` |
| `Door.geocodeQuality` | `ROOFTOP`, `INTERPOLATED`, `CENTER`, `APPROXIMATE` |
| `Door.addressSource` | `COMPANY_ADDRESS`, `PLACES_MATCH`, `METRO_FALLBACK`, `MANUAL` |
| `Door.workplaceType` | `ON_SITE`, `HYBRID`, `REMOTE`, `UNKNOWN` |
| `Door.preferredVisitWindow` | `MORNING`, `AFTERNOON`, `EVENING` |
| `Door.source` | `API`, `IMPORT`, `MANUAL` |
| `Assignment.status` | `ACTIVE`, `COMPLETED`, `ROLLED_OVER`, `CANCELLED`, `SKIPPED` |
| `Assignment.assignedBy` | `ENGINE`, `MANAGER` |
| `Visit.outcome` | `NOT_HOME`, `NOT_INTERESTED`, `FOLLOW_UP`, `APPOINTMENT_SET`, `SOLD`, `BAD_ADDRESS` |
| `LocationPing.source` | `START_DAY`, `ARRIVED`, `VISIT`, `FOREGROUND`, `END_DAY` |
| `Media.kind` | `PHOTO`, `SIGNATURE` |
| `RoutePlan.provider` / `trigger` / `status` | `LOCAL`, `GOOGLE` / `SCHEDULED`, `REP`, `MANAGER`, `HOT_DOOR`, `NEW_TODAY` / `OK`, `PARTIAL`, `FAILED` |
| `Job.status` | `QUEUED`, `RUNNING`, `DONE`, `FAILED` |
| `OutboxEvent.status` | `PENDING`, `SENT`, `FAILED` |

### 4.4 Invariants

Enforce these in services, inside a Prisma `$transaction`:

1. **At most one ACTIVE assignment per door.** Creating one cancels any other ACTIVE assignment for that door (reason `REASSIGNED`).
2. **Capacity:** the count of ACTIVE plus COMPLETED assignments for a rep and date is at most `Rep.dailyCapacity`, except revisits [ASN-6] and manual assignments, which may exceed it. Over-capacity is shown in the console.
3. **Door status follows its assignment:** `ASSIGNED` after assignment, `SCHEDULED` once the assignment has a route order; never `ASSIGNED` without an ACTIVE assignment.
4. A `Visit` is immutable once created. Corrections are made by a manager as door edits, which are audit-logged.
5. Every manager or admin mutation writes an `AuditLog` row with before and after values in `data`.
6. A door in `NEEDS_REVIEW` always has a `reviewReason`; a door in `CLOSED` always has a `closedReason` and `closedAt`.

## 5. State machines

### 5.1 Door

| From | To | Trigger |
| --- | --- | --- |
| (none) | `NEW` | Intake creates the door |
| `NEW` | `GEOCODED` | Address resolution succeeds |
| `NEW` | `NEEDS_REVIEW` | Resolution fails (`PO_BOX`, `MISSING_ADDRESS`, `LOCATION_MISMATCH`, `REMOTE_JOB`, `LOW_GEOCODE_QUALITY`) |
| `GEOCODED` | `ASSIGNED` | The engine or a manager assigns it |
| `GEOCODED` | `NEEDS_REVIEW` | Coverage gap (`COVERAGE_GAP`) |
| `GEOCODED` | `UNASSIGNABLE` | No active reps |
| `ASSIGNED` | `SCHEDULED` | Route plan gives it an order |
| `ASSIGNED`, `SCHEDULED` | `GEOCODED` | Unassigned, skipped, or rolled over (then re-run through assignment) |
| `ASSIGNED`, `SCHEDULED` | `NEEDS_REVIEW` | Rolled over more than the limit (`ROLLOVER_LIMIT`) |
| `ASSIGNED`, `SCHEDULED`, `VISITED` | per outcome table (6.7) | A visit is recorded |
| `VISITED` | `ASSIGNED` | Revisit assigned on the next-step date |
| `NEEDS_REVIEW` | `NEW` | A manager edits the address or retries (resolution re-runs) |
| `NEEDS_REVIEW` | `GEOCODED` | A manager accepts a candidate, or clears a coverage gap |
| `UNASSIGNABLE` | `GEOCODED` | Daily retry, or when a rep is added |
| any open status | `CLOSED` | Manager closes it; outcome rules; do-not-knock |

### 5.2 Assignment

`ACTIVE` becomes `COMPLETED` (a visit is recorded), `SKIPPED` (the rep skips), `ROLLED_OVER` (21:00 rollover), or `CANCELLED` (reassigned, unassigned, door closed, or rep deactivated). All four are terminal.

## 6. Domain logic (`lib/domain`)

### 6.1 Normalization (`normalize.ts`)

These are ported from the n8n WF1 and WF2 code nodes and must behave identically.

| Function | Rule |
| --- | --- |
| `str(v)` | `String(v ?? "").trim()` |
| `state2(v)` | Upper-case; two letters as-is; full state names map to codes (all 50 states and DC) |
| `zip5(v)` | Digits only, first 5 |
| `phoneE164(v)` | 10 digits become `+1XXXXXXXXXX`; 11 digits starting with 1 become `+XXXXXXXXXXX`; anything else is dropped |
| `norm(s)` | Lower-case; every character not in `[a-z0-9 ]` becomes a space; collapse spaces |
| `streetKey(s)` | `norm`, then map words: street→st, road→rd, avenue→ave, boulevard→blvd, drive→dr, highway→hwy, freeway→fwy, parkway→pkwy, lane→ln, north→n, south→s, east→e, west→w, suite→ste |
| `companyKey(s)` | `norm`, then drop the words inc, llc, co, corp, corporation, company, ltd, group, the |
| `domainOf(url)` | Hostname, lower-case, leading `www.` removed; null for invalid input |
| `workplaceType(v)` | Upper-case, hyphens to underscores; `ON_SITE`, `HYBRID` or `REMOTE`, else `UNKNOWN` |
| `similarity(a, b)` | `1 - levenshtein(a, b) / max(len)` on `companyKey` values; 1 when both are empty |

### 6.2 Intake pipeline (`services/intake.ts`) [INT-1 to INT-4, INT-6]

1. Validate with `IntakeProspect` (section 10.4). Normalize every field.
2. Check do-not-knock (company key or domain; street key plus ZIP). On a match, return `do_not_knock` and create nothing.
3. If a door with the same `externalProspectId` exists, return `duplicate` with its ID.
4. Find the company: by `domain` if present, else by `nameKey`. Create it if neither matches. Fill blank company fields from the payload; never overwrite existing values.
5. If the payload has a street, look for an open door (not `CLOSED`) of this company with the same `streetKey`. If found, append `" | Also listed: {notes} [{externalProspectId}]"` to its `qualificationNotes` and return `merged`.
6. Create the door with status `NEW`, the company address copied into the door's address fields (resolution may replace it), and `jobCity`, `jobState`, `workplaceType`, contact fields, notes, priority and preferred window.
7. Enqueue `address.resolve` with `dedupeKey = "resolve:" + doorId`. Emit `door.created` and `door.upserted`. Return `accepted`.

All of steps 3 to 7 run in one transaction.

### 6.3 Address resolution (`addressResolution.ts`) [ADR-1 to ADR-3]

Input: the door's intake fields. Output: `{ kind: "resolved", address, lat, lng, quality, source, placeId? }` or `{ kind: "review", reason, evidence }`. Google calls are injected as functions so tests can stub them.

```
usable(addr) = street starts with a digit AND not a PO box (norm starts with "po box", "pobox" or "post office box")
               AND zip is 5 digits AND city AND state
cityMatches  = no job city, OR (norm(addr.city) == norm(jobCity) AND (no jobState OR addr.state == jobState))

1. workplaceType == REMOTE                      → review REMOTE_JOB
2. usable(companyAddr) AND cityMatches          → candidate = companyAddr, source COMPANY_ADDRESS
3. else if jobCity:
     places = placesTextSearch(companyName + " " + jobCity + ", " + jobState)
     best   = places where street_number AND route AND postal_code present
              AND norm(locality) == norm(jobCity) AND (no jobState OR admin_area_1 short == jobState)
              AND businessStatus in (missing, OPERATIONAL)
              AND similarity(companyName, displayName) >= nameMatchThreshold
              → the highest similarity
     if best → candidate = best, source PLACES_MATCH, placeId
     else if usable(companyAddr):
        miles = haversine(geocode(companyAddr), geocode(jobCity + ", " + jobState))
        if miles <= metroRadiusMiles → candidate = companyAddr, source METRO_FALLBACK
        else → review LOCATION_MISMATCH (evidence: both points, miles, places tried)
     else → review (PO_BOX if a PO box, else MISSING_ADDRESS)
4. else (no usable address and no job city)     → review (PO_BOX or MISSING_ADDRESS)
5. geocode(candidate): quality from location_type
     ROOFTOP → ROOFTOP; RANGE_INTERPOLATED → INTERPOLATED; GEOMETRIC_CENTER → CENTER; APPROXIMATE → APPROXIMATE
   pass if quality in (ROOFTOP, INTERPOLATED) AND NOT partial_match
   else review LOW_GEOCODE_QUALITY (evidence: query, quality, status)
```

On `resolved`, the service writes the address fields, `streetKey`, `lat`, `lng`, `geocodeQuality`, `addressSource` and `placeId`, sets status `GEOCODED`, clears `reviewReason` and `reviewDetail`, enqueues `door.assign`, and emits `door.upserted`. On `review`, it sets `NEEDS_REVIEW` with the reason, stores `evidence` as JSON in `reviewDetail`, and emits `door.needs_review` and `door.upserted`.

`reviewDetail` schema:

```ts
type ReviewEvidence = {
  companyAddress?: { street: string; city: string; state: string; zip: string; lat?: number; lng?: number };
  jobCity?: { city: string; state: string; lat?: number; lng?: number };
  distanceMiles?: number;
  placesCandidates?: Array<{ name: string; street: string; city: string; state: string; zip: string;
                             similarity: number; placeId: string; rejectedBecause?: string }>;
  geocode?: { query: string; quality?: string; status: string; partialMatch?: boolean };
  coverage?: { nearestRepId: string; nearestRepName: string; driveMinutes: number; maxDriveMinutes: number };
  rollovers?: number;
};
```

### 6.4 Assignment engine (`assignment.ts`) [ASN-1 to ASN-6]

```
assign(door, reps, now, settings, driveTimes):        // pure; driveTimes injected
  active = reps where active
  if active is empty → UNASSIGNABLE

  for each rep: origin = (rep.onShift AND lastLocationAt within locationStalenessMinutes) ? last : base
  drop reps with no origin (no base set)

  if door is a revisit AND preferredRep is active:
      date = nextWorkday(preferredRep, from = local date of door.nextStepAt)
      → assign preferredRep on date (capacity ignored)

  ordered = active reps by haversine(origin, door)
  for batch in chunks(ordered, shortlistSize):         // 5 at a time
      minutes = driveTimes(batch origins → door)        // Route Matrix; haversine estimate on failure
      for rep in batch sorted by minutes:
          skip reps with minutes > maxDriveMinutes      // out of range: they never take the door
          date = targetDate(rep, door, now)
          if load(rep, date) < rep.dailyCapacity → assign rep on date, driveMinutes = minutes
  every in-range rep is full → the fastest in-range rep on a later workday that has capacity (search up to 14 days)
  no rep in range → NEEDS_REVIEW COVERAGE_GAP (evidence: the nearest rep by drive time, and minutes)
```

The service then creates the assignment (invariant 1), sets the door to `ASSIGNED`, emits `door.assigned` and `door.upserted`, and, if `date` is the rep's local today, enqueues `route.plan` (trigger `HOT_DOOR` for hot doors, else `NEW_TODAY`) and sends a push for hot doors.

The haversine estimate used when the matrix fails is `minutes = miles × roadFactor / avgSpeedMph × 60`, with `roadFactor = 1.3` and `avgSpeedMph = 30` from settings.

### 6.5 Target date (`targetDate.ts`) [ASN-2]

```
targetDate(rep, door, nowUtc):
  local = nowUtc in rep.timeZone; today = local.toISODate()
  workday(d) = weekday(d) in rep.workdays AND no RepUnavailability for d
  if door.priority == HOT AND rep.onShift AND workday(today) → today
  if workday(today) AND local.time < cutoffLocalTime          → today
  return the first d > today with workday(d)                  // at most 14 days ahead, else error
```

### 6.6 Route planning (`routing/*`) [RTE-1 to RTE-3]

Input: the start point and start time (the deployment base at `dayStartLocal`, or the current GPS fix and now for a re-plan), and the rep's ACTIVE assignments for the date with each door's location, priority and preferred window. Stops already visited keep their order and are excluded from the input.

**Local provider (default):**

1. Travel time between two points = haversine miles × `roadFactor` / `avgSpeedMph`. With `routing.useRouteMatrix` on (P1), the provider fetches the real N×N matrix instead (N stays at 25 or fewer).
2. Buckets by window: `MORNING` (day start to 12:00), `AFTERNOON` (12:00 to 17:00), `EVENING` (17:00 to 20:00), and unwindowed (fits anywhere). Bucket order is fixed: morning, afternoon, evening.
3. Construct the route with nearest-neighbor from the start. Within each bucket, hot doors come first, then the nearest remaining door. Unwindowed doors fill the earliest bucket they are nearest to.
4. Improve it with 2-opt inside each bucket segment (bucket order never changes, and hot doors stay at the front of their bucket). Stop when no move improves the total by more than 1%.
5. Planned arrival = previous departure + travel. If a door arrives before its window opens, wait. Each visit takes `visitDurationMinutes`. Nothing is ever dropped; stops planned after 20:00 are flagged late (`RoutePlan.status = PARTIAL`).

**Google provider (optional):** Route Optimization `optimizeTours` (9.1). One vehicle. Each door is a shipment with one delivery at its location, `duration = visitDurationMinutes`, a time window from its preferred window, and a high `penaltyCost` for hot doors so they are never skipped. Skipped shipments keep their assignment, are appended at the end, and are flagged. If the provider fails, fall back to the local provider and record it in `RoutePlan.detail`.

The service writes `routeOrder` and `plannedArrival` on each assignment, sets those doors to `SCHEDULED`, saves a `RoutePlan` row, and pushes "Your route changed" to the rep if the plan was not the 06:30 scheduled one.

### 6.7 Outcome rules (`outcomes.ts`) [OUT]

`applyOutcome(door, visit, settings)` returns the door patch and the side effects:

| Outcome | Door patch | Effects |
| --- | --- | --- |
| `NOT_HOME` | `attempts + 1`. Under `maxNotHomeAttempts`: status `GEOCODED`. At the limit: `CLOSED`, `MAX_ATTEMPTS` | Under the limit: enqueue `door.assign` |
| `NOT_INTERESTED` | `CLOSED`, `NOT_INTERESTED` | |
| `FOLLOW_UP` | `VISITED`, `nextStepAt`, `preferredRepId = visit.repId` | (Revisit handled by the rollover job) |
| `APPOINTMENT_SET` | `VISITED`, `nextStepAt`, `preferredRepId = visit.repId` | Emit `visit.hot` |
| `SOLD` | `CLOSED`, `SOLD` | Emit `visit.hot` |
| `BAD_ADDRESS` | `NEEDS_REVIEW`, `BAD_ADDRESS`, evidence = the rep's notes and GPS fix | Emit `door.needs_review` |

Every outcome sets `lastOutcome`, completes the assignment, and emits `visit.recorded` and `door.upserted`.

### 6.8 Time utilities (`time.ts`)

`localToday(tz, now)`, `localTime(tz, now)` as `HH:mm`, `isWorkday(rep, date, unavailableDates)`, `nextWorkday(rep, from, unavailableDates)`, `localDateOf(utc, tz)`, `atLocal(tz, date, "HH:mm")` returning a UTC DateTime. All are built on Luxon and tested across DST changes (for example, America/Denver on the second Sunday of March).

## 7. Settings registry (`lib/settings.ts`)

Settings are stored in `AppSetting` as JSON, read through a typed registry with zod validation and defaults, and cached in memory for 30 seconds.

| Key | Type | Default | Used by |
| --- | --- | --- | --- |
| `assignment.maxDriveMinutes` | int | 120 | ASN-1 coverage guard |
| `assignment.shortlistSize` | int | 5 | ASN-1 |
| `assignment.cutoffLocalTime` | `HH:mm` | `"11:00"` | Target date |
| `assignment.locationStalenessMinutes` | int | 120 | Origin choice |
| `assignment.maxRollovers` | int | 3 | Rollover |
| `rep.defaultDailyCapacity` | int | 20 | New reps |
| `address.nameMatchThreshold` | number 0..1 | 0.8 | ADR-1 |
| `address.metroRadiusMiles` | number | 30 | ADR-1 |
| `routing.provider` | `LOCAL` or `GOOGLE` | `LOCAL` | RTE-3 |
| `routing.visitDurationMinutes` | int | 20 | Routing |
| `routing.roadFactor` | number | 1.3 | Estimates |
| `routing.avgSpeedMph` | number | 30 | Estimates |
| `routing.useRouteMatrix` | bool | false | Local provider (P1) |
| `visit.arrivalRadiusMeters` | int | 200 | Off-site flag |
| `outcome.maxNotHomeAttempts` | int | 3 | Outcome rules |
| `schedule.routePlanLocalTime` | `HH:mm` | `"06:30"` | Scheduler |
| `schedule.rolloverLocalTime` | `HH:mm` | `"21:00"` | Scheduler |
| `schedule.digestTime` | `HH:mm` | `"19:00"` | Scheduler |
| `schedule.digestTimeZone` | IANA | `"America/Chicago"` | Scheduler |
| `location.foregroundPingSeconds` | int | 120 | Rep client (served by `/me`) |
| `location.retentionDays` | int | 90 | Cleanup |
| `webhooks.outboundUrl` | URL or null | null | Outbox (the secret stays in env) |

## 8. Jobs and schedules (`worker/`)

### 8.1 Job types

| Type | Payload | Handler |
| --- | --- | --- |
| `address.resolve` | `{ doorId }` | 6.3 |
| `door.assign` | `{ doorId, reason: "NEW" \| "ROLLOVER" \| "NOT_HOME" \| "REVISIT" \| "RETRY" \| "REP_CHANGE", ignoreDriveLimit?: boolean }` (the flag is set when a manager clears a coverage gap) | 6.4 |
| `route.plan` | `{ repId, date, trigger, start?: { lat, lng } }` | 6.6 |
| `rollover.rep` | `{ repId, date }` | 8.3 |
| `digest.send` | `{ date }` | Builds `digest.daily` |
| `push.send` | `{ userId, title, body, url, tag }` | 9.2 |
| `import.commit` | `{ batchId }` | Runs intake for each previewed row |
| `unassignable.retry` | `{}` | Re-enqueues `door.assign` for every `UNASSIGNABLE` door |
| `retention.cleanup` | `{}` | Deletes pings older than the retention setting, idempotency keys older than 7 days, and DONE jobs older than 14 days |

### 8.2 Runner

- **One lane, sequential.** At this scale, running jobs one at a time removes capacity races between `door.assign` and `route.plan` without locks.
- **Claim:** every second, select up to 10 `QUEUED` jobs with `runAt <= now`, ordered by `runAt`. For each, run `UPDATE … SET status='RUNNING', lockedAt=now, lockedBy=workerId WHERE id=? AND status='QUEUED'` and proceed only if one row changed.
- **Success:** status `DONE` and `dedupeKey = null` (so the same key can be enqueued again later).
- **Failure:** increment `attempts`. Under `maxAttempts`, go back to `QUEUED` with `runAt = now + 15s × 2^attempts` (capped at 30 minutes). At the limit, `FAILED`, `dedupeKey = null`, and the job is shown in Settings for retry.
- **Stale locks:** on boot and every minute, jobs `RUNNING` with `lockedAt` older than 5 minutes go back to `QUEUED`.
- **Enqueue helper:** `enqueue(type, payload, { runAt?, dedupeKey? })` ignores the unique-constraint error on `dedupeKey`, so double-enqueues are harmless.

### 8.3 Scheduler (tick every 60 seconds)

For each active rep, compute the local date and time in the rep's zone:

- At `routePlanLocalTime` or later on a workday, if there is no `SCHEDULED`-trigger plan for today: enqueue `route.plan` (dedupe `plan:{repId}:{date}:scheduled`).
- At `rolloverLocalTime` or later, if not yet run for today: enqueue `rollover.rep` (dedupe `rollover:{repId}:{date}`).

Globally:

- At `digestTime` in `digestTimeZone`: enqueue `digest.send` (dedupe `digest:{date}`).
- Daily at 03:00 server time: `retention.cleanup` and `unassignable.retry`.

Because each check is "at or after the time, and not done yet", a worker that was down catches up on its next tick.

**Rollover handler:**

1. If the rep is still on shift, end the shift (`endedBy = SYSTEM`) and set `onShift = false`.
2. Each `ACTIVE` assignment for that date becomes `ROLLED_OVER`. The door's `rolloverCount` increases by 1. Over `maxRollovers`: `NEEDS_REVIEW`, `ROLLOVER_LIMIT`. Otherwise status `GEOCODED` and enqueue `door.assign` (reason `ROLLOVER`).
3. Revisits: doors with status `VISITED`, `preferredRepId = rep`, and a `nextStepAt` on or before the rep's next workday (overdue next steps included, so a missed day never strands a follow-up) get `door.assign` (reason `REVISIT`).

## 9. Integrations

### 9.1 Google Maps Platform (`lib/integrations/google/*`)

Server-side only, using `GOOGLE_MAPS_API_KEY`. Restrict the key to these APIs and to the server's IP. Every call has a 10-second timeout and one retry on 5xx, and logs the API name and latency.

| Use | Request |
| --- | --- |
| Geocoding | `GET https://maps.googleapis.com/maps/api/geocode/json?address={q}&components=country:US&key={KEY}`. Read `status`, `results[0].geometry.location`, `results[0].geometry.location_type` and `results[0].partial_match`. |
| Places Text Search (New) | `POST https://places.googleapis.com/v1/places:searchText` with headers `X-Goog-Api-Key` and `X-Goog-FieldMask: places.id,places.displayName,places.formattedAddress,places.addressComponents,places.location,places.businessStatus`. Body: `{ "textQuery": "...", "regionCode": "US", "pageSize": 3 }` (older docs call `pageSize` `maxResultCount`). Address components use `longText`, `shortText` and `types`. |
| Route Matrix | `POST https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix` with headers `X-Goog-Api-Key` and `X-Goog-FieldMask: originIndex,destinationIndex,duration,distanceMeters,status,condition`. Body: `{ origins: [{ waypoint: { location: { latLng: { latitude, longitude } } } }], destinations: [...], travelMode: "DRIVE", routingPreference: "TRAFFIC_UNAWARE" }`. The response is a JSON array of elements, and `duration` is a string such as `"1234s"`. |
| Route Optimization (optional) | `POST https://routeoptimization.googleapis.com/v1/projects/{GOOGLE_CLOUD_PROJECT_ID}:optimizeTours`. Uses an OAuth bearer token from a service account (`google-auth-library`, scope `https://www.googleapis.com/auth/cloud-platform`); **it does not accept API keys**. Read `routes[0].visits[]` (`shipmentIndex`, `startTime`) and `skippedShipments`. |

Verify field names against the current Google documentation when implementing. Each integration module exports a typed function and a fake for tests.

### 9.2 Web push (`lib/integrations/push.ts`)

- VAPID keys come from env; `GET /api/v1/push/vapid-public-key` serves the public key.
- `push.send` sends to every subscription the user has. A 404 or 410 response deletes the subscription; other failures increment `failureCount`, and the subscription is deleted after 5 consecutive failures.
- The payload is `{ title, body, url, tag }`. The `tag` collapses repeated notifications (for example `route-{date}`).
- On iOS, push only works for the installed PWA (16.4 or later). The client polls `GET /api/v1/rep/today` every 60 seconds while it is visible and push is unavailable.

### 9.3 Outbound events (`lib/events.ts`, `worker/outbox.ts`)

Services write an `OutboxEvent` row in the same transaction as the change that caused it. The outbox loop runs every 10 seconds and posts pending events to `webhooks.outboundUrl` in order of creation.

**Envelope:**

```json
{ "id": "evt_cuid", "type": "visit.hot", "version": 1, "occurredAt": "2026-10-08T15:04:05.000Z", "data": { } }
```

**Headers:** `Content-Type: application/json`, `X-Canvass-Event: {type}`, `X-Canvass-Delivery: {id}`, `X-Canvass-Timestamp: {unix seconds}`, `X-Canvass-Signature: v1={hex HMAC-SHA256 of "{timestamp}.{raw body}" with OUTBOUND_WEBHOOK_SECRET}`. The receiver rejects timestamps more than 5 minutes old and dedupes on `X-Canvass-Delivery`.

**Retries:** any 2xx response marks the event `SENT`. Otherwise retry after 30 s, 1 m, 5 m, 15 m, 30 m, 1 h, 2 h, 4 h, 8 h and 8 h (about 24 hours in total), then `FAILED`, shown in Settings with a retry button.

| Event | When | `data` |
| --- | --- | --- |
| `door.upserted` | Any change to a door's status, address, assignment, outcome or notes | `{ door: DoorSnapshot }` |
| `door.created` | Intake created a door | `{ door: DoorSnapshot }` |
| `door.needs_review` | Door entered review | `{ door: DoorSnapshot, reason, evidence }` |
| `door.unassignable` | No active reps | `{ door: DoorSnapshot }` |
| `door.assigned` | Assignment created (engine or manager) | `{ door: DoorSnapshot, assignment: { id, repId, repName, repCrmId, scheduledFor, assignedBy, driveMinutes } }` |
| `visit.recorded` | Every visit | `{ visit: VisitSnapshot, door: DoorSnapshot, rep: { id, name, crmId } }` |
| `visit.hot` | Appointment set or sold | Same as `visit.recorded` |
| `digest.daily` | Daily at the digest time | `{ date, timeZone, totals, reps: [{ repId, name, visited, contacts, appointments, sales, notVisited, driveMinutes }] }` |

```ts
type DoorSnapshot = {
  id: string; externalProspectId: string; crmId: string | null; name: string;
  status: DoorStatus; reviewReason: ReviewReason | null; closedReason: ClosedReason | null; priority: "NORMAL" | "HOT";
  address: { street: string | null; city: string | null; state: string | null; zip: string | null };
  lat: number | null; lng: number | null; geocodeQuality: GeocodeQuality | null; addressSource: AddressSource | null;
  jobLocation: string | null; qualificationNotes: string; preferredVisitWindow: VisitWindow | null;
  attempts: number; lastOutcome: Outcome | null; nextStepAt: string | null;
  nextStepDate: string | null;   // nextStepAt as YYYY-MM-DD in the rep's time zone (business zone if unassigned), for date-only CRM fields
  company: { id: string; crmId: string | null; name: string; website: string | null; domain: string | null;
             address: { street: string | null; city: string | null; state: string | null; zip: string | null } };
  currentAssignment: { id: string; repId: string; repName: string; repCrmId: string | null;
                       scheduledFor: string; routeOrder: number | null; plannedArrival: string | null } | null;
  updatedAt: string;
};
type VisitSnapshot = {
  id: string; outcome: Outcome; notes: string; decisionMakerPresent: boolean | null; nextStepAt: string | null;
  recordedAt: string; offSite: boolean; distanceFromDoorM: number | null; location: { lat: number; lng: number } | null;
  photoUrls: string[]; signatureUrl: string | null;   // signed URLs valid for 7 days
};
```

### 9.4 Twenty CRM via n8n

Canvass never calls Twenty directly. An n8n workflow receives the events and upserts into Twenty using the objects that already exist there (`companies`, the custom `doorAssignments` and `fieldReps`, `notes`, `opportunities`).

| Canvass | Twenty |
| --- | --- |
| `company.name`, `website`, address | `companies`: `name`, `domainName.primaryLinkUrl`, `address` (upsert on `crmId`, else by name) |
| `door.externalProspectId` | `doorAssignments.externalProspectId` (upsert key) |
| `door.status`, `reviewReason`, `priority`, `geocodeQuality`, `addressSource`, `jobLocation`, `qualificationNotes`, `preferredVisitWindow`, `attempts`, `nextStepAt` | Same-named fields (Twenty `nextStepDate` takes the snapshot's `nextStepDate`, a local date, not `nextStepAt`) |
| `door.address`, `lat`, `lng` | `doorAddress`, `lat`, `lng` |
| `door.lastOutcome`, latest visit `notes`, `recordedAt`, visit `id` | `outcome`, `visitNotes`, `visitedAt`, `formSubmissionId` |
| `currentAssignment.scheduledFor`, `routeOrder`, `plannedArrival`, `repCrmId` | `scheduledFor`, `routeOrder`, `plannedArrival`, `fieldRep` relation |
| `visit.recorded` | A `note` on the company, with the outcome, notes and photo links |
| `visit.hot` | An `opportunity` (stage "Appointment" or "Won"), plus the CEO alert |

After creating records, n8n calls `PATCH /api/v1/integrations/crm-ids` so later events carry `crmId` and the upserts become direct. The Connecteam fields in Twenty (`connecteamShiftId`, `connecteamOptionId`) are no longer used.

### 9.5 Media storage (`lib/integrations/storage.ts`)

- Files go to `UPLOAD_DIR/{yyyy}/{mm}/{mediaId}.{ext}`. JPEG, PNG or WebP only, at most 5 MB. The MIME type is checked from magic bytes, not from the filename. The SHA-256 is stored.
- Read access is `GET /api/v1/media/{id}`, for the uploader or a manager and above, or with a signed query (`?exp={unix}&sig={HMAC(MEDIA_SIGNING_SECRET, id.exp)}`) for n8n and CRM links.
- The storage interface (`put`, `get`, `signedUrl`) allows a later switch to S3-compatible storage without changes elsewhere.

## 10. HTTP API

### 10.1 Conventions

- **Base path** `/api/v1`. JSON in and out, except media upload (multipart).
- **Auth:** an Auth.js session cookie for the rep and console, or `Authorization: Bearer {apiKey}` for integrations. Each route declares the roles or API-key scope it accepts; anything else gets 401 (not signed in) or 403 (wrong role).
- **Validation:** zod at the edge. A failure returns 400 with field-level details.
- **Errors:** `{ "error": { "code": "VALIDATION_FAILED", "message": "Readable sentence.", "details": [{ "path": "companyName", "message": "Required" }] } }`. Codes: `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_FAILED`, `CONFLICT`, `RATE_LIMITED`, `INTERNAL`.
- **Idempotency:** every rep mutation carries a client-generated UUID `clientId` in the body (visits, pings, media, shift and arrive actions). Repeating a request with the same `clientId` returns the original result with status 200. Console mutations accept an optional `Idempotency-Key` header, stored in `IdempotencyKey` for 24 hours.
- **Pagination:** `?limit=` (default 50, max 200) and `?cursor=` (an opaque ID). The response carries `{ items, nextCursor }`.
- **Times:** ISO-8601 UTC strings in and out. Local dates are `YYYY-MM-DD`.
- **Rate limits** (in-memory token bucket, single process): intake 120 requests per minute per key; login 10 per minute per IP; everything else 600 per minute per user.

### 10.2 Endpoints

**Auth and account**

| Method and path | Roles | Purpose |
| --- | --- | --- |
| `POST /invites` | Manager+ (Admin for non-rep roles) | `{ email, role, rep?: { name, timeZone, baseAddress, dailyCapacity? } }` returns `{ inviteUrl, expiresAt }` (valid 7 days) |
| `GET /invites/{token}` | Public | `{ email, role, valid }` |
| `POST /invites/{token}/accept` | Public | `{ name, password }` creates the user (and rep), then signs in |
| `GET /me` | Any | User, rep profile and client settings (`foregroundPingSeconds`, `arrivalRadiusMeters`, `vapidPublicKey`) |
| `PATCH /me/preferences` | Any | `{ theme?: "day" \| "dusk" \| "auto", mapsApp?: "apple" \| "google" }` |
| `POST /me/monitoring-ack` | Rep | Records acknowledgment of the location notice |
| `GET /users`, `PATCH /users/{id}` | Admin | Role and active flag |

**Rep app** (role REP; acts on the caller's own rep)

| Method and path | Purpose |
| --- | --- |
| `GET /rep/today?date=` | `TodayResponse` (10.4). `date` defaults to local today |
| `POST /rep/shift/start` | `{ clientId, location }` starts the shift, sets `onShift`, records a ping |
| `POST /rep/shift/end` | `{ clientId, location }` ends the shift and returns `{ remainingStops }` |
| `POST /rep/locations` | `{ pings: LocationPingInput[] }` (at most 100). Rejected unless on shift, except `END_DAY` |
| `POST /rep/assignments/{id}/arrive` | `{ clientId, location }` returns `{ distanceM, offSite }` |
| `POST /rep/assignments/{id}/skip` | `{ clientId, reason: "CLOSED" \| "UNSAFE" \| "OUT_OF_TIME" \| "OTHER", note? }` (P1) |
| `POST /rep/replan` | `{ location }` re-plans today from here and returns the `TodayResponse` |
| `POST /rep/visits` | `VisitCreate` (10.4) returns `{ visit, door: { status, nextStepAt } }` |
| `POST /media` | Multipart `file`, `clientId`, `kind`; returns `{ mediaId }` |
| `GET /media/{id}` | Uploader, Manager+, or a signed URL |
| `GET /rep/doors/{id}/history` | Past visits (P1) |
| `GET /push/vapid-public-key`, `POST /push/subscriptions`, `DELETE /push/subscriptions` | Subscription management |

**Console** (Viewer may call GETs; Manager+ for mutations unless noted)

| Method and path | Purpose |
| --- | --- |
| `GET /map/live?date=` | `{ reps: RepMarker[], doors: DoorPin[] }` for the map (10.4) |
| `GET /doors?status=&repId=&date=&q=&source=&cursor=&limit=` | Doors table |
| `GET /doors/{id}` | Door with company, assignments, visits (media URLs) and audit timeline |
| `PATCH /doors/{id}` | `{ priority?, qualificationNotes?, preferredVisitWindow? }`. Changing priority to HOT re-runs ASN-4 |
| `GET /review-queue` | `{ groups: [{ reason, count, items: DoorWithEvidence[] }] }` |
| `POST /doors/{id}/resolve` | `ReviewResolve` (10.4) |
| `POST /doors/{id}/assign` | `{ repId, date, reason? }` creates a manual assignment |
| `POST /doors/{id}/unassign` | `{ reason }` returns the door to `GEOCODED` without re-running the engine |
| `POST /doors/{id}/close` | `{ reason: "NO_VISIT" \| "MANUAL", note? }` |
| `GET /reps`, `GET /reps/{id}`, `PATCH /reps/{id}` | `PATCH` takes `{ name?, phone?, timeZone?, baseAddress?, dailyCapacity?, workdays?, dayStartLocal?, active? }`. A new `baseAddress` is geocoded synchronously; deactivating cancels open assignments and enqueues `door.assign` (reason `REP_CHANGE`) |
| `POST /reps/{id}/unavailability`, `DELETE /reps/{id}/unavailability/{date}` | `{ dates: string[], reason? }`. Open assignments on those dates are reassigned |
| `GET /reps/{id}/day/{date}` | Route, shift, pings (sampled) and visits for the rep day board |
| `POST /reps/{id}/replan` | `{ date }` |
| `GET /metrics?from=&to=&repId=&format=json\|csv` | P1 |
| `GET /settings`, `PUT /settings` | Admin. A partial map of registry keys, validated per key |
| `GET /api-keys`, `POST /api-keys`, `POST /api-keys/{id}/revoke` | Admin. `POST` returns the full key once |
| `POST /imports` | Admin. Multipart; returns an `ImportBatch` preview with per-row results (P1) |
| `POST /imports/{id}/commit` | Admin. Enqueues `import.commit` (P1) |
| `GET /outbox?status=FAILED`, `POST /outbox/{id}/retry` | Admin |
| `GET /jobs?status=FAILED`, `POST /jobs/{id}/retry` | Admin |
| `GET /audit?entityType=&entityId=` | Manager+ |

**Integration** (API key)

| Method and path | Scope | Purpose |
| --- | --- | --- |
| `POST /intake/prospects` | `intake:write` | One prospect (10.4) |
| `PATCH /integrations/crm-ids` | `crm:write` | `{ items: [{ entityType: "COMPANY" \| "DOOR" \| "REP", id, crmId }] }` |
| `GET /health` | Public | `{ ok, db, worker: { lastTickAt } }`. No sensitive data |

### 10.3 Authorization rules

- A rep can only read and write their own rep record, their own assignments, and the doors on those assignments. Any other ID returns 404, not 403, so IDs cannot be probed.
- A visit is accepted for a door the rep has an assignment for, now or in the last 7 days. Otherwise it is rejected with `FORBIDDEN`.
- Viewers see every GET in the console; every console mutation returns 403 for them.
- API keys can only call integration routes within their scopes.

### 10.4 Schemas (zod, abridged as TypeScript types)

```ts
// Shared
type LatLng = { lat: number; lng: number };
type Fix = LatLng & { accuracyM?: number; capturedAt: string };           // device time, ISO

// POST /intake/prospects
type IntakeProspect = {
  externalProspectId: string;                 // required, at most 100 characters
  companyName: string;                        // required
  companyWebsite?: string;
  companyAddress?: { street?: string; city?: string; state?: string; zip?: string };
  jobLocation?: { city?: string; state?: string };   // companyAddress or jobLocation is required
  workplaceType?: string;                      // "on-site", "ON_SITE", "hybrid", "remote" ...
  contact?: { name?: string; phone?: string; email?: string; linkedinUrl?: string };
  priority?: "normal" | "hot" | "NORMAL" | "HOT";
  qualificationNotes?: string;                 // at most 2000 characters
  preferredVisitWindow?: "morning" | "afternoon" | "evening";
  source?: "API" | "IMPORT";
};
type IntakeResult =
  | { status: "accepted"; doorId: string }                                  // 201
  | { status: "duplicate" | "merged"; doorId: string }                      // 200
  | { status: "do_not_knock" }                                              // 200
  | { error: ApiError };                                                    // 400 or 401

// GET /rep/today
type TodayResponse = {
  date: string; timeZone: string;
  shift: { id: string; startedAt: string; endedAt: string | null } | null;
  route: { planId: string | null; provider: "LOCAL" | "GOOGLE" | null; totalDriveMinutes: number | null;
           plannedFinish: string | null; updatedAt: string | null };
  stops: Array<{
    assignmentId: string; status: AssignmentStatus; routeOrder: number | null; plannedArrival: string | null;
    arrivedAt: string | null; outcome: Outcome | null;                     // set when completed today
    door: { id: string; name: string; companyName: string; priority: "NORMAL" | "HOT";
            address: string; lat: number; lng: number; qualificationNotes: string;
            preferredVisitWindow: VisitWindow | null; attempts: number; contactName: string | null;
            lastVisit: { recordedAt: string; outcome: Outcome; notes: string } | null };
  }>;
  pendingServerVersion: string;               // hash of the stop list; the client re-renders when it changes
};

// POST /rep/visits
type VisitCreate = {
  clientId: string;                           // UUID v4, generated on the device
  assignmentId: string; doorId: string;
  outcome: Outcome;
  decisionMakerPresent?: boolean;
  notes?: string;                             // at most 2000 characters
  nextStepAt?: string;                        // required for FOLLOW_UP and APPOINTMENT_SET; must be in the future
  photoMediaIds?: string[];                   // at most 3, uploaded first via POST /media
  signatureMediaId?: string;                  // required for SOLD
  location?: Fix;                             // missing only if permission was denied (then offSite = true)
  recordedAt: string;                         // device time the rep tapped "Save visit"
  formDurationS?: number;
};

// POST /rep/locations
type LocationPingInput = Fix & { clientId: string; source: "START_DAY" | "ARRIVED" | "VISIT" | "FOREGROUND" | "END_DAY" };

// POST /doors/{id}/resolve
type ReviewResolve =
  | { action: "ACCEPT_PLACES_CANDIDATE"; candidateIndex: number }
  | { action: "USE_COMPANY_ADDRESS" }                                       // accept despite a mismatch
  | { action: "EDIT_ADDRESS"; address: { street: string; city: string; state: string; zip: string } }
  | { action: "RETRY" }                                                     // re-run address.resolve
  | { action: "CLEAR_COVERAGE_GAP" }                                        // assign anyway (ignore the drive limit)
  | { action: "NO_VISIT"; note?: string };                                  // close the door
// Every action geocodes synchronously where needed and returns the updated door, or 400 with the geocode evidence.

// GET /map/live
type RepMarker = { repId: string; name: string; initials: string; onShift: boolean;
                   lat: number | null; lng: number | null; lastLocationAt: string | null;
                   freshness: "FRESH" | "AGING" | "STALE" | "NONE";    // <15 min, 15–120 min, >120 min, none
                   todayDone: number; todayTotal: number };
type DoorPin = { doorId: string; lat: number; lng: number; status: DoorStatus; priority: "NORMAL" | "HOT";
                 repId: string | null; routeOrder: number | null; name: string };
```

### 10.5 Apify LinkedIn job mapping (imports and pre-processing)

The console import (INT-5), and any n8n step that forwards Apify output, map each job object like this:

| Apify field | Intake field | Rule |
| --- | --- | --- |
| `id` | `externalProspectId` | As a string |
| `companyName` | `companyName` | |
| `companyWebsite` | `companyWebsite` | |
| `companyAddress.streetAddress`, `addressLocality`, `addressRegion`, `postalCode` | `companyAddress.street`, `city`, `state`, `zip` | `addressRegion` is a full state name; normalize it. A null `companyAddress` is allowed |
| `location.abbreviatedLocalizedName` ("San Diego, CA") | `jobLocation.city`, `state` | Split on the last comma |
| `jobWorkplaceTypes[0].workplaceTypeEnum` | `workplaceType` | |
| `recruiter.name`, `recruiter.profileUrl` | `contact.name`, `contact.linkedinUrl` | When present |
| `title`, `postedAt`, `link` | `qualificationNotes` | `"Hiring: {title}. Posted {YYYY-MM-DD}. Job: {link}"` |

Use `tests/fixtures/sample_apify_linkedin_jobs.json` (36 rows with labeled edge cases) as the import and intake fixture.

## 11. Security and privacy

- **Passwords:** argon2id, at least 10 characters, with a check against a list of common passwords. Login lockout is 10 failures in 15 minutes per account.
- **Sessions:** JWT in an HttpOnly, Secure, SameSite=Lax cookie. Reps stay signed in 30 days; other roles 7 days. Deactivating a user invalidates their sessions through the per-user `User.tokenVersion`, which is embedded in the JWT and checked on each request.
- **API keys:** 32 random bytes, base64url, with a `cvs_` prefix. Only the SHA-256 is stored; the full key is shown once.
- **Webhooks** are signed (9.3). Signed media URLs expire in 7 days.
- **Location:** pings are stored only during a shift and deleted after `location.retentionDays`. Reps cannot read other reps' locations. Viewing a rep's location history is audit-logged.
- **PII:** contact fields are visible only to roles that can see the door. Personal data never appears in URLs or query strings, except opaque IDs.
- **Headers:** a strict CSP (self, plus the OpenFreeMap tile and style hosts); `Permissions-Policy: geolocation=(self)`; HSTS.
- **Uploads:** size and magic-byte checks; files are served with `Content-Disposition: inline` and the stored MIME type only.

## 12. Configuration

| Variable | Required | Example or notes |
| --- | --- | --- |
| `DATABASE_URL` | Yes | `file:/data/canvass.db` |
| `AUTH_SECRET` | Yes | 32+ random bytes |
| `APP_BASE_URL` | Yes | `https://canvass.example.com` (invite links, signed URLs) |
| `GOOGLE_MAPS_API_KEY` | Yes | Geocoding, Places (New) and Routes APIs enabled; IP-restricted |
| `GOOGLE_CLOUD_PROJECT_ID`, `GOOGLE_APPLICATION_CREDENTIALS` | Only for `routing.provider = GOOGLE` | Service account JSON path |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Yes | `npx web-push generate-vapid-keys`; subject `mailto:ops@…` |
| `OUTBOUND_WEBHOOK_SECRET` | Yes | Shared with n8n |
| `MEDIA_SIGNING_SECRET` | Yes | |
| `UPLOAD_DIR` | Yes | `/data/uploads` |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` | First boot | `prisma/seed.ts` creates the first admin if no users exist |
| `NEXT_PUBLIC_MAP_STYLE_URL` | No | Defaults to the OpenFreeMap style; recolored client-side with tokens |
| `WORKER_ID` | No | Defaults to the hostname and process ID |

All variables are validated with zod at boot (`lib/env.ts`); the process exits with a readable error if any are missing.

## 13. Testing

**Unit tests (Vitest, `lib/domain`), required before each milestone closes:**

| Area | Cases |
| --- | --- |
| Normalization | State names to codes; ZIP+4; phone formats; "Road" equals "Rd" in `streetKey`; "Sunbelt Medical Billing LLC" equals "Sunbelt Medical Billing" in `companyKey` |
| Intake | New; duplicate ID; same company and street merges; same company at a different street creates a new door; company matched by domain; matched by name with a legal suffix; do-not-knock; validation errors |
| Address resolution | Company address in the job city; PO box resolved by Places; Places name below the threshold rejected; Places in a different city rejected; metro fallback at 23.2 miles; mismatch at 227.6 miles; remote; no address and no job city; low geocode quality; partial match |
| Assignment | Nearest by drive time; capacity overflow to the next rep; next batch when the shortlist is full; coverage gap over 120 minutes; no active reps; hot door same day on shift; before and after the cutoff in two time zones; skipping non-workdays and unavailability; revisit to the preferred rep over capacity; stale location falls back to the deployment base |
| Routing | Window buckets kept in order; hot first in its bucket; 2-opt never worse than nearest-neighbor; arrival waits for a window; late stops flagged, not dropped |
| Outcomes | Every row of 6.7, including the third not-home closing the door |
| Time | DST forward and back; workday rollover across a weekend |

**Integration tests** run against a temporary SQLite file with fake Google, push and webhook modules: the intake endpoint end to end with the 36-row fixture (expected statuses and reasons asserted); visit idempotency (the same `clientId` twice gives one visit); outbox signature and retry; rollover job.

**End to end (Playwright, mobile viewport):** a rep signs in, starts the day, goes offline (`context.setOffline(true)`), logs 3 visits including a photo, comes back online, and the server has exactly 3 visits; a manager resolves a review item and the door is assigned.

## 14. Moving to Postgres later

- Change the datasource provider. Convert string enums to native Prisma enums using `lib/domain/enums.ts` as the list, and JSON string columns to `Json`.
- Replace the single-lane job runner with `SELECT … FOR UPDATE SKIP LOCKED` claims and several workers, and move the rate limiter to the database or Redis.
- No API or domain changes are needed. That is why the domain layer stays free of Prisma.

## 15. Build order for Claude Code

1. **Scaffold:** Next.js, TypeScript strict, Tailwind v4 with `app/tokens.css`, Prisma with this schema, `lib/env.ts`, `lib/db.ts` with pragmas, seed admin, Vitest and Playwright set up.
2. **Domain first:** `lib/domain/*` with the full unit suite from section 13, before any UI.
3. **Auth and roles:** Auth.js credentials, invites, the role guard helper, audit logging.
4. **Jobs and outbox:** the worker process, enqueue helper, scheduler skeleton, outbox with signing. Fakes for Google.
5. **Intake and resolution:** the intake route, `address.resolve` handler, review queue API and console screen, doors table. Milestone M1.
6. **Assignment and routing:** the handlers, scheduler rules, reps API and console screens, rep day board. Milestone M2.
7. **Rep PWA:** manifest, service worker, IndexedDB outbox, Today, map, arrive, visit form, media upload, push, location pings, Settings. Milestone M3.
8. **Live map, metrics, imports, do-not-knock (P1),** then hardening: rate limits, CSP, backups, health check.

Each step ends with its tests green and a short note appended to `docs/CHANGELOG.md`.
