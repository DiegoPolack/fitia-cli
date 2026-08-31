# Food search protocol evidence

Checked August 30, 2026 against a scoped physical-app capture, direct replay for the owner's account, and the installed CLI. This records observed protocol behavior and verification limits, not a supported public Fitia API.

## Request

Food search uses `POST https://us-central1-fitia-27c84.cloudfunctions.net/generalSearchV5` with `Content-Type: application/json` and the raw Firebase ID token in `Authorization`. The captured session was verified through Firebase account lookup as the owner's account. Replay required no cookies, browser fingerprint, or proxy infrastructure.

The observed request body was:

```json
{"search":"pollo","search_own_db":true,"language":"ES","size":50,"app_platform":"iOS","app_build_number":1069,"country":"PE","search_verified":true}
```

The platform and build fields reproduce the observed provider contract; they do not describe where the CLI runs.

## Response semantics

The response contains `total`, `hits`, and `max_score`. Each hit includes search metadata and a source object. Food sources include an identifier, collection reference, localized name, brand, source, cooking state, nutrients, and servings. A source reference is data, not permission to treat it as an arbitrary database path.

Food nutrient values are base amounts. The observed chicken contained 1.2 kcal per gram and a 120 g serving displayed as 144 kcal in the app. Some foods use milliliter servings. A metric basis is established only when an unambiguous default 1 g or 1 ml serving exists; records without that evidence must not be scaled.

Results can mix foods and recipes. Recipes provide explicit macros per serving rather than the food nutrient map. Their supplied values are not per-gram or per-100-g values. A zero-sized provider serving is an unknown size, not a zero serving.

The provider's `total.value` changed to match the requested size in smaller replays, so it is not evidence of the full database match count. No pagination contract was established.

## Evidence limits

The capture was narrowly authorized and stopped when Firestore's gRPC connection rejected the temporary certificate authority. Certificate validation was not bypassed. Raw captures, credentials, account identifiers, and disposable certificate files remained outside the repository and were removed after extracting the schema.

Live results apply to this account, app version, and date. Tests use synthetic fixtures rather than private captures.
