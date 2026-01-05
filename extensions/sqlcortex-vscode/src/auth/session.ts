import { createApiClient } from "../api/client";
import { TokenStore } from "./tokenStore";

export type UserSummary = { id: string; email: string; name: string | null };
export type OrgSummary = { id: string; name: string };
export type MembershipSummary = { orgId: string; orgName: string; role: string };

export type SessionSnapshot = {
  user: UserSummary | null;
  org: OrgSummary | null;
  memberships: MembershipSummary[];
};

type MeResponse = {
  user?: UserSummary | null;
  org?: OrgSummary | null;
  memberships?: Array<{ org_id: string; org_name: string; role: string }>;
};

let cachedSession: SessionSnapshot | null = null;

export function getCachedSession(): SessionSnapshot | null {
  return cachedSession;
}

export function setCachedSession(session: SessionSnapshot): void {
  cachedSession = session;
}

export function clearCachedSession(): void {
  cachedSession = null;
}

export async function getAccessToken(tokenStore: TokenStore): Promise<string | null> {
  const token = await tokenStore.getAccessToken();
  return token ?? null;
}

export async function verifyToken(
  baseUrl: string,
  token: string,
  clientHeader: string
): Promise<SessionSnapshot> {
  const client = createApiClient({ baseUrl, token, clientHeader });
  const payload = await client.get<MeResponse>("/api/v1/me");

  if (!payload || typeof payload !== "object") {
    throw new Error("Authentication response malformed");
  }

  const session: SessionSnapshot = {
    user: (payload as MeResponse).user ?? null,
    org: (payload as MeResponse).org ?? null,
    memberships: ((payload as MeResponse).memberships ?? []).map((membership) => ({
      orgId: membership.org_id,
      orgName: membership.org_name,
      role: membership.role,
    })),
  };

  return session;
}

export async function requireAuth(options: {
  tokenStore: TokenStore;
  baseUrl: string;
  clientHeader: string;
  promptLogin: () => Promise<boolean>;
}): Promise<{ token: string; session: SessionSnapshot } | null> {
  let token = await getAccessToken(options.tokenStore);
  if (!token) {
    const didLogin = await options.promptLogin();
    if (!didLogin) {
      return null;
    }
    token = await getAccessToken(options.tokenStore);
    if (!token) {
      return null;
    }
  }

  try {
    const session = await verifyToken(options.baseUrl, token, options.clientHeader);
    setCachedSession(session);
    return { token, session };
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 401 || status === 403) {
      await options.tokenStore.clear();
      clearCachedSession();
      const didLogin = await options.promptLogin();
      if (!didLogin) {
        return null;
      }
      const refreshedToken = await getAccessToken(options.tokenStore);
      if (!refreshedToken) {
        return null;
      }
      const session = await verifyToken(options.baseUrl, refreshedToken, options.clientHeader);
      setCachedSession(session);
      return { token: refreshedToken, session };
    }
    throw err;
  }
}
