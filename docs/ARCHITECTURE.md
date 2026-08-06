# Mission Control V1 architecture

## Purpose

Mission Control owns task intake, routing, risk classification, approvals, state transitions, and audit history. Coding workers and runtime sandboxes remain separate execution layers.

## Trust boundaries

1. **Control plane:** Mission Control, policy engine, task state, approvals, audit events.
2. **Execution plane:** coding workers and sandboxes. They receive only task-scoped access.
3. **Production plane:** deployed SaaS applications and production databases. Workers do not receive permanent unrestricted credentials.

## V1 flow

`request -> triage -> plan -> policy gate -> execute -> verify -> stage -> deploy -> monitor -> complete`

High-risk actions pause for explicit approval. Raw-secret access is blocked. Illegal state jumps fail closed.

## Persistence

Local development uses an atomic JSON task store. Production will swap the `TaskStore` interface for PostgreSQL/Supabase without changing Mission Control behavior.

## Engineering worker boundary

Engineering work now uses two swappable contracts:

- `EngineeringWorker` owns AI coding behavior.
- `SandboxProvider` owns isolated command execution.

Codex runs with workspace-only writes and network disabled by default. Vercel Sandbox starts with restricted egress and an executable allowlist. Mission Control does not pass production credentials into either boundary.

## Next integration

Phase 3 makes GitHub the code-change source of truth: short-lived repository access, branch creation, PR creation, CI status, and diff capture. Mission Control will dispatch work but will not share its own control-plane credentials.
