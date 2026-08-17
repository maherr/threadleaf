export interface RequestUrlParam {
  url: string;
  method?: string;
  contentType?: string;
  body?: string | ArrayBuffer;
  headers?: Record<string, string>;
  throw?: boolean;
}

export interface RequestUrlResponse {
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  json: unknown;
  text: string;
}

export interface RequestUrlResponsePromise extends Promise<RequestUrlResponse> {
  arrayBuffer: Promise<ArrayBuffer>;
  json: Promise<unknown>;
  text: Promise<string>;
}

function normalizeRequest(request: RequestUrlParam | string): RequestUrlParam {
  return typeof request === "string" ? { url: request } : request;
}

async function performRequest(request: RequestUrlParam | string): Promise<RequestUrlResponse> {
  const input = normalizeRequest(request);
  if (!input.url || typeof input.url !== "string") {
    throw new TypeError("requestUrl requires a non-empty URL.");
  }
  if (typeof globalThis.fetch !== "function") {
    throw new Error("requestUrl is unavailable because this runtime has no fetch implementation.");
  }
  const headers = { ...(input.headers ?? {}) };
  if (input.contentType && !Object.hasOwn(headers, "Content-Type")) {
    headers["Content-Type"] = input.contentType;
  }
  const requestInit: RequestInit = { headers };
  if (input.method !== undefined) requestInit.method = input.method;
  if (input.body !== undefined) requestInit.body = input.body as BodyInit;
  const response = await globalThis.fetch(input.url, requestInit);
  const arrayBuffer = await response.arrayBuffer();
  const text = new TextDecoder().decode(arrayBuffer);
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });
  if (input.throw !== false && response.status >= 400) {
    throw new Error(`requestUrl failed with HTTP status ${response.status}.`);
  }
  let json: unknown = null;
  if (text.trim()) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return {
    arrayBuffer,
    headers: responseHeaders,
    json,
    status: response.status,
    text,
  };
}

function withResponseProperties(promise: Promise<RequestUrlResponse>): RequestUrlResponsePromise {
  const responsePromise = promise as RequestUrlResponsePromise;
  Object.defineProperties(responsePromise, {
    arrayBuffer: {
      configurable: false,
      enumerable: true,
      get: () => promise.then((response) => response.arrayBuffer),
    },
    json: {
      configurable: false,
      enumerable: true,
      get: () => promise.then((response) => response.json),
    },
    text: {
      configurable: false,
      enumerable: true,
      get: () => promise.then((response) => response.text),
    },
  });
  return responsePromise;
}

export function requestUrl(request: RequestUrlParam | string): RequestUrlResponsePromise {
  return withResponseProperties(performRequest(request));
}

export async function request(requestInput: RequestUrlParam | string): Promise<string> {
  return (await requestUrl(requestInput)).text;
}
