export type ProviderErrorKind =
  | "missing_credentials"
  | "http_error"
  | "network_error"
  | "stream_error"
  | "malformed_response";

export type ProviderErrorOptions = {
  kind: ProviderErrorKind;
  providerId?: string;
  status?: number;
  retryable?: boolean;
  attempts?: number;
  cause?: unknown;
};

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly providerId?: string;
  readonly status?: number;
  readonly retryable: boolean;
  readonly attempts?: number;

  constructor(message: string, options: ProviderErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "ProviderError";
    this.kind = options.kind;
    this.providerId = options.providerId;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.attempts = options.attempts;
  }
}
