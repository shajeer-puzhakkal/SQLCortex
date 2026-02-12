import * as vscode from "vscode";
import type { ConnectionProfile } from "./ConnectionTypes";

const PROFILE_KEY = "sqlcortex.connectionProfiles";

function passwordKey(profileId: string): string {
  return `sqlcortex:conn:${profileId}:password`;
}

export class ConnectionProfileStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  listProfiles(): ConnectionProfile[] {
    const profiles =
      this.context.globalState.get<ConnectionProfile[]>(PROFILE_KEY, []) ?? [];
    return profiles.slice().sort((a, b) => a.name.localeCompare(b.name));
  }

  getProfile(profileId: string): ConnectionProfile | null {
    const profiles = this.listProfiles();
    return profiles.find((profile) => profile.id === profileId) ?? null;
  }

  async saveProfile(profile: ConnectionProfile): Promise<void> {
    const profiles = this.listProfiles();
    const index = profiles.findIndex((item) => item.id === profile.id);
    if (index >= 0) {
      profiles[index] = profile;
    } else {
      profiles.push(profile);
    }
    await this.context.globalState.update(PROFILE_KEY, profiles);
  }

  async deleteProfile(profileId: string): Promise<void> {
    const profiles = this.listProfiles().filter((item) => item.id !== profileId);
    await this.context.globalState.update(PROFILE_KEY, profiles);
    await this.context.secrets.delete(passwordKey(profileId));
  }

  async setPassword(profileId: string, password: string): Promise<void> {
    await this.context.secrets.store(passwordKey(profileId), password);
  }

  async getPassword(profileId: string): Promise<string | null> {
    const value = await this.context.secrets.get(passwordKey(profileId));
    return value ?? null;
  }
}
