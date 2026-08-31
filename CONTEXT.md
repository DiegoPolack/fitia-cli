# Fitia Nutrition Context

This context describes the personal nutrition record and meal-planning concepts exposed for the owner's Fitia account. It distinguishes Fitia-owned data from calculations and verification performed outside the mobile app.

## Diary

**Diary Day**:
The nutrition record for one explicit local calendar date.
_Avoid_: UTC day, daily plan

**Meal**:
One of the five diary slots: breakfast, morning snack, lunch, afternoon or evening snack, or dinner.
_Avoid_: Generic snack

**Diary Entry**:
One item recorded within a meal, whether planned or eaten.
_Avoid_: Food, serving

**Quick Entry**:
A diary entry whose label and calorie and macro totals are supplied directly, without claiming a link to a database food or recipe.
_Avoid_: Food entry, recipe entry

**Eaten Entry**:
A diary entry marked as consumed. Planned entries are not eaten entries and do not contribute to calculated consumption.
_Avoid_: Logged entry

**Mobile Refresh**:
A request for the mobile app to import server-side changes for an existing diary day. It does not prove that the app displayed those changes.
_Avoid_: Mobile sync

## Nutrition

**Goal**:
Fitia's stored calorie and macro target for a diary day or meal.
_Avoid_: Recommendation, prescription

**Consumed Macros**:
Calories, protein, carbohydrates, and fat attributable to eaten entries with known totals.
_Avoid_: Cached nutrients

**Remaining Macros**:
A goal minus consumed macros. A negative value means consumption exceeds the goal and is not clamped to zero.
_Avoid_: Allowance

**Coverage Gap**:
A portion of the diary whose consumed nutrition cannot be calculated from verified serving totals. Unknown values remain unknown rather than becoming zero.
_Avoid_: Missing consumption

## Food Planning

**Planner Food**:
A food saved by Fitia as an available choice for a particular meal. It is not an identifier for the full food database.
_Avoid_: Food search result

**Food Search Result**:
A food or recipe returned from Fitia's broader food database search.
_Avoid_: Planner food

**Native Suggestion**:
A read-only food combination and portion proposed by Fitia's planner. Receiving a suggestion does not mean the food was eaten or authorize adding it to the diary.
_Avoid_: Logged meal, CLI recommendation

## Verification

**Server Verified**:
A change confirmed by reading the resulting state from Fitia's server.
_Avoid_: Mobile verified

**Mobile Verified**:
A change independently observed in the Fitia mobile app. Server verification alone does not establish mobile verification.
_Avoid_: Server verified
