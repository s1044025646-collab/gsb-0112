export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus = 400,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export const ERR = {
  notFound: (what: string) => new DomainError("NOT_FOUND", `${what} not found`, 404),
  validation: (msg: string) => new DomainError("VALIDATION_ERROR", msg, 422),
  conflict: (code: string, msg: string) => new DomainError(code, msg, 409),
  forbidden: (msg: string) => new DomainError("FORBIDDEN", msg, 403),
};
