# Canvass handoff

## Getting started

```sh
npm install                 # also generates the Prisma client
cp .env.example .env        # then fill in secrets
npm run db:deploy           # create or upgrade the SQLite database from prisma/migrations
npm run db:seed             # first admin from SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD
npm run dev                 # web: http://localhost:3000
npm run worker              # worker: jobs, scheduler, outbound webhooks (second terminal)
npm test                    # unit + integration tests (Vitest)
npm run test:e2e            # Playwright; first time: npx playwright install chromium
npm run lint && npm run typecheck
```

**Schema changes:** edit `prisma/schema.prisma`, then `npm run db:migrate -- --name what_changed`. That writes a new folder under `prisma/migrations/` and applies it to your dev database. Commit the migration; containers apply it with `prisma migrate deploy` on boot.

**Running with Docker:** `docker compose up -d --build` starts `web` (applies migrations, seeds the first admin, serves on `CANVASS_PORT`, default 3000) and `worker`. They share the `canvass-data` volume at `/data`, which holds the database and uploads. Secrets come from `.env`.

Progress by build step is in `docs/CHANGELOG.md`.

Canvass (working name) is the door-to-door field app: a Next.js PWA for reps, a manager console, and an API, on Prisma with SQLite.

Copy this folder into the root of the new repository, then point Claude Code at it.

| File | What it is |
| --- | --- |
| `docs/PRD.md` | What to build: users, requirements with priorities and acceptance criteria, screens, milestones, open decisions |
| `docs/BACKEND_SPEC.md` | How it works: architecture, domain rules, jobs, integrations, the HTTP API, tests, and the build order |
| `docs/DESIGN_TOKENS.md` | How it looks: visual direction, tokens, status system, components, copy |
| `prisma/schema.prisma` | Data model (21 models, SQLite) |
| `app/tokens.css` | Design tokens for Tailwind v4: the code source of truth for the UI |
| `tests/fixtures/sample_apify_linkedin_jobs.json` | 36 sample prospects with labeled edge cases, used by the intake and import tests |

Suggested first prompt for Claude Code:

> Read README.md, then docs/PRD.md, docs/BACKEND_SPEC.md and docs/DESIGN_TOKENS.md. Follow the build order in BACKEND_SPEC.md section 15. Start with step 1 (scaffold) and step 2 (domain logic with its unit tests). Stop after each step, show me the test results, and append a note to docs/CHANGELOG.md.

The open decisions in PRD section 12 have defaults. Change them there before building if any default is wrong.
