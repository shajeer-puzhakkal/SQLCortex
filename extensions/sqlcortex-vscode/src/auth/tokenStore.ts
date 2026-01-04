import * as vscode from "vscode";

const ACCESS_TOKEN_KEY = "sqlcortex.accessToken";
const REFRESH_TOKEN_KEY = "sqlcortex.refreshToken";

export type TokenStore = {
  getAccessToken: () => Promise<string | undefined>;
  setAccessToken: (token: string) => Promise<void>;
  getRefreshToken: () => Promise<string | undefined>;
  setRefreshToken: (token: string) => Promise<void>;
  clear: () => Promise<void>;
};

export function createTokenStore(secrets: vscode.SecretStorage): TokenStore {
  return {
    getAccessToken: () => secrets.get(ACCESS_TOKEN_KEY),
    setAccessToken: (token: string) => secrets.store(ACCESS_TOKEN_KEY, token),
    getRefreshToken: () => secrets.get(REFRESH_TOKEN_KEY),
    setRefreshToken: (token: string) => secrets.store(REFRESH_TOKEN_KEY, token),
    clear: async () => {
      await secrets.delete(ACCESS_TOKEN_KEY);
      await secrets.delete(REFRESH_TOKEN_KEY);
    },
  };
}
