import { z } from "zod";

const cache = new WeakMap<object, z.ZodType | null>();

/** Compile a JSON Schema into a validator; null when the schema uses unsupported features. */
export function compileSchema(schema: Record<string, unknown>): z.ZodType | null {
  if (cache.has(schema)) return cache.get(schema)!;
  let v: z.ZodType | null = null;
  try {
    v = z.fromJSONSchema(schema as never);
  } catch {
    v = null;
  }
  cache.set(schema, v);
  return v;
}

/** Validate tool arguments. Returns an error message for the model, or null when valid. */
export function validateArguments(schema: Record<string, unknown>, input: unknown): string | null {
  if (input && typeof input === "object" && "__invalid_json" in input) return "arguments were not valid JSON";
  const v = compileSchema(schema);
  if (!v) return null;
  const r = v.safeParse(input);
  if (r.success) return null;
  return r.error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

/** True when the schema can be compiled (used to reject bad action definitions early). */
export function isSupportedSchema(schema: Record<string, unknown>): boolean {
  return compileSchema(schema) !== null;
}
