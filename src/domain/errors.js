// Domain error with a user-facing Spanish message and an HTTP-ish status.
export class DomainError extends Error {
  constructor(message, status = 400, code = 'invalid') {
    super(message);
    this.status = status;
    this.code = code;
  }
}
