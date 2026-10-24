export interface HttpResult {
  status: number;
  body: unknown;
  headers: Headers;
}

export type HttpHeaders = Record<string, string>;

export interface HttpClient {
  get(path: string): Promise<HttpResult>;
  post(path: string, body: unknown, headers?: HttpHeaders): Promise<HttpResult>;
  postRaw(
    path: string,
    raw: string,
    contentType?: string,
    headers?: HttpHeaders,
  ): Promise<HttpResult>;
}

async function read(response: Response): Promise<HttpResult> {
  const text = await response.text();
  let body: unknown = text;

  try {
    body = text === "" ? undefined : JSON.parse(text);
  } catch {
    body = text;
  }

  return { status: response.status, body, headers: response.headers };
}

export function createHttpClient(baseUrl: string): HttpClient {
  return {
    get: async (path) => read(await fetch(`${baseUrl}${path}`)),
    post: async (path, body, headers = {}) =>
      read(
        await fetch(`${baseUrl}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        }),
      ),
    postRaw: async (path, raw, contentType = "application/json", headers = {}) =>
      read(
        await fetch(`${baseUrl}${path}`, {
          method: "POST",
          headers: { "content-type": contentType, ...headers },
          body: raw,
        }),
      ),
  };
}
