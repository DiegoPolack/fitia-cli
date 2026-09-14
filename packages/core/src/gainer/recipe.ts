import { emptyMacros, type Macros, macroKeys } from "../nutrition.ts";

export const sweetenerModes = ["both", "honey_only", "stevia_only", "none"] as const;
export type SweetenerInventory = "unknown" | (typeof sweetenerModes)[number];
export type SweetenerMode = "auto" | (typeof sweetenerModes)[number];
export type GainerMode = "calories" | "fitia_optimal";
export interface HoneyProfile {
  source: "standard_reference" | "product_label";
  label: string;
  per100G: Macros;
}
export interface GainerConfig {
  sweetenerInventory: SweetenerInventory;
  defaultMode: GainerMode;
  honeyGramsPerTablespoon: number;
  honeyProfile: HoneyProfile;
}

export interface GainerIngredient {
  id: string;
  name: string;
  amount: number;
  unit: "g" | "ml";
  nutrition: Macros | null;
  price: { pen: number; packageAmount: number };
}

// Canonical v1 recipe. Nutrition is for the listed base amount, WITHOUT sweeteners.
// Cinnamon/vanilla have no supplied nutrition label: excluded explicitly, never inferred.
export const gainerRecipe = {
  id: "polack_labs_mass_gainer_v1",
  name: "Polack Labs Mass Gainer v1",
  waterMl: 600,
  creatineG: 5,
  ingredients: [
    {
      id: "quaker_oats",
      name: "Quaker Avena Instantánea",
      amount: 50,
      unit: "g",
      nutrition: { caloriesKcal: 200, carbsG: 29, proteinG: 6.5, fatG: 4.5 },
      price: { pen: 9.5, packageAmount: 350 },
    },
    {
      id: "anchor",
      name: "Anchor mezcla láctea en polvo",
      amount: 50,
      unit: "g",
      nutrition: { caloriesKcal: 227, carbsG: 27.6, proteinG: 8.2, fatG: 9.3 },
      price: { pen: 33, packageAmount: 800 },
    },
    {
      id: "nestum",
      name: "Nestum 5 Cereales",
      amount: 20,
      unit: "g",
      nutrition: { caloriesKcal: 79.4, carbsG: 16.1, proteinG: 2, fatG: 0.5 },
      price: { pen: 18.6, packageAmount: 350 },
    },
    {
      id: "seven_cereals",
      name: "7 Cereales chocolate",
      amount: 10,
      unit: "g",
      nutrition: { caloriesKcal: 37, carbsG: 7.195, proteinG: 1.565, fatG: 0.485 },
      price: { pen: 4.4, packageAmount: 150 },
    },
    {
      id: "maca",
      name: "Maca Suiti",
      amount: 5,
      unit: "g",
      nutrition: { caloriesKcal: 14.6, carbsG: 3.42, proteinG: 0.7, fatG: 0.05 },
      price: { pen: 25.2, packageAmount: 220 },
    },
    {
      id: "cocoa",
      name: "Cocoa D'Onofrio",
      amount: 5,
      unit: "g",
      nutrition: { caloriesKcal: 20.5, carbsG: 2.605, proteinG: 1.22, fatG: 0.575 },
      price: { pen: 18.9, packageAmount: 150 },
    },
    {
      id: "cinnamon",
      name: "Canela Bell's",
      amount: 1,
      unit: "g",
      nutrition: null,
      price: { pen: 7.5, packageAmount: 50 },
    },
    {
      id: "vanilla",
      name: "Esencia de vainilla Universal",
      amount: 3,
      unit: "ml",
      nutrition: null,
      price: { pen: 2.3, packageAmount: 100 },
    },
  ] satisfies GainerIngredient[],
  sweeteners: {
    both: { honeyTablespoons: 2, steviaPackets: 2 },
    honey_only: { honeyTablespoons: 3, steviaPackets: 0 },
    stevia_only: { honeyTablespoons: 0, steviaPackets: 2 },
    none: { honeyTablespoons: 0, steviaPackets: 0 },
  },
} as const;

export const baseMixNutrition = gainerRecipe.ingredients.reduce<Macros>((total, ingredient) => {
  for (const key of macroKeys) total[key] += ingredient.nutrition?.[key] ?? 0;
  return total;
}, emptyMacros());
export const baseMixCostPen = gainerRecipe.ingredients.reduce(
  (total, i) => total + (i.amount * i.price.pen) / i.price.packageAmount,
  0,
);

// New users are unknown. The deployment owner's inventory is seeded by an identity-scoped migration.
export function defaultGainerConfig(): GainerConfig {
  return {
    sweetenerInventory: "unknown",
    defaultMode: "fitia_optimal",
    honeyGramsPerTablespoon: 20,
    honeyProfile: {
      source: "standard_reference",
      label: "Generic honey reference; replace with the actual product label",
      per100G: { caloriesKcal: 304, carbsG: 82.4, proteinG: 0, fatG: 0 },
    },
  };
}
