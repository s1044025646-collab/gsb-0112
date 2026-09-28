import { createServer } from "node:net";
import { resolve } from "node:path";
import { createAppContext, closeAppContext } from "../app/context.ts";
import { createApiServer } from "../api/http.ts";

async function pickPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
    probe.on("error", reject);
  });
}

async function main(): Promise<void> {
  const dbFile = resolve(process.env.TRIAL_DB ?? "data/trial.db");
  const app = createAppContext({ filename: dbFile });
  const server = createApiServer(app);
  const requested = process.env.TRIAL_PORT ? Number(process.env.TRIAL_PORT) : await pickPort();
  server.listen(requested, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : requested;
    console.log(JSON.stringify({ status: "listening", host: "127.0.0.1", port, dbFile }));
  });
  const shutdown = () => {
    server.close(() => {
      closeAppContext(app);
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  if (process.platform === "win32") {
    process.on("SIGHUP", shutdown);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
