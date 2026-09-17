import { type DiaryClient, type MealName, mealTypes, quickEntryIdentity } from "../diary.ts";
import { CliError } from "../errors.ts";
import { type DaySummary, difference, emptyMacros, macroKeys, round } from "../nutrition.ts";
import type { CarryoverPlan } from "./serving.ts";

export type DiarySnapshot = Awaited<ReturnType<DiaryClient["get"]>>;
export type MealReference = { meal: MealName; itemId: string };
export type CarryoverRecord = CarryoverPlan & {
  status: "pending" | "consumed" | "cancelled";
  version: string;
  consumedEntry: MealReference | null;
};

export function recordedCarryover(
  record: CarryoverRecord,
  diary: DiarySnapshot,
  accountId: string,
  reference = record.consumedEntry,
) {
  if (diary.date !== record.targetDate)
    throw new CliError("CARRYOVER_DATE_MISMATCH", "Carryover and diary dates differ.", "Read the target date.");
  const matches: MealReference[] = [];
  for (const meal of diary.meals) {
    if (!Object.hasOwn(mealTypes, meal.name)) continue;
    const mealName = meal.name as MealName;
    const id =
      reference?.itemId ??
      quickEntryIdentity(accountId, record.targetDate, mealName, record.morningCarryoverMealLog.idempotencyKey).id;
    if (reference && reference.meal !== mealName) continue;
    for (const item of meal.items.filter((i) => i.id === id)) {
      if (
        item.type !== "2" ||
        !item.eaten ||
        macroKeys.some((key) => item[key] === null || Math.abs(item[key]! - record.nutrition[key]) > 1e-6)
      )
        throw new CliError(
          "CARRYOVER_ENTRY_CONFLICT",
          "The identified diary entry does not match the consumed carryover.",
          "Reconcile the exact entry; do not add its nutrition again.",
        );
      matches.push({ meal: mealName, itemId: item.id });
    }
  }
  if (matches.length > 1)
    throw new CliError(
      "CARRYOVER_DUPLICATE_LOG",
      "This carryover appears more than once in Fitia.",
      "Review the exact diary entries before calculating.",
    );
  return matches[0] ?? null;
}

export function carryoverContext(
  records: CarryoverRecord[],
  day: DaySummary,
  diary: DiarySnapshot | null,
  accountId: string,
) {
  if (diary && diary.updateTime !== day.updateTime)
    throw new CliError(
      "DIARY_CHANGED",
      "The diary changed between the summary and carryover verification.",
      "Repeat the read-only calculation.",
    );
  const planned = emptyMacros(),
    recorded = emptyMacros(),
    excluded = emptyMacros();
  const references = new Set<string>();
  const ids = new Set<string>();
  const items = records.map((record) => {
    if (record.targetDate !== day.date)
      throw new CliError("CARRYOVER_DATE_MISMATCH", "Carryover and calculation dates differ.", "Read the target date.");
    if (ids.has(record.id))
      throw new CliError(
        "CARRYOVER_DUPLICATE_REFERENCE",
        "The same carryover was supplied twice.",
        "Read unique carryover records.",
      );
    ids.add(record.id);
    if (record.status === "cancelled") return { ...record, effectiveStatus: "cancelled" as const };
    if (!diary)
      throw new CliError(
        "CARRYOVER_DIARY_REQUIRED",
        "Carryover requires diary verification.",
        "Read the target day's entries.",
      );
    const entry = recordedCarryover(record, diary, accountId);
    if (record.status === "consumed" && !entry)
      throw new CliError(
        "CARRYOVER_LOG_MISSING",
        "A consumed carryover no longer has its verified Fitia entry.",
        "Reconcile the diary; no nutrition was assumed or added.",
      );
    if (entry) {
      const key = `${entry.meal}:${entry.itemId}`;
      if (references.has(key))
        throw new CliError(
          "CARRYOVER_DUPLICATE_REFERENCE",
          "Two carryovers refer to the same diary entry.",
          "Reconcile the carryover records.",
        );
      references.add(key);
    }
    const excludeFromPlanning = entry !== null && record.sourceDate < day.date;
    for (const key of macroKeys) {
      (entry ? recorded : planned)[key] += record.nutrition[key];
      if (excludeFromPlanning) excluded[key] += record.nutrition[key];
    }
    return {
      ...record,
      effectiveStatus: entry ? ("registered_in_fitia" as const) : ("pending" as const),
      verifiedEntry: entry,
      excludedFromPlanning: excludeFromPlanning,
    };
  });
  const normalConsumed = { ...day.consumed },
    planningConsumed = { ...day.consumed };
  for (const key of macroKeys) {
    planned[key] = round(planned[key]);
    recorded[key] = round(recorded[key]);
    excluded[key] = round(excluded[key]);
    if (day.consumed[key] !== null) {
      normalConsumed[key] = round(day.consumed[key]! - excluded[key]);
      planningConsumed[key] = round(normalConsumed[key]! + planned[key]);
    }
  }
  return {
    items,
    plannedNutrition: planned,
    recordedNutrition: recorded,
    registeredConsumed: { ...day.consumed },
    excludedCarryoverFromPlanning: excluded,
    normalConsumed,
    planningConsumed,
    optimizationConsumed: planningConsumed,
    rule: "Planning equals registered Fitia consumption minus verified registered carryovers from earlier source dates plus unregistered pending portions once. Same-day registered portions remain included. Fitia totals, targets and carryover state are unchanged.",
  };
}

export type CarryoverContext = ReturnType<typeof carryoverContext>;

export function planningDay(day: DaySummary, context: CarryoverContext): DaySummary {
  const consumed = { ...context.planningConsumed };
  return { ...day, consumed, remaining: difference(day.goals, consumed) };
}
