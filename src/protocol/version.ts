// The wire protocol's version (docs/protocol.md). Additive changes (a new message type, op, error code or optional
// field) keep it; removing or renaming anything, or a new ChatItem kind or item op, bumps it.

/** The protocol this build speaks; `hello` and `welcome` carry it, and both sides refuse another. */
export const PROTOCOL = 3;
