export type RunRateLimitOperation = { key: string };

export function createRunRateLimitBinding(invoke: (operation: RunRateLimitOperation) => Promise<unknown>): RateLimit {
  return {
    limit: (options: RateLimitOptions) => invoke({ key: options.key }) as Promise<RateLimitOutcome>,
  };
}

export function executeRunRateLimitOperation(
  limiter: RateLimit,
  runId: string,
  operation: RunRateLimitOperation,
): Promise<RateLimitOutcome> {
  return limiter.limit({ key: `${runId}:${operation.key}` });
}
