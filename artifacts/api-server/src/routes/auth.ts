import { Router, type IRouter } from "express";
import { loginAccount, registerAccount } from "../accounts";

const router: IRouter = Router();

router.post("/auth/register", async (req, res) => {
  const { username, password } = req.body ?? {};
  const result = await registerAccount(
    typeof username === "string" ? username : "",
    typeof password === "string" ? password : "",
  );
  res.json(result);
});

router.post("/auth/login", async (req, res) => {
  const { username, password } = req.body ?? {};
  const result = await loginAccount(
    typeof username === "string" ? username : "",
    typeof password === "string" ? password : "",
  );
  res.json(result);
});

export default router;
