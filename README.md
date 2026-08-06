# Abu AI Software Factory — Mission Control V1

First production-oriented foundation for Abu's AI-operated software company.

## What works now

- Typed task intake and validation
- Deterministic task routing
- Risk classification
- Approval gates for production-impacting work
- Hard block on raw-secret access
- Audited task state machine
- Persistent local task store
- OpenAI Agents SDK planner using OpenRouter's free router for development
- Codex engineering-worker adapter
- Workspace-only Codex writes with network disabled
- Vercel Sandbox provider with restricted egress
- Sandbox executable allowlist
- Automated policy and orchestration tests

## Run locally

Requirements: Node.js 22+.

```bash
npm install
npm test
npm run typecheck
npm run dev -- "Build attendance export"
```

AI planning currently uses OpenRouter's free router for development. Configure
`OPENROUTER_API_KEY` as a secret and leave `MISSION_CONTROL_MODEL=openrouter/free`.
Never commit a real key.

The free router is for development/testing, not our production reliability target.

## Current boundary

Mission Control V1 does not touch GitHub, production databases, or deployment providers yet. Those arrive behind scoped tools in following phases.

## Build sequence

1. Mission Control foundation — current phase
2. Codex engineering worker + isolated sandbox — implemented
3. GitHub branch/PR + CI integration — next
4. QA/security verification
5. Staging/deployment gates
6. Monitoring, auto-repair, and rollback
7. Autonomy evaluation
