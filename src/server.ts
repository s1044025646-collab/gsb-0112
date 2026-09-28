import { openDb } from "./db.js";
import { createApp } from "./api.js";
import { systemCtx } from "./context.js";

const dbPath = process.env.CTRS_DB ?? "ctrs.db";
const db = openDb(dbPath);
const app = createApp(db, systemCtx);

// Port 0 => OS picks a free local port automatically.
const port = Number(process.env.CTRS_PORT ?? 0);
const server = app.listen(port, "127.0.0.1", () => {
  const addr = server.address();
  const actual = typeof addr === "object" && addr ? addr.port : port;
  console.log(`ctrs-api listening on http://127.0.0.1:${actual} (db: ${dbPath})`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
