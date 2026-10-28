// Local durable-record identity. This is not a wire serializer or wire schema.
export function nativeSemanticJson(value) {
  return JSON.stringify(value, (_, child) => child && typeof child === "object" && !Array.isArray(child)
    ? Object.fromEntries(Object.entries(child).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : child);
}
