# ADR 0019 — Learned Skills in SKILL.md format, generalized and independently supported

Status: implemented. Offline exposure measured; effect on review quality not yet measured.
Baseline: `feat/skill-governance` after ADR 0018.

## Context

A chained same-repository pilot (4 chains, 28 reviews) showed no measurable gain from
learned Skills. Manual inspection of the six learned Skills found the cause in extraction,
not governance:

- Four of six restated the source PR's concrete defect ("case notes") and would only fire
  if the same bug recurred in the same function.
- Paths were the source PR's exact files, and a reusable method was stored as a
  `repository_fact`, so path matching became a hard boundary. A parameter-validation lesson
  learned from one scikit-learn PR was invisible to the next PR adding the same kind of
  validation in another module.
- The catalog showed a narrow title and two conditions, so reviewers rarely opened bodies
  (7 exposures, 1 read).
- A run and the feedback on that same run counted as two supporting sources.

## Decision

1. **SKILL.md interchange format (`skill-md-1`).** The learner returns, per add or revise,
   `skill: { markdown, references? }`. The Markdown has YAML frontmatter (`name`,
   `description`, `type`, `scope`, `paths`, `languages`, `keywords`, `symbols`,
   `dependencyRefs`) and four list sections: *When to use*, *Procedure*, *Not a defect when*,
   *Stop when*. `references` holds at most two Markdown files of 2500 bytes. The host parses
   strictly into the existing structured content, so validation, hashing, similarity and
   eligibility are unchanged; storage stays content-addressed JSON.
2. **No scripts.** A reference with a code extension is refused. Reviews are read-only and
   must not execute learned code.
3. **Progressive disclosure in review.** The catalog shows only `name` and `description` for
   SKILL.md knowledge; `read_review_skill {id}` returns the rendered SKILL.md and the list of
   references; `read_review_skill {id, reference}` opens one reference after its body was read,
   within the same byte budget. Legacy Skills (no name and description) keep their frozen
   catalog entry and their original `{ skill }` body, so replays of old runs verify and read
   the same material.
4. **Generalize, then file the incident.** The prompt (`skill-md-1`) asks whether the Skill
   would catch the next instance of the mistake in a different file; the concrete incident
   goes to `references/example.md`. The description names change shapes that should trigger
   the Skill.
5. **Module scope for methods.** A SKILL.md `review_method` whose path ends in a file is
   refused; file-specific knowledge must be a `repository_fact`.
6. **Independence per reviewed change.** `attach_source` from a source on a change that already
   supports the Skill is a no-op. Run-derived experience becomes `active` after support from
   `INDEPENDENT_CHANGES_FOR_ACTIVE = 2` distinct changes; trusted feedback still activates directly.
7. **Envelope tolerance.** The Pi learner accepts a code fence, trailing text or bare
   operations around its JSON and records each repair in `format-repairs.json`; content is
   never repaired. Similarity (`skill-similarity-2`) also compares descriptions.

## Offline result

Same six learning sources, same model (`gpt-5.6-luna`, medium), new learner into a fresh bank:

| | Old learner | SKILL.md learner |
|---|---|---|
| Learning calls failed | 1 of 12 (semantic) | 0 of 12 (2 envelope repairs) |
| Test points with any visible Skill | 4 of 6 | 6 of 6 |
| Defect test points shown a Skill of the same defect class | 0 of 3 | 1 of 3 (#26229) |
| Skills with the incident moved to references | — | 2 of 5 |

A first attempt without envelope tolerance failed on 3 of 12 calls because of output shape,
which motivated item 7.

## Small end-to-end run

Twelve reviews with the relearned bank, each test point seeing the bank as it stood after
the previous chain case, against the earlier arms (2 runs per test point, 12 per arm):

| | No Skills | Old learner | SKILL.md learner |
|---|---|---|---|
| Defect test points found | 4/6 | 4/6 | 4/6 |
| Clean runs with a finding | 3/6 | 4/6 | 2/6 |
| Skill bodies read | — | 1 | 7 |
| Mean tokens per review | 127k | 131k | 143k |

This shows the pipeline works end to end and that reviewers now open learned Skills. It is
not a benchmark: two runs per point cannot separate the arms, and the clean-run change is not
attributable to a specific Skill. The remaining miss (#26229) read a Skill whose description
generalized to parameter validation while its procedure still followed the source incident
(array forms), so the capability constraint that caused the defect was not checked.

Reproduce outside the checkout with `eval/skills/chain.mjs`: `prepare`, `check`, `run` or
`watch` (quota-aware resume), `relearn --name B3`, `reach --banks B B3` (offline exposure) and
`bankrun --bank B3` (paired reviews with a relearned bank).

## Consequences

- Learned knowledge can be exported and read as ordinary Skill packages, and approvers see
  the same SKILL.md the reviewer reads.
- Some generalization remains incident-flavoured (symbols of the source function stay in
  frontmatter); the approver and curation remain the backstop.
