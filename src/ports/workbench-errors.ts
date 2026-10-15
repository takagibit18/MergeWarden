export class WorkbenchError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = 'WorkbenchError';
    this.code = code;
    this.statusCode = statusCode;
  }
}
