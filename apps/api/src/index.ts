import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  AnalysisCreateRequest,
  AnalysisCreateResponse,
  AnalysisGetResponse,
  ErrorResponse,
  HealthResponse,
  makeError,
  mapAnalysisToResource,
} from "./contracts";

dotenv.config();

const app = express();
const prisma = new PrismaClient();

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res: Response<HealthResponse>) =>
  res.json({ ok: true, service: "api" })
);

app.post(
  "/api/v1/analyses",
  async (
    req: Request<unknown, unknown, AnalysisCreateRequest>,
    res: Response<AnalysisCreateResponse | ErrorResponse>
  ) => {
    const body = req.body;
    if (!body || typeof body.sql !== "string" || body.sql.trim().length === 0) {
      return res
        .status(400)
        .json(makeError("INVALID_INPUT", "`sql` is required and must be a string"));
    }

    if (typeof body.explain_json === "undefined") {
      return res
        .status(400)
        .json(
          makeError(
            "INVALID_EXPLAIN_JSON",
            "`explain_json` must be provided as object or array"
          )
        );
    }

    let explainJsonParsed: unknown;
    try {
      // Validate that the payload is JSON-serializable.
      const serialized = JSON.stringify(body.explain_json);
      explainJsonParsed = JSON.parse(serialized);
    } catch (err) {
      return res
        .status(400)
        .json(
          makeError(
            "INVALID_EXPLAIN_JSON",
            "Invalid JSON for `explain_json`",
            err instanceof Error ? { reason: err.message } : undefined
          )
        );
    }

    const analysis = await prisma.analysis.create({
      data: {
        sql: body.sql,
        explainJson: explainJsonParsed as Prisma.InputJsonValue,
        projectId: body.project_id ?? null,
        userId: body.user_id ?? null,
        status: "queued",
        result: null,
      },
    });

    return res.status(201).json({ analysis: mapAnalysisToResource(analysis) });
  }
);

app.get(
  "/api/v1/analyses/:id",
  async (
    req: Request<{ id: string }>,
    res: Response<AnalysisGetResponse | ErrorResponse>
  ) => {
    const analysis = await prisma.analysis.findUnique({
      where: { id: req.params.id },
    });

    if (!analysis) {
      return res.status(404).json(makeError("INVALID_INPUT", "Analysis not found"));
    }

    return res.json({ analysis: mapAnalysisToResource(analysis) });
  }
);

// Centralized error handler to preserve standardized error contract
app.use(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  (err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res
      .status(500)
      .json(makeError("ANALYZER_ERROR", "Unexpected server error", { reason: err.message }));
  }
);

const port = Number(process.env.PORT ?? process.env.API_PORT ?? 4000);
app.listen(port, () => console.log(`api listening on :${port}`));
