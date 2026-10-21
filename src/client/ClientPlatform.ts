import type { ClientPlatform } from "@openfront/shared/WireSchemas";
import { isDesktopShell } from "./DesktopShell";

// The desktop shell is only distributed through Steam, so the shell itself
// (not a working Steam client, which may be absent) is the signal.
export function clientPlatform(): ClientPlatform {
  if (isDesktopShell()) return "steam";
  return "web";
}
