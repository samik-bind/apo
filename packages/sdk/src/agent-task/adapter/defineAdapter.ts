import type {
  CollectedDeliverables,
  DeliverableDefinition,
  TypedAdapterDefinition,
} from "./types.ts";

export function defineAdapter<
  const TName extends string,
  const TDeliverables extends Record<string, DeliverableDefinition>,
  TCollected extends CollectedDeliverables,
>(
  adapter: TypedAdapterDefinition<TName, TDeliverables, TCollected>,
): TypedAdapterDefinition<TName, TDeliverables, TCollected> {
  return adapter;
}
