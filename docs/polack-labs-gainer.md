# Polack Labs Mass Gainer

The existing Fitia MCP owns the deterministic `polack_labs_mass_gainer_v1`
recipe in `packages/core/src/gainer/recipe.ts`. No client should remember or
reconstruct its numbers. Nutrition and prices are defined once beside the
ingredient quantities; the base totals are derived from that table.

## Calculation

Sweeteners are separate from the base mix. Resolve the configured sweetener
first, then compute:

```text
honey grams = configured tablespoons × configured grams per tablespoon
sweetener nutrition = honey grams / 100 × honey profile per100G
calorie scale = (target kcal − sweetener kcal) / base-mix kcal
```

`calories` uses an explicit `targetCaloriesKcal`, or the live day's remaining
calories if omitted. `fitia_optimal` (initial default) uses the same `summary()`
core service as `fitia-day-summary`, in process, once per calculation. It requires
complete diary coverage, goals and consumption for all four metrics. Its internal
`GREEN_RANGE_LOWER` / `GREEN_RANGE_UPPER` define 90–110% of each target as green.
This is an explicit MCP convention, not inferred from or experimentally verified
against Fitia's UI. The calorie ceiling is green max minus consumed calories;
being above the central target does not automatically rule out a drink.

The deterministic search includes no drink (no sweeteners either), exact green
boundary scales, and whole-gram rounding transitions. At ordinary daily budgets
it covers every practical nutritional serving. Work is bounded to 1024 transition
steps per ingredient for unusually large targets, plus neighbors of every green
boundary. Recipe proportions and configured sweeteners remain fixed.

Candidates are scored using the **practical** nutrition also returned for logging.
For each metric, normalized shortfall below green costs 1, excess above green
costs 0.5, and being outside green adds 0.05. Calories have weight 4; each macro
has weight 1. When a metric was already high, its existing excess is a constant
and further increments cost 0.1 rather than 0.5; more protein never earns a reward.
Inside green there is zero nutritional penalty. Added kcal / calorie target
costs another 0.005. Normalization uses max(target, 1), including zero targets.
All weights and tolerances live in `optimizationPolicy` and are returned for
explanation. Candidates are ordered by size; score differences within 1e-6 keep
the smaller serving. Both exact and practical calories must fit the upper band.
This is a transparent weighted compromise, not a clinical optimization or a
strict lexicographic guarantee about the number of green metrics.

All four metrics green after a drink returns `recommended`; the best beneficial
compromise returns `acceptable`. Existing top-level statuses are preserved.
`optimization.outcome` distinguishes `all_green`, `best_available`,
`limited_by_calories`, `not_needed` (already all green) and `not_beneficial`
(zero drink wins). The latter two use `not_recommended` and a null log payload.
Unknown inventory or incomplete automatic budgeting
returns `needs_input`. Honey alone over the target returns
`sweetener_exceeds_target`, its excess, and the maximum honey grams that would
fit, using upper-band headroom in optimal mode. Configured sweeteners are never
silently replaced or reduced. Explicit targets are accepted only in `calories` mode.

Additive response fields: `greenRanges` (target/min/max per metric, null if goals
are incomplete) and optimal-only `optimization` (outcome, before/after states,
improvedMetrics, enteredGreen, leftGreen, calorie headroom, scores/penalties,
policy, candidate count and practical validation). State keys use the same macro
names as nutrition. `improvedMetrics` means an initially low metric increased;
`enteredGreen` identifies deficits actually resolved. `targetCaloriesKcal` remains
the central remaining/explicit target for client compatibility; drink nutrition
reports the selected portion, and `optimization.maxAdditionalCaloriesKcal`
reports the different upper-band budget.

Exact quantities drive primary nutrition. Practical solids and small liquids
round to whole grams/ml; water rounds to tens of ml. Creatine remains the fixed
recipe amount whenever there is mix. `practicalNutrition` and
`practicalProjection` use the independently rounded ingredients and honey.
In `calories`, rounding may slightly exceed the requested amount and produces a
warning. Optimal candidates are rechecked against the calorie green max after
rounding, and never selected on the assumption that a warning permits an excess.
The exact/practical cost is a known base-mixture subtotal: honey, stevia,
creatine and water prices are not supplied, so `totalPen` is null.

The honey fallback is explicitly `standard_reference`, not a product label.
Change its complete profile and grams per tablespoon through config-update
when the actual label is available. Cinnamon and vanilla nutrition are excluded
because no labels were provided; their quantities and costs are included.
Stevia and creatine contribute zero kcal/macros in this model.

## Tools

### Night serving and carryover

After optimal batch sizing, `servingStrategy` is `single_serving` through the
saved `maxNightCaloriesKcal` (default 750), including the 700–750 band. Above it,
`split_next_morning` evaluates whole percentages of the practical blended batch.
It prefers the fraction nearest `preferredNightCaloriesKcal` (default 700),
reserving at least 100 kcal for morning where feasible. A larger night portion
may be chosen if another low metric enters green without making another metric
high and the remainder stays substantial. The maximum always applies. Around a
1400 kcal batch this can approach half; very large batches still respect the
night cap, so morning may be larger. There is no separate morning limit yet.

New split fields are `fullBatch`, `nightPortion`, `morningCarryover`,
`nightProjection`, `nightOptimization`, `servingReason`, `servingPolicy`,
`carryoverDraft`, `carryoverId`, `nightMealLog`, `morningCarryoverMealLog`,
`preparation` and `projectionScope`. Fractions refer to the weight of the fully
blended finished batch, not a final volume inferred from water. All ingredient
weighing remains in whole units. Portion macros are practical batch totals times
the chosen fraction; the morning remainder is subtraction rounded to six decimals,
so the two portions conserve the batch. Creatine is divided with the mixture.

Legacy `optimization.before/after/outcome` and `maxAdditionalCaloriesKcal` use the
corrected planning basis in optimal mode. Full-batch projections remain hypothetical
whole-batch results on the source day; `nightProjection` uses that same calculation
basis for the night fraction. Use the explicit projections below to distinguish
planning from actual Fitia registration.
`suggestedMealLog` safely aliases **only nightMealLog**, and `exactMealLog` is null
for a split. Both separate log payloads use normal `fitia-meal-log`, independent
preview/confirmation and stable keys. Their suggested meal slots are dinner and
breakfast. No food or metadata is written by calculation. Calories mode does not
split or resize its explicit target.

Migration `0003_groovy_madame_masque.sql` adds `fitia_gainer_carryover`, isolated
by authenticated Clerk identity and immutable batch hash. It stores source/target
dates, canonical recipe/config snapshot, pending/consumed/cancelled status, version
and an optional verified diary reference. Night configuration fields use validated
defaults for existing JSON preferences; no historical settings need rewriting.
The saved snapshot is independent of subsequent preference changes.

`fitia-gainer-carryover-get({date})` reads records **targeting** that date and their
verified Fitia/planning context. `fitia-gainer-carryover-update` is one mutation
tool with a strict object input:

- Save: `{action:"save", draft:carryoverDraft, confirm:false, expectedVersion?}`.
  Draft contains `sourceDate`, `recipeId`, `scaleFactor`, concrete `sweetener`,
  `nightPercent` and `configVersion`. The server reconstructs the canonical batch;
  it does not accept client-supplied nutrition. A changed config version requires
  a fresh calculation. Preview shows the exact persistent record; approve before
  `confirm:true` using the returned version (zero on initial creation).
- Consume/cancel: `{action:"consumed"|"cancelled", carryoverId, confirm:false,
  expectedVersion?, consumedEntry?:{meal,itemId}}`. The reference is allowed only
  for consumed. Consumption requires a verified eaten quick entry on targetDate
  matching the saved remainder. Cancellation never deletes a Fitia entry and is
  rejected if its tracked entry is already registered.

Mutations reuse write scopes, the kill switch, durable locks, encrypted pre-write
audit, optimistic versions and readback. Retries return the existing immutable
batch/state. Saving it again cannot reopen a cancelled record. There is no automatic
save/consume/cancel, nor any automatic food logging. Explicit confirmation follows
the same agent approval contract as the existing config mutation.

### Registered consumption versus planning

The real `fitia` summary is unchanged. Every calculator response separates:

- `registeredConsumed`: the real Fitia consumed totals, including morning carryovers.
- `excludedCarryoverFromPlanning`: only verified registered portions whose
  `targetDate` equals the calculation date and `sourceDate` is earlier.
- `planningConsumed`: registered minus that exclusion plus unregistered pending
  nutrition **once**. This is the exact base used by `fitia_optimal`.
- `effectiveProjection`: planning consumption plus the full practical new batch,
  attributed to its source date, including its future morning fraction if split.
- `fitiaProjection`: real registered totals plus only the practical serving to
  consume on the calculation date (night fraction for a split). It does not add
  unregistered pending portions or tomorrow's fraction as if already consumed.
- `planningBasis`: excluded calories, earlier source dates and pending reservation;
  `projectionScope` describes the projection bases explicitly.

The carryover context retains `recordedNutrition` (all verified portions),
`plannedNutrition` (unregistered pending portions) and `normalConsumed` (registered
minus earlier-source exclusions, before adding pending). Its `optimizationConsumed`
aliases `planningConsumed`. Each verified item reports `excludedFromPlanning`.
Same-day-source portions remain included. A verified earlier-source portion is
excluded even if its stored metadata is still pending; marking it consumed does not
subtract it again. Cancelled portions have no planning adjustment. Duplicate IDs
or reused diary receipts fail explicitly rather than granting repeated credit.

The existing `projection` / `practicalProjection` remain full-batch exact/practical
projections on the calculation basis: planning in optimal mode, real registered
totals in calories mode. `optimization.after` therefore describes the full practical
batch, not just tonight's physical consumption. Explicit calorie mode retains its
requested size (or the real Fitia remaining calories when no target is provided);
the new planning fields are informational in that mode. No-drink results add zero
nutrition to either explicit projection; unknown consumed macros remain null.

For example, 1858 registered kcal including 445 verified prior-source kcal gives
1413 planning kcal when no unregistered portions remain pending. The serving must
equal a calculation from that normal intake, without the caller subtracting it.
This attribution changes no Fitia entry, daily target, saved preference or carryover
state, and requires no new migration. `sweetener:none` remains a per-call override.

Automatic recognition uses the stable morning log key and the existing exact
quick-entry ID algorithm. Manually logged portions with another key require an
explicit consumedEntry reference and preview/confirmation; names/approximate
totals are never guessed. If a consumed entry disappears or changes, calculation
fails with a reconciliation error. Summary/entry reads must have matching update
times. Partial consumption or moving the remainder beyond targetDate is not yet
modeled; reconcile explicitly instead of declaring the whole remainder consumed.

With the supplied approximate pre-drink 14 September fixture, the practical batch
is 1034.13 kcal: 68% / 703.2084 kcal at night and 32% / 330.9216 kcal the next morning.
This is a synthetic regression example, not a modification of the real diary.

All inputs are strict objects. No tool accepts a user ID.

- `fitia-gainer-calculate`: `{date, mode?, sweetener?, targetCaloriesKcal?}`.
  `date` is a real local calendar date; `mode` is `calories | fitia_optimal`;
  `sweetener` defaults to `auto`, or `both | honey_only | stevia_only | none`.
  Explicit targets range from zero to 20000 kcal. Read-only, requires `fitia:read`.
- `fitia-gainer-config-get`: `{}`. Returns resolved config, persistent-state
  indicator and version. Read-only, requires `fitia:read`.
- `fitia-gainer-config-update`: `{patch, confirm=false, expectedVersion?}`.
  Patch fields: `sweetenerInventory` (`unknown` or a concrete sweetener mode),
  `defaultMode`, `honeyGramsPerTablespoon` (1–100), and complete
  `honeyProfile: {source, label, per100G: {caloriesKcal, proteinG, carbsG, fatG}}`.
  Source is `standard_reference | product_label`. Preview returns the exact
  before/after and version without writing. After explicit approval, confirm
  the same patch with that `expectedVersion`. Conflicts require a new preview.
  Requires `fitia:write` even for previews, matching the other write tools.

  Night fields: `preferredNightCaloriesKcal` and `maxNightCaloriesKcal` (1–20000),
  with preferred ≤ maximum after merging the patch into current preferences.

```json
{"date":"2026-09-13","mode":"fitia_optimal","sweetener":"auto"}
```

```json
{"date":"2026-09-13","mode":"calories","sweetener":"none","targetCaloriesKcal":500}
```

## Persistence and deployment

Migration `0002_thick_praxagora.sql` adds `fitia_gainer_config`, keyed by the
verified Clerk identity. It seeds `honey_only` only for this deployment's
already-linked owner. Other users default to `unknown`; reads do not create rows.
`auto` uses that inventory directly. A missing row is distinct from a malformed
row or database outage, which fails explicitly rather than falling back.

Configuration commits reuse `SafeWriteCoordinator`, the same request-scoped
remote journal, kill switch, durable locks, encrypted pre-write audit,
optimistic version checks and readback as diary writes. The account ID is never
supplied by the caller. No OAuth settings or Fitia diary fields are changed.

Run the existing `db:migrate`, `bun run check`, `build:worker` and Wrangler
deployment pipeline. Apply the migration before deploying code that reads the
new table. A rollback to the previous Worker can leave the additive table intact.
For local stdio the calculator supports explicit sweeteners; persistent config
updates require the authenticated remote deployment, not another local store.

## Skill and meal logging

`skills/fitia-gainer/SKILL.md` is imported as text into both MCP bundles and
included in initialization `instructions`. It is also discoverable through
`resources/list` and readable at `fitia://skills/fitia-gainer`. The existing
Fitia skill links to it. Thus there is no parallel skill service or extra MCP.
Clients that install file-based skills may use that same directory; clients
must still connect to the remote MCP for persisted settings.

The skill requires tool-based calculations, `auto` inventory, concise practical
quantities, and preview/approval for config and logging. Calculation never logs.
`suggestedMealLog` contains the practical profile; `exactMealLog` is available
for an actually exact serving. Select the meal and follow `fitia-meal-log`'s
existing preview, approval and idempotency workflow. Rejected calculations have
no log payload.
