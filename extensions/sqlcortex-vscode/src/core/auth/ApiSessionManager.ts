import * as vscode from "vscode";
import { createApiClient, normalizeApiError, type ApiClient } from "../api/ApiClient";

const API_TOKEN_KEY = "sqlcortex:apiToken";

type MeResponse = {
  user?: {
    id: string;
    email: string;
    name: string | null;
  } | null;
  org?: {
    id: string;
    name: string;
  } | null;
};

export type ApiSession = {
  token: string;
  user: {
    id: string;
    email: string;
    name: string | null;
  } | null;
  org: {
    id: string;
    name: string;
  } | null;
};

type ApiSessionManagerDeps = {
  context: vscode.ExtensionContext;
  resolveBaseUrl: () => string | null;
  clientHeader: string;
};

export class ApiSessionManager {
  constructor(private readonly deps: ApiSessionManagerDeps) {}

  async getToken(): Promise<string | null> {
    const value = await this.deps.context.secrets.get(API_TOKEN_KEY);
    return value ?? null;
  }

  async loginWithToken(rawToken: string): Promise<ApiSession> {
    const token = rawToken.trim();
    if (!token) {
      throw new Error("Token cannot be empty.");
    }

    const client = this.createClientOrThrow(token);
    const payload = await client.get<MeResponse>("/api/v1/me");

    await this.deps.context.secrets.store(API_TOKEN_KEY, token);

    return {
      token,
      user: payload.user ?? null,
      org: payload.org ?? null,
    };
  }

  async logout(): Promise<void> {
    await this.deps.context.secrets.delete(API_TOKEN_KEY);
  }

  async getClientOrThrow(): Promise<ApiClient> {
    const token = await this.getToken();
    if (!token) {
      throw new Error("Not logged in.");
    }
    return this.createClientOrThrow(token);
  }

  formatError(err: unknown): string {
    return normalizeApiError(err);
  }

  private createClientOrThrow(token: string): ApiClient {
    const baseUrl = this.deps.resolveBaseUrl();
    if (!baseUrl) {
      throw new Error("API base URL is not configured.");
    }
    return createApiClient({
      baseUrl,
      token,
      clientHeader: this.deps.clientHeader,
    });
  }
}
