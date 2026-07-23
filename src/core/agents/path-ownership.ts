export class PathOwnershipTable {
  private readonly owners = new Map<string, string>();
  private readonly pathsByOwner = new Map<string, Set<string>>();
  private readonly ownerLabels = new Map<string, string>();

  claim(ownerId: string, ownerLabel: string, paths: string[]): void {
    const unique = [...new Set(paths)].sort();
    if (unique.length === 0) return;
    const conflict = unique.flatMap((requestedPath) =>
      [...this.owners.entries()]
        .filter(([ownedPath, owner]) => owner !== ownerId && pathsOverlap(requestedPath, ownedPath))
        .map(([ownedPath, owner]) => ({ requestedPath, ownedPath, owner })),
    )[0];
    if (conflict) {
      throw new Error(`Concurrent Agent write conflict on "${conflict.requestedPath}"; overlapping path "${conflict.ownedPath}" is owned by ${this.ownerLabels.get(conflict.owner) ?? "another SubAgent"}.`);
    }
    let owned = this.pathsByOwner.get(ownerId);
    if (!owned) {
      owned = new Set<string>();
      this.pathsByOwner.set(ownerId, owned);
      this.ownerLabels.set(ownerId, ownerLabel);
    }
    for (const path of unique) {
      this.owners.set(path, ownerId);
      owned.add(path);
    }
  }

  release(ownerId: string): void {
    const owned = this.pathsByOwner.get(ownerId);
    if (!owned) return;
    for (const path of owned) {
      if (this.owners.get(path) === ownerId) this.owners.delete(path);
    }
    this.pathsByOwner.delete(ownerId);
    this.ownerLabels.delete(ownerId);
  }
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}
