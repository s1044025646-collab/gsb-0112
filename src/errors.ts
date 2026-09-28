export type ErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "CONFLICT"
  | "ELIGIBILITY_NOT_MET"
  | "CONSENT_MISSING"
  | "FORBIDDEN_BLINDED_ROLE"
  | "FORBIDDEN"
  | "SUBJECT_STATE_INVALID"
  | "RANDOMIZATION_POOL_EXHAUSTED";

export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public httpStatus = 400
  ) {
    super(message);
  }
}

export const err = {
  validation: (m: string) => new AppError("VALIDATION_ERROR", m, 400),
  notFound: (m: string) => new AppError("NOT_FOUND", m, 404),
  conflict: (m: string) => new AppError("CONFLICT", m, 409),
  eligibility: (m: string) => new AppError("ELIGIBILITY_NOT_MET", m, 422),
  consent: (m: string) => new AppError("CONSENT_MISSING", m, 422),
  blinded: (m: string) => new AppError("FORBIDDEN_BLINDED_ROLE", m, 403),
  forbidden: (m: string) => new AppError("FORBIDDEN", m, 403),
  state: (m: string) => new AppError("SUBJECT_STATE_INVALID", m, 409),
  pool: (m: string) => new AppError("RANDOMIZATION_POOL_EXHAUSTED", m, 409),
};
