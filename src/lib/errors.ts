export type ErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'card_error'
  | 'api_error';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly type: ErrorType,
    readonly code: string,
    message: string,
    readonly param?: string,
  ) {
    super(message);
  }

  toJSON() {
    return { error: { type: this.type, code: this.code, message: this.message, param: this.param } };
  }
}

export const notFound = (what: string, id: string) =>
  new ApiError(404, 'invalid_request_error', 'resource_missing', `No such ${what}: '${id}'`);

export const invalidState = (message: string) =>
  new ApiError(409, 'invalid_request_error', 'invalid_state', message);
