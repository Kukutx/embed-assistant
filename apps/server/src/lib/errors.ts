import { ErrorCode } from "@embed-assistant/protocol";

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  origin_not_allowed: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  budget_exceeded: 429,
  model_unavailable: 503,
  internal_error: 500,
};

export class ApiError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.status = STATUS[code];
  }
}

export const notFound = (what: string) => new ApiError(ErrorCode.NotFound, `${what} not found`);
export const badRequest = (message: string, details?: unknown) =>
  new ApiError(ErrorCode.BadRequest, message, details);
export const unauthorized = (message = "missing or invalid credentials") =>
  new ApiError(ErrorCode.Unauthorized, message);
export const forbidden = (message = "not allowed") => new ApiError(ErrorCode.Forbidden, message);
