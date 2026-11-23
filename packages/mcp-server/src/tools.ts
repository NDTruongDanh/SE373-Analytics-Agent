import {
  DescribeTableInputSchema,
  ExplainQueryInputSchema,
  ListTablesInputSchema,
  RunQueryInputSchema,
  SampleRowsInputSchema,
  SearchSemanticLayerInputSchema,
} from "@shared/contracts";
import { TOOL_SCOPES } from "./constants.js";

export { TOOL_SCOPES, TOOL_SPECS } from "./constants.js";

export type ToolName = keyof typeof TOOL_SCOPES;

export interface ToolSpec {
  name: ToolName;
  description: string;
  inputSchema:
    | typeof ListTablesInputSchema
    | typeof DescribeTableInputSchema
    | typeof ExplainQueryInputSchema
    | typeof RunQueryInputSchema
    | typeof SampleRowsInputSchema
    | typeof SearchSemanticLayerInputSchema;
  needsSql: boolean;
}
