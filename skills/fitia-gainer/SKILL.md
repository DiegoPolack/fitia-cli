---
name: fitia-gainer
description: Calculate the Polack Labs Mass Gainer with the Fitia MCP when asked about a batido, gainer, whether to have it today, or how much to prepare; manage its saved sweeteners and approved meal logging.
---

# Polack Labs Gainer

For “¿Me hago el batido?”, “Calcula mi batido”, “¿Cuánto batido me toca?”, “Gainer”, or equivalent, call `fitia-gainer-calculate` with the user's local date, `mode: fitia_optimal`, and `sweetener: auto`. For an explicitly requested calorie amount use `mode: calories` and `targetCaloriesKcal`. Do not first call day-summary: the calculator already reads the same core service.

Never reconstruct the recipe, scale its ingredients, or calculate nutrition from memory. The calculator is the deterministic source of truth. If it is unavailable, say so rather than substituting remembered formulas. Preserve the recipe version. Do not invent a low-fat variant.

This MCP defines green ranges as 90–110% of each recorded target (calories, protein, carbs, fat). This is an explicit MCP convention, not a claim verified from Fitia's interface. `fitia_optimal` considers all four ranges, practical rounding, excess penalties, and no drink. Calories already green can still allow a useful macro correction; all four green means no drink is needed. Never aim for the central 100% after a metric is green. `mode: calories` retains the explicit-calorie calculator and does not optimize the serving against these bands.

Use the saved inventory. If the result requests sweetener inventory, ask only: **¿Tienes stevia, miel, ambos o ninguno?** Do not ask again if it is already known. Other `needs_input` reasons (incomplete diary or goals) require resolving that specific gap, not asking about sweeteners. Unknown nutrition is not zero.

Present a compact recommendation using the returned `reason`: calories remaining, practical ingredient quantities, honey tablespoons/whole grams, stevia packets, creatine, water, kcal, carbs/protein/fat, approximate known cost subtotal, and projected consumption/remaining macros. All practical grams/ml are whole numbers. Explain that the displayed subtotal excludes ingredients with unknown prices. Prefer `practicalNutrition` and `practicalProjection` when showing what the user will actually prepare; the exact profile describes the mathematical portion. Show only relevant warnings, including material rounding overshoot. Never dump raw JSON.

For optimal results, explain `greenRanges` and `optimization.before/after`, `improvedMetrics`, `enteredGreen`, and `leftGreen` as relevant. `targetCaloriesKcal` still reports the legacy central remaining amount, not the selected drink size; the upper-band headroom is `optimization.maxAdditionalCaloriesKcal`. Do not describe central remaining macros as deficits when they are already green. Keep the existing status contract: `not_recommended` plus `optimization.outcome: not_needed` means all four metrics already green; `not_beneficial` means no evaluated serving beats skipping the drink. `limited_by_calories` and `best_available` explain a compromise, not full correction. Never log a zero serving or its configured sweeteners.

## Night split and next-morning carryover

Use `servingStrategy`. For `single_serving`, present the usual simple result. For `split_next_morning`, explain `servingReason`, show the full batch's practical ingredients once, then the returned night/morning percentages and nutrition separately. The night limits come from saved configuration; do not invent a 50/50 division or always choose the maximum. Blend the complete batch thoroughly, weigh the finished mixture and divide by the returned whole percentages. Refrigerate the remainder promptly for the following morning. Water is the recipe's water contribution, not a measured final volume. Creatine is already in the batch and is shared between portions; do not add another full dose to either portion.

`optimization.after` and legacy projections still describe the full batch hypothetically assigned to the source date. They do NOT mean tonight reaches that state. Use `nightProjection` and `nightOptimization.after` to describe tonight, and show `morningCarryover.targetDate` for the remainder. Do not promise a perfect day or move macros between Fitia dates.

Calculation does not create a persistent carryover. Once the user explicitly asks to save the prepared/planned split, pass the exact returned `carryoverDraft` (including `configVersion`) to `fitia-gainer-carryover-update` with `action: save`, `confirm:false`. Show the dates, fractions and nutrition in the preview. Only after approval repeat the same operation with `confirm:true` and its `expectedVersion`. Save before logging tonight so the original draft remains available. If preparation is abandoned, offer cancellation; never silently cancel it.

Use `fitia-gainer-carryover-get` with the target date to retrieve the saved immutable batch and morning logging payload. Pending unregistered nutrition is reserved in optimal planning; actual Fitia consumption remains authoritative. `effectiveStatus: registered_in_fitia` means its exact entry is already counted even if the saved status still says pending. Do not log it again. If a user manually registered it under another key, use the exact `consumedEntry: {meal,itemId}` for reconciliation; never infer identity from a similar name or approximate macros. Verification requires an eaten quick entry with matching totals. Missing or changed verified entries must be reconciled, not hidden by recalculation.

After the morning portion is actually consumed and logged on its target date, mark it with `action: consumed`, `carryoverId`, and (when necessary) `consumedEntry`, following preview/approval/expectedVersion. This metadata operation verifies Fitia and never logs food. For discarded or unconsumed remainder use `action: cancelled` through the same flow. Completed/cancelled records cannot be silently reopened. Different portions or a different consumption date need explicit reconciliation; this version tracks the entire saved remainder on the next morning's date.

For `not_recommended` or `sweetener_exceeds_target`, say clearly why using the tool's reason. Do not present a rejected portion as a recipe to prepare or silently reduce the configured honey. A user-selected alternate sweetener requires a new calculator call. Recommendations concern recorded macro targets, not medical suitability; do not override known dietary restrictions.

## Persistent preferences

`fitia-gainer-config-get` reads the authenticated user's settings. “Compré stevia otra vez” can prompt an offer to save a change, but is not permission to mutate silently. When the user explicitly asks to save a setting:

The same preferences flow handles `preferredNightCaloriesKcal` and `maxNightCaloriesKcal`. Preferred must not exceed maximum; use one patch to change both when needed.

1. Call `fitia-gainer-config-update` with the exact `patch` and `confirm:false`.
2. Show `before`, `after` and the changed fields succinctly. Obtain explicit approval of that preview before writing.
3. Submit the same patch with `confirm:true` and the returned `expectedVersion`. On a conflict, preview again; changed results need approval. Never change identity, bypass scopes/kill switches, or clear pending locks.

## Log what was prepared

Calculation never logs a meal. If the user then says “Agrégalo a Fitia”, reuse `suggestedMealLog` from the last applicable result for practical quantities, or `exactMealLog` only if the exact serving was actually prepared. Do not recalculate macros yourself. Infer the meal only from clear context; otherwise ask for the meal. Check the local date if midnight passed.

For a split, `suggestedMealLog` is only the night portion and `exactMealLog` is null. Use `nightMealLog` for that night and the saved `morningCarryoverMealLog` for the next morning, each with its existing stable idempotency key and actual date. Never use fullBatch/legacy total nutrition to log a split serving, and never recompute the morning remainder from memory or a fresh day's calculation. Default meal slots are dinner/breakfast; change the slot only for the actual meal and keep its verified receipt for reconciliation.

Call `fitia-meal-log` with those totals and `confirm:false`. Show the exact preview and follow the server's explicit approval instructions before `confirm:true`. Changed ingredients or quantities require a new deterministic calculation, not improvised scaling. Reuse the returned idempotency key after uncertainty. Never log a rejected calculation with a null payload.
