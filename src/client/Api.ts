import type { NewsItem } from "@openfront/shared/ApiSchemas";
import { GameInfo } from "@openfront/shared/WireSchemas";
import newsItemsFallback from "resources/news.json";
import { getPlayToken } from "./Auth";
import { ClientEnv } from "./ClientEnv";

// POST /api/create_game on the game server — mints a fresh private lobby with
// the caller as creator. Deliberately has no worker prefix and no id: the edge
// (nginx in prod, the vite dev proxy locally) picks a worker, which mints a
// self-owned id and returns it, along with the play token the lobby was
// created under. The host must join with that same token so it joins as the
// lobby's creator.
export async function createLobby(): Promise<{
  lobby: GameInfo;
  creatorToken: string;
}> {
  // The play token is the browser's anonymous persistent ID; the server
  // extracts the creator identity from it. It should never be exposed to
  // other clients.
  const token = await getPlayToken();
  try {
    const response = await fetch(
      `${ClientEnv.serverHttpBase()}/api/create_game`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Server error response:", errorText);
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    console.log("Success:", data);

    return { lobby: data as GameInfo, creatorToken: token };
  } catch (error) {
    console.error("Error creating lobby:", error);
    throw error;
  }
}

// POST /wX/api/create_game?previous=<gameID>, targeted at the worker that owns
// the finished game — mints a successor private lobby (same creator, default
// settings) and has the old game broadcast the new id to everyone still
// connected. Returns the successor's info; the caller navigates the host there.
// Idempotent server-side: repeat calls return the same successor.
export async function createNextLobby(
  previousGameID: string,
): Promise<GameInfo> {
  // Nothing is caught here: a NoServerError from gameWorkerPath below
  // propagates to the only caller (GameRightSidebar's successor-lobby
  // button), which already catches, logs and re-enables the button.
  const token = await getPlayToken();
  const response = await fetch(
    `${ClientEnv.gameHttpBase(previousGameID)}/${ClientEnv.gameWorkerPath(previousGameID)}/api/create_game?previous=${previousGameID}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    },
  );
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    console.error("createNextLobby: server error response:", errorText);
    throw new Error(`create next lobby failed: HTTP ${response.status}`);
  }
  return (await response.json()) as GameInfo;
}

// The news list is bundled with the client: there is no API to ask.
export async function getNews(): Promise<NewsItem[]> {
  return newsItemsFallback as NewsItem[];
}
