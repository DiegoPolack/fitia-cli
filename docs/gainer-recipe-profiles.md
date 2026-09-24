# Gainer recipe profiles (local preparation)

This change prepares configurable recipes without selecting a new recipe or
deploying anything. `activeProfile` defaults to `legacy_v1`. The recipe profile
is separate from the [Adaptive algorithm strategy](adaptive-proportional.md):
the new `proportional_v2` strategy is the current default for this recipe;
`adaptive.strategy: legacy_v1` retains the historical optimizer. Old persisted JSON
normalizes on read without writes or a SQL migration. Existing inventory, mode,
night limits, honey settings and top-level `adaptive` overrides remain intact.

## Frozen legacy and independent future ingredients

`recipe.ts` remains the single historical numerical definition. `profiles.ts`
exposes it as immutable `recipeProfiles.legacy_v1`; attempts to edit it fail.
Legacy-strategy calculations retain their original arithmetic, traversal order, bounds,
water, scores, splits and log identifiers. In particular, historical Quaker and
Anchor remain equal base amounts and Nestum retains its historical maximum.
Existing top-level `adaptive` overrides still apply to legacy for compatibility;
the profile records its frozen factory defaults. New proportional-strategy bounds
instead use `adaptive.ingredientDeviation` around the daily baseline.

No `future_v2` is created automatically. An explicit patch creates an inactive
draft with independent ingredient settings: `enabled`, `baseAmount`, `unit`,
`nutrition: {basisAmount, macros, source, fiberG?}`, `price`, `adaptiveBounds` and
`amountMode`. Nutrition basis is independent of recipe base quantity: changing
Quaker changes neither Anchor nor either product's nutrition per unit.
Ingredient patches merge individually; supplied nutrition/price/bound objects
replace that complete object. Only the active profile feeds calculations.

Disabled ingredients are removed before nutrition, search, costs, solids, water,
deviation scoring and snapshot construction. They appear only in configuration
and disabled-ingredient metadata. Cinnamon/vanilla retain the documented legacy
nutrition exclusion; every other enabled ingredient needs all four known macros.

`future_v2` initially leaves Anchor's water ratio/concentration and Nestum's bounds
unset, so selecting the incomplete draft fails. It does not inherit Nestum's
historical 6× maximum. The proposed 50–60 g future cap is a candidate for an
explicit choice, not a selected default. Future adaptive settings are isolated
inside the profile; the old top-level `adaptive` object continues to mean legacy.

## Universe Nutrition Maltodex

The candidate is defined once by `maltodexCandidate()` from the supplied product
label and observed package/price. Its source is `product_label`, flavor is
`unflavored`, and protein remains `null`. The declared orange derivative, citric
acid and sucralose do not imply orange flavor or known perceptible sweetness.
It is a carb source, never part of sweetener selection. Honey/stevia behavior is
unchanged. Its base amount and bounds are also unset; it stays disabled.

Before enabling it, obtain a verified numeric protein value for the same label
basis (or a complete corrected nutrition profile), then explicitly choose its
positive base quantity and adaptive min/max factors. Activation with incomplete
nutrition fails, even inside an inactive draft. Disabled incomplete data is valid.
Unknown prices are reported as exclusions from the known subtotal.

## Future water and Anchor sequence

The historical water algorithm and `waterMlPerDryGram` value are unchanged.
Future `waterMode: structural_solids` with Anchor `amountMode: water_ratio` uses:

1. Active non-dairy structural powders determine the water target using the
   configured ratio. Disabled powders, liquid ingredients and fixed creatine
   do not set this target.
2. Anchor derives from that water target using `gramsPer100MlWater`. It does not
   feed back into water, so there is no circular equation.
3. Practical structural quantities are whole units; Anchor is rounded to grams
   from their water target. Adaptive can vary its concentration inside explicit
   `concentrationBounds: {min, max}` in grams per 100 ml. Final candidates must
   fit those bounds, dry-solids and batch-calorie limits. Total dry solids for
   the cap include active Anchor and fixed creatine.
4. Water is displayed rounded to 10 ml; concentration constraints refer to the
   unrounded water target, also returned. No untested texture correction or
   reduction of the water ratio is applied.

Both fixed and adaptive future paths enforce profile bounds and limits. Fixed
mode scales the profile's independent bases; adaptive returns individual whole
quantities and retains `scaleFactor` as calorie-equivalent only. No physical
Anchor concentration is supplied by defaults or selected by these changes.

## Configuration workflow when activation is actually requested

The existing tools are extended, not replaced. `fitia-gainer-config-get({})`
returns resolved profiles. `fitia-gainer-config-update` still takes
`{patch, confirm:false, expectedVersion?}`; approval of its preview is required
before the same patch with `confirm:true` and the returned version. The existing
scope, identity isolation, CAS, encrypted audit and readback remain in force.

To prepare an inactive draft while keeping legacy selected:

```json
{"patch":{"recipeProfiles":{"future_v2":{"ingredients":{"quaker_oats":{"baseAmount":70}}}}},"confirm":false}
```

Then explicitly configure future Anchor's `gramsPer100MlWater` and
`concentrationBounds`, Nestum's `adaptiveBounds`, and any other changed quantities,
prices or labels. Anchor can alternatively use independent `amountMode: base`
with explicit base amount and bounds. To enable Maltodex later, also supply its
complete nutrition, `baseAmount`, `adaptiveBounds` and `enabled:true` in that
future profile. This document deliberately supplies no invented protein value,
physical Anchor ratio or definitive Maltodex bounds.

Only after that profile validates and the user requests activation, preview:

```json
{"patch":{"activeProfile":"future_v2"},"confirm":false}
```

Switching back uses `{"patch":{"activeProfile":"legacy_v1"},"confirm":false}`
and the same approval flow. It restores the historical recipe using the preserved
legacy preferences, without reconstructing individual defaults. Saved carryovers
keep their own validated recipe/config snapshot and are independent of later
profile selection; old recipe IDs and hashes remain unchanged.

## Debug and verification

Calculator metadata adds `recipeProfile` with active/enabled/disabled IDs,
effective base amounts and water mode. Practical quantities and adaptive
adjustments stay in their existing fields. `scoringComponents` separates
nutrition and deviation from `costPenalty: 0` / `practicalityPenalty: 0`.
Both optimization flags accept only `false`; enabling unimplemented heuristics
is rejected. No price or package-fraction preference affects the current score.

`test/fixtures/gainer-legacy-v1.json` stores 62 pre-change result fingerprints
captured from commit `7dce5152e0028ac8fe03f9f125e7d5b2fcac03f7`. Regression tests
exclude only new additive metadata, comparing all historical fields, including
candidate counts, complete scores, cost, water, splits, carryover IDs and logs.
Adaptive fingerprints explicitly select the retained `legacy_v1` strategy.
The 2026-09-22 synthetic case explicitly checks 75 g Quaker, 75 g Anchor, 30 g
Nestum, 1046.64 practical kcal and the 67/33 split. Further synthetic tests cover
disabled metadata invariance, profile switching, incomplete nutrition, independent
bases, Anchor concentration, and isolated PostgreSQL preview/readback behavior.

Remaining decisions: actual product protein label, physical texture/concentration
tests, future ingredient caps and optional cost/practicality scoring formulas.
The future optimizer retains bounded local search, not a global optimum guarantee.
This preparation requires no real Fitia calls, account writes, migration or deploy.
