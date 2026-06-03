/**
 * Format helper for selector labels: appends the group label in parentheses
 * so operators can see which bucket a tag/scenario belongs to without
 * leaving the dropdown.
 *
 * Used in `<option>` / chip labels app-wide. Keep the format consistent
 * (full-width parens + group name) so every selector reads the same.
 */
export function withGroup(name: string, groupName?: string | null): string {
  if (!groupName) return name
  return `${name}（${groupName}）`
}
