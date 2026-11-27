export const RECEIPT_CODE = /^[0-9a-z]{1,10}-[\w-]{12}$/;

/** Read the code from either the printed value or a pasted verification link. */
export function extractCode(input: string): string {
  const text = input.trim();
  const candidate = /\/verify\/([^/?#\s]+)/.exec(text)?.[1] ?? text;
  try {
    return decodeURIComponent(candidate).trim();
  } catch {
    return "";
  }
}
