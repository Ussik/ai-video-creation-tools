import { reasonedQuotedLineRepair } from './model-output-syntax-repair.js'
/** Shared technical stages only. Transport completeness is enforced before a
 * string reaches this entry; domain fields/references remain caller-owned. */
export function sourceStructuredPolicy(_localOnly = false) {
  return { recoverUniqueSyntax: true, recoverCompletedSyntax: true, localSyntaxOnly: true,
    planSyntaxRepair: reasonedQuotedLineRepair, freezeCorrection: true } as const
}
