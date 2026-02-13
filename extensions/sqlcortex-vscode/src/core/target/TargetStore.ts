import * as vscode from "vscode";

const TARGET_KEY = "sqlcortex:selectedTarget";

export type SelectedTarget = {
  orgId: string | null;
  orgName: string;
  projectId: string;
  projectName: string;
  envId: string;
  envName: string;
};

export class TargetStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  getSelectedTarget(): SelectedTarget | null {
    return this.context.globalState.get<SelectedTarget | null>(TARGET_KEY, null);
  }

  async setSelectedTarget(target: SelectedTarget): Promise<void> {
    await this.context.globalState.update(TARGET_KEY, target);
  }

  async clearSelectedTarget(): Promise<void> {
    await this.context.globalState.update(TARGET_KEY, null);
  }
}
