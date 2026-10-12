# Pilot runbook (milestones M4 and M5)

M4 is two reps for one week. M5 is all ten. This is the checklist for both. The code is finished; what remains is setup and watching.

## Before day one

- [ ] `.env` filled in from `.env.example`. Generate `AUTH_SECRET`, `MEDIA_SIGNING_SECRET` and `OUTBOUND_WEBHOOK_SECRET` as 32 or more random bytes each. Never reuse the example values.
- [ ] VAPID keys for push: `npx web-push generate-vapid-keys`, then set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` (a `mailto:` you read).
- [ ] `GOOGLE_MAPS_API_KEY` set, with Geocoding, Places (New), Routes and Route Optimization enabled. Without it the fakes are **not** used in production; geocoding fails and doors go to review.
- [ ] The site is served over HTTPS. Service workers, push and geolocation need it.
- [ ] `docker compose up -d --build`, then open `/health`. Both web and worker must be `ok`.
- [ ] Sign in as the seeded admin, change the password, and set the business time zone and shift hours in **Settings**.
- [ ] Create the intake API key and give it to n8n or Apify. Set up the CRM side with `docs/N8N_TWENTY.md`.
- [ ] Invite the pilot reps. Each sets a password, installs the app to the home screen, allows location and notifications, and acknowledges the monitoring notice.
- [ ] Set each rep's base address and working days.
- [ ] Do-not-knock list loaded (**Imports**), if you have one.

## Backups

Run nightly: `npm run backup` (or `node scripts/backup.mjs /path/to/backups`). It uses SQLite's online backup, so it is safe while the app runs, and copies uploads. It keeps the newest 14. In Docker:

```sh
docker compose exec web node scripts/backup.mjs /data/backups
```

Copy `/data/backups` off the machine. A backup on the same disk does not survive the disk. To restore, stop web and worker, replace `canvass.db` (and delete any `canvass.db-wal` and `-shm`), restore `uploads/`, and start again. Practice a restore once before the pilot. For continuous replication instead of nightly copies, Litestream on the same file also works; it needs no app changes.

## Each day of the pilot

- **Morning:** open **Review**. Clear the queue so those doors can be planned. Check **Map** that each rep has a route and has started.
- **During:** the live map shows each rep's last position and freshness. A grey ring means no ping for a while, usually a phone with location off.
- **Evening:** check **Settings → Failed jobs / outbox**. Anything there needs a retry or a fix. Rollover moves unfinished stops at 21:00 local.
- **Weekly:** **Metrics** and the pilot-health panel (`GET /api/v1/metrics/pilot`).

## Exit criteria

Take these from the pilot-health panel and PRD §10. Move from M4 to M5 only when all hold over the pilot week:

- Every visit a rep logged reached the server (no lost offline visits).
- No door stuck in review for more than one working day.
- Reps open the app and finish the day without calling for help more than once each.
- Visits and hot-door events reached Twenty and the CEO alert fired within a minute for each hot visit.
- A restore from backup has been tried and worked.

## If something breaks

- **Rep says their stops are missing:** re-plan from the rep's day board; check they are not marked unavailable.
- **Rep offline:** nothing to do. Their actions queue on the phone and send when signal returns; the banner shows the count.
- **Outbox failing:** the n8n URL or secret is wrong, or n8n is down. Fix it, then retry from Settings.
- **Google errors:** the planner falls back to the built-in estimate and the day board says so. Fix the key or quota; doors keep working.
