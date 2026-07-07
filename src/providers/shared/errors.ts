export type ProviderErrorKind =
  | "missing_credentials"
  | "http_error"
  | "stream_error"
  | "malformed_response";

export type ProviderErrorOptions = {
  kind: ProviderErrorKind;
  providerId?: string;
  status?: number;
  retryable?: boolean;
  cause?: unknown;
};

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly providerId?: string;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(message: string, options: ProviderErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "ProviderError";
    this.kind = options.kind;
    this.providerId = options.providerId;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}
