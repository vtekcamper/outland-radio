/**
 * sse.js — Server-Sent Events registry + broadcast
 *
 * Each connected player tab registers a `send` function here.
 * The cron scheduler calls broadcast() to push audio events.
 */

const clients = new Set();

export function addClient(send) {
  clients.add(send);
}

export function removeClient(send) {
  clients.delete(send);
}

export function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const send of clients) {
    try {
      send(payload);
    } catch {
      clients.delete(send);
    }
  }
}

export function clientCount() {
  return clients.size;
}
