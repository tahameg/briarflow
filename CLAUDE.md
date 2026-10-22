# CLAUDE.md

@AGENTS.md

## Claude Code specifics

- Agent definitions live in `.claude/agents/`: `ux-designer`, `lead-developer`,
  `backend-developer`, `frontend-developer`, `tester`.
- The main session is the orchestrator. Subagents cannot spawn other agents, so the lead
  developer "orchestrates" by writing task breakdowns in `docs/tasks/phase-N.md`, and the
  main session dispatches those tasks to the right agent.
- Run independent agents in parallel only when they own disjoint packages.
- After each agent finishes, the orchestrator verifies with `npm test` and
  `npm run typecheck` before marking work done in `docs/STATUS.md`.
- Do not commit unless the user asks.
