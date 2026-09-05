export interface SavedSession {
  version: 1;
  idToken: string;
  refreshToken: string;
  uid: string;
  email: string | null;
}

export interface SessionStore {
  readonly name?: string;
  read(): Promise<SavedSession | undefined>;
  save(session: SavedSession, expected?: SavedSession): Promise<void>;
  remove(): Promise<void>;
}

export function validSession(value: unknown): value is SavedSession {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  return (
    data.version === 1 &&
    typeof data.idToken === "string" &&
    data.idToken.length <= 16384 &&
    /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(data.idToken) &&
    typeof data.refreshToken === "string" &&
    data.refreshToken.length > 0 &&
    data.refreshToken.length <= 16384 &&
    !/[\x00-\x20]/.test(data.refreshToken) &&
    typeof data.uid === "string" &&
    data.uid.length > 0 &&
    data.uid.length <= 128 &&
    (data.email === null || (typeof data.email === "string" && data.email.length <= 1024))
  );
}
