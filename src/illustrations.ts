import coast from "../mockups/assets/coast.svg";
import lantern from "../mockups/assets/lantern.svg";
import type { GameDefinition } from "./types";

export function storyIllustration(game: Pick<GameDefinition, "genre">): string {
  return game.genre?.toLowerCase().includes("fantasy") ? lantern : coast;
}
