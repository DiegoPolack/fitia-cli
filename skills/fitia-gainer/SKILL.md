---
name: fitia-gainer
description: Calculate the Polack Labs Mass Gainer with the Fitia MCP when asked about a batido, gainer, whether to have it today, or how much to prepare; manage its saved sweeteners and approved meal logging.
---

# Polack Labs Gainer

For “¿Me hago el batido?”, “Calcula mi batido”, “¿Cuánto batido me toca?”, “Gainer”, or equivalent, call `fitia-gainer-calculate` with the user's local date, `mode: fitia_optimal`, and `sweetener: auto`. For an explicitly requested calorie amount use `mode: calories` and `targetCaloriesKcal`. Do not first call day-summary: the calculator already reads the same core service.

Never reconstruct the recipe, scale its ingredients, or calculate nutrition from memory. The calculator is the deterministic source of truth. If it is unavailable, say so rather than substituting remembered formulas. Preserve the recipe version. Do not invent a low-fat variant.

Use the saved inventory. If the result requests sweetener inventory, ask only: **¿Tienes stevia, miel, ambos o ninguno?** Do not ask again if it is already known. Other `needs_input` reasons (incomplete diary or goals) require resolving that specific gap, not asking about sweeteners. Unknown nutrition is not zero.

Present a compact recommendation using the returned `reason`: calories remaining, practical ingredient quantities, honey tablespoons/whole grams, stevia packets, creatine, water, kcal, carbs/protein/fat, approximate known cost subtotal, and projected consumption/remaining macros. All practical grams/ml are whole numbers. Explain that the displayed subtotal excludes ingredients with unknown prices. Prefer `practicalNutrition` and `practicalProjection` when showing what the user will actually prepare; the exact profile describes the mathematical portion. Show only relevant warnings, including material rounding overshoot. Never dump raw JSON.

For `not_recommended` or `sweetener_exceeds_target`, say clearly why using the tool's reason. Do not present a rejected portion as a recipe to prepare or silently reduce the configured honey. A user-selected alternate sweetener requires a new calculator call. Recommendations concern recorded macro targets, not medical suitability; do not override known dietary restrictions.

## Persistent preferences

`fitia-gainer-config-get` reads the authenticated user's settings. “Compré stevia otra vez” can prompt an offer to save a change, but is not permission to mutate silently. When the user explicitly asks to save a setting:

1. Call `fitia-gainer-config-update` with the exact `patch` and `confirm:false`.
2. Show `before`, `after` and the changed fields succinctly. Obtain explicit approval of that preview before writing.
3. Submit the same patch with `confirm:true` and the returned `expectedVersion`. On a conflict, preview again; changed results need approval. Never change identity, bypass scopes/kill switches, or clear pending locks.

## Log what was prepared

Calculation never logs a meal. If the user then says “Agrégalo a Fitia”, reuse `suggestedMealLog` from the last applicable result for practical quantities, or `exactMealLog` only if the exact serving was actually prepared. Do not recalculate macros yourself. Infer the meal only from clear context; otherwise ask for the meal. Check the local date if midnight passed.

Call `fitia-meal-log` with those totals and `confirm:false`. Show the exact preview and follow the server's explicit approval instructions before `confirm:true`. Changed ingredients or quantities require a new deterministic calculation, not improvised scaling. Reuse the returned idempotency key after uncertainty. Never log a rejected calculation with a null payload.
