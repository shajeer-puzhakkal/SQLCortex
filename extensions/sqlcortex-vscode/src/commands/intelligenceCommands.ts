import * as vscode from "vscode";
import { formatApiError, type ApiClient } from "../api/client";
import { scoreIntelligence } from "../api/endpoints";
import { IntelligencePipeline } from "../intelligence/pipeline";

export const SCORE_CURRENT_QUERY_FAST_COMMAND_ID = "sqlcortex.scoreCurrentQueryFast";
export const SCORE_CURRENT_QUERY_WITH_PLAN_COMMAND_ID =
  "sqlcortex.scoreCurrentQueryWithPlan";
export const TOGGLE_REALTIME_SCORING_COMMAND_ID = "sqlcortex.toggleRealtimeScoring";

export const INTELLIGENCE_REALTIME_SETTING = "intelligence.realTimeScoringEnabled";
export const INTELLIGENCE_DEBOUNCE_SETTING = "intelligence.debounceMs";

const PLAN_MODE_USAGE_COUNT_KEY = "sqlcortex.intelligence.planModeUsageCount";

type IntelligencePlanContext = {
  client: ApiClient;
  projectId: string;
  connectionId: string;
};

type IntelligenceCommandDeps = {
  context: vscode.ExtensionContext;
  output: vscode.OutputChannel;
  pipeline: IntelligencePipeline;
  resolvePlanContext: () => Promise<IntelligencePlanContext | null>;
};

async function trackPlanModeUsage(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  fingerprint: string
): Promise<void> {
  const previous = context.workspaceState.get<number>(PLAN_MODE_USAGE_COUNT_KEY, 0);
  const next = previous + 1;
  await context.workspaceState.update(PLAN_MODE_USAGE_COUNT_KEY, next);
  output.appendLine(
    `SQLCortex telemetry: intelligence.plan_mode_used=${next}, fingerprint=${fingerprint.slice(0, 12)}`
  );
}

export function createIntelligenceCommandHandlers(
  deps: IntelligenceCommandDeps
): Record<string, () => Promise<void>> {
  return {
    [SCORE_CURRENT_QUERY_FAST_COMMAND_ID]: async () => {
      const snapshot = await deps.pipeline.scoreCurrentQueryFast();
      if (!snapshot) {
        vscode.window.showWarningMessage(
          "SQLCortex: Place your cursor in a SQL statement to score it."
        );
        return;
      }

      vscode.window.showInformationMessage(
        `SQLCortex: Fast score ${snapshot.result.performance_score}/100 (${snapshot.result.risk_level}).`
      );
    },

    [SCORE_CURRENT_QUERY_WITH_PLAN_COMMAND_ID]: async () => {
      const statementContext = deps.pipeline.getActiveStatementContext();
      if (!statementContext) {
        vscode.window.showWarningMessage(
          "SQLCortex: Place your cursor in a SQL statement to run plan scoring."
        );
        return;
      }

      const planContext = await deps.resolvePlanContext();
      if (!planContext) {
        return;
      }

      deps.output.appendLine(
        `SQLCortex intelligence: running plan score (${statementContext.fingerprint.slice(0, 12)}).`
      );

      try {
        const response = await scoreIntelligence(planContext.client, {
          mode: "plan",
          sql: statementContext.statement.sql,
          project_id: planContext.projectId,
          connection_id: planContext.connectionId,
        });
        const applied = deps.pipeline.applyExternalResult(
          statementContext,
          response,
          "plan"
        );
        await trackPlanModeUsage(
          deps.context,
          deps.output,
          statementContext.fingerprint
        );

        if (!applied) {
          deps.output.appendLine(
            "SQLCortex intelligence: plan score completed but editor state changed before render."
          );
          vscode.window.showInformationMessage(
            "SQLCortex: Plan score finished, but the editor changed before it could be displayed."
          );
          return;
        }

        vscode.window.showInformationMessage(
          `SQLCortex: Plan score ${response.performance_score}/100 (${response.cost_bucket} cost).`
        );
      } catch (err) {
        const message = formatApiError(err);
        deps.output.appendLine(`SQLCortex: Plan scoring failed: ${message}`);
        vscode.window.showErrorMessage(`SQLCortex: ${message}`);
      }
    },

    [TOGGLE_REALTIME_SCORING_COMMAND_ID]: async () => {
      const configuration = vscode.workspace.getConfiguration("sqlcortex");
      const current = configuration.get<boolean>(INTELLIGENCE_REALTIME_SETTING, true);
      const next = !current;

      await configuration.update(
        INTELLIGENCE_REALTIME_SETTING,
        next,
        vscode.ConfigurationTarget.Global
      );

      if (next) {
        deps.pipeline.requestImmediateRefresh();
      } else {
        deps.pipeline.clearActiveEditor();
      }

      vscode.window.showInformationMessage(
        `SQLCortex: Real-time scoring ${next ? "enabled" : "disabled"}.`
      );
    },
  };
}
