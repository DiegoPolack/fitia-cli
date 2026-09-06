# Diary protocol evidence

Checked August 30, 2026 against signed application code, authenticated server reads, and live iOS refresh behavior for the owner's account. This records protocol evidence and verification limits, not a supported public Fitia API.

## Evidence

Inspected Android package com.nutrition.technologies.Fitia 25.1.14 (1495) without installing or running it. The APK was downloaded from the APKPure distribution link. APK signature schemes v2 and v3 verified with apksigtool. Its certificate SHA256 is DBFABA398F3D2913F9A02979580CF1F7ED5FE4443251C7964CE5F5FA8182F434, matching Fitia's published Digital Asset Links statement returned by Google's statements API. The archive SHA256 is 77f1fccb17c1fb0bbd54a25224dd50320756bef7fb874d701f1f22e7532d9352.

Only protocol facts are recorded here. Decompiled code and the package stay outside the repository.

DailyPlanItemServices and UserServices establish the Firestore path:

`Usuarios/{verified account UID}/dailyRecords/{dd-MM-yyyy}`

The day document has `registrationDateUTC` and `mealProgress.meals`. Meals have `typeID`, `uid`, `registrationDateUTC`, and `mealItems`, a map keyed by unique item ID. MealTypeModel establishes Breakfast 0, Snack 1 1, Lunch 2, Snack 2 3, Dinner 4. Use an existing meal; do not invent a missing day or meal container.

QuickItemModel.toQuickItemPlanItem and QuickItemPlanItem's decoder establish a simple quick entry:

| Field | Value |
| --- | --- |
| type | string `2` |
| uniqueID | unique string |
| name | label, including the serving description supplied by the caller |
| registrationDate | Firestore timestamp |
| registrationDateMeal | existing meal timestamp |
| isEaten | true for logged consumption |
| order | integer after the existing items |
| calories | total entry kcal |
| proteins, carbs, fats | total entry grams, nullable in Fitia; explicit in this CLI |

This is a quick entry, not a full food database object. It does not claim micronutrients, recipe ingredients, or a database association. Normal food entries use type `0`; recipes use type `1` and contain their component foods.

### Food and recipe serving totals

Verified September 5, 2026 with an authenticated read of four eaten entries against both Fitia's `consumedCalories` and `nutrientsProgress` aggregates. No diary mutation was used. For a type `0` food, the top-level `calories`, `proteins`, `carbs`, and `fats` values are per selected metric unit. A total requires exactly one selected `g` or `ml` serving, a strict nonnegative decimal `selectedNumberOfServingsRaw`, and a positive `factor`.

When `cookingState` and `selectedCookingState` are equal, the serving multiplier is `selected serving size * number of servings`. When the states differ, it is `selected serving size * number of servings / factor`. A factor other than one without both cooking states is ambiguous and remains unknown. The live record included both same-state and converted foods; the resolved entry calories and all four macros matched Fitia's aggregates within rounding tolerance.

A type `1` recipe is resolved by applying the same verified food rule to every nested food, summing those totals, then multiplying by `selectedNumberOfServingsRaw / servingsPerRecipe`. An empty recipe, incomplete ingredient, invalid serving count, missing conversion evidence, duplicate selected serving, unsupported unit, or future entry type remains nullable. No cached macro is substituted for an unresolved entry.

DailyPlanItemServices exposes field updates as well as whole document replacement. Logging patches only the new item, the consumed calorie aggregate, and the diary's `fcmToken` origin marker to null, using the document updateTime as a concurrency precondition. It must not replace the whole day, overwrite existing foods, create other accounts, or edit user preferences.

## Mobile refresh contract

The diary's `fcmToken` identifies the device that wrote it. Android's realtime diary listener compares it with the local device token and skips matching changes. It accepts a null marker as an external update. This is a diary field, not the account's push notification registration. Never replace account tokens or manufacture a push token.

The existing endpoint is sufficient:

```text
PATCH https://firestore.googleapis.com/v1/projects/fitia-27c84/databases/(default)/documents/Usuarios/{verifiedUid}/dailyRecords/{dd-MM-yyyy}
  ?updateMask.fieldPaths=fcmToken
  &currentDocument.updateTime={lastReadUpdateTime}
Authorization: Bearer {Firebase ID token}
Content-Type: application/json

{"fields":{"fcmToken":{"nullValue":null}}}
```

Evidence in the signed Android build: MealsServices.fetchAllDailyItemsRealTime supplies the diary query; the realtime repository registers its listener for Premium accounts; the listener compares each document's fcmToken with the current device token before converting changes into local records. Its query covers a window around the current date. The exact Premium gating and date window on iOS were not inspected, so do not promise immediate refresh of arbitrary historical days or non-Premium accounts. The app-start callable only supplies a timezone and was not used as a refresh endpoint. Apple Health synchronization and sharing a meal plan are separate features, not replacements for importing this diary.

Live iOS verification on August 30, 2026: the server contained two breakfast quick entries totaling 477.3 kcal, but iOS 24.2.16 (1069) showed an empty breakfast and 0 kcal. A conditional PATCH setting only `fcmToken` to Firestore null immediately displayed both entries and 477 kcal, without restarting or signing out. Readback confirmed every other document field unchanged. This establishes the refresh mechanism on that version, not a guarantee across versions or offline devices.

`meal refresh --date YYYY-MM-DD --dry-run|--yes` repairs an existing day by clearing only this origin marker. It never rewrites meals, totals, preferences, or planSyncStatus. Output is `{status: "preview"|"already-requested"|"committed", date, kind: "mobile-refresh", serverVerified, mobileVerified: false, expectedUpdateTime, fieldsChanged}`. An already null marker returns `already-requested` with no write, meaning only that the server is already prepared for an external update. It does not prove the phone rendered it. A preview returns the actual field mask. No phone connection is required; an online app must consume the change.

Refresh uses the same prewrite audit, killswitch, conditional write, readback, and uncertain-result handling as logging. Its operation claim is scoped to the account, day and server revision; repeated requests against an already cleared marker do not create a second write. Fresh meal logs clear the marker atomically with the entry so they need no separate refresh request. Repeating an already present log remains a no-op; use refresh to repair older entries.

## CLI output and safety

`meal remove --date YYYY-MM-DD --meal breakfast --item-id ID --dry-run|--yes` removes exactly one quick entry (type `2`) from an existing meal. The ID must come from meal get or a log receipt. It does not accept names, wildcards, entire days, or automatic selection. Food and recipe types remain refused because their deletion and aggregate-update behavior has not been live verified. An already missing ID returns `already-absent` without a write.

Removal uses the existing document PATCH endpoint. The removed item's quoted field path is included in updateMask but omitted from the body, which deletes just that map entry under [Firestore's documented PATCH semantics](https://firebase.google.com/docs/firestore/reference/rest/v1/projects.databases.documents/patch). Setting the item to null is not deletion. The same atomic request updates consumedCalories by subtracting the quick entry's calories only when isEaten is true, and sets fcmToken to null to request a Mobile Refresh. Negative or unknown calorie accounting is refused instead of guessing. Only insignificant floating point subtraction error below 0.000001 kcal is clamped to zero.

The removal receipt contains status (`preview`, `already-absent`, or `committed`), date, meal, itemId, kind (`remove-entry`), entry (the selected summary or null when absent), caloriesRemovedKcal, consumedCaloriesBeforeKcal, consumedCaloriesAfterKcal, serverVerified, mobileVerified:false, expectedUpdateTime, and fieldsChanged. The private pending audit preserves the selected entry summary before dispatch. Existing updateTime preconditions, operation claims, killswitch and readback apply. Retrying an absent ID cannot subtract calories again. Reusing meal log after a successful removal can recreate the same item ID; that is a new add operation, not an undo command.

This release verifies removal with synthetic service tests and live previews only. It does not remove a real entry merely to exercise the feature. The prior mobile marker mechanism was verified live; a CLI receipt cannot verify a phone's display.

`meal get --date YYYY-MM-DD` returns the date, Firestore updateTime, and selected meal and item fields. Dates are explicit calendar dates, with no implicit UTC conversion. Verified type `0`, `1`, and `2` entries expose serving-total calories and macros. Incomplete or unknown structures remain identifiable without invented totals.

`meal log --date ... --meal breakfast --name ... --calories ... --protein ... --carbs ... --fat ...` creates a quick entry. Every amount must be explicit, finite, and nonnegative. The command derives and returns a stable idempotency key; `--occurrence 2` distinguishes a second identical entry, and `--idempotency-key` remains available for external retry coordination. The command requires either `--dry-run` or `--yes`. Dry run performs authentication, a fresh diary read, validation and real payload construction; it does not call the write endpoint.

The receipt states preview, already present, or committed, plus the entry, date, meal, item ID, and verification state. Only server readback can establish committed success. Mobile display remains a separate verification step.

An exclusive local operation claim prevents parallel execution with the same idempotency key. A stable item ID makes repeats detectable remotely, including after a lost response. Different content with the same key is rejected. There are no automatic mutation retries. A timeout after sending is an uncertain result, never a confirmed failure or invitation to use a new key.

Pending and final receipts use an append only JSONL log with mode 0600 under the private CLI state directory. The pending receipt is synced before the request. A `DISABLE_WRITES` file in that directory or FITIA_DISABLE_WRITES=1 blocks writes, checked again immediately before dispatch. No signed financial intent tokens are warranted for adding a reversible personal food entry.

## Authentication

The public Firebase project configuration explicitly includes localhost in authorizedDomains. Use the normal Firebase Google sign in popup with in memory browser persistence. Verify the issued ID token through account lookup and require an existing Fitia profile. Save the renewable session in macOS Keychain or the Windows CurrentUser DPAPI credential store; never read an existing browser session. Token refresh uses Google's documented securetoken endpoint and verifies the same account before saving rotated credentials. Other platforms retain explicit environment and stdin authentication without a plaintext renewable-session fallback.

Live authentication, diary reads, and server writes have succeeded on the owner's account. Quick entries and the origin-marker refresh were observed in the iPhone UI. Each CLI receipt still reports `mobileVerified: false` because it cannot observe the phone; cached nutrition scores and other derived app state are not guaranteed by a server response.

Sources: [Firebase Google sign in](https://firebase.google.com/docs/auth/web/google-signin), [Firebase Auth REST API](https://firebase.google.com/docs/reference/rest/auth), [Firestore REST API](https://firebase.google.com/docs/firestore/use-rest-api), [Fitia's Android listing](https://play.google.com/store/apps/details?id=com.nutrition.technologies.Fitia), [Fitia's Apple Health integration](https://fitia.app/help/articles/how-to-sync-fitia-with-apple-health-google-health-connect/), [Fitia's shared meal plans](https://fitia.app/help/articles/sync-meal-plan-with-others/).
