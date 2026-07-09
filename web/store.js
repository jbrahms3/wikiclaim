// Store selector. Uses Postgres when DATABASE_URL is set (e.g. on Railway),
// otherwise falls back to a local JSON file. Both backends expose the same
// async interface, so the rest of the app doesn't care which is active.
import crypto from "node:crypto";
import { createJsonStore } from "./db/json-store.js";
import { createPgStore } from "./db/pg-store.js";

export const uid = () => crypto.randomUUID();

export const store = process.env.DATABASE_URL ? createPgStore() : createJsonStore();

export async function initStore() {
  await store.init();
  console.log(`Store backend: ${store.kind}`);
}
