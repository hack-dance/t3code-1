import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ProjectTransferContext = Schema.Struct({
  sourceLabel: TrimmedNonEmptyString,
  targetLabel: TrimmedNonEmptyString,
});
export type ProjectTransferContext = typeof ProjectTransferContext.Type;

const ReportLabel = TrimmedNonEmptyString.check(Schema.isMaxLength(256));

// Limit reports without making existing environment labels invalid for clone requests.
export const ProjectFilesCopiedInput = Schema.Struct({
  context: Schema.Struct({
    sourceLabel: ReportLabel,
    targetLabel: ReportLabel,
  }),
  projectName: ReportLabel,
  remoteUrl: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(8192))),
  destinationPath: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  files: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(512))).check(
    Schema.isMaxLength(200),
  ),
});
export type ProjectFilesCopiedInput = typeof ProjectFilesCopiedInput.Type;
