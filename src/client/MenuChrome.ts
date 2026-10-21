/**
 * Whether the menu chrome has been torn down for a starting game and not yet
 * restored.
 *
 * Keyed on the teardown itself rather than on the `in-game` body class: the
 * teardown runs at prestart, while the class is set later at join, and for
 * multiplayer there is a real gap between the two while terrain loads. A leave
 * inside that window must still find something to undo.
 */
let tornDown = false;

export function menuChromeIsTornDown(): boolean {
  return tornDown;
}

/** Mark the menu chrome as hidden for a game that is starting. */
export function hideMenuChrome(): void {
  tornDown = true;
}

/** Mark the menu chrome as restored after leaving a game in place. */
export function restoreMenuChrome(): void {
  tornDown = false;
}
