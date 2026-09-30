import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/**
 * Buffered fetch for non-streaming SDK completions. Node's fetch has a 300-second
 * headers timeout; this transport leaves the only deadline to the caller's signal.
 * Fresh default agents preserve Node's TLS trust (including NODE_EXTRA_CA_CERTS)
 * without inheriting an SDK agent's socket timeout. Proxy routing is not supported.
 */
export const completionFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(`Unsupported completion protocol: ${url.protocol}`);
  }
  const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
  request.signal.throwIfAborted();
  return new Promise<Response>((resolve, reject) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(url, {
      method: request.method,
      headers: Object.fromEntries(request.headers),
      signal: request.signal,
      agent: false,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => {
        const headers = new Headers();
        for (let index = 0; index < res.rawHeaders.length; index += 2) {
          headers.append(res.rawHeaders[index], res.rawHeaders[index + 1]);
        }
        const status = res.statusCode!;
        try {
          resolve(new Response(
            request.method === "HEAD" || status === 204 || status === 205 || status === 304
              ? null : Buffer.concat(chunks),
            { status, statusText: res.statusMessage, headers },
          ));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(0);
    req.end(body);
  });
};
