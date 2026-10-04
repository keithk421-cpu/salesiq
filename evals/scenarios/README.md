# Scenario drafts
HELP (M1) scenarios live in `help/`, one JSON per moment, format in `SCHEMA.md`.
Every scenario starts with `"golden_approved": false`. Only Keith approves (sets true) after review; agents never do.
Keith reviews them as `docs/SCENARIO_REVIEW.md` (regenerate with `npm run scenarios:review` after any change).
The remaining EVALS.md categories (partial-vs-answered, next-step states, teammate inquiry -> buyer answer,
should've-stayed-quiet for proactive Coach) belong to M2/M3 and are drafted with those milestones.
