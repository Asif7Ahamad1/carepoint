import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import type { ClinicStore } from "./domain.js";

config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });
config({ path: fileURLToPath(new URL("../../.env", import.meta.url)) });

const [{ createApp }, { MemoryClinicStore }, { MySqlClinicStore }] = await Promise.all([
  import("./app.js"),
  import("./memory-store.js"),
  import("./mysql-store.js"),
]);

const store: ClinicStore = process.env.DATABASE_URL
  ? await MySqlClinicStore.connect(process.env.DATABASE_URL)
  : new MemoryClinicStore();

const port = Number(process.env.PORT || 4000);
const app = createApp(store, process.env.WEB_ORIGIN || "http://localhost:5173");
const server = app.listen(port, () => {
  console.log(`CarePoint API listening on http://localhost:${port} (${store.mode} mode)`);
});

const expirySweep = setInterval(() => {
  store.sweepExpiredOffers().catch((error: unknown) => {
    console.error("Waitlist offer expiry sweep failed.", error);
  });
}, 15_000);

async function shutdown(): Promise<void> {
  clearInterval(expirySweep);
  server.close(async () => {
    await store.close();
    process.exit(0);
  });
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
