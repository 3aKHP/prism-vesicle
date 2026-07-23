import type { AgentStore } from "./store";

export class AgentHandleAllocator {
  private readonly initializers = new Map<string, Promise<number>>();
  private readonly nextOrdinals = new Map<string, number>();

  constructor(private readonly store: Pick<AgentStore, "nextHandleOrdinal">) {}

  async allocate(parentSessionId: string, profileId: string): Promise<string> {
    const key = `${parentSessionId}\u0000${profileId}`;
    let initializer = this.initializers.get(key);
    if (!initializer) {
      initializer = this.store.nextHandleOrdinal(parentSessionId, profileId);
      this.initializers.set(key, initializer);
    }
    const initial = await initializer;
    const ordinal = this.nextOrdinals.get(key) ?? initial;
    this.nextOrdinals.set(key, ordinal + 1);
    return `${profileId}-${ordinal}`;
  }
}
