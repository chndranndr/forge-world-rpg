import { CorruptDatabaseError } from "./db.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function publicItemEffects(value: unknown): unknown[] {
  if (!Array.isArray(value))
    throw new CorruptDatabaseError("Item effects tidak valid.");
  return value.filter((effect) => {
    if (!isObject(effect) || typeof effect.type !== "string")
      throw new CorruptDatabaseError("Item effect tidak valid.");
    switch (effect.type) {
      case "ADD_FACT":
      case "REMOVE_FACT":
      case "DISCOVER_LORE":
      case "REVEAL_FACT":
      case "SET_FLAG":
      case "NPC_PRESENCE":
        return false;
      case "ATTRIBUTE_CHANGE":
      case "RESOURCE_CHANGE":
      case "RELATIONSHIP_CHANGE":
      case "ADD_ITEM":
      case "REMOVE_ITEM":
        return true;
      default:
        throw new CorruptDatabaseError("Item effect tidak dikenal.");
    }
  });
}
