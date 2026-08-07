# Abu AI Software Factory — Mission Control

AI-operated software factory control plane with bounded autonomy and explicit
human gates for irreversible production risk.

## Factory flow

1. Intake and deterministic routing
2. AI planning with typed actions
3. Source-aware repository context
4. Isolated code generation and sandbox verification
5. Draft pull-request publication
6. QA/security verification
7. Staging-only database migration gates
8. SHA-bound human production approval
9. Verified production promotion
10. Production health monitoring and conservative rollback

Raw secrets, production data deletion, auth changes, and billing changes never
receive autonomous access.

## Autopilot

`POST /api/autopilot` advances safe work through bounded lifecycle steps.

Start a task:

```json
{ "request": "Analyze attendance export behavior", "projectId": "<uuid>" }
```

Resume a task:

```json
{ "taskId": "<uuid>" }
```

Use `Authorization: Bearer <FACTORY_API_TOKEN>`.

Every response includes a task snapshot and one next action:

- `done` — task completed
- `call_again` — another bounded invocation may continue
- `human_approval` — explicit Abu production approval required
- `human_review` — automation stopped safely

Autopilot takes at most one production health sample per invocation. This keeps
health streaks independent and prevents a single serverless request from
manufacturing a rollback decision.

## Safety boundaries

- Production deployment requires exact reviewed PR head approval.
- Production database writes/deletes remain blocked.
- Raw secret reads remain blocked.
- Code mutations publish draft PRs only.
- Staging database mutations are additive and staging-only.
- Rollback requires three consecutive unhealthy observations.
- Rollback targets only an older READY Vercel rollback candidate.
- Unsupported rollback plans/permissions escalate to a human.
- Unexpected autonomous resume states fail closed.

## Runtime configuration

Required core secrets/config:

- `DATABASE_URL`
- `FACTORY_API_TOKEN`
- `OPENROUTER_API_KEY`
- `GITHUB_CONNECTOR_ID`

Production approval:

- `FACTORY_APPROVAL_TOKEN`

Production monitoring:

- `VERCEL_AUTOMATION_TOKEN`
- `VERCEL_TEAM_ID`

Never commit real secret values.

OpenRouter's free router is acceptable for development/testing. It should not be
treated as a production reliability guarantee.

## HTTP control plane

- `GET /api/health` — readiness
- `POST /api/plan` — plan-only interface
- `POST /api/execute` — execute an already planned task
- `POST /api/approve` — separate production approval channel
- `POST /api/monitor` — one bounded production health observation
- `POST /api/autopilot` — bounded safe lifecycle driver

## Validation

Pull requests run:

```bash
npm ci
npm run typecheck
npm run build
npm test
```

## Build sequence

1. Mission Control foundation — implemented
2. Source-aware engineering context — implemented
3. Sandbox tests and repair — implemented
4. QA/security reviewer — implemented
5. Staging and database safety gates — implemented
6. Production deployment gates — implemented
7. Production monitoring and rollback — implemented
8. Autopilot and end-to-end hardening — final candidate
