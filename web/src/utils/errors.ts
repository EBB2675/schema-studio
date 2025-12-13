export const formatApiError = (error: any): string => {
  if (error?.response?.data?.detail) return String(error.response.data.detail);
  if (error?.message) return String(error.message);
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "Unexpected error";
  }
};
