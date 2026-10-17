/* Singular / plural wording shared by the screens and the offline data layer */

/* Units that do not change in the plural (1 kg, 2 kg) */
const INVARIANT_UNITS = new Set(["kg", "g", "mg", "m", "cm", "mm", "ft", "lb"]);

/** "piece" -> "pieces", "box" -> "boxes", "category" -> "categories" */
function pluralizeWord(word: string): string {
  const w = word.trim();

  if (!w || INVARIANT_UNITS.has(w.toLowerCase())) return w;
  if (/(s|x|z|ch|sh)$/i.test(w)) return `${w}es`;
  if (/[^aeiou]y$/i.test(w)) return `${w.slice(0, -1)}ies`;

  return `${w}s`;
}

/** Singular only for exactly 1; everything else (0, 2, 1.5) is plural. */
export function plural(count: number, singular: string): string {
  return count === 1 ? singular : pluralizeWord(singular);
}

/** countOf(1, "item") -> "1 item", countOf(3, "item") -> "3 items" */
export function countOf(count: number, singular: string): string {
  return `${count} ${plural(count, singular)}`;
}

/** formatQty(1, "piece") -> "1 piece", formatQty(2, "bag") -> "2 bags" */
export function formatQty(quantity: number, unit?: string | null): string {
  return unit ? countOf(quantity, unit) : String(quantity);
}