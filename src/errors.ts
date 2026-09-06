export class DiscoveryError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "DiscoveryError";
  }
}

export function publicError(error: unknown) {
  const safe =
    error instanceof DiscoveryError
      ? error
      : new DiscoveryError("INTERNAL_ERROR", "Inspia discovery could not complete this request.");
  return {
    code: safe.code,
    message: safe.message,
    retryable: safe.retryable,
    ...(safe.retryAfterSeconds !== undefined ? { retryAfterSeconds: safe.retryAfterSeconds } : {}),
  };
}
