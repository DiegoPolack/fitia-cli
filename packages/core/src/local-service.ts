import { Effect, Layer } from "effect";
import { cleanToken } from "./auth.ts";
import { credentials } from "./credential-store.ts";
import { Fitia, makeFitiaOperations } from "./service.ts";
import { sessionCredentials } from "./session.ts";

export interface LocalFitiaLayerOptions {
  readonly token?: string;
  readonly timeoutMs?: number;
  readonly useCredentialStore?: boolean;
  /** @deprecated Use useCredentialStore. */
  readonly useKeychain?: boolean;
}

export const makeFitiaLayer = (options: LocalFitiaLayerOptions = {}) =>
  Layer.effect(
    Fitia,
    Effect.gen(function* () {
      let token = options.token === undefined ? undefined : cleanToken(options.token);
      let trustedAccountId: string | undefined;

      if (options.token === undefined && options.useCredentialStore !== false && options.useKeychain !== false) {
        const saved = yield* Effect.tryPromise(() => sessionCredentials(credentials, true));
        token = saved?.token;
        trustedAccountId = saved?.uid;
      }

      return yield* makeFitiaOperations({ token, timeoutMs: options.timeoutMs, trustedAccountId });
    }),
  );
