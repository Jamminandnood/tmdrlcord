import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express, type Request, type Response } from "express"; // Request, Response 추가
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      // req와 res에 타입을 명시해줍니다 (any를 써서 검사를 피함)
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
  }),
);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

const publicDir = path.resolve(__dirname, "public");
app.use(express.static(publicDir));

// _req와 res에도 타입을 명시해줍니다
app.get(/^\/(?!api|socket\.io).*/, (_req: Request, res: Response) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

export default app;
