// Refusals a UiSession method (and the agents and memory code under it) throws that a client must be able to tell
// apart. The server reports each with its own wire error code (src/server/connection.ts), so rewording a message never
// changes the code a client sees.

/** The name or id asked for does not exist: an unknown agent, a memory line or message past the log. */
export class NotFound extends Error {
  override readonly name = 'NotFound';
}

/** The session cannot do this now, though the request is well formed: memory closed on an inspection. */
export class Unavailable extends Error {
  override readonly name = 'Unavailable';
}
