import { EventEmitter } from "node:events";
import type { ServerEvent } from "../shared/types.js";

/** In-process bus; /api/events forwards every message to connected browsers over SSE. */
const bus = new EventEmitter();
bus.setMaxListeners(100);

export function publish(event: ServerEvent) {
  bus.emit("event", event);
}

export function subscribe(listener: (event: ServerEvent) => void) {
  bus.on("event", listener);
  return () => {
    bus.off("event", listener);
  };
}
