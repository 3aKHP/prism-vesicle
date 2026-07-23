export class PathOwnershipTable {
  private readonly owners = new Map<string, string>();
  private readonly pathsByOwner = new Map<string, Set<string>>();

  constructor(private readonly ownerLabel: (ownerId: string) => string) {}

  claim(ownerId: string, paths: string[]): void {
    const unique = [...new Set(paths)].sort();
    const conflict = unique.flatMap((requestedPath) =>
      [...this.owners.entries()]
        .filter(([ownedPath, owner]) => owner !== ownerId && pathsOverlap(requestedPath, ownedPath))
        .map(([ownedPath, owner]) => ({ requestedPath, ownedPath, owner })),
    )[0];
    if (conflict) {
      throw new Error(`Concurrent Agent write conflict on "${conflict.requestedPath}"; overlapping path "${conflict.ownedPath}" is owned by ${this.ownerLabel(conflict.owner)}.`);
    }
    const owned = this.pathsByOwner.get(ownerId) ?? new Set<string>();
    for (const path of unique) {
      this.owners.set(path, ownerId);
      owned.add(path);
    }
    if (owned.size > 0) this.pathsByOwner.set(ownerId, owned);
  }

  release(ownerId: string): void {
    const owned = this.pathsByOwner.get(ownerId);
    if (!owned) return;
    for (const path of owned) {
      if (this.owners.get(path) === ownerId) this.owners.delete(path);
    }
    this.pathsByOwner.delete(ownerId);
  }
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}
