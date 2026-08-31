// Synthetic responses for built Node executable tests. Never used by production.
import { readFileSync } from "node:fs";

const foodSearch = JSON.parse(readFileSync(new URL("./food-search.json", import.meta.url), "utf8"));
let refreshed = false;
let removed = false;
globalThis.fetch = async (url, init) => {
  if (
    url ===
      "https://firestore.googleapis.com/v1/projects/fitia-27c84/databases/(default)/documents/Usuarios/test-user/dailyRecords/30-08-2026" &&
    !init.method
  ) {
    return Response.json({
      name: "projects/fitia-27c84/databases/(default)/documents/Usuarios/test-user/dailyRecords/30-08-2026",
      updateTime: "2026-08-30T10:00:00Z",
      fields: {
        fcmToken: refreshed ? { nullValue: null } : { stringValue: "synthetic-device-marker" },
        mealProgress: {
          mapValue: {
            fields: {
              targetCalories: { doubleValue: 2000 },
              targetProteins: { doubleValue: 140 },
              targetCarbs: { doubleValue: 250 },
              targetFats: { doubleValue: 60 },
              consumedCalories: { doubleValue: removed ? 0 : 80 },
              meals: {
                mapValue: {
                  fields: {
                    breakfast: {
                      mapValue: {
                        fields: {
                          typeID: { integerValue: "0" },
                          registrationDateUTC: { timestampValue: "2026-08-30T05:00:00Z" },
                          mealItems: {
                            mapValue: {
                              fields: removed
                                ? {}
                                : {
                                    existing: {
                                      mapValue: {
                                        fields: {
                                          type: { stringValue: "2" },
                                          uniqueID: { stringValue: "existing" },
                                          name: { stringValue: "Synthetic breakfast" },
                                          isEaten: { booleanValue: true },
                                          order: { integerValue: "0" },
                                          calories: { doubleValue: 80 },
                                          proteins: { doubleValue: 1 },
                                          carbs: { doubleValue: 9 },
                                          fats: { doubleValue: 4 },
                                        },
                                      },
                                    },
                                  },
                            },
                          },
                        },
                      },
                    },
                    dinner: {
                      mapValue: {
                        fields: {
                          typeID: { integerValue: "4" },
                          targetCalories: { doubleValue: 600 },
                          mealItems: { mapValue: {} },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
  }
  if (
    String(url).startsWith(
      "https://firestore.googleapis.com/v1/projects/fitia-27c84/databases/(default)/documents/Usuarios/test-user?",
    )
  ) {
    if (init.method) throw new Error("Unexpected profile mutation");
    return Response.json({
      name: "projects/fitia-27c84/databases/(default)/documents/Usuarios/test-user",
      fields: {
        tipoDieta: { stringValue: "Recomendada" },
        pais: { stringValue: "PE" },
        databaseLanguage: { stringValue: "ES" },
        fechaCreacion: { timestampValue: "2024-02-10T23:18:24.321Z" },
        availableDinnerPlannerFoods: { arrayValue: { values: [{ stringValue: "1" }] } },
        vegano: { booleanValue: false },
        restrictionsAndMealPreferences: {
          mapValue: { fields: { allergies: { arrayValue: {} }, medicalConditions: { arrayValue: {} } } },
        },
      },
    });
  }
  if (url === "https://planner.fitia.app/api/v1/yuki/food-suggestions") {
    const body = JSON.parse(init.body);
    if (
      body.userID !== "test-user" ||
      body.targetCalories !== 600 ||
      body.targetProteins !== 43 ||
      body.mealType !== "dinner" ||
      body.measurementSystem !== "metric" ||
      init.method !== "POST" ||
      !init.headers.Authorization.startsWith("Bearer ")
    )
      throw new Error("Unexpected suggestion contract");
    return Response.json([
      [
        {
          firestoreDocId: "1",
          name: [{ language: "ES", name: "Pollo sintético" }],
          selectedSize: 400,
          cookingState: "Raw",
          servingSettings: [{ system: "metric", servingUnit: "g", servingSize: 100 }],
          recommendations: [],
          caloriesPerGram: 1.2,
          proteinPerGram: 0.225,
          carbsPerGram: 0,
          fatPerGram: 0.0262,
        },
      ],
    ]);
  }
  if (
    String(url).startsWith(
      "https://firestore.googleapis.com/v1/projects/fitia-27c84/databases/(default)/documents/Usuarios/test-user/dailyRecords/30-08-2026?",
    ) &&
    init.method === "PATCH"
  ) {
    const parsed = new URL(url);
    const mask = parsed.searchParams.getAll("updateMask.fieldPaths");
    const fields = JSON.parse(init.body).fields;
    if (parsed.searchParams.get("currentDocument.updateTime") !== "2026-08-30T10:00:00Z")
      throw new Error("Missing concurrency precondition");
    if (JSON.stringify(mask) === '["fcmToken"]') {
      if (JSON.stringify(fields) !== '{"fcmToken":{"nullValue":null}}') throw new Error("Unexpected refresh contract");
    } else if (
      JSON.stringify(mask) ===
      '["mealProgress.meals.`breakfast`.mealItems.`existing`","mealProgress.consumedCalories","fcmToken"]'
    ) {
      if (
        JSON.stringify(fields) !==
        '{"mealProgress":{"mapValue":{"fields":{"consumedCalories":{"doubleValue":0}}}},"fcmToken":{"nullValue":null}}'
      )
        throw new Error("Unexpected removal contract");
      removed = true;
    } else throw new Error("Unexpected mutation");
    refreshed = true;
    return Response.json({});
  }
  if (url === "https://us-central1-fitia-27c84.cloudfunctions.net/generalSearchV5") return Response.json(foodSearch);
  if (String(url).startsWith("https://identitytoolkit.googleapis.com/v1/accounts:lookup?")) {
    return Response.json({
      users: [
        {
          localId: "test-user",
          email: "test@example.invalid",
          displayName: "Test User",
          emailVerified: true,
          providerUserInfo: [{ providerId: "google.com" }],
        },
      ],
    });
  }
  if (url === "https://app.fitia.app/api/profiles/test-user") {
    return Response.json({
      email: "test@example.invalid",
      name: "Test User",
      country: "pe",
      isPremium: true,
      useCase: "trackCalories",
      goal: "maintainWeight",
      sex: "male",
      creationDate: "2026-01-01",
      birthdate: "private omitted",
      photoUrl: "private omitted",
    });
  }
  if (url === "https://app.fitia.app/api/subscription/premium") return Response.json({ isPremium: true });
  if (url === "https://app.fitia.app/api/foods?countryCode=pe")
    return Response.json([
      { id: 1, names: { en: "Chicken", es: "Pollo" }, category: "Proteins", iconUrl: "secret omitted" },
      { id: 2, names: { en: "Avocado", es: "Palta" }, category: "Fats" },
    ]);
  throw new Error("Unexpected test request");
};
