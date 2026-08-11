// Supabase's untyped client always types embedded to-one relations as an
// array (it can't infer cardinality without generated Database types), but
// PostgREST actually returns a single object at runtime for these — e.g. an
// order belongs to one customer. This reads either shape correctly.
export function firstEmbedded<T>(rel: T | T[] | null | undefined): T | null {
  if (!rel) return null;
  return Array.isArray(rel) ? (rel[0] ?? null) : rel;
}

export function embeddedName(rel: { name: string } | { name: string }[] | null): string | null {
  return firstEmbedded(rel)?.name ?? null;
}
