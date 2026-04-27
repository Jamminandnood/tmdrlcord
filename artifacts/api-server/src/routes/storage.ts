import { Readable } from "node:stream";
import { logger } from "../lib/logger";
import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import {
  ObjectStorageService,
  ObjectNotFoundError,
} from "../lib/objectStorage";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

const MAX_UPLOAD_SIZE = 10 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
]);

router.post(
  "/storage/uploads/request-url",
  async (req: Request, res: Response) => {
    const body = req.body ?? {};
    const name = typeof body.name === "string" ? body.name : "";
    const size = typeof body.size === "number" ? body.size : 0;
    const contentType =
      typeof body.contentType === "string" ? body.contentType : "";

    if (!name || !contentType) {
      res
        .status(400)
        .json({ error: "name과 contentType이 필요합니다." });
      return;
    }
    if (!ALLOWED_TYPES.has(contentType.toLowerCase())) {
      res
        .status(400)
        .json({ error: "지원하지 않는 파일 형식입니다. (PNG/JPG/GIF/WebP)" });
      return;
    }
    if (!Number.isFinite(size) || size <= 0 || size > MAX_UPLOAD_SIZE) {
      res
        .status(400)
        .json({ error: "파일 크기는 10MB 이하여야 합니다." });
      return;
    }

    try {
      const uploadURL = await objectStorageService.getObjectEntityUploadURL();
      const objectPath =
        objectStorageService.normalizeObjectEntityPath(uploadURL);
      res.json({ uploadURL, objectPath });
    } catch (err) {
      logger.error({ err }, "Error generating upload URL");
      res.status(500).json({ error: "업로드 URL 생성에 실패했습니다." });
    }
  },
);

router.get(
  "/storage/objects/*path",
  async (req: Request, res: Response) => {
    try {
      const raw = req.params.path;
      const wildcardPath = Array.isArray(raw) ? raw.join("/") : raw;
      const objectPath = `/objects/${wildcardPath}`;
      const objectFile =
        await objectStorageService.getObjectEntityFile(objectPath);

      const response = await objectStorageService.downloadObject(objectFile);
      res.status(response.status);
      response.headers.forEach((value, key) => res.setHeader(key, value));
      if (response.body) {
        const nodeStream = Readable.fromWeb(
          response.body as ReadableStream<Uint8Array>,
        );
        nodeStream.pipe(res);
      } else {
        res.end();
      }
    } catch (err) {
      if (err instanceof ObjectNotFoundError) {
        res.status(404).json({ error: "파일을 찾을 수 없습니다." });
        return;
      }
      logger.error({ err }, "Error serving object");
      res.status(500).json({ error: "파일을 가져오지 못했습니다." });
    }
  },
);

export default router;
