import {
  ApiClientError,
  createApiClient as createBaseApiClient,
  type ApiClient as BaseApiClient,
} from "../../api/client";
import { normalizeApiError as normalizeBaseApiError } from "../errors/normalizeApiError";

export type ApiClient = BaseApiClient;

const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 300;
const RETRYABLE_HTTP_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export type ApiClientOptions = {
  baseUrl: string;
  token: string;
  clientHeader: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
};

export function createApiClient(options: ApiClientOptions): ApiClient {
  const client = createBaseApiClient({
    baseUrl: options.baseUrl,
    token: options.token,
    clientHeader: options.clientHeader,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });

  const maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);

  const runWithRetry = async <T>(request: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await request();
      } catch (err) {
        if (!isRetryableError(err) || attempt >= maxRetries) {
          throw err;
        }
        await sleep(retryDelayMs * (attempt + 1));
      }
    }
  };

  return {
    request: (path, init) => runWithRetry(() => client.request(path, init)),
    get: (path, init) => runWithRetry(() => client.get(path, init)),
    post: (path, body, init) => runWithRetry(() => client.post(path, body, init)),
  };
}

export function normalizeApiError(err: unknown): string {
  return normalizeBaseApiError(err);
}

function isRetryableError(err: unknown): boolean {
  if (!(err instanceof ApiClientError)) {
    return false;
  }
  if (err.isNetworkError || err.isTimeout) {
    return true;
  }
  if (typeof err.status === "number") {
    return RETRYABLE_HTTP_STATUS.has(err.status);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
