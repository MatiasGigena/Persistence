// A FakeServer on a real Unix socket, NDJSON framed as docs/protocol.md says: what the attached TUI talks to
// until `pi-durable serve` runs in the tests.
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import type { FakeServer } from '../fixtures/fake-server.ts';

export interface SocketFake {
  readonly server: Server;
  readonly sockets: Set<Socket>;
  /** Stops listening and ends every connection; the socket file goes away. */
  close(): Promise<void>;
}

export async function listenFake(fake: FakeServer, path: string): Promise<SocketFake> {
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    const peer = fake.connect({ send: text => { if (socket.writable) socket.write(`${text}\n`); }, end: () => socket.end() });
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        peer.handle(line);
      }
    });
    socket.on('error', () => undefined);
    socket.once('close', () => { sockets.delete(socket); peer.gone(); });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  return {
    server,
    sockets,
    close: () => new Promise<void>(resolve => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}
