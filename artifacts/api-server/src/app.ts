// @ts-nocheck
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import cors from "cors";
import router from "./routes";
import { logger } from "./lib/logger";

// TypeScript의 import 시스템을 우회하기 위해 require를 사용합니다.
const pinoHttp = require("pino-http");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app: Express = express();

// pinoHttp를 강제로 실행 가능한 형태로 만듭니다.
const httpLogger = (pinoHttp.default || pinoHttp)({
  logger,
  serializers: {
    req(req: any) {
      return {
        id: req.id,
        method: req.method,
        url: req.url?.split("?")[0],
      };
    },
    res(res: any) {
      return {
        statusCode: res.statusCode,
      };
    },
  },
});

app.use(httpLogger);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

const publicDir = path.resolve(__dirname, "public");
app.use(express.static(publicDir));

app.get(/^\/(?!api|socket\.io).*/, (_req: any, res: any) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

export default app;