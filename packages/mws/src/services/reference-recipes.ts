/**
 * Standard MWS documentation / reference wikis (recipes). These are opened in a
 * new browser tab from the user home page (`/home`) and are skipped by the
 * in-wiki "home" button injection, since they are reference material rather than
 * a user's working wiki.
 *
 * Shared by `managers/admin-htmx.ts` (home-page rendering) and, later,
 * `managers/WikiStateStore.ts` (home-button injection).
 */
export const REFERENCE_RECIPES: ReadonlySet<string> = new Set([
  "docs",
  "mws-docs",
  "dev-docs",
  "tour",
]);

export function isReferenceRecipe(recipeName: string): boolean {
  return REFERENCE_RECIPES.has(recipeName);
}
