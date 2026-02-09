export const formatApiError = (error: unknown): string => {
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    const maybeResponse = (error as { response?: { data?: { detail?: unknown } } }).response;
    if (maybeResponse?.data?.detail) return String(maybeResponse.data.detail);
    if ("message" in error && typeof (error as { message?: unknown }).message !== "undefined") {
      return String((error as { message?: unknown }).message);
    }
  }
  try {
    return JSON.stringify(error);
  } catch {
    return "Unexpected error";
  }
};
