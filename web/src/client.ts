import axios, { AxiosError, AxiosHeaders, type AxiosInstance, type InternalAxiosRequestConfig } from "axios";

import { API_FEATURE_HEADER, API_VERSION, API_VERSION_HEADER, DEFAULT_FEATURE_FLAGS } from "./constants/api";
import { DEFAULT_API } from "./constants/defaults";
import type { StaticAnswer, StaticBackend } from "./static/backend";

/** Version headers for the browser-local request contract. */
export function apiHeaders(): Record<string, string> {
  return { [API_VERSION_HEADER]: API_VERSION, [API_FEATURE_HEADER]: DEFAULT_FEATURE_FLAGS.join(",") };
}

// ---------- static site ----------

// The browser backend and worker are loaded on first use.
let staticBackend: Promise<StaticBackend> | null = null;

/** The backend of the static site (created on first use). */
export function getStaticBackend(): Promise<StaticBackend> {
  staticBackend ??= Promise.all([import("./static/backend"), import("./static/workerCore")]).then(
    ([{ StaticHttpError, createStaticBackend }, { runInWorker }]) => createStaticBackend({
      readJson: async (path) => {
        const response = await fetch(new URL(`data/${path}`, new URL(import.meta.env.BASE_URL, window.location.href)));
        if (!response.ok) throw new StaticHttpError(500, `Could not load ${path} from the site (${response.status}).`);
        return response.json();
      },
      runCore: runInWorker,
    }),
  );
  return staticBackend;
}

/** Replace the static backend (tests). */
export function setStaticBackend(backend: StaticBackend | null): void {
  staticBackend = backend ? Promise.resolve(backend) : null;
}

function parseBody(data: unknown): unknown {
  if (typeof data !== "string") return data;
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

function staticError(error: unknown): StaticAnswer {
  const status = (error as { status?: unknown })?.status;
  const detail = (error as { detail?: unknown })?.detail;
  if (typeof status === "number" && typeof detail === "string") return { status, data: { detail } };
  return { status: 500, data: { detail: error instanceof Error ? error.message : String(error) } };
}

async function answerStatically(method: string, path: string, params?: Record<string, unknown>, body?: unknown) {
  try {
    return await (await getStaticBackend()).request(method, path, params ?? {}, parseBody(body));
  } catch (error) {
    return staticError(error);
  }
}

/** An Axios adapter that answers from the static backend, with the same response shapes and errors as HTTP. */
async function staticAdapter(config: InternalAxiosRequestConfig) {
  const answer = await answerStatically((config.method || "get").toUpperCase(), config.url || "/", config.params, config.data);
  let data = answer.data;
  if (config.responseType === "blob") {
    const type = answer.contentType ?? "application/json";
    data = new Blob([typeof data === "string" ? data : JSON.stringify(data)], { type });
  }
  const response = { data, status: answer.status, statusText: String(answer.status), headers: new AxiosHeaders(), config, request: {} };
  if (answer.status >= 400) {
    throw new AxiosError(`Request failed with status code ${answer.status}`, AxiosError.ERR_BAD_RESPONSE, config, {}, response);
  }
  return response;
}

// ---------- the client ----------

/** An Axios instance for the backend; paths are relative to `baseURL`. */
export function createApiClient(baseURL: string = DEFAULT_API): AxiosInstance {
  const instance = axios.create({ baseURL });
  instance.defaults.adapter = staticAdapter;
  instance.interceptors.request.use((config) => {
    config.headers = config.headers ?? {};
    for (const [name, value] of Object.entries(apiHeaders())) {
      config.headers[name] = value;
    }
    return config;
  });
  return instance;
}

/** `fetch` for a backend path (`/overview?...`), with the API headers added to `init`. */
export async function apiFetch(path: string, init: RequestInit = {}) {
  const answer = await answerStatically((init.method || "GET").toUpperCase(), path, undefined, init.body);
  const text = typeof answer.data === "string" ? answer.data : JSON.stringify(answer.data);
  return new Response(text, { status: answer.status, headers: { "Content-Type": answer.contentType ?? "application/json" } });
}
