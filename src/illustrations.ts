import archive from "./assets/covers/archive.svg";
import coast from "./assets/covers/coast.svg";
import desert from "./assets/covers/desert.svg";
import lantern from "./assets/covers/lantern.svg";
import mountain from "./assets/covers/mountain.svg";
import rain from "./assets/covers/rain.svg";
import { coverIdFor, type CoverId } from "./library";
import type { GameDefinition } from "./types";

const COVERS: Record<CoverId, string> = {
  coast,
  lantern,
  archive,
  desert,
  mountain,
  rain,
};

export function storyIllustration(
  game: Pick<GameDefinition, "genre" | "title">,
): string {
  return COVERS[coverIdFor(game)];
}
