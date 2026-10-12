# Changelog

## 2026-10-09 — Build step 7: the rep app (milestone M3)

M3's done-when ("a rep completes a full day on a phone, including 30 minutes in airplane mode, with nothing lost") is covered by `tests/e2e/m3.spec.ts`, which drives the real app on a Pixel 7 viewport:

1. The rep signs in, acknowledges the location notice, and Today shows 3 planned stops. The service worker takes control and caches the app.
2. Start day, online. The server records the shift.
3. Airplane mode (`context.setOffline`). Reloading the app still renders Today from cache: **246 to 829 ms** from reload to the current stop in the runs so far, against the 1 second target.
4. Offline, the rep:
   - marks arrival at stop 1 (the phone is far from the pin, so the app asks to confirm, as specified), then logs "Not home";
   - logs a follow-up on stop 2, with a missing date refused, a date, notes, "decision-maker: yes" and a photo;
   - logs a sale on stop 3, with the missing signature refused, then a drawn signature;
   - ends the day.
   The banner reads "Offline. 3 visits will sync when you're back online." The server has received nothing, and everything survives another reload.
5. Back online, it syncs by itself. The server ends up with **exactly 3 visits** (one per door), with the arrival, the off-site flag, notes, the photo, the signature (a signed link serves a real PNG), the shift end, and the right door states (`GEOCODED` after a not-home, `VISITED` with a next step, `CLOSED` after a sale). The manager's live map shows "3 of 3 done" and a recent location.
6. The rep opens the map, switches to Dusk and Apple Maps in Settings, and signs out (allowed because nothing is left to sync).

**Backend** (`lib/services/repApp.ts`, `visits.ts`, `media.ts`; routes under `/api/v1/rep`, `/media`, `/push`):
- Every rep action is idempotent on its `clientId`: a repeat returns the original result with status 200. Shift start and end, arrival and pings use the stored-response table; visits and media use their unique `clientId` columns. Two simultaneous copies of a visit save one.
- Times come from the phone (`recordedAt`), clamped to at most 5 minutes in the future, because an action queued offline is synced later. A visit's rules (next step in the future, signature for a sale) are judged at the moment the rep tapped Save, not when it synced.
- A visit for a stop that was reassigned or rolled over meanwhile is accepted, flagged `assignmentMismatch`, and the door's newer assignment is cancelled. A door a manager already closed stays closed, and the visit is still kept. A stop from another rep or the wrong door is 404 (so IDs cannot be probed). A stop more than 7 days old is refused.
- Outcome rules, events (`visit.recorded`, `visit.hot` with signed photo and signature links, `door.needs_review`), the not-home reassignment, and audit rows (`rep.day_started`, `rep.day_ended`, `rep.arrived`, `rep.visit_saved`, which cover most of the PRD §10 analytics).
- Media: JPEG, PNG or WebP by magic bytes, at most 5 MB, stored under `UPLOAD_DIR/yyyy/mm/`; readable by the uploader and console users, or by a signed 7-day link.
- Pings are accepted only on shift (END_DAY always). A late ping outside a shift is ignored and counted, never an error, so a queued ping can't wedge the app's queue.
- Push: subscriptions (a device moves to whoever signed in on it last), the `push.send` handler (a 404 or 410 removes the device, 5 failures remove it, no VAPID keys means it quietly sends nothing), and the polling fallback in the app.
- `POST /rep/replan` re-plans from the rep's location with the built-in planner only, so the phone never waits on Google.

**The app** (`components/rep`, `lib/rep`, `public/sw.js`):
- **Offline outbox** (`lib/rep/outbox.ts`, IndexedDB via `idb`): every action is written first and sent later, in order. Items leave the queue only after the server acknowledges them. A visit and its photos are queued in one transaction.
- **Sync engine** (`lib/rep/sync.ts`): classifies each failure.
  - Network error, 5xx, 408 or 429: stop and retry later.
  - 401: stop and ask the rep to sign in again; nothing is lost.
  - Other 4xx: the item is marked failed, shown with the server's message, and retried when the rep taps the banner.
  Consecutive pings go as one batch (at most 100). It runs on open, on reconnect, when the app comes to the front, every 30 seconds while visible, and right after the rep does something, one at a time across tabs.
- **What the rep sees** (`lib/rep/overlay.ts`): the last server data with the rep's queued actions applied, so a started day, an arrival or a saved visit shows immediately and never flickers back when a refetch lands first.
- **Screens:**
  - Today: the door-hanger card with the swing animation, Up next, a collapsed Done group, and the location indicator.
  - Stop detail, Map (MapLibre with OpenFreeMap tiles in token colors), and Log visit (outcome tiles, then only the fields that outcome needs; photos compressed on the phone to 1600 px; a signature pad).
  - Start day, End day (with the "stops will move" warning) and Re-plan.
  - Off-site arrival confirmation, the offline, syncing and failed banners, the install guide for iOS and Android, and Settings (theme, maps app, notifications, sign out).
- **Location:** a fix is taken at start, arrival, visit and end of day, and every 2 minutes (the setting) while the day is on and the app is visible. Nothing is collected off shift.
- **Service worker** (`public/sw.js`, hand-written): built assets are cached on first use; the Today page is network-first with a 4 second timeout and a cached fallback; map tiles are cached; push notifications; and the page asks it to cache what it just loaded, so even the first visit works offline. The backend spec §1 is updated: Serwist's Next plugin is tied to webpack, and Next 16 builds with Turbopack.
- **Install:** `app/manifest.ts`, generated icons (`scripts/make-icons.mjs`, no image dependencies), iOS web-app metadata.
- **Offline map:** at the start of the day the app prefetches the tiles around the route (up to 300 tiles, zooms 11 to 15) and loads the map code, so the service worker holds them. If the map can't start, the rep gets a plain message and the list always works.

**Manager live map** (`GET /map/live`, `/console/map`, now the console home):
- Rep markers with a freshness ring (solid under 15 minutes, dashed up to 2 hours, none beyond) and the day's progress.
- Door pins by status, each with an ink outline; hot pins get a halo. The route line for a selected rep.
- Filters for date, rep and status, a 30-second refresh, and side lists (review count, reps with day-board links, the selected rep's route) so the map is never the only way to reach anything.

**Tests:** 283 Vitest tests (unit and integration) and 5 Playwright tests. The offline engine has 22 unit tests against a fake IndexedDB: order, a connection lost mid-way, a lost acknowledgment resent with the same `clientId`, each failure class, batching, and the overlay. The rep API has 29 integration tests.

**A concurrency bug found by a flaky browser test, and fixed.** In one full run the intake API answered 500, and the same test passed on three reruns. The cause was SQLite itself, not the test:
- The web app and the worker are two processes writing to one database. Prisma's SQLite adapter begins every transaction as deferred, so a transaction that reads and then writes can be overtaken by the other process's commit. SQLite then refuses the write at once (`SQLITE_BUSY_SNAPSHOT`), and the 5-second busy timeout never applies to that case.
- This could have hit any of the read-then-write transactions in intake, assignment, visits and rollover, so it would have surfaced in production as rare, unexplained 500s.
- `tests/integration/contention.test.ts` reproduces it with two connections: the transaction fails without the fix.
- `lib/db.ts` now retries an interactive transaction when SQLite reports busy: up to 6 attempts, with a short growing pause. Only busy errors are retried (Prisma reports them as `P1008` with the SQLite code), any other error goes straight to the caller, and batch transactions pass through. The contention tests cover recovery, giving up after repeated conflicts, no retry for ordinary failures, and batches.
- Because the whole transaction function re-runs, everything inside one must be safe to run twice. They all are: the only side effects are database writes, which roll back, and Google calls already happen outside transactions by design.
- Also added `closeDb()`, so test and shutdown cleanup never creates a client just to close it.

Decisions and things to know:
- **Settings moved into the app.** The rep app is one page (`/today`) with Today, the map and Settings inside it, so after the first load moving between them needs no network. `/settings` redirects to it.
- **Ending the day does not move the stops at once.** They stay on today's route until the 21:00 rollover, so a rep who taps End day by mistake can start the day again. The warning text ("They'll move to your next working day") is still true.
- **Offline cache belongs to one person.** If someone else signs in on the same phone, the cache is cleared. Sign-out is blocked while anything is unsynced, with a message saying how many items are waiting.
- **Hanger tab:** the stop number uses `text-title-l` below the hole, because 40px display type cannot fit under the hole in a 64px tab. The design doc is updated.
- **Not covered by an automated test:** the 2-minute location pings and push delivery to a real device. The pings run on a timer the browser test can't wait for (the setting's minimum is 30 seconds), and push needs real VAPID keys and a real device. Both are covered at the unit and integration level. The map's tile loading needs the internet, so the browser test accepts either the map or its "not available" message.
- **Still to do:** the remaining PRD analytics events that only the phone knows (form opened, navigate tapped, queue flushed), skip a stop (P1), and door history on the stop sheet (P1; the last visit already shows).

## 2026-10-09 — Build step 6: assignment and routing (milestone M2)

M2's done-when ("doors from M1 are assigned and routed for 3 test reps in different time zones") is covered by `tests/integration/m2.test.ts`. It uses reps in Dallas (Central, capacity 8), Denver and Seattle, with the clock at 09:00 Dallas, 08:00 Denver and 07:00 Seattle, and the 36-row sample file. Results:

- 20 doors assigned: 18 in the Dallas–Fort Worth area, 1 in Denver and 1 in Seattle.
- 10 doors out of range (Austin, Lubbock, Atlanta, Phoenix, Chicago and Tampa) go to review as coverage gaps, each naming the nearest rep and the drive time. The 4 address problems from M1 stay in review.
- Dallas gets 8 doors a day, and the overflow goes to later working days.
- Routes are planned for each rep's own today. Dallas starts now (it is past 09:00 there); Denver and Seattle start at their own 09:00 (15:00Z and 16:00Z). Later days stay `ASSIGNED` until their own 06:30 plan.
- The 21:00 rollover moves unvisited doors to later days, counts the rollover, sends a door moved too often to review (`ROLLOVER_LIMIT`), and ends a shift still open.

`tests/e2e/m2.spec.ts` runs the manager flow in a browser: a rep is invited with a located base, a prospect is assigned to the nearest rep, then the rep is edited (capacity, day off), the stop is reassigned and unassigned from the day board, and a setting is saved, with an invalid value refused.

- **Assignment** (`lib/services/assignment.ts`, `door.assign`):
  - Loads reps, their load per date and their days off, asks the pure engine for a decision, and applies it in one transaction.
  - Invariant 1 holds: a new ACTIVE assignment cancels any other for the door.
  - Emits `door.assigned` and `door.upserted`, and enqueues a re-plan when the date is the rep's own today.
  - A hot door for today also queues a push: "New hot door: Bluebonnet Dental, 2.1 mi away".
  - No active reps gives `UNASSIGNABLE` with a `door.unassignable` event. A new or reactivated rep re-tries those doors.
- **Route planning** (`lib/services/routes.ts`, `route.plan`):
  - The start is an explicit fix, else the rep's fresh location while on shift, else the deployment base at the rep's day start.
  - The built-in planner is the default. With `routing.provider = GOOGLE` it calls Route Optimization and falls back to the built-in planner on any failure, recording why in the plan.
  - Visited stops keep their order, and a re-plan continues after them.
  - It writes the `RoutePlan` row, route orders and planned arrivals, moves doors to `SCHEDULED`, and emits `door.upserted`.
  - The rep gets a "Your route changed" push for manager and new-door re-plans only. The scheduled plan, a rep's own re-plan and a hot door (which has its own push) do not.
- **Rollover** (`lib/services/rollover.ts`, `rollover.rep`): as specified, plus revisits. The scheduler now enqueues `route.plan`, `rollover.rep` and the digest.
- **Reps** (`lib/services/reps.ts`, `/reps`, `/reps/{id}`):
  - Edit the profile. A new base address is geocoded synchronously, and an address that cannot be found is refused.
  - Deactivation ends the shift, cancels open assignments, signs the rep out and sends their doors back through assignment (`REP_CHANGE`). The admin path in `PATCH /users/{id}` does the same.
  - Days off cancel and reassign the affected doors (ASN-7).
- **Invites geocode the base** when they are created, so the manager sees a bad address at once and the rep is assignable on accepting.
- **Manual assignment** (`POST /doors/{id}/assign` and `/unassign`):
  - May exceed capacity, is never overridden by the engine, and is audited with actor and reason.
  - Needs a located, open door and an active rep, and the date cannot be in the past.
  - Unassigning returns the door to Ready without re-running the engine.
- **Marking a door hot** (`PATCH /doors/{id}`) re-runs the hot-door rules:
  - For today's stop: re-plan, plus a push if the rep is on shift.
  - For an engine-assigned later stop: back through assignment.
  - A manager's own assignment is left alone.
- **Day board** (`GET /reps/{id}/day/{date}`, `POST /reps/{id}/replan`):
  - Route, shift, sampled location points and over-capacity flag.
  - Viewing location history is audit-logged (`rep.location_viewed`, backend spec §11).
  - Re-plan is queued, because request handlers never call Google.
- **Console:**
  - Reps screen: today's progress, an edit sheet, days off and the day board.
  - Day board: date navigation, summary chips (stops, drive minutes, planned finish, late stops, over capacity, shift, Google fallback), re-plan, reassign and unassign.
  - Doors drawer: assign, reassign and unassign.
  - Settings: every tunable in six groups, saved as a batch (changed values only, invalid ones named per field), worker, webhook and secret status, failed events and jobs with retry, and API keys.
- **Tests:** 221 Vitest tests (unit and integration) and 4 Playwright tests.

Where the spec was open, or where I chose differently:

- **Overflow in assignment (changed, and `docs/BACKEND_SPEC.md` §6.4 is updated).** As written, a full local rep plus a distant rep with room sent the door to the distant rep and then flagged a coverage gap naming that rep. Now only reps within the drive limit compete. A full in-range rep takes the door on a later day, and a coverage gap is raised only when no rep is in range, naming the nearest.
- **Revisits** (§8.3 updated): next steps that are overdue are included, so a missed day never strands a follow-up. A visited door whose preferred rep is inactive is not handled yet, because the rollover only runs for active reps. It goes back through `unassignable.retry` only if it becomes unassignable.
- **Bug found by the e2e test:** every sheet used the same element id for its title, so with several on one page the dialog's accessible name pointed at the wrong heading. Each sheet now has its own id.
- **Job runner:** claims only types with a handler (step 5), so `push.send` jobs queued now wait for step 7.
- **Not built yet:** the real-matrix option for the built-in planner (`routing.useRouteMatrix`, P1), drag-to-reorder on the day board (P1), and the live map on the day board (step 7; the board shows the number of location points for now).

## 2026-10-09 — Build step 5: intake and resolution (milestone M1)

M1's done-when ("the 36-row sample file posted to intake yields the expected statuses and review reasons") is covered by `tests/integration/m1.test.ts`. It posts all 36 rows to the real route with an API key and runs the worker's `address.resolve` jobs against a city-level fake of Google. Results:

- 34 accepted, 1 duplicate (Bluebonnet), 1 merged (Cedar Ridge).
- 30 `GEOCODED`:
  - 2 by metro fallback: Trinity (Irving office, Fort Worth job) and Bridgewater.
  - 1 by Places: Sunbelt's PO box.
  - 27 from the company address.
- 4 `NEEDS_REVIEW`:
  - Red River: `LOCATION_MISMATCH`, Grand Prairie against Houston, more than 200 miles.
  - Silverline (no street), Rangeway (no ZIP) and Copperfield (no address): `MISSING_ADDRESS`.

`tests/e2e/m1.spec.ts` runs the same flow in a browser: an admin creates a key, three prospects are posted, the worker resolves them, and the manager clears the queue.

- **Intake** (`POST /intake/prospects`, `lib/services/intake.ts`):
  - API key with `intake:write`, limited to 120 requests a minute per key.
  - The domain pipeline runs over a Prisma `IntakeStore` in one transaction, together with the `address.resolve` enqueue, the `door.created` and `door.upserted` events, and an audit row.
  - Responses: 201 accepted; 200 duplicate, merged or `do_not_knock`; 400 with field details.
- **Address resolution** (`lib/services/addressResolution.ts`, the `address.resolve` handler):
  - Google is called outside the transaction, and the result is written only if the door is still `NEW`, so repeated or duplicated jobs are harmless.
  - A resolved door becomes `GEOCODED`, with a `door.assign` job queued for step 6. A door sent to review gets `NEEDS_REVIEW` with its evidence and a `door.needs_review` event.
- **Review queue** (`GET /review-queue`, `POST /doors/{id}/resolve`, console Review screen):
  - Doors are grouped by reason, oldest first, with the evidence beside them: company address, job city, distance, the Places candidates tried and why each was rejected, geocode quality, coverage.
  - All six actions work. Addresses a manager chooses are geocoded synchronously and rejected unless rooftop or interpolated.
  - Resolving is audited with the reason, the action and the minutes the door waited (PRD §10 `mgr.review_resolved`). The review count shows in the nav.
- **Doors** (`GET /doors`, `GET` and `PATCH /doors/{id}`, `POST /doors/{id}/close`, console Doors screen):
  - Search by company, address or prospect ID, filter by status and source, page with a cursor.
  - The detail drawer shows fields, assignments, visits and the audit timeline, with actions to mark hot or normal and to close.
- **API keys** (`/api-keys`, console Settings screen): admins create keys (shown once, with a copy button) and revoke them. The list shows name, prefix, scopes, last use and status.
- **CRM IDs** (`PATCH /integrations/crm-ids`): `crm:write`. Each item is applied on its own and reports `updated`, `unchanged`, `not_found` or `conflict`.
- **Local demos without a Google key:** `CANVASS_FAKE_GOOGLE=1` swaps in the city-level fake (`lib/integrations/google/cityFake.ts`). A production build accepts it only when `APP_BASE_URL` is localhost.
- **E2E:** runs start the worker beside the production build (`tests/e2e/startWorker.ts`) on the same throwaway database.
- **Tests:** 189 Vitest tests (unit and integration) and 3 Playwright tests.

Fixes and decisions:

- **Unhandled job types wait:** the runner now claims only job types it has a handler for. `door.assign` jobs from M1 wait in the queue for the step 6 handler instead of failing.
- **`ignoreDriveLimit` on `door.assign`:** added for the review action "Assign anyway" (`CLEAR_COVERAGE_GAP`).
- **Forms keep input after errors:** React 19 resets a `<form action>` after the action runs, which wiped what a manager had typed when an address was rejected (found by the e2e test). The review, invite and API-key forms now submit with `onSubmit`.
- **Audit entities:** added `COMPANY`, for CRM ID updates.
- **Not yet built:** a manager marking a door hot does not yet re-plan a rep's day (ASN-4); that comes with the assignment engine in step 6.

## 2026-10-09 — Build step 4: jobs, outbox, worker, Google clients

- **Jobs** (`lib/jobs.ts`, `worker/runner.ts`):
  - Every job type in §8.1 has a zod payload schema. `enqueue()` validates the payload and ignores duplicate `dedupeKey`s.
  - The runner is one lane and sequential, with atomic claims, so two racing runners still run each job once.
  - Backoff is 15 s × 2^attempts, capped at 30 minutes, and a job is `FAILED` at `maxAttempts`.
  - Jobs with an unknown type or a bad payload, and `PermanentJobError`s, fail at once.
  - Stale locks (over 5 minutes) go back to the queue at boot and every minute.
- **Scheduler** (`worker/scheduler.ts`):
  - `dueJobs()` is pure and tested across time zones: route plan at 06:30 on workdays, rollover at 21:00 every day (both in the rep's zone), digest at 19:00 in the digest zone, and maintenance at 03:00 server time.
  - Catch-up works as specified: "at or after the time, and not done yet".
  - Only job types with a registered handler are scheduled. Today those are `digest.send`, `retention.cleanup` and `unassignable.retry`; the rest arrive with their steps.
- **Outbox** (`lib/events.ts`, `worker/outbox.ts`):
  - `emit()` writes the §9.3 envelope inside the caller's transaction. Snapshot builders cover `DoorSnapshot` and `VisitSnapshot` (media URLs signed for 7 days), and `buildDigest` covers the daily digest.
  - Delivery sends the signed headers (`X-Canvass-Event`, `-Delivery`, `-Timestamp`, `-Signature: v1=HMAC-SHA256`). It retries 10 times (30 s up to 8 h, about 24 hours in all), then marks the event `FAILED`.
  - Events wait as `PENDING` until `webhooks.outboundUrl` is set.
  - A failing event does not block later ones; each retries on its own schedule. This is a deliberate reading of "in order of creation", so one bad event cannot hold up the CEO alerts behind it for a day.
- **Worker process** (`npm run worker`, `worker/index.ts`): runner every 1 s, scheduler every 60 s (it also writes a heartbeat), outbox every 10 s, and stale-lock recovery every 60 s. On SIGTERM it finishes the current job before exiting. `GET /health` now reports `worker.ok` and `lastTickAt` (stale after 3 minutes).
- **Google** (`lib/integrations/google/*`):
  - Geocoding, Places Text Search (New), computeRouteMatrix and optimizeTours, each a typed function returning the domain's shapes, plus `fakeGoogle()` for tests.
  - All calls have a 10-second timeout, one retry on 5xx or a network error, and a latency log.
  - Geocoding quota and key errors throw, so the job retries rather than sending the door to review.
  - Field names were checked against Google's current docs on 2026-10-09. Places uses `pageSize`, since `maxResultCount` is deprecated. Route Optimization needs OAuth (service account). Missing zero-value indexes are read as 0.
- **Admin API:** `GET /jobs`, `POST /jobs/{id}/retry`, `GET /outbox`, `POST /outbox/{id}/retry` (audited).
- **Deployment:**
  - `Dockerfile` and `docker-compose.yml`: `web` applies migrations, seeds and serves; `worker` waits for web's database health check. Both share the `canvass-data` volume.
  - The Compose config validates, but the image has not been built here because Docker Desktop was not running.
  - The database is now managed by Prisma migrations (`prisma/migrations/0001_init`, generated with `migrate diff`). Integration and e2e tests build their databases with `migrate deploy`, so every test run checks the migrations.
  - The local dev database was baselined with `migrate resolve --applied 0001_init` after confirming it matched the schema exactly.
- **Tests:** 175 Vitest tests (unit and integration) and 2 Playwright tests.
  - Outbox tests post to a real local HTTP server and verify the signature the way n8n will.
  - The 10-retry schedule is walked one step at a time, then an admin retry is checked.

Changes to the handoff:

- **Schema:** added `Job.key` (indexed). The spec clears `dedupeKey` when a job finishes, so the scheduler had no way to tell "ran today" from "never ran"; a restarted worker would have rerun the day's rollover. `key` is kept after completion.
- **Heartbeat:** the worker heartbeat is stored as the reserved AppSetting row `_worker.heartbeat`. The settings registry ignores it on read and refuses it on write.
- **Seed:** with no users and no seed credentials, the seed now warns instead of failing, so the web container still boots.

## 2026-10-09 — Build step 3: auth, roles, audit (milestone M0)

M0's done-when ("a manager can sign in and invite a rep; tokens render in both themes") is covered by the Playwright test `tests/e2e/m0.spec.ts`. In it, an admin signs in, invites a rep, and the rep sets a password on a phone viewport, acknowledges the location notice and lands on Today. The test also checks the action color: `#1565C0` with white text in day, `#5B9BF0` with `#11181D` text in dusk.

- **Auth** (`auth.ts`, `lib/auth/*`, `lib/services/auth.ts`):
  - Auth.js 5.0.0-beta.32 with Credentials and JWT sessions.
  - Passwords use argon2id. The policy is at least 10 characters, not on a common-password list, and not the user's email.
  - On every request, `validateSession` checks that the user is active, the JWT's `tokenVersion` matches, and the role-based expiry (reps 30 days, others 7) has not passed.
  - Sign-in is limited to 10 attempts per minute per IP.
  - Lockout: 10 failures in 15 minutes per account. Failures are counted from `auth.login_failed` audit rows, so the lockout survives restarts without a schema change. Unknown emails still run an argon2 check, so a failed sign-in takes the same time either way.
- **Invites** (`lib/services/invites.ts`):
  - Managers invite reps; only admins invite other roles.
  - Only the token's SHA-256 is stored. A link lasts 7 days and works once; accepting claims the invite atomically, so two simultaneous accepts cannot both succeed.
  - Until an email provider is set up (D-1), the console shows the link once, with a copy button.
- **API layer** (`lib/api/*`):
  - The `route()` wrapper handles session roles, API-key scopes (`cvs_` keys, SHA-256 lookup, last use recorded) and "viewer may read".
  - It also handles the per-user, per-key or per-IP token bucket, zod parsing of body and query, `Idempotency-Key` replay for console mutations (24 hours), and the §10.1 error envelope.
  - `audit()` writes the AuditLog rows.
- **Settings** (`lib/settings.ts`): per-key zod schemas over the domain defaults, a 30-second cache, and audited updates. A patch with any invalid key is rejected whole.
- **Endpoints:**
  - `POST /invites`, `GET /invites/{token}`, `POST /invites/{token}/accept` (signs in)
  - `GET /me`, `PATCH /me/preferences`, `POST /me/monitoring-ack`
  - `GET /users`, `PATCH /users/{id}`
  - `GET` and `PUT /settings`
  - `GET /health` (worker status arrives in step 4)
- **UI** (`components/ui/*`, `lib/ui/status.ts`):
  - Primitives: Button, Chip, StatusChip, OutcomeChip, Field, Input, Select, Sheet (on `<dialog>`), Toast and ThemeSwitcher.
  - Status, outcome and review-reason constants from design doc §4.
  - Theme: a cookie gives server-rendered `data-theme`. Without a cookie, the user's saved preference applies, otherwise the OS setting.
- **Screens:**
  - Sign in (wrong password, lockout and offline states)
  - Set password from an invite (expired and used states)
  - Rep: the monitoring notice (its interval and retention come from settings), a Today placeholder, and Settings (theme, sign out)
  - Console: the shell, and Reps (field reps, pending invites, console team, invite sheet, admin deactivate and reactivate)
- **Tests:** 136 Vitest tests (unit and integration) and 2 Playwright tests.
  - Integration tests run each file against its own copy of a freshly pushed SQLite template.
  - E2E runs use a production build in `.next-e2e` (so they can run beside a developer's `next dev`) and a new database file per run. That file is created by a plain, non-destructive `prisma db push`; Prisma blocks `--force-reset` when an AI agent runs it, and resetting isn't needed.

Changes to the handoff:

- **Schema:** added `Invite.data` (JSON). It holds the rep profile from the invite until the rep accepts. `INVITE` was added to the AuditLog entity types.
- **Tokens:** added a `scrim` token (sheet and modal backdrop) to `app/tokens.css` and design doc §3.2.
- **Users:** `PATCH /users/{id}` refuses to turn a rep into a console user or the other way round; the two are set up differently, so invite a new account instead. It also refuses to demote or deactivate the last active admin.
- **Deferred to step 6:** deactivating a user sets `Rep.active = false` now, but reassigning their open doors waits for the assignment engine. Geocoding a rep's deployment base also waits for the reps screen in step 6.

## 2026-10-09 — Build steps 1 and 2: scaffold and domain layer

**Step 1, scaffold.** Next.js 16.4 (App Router, TypeScript 5.9 strict), Tailwind 4.3 importing `app/tokens.css`, Overpass via `next/font`, Prisma 7.10 on SQLite, zod 4, Luxon, Vitest 5, Playwright, ESLint 9.

- Prisma 7: the datasource URL moved to `prisma.config.ts`, the client is generated into `lib/generated/prisma`, and `lib/db.ts` connects through the better-sqlite3 adapter. The models are unchanged.
- `lib/db.ts` exposes a lazily created client, `db()`, and `dbReady()`. The client applies `journal_mode=WAL`, `busy_timeout=5000`, `synchronous=NORMAL` and `foreign_keys=ON`; all four were verified against a real database.
- `lib/env.ts` validates the environment with zod. `parseEnv(keys)` validates a subset (used by the seed); `env()` validates everything. Empty values count as unset.
- `prisma/seed.ts` creates the first admin (argon2id) only when no users exist, and writes an audit row.
- ESLint enforces design §11.4: no raw hex and no Tailwind palette colors in `app/` or `components/`. It also keeps `lib/domain` pure: no Prisma, Next.js, React or `fetch`.
- Version choices: TypeScript 5.9 instead of 7.0 (the new native compiler, not yet supported by the lint tooling), ESLint 9 for `eslint-config-next`, and Prisma 7.10 because npm's `latest` tag points at an 8.0 release candidate.

**Step 2, domain layer** (`lib/domain/`, 98 unit tests passing):

| Module | Spec | Notes |
| --- | --- | --- |
| `enums.ts` | §4.3 | `as const` arrays, zod enums and types for every enum field, plus weekdays and skip and assign reasons |
| `settings.ts` | §7 | Registry defaults as plain values; `lib/settings.ts` (step 3) layers the stored overrides on top |
| `normalize.ts` | §6.1 | Includes `isPoBox`, which also accepts "P.O. Box" (norm turns it into "p o box") |
| `geo.ts`, `time.ts` | §6.4, §6.8 | Haversine, drive estimate, Luxon local-day helpers; DST tested for America/Denver 2026 |
| `intake.ts`, `apify.ts` | §6.2, §10.4, §10.5 | Pipeline runs against an `IntakeStore` port; the service implements it with Prisma in one transaction. The 36-row fixture gives 34 accepted, 1 duplicate, 1 merged |
| `addressResolution.ts` | §6.3 | Geocode and Places injected; the metro-fallback geocode is reused for the quality gate |
| `targetDate.ts`, `assignment.ts` | §6.4, §6.5 | Drive times injected; a failing matrix falls back to the estimate per rep |
| `routing/local.ts` | §6.6 | Window buckets, hot first, nearest-neighbor, then 2-opt |
| `outcomes.ts` | §6.7 | Returns a door patch and effects; also `visitFieldErrors` for REP-6 |

Interpretations where the spec was open:

- **Company match (INT-4):** try the domain first, then fall back to the name key when the domain is present but unmatched.
- **Intake validation:** "company address or job location is required" means a company street or city, or a job city.
- **Assignment, all reps full:** pick the fastest rep's first workday with room, within 14 days. The drive-time limit still applies. If no rep has room, the door goes to review with `COVERAGE_GAP`.
- **Assignment, no deployment base:** reps without a base are dropped. If no reps remain, the door is `UNASSIGNABLE`.
- **Revisits:** a next-step date in the past is moved to today, and the preferred rep's next workday is used from there.
- **Routing, unwindowed doors:** each joins the windowed bucket whose stops it is nearest to. If no door has a window, all doors form one bucket.
- **Routing, 2-opt:** a pass accepts every improving reversal. Passes stop when a full pass improves the total by 1% or less.
- **Routing, late stops:** a stop arriving after 20:00 local is marked late, and the plan is `PARTIAL`.
- **Review evidence:** added `note` and `reportedAt` fields for the rep's bad-address report.

## 2026-10-09 — Primary color changed from orange to blue

- The single action color is now **Interstate blue** `#1565C0` (dusk `#5B9BF0`), replacing Safety orange `#FF5A1F` (dusk `#FF6B33`).
- Text on the action color is now white in the day theme (5.75:1). Ink on Interstate blue fails (2.88:1) and is not allowed. Dusk keeps `#11181D` on `#5B9BF0` (6.31:1).
- Hot doors follow the action color: blue tab and blue map halo, plus a `flame` badge so hot pins stay distinct from blue "scheduled" pins. `hot-text` is `#0D47A1` (8.63:1 on paper).
- Mailbox blue `#1F4E8C` is unchanged and stays reserved for route lines, links, focus rings and the "Assigned" and "Scheduled" statuses.
- Primitives renamed: `--orange-*` replaced by `--signal-100/400/600/800`.
- Files: `docs/DESIGN_TOKENS.md` (§3.1–3.4, §8.1, §8.2, §8.8) and `app/tokens.css`.

## 2026-10-09 — Step 8: P1 features and hardening

- **Security:** per-request nonce CSP from `proxy.ts` (`lib/security/csp.ts`), plus static headers (nosniff, frame, HSTS, referrer, permissions) from `next.config.ts`. `/sw.js` is never cached. The e2e suite fails on any CSP violation.
- **Imports (INT-5, MGR-9):** CSV/JSON upload with dry-run preview, then commit as a worker job. Limits 5 MB and 2000 rows. Migration `0002_import_batches` adds the preview payload. Template CSV download.
- **Do-not-knock (INT-6):** rules by domain, company, or address; matching open doors are closed and later intake is refused. Managed from the Imports screen.
- **Metrics (MGR-8):** per rep per day and range, CSV export, and a pilot-health panel for the PRD success metrics (`/api/v1/metrics`, `/metrics/pilot`).
- **Skip stop and door history (REP-10, REP-11):** skipping needs a reason and re-queues the door for a different rep or day (`avoid` on `door.assign`). Stop detail shows prior visits when online.
- **Analytics events (PRD §10):** the phone queues `rep.visit_form_opened`, `rep.navigate_tapped` and `rep.offline_queue_flushed`; sent in batches of 50.
- **Reorder (MGR-5):** Up and Down buttons per open stop on the day board (`PUT /reps/{id}/day/{date}/order`). Buttons rather than drag, so keyboard and touch work.
- **Auto theme at sunset:** `lib/ui/sunset.ts` computes dusk from the rep's last position; checked against a published sunrise/sunset API for Dallas.
- **Privacy:** pings and analytics events are discarded on sign-out and when another person signs in on the same phone. Real work (visits, skips) is never discarded.
- **Backups:** `npm run backup` (SQLite online backup plus uploads, keeps 14).
- **Docs:** `docs/N8N_TWENTY.md`, `docs/PILOT_RUNBOOK.md`.

Decisions:
- Ending a day does not move its unfinished stops; the 21:00 rollover does.
- `POST /media` still accepts a body with no Content-Length (proxies may chunk uploads); the 5 MB cap is enforced after reading.
- Not verified here: the Docker image build (Docker Desktop was off), push delivery to a real device, and map tiles offline of the internet. n8n and Twenty workflows are described, not built.

## 2026-10-09 - Door snapshot additions for Twenty

- `company.address` (street, city, state, zip) is now in every DoorSnapshot, so n8n can create a Twenty company with the real address.
- `nextStepDate` (YYYY-MM-DD in the rep time zone, or the business zone when unassigned) is now in every DoorSnapshot. Twenty date-only field: the UTC date of `nextStepAt` could shift an evening appointment to the next day.
- Added `docs/TESTING_GUIDE.md`.
