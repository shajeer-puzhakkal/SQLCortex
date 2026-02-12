import * as vscode from "vscode";
import { Pool } from "pg";
import type { ConnectionProfile, ConnectionState, ConnectionSslMode } from "./ConnectionTypes";
import type { ConnectionProfileStore } from "./ConnectionProfileStore";
import type { LogBus } from "../logging/LogBus";

type ConnectionManagerDeps = {
  profileStore: ConnectionProfileStore;
  logBus?: LogBus;
};

export class ConnectionManager implements vscode.Disposable {
  private pool: Pool | null = null;
  private currentProfile: ConnectionProfile | null = null;
  private readonly stateEmitter = new vscode.EventEmitter<ConnectionState>();
  readonly onDidChangeConnectionState = this.stateEmitter.event;

  constructor(private readonly deps: ConnectionManagerDeps) {}

  async connect(profileId: string): Promise<void> {
    const profile = this.deps.profileStore.getProfile(profileId);
    if (!profile) {
      throw new Error("Connection profile not found.");
    }
    const password = await this.deps.profileStore.getPassword(profileId);
    if (!password) {
      throw new Error("Password not found for selected connection.");
    }

    if (this.pool) {
      await this.disconnect();
    }

    const config = this.buildPoolConfig(profile, password);
    const pool = new Pool(config);
    const label = this.buildDisplayLabel(profile);
    this.deps.logBus?.log(`Connecting to ${label}.`);

    try {
      await pool.query("SELECT 1");
    } catch (err) {
      await pool.end().catch(() => undefined);
      this.deps.logBus?.error(`Connection failed for ${label}.`, err);
      throw err;
    }

    this.pool = pool;
    this.currentProfile = profile;
    this.stateEmitter.fire({ status: "connected", profile });
    this.deps.logBus?.log(`Connected to ${label}.`);
  }

  async disconnect(): Promise<void> {
    if (!this.pool && !this.currentProfile) {
      return;
    }
    const label = this.currentProfile ? this.buildDisplayLabel(this.currentProfile) : "database";
    if (this.pool) {
      try {
        await this.pool.end();
      } catch (err) {
        this.deps.logBus?.error(`Failed to close connection for ${label}.`, err);
      }
    }
    this.pool = null;
    this.currentProfile = null;
    this.stateEmitter.fire({ status: "disconnected", profile: null });
    this.deps.logBus?.log(`Disconnected from ${label}.`);
  }

  async reconnect(): Promise<void> {
    const profile = this.currentProfile;
    if (!profile) {
      throw new Error("No active connection to refresh.");
    }
    await this.connect(profile.id);
  }

  getPoolOrThrow(): Pool {
    if (!this.pool) {
      throw new Error("No active database connection.");
    }
    return this.pool;
  }

  getConnectionProfile(): ConnectionProfile | null {
    return this.currentProfile;
  }

  getConnectionLabel(): string | null {
    if (!this.currentProfile) {
      return null;
    }
    return this.buildDisplayLabel(this.currentProfile);
  }

  getConnectionTag(): string | null {
    if (!this.currentProfile) {
      return null;
    }
    return this.buildInternalLabel(this.currentProfile);
  }

  dispose(): void {
    void this.disconnect();
    this.stateEmitter.dispose();
  }

  private buildPoolConfig(profile: ConnectionProfile, password: string): {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    ssl?: boolean | { rejectUnauthorized: boolean };
  } {
    return {
      host: profile.host,
      port: profile.port,
      database: profile.database,
      user: profile.user,
      password,
      ssl: this.resolveSsl(profile.sslMode),
    };
  }

  private resolveSsl(mode: ConnectionSslMode): boolean | { rejectUnauthorized: boolean } | undefined {
    if (mode === "disable") {
      return false;
    }
    if (mode === "require") {
      return { rejectUnauthorized: false };
    }
    return undefined;
  }

  private buildDisplayLabel(profile: ConnectionProfile): string {
    return `${profile.user}@${profile.host}:${profile.port}/${profile.database}`;
  }

  private buildInternalLabel(profile: ConnectionProfile): string {
    return `postgres:${profile.name}@${profile.host}:${profile.port}/${profile.database}`;
  }
}
