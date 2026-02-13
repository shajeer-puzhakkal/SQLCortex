import {
  createApiClient as createBaseApiClient,
  formatApiError as formatBaseApiError,
  type ApiClient as BaseApiClient,
} from "../../api/client";

export type ApiClient = BaseApiClient;

export type ApiClientOptions = {
  baseUrl: string;
  token: string;
  clientHeader: string;
};

export function createApiClient(options: ApiClientOptions): ApiClient {
  return createBaseApiClient({
    baseUrl: options.baseUrl,
    token: options.token,
    clientHeader: options.clientHeader,
  });
}

export function normalizeApiError(err: unknown): string {
  return formatBaseApiError(err);
}
