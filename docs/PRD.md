# Canvass — Product Requirements (v1)

| | |
| --- | --- |
| Status | Ready for build |
| Version | 1.0, October 2026 |
| Stack | Next.js (App Router) full stack, Prisma, SQLite (v1), installable PWA |
| Related | `docs/DESIGN_TOKENS.md` (UI contract), `docs/BACKEND_SPEC.md` (data model, API, jobs) |

Priorities: **P0** is required for the 2-rep pilot, **P1** is required before rolling out to all 10 reps, and **P2** comes later.

## 1. Summary

Canvass turns qualified prospects into a scheduled, routed day of door visits for about 10 field reps anywhere in the US. It captures each visit's outcome at the door and sends the results to the CRM (Twenty) and the CEO. It replaces Connecteam for this workflow. Reps use a mobile PWA; managers use a desktop console in the same Next.js app.

## 2. Why we are building it

Connecteam could deliver shifts with an address to a rep, but it has no dispatch logic, no map of the day's doors for the rep, and no route ordering. Its location data is limited to clock punches and batch breadcrumbs, and its forms cannot be pre-filled or reliably linked to a prospect. Every useful piece (assignment, routing, linking an outcome to a door) would have lived in n8n workarounds anyway.

A custom app owns the field workflow end to end. Twenty remains the CRM of record for companies and deal outcomes, and n8n remains the integration layer that keeps Twenty and the CEO alerts up to date.

## 3. Goals, non-goals and success metrics

### Goals

- **G1.** Every qualified prospect becomes a visitable door, assigned to the best rep, within 5 minutes of intake, or is flagged for review with a clear reason.
- **G2.** Reps spend their time knocking, not planning. The day is ordered automatically, navigation is one tap, and logging a visit takes under 30 seconds.
- **G3.** Outcomes reach the CRM and the CEO within a minute of being logged.
- **G4.** The app works with poor signal. No logged visit is ever lost.

### Success metrics

| Metric | Target | Measured from |
| --- | --- | --- |
| Intake to assignment, p90 | 5 minutes or less | `Door.createdAt` to first `Assignment.createdAt` |
| Doors resolved without manual review | 85% or more | Share of doors that never enter `NEEDS_REVIEW` |
| Time to log a visit, median | 30 seconds or less | "Log visit" opened to "Save visit" tapped |
| Visits synced within 60 seconds while online | 99% or more | `Visit.recordedAt` to `Visit.receivedAt` |
| Lost visits | 0 | Client queue audit against server visits |
| Outcome alert to CEO, p90 | 60 seconds or less | `Visit.receivedAt` to the outbox event marked sent |

### Non-goals for v1

- Continuous GPS tracking with the screen off. That needs a native wrapper (Capacitor); it is a phase-2 option.
- Commissions, payroll, payments or quotes.
- Drawing territories. Reps are deployable anywhere in the US, and assignment is purely by drive time.
- Multiple companies on one instance, or white-labeling.
- App-store distribution, chat between reps, and AI features.

## 4. Users and roles

| Role | Who | Device and context | Can |
| --- | --- | --- | --- |
| Rep | Field sales rep (about 10) | Own phone, outdoors, one hand, patchy signal, sometimes evening | See and work their own day; log visits; share location while on shift |
| Manager | Ops lead | Desktop, all day | Everything reps can see for all reps; resolve reviews; assign and reassign; manage reps |
| Admin | Owner, may be the same person as the manager | Desktop | Manager rights, plus settings, API keys, imports and user roles |
| Viewer | CEO | Desktop or phone | Read-only console (map, doors, metrics). Alerts arrive through Slack or email by way of n8n |

Permissions:

| Capability | Rep | Viewer | Manager | Admin |
| --- | --- | --- | --- | --- |
| Own day: start and end shift, arrive, log visits | Yes | | | |
| View all doors, reps and the map | | Yes | Yes | Yes |
| Resolve reviews; assign and reassign doors | | | Yes | Yes |
| Invite reps; edit rep profiles | | | Yes | Yes |
| Settings, API keys, imports, role changes | | | | Yes |

## 5. Concepts

| Term | Meaning |
| --- | --- |
| Prospect | A qualified lead from the prospecting workflow. Usually a LinkedIn job posting from a small company. |
| Company | The business behind one or more prospects (`Company` model). |
| Door | One visitable place for a prospect: a company at a street address. Several postings from one company at one address become one door. |
| Address resolution | Choosing and geocoding the visit address: the company address first, then a Google Places match in the job city, then a metro fallback, otherwise review. |
| Assignment | A door given to a rep for a specific local date. A door can have many assignments over its life (rollovers, re-visits). |
| Route | The ordered list of a rep's assignments for a day, with planned arrival times. |
| Visit | What happened at the door: outcome, notes, photo, GPS stamp and time. |
| Shift | A rep's working day, between "Start day" and "End day". Location is only collected during a shift. |
| Deployment base | Where a rep starts each day. It changes when a rep is redeployed to another city. |
| Hot door | A high-priority prospect, inserted into today's route for a rep who is on shift. |
| Review reason | Why a door needs a manager decision (section 4.3 of the design doc). |

## 6. Core journeys

### 6.1 Door lifecycle

1. The prospecting workflow (or an import) sends a prospect to the intake API.
2. Canvass validates and normalizes it, dedupes it, finds or creates the company, and creates a door with status `NEW`.
3. Address resolution picks and geocodes the visit address. The door becomes `GEOCODED`, or `NEEDS_REVIEW` with a reason.
4. The assignment engine picks the rep with the shortest drive time who has capacity on the target date. The door becomes `ASSIGNED`, or `NEEDS_REVIEW` (coverage gap), or `UNASSIGNABLE` if there are no active reps.
5. At 06:30 in the rep's time zone, the route planner orders the day. Doors become `SCHEDULED`, with a route order and planned arrival times.
6. The rep visits and logs the outcome. Outcome rules (section 7.7) set the next status and any follow-up.
7. Each change emits an event. n8n updates Twenty and alerts the CEO on appointments and sales.

### 6.2 A rep's day

1. Open the installed app. Today's route is already planned.
2. Tap "Start day". The app records a GPS fix and starts sharing location while the app is open.
3. Work through the stops: "Navigate" opens Apple or Google Maps, "Arrived" records a GPS fix, "Log visit" captures the outcome.
4. A hot door may arrive by push notification. It appears in the route at the best position.
5. Tap "End day". Any stops not visited move to the next working day.

### 6.3 A manager's day

1. Open the console map. See where reps are, today's doors by status and each rep's progress.
2. Clear the review queue: fix addresses, accept a candidate, or close doors that can't be visited.
3. Handle exceptions: reassign doors when a rep is out, and act on coverage gaps by deploying a rep or closing doors.
4. Check the metrics. The CEO gets the 19:00 digest automatically.

## 7. Functional requirements

### 7.1 Intake and import (INT)

| ID | Requirement | P | Acceptance criteria |
| --- | --- | --- | --- |
| INT-1 | An intake API accepts one prospect per request, authenticated with an API key. | P0 | `POST /api/v1/intake/prospects` with a valid key returns `accepted`, `duplicate`, `merged` or a 400 listing errors, as specified in the backend spec. A missing or revoked key returns 401. |
| INT-2 | Input is validated and normalized. | P0 | Full state names become two-letter codes; ZIP+4 becomes 5 digits; phones become E.164; "on-site" becomes `ON_SITE`. `externalProspectId`, `companyName`, and either a company address or a job location are required. |
| INT-3 | Duplicates are detected. | P0 | A repeated `externalProspectId` returns `duplicate` and changes nothing. A new ID for the same company and normalized street ("Rd" equals "Road") adds the posting to the existing door's notes and returns `merged`. |
| INT-4 | Companies are found or created. | P0 | Match by website domain, then by normalized name (legal suffixes such as "LLC" ignored). Otherwise create the company. |
| INT-5 | Admins can import Apify LinkedIn job JSON or a CSV from the console. | P1 | Upload, preview the counts (new, duplicate, merged, invalid, with reasons), then confirm. The same rules as the API apply. An import of 500 rows finishes in under 2 minutes, excluding address resolution. |
| INT-6 | A do-not-knock list. | P1 | Admins add a company or an address. Matching intake is rejected with `do_not_knock`, and any open doors that match close with that reason. |

### 7.2 Address resolution (ADR)

| ID | Requirement | P | Acceptance criteria |
| --- | --- | --- | --- |
| ADR-1 | Resolve the visit address by following these steps in order. | P0 | (1) Remote job: review, reason `REMOTE_JOB`. (2) A usable company address in the job city: use it. (3) Otherwise a Google Places search for the company in the job city; accept the top result only if it is operating, the name matches at 0.8 or better, and it is in that city and state. (4) Otherwise a usable company address within 30 miles of the job city. (5) Otherwise review, with `PO_BOX`, `MISSING_ADDRESS` or `LOCATION_MISMATCH`. The address source is recorded for every door. |
| ADR-2 | Geocode quality gate. | P0 | Rooftop and interpolated results pass. Center, approximate, or partial matches go to review with `LOW_GEOCODE_QUALITY`. |
| ADR-3 | Review evidence is stored. | P0 | A door in review stores what was tried (company address, job city, Places candidates with similarity, distance), so the console can show it side by side. |
| ADR-4 | Managers resolve reviews. | P0 | From the review queue: accept a candidate, edit the address (re-geocoded on save), mark it as no visit (closes the door), or retry. A resolved door goes back to assignment automatically. |
| ADR-5 | Thresholds are settings. | P1 | The name-match threshold and metro radius are editable in Settings. |

### 7.3 Assignment (ASN)

| ID | Requirement | P | Acceptance criteria |
| --- | --- | --- | --- |
| ASN-1 | Automatic assignment when a door becomes ready. | P0 | Candidates are all active reps. The origin is the rep's last location if under 2 hours old and on shift, otherwise their deployment base. Shortlist the 5 nearest by straight-line distance, then get drive times. The target date is computed in the rep's time zone. Take the fastest rep with capacity; if the shortlist is full, try the next 5. Drive time over the maximum (default 120 minutes) sends the door to review with `COVERAGE_GAP`. No active reps makes it `UNASSIGNABLE`. |
| ASN-2 | Target date rules. | P0 | A hot door goes to today if the chosen rep is on shift. Otherwise it goes to today if the door arrives before the 11:00 cutoff in the rep's time zone and today is a working day for that rep; otherwise to the rep's next working day. Days marked unavailable are skipped. |
| ASN-3 | Manual assign, reassign and unassign. | P0 | A manager picks a rep and a date. The engine never overrides a manual assignment. Every change is logged with the actor and a reason. |
| ASN-4 | Hot-door insertion. | P0 | A hot door assigned for today triggers a re-plan of that rep's route and a push notification within 60 seconds. |
| ASN-5 | Nightly rollover at 21:00 in each rep's time zone. | P0 | Unvisited assignments are marked rolled over, and the doors are reassigned through ASN-1 for the next working day. A door rolled over more than 3 times goes to review. |
| ASN-6 | Re-visits for follow-ups and appointments. | P1 | A door with a next-step date is assigned to the same rep on that date (or their next working day), during the 21:00 rollover the night before. If that rep is inactive, ASN-1 applies. |
| ASN-7 | Rep unavailability. | P1 | A manager marks dates a rep is off. That rep's open assignments on those dates are reassigned through ASN-1. |

### 7.4 Route planning (RTE)

| ID | Requirement | P | Acceptance criteria |
| --- | --- | --- | --- |
| RTE-1 | Morning plan at 06:30 in each rep's time zone. | P0 | Order the rep's assignments for today, starting from the deployment base at the rep's day start (default 09:00). Visits take 20 minutes by default. Preferred visit windows (morning, afternoon, evening) are respected where possible, and hot doors are never dropped. Store the route order, planned arrival and total drive time. |
| RTE-2 | Re-plan on demand. | P0 | The rep's "Re-plan from here" uses the current GPS fix as the start; the manager has a "Re-plan" button; a hot-door insertion re-plans automatically. Visited stops keep their order. |
| RTE-3 | Pluggable provider. | P0 | A local heuristic (nearest neighbor, then 2-opt, on road-factor-adjusted distances) is the default and needs no setup. Google Route Optimization can be switched on in settings. |
| RTE-4 | Route summary. | P1 | The rep and the manager see the stop count, total drive time, and planned finish time. |

### 7.5 Rep app (REP)

| ID | Requirement | P | Acceptance criteria |
| --- | --- | --- | --- |
| REP-1 | Invite and sign in. | P0 | A manager invites by email. The invite link sets a password. The rep stays signed in for 30 days. After first sign-in, an install guide shows the correct steps for iOS (Share, then Add to Home Screen) and Android. |
| REP-2 | Start and end the day. | P0 | "Start day" records a GPS fix and sets the rep on shift. "End day" records a fix, ends the shift, and warns when stops remain: "4 stops not visited. They'll move to your next working day." |
| REP-3 | Today screen. | P0 | Shows the current stop as a door-hanger card, an "Up next" list with planned arrival times, and a collapsed "Done" group with outcome chips. A List/Map toggle shows the route on a map with numbered stops. It renders from cache in under 1 second when offline. |
| REP-4 | Navigate. | P0 | Opens the rep's chosen maps app (Apple or Google, set in Settings) with the stop's coordinates. |
| REP-5 | Arrived. | P0 | Records a GPS fix and the distance to the door. Beyond 200 m, the rep is asked to confirm, and the visit is flagged off-site (never blocked). |
| REP-6 | Log visit. | P0 | Outcome is required (six large tiles). The other fields depend on the outcome: "Decision-maker present" (yes or no), notes, next-step date and time (required for follow-up and appointment set), photo (optional, compressed on the device to 1600px), and signature (required for sold). The GPS stamp is captured automatically. Saving works offline. Median completion is 30 seconds or less in usability testing. |
| REP-7 | Offline queue. | P0 | Every rep action (start, arrive, visit, end, location pings) is queued in IndexedDB and sent in order when online. It retries on reconnect, when the app opens, and every 30 seconds while visible. A visible banner shows the pending count. The server treats retries idempotently. Clearing the queue requires every item to be acknowledged. |
| REP-8 | Location while on shift. | P0 | A GPS fix is recorded at start, arrive, visit and end. While on shift with the app visible, the app sends a fix every 2 minutes. Nothing is collected off shift. An indicator reads "Sharing location while your day is on". |
| REP-9 | Push notifications. | P0 | Push is used for a new hot door, a re-ordered route, and a door removed from today. Push needs the installed PWA on iOS 16.4 or later; if it is unavailable, the app polls every 60 seconds while open. |
| REP-10 | Door history. | P1 | The stop detail shows previous visits (date, rep, outcome, notes) and the qualification notes. |
| REP-11 | Skip a stop. | P1 | The rep gives a reason (closed, unsafe, ran out of time, other). The stop leaves today and goes back to assignment. |
| REP-12 | Theme. | P1 | Day, dusk or automatic (dusk after local sunset). Settings also hold the maps app, notifications and sign out. |

### 7.6 Manager console (MGR)

| ID | Requirement | P | Acceptance criteria |
| --- | --- | --- | --- |
| MGR-1 | Live map. | P0 | Shows rep markers with a freshness ring, today's door pins by status, and the route line for a selected rep. Filters: date, rep, status. It refreshes every 30 seconds. |
| MGR-2 | Review queue. | P0 | Grouped by reason, oldest first. Each item shows the evidence (ADR-3) and offers actions (ADR-4). The queue count shows in the navigation. |
| MGR-3 | Doors table. | P0 | Search by company or address. Filter by status, rep, date and source. A detail drawer shows the door's fields, assignments, visits and a timeline from the audit log. |
| MGR-4 | Reps. | P0 | Invite, edit (name, phone, deployment base address with geocoding, time zone, daily capacity, working days, day start), and deactivate. A rep's open doors are reassigned when they are deactivated. |
| MGR-5 | Rep day board. | P0 | A rep's route for a date: stops in order with status and planned arrival. Actions: reassign a stop, unassign, re-plan. Drag-to-reorder is P1. |
| MGR-6 | Settings. | P0 | Admin only: assignment and routing tunables, working days, digest time and time zone, the route provider, and the outbound webhook URL (the secret is stored in the environment). |
| MGR-7 | API keys. | P0 | Admin creates a key, which is shown once with a copy button, and can revoke it. The list shows the name, prefix, last use and scopes. |
| MGR-8 | Metrics. | P1 | Per rep, per day and for a date range: doors visited, contacts (any outcome other than not home or bad address), appointments, sales, contact rate, drive minutes per visit. Exportable to CSV. |
| MGR-9 | Imports. | P1 | The INT-5 upload, preview and confirm flow, with a history of past imports. |

### 7.7 Outcome rules (OUT, P0)

| Outcome | Door after the visit | Other effects |
| --- | --- | --- |
| Not home | Attempts increase by 1. Under the maximum (default 3): back to `GEOCODED` and reassigned through ASN-1 for the next working day. At the maximum: `CLOSED`. | None |
| Not interested | `CLOSED` | None |
| Follow-up | `VISITED`, with `nextStepAt` set | Re-visit per ASN-6 |
| Appointment set | `VISITED`, with `nextStepAt` set to the appointment time | Hot event to the CEO; re-visit per ASN-6 |
| Sold | `CLOSED` | Hot event to the CEO, with the signature attached |
| Bad address | `NEEDS_REVIEW`, reason `BAD_ADDRESS` | Ops alert |

The assignment that the visit belongs to becomes `COMPLETED`. If a visit arrives for an assignment that has since been reassigned, it is still accepted (the rep was really there), flagged as an assignment mismatch, and the door's newer assignment is cancelled.

### 7.8 Notifications and CRM sync (NTF)

| ID | Requirement | P | Acceptance criteria |
| --- | --- | --- | --- |
| NTF-1 | Outbound events. | P0 | Events in the catalog (backend spec section 9.3) are posted to the n8n webhook URL with an HMAC signature. Delivery is retried with backoff for up to 24 hours, and failures are visible in Settings. |
| NTF-2 | CEO alerts. | P0 | Appointment set and sold emit a `visit.hot` event. n8n posts it to Slack #d2d-wins and emails the CEO. |
| NTF-3 | Daily digest. | P0 | At 19:00 in the configured time zone, a `digest.daily` event carries per-rep counts. n8n formats and sends it. |
| NTF-4 | Ops alerts. | P0 | `door.needs_review` and `door.unassignable` events, and outbox delivery failures, reach Slack #d2d-ops through n8n. |
| NTF-5 | Twenty sync. | P0 | n8n maps the events into Twenty: company upsert, Door Assignment upsert (by external prospect ID), a Note per visit, an Opportunity for appointments and sales. Canvass stores the returned Twenty IDs when n8n calls back (`PATCH /api/v1/integrations/crm-ids`). |

## 8. Screens

### Rep app (PWA)

| Screen | Key states |
| --- | --- |
| Sign in | Default; wrong password; offline ("Connect to sign in for the first time") |
| Set password (from invite) | Valid link; expired link; password rules |
| Install guide | iOS steps; Android prompt; already installed (skipped) |
| Today | Before the shift; on shift; hot door just added (highlighted); all done; no stops; offline banner; sync error |
| Map | Route with numbered stops; my location; no location permission |
| Stop detail | Notes; history (P1); off-site warning |
| Log visit (sheet) | Outcome tiles; fields depending on the outcome; photo; signature pad; saving offline |
| Settings | Theme; maps app; notifications on or off; sign out |

### Manager console

| Screen | Key states |
| --- | --- |
| Live map | Reps fresh, stale or off shift; empty day |
| Review queue | Grouped by reason; empty ("No doors need a decision") |
| Doors | Table; filters; detail drawer with timeline |
| Reps | List; invite dialog; edit drawer; deactivate confirmation |
| Rep day board | Route; re-plan; reassign dialog |
| Metrics (P1) | Date range; per-rep table; CSV export |
| Imports (P1) | Upload; preview; result |
| Settings | Tunables; schedule; integrations; API keys; event delivery log |

## 9. Non-functional requirements

| Area | Requirement |
| --- | --- |
| Devices | iOS Safari 16.4 or later, installed to the home screen (required for push); Android Chrome (current and previous major version). The console supports current Chrome, Edge and Safari at 1024px and wider. |
| Performance | The rep Today screen is interactive in under 2 seconds on a mid-range Android over 4G, and renders from cache in under 1 second offline. Rep-facing API calls respond in under 300 ms at p95 on the server. |
| Offline | All rep actions after sign-in work offline. Today's route, door details and the map tiles for the route's bounding box are cached at the start of the day. |
| Reliability | No visit is lost: client queue, idempotent server, and a daily database backup. The outbox guarantees at-least-once delivery of events. |
| Time zones | All timestamps are stored in UTC. "Today", cutoffs and schedules are computed in each rep's IANA time zone. The digest uses its own configured time zone. |
| Privacy | Location is collected only during a shift, kept for 90 days (configurable), and visible only to managers, admins and viewers. Reps get a written monitoring notice at their first sign-in and must acknowledge it. |
| Security | Role-based access on every route; API keys stored hashed; webhook payloads signed; uploads limited to images up to 5 MB; audit log for all manager and admin actions. |
| Accessibility | WCAG 2.2 AA, with AAA body contrast in the rep app (see the design doc). |
| Scale (v1) | 10 to 25 reps, up to 1,000 new doors a day, on one server with SQLite. The schema is portable to Postgres without model changes. |

## 10. Product analytics

Log these as rows in an `AnalyticsEvent` table (or the audit log) for v1; no third-party tracker.

`rep.day_started`, `rep.day_ended`, `rep.arrived` (distance and off-site flag), `rep.visit_form_opened`, `rep.visit_saved` (duration in the form, outcome), `rep.navigate_tapped`, `rep.replan_requested`, `rep.offline_queue_flushed` (count, age of the oldest item), `mgr.review_resolved` (reason, action, time in queue), `mgr.door_reassigned`.

## 11. Milestones

| Milestone | Contents | Done when |
| --- | --- | --- |
| M0 Foundations | Repo, Prisma schema, auth and roles, design tokens and UI primitives, settings, audit log | A manager can sign in and invite a rep; tokens render in both themes |
| M1 Intake and resolution | INT-1 to 4, ADR-1 to 4, review queue, doors table, outbox and events | The 36-row sample file posted to intake yields the expected statuses and review reasons |
| M2 Assignment and routing | ASN-1 to 5, RTE-1 to 3, reps screen, rep day board, scheduler | Doors from M1 are assigned and routed for 3 test reps in different time zones |
| M3 Rep app | REP-1 to 9, outcome rules, live map | A rep completes a full day on a phone, including 30 minutes in airplane mode, with nothing lost |
| M4 Pilot | 2 real reps for 1 week; n8n sync to Twenty and CEO alerts live | Pilot exit criteria from the implementation plan met |
| M5 Rollout | P1 items, all 10 reps | Two weeks with no lost visits and the review queue cleared daily |

## 12. Open decisions

| # | Decision | Default in this spec |
| --- | --- | --- |
| D-1 | Sign-in method | Email and password via invite link. Magic links can replace it once an email provider is set up. |
| D-2 | Where intake comes from | The prospecting workflow posts to Canvass directly. The n8n WF1 and WF2 workflows are retired, because Canvass now performs intake, dedupe and address resolution. n8n keeps CRM sync and alerts. |
| D-3 | Route provider | Local heuristic by default. Google Route Optimization is optional; it needs a Google Cloud service account, because it does not accept API keys. |
| D-4 | Hosting | One small VPS or container host with a persistent volume for SQLite and uploads. Serverless platforms are not suitable for SQLite. |
| D-5 | Maximum drive time before a coverage gap | 120 minutes |
| D-6 | Working days, day start, cutoff | Monday to Saturday, 09:00 start, 11:00 cutoff, all per rep |
| D-7 | Digest time zone | America/Chicago at 19:00 |
| D-8 | Can reps see other reps on the map? | No |
| D-9 | Test data already loaded in Twenty (`TEST-` doors and `.example` companies) | Delete it before the first real sync |
