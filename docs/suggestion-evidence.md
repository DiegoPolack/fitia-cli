# Daily nutrition and suggestion evidence

This is a discovered Fitia boundary with a CLI-defined ranking policy. Verified on 2026-08-30 against the signed Android 25.1.14 app source and authenticated, read-only calls for the user's own account.

## Daily summary

Read the same owned `Usuarios/{uid}/dailyRecords/{dd-MM-yyyy}` document as `meal get`. Goals are `mealProgress.targetCalories`, `targetProteins`, `targetCarbs`, `targetFats`, in kcal and grams. Each meal has the same target fields. Sum eaten quick entries and food/recipe entries whose serving totals satisfy the verified rules in `diary-evidence.md`. Unknown types, incomplete serving evidence, missing nutrients, and unknown eaten states produce explicit coverage gaps, never zero consumption. Planned entries do not count. Calories also have the server aggregate `consumedCalories`; disagreement with complete entry totals is surfaced and blocks automatic budgeting.

The cached `nutrientsProgress` is a reconciliation check, not a substitute for missing entry data. Live evidence on August 30 showed a stale cache after a quick-entry write. A separate read-only verification on September 5 resolved two foods and two recipes; their calories and macros matched both Fitia aggregates within rounding tolerance. Recompute from entries without refreshing or writing. Remaining values are signed goal minus consumption, so exceeding a target remains visible. No goal recalculation, diet prescription, or write.

## Native suggestions

`POST https://planner.fitia.app/api/v1/yuki/food-suggestions`, Bearer Firebase ID token. Source: `PlannerFitiaAppApi.postFoodsSuggestions`, `FoodSuggestionRequest.customBuilder`, `MealsServices.fetchFoodMealReplacementsGenerationType`, and the Retrofit origin in `Sg/k5.java`.

JSON fields: `dietType`, `minCalories`, `maxCalories`, `targetCalories`, `targetProteins`, `targetCarbs`, `targetFats`, `mealType`, `selectedFoods`, `measurementSystem`, `country`, `language`, `creationDate`, `userID`. The macro targets are **grams**, despite the helper name `fetchMacrosPercentages`. Targets are truncated integers in the app. Meal types are breakfast, mid_morning, lunch, mid_afternoon, dinner. This route returns suggestions; applying them is a separate app operation. Never call the planner generation or replacement write routes.

Read only relevant preferences from the same owned user document: `tipoDieta`, `pais`, `databaseLanguage`, `fechaCreacion`, the corresponding `available*PlannerFoods` list, and restriction presence. Do not copy push tokens, health metrics, or unrelated profile fields. Optional CLI food IDs narrow that saved list. No assertion that the provider enforces allergies or medical restrictions.

Response is an array of food combinations. Each food has localized `name`, `firestoreDocId`, `selectedSize`, `servingSettings`, `cookingState`, `recommendations`, and `caloriesPerGram` / `proteinPerGram` / `carbsPerGram` / `fatPerGram`. Request metric units. Require an unambiguous metric g/ml serving and explicit positive selected size; multiply per-unit nutrients by selected size. Keep cooking state and provider preparation notes. Do not silently convert raw to cooked weight. Source: `PlannerPlannerFoodResponse.toPlannerFood`.

Live request for dinner with max 287 kcal, 62 g protein, 0 g carbs, 6 g fat returned HTTP 200 and a 200 g raw chicken option: 240 kcal, 45 g protein, 0 g carbs, 5.24 g fat. No diary revision changed.

## CLI policy

`day summary --date YYYY-MM-DD` returns goals, consumed totals, signed remaining values, meal breakdown, coverage, and stale-cache warnings.

`meal suggest --date YYYY-MM-DD --meal dinner [--limit 5] [--foods 1,4]` reads its own summary, so callers need not read it first. Budget calories are the smaller of the remaining day and remaining meal targets. Positive remaining daily macros are allocated in that calorie proportion. Request a 70% to 100% calorie range. Reject incomplete diary budgeting, and return no-budget rather than inventing calories when none remain. This is an explicit planning heuristic, not Fitia's daily goal algorithm.

Filter provider results to the requested foods and calorie budget, deduplicate, then rank by added macro excess and closeness to the budget. Show portions, totals, remaining-after values, and tradeoffs. No result is automatically logged. A log-ready quick entry per food is provided for an explicitly selected and eaten option. Empty results are valid and lead to food search, not retries or invented native suggestions.
