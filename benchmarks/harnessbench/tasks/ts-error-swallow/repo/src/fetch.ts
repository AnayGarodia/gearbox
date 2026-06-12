export async function fetchWithFallback(
  primary: () => Promise<string>,
  fallback: () => Promise<string>
): Promise<string> {
  try {
    return await primary();
  } catch {
    try {
      return await fallback();
    } catch {
      return null as unknown as string;
    }
  }
}
