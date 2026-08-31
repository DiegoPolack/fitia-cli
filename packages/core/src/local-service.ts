import { Effect, Layer } from "effect";
import { cleanToken } from "./auth.ts";
import { keychain } from "./keychain.ts";
import { Fitia, makeFitiaOperations } from "./service.ts";
import { sessionCredentials } from "./session.ts";

export interface LocalFitiaLayerOptions {
  readonly token?: string;
  readonly timeoutMs?: number;
  readonly useKeychain?: boolean;
}

export const makeFitiaLayer = (options: LocalFitiaLayerOptions = {}) =>
  Layer.effect(
    Fitia,
    Effect.gen(function* () {
      let token = options.token === undefined ? undefined : cleanToken(options.token);
      let trustedAccountId: string | undefined;

      if (token === undefined && options.useKeychain !== false && process.platform === "darwin") {
        const saved = yield* Effect.tryPromise(() => sessionCredentials(keychain, true));
        token = saved?.token;
        trustedAccountId = saved?.uid;
      }

      return yield* makeFitiaOperations({ token, timeoutMs: options.timeoutMs, trustedAccountId });
    }),
  );
