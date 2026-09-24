# Proportional Adaptive v2

`fitia_adaptive` now defaults to `adaptive.strategy: proportional_v2` for the
current historical recipe. The recipe remains `legacy_v1`; algorithm version
and recipe version are separate. `fitia_optimal`, `calories`, default calculation
mode, sweetener inventory and the disabled Maltodex candidate are unchanged.
Select `adaptive.strategy: legacy_v1` to use the original independent-ingredient
optimizer. The experimental `future_v2` recipe retains that existing strategy;
this change does not implement the new algorithm for Maltodex or water-ratio Anchor.

## Candidate construction

1. Reuse the current summary and verified carryover planning context.
2. Run the existing fixed-proportion optimizer to get this day's batch scale.
   Its practical Quaker, Anchor, Nestum and 7 Cereales amounts form the baseline.
3. Bound each of those four decisions by its baseline × (1 ± deviation).
   Defaults are 30% each; integer lower/upper limits round inward (ceil/floor).
   For baseline 56/56/22/11 g, allowed intervals are 40–72/40–72/16–28/8–14 g.
   Old absolute `bounds` remain saved for the legacy strategy, but do not silently
   constrain or broaden the new proportional search.
4. For every candidate, `mainDryScale = sum(main grams) / sum(base main grams)`.
   Maca, cocoa, cinnamon and vanilla derive from their canonical base quantities
   times this scale and round to whole grams/ml. They are not search variables.
5. Water derives from the final four-main-ingredient grams, then rounds to 10 ml.
   The default ratio is the existing base water divided by base main grams.
   An old custom `waterMlPerDryGram` is converted as
   `oldRatio × baseTotalDryGramsIncludingCreatine / baseMainGrams` so its base-batch
   hydration is retained. An explicit `waterMlPerMainDryGram` overrides this conversion.
   Flavor powders and creatine do not feed back into the new water calculation.
6. For `honey_only`, target tablespoons are the rounded canonical dose times
   `mainDryScale`. Evaluate only target−1/target/target+1, deduplicated and clamped
   to zero. Grams use the saved grams-per-tablespoon and practical rounding.
   `both`, `stevia_only` and `none` keep their existing fixed doses. Creatine stays
   fixed; no dose is inferred from the new scale.
7. Recompute all practical nutrition, including derived ingredients and honey.
   Check total dry solids (including creatine), batch kcal and green calorie
   headroom against both exact-honey and practical-honey representations.
8. Select a beneficial candidate using the existing adaptive nutrition weights,
   already-high macro penalties and tie tolerance, then apply unchanged splitting,
   projections and meal payloads. No candidate means no drink, not a silently
   unconstrained fallback.

The secondary deviation is `deviationWeight × mean(abs(main − dailyBaseline) /
max(dailyBaseline, 1))` over the four main ingredients only. There is no new
sweetness, cost or practicality scoring heuristic. Derived ingredients and honey
still contribute their real nutrition to the primary score. Comparison evaluates
the actual `fitia_optimal` result and the new candidate with exactly the same
adaptive nutrition weights; a physical restriction can sacrifice some improvement.

If fixed honey prevents any fixed batch, `honey_only` may obtain the baseline
from the same fixed optimizer without honey. It then applies the normal discrete
honey rule to every candidate. This is reported as
`baselineSource: fitia_optimal_without_honey`; it never changes fixed-mode behavior.
If that reference also recommends no drink, there is no adaptive search. An
all-green day also returns no drink. Very restrictive physical caps can make the
daily bounds infeasible; they are not relaxed to force a recipe.

Search uses minimum, baseline and maximum main-quantity seeds, the existing
8/4/2/1 steps, 16 passes per step and at most 18000 unique main-quantity/honey
candidate evaluations. Coordinate and calorie-balanced pair proposals always
derive the full batch again. It is deterministic bounded local search, not an
exhaustive/global optimum guarantee.

## Configuration and output

Existing config tool inputs are unchanged; `adaptive` gains optional fields:

```json
{
  "strategy": "proportional_v2",
  "ingredientDeviation": {
    "quaker_oats": 0.30,
    "anchor": 0.30,
    "nestum": 0.30,
    "seven_cereals": 0.30
  }
}
```

`waterMlPerMainDryGram` is optional; omitted means use the conversion above.
Deviations accept 0–1 and merge per ingredient. Old min/max factors remain readable
and reusable when selecting `legacy_v1`. Existing JSON preferences normalize on
read without a database migration or write. `defaultMode` remains `fitia_optimal`.
Preview, approval, CAS, encrypted audit and authenticated identity are unchanged.

`optimization.adaptive` exposes `strategy`, `baseline`, `baselineScaleFactor`,
`baselineSource`, four bounds and adjustments, `derivedIngredients` (main mass,
physical scale, flavor quantities and water), discrete honey target/candidates/
selection, resolved settings, search count and `comparison`. The top-level
sweetener, cost, nutrition and log payloads reflect the selected dose. Adaptive
`scaleFactor` remains a calorie equivalent; never multiply the recipe by it.

## Frozen carryovers

New proportional drafts add optional `adaptivePreparation`:
`{version: proportional_v2, baselineScaleFactor, honeyTablespoons}` alongside
all concrete `adaptiveAmounts`. Saving validates dynamic bounds, derived quantities,
honey choice and batch limits using the frozen config. The baseline scale records
the original daily reference, not a reference recomputed from tomorrow's diary.

Missing `adaptivePreparation` always means the old preparation algorithm, even if
the user's current/default strategy changed. Concrete saved ingredients are never
re-optimized; old honey/water, nutrition, hashes and logging keys remain unchanged.
New batches likewise reconstruct from their own versioned definition/config after
settings change. No forced configVersion bump is needed: existing CAS versions
continue changing only on explicit config writes. No SQL migration is required.

Tests preserve all previous fallback assertions and 62 historical fingerprints,
and add synthetic bounds, rounding, hydration, honey, macro comparison, planning,
legacy/new snapshot and local PostgreSQL roundtrip cases. The problem fixture is
synthetic and reproduces a similarly imbalanced old recipe; it is not a live diary
read. Production was not called or deployed during this implementation.
