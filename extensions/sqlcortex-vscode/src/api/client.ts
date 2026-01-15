import type { ApiError } from "./types";

const DEFAULT_TIMEOUT_MS = 10000;

export type ApiClientOptions = {
  baseUrl: string;
  token?: string | null;
  clientHeader: string;
  timeoutMs?: number;
  onUnauthorized?: () => void | Promise<void>;
};

type ApiRequestInit = Omit<RequestInit, "body"> & {
  body?: BodyInit | Record<string, unknown> | null;
};

export type ApiClient = {
  get<T>(path: string, init?: ApiRequestInit): Promise<T>;
  post<T>(path: string, body?: BodyInit | Record<string, unknown> | null, init?: ApiRequestInit): Promise<T>;
  request<T>(path: string, init?: ApiRequestInit): Promise<T>;
};

export class ApiClientError extends Error {
  status?: number;
  code?: string;
  details?: unknown;
  isTimeout?: boolean;
  isNetworkError?: boolean;

  constructor(
    message: string,
    options?: {
      status?: number;
      code?: string;
      details?: unknown;
      isTimeout?: boolean;
      isNetworkError?: boolean;
    }
  ) {
    super(message);
    this.name = "ApiClientError";
    this.status = options?.status;
    this.code = options?.code;
    this.details = options?.details;
    this.isTimeout = options?.isTimeout;
    this.isNetworkError = options?.isNetworkError;
  }
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const request = async <T>(path: string, init: ApiRequestInit = {}): Promise<T> => {
    const url = buildUrl(baseUrl, path);
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    headers.set("X-SQLCortex-Client", options.clientHeader);
    if (options.token) {
      headers.set("Authorization", `Bearer ${options.token}`);
    }

    let body = init.body;
    if (body !== undefined && body !== null) {
      if (typeof body === "string") {
        // Leave as-is for non-JSON payloads.
      } else {
        headers.set("Content-Type", "application/json");
        body = JSON.stringify(body);
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers,
        body: body as BodyInit | null | undefined,
        signal: controller.signal,
      });
    } catch (err) {
      if (isAbortError(err)) {
        throw new ApiClientError("Request timed out. Please try again.", {
          isTimeout: true,
        });
      }
      throw new ApiClientError(
        "Network error. Check your connection or API base URL.",
        { isNetworkError: true }
      );
    } finally {
      clearTimeout(timeout);
    }

    const text = await response.text();
    const payload = parseJson(text);

    if (!response.ok) {
      const apiError = isApiError(payload) ? payload : null;
      const message = mapErrorMessage(response.status, apiError);
      if (response.status === 401 && options.onUnauthorized) {
        await options.onUnauthorized();
      }
      throw new ApiClientError(message, {
        status: response.status,
        code: apiError?.code,
        details: apiError?.details,
      });
    }

    if (!text) {
      return {} as T;
    }

    if (payload === null) {
      throw new ApiClientError("Unexpected response from SQLCortex API.", {
        status: response.status,
      });
    }

    return payload as T;
  };

  return {
    request,
    get: (path, init) => request(path, { ...init, method: "GET" }),
    post: (path, body, init) => request(path, { ...init, method: "POST", body }),
  };
}

export function formatApiError(err: unknown): string {
  if (err instanceof ApiClientError) {
    return err.message;
  }
  if (err instanceof Error && err.message) {
    return err.message;
  }
  return "Request failed.";
}

function buildUrl(baseUrl: string, path: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path;
  }
  if (path.startsWith("/")) {
    return `${baseUrl}${path}`;
  }
  return `${baseUrl}/${path}`;
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function parseJson(text: string): unknown | null {
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function isApiError(payload: unknown): payload is ApiError {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  const candidate = payload as { code?: unknown; message?: unknown };
  return typeof candidate.code === "string" || typeof candidate.message === "string";
}

function mapErrorMessage(status: number, apiError: ApiError | null): string {
  if (status === 401) {
    return "Session expired. Please log in again.";
  }
  if (status === 403 || apiError?.code === "FORBIDDEN") {
    return "You do not have access to this resource.";
  }
  if (status === 422 || apiError?.code === "INVALID_INPUT") {
    return apiError?.message ?? "The request was invalid. Check your input.";
  }
  if (apiError?.code === "SQL_NOT_READ_ONLY") {
    return "Only read-only queries are allowed.";
  }
  if (apiError?.code === "INVALID_EXPLAIN_JSON") {
    return "Invalid EXPLAIN JSON payload.";
  }
  if (apiError?.code === "RATE_LIMITED") {
    return "Rate limit exceeded. Try again later.";
  }
  if (apiError?.code === "PLAN_LIMIT_EXCEEDED") {
    return "Plan limit exceeded. Upgrade to run more queries.";
  }
  if (apiError?.code === "ANALYZER_TIMEOUT") {
    return "Analyzer timed out. Try again with a simpler query.";
  }
  if (apiError?.code === "ANALYZER_ERROR") {
    return "Analyzer error. Try again later.";
  }
  if (status >= 500) {
    return "SQLCortex server error. Try again later.";
  }
  if (apiError?.message) {
    return apiError.message;
  }
  return `Request failed (HTTP ${status})`;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}
