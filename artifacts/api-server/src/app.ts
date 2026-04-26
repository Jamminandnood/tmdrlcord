import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express, type Request, type Response } from "express";
import cors from "cors";
import pino from "pino-http"; // 'pinoHttp' 대신 'pino'라는 이름으로 가져옵니다.
import router from "./routes";
import { logger } from "./lib/logger";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app: Express = express();

// pino-http 라이브러리의 타입 문제를 해결하기 위해 (pino as any)() 형식을 사용합니다.
app.use(
  (pino as any)({
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
  })
);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

const publicDir = path.resolve(__dirname, "public");
app.use(express.static(publicDir));

app.get(/^\/(?!api|socket\.io).*/, (_req: Request, res: Response) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

export default app;
