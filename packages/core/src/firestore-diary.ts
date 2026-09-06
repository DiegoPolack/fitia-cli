import type { Fetch } from "./api.ts";
import { requireToken } from "./auth.ts";
import { CliError, invalidResponse, object, requiredString } from "./errors.ts";

export type FirestoreValue = Record<string, any>;
export type FirestoreFields = Record<string, FirestoreValue>;
export type FirestoreDocument = { name: string; fields: FirestoreFields; updateTime: string };

const BASE = "https://firestore.googleapis.com/v1/projects/fitia-27c84/databases/(default)/documents";
const DOCUMENT_PREFIX = "projects/fitia-27c84/databases/(default)/documents";

export function mapValue(value: FirestoreValue | undefined): FirestoreFields {
  const fields = object(object(value).mapValue).fields;
  return fields === undefined ? {} : (object(fields) as FirestoreFields);
}

export function stringValue(value?: FirestoreValue): string | null {
  return typeof value?.stringValue === "string" ? value.stringValue : null;
}

export function numberValue(value?: FirestoreValue): number | null {
  const raw = value?.doubleValue ?? value?.integerValue;
  if (typeof raw !== "number" && typeof raw !== "string") return null;
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
}

export function timestampValue(value?: FirestoreValue): string {
  if (typeof value?.timestampValue !== "string" || !Number.isFinite(Date.parse(value.timestampValue)))
    invalidResponse();
  return value.timestampValue;
}

export function encodeFields(entry: Record<string, unknown>): FirestoreFields {
  return Object.fromEntries(
    Object.entries(entry).map(([key, value]) => [
      key,
      typeof value === "string"
        ? { stringValue: value }
        : typeof value === "boolean"
          ? { booleanValue: value }
          : { doubleValue: value },
    ]),
  );
}

function quoteField(segment: string) {
  return `\`${segment.replaceAll("\\", "\\\\").replaceAll("`", "\\`")}\``;
}

export function diaryItemField(mealId: string, itemId: string) {
  return `mealProgress.meals.${quoteField(mealId)}.mealItems.${quoteField(itemId)}`;
}

export class FirestoreDiaryAdapter {
  constructor(
    private token?: string,
    private timeoutMs = 15000,
    private fetcher: Fetch = fetch,
  ) {}

  async readDailyRecord(uid: string, storageDate: string): Promise<FirestoreDocument> {
    const path = `Usuarios/${encodeURIComponent(uid)}/dailyRecords/${storageDate}`;
    const data = object(await this.request(`${BASE}/${path}`));
    const name = requiredString(data.name);
    if (name !== `${DOCUMENT_PREFIX}/Usuarios/${uid}/dailyRecords/${storageDate}`) invalidResponse();
    timestampValue({ timestampValue: data.updateTime });
    return { name, fields: object(data.fields) as FirestoreFields, updateTime: data.updateTime as string };
  }

  async readUserFields(uid: string, fieldPaths: readonly string[]): Promise<FirestoreFields> {
    const params = new URLSearchParams();
    for (const fieldPath of fieldPaths) params.append("mask.fieldPaths", fieldPath);
    const data = object(await this.request(`${BASE}/Usuarios/${encodeURIComponent(uid)}?${params}`));
    if (data.name !== `${DOCUMENT_PREFIX}/Usuarios/${uid}`) invalidResponse();
    return object(data.fields) as FirestoreFields;
  }

  async patch(document: FirestoreDocument, body: { fields: FirestoreFields }, fieldsChanged: readonly string[]) {
    const params = new URLSearchParams();
    for (const field of fieldsChanged) params.append("updateMask.fieldPaths", field);
    params.set("currentDocument.updateTime", document.updateTime);
    await this.request(
      `${BASE}/${document.name.split("/documents/")[1]}?${params}`,
      { method: "PATCH", body: JSON.stringify(body) },
      true,
    );
  }

  private async request(url: string, init: RequestInit = {}, writing = false): Promise<any> {
    try {
      // Cloudflare Workers requires the global fetch function to be invoked
      // without the adapter instance as its JavaScript receiver.
      const fetcher = this.fetcher;
      const response = await fetcher(url, {
        ...init,
        headers: { Authorization: `Bearer ${requireToken(this.token)}`, "Content-Type": "application/json" },
        // Workers does not implement redirect="error". Manual mode exposes
        // the 3xx response so the non-ok branch below can reject it safely.
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 404)
          throw new CliError(
            "DIARY_NOT_FOUND",
            "This date has no accessible Fitia diary document.",
            "Open this date in Fitia and allow it to sync. The CLI does not create missing days.",
            4,
          );
        if ([409, 412].includes(response.status))
          throw new CliError(
            "DIARY_CHANGED",
            "The diary changed before the write could commit.",
            "Read it again and retry with the same idempotency key.",
            4,
          );
        if ([401, 403].includes(response.status))
          throw new CliError(
            "DIARY_ACCESS_REJECTED",
            "Firestore rejected this account's diary access.",
            "Sign in again. No permissions or app protections will be bypassed.",
            3,
          );
        if (response.status === 429)
          throw new CliError(
            "RATE_LIMITED",
            "Fitia is limiting requests.",
            "Wait, then retry with the same idempotency key.",
            4,
          );
        throw new CliError(
          writing && response.status >= 500 ? "WRITE_UNCERTAIN" : "DIARY_HTTP_ERROR",
          `The diary service returned HTTP ${response.status}.`,
          writing ? "Read the diary and retry only with the same idempotency key." : "Retry later.",
          4,
        );
      }
      const reader = response.body?.getReader();
      if (!reader) invalidResponse();
      let size = 0;
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4 * 1024 * 1024) {
          await reader.cancel();
          invalidResponse();
        }
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
      if (error instanceof CliError && (!writing || !["INVALID_RESPONSE", "SYSTEM_ERROR"].includes(error.code)))
        throw error;
      throw new CliError(
        writing ? "WRITE_UNCERTAIN" : "DIARY_REQUEST_FAILED",
        writing ? "The write result is uncertain." : "Could not read the diary.",
        writing
          ? "Do not use a new key. Read the diary and retry only with the same idempotency key."
          : "Check your connection and authentication.",
        4,
      );
    }
  }
}
