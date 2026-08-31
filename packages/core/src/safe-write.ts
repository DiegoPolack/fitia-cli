import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CliError } from "./errors.ts";

export const stateDirectory = () => join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "fitia-cli");

type Receipt = {
  date: string;
  status: string;
  serverVerified: boolean;
  mobileVerified: boolean;
  itemId?: string;
};

type VersionedDocument = { updateTime: string };

type WritePlan<T extends Receipt, Document extends VersionedDocument, Write> = {
  document: Document;
  accountId: string;
  receipt: T;
  hash: string;
  body: Write;
  fieldsChanged: string[];
  verify: (document: Document) => boolean;
};

export class SafeWriteCoordinator<Document extends VersionedDocument, Write> {
  constructor(
    private stateDir: string,
    private patch: (document: Document, body: Write, fieldsChanged: readonly string[]) => Promise<void>,
    private readback: (accountId: string, date: string) => Promise<Document>,
  ) {}

  async assertEnabled() {
    let disabled = process.env.FITIA_DISABLE_WRITES === "1";
    try {
      await lstat(join(this.stateDir, "DISABLE_WRITES"));
      disabled = true;
    } catch (error: any) {
      if (error.code !== "ENOENT")
        throw new CliError(
          "KILLSWITCH_UNREADABLE",
          "Could not check whether writes are disabled.",
          "Check the CLI state directory.",
          5,
        );
    }
    if (disabled)
      throw new CliError(
        "WRITES_DISABLED",
        "Fitia CLI writes are disabled.",
        "The owner must remove DISABLE_WRITES or unset FITIA_DISABLE_WRITES before changing the diary.",
        5,
      );
  }

  async execute<T extends Receipt>({
    document,
    accountId,
    receipt,
    hash,
    body,
    fieldsChanged,
    verify,
  }: WritePlan<T, Document, Write>) {
    await this.prepareState();
    const lockPath = join(this.stateDir, `operation-${hash}.lock`);
    let lock: Awaited<ReturnType<typeof open>>;
    try {
      lock = await open(
        lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
    } catch {
      throw new CliError(
        "OPERATION_PENDING",
        "An earlier attempt for this operation may still be pending.",
        "Read the diary and inspect the private audit log before manually removing this operation's lock.",
        5,
      );
    }
    const attempt = randomUUID();
    let dispatched = false;
    let uncertain = false;
    try {
      await lock.writeFile(
        JSON.stringify({ attempt, itemId: receipt.itemId, date: receipt.date, createdAt: new Date().toISOString() }),
      );
      await lock.sync();
      await this.audit({
        attempt,
        accountId,
        ...receipt,
        status: "pending",
        phase: "before-write",
        expectedUpdateTime: document.updateTime,
        fieldsChanged,
      });
      await this.assertEnabled();
      dispatched = true;
      await this.patch(document, body, fieldsChanged);
      let verified: Document;
      try {
        verified = await this.readback(accountId, receipt.date);
      } catch {
        throw new CliError(
          "WRITE_UNCERTAIN",
          "The write returned, but readback could not confirm it.",
          "Inspect the diary and audit before retrying. For meal log, reuse the original key.",
          4,
        );
      }
      if (!verify(verified))
        throw new CliError(
          "WRITE_UNCERTAIN",
          "Readback did not confirm the expected diary change.",
          "Inspect the diary and audit receipt. For meal log, do not submit under a new key.",
          4,
        );
      await this.audit({
        attempt,
        ...receipt,
        status: "committed",
        serverVerified: true,
        updateTime: verified.updateTime,
      });
      return {
        ...receipt,
        status: "committed",
        serverVerified: true,
        expectedUpdateTime: document.updateTime,
        fieldsChanged,
      };
    } catch (error) {
      uncertain = dispatched && (!(error instanceof CliError) || error.code === "WRITE_UNCERTAIN");
      const reported =
        uncertain && !(error instanceof CliError && error.code === "WRITE_UNCERTAIN")
          ? new CliError(
              "WRITE_UNCERTAIN",
              "The write may have completed, but the receipt could not be finalized.",
              "Inspect the diary and audit before retrying. For meal log, reuse the original key.",
              4,
            )
          : error;
      try {
        await this.audit({
          attempt,
          date: receipt.date,
          itemId: receipt.itemId,
          status: uncertain ? "uncertain" : "failed",
          code: reported instanceof CliError ? reported.code : "LOCAL_ERROR",
        });
      } catch {}
      throw reported;
    } finally {
      await lock.close();
      if (!uncertain) await unlink(lockPath).catch(() => {});
    }
  }

  private async prepareState() {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.stateDir);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new CliError(
        "UNSAFE_STATE_DIRECTORY",
        "The CLI state directory must be private and owned by you.",
        "Use a directory with mode 0700. No write was sent.",
        5,
      );
  }

  private async audit(record: Record<string, unknown>) {
    const path = join(this.stateDir, `audit-${new Date().toISOString().slice(0, 10)}.jsonl`);
    const file = await open(
      path,
      constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()))
        throw new CliError(
          "UNSAFE_AUDIT_LOG",
          "The audit log is not private.",
          "Fix its permissions before writing.",
          5,
        );
      await file.writeFile(`${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
  }
}
