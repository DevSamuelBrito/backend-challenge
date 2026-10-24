import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from "@nestjs/common";
import { LockTimeoutError } from "../../application/persistence-errors";
import { ConflictError, DomainError, NotFoundError } from "../../domain/domain-error";

interface HttpResponse {
  status(code: number): HttpResponse;
  setHeader(name: string, value: string): unknown;
  json(body: unknown): unknown;
}

interface Translated {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const CODE_BY_STATUS: Record<number, string> = {
  400: "INVALID_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  413: "PAYLOAD_TOO_LARGE",
};

function codeForStatus(status: number): string {
  return CODE_BY_STATUS[status] ?? `HTTP_${status}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function clientErrorStatus(error: unknown): number | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  const status = error.status ?? error.statusCode;

  return typeof status === "number" && status >= 400 && status < 500 ? status : undefined;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponse>();
    const { status, body, headers } = this.translate(exception);

    for (const [name, value] of Object.entries(headers ?? {})) {
      response.setHeader(name, value);
    }

    response.status(status).json(body);
  }

  private translate(exception: unknown): Translated {
    if (exception instanceof LockTimeoutError) {
      return {
        status: 503,
        body: { code: exception.code, message: exception.message },
        headers: { "Retry-After": "1" },
      };
    }

    if (exception instanceof DomainError) {
      return {
        status: this.statusOfDomainError(exception),
        body: { code: exception.code, message: exception.message },
      };
    }

    if (exception instanceof HttpException) {
      const payload = exception.getResponse();

      if (isRecord(payload) && !("statusCode" in payload)) {
        return { status: exception.getStatus(), body: payload };
      }

      return this.clientError(exception.getStatus(), exception.message);
    }

    const status = clientErrorStatus(exception);

    if (status !== undefined) {
      return this.clientError(status, (exception as Error).message);
    }

    this.logger.error(
      exception instanceof Error ? (exception.stack ?? exception.message) : exception,
    );

    return {
      status: 500,
      body: { code: "INTERNAL_ERROR", message: "Erro interno do servidor" },
    };
  }

  private statusOfDomainError(error: DomainError): number {
    if (error instanceof NotFoundError) {
      return 404;
    }

    return error instanceof ConflictError ? 409 : 400;
  }

  private clientError(status: number, message: string): Translated {
    return { status, body: { code: codeForStatus(status), message } };
  }
}
