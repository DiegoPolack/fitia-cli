import { verifyToken } from "@clerk/backend";
import { type AuthInfo, OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";

const clerkUserId = /^user_[A-Za-z0-9]{1,64}$/;

function scopesFrom(claims: Record<string, unknown>): string[] {
  const value = claims.scope ?? claims.scp;
  if (typeof value === "string") return value.split(/\s+/).filter(Boolean);
  return Array.isArray(value) && value.every((scope) => typeof scope === "string") ? value : [];
}

export function clerkTokenVerifier(options: {
  issuer: string;
  audience: string;
  jwtKey: string;
  verify?: typeof verifyToken;
}) {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      try {
        const claims = await (options.verify ?? verifyToken)(token, {
          audience: options.audience,
          clockSkewInMs: 5_000,
          headerType: "at+jwt",
          jwtKey: options.jwtKey,
        });
        if (
          claims.iss !== options.issuer ||
          !clerkUserId.test(claims.sub) ||
          !Number.isSafeInteger(claims.exp) ||
          typeof claims.client_id !== "string" ||
          claims.client_id.length === 0
        ) {
          throw new Error("unsafe claims");
        }
        return {
          token,
          clientId: claims.client_id,
          scopes: scopesFrom(claims),
          expiresAt: claims.exp,
          resource: new URL(options.audience),
          extra: { clerkUserId: claims.sub },
        };
      } catch {
        throw new OAuthError(OAuthErrorCode.InvalidToken, "The access token is invalid or expired");
      }
    },
  };
}

export function clerkUserFrom(auth: AuthInfo): string {
  const userId = auth.extra?.clerkUserId;
  if (typeof userId !== "string" || !clerkUserId.test(userId)) throw new Error("Missing Clerk user identity");
  return userId;
}
