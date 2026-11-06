import { buildCodeupMergeContinuation, type CodeupTaskKind } from "./taskPrompt";

export interface CodeupTaskCleanup {
  repository: string;
  mrId: number;
  repositoryId?: string;
  kind: CodeupTaskKind;
  sourceBranch: string;
  targetBranch: string;
  recoveryAttempts?: number;
}

export const CODEUP_MERGE_INCOMPLETE = "CODEUP_MERGE_INCOMPLETE:";
export const MAX_MERGE_RECOVERY_ATTEMPTS = 2;

/** Only a verified unfinished Git merge can trigger another agent turn. */
export function codeupMergeRecoveryPrompt(
  context: CodeupTaskCleanup,
  error: unknown,
): string | null {
  if (
    context.kind === "review" ||
    !String(error).includes(CODEUP_MERGE_INCOMPLETE) ||
    (context.recoveryAttempts ?? 0) >= MAX_MERGE_RECOVERY_ATTEMPTS
  )
    return null;
  return buildCodeupMergeContinuation(context.kind, context.sourceBranch, context.targetBranch);
}
