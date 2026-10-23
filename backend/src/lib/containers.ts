// Names (one per line, as printed by `docker ps --format {{.Names}}`) that are NOT the container to keep.
export function staleNames(psOutput: string, keep: string | null): string[] {
  return psOutput
    .split('\n')
    .map((n) => n.trim())
    .filter((n) => n && n !== keep);
}

// Step 14: production and previews of one project share the `devflow.project` label, so cleanup has to know
// which "scope" it is cleaning. Input is `docker ps -a --format '{{.Names}}\t{{.Label "devflow.preview"}}'`.
//   { production: true }  -> containers with no preview label (never touches previews)
//   { previewId }         -> containers of that one preview
//   'all'                 -> everything of the project (project deleted)
export type CleanupScope = 'all' | { production: true } | { previewId: string };

export function staleNamesInScope(psOutput: string, keep: string | null, scope: CleanupScope): string[] {
  return psOutput
    .split('\n')
    .map((line) => line.split('\t'))
    .map(([name, preview]) => ({ name: (name ?? '').trim(), preview: (preview ?? '').trim() }))
    .filter(({ name, preview }) => {
      if (!name || name === keep) return false;
      if (scope === 'all') return true;
      if ('production' in scope) return preview === '';
      return preview === scope.previewId;
    })
    .map((c) => c.name);
}
