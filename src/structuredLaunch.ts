/** Intentional cancellation/ownership loss is not a transport failure to retry in PTY. */
export function isStructuredStartAborted(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("STRUCTURED_START_ABORTED:");
}
