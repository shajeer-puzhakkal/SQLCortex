import {
  createApiClient as createBaseApiClient,
  type ApiClient as BaseApiClient,
} from "../../api/client";
import { normalizeApiError as normalizeBaseApiError } from "../errors/normalizeApiError";

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
  return normalizeBaseApiError(err);
}
