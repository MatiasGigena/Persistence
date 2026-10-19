// An in-memory Connector to a FakeServer: each connect makes a peer, and messages cross with setImmediate in both
// directions, in order, as over a socket.
import type { Channel, Connector } from '../../src/client/unix-link.ts';
import type { FakePeer, FakeServer } from '../fixtures/fake-server.ts';

export interface MemoryConnector {
  readonly connect: Connector;
  /** While true, connecting fails as with no server listening. */
  down: boolean;
  /** Connections made, in order. */
  readonly peers: FakePeer[];
  /** Every client message sent, in order, across connections. */
  readonly sent: string[];
}

export function memoryConnector(server: FakeServer): MemoryConnector {
  const state: MemoryConnector = {
    down: false,
    peers: [],
    sent: [],
    connect: events => {
      if (state.down) return Promise.reject(new Error('connect ECONNREFUSED'));
      let open = true;
      const end = (): void => {
        if (!open) return;
        open = false;
        setImmediate(() => events.end());
      };
      const peer = server.connect({
        send: text => { if (open) setImmediate(() => { if (open) events.message(text); }); },
        end: () => setImmediate(end),
      });
      state.peers.push(peer);
      const channel: Channel = {
        send: text => {
          if (!open) return;
          state.sent.push(text);
          setImmediate(() => { if (open) peer.handle(text); });
        },
        close: () => { peer.gone(); end(); },
      };
      return Promise.resolve(channel);
    },
  };
  return state;
}
