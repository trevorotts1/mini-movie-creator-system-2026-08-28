import type { StockAdapter } from "./guard.js";
import type { StockClip, StockProviderId } from "./types.js";

/**
 * Optional stock provider adapters — stubbed interfaces (spec §22:
 * "optional Pexels/Pixabay adapters"). No network calls here; concrete
 * adapters fetch at generation time and hand back resolved clips.
 */

/** Placeholder adapter: refuses all searches until a real implementation lands. */
class StubAdapter implements StockAdapter {
  constructor(readonly providerId: StockProviderId) {}

  async search(): Promise<StockClip[]> {
    throw new Error(
      `Stock adapter "${this.providerId}" is a stub (spec §22: optional Pexels/Pixabay adapters); implement before use.`,
    );
  }
}

/** Pexels video search adapter (stubbed — no network). */
export function createPexelsAdapter(): StockAdapter {
  return new StubAdapter("pexels");
}

/** Pixabay video search adapter (stubbed — no network). */
export function createPixabayAdapter(): StockAdapter {
  return new StubAdapter("pixabay");
}

/** Registry of built-in adapter factories by provider id. */
export const STOCK_ADAPTER_FACTORIES: Readonly<
  Record<Exclude<StockProviderId, "local">, () => StockAdapter>
> = {
  pexels: createPexelsAdapter,
  pixabay: createPixabayAdapter,
};

/** Create the adapter for a provider id. `local` has no remote adapter. */
export function createStockAdapter(providerId: StockProviderId): StockAdapter | undefined {
  if (providerId === "local") return undefined;
  return STOCK_ADAPTER_FACTORIES[providerId]();
}