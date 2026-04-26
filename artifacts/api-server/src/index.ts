import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import app from "./app";
import { logger } from "./lib/logger";
import { attachChatServer } from "./chat";
import { seedAdminAccount } from "./accounts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = http.createServer(app);

attachChatServer(server);

const adminUsername = process.env["ADMIN_USERNAME"] || "admin";
const adminPassword = process.env["ADMIN_PASSWORD"] || "admin1234";

seedAdminAccount(adminUsername, adminPassword).catch((err) => {
  logger.error({ err }, "failed to seed admin account");
});

server.listen(port, (err?: Error) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port, dir: __dirname }, "Realtime chat server listening");
});
