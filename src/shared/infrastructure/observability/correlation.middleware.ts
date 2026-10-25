import { Inject, Injectable, Logger, type NestMiddleware } from "@nestjs/common";
import { validCorrelationId } from "../../application/correlation-id";
import { ID_GENERATOR, type IdGenerator } from "../../application/id-generator.port";
import { type RequestContext, runWithContext } from "../../application/request-context";

interface Request {
  method: string;
  originalUrl?: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
}

interface Response {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  on(event: "finish", listener: () => void): unknown;
}

export const CORRELATION_HEADER = "x-correlation-id";
const QUIET_PATHS = ["/health", "/metrics"];

@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  private readonly logger = new Logger("Http");

  constructor(@Inject(ID_GENERATOR) private readonly ids: IdGenerator) {}

  use(request: Request, response: Response, next: () => void): void {
    const correlationId =
      validCorrelationId(request.headers[CORRELATION_HEADER]) ?? this.ids.next();
    const context: RequestContext = { correlationId };
    const startedAt = performance.now();
    const path = (request.originalUrl ?? request.url).split("?")[0] ?? "";

    response.setHeader("X-Correlation-Id", correlationId);

    if (!QUIET_PATHS.some((quiet) => path.startsWith(quiet))) {
      response.on("finish", () => {
        this.logger.log({
          event: "http.request",
          ...context,
          method: request.method,
          path,
          statusCode: response.statusCode,
          durationMs: Math.round(performance.now() - startedAt),
        });
      });
    }

    runWithContext(context, next);
  }
}
