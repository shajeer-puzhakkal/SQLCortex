import * as vscode from "vscode";
import type { DbCopilotSchemaSnapshotErrorCode } from "../../../state/dbCopilotState";
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

type SchemaErrorState = {
  message: string | null;
  code: DbCopilotSchemaSnapshotErrorCode | null;
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

export function createErrorNode(error: SchemaErrorState): SchemaTreeNode {
  const errorNode = resolveErrorNode(error);
  const detail =
    error.code === "unknown" ? error.message ?? errorNode.detail : errorNode.detail;
  return createPlaceholderNode("Schema unavailable", {
    icon: "error",
    message: errorNode.message,
    detail,
    action: errorNode.action,
  });
}

export function createEmptySnapshotNode(): SchemaTreeNode {
  return createPlaceholderNode("No snapshot", {
    icon: "database",
    message: "Capture a schema snapshot to populate this tree.",
    action: {
      label: "Capture Schema Snapshot",
      commandId: "dbcopilot.captureSchemaSnapshot",
      icon: "cloud-download",
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

function resolveErrorNode(error: SchemaErrorState): {
  message: string;
  detail: string;
  action?: PlaceholderOptions["action"];
} {
  switch (error.code) {
    case "unauthorized":
      return {
        message: "Session expired. Re-login to continue.",
        detail: "Your DB Copilot token is no longer valid.",
        action: {
          label: "Login with Token",
          commandId: "dbcopilot.loginWithToken",
          icon: "account",
        },
      };
    case "forbidden":
      return {
        message: "You do not have permission for this target.",
        detail: "Ask for access, or choose a different target.",
        action: {
          label: "Select Target",
          commandId: "dbcopilot.selectTarget",
          icon: "link-external",
        },
      };
    case "target_not_found":
      return {
        message: "Selected target is no longer available.",
        detail: "Re-select your Org / Project / Environment.",
        action: {
          label: "Select Target",
          commandId: "dbcopilot.selectTarget",
          icon: "target",
        },
      };
    case "backend_unreachable":
      return {
        message: "SQLCortex backend is unreachable.",
        detail: "Check network and API base URL, then retry.",
        action: {
          label: "Refresh",
          commandId: "dbcopilot.refreshSchema",
          icon: "refresh",
        },
      };
    case "timeout":
      return {
        message: "Schema refresh timed out.",
        detail: "The backend responded too slowly. Retry refresh.",
        action: {
          label: "Refresh",
          commandId: "dbcopilot.refreshSchema",
          icon: "refresh",
        },
      };
    default:
      return {
        message: "Schema snapshot failed to load.",
        detail: "Unknown error.",
        action: {
          label: "Refresh",
          commandId: "dbcopilot.refreshSchema",
          icon: "refresh",
        },
      };
  }
}
