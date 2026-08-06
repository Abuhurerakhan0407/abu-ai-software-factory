# AI Software Factory rules

These rules apply to every coding worker operating in this repository.

1. Inspect relevant code and tests before editing.
2. Never push directly to production or mutate production data.
3. Never print, copy, expose, or request raw secrets.
4. All code changes go through a branch/PR workflow once GitHub integration is enabled.
5. Run typecheck and relevant tests before declaring work complete.
6. Database changes must be explicit migrations with a rollback or recovery plan.
7. High-risk and critical actions must obey `src/policy/risk.ts`.
8. Never weaken a security or approval gate to make a test pass.
9. Keep orchestration/control-plane credentials outside worker sandboxes.
10. Prefer reversible changes and preserve audit events.
