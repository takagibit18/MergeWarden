/** Client-facing errors contain only fixed messages, never storage/provider exceptions. */
export class HttpError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly fieldErrors?: Record<string, string[]>;
  constructor(code: string, message: string, statusCode: number, fieldErrors?: Record<string, string[]>) {
    super(message);
    this.name = 'HttpError';
    this.code = code;
    this.statusCode = statusCode;
    if (fieldErrors) this.fieldErrors = fieldErrors;
  }
}
