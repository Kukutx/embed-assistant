import { z } from "zod";

/** JSON Schema of a tool's input. Must describe an object. */
export const ToolParameters = z
  .record(z.string(), z.unknown())
  .refine((v) => v.type === "object", { message: 'parameters must be a JSON Schema with type "object"' })
  .refine((v) => JSON.stringify(v).length <= 16_000, { message: "parameters schema too large" });

export const ToolName = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/, "letters, digits, _ and -, starting with a letter");
