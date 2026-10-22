import type { Message } from "./types";

export interface SceneMessages {
  narration: Message | null;
  dialogue: Message | null;
}

const ROLE_LABELS: Record<Message["role"], string> = {
  PLAYER: "Pemain",
  NARRATOR: "Narator",
  NPC: "NPC",
  SYSTEM_EVENT: "Sistem",
};

function latestStoryTurnId(messages: Message[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "NARRATOR" || message.role === "NPC") {
      return message.turnId;
    }
  }
  return null;
}

export function latestSceneMessages(messages: Message[]): SceneMessages {
  const turnId = latestStoryTurnId(messages);
  if (turnId === null) return { narration: null, dialogue: null };

  let narration: Message | null = null;
  let dialogue: Message | null = null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.turnId !== turnId) continue;
    if (message.role === "NARRATOR" && narration === null) narration = message;
    if (message.role === "NPC" && dialogue === null) dialogue = message;
    if (narration !== null && dialogue !== null) break;
  }
  return { narration, dialogue };
}

export function sceneEyebrow(turnCount: number, location: string): string {
  const turn = Math.max(1, turnCount);
  return `Adegan ${String(turn).padStart(2, "0")} · ${location}`;
}

export function messageAuthor(
  message: Pick<Message, "role" | "speakerId">,
  npcNames: Record<string, string>,
): string {
  const role = ROLE_LABELS[message.role];
  if (!message.speakerId) return role;
  return npcNames[message.speakerId] ?? role;
}
