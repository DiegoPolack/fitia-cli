import { Context, Effect, Layer } from "effect";
import { FitiaClient } from "./api.ts";
import { cleanToken, tokenStatus } from "./auth.ts";
import { DiaryClient, type LogInput, type RefreshInput, type RemoveInput } from "./diary.ts";
import { CliError } from "./errors.ts";
import type { WriteJournal } from "./safe-write.ts";
import type { SuggestInput } from "./suggestions.ts";

export interface FitiaOperations {
  readonly authStatus: () => Effect.Effect<ReturnType<typeof tokenStatus>, CliError>;
  readonly account: () => Effect.Effect<unknown, CliError>;
  readonly profile: () => Effect.Effect<unknown, CliError>;
  readonly premium: () => Effect.Effect<unknown, CliError>;
  readonly foods: (country: string, query?: string, limit?: number) => Effect.Effect<unknown, CliError>;
  readonly searchFoods: (
    query: string,
    country?: string,
    language?: string,
    limit?: number,
  ) => Effect.Effect<unknown, CliError>;
  readonly meal: (date: string) => Effect.Effect<unknown, CliError>;
  readonly summary: (date: string) => Effect.Effect<unknown, CliError>;
  readonly suggest: (input: SuggestInput) => Effect.Effect<unknown, CliError>;
  readonly log: (input: LogInput) => Effect.Effect<unknown, CliError>;
  readonly refresh: (input: RefreshInput) => Effect.Effect<unknown, CliError>;
  readonly remove: (input: RemoveInput) => Effect.Effect<unknown, CliError>;
}

export const Fitia = Context.Service<FitiaOperations>("@fitia/core/Fitia");

const attempt = <A>(run: () => Promise<A>): Effect.Effect<A, CliError> =>
  Effect.tryPromise({
    try: run,
    catch: (error) =>
      error instanceof CliError
        ? error
        : new CliError("SYSTEM_ERROR", "The operation could not complete.", "Check local dependencies and retry.", 5),
  });

export interface FitiaLayerOptions {
  readonly token?: string;
  readonly timeoutMs?: number;
  readonly trustedAccountId?: string;
  readonly writeJournal?: WriteJournal;
}

export const makeFitiaTokenLayer = (options: FitiaLayerOptions = {}) =>
  Layer.effect(Fitia, makeFitiaOperations(options));

export const makeFitiaOperations = (options: FitiaLayerOptions = {}) =>
  Effect.sync(() => {
    const timeoutMs = options.timeoutMs ?? 15_000;
    const token = options.token === undefined ? undefined : cleanToken(options.token);
    const client = new FitiaClient(token, timeoutMs);
    const diary = new DiaryClient(token, timeoutMs, fetch, undefined, options.trustedAccountId, options.writeJournal);
    const source = options.token === undefined ? "none" : "explicit";

    return {
      authStatus: () => Effect.succeed(tokenStatus(token, source)),
      account: () => attempt(() => client.account()),
      profile: () => attempt(() => client.profile()),
      premium: () => attempt(() => client.premium()),
      foods: (country, query, limit) => attempt(() => client.foods(country, query, limit)),
      searchFoods: (query, country, language, limit) =>
        attempt(() => client.searchFoods(query, country, language, limit)),
      meal: (date) => attempt(() => diary.get(date)),
      summary: (date) => attempt(() => diary.summary(date)),
      suggest: (input) => attempt(() => diary.suggest(input)),
      log: (input) => attempt(() => diary.log(input)),
      refresh: (input) => attempt(() => diary.refresh(input)),
      remove: (input) => attempt(() => diary.remove(input)),
    } satisfies FitiaOperations;
  });
