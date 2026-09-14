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
complete diary coverage and all remaining macros. Its scale is the minimum of
the calorie scale, remaining fat after sweeteners / base fat, and remaining
carbs after sweeteners / base carbs. These are strict ceilings, not a clinical
optimization. Protein impact is reported without altering the recipe.

Full portions that fit return `recommended`; portions reduced by macro ceilings
return `acceptable`. No calorie budget, no fat/carb room, or no measurable mix
returns `not_recommended`. Unknown inventory or incomplete automatic budgeting
returns `needs_input`. Honey alone over the target returns
`sweetener_exceeds_target`, its excess, and the maximum honey grams that would
fit. Configured sweeteners are never silently replaced or reduced. Explicit
targets are accepted only in `calories` mode.

Exact quantities drive primary nutrition. Practical solids and small liquids
round to whole grams/ml; water rounds to tens of ml. Creatine remains the fixed
recipe amount whenever there is mix. `practicalNutrition` and
`practicalProjection` use the independently rounded ingredients and honey.
Rounding may slightly exceed an exact ceiling; a warning identifies this.
The exact/practical cost is a known base-mixture subtotal: honey, stevia,
creatine and water prices are not supplied, so `totalPen` is null.

The honey fallback is explicitly `standard_reference`, not a product label.
Change its complete profile and grams per tablespoon through config-update
when the actual label is available. Cinnamon and vanilla nutrition are excluded
because no labels were provided; their quantities and costs are included.
Stevia and creatine contribute zero kcal/macros in this model.

## Tools

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
