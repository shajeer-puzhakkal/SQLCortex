import { ApiClientError, formatApiError } from "../../api/client";

export function normalizeApiError(err: unknown): string {
  if (err instanceof ApiClientError) {
    if (err.isTimeout) {
      return "Request timed out while contacting SQLCortex API.";
    }
    if (err.isNetworkError) {
      return "Cannot reach SQLCortex API. Check your network or API base URL.";
    }
    if (err.status === 401) {
      return "Session expired. Please log in again.";
    }
    if (err.status === 403) {
      return "You do not have access to this target.";
    }
    if (err.status === 404) {
      return "Selected target was not found. Re-select target and try again.";
    }
    return err.message;
  }

  return formatApiError(err);
}
