import * as vscode from "vscode";
import { SchemaTreeNode } from "./SchemaTreeNode";

type PlaceholderOptions = {
  icon: string;
  message: string;
  action?: {
    label: string;
    commandId: string;
    icon: string;
  };
  detail?: string;
};

export function createLoginRequiredNode(): SchemaTreeNode {
  return createPlaceholderNode("Login required", {
    icon: "key",
    message: "Login to DB Copilot to load schema snapshots.",
    action: {
      label: "Login with Token",
      commandId: "dbcopilot.loginWithToken",
      icon: "account",
    },
  });
}

export function createSelectTargetNode(): SchemaTreeNode {
  return createPlaceholderNode("Select target", {
    icon: "target",
    message: "Select an Org / Project / Environment to browse schema objects.",
    action: {
      label: "Select Target",
      commandId: "dbcopilot.selectTarget",
      icon: "link-external",
    },
  });
}

export function createLoadingNode(): SchemaTreeNode {
  return createPlaceholderNode("Loading schema", {
    icon: "loading~spin",
    message: "Refreshing schema snapshot from local store.",
  });
}

export function createErrorNode(errorMessage: string | null): SchemaTreeNode {
  return createPlaceholderNode("Schema unavailable", {
    icon: "error",
    message: "Schema snapshot failed to load.",
    detail: errorMessage ?? "Unknown error.",
    action: {
      label: "Refresh",
      commandId: "dbcopilot.refreshSchema",
      icon: "refresh",
    },
  });
}

export function createEmptySnapshotNode(): SchemaTreeNode {
  return createPlaceholderNode("No snapshot", {
    icon: "database",
    message: "Capture or refresh a schema snapshot to populate this tree.",
    action: {
      label: "Refresh",
      commandId: "dbcopilot.refreshSchema",
      icon: "refresh",
    },
  });
}

function createPlaceholderNode(label: string, options: PlaceholderOptions): SchemaTreeNode {
  const children: SchemaTreeNode[] = [
    new SchemaTreeNode(options.message, {
      icon: options.icon,
      id: `dbcopilot.schema.placeholder.${slugify(label)}.message`,
    }),
  ];

  if (options.detail) {
    children.push(
      new SchemaTreeNode(options.detail, {
        icon: "info",
        id: `dbcopilot.schema.placeholder.${slugify(label)}.detail`,
      })
    );
  }

  if (options.action) {
    children.push(
      new SchemaTreeNode(options.action.label, {
        icon: options.action.icon,
        commandId: options.action.commandId,
        id: `dbcopilot.schema.placeholder.${slugify(label)}.action.${slugify(
          options.action.commandId
        )}`,
      })
    );
  }

  return new SchemaTreeNode(label, {
    collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
    children,
    icon: options.icon,
    id: `dbcopilot.schema.placeholder.${slugify(label)}`,
  });
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}
