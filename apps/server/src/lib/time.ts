export const iso = (d: Date | string | null): string => (d instanceof Date ? d.toISOString() : new Date(d ?? 0).toISOString());
export const isoOrNull = (d: Date | string | null): string | null => (d === null ? null : iso(d));
