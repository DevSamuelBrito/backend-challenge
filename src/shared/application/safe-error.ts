export interface SafeErrorSummary {
  errorName: string;
  errorCode?: string;
}

export function summarizeError(error: unknown): SafeErrorSummary {
  if (!(error instanceof Error)) {
    return { errorName: typeof error };
  }

  const code = (error as { code?: unknown }).code;

  return {
    errorName: error.name,
    ...(typeof code === "string" && { errorCode: code }),
  };
}

export function describeError(error: unknown): string {
  const { errorName, errorCode } = summarizeError(error);

  return errorCode ? `${errorName} (${errorCode})` : errorName;
}

export function stackFramesOf(error: unknown): string | undefined {
  if (!(error instanceof Error) || !error.stack) {
    return undefined;
  }

  return error.stack
    .split("\n")
    .filter((line) => line.trimStart().startsWith("at "))
    .join("\n");
}
