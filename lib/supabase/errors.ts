type DbError = { code?: string; message?: string } | null | undefined;

/** "column articles.origin does not exist" (Postgres 42703) or PostgREST's "could not find the 'origin' column" (PGRST204). */
export function isMissingColumn(error: DbError): boolean {
  if (!error) return false;
  return error.code === "42703" || error.code === "PGRST204" || /column .*does not exist|could not find the .* column/i.test(error.message ?? "");
}

/** True for "relation does not exist" (Postgres 42P01) and PostgREST's "table not found in the schema cache" (PGRST205). */
export function isMissingTable(error: DbError): boolean {
  if (!error) return false;
  return error.code === "42P01" || error.code === "PGRST205" || /could not find the table|does not exist/i.test(error.message ?? "");
}
