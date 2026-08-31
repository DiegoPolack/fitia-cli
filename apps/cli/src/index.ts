#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import { run } from "./cli.ts";
import { VERSION } from "./contract/index.ts";

process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

// Keep the existing versioned argv contract while Effect owns the executable lifecycle.
const argv = Argument.string("argument").pipe(Argument.variadic());
const command = Command.make("fitia", { argv }, ({ argv }) =>
  Effect.tryPromise({
    try: () => run(Array.from(argv)),
    catch: (cause) => cause,
  }).pipe(
    Effect.tap((exitCode) =>
      Effect.sync(() => {
        process.exitCode = exitCode;
      }),
    ),
    Effect.orDie,
  ),
);

Command.runWith(command, { version: VERSION })(["--", ...process.argv.slice(2)]).pipe(
  Effect.provide(BunServices.layer),
  BunRuntime.runMain,
);
