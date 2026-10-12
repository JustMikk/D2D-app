# Testing guide: what's built so far

Three layers, from fastest to most realistic. Do them in order; stop at the first failure.

## 0. One-time setup

```sh
npm install
cp .env.example .env       # then edit; see below
npm run db:deploy          # creates data/canvass.db
npm run db:seed            # first admin from SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD
npx playwright install chromium     # only for layer 2
```

`.env` for local testing: replace the three secrets (`AUTH_SECRET`, `MEDIA_SIGNING_SECRET`, `OUTBOUND_WEBHOOK_SECRET`) with any 32+ character strings, keep `APP_BASE_URL="http://localhost:3000"`, and add `CANVASS_FAKE_GOOGLE=1` so geocoding, places and routing run on built-in fakes (no Google key needed; refused in production). Leave `VAPID_*` empty unless you test push (section H).

## 1. Automated checks (about 3 minutes)

```sh
npm run typecheck && npm run lint
npm test                     # about 340 tests: domain rules, API, jobs, outbox, offline sync, security
```

All green means the business rules hold: intake and dedupe, address resolution, assignment and routing, visits and outcomes, imports, do-not-knock, metrics, webhooks, CSP.

## 2. End-to-end in a real browser (about 2 minutes)

```sh
npm run test:e2e
```

This builds the app, starts web and worker on port 3100 with a fresh database, and runs a manager and a phone-sized rep through: sign-in, invite, intake, review queue, assignment, a full day with time spent in airplane mode (nothing lost), and CSP checks. Run the whole suite; the specs build on each other, so one alone may fail. Failures leave a trace: `npx playwright show-trace test-results/<folder>/trace.zip`.

## 3. Hands-on walkthrough (about 45 minutes)

Run web and worker in two terminals:

```sh
npm run dev        # http://localhost:3000
npm run worker
```

Use two browsers or profiles: a desktop one for the manager, and a phone (or Chrome DevTools device mode, Pixel 7) for the rep. For the phone to work as a real PWA, serve over HTTPS (a tunnel such as `cloudflared` or `ngrok`) and set `APP_BASE_URL` to that URL.

### A. Sign in and the shell
1. Open `/`, sign in as the seeded admin. You land on **Map**. Nav: Map, Review, Doors, Reps, Metrics, Imports, Settings.
2. Wrong password five times: the account locks for a while, and the error does not reveal whether the email exists.
3. Toggle the theme (day, dusk, auto). Primary buttons are blue with white text in day, and light blue with dark text in dusk.

### B. Reps and invites
1. **Reps → Invite**: name, email, time zone (try different ones, e.g. America/Chicago and America/Denver), base address, working days. Copy the invite link.
2. Open the link in the phone browser and set a password. You get the install guide and the location-monitoring notice, which must be acknowledged.
3. Create three reps in different time zones; the assignment checks below depend on it.

### C. Intake and review
1. **Settings → API keys**: create a key with `intake:write` (shown once). Then `KEY=cvs_...`
2. Post the 36-prospect fixture:
   ```sh
   curl -s -X POST http://localhost:3000/api/v1/intake/prospects \
     -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
     --data @tests/fixtures/sample_apify_linkedin_jobs.json
   ```
   Expect 34 accepted, 1 duplicate, 1 merged. Post it again: everything is a duplicate, nothing new is created.
3. Wait about a minute (the worker resolves addresses), then open **Doors**: most are Assigned or Scheduled; some are in **Review**.
4. **Review**: pick a door. Evidence (company address, Places match, job location) is side by side. Try each action: use an address, pick a candidate, enter an address by hand, close. A resolved door gets assigned within the minute.
5. **Doors**: click a row. The drawer shows the timeline. Try Assign, Reassign and Close with a reason.

### D. Assignment and routing
1. **Reps → a rep → a day**: the stops are in route order, with planned arrivals and drive time. Check the nearest rep took each door, no rep exceeds the daily capacity, and a rep marked unavailable gets none.
2. Press **Re-plan**; the order may change. Use the **Up/Down** arrows on a stop; the order changes and a toast confirms.
3. Mark a rep unavailable for a day: their stops move to a later day. Reassign and Unassign a stop.
4. **Settings**: change a tunable (e.g. daily capacity) and confirm it takes effect within 30 seconds.

### E. The rep on a phone
1. Open `/today` signed in as the rep. You see one big current-stop card (door-hanger style), **Up next**, and **Done**.
2. **Start day**, then **Navigate** (opens Google, Apple or Waze per your Settings choice) and **Arrived**. Arriving more than 200 m away flags the visit off-site.
3. Tap a stop, **Log visit**: pick each outcome in turn. Conditional fields appear (next-step date for follow-up, signature for sold). Add a photo (resized to 1600 px) and a signature.
4. **Details and skip**: skip a stop with a reason. It leaves Today and is re-queued to another day or rep.
5. As manager, add a hot door for a rep who is on shift. Today shows a "Just added" chip and the card swings in.
6. **End day**: unfinished stops are left; the 21:00 rollover moves them.

### F. Offline (the main promise)
1. With Today loaded, turn on airplane mode (or DevTools → Network → Offline).
2. Reload. Today still renders from cache. Arrive, log two visits, skip one. A banner shows the pending count.
3. Reconnect. The banner clears within seconds. On the manager side, exactly those visits appear, once each, with their original times. Repeat with DevTools "Slow 3G"; nothing duplicates.
4. Sign out while items are queued: you are warned about unsent work.

### G. Manager live view and imports
1. **Map**: rep markers with freshness rings, door pins by status, route lines, filters. It refreshes every 30 seconds. (Map tiles need internet.)
2. **Imports**: download the template, add a few rows (one duplicate, one with a bad zip), upload. The preview lists what will be created, merged and rejected; commit it, then check **Doors**.
3. **Do-not-knock**: add a company or domain. Matching open doors close, and posting the same prospect to intake is refused as `do_not_knock`.
4. **Metrics**: pick a date range; check the per-rep numbers against what you did in E, and export the CSV. The pilot-health panel shows the PRD success metrics.

### H. Push notifications (needs HTTPS and VAPID keys)
1. `npx web-push generate-vapid-keys`; put the keys in `.env`; restart web and worker.
2. In the rep's **Settings**, enable notifications. As manager, add a hot door for that rep. A push arrives within about a minute; tapping it opens Today. Without push, the app polls every 60 seconds.

### I. Webhooks and Twenty (see `docs/N8N_TWENTY.md`)
1. In n8n, activate "Canvass → Twenty" after its setup checklist. In Canvass **Settings**, set `webhooks.outboundUrl` to its webhook URL. The same `OUTBOUND_WEBHOOK_SECRET` must be in both places.
2. Post one new prospect. In n8n, watch executions: `door.created`, then `door.assigned`.
3. In Twenty, confirm the company and the door record exist. The `crm-ids` callback should make the next `door.upserted` carry a `crmId` (check `GET /api/v1/doors/{id}`).
4. Log a hot visit (appointment or sold): an opportunity and the Slack alert appear. Log a plain visit: a note appears. Nothing should appear twice.
5. **Settings → Failed outbox** lists anything undelivered, with a Retry button. Test it by breaking the URL, posting a prospect, then fixing the URL and retrying.
6. Bad signature: `curl -X POST <webhook-url> -d '{}'` must get 401.

### J. Security and resilience spot checks
- Page responses include a `Content-Security-Policy` with a per-request nonce, `X-Frame-Options` and `nosniff`. DevTools Console shows no CSP violations.
- Signed out: `curl -i localhost:3000/api/v1/doors` returns 401. As a rep, another rep's IDs return 404.
- `GET /api/v1/health` reports `ok` only while both web and worker are alive; stop the worker and it says so.
- `npm run backup -- data/backups`, then open the copy with any SQLite viewer.

## 4. Known gaps (do not expect these to work yet)
- The Docker image has not been built or run.
- Push delivery to a real phone and background location on iOS are untested.
- The n8n workflow has had no live event yet.
- Map tiles need internet; offline the map falls back to a list.

## 5. If something fails
- **Nothing gets assigned:** the worker is not running, or `CANVASS_FAKE_GOOGLE` is missing and no Google key is set. Check **Settings → Failed jobs**.
- **Port in use or odd Turbopack errors:** stop other `next` processes. `npm run test:e2e` uses port 3100 on purpose.
- **"database is locked":** two copies of the app on one database file. Run one web and one worker.
- **Tests leave junk:** delete `data/e2e*` and `.next-e2e`; they are rebuilt.
