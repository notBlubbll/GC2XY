import { HandlerInput, HandlerResult } from "../../shared.ts";
import { handleSQLStudioAuth } from "./auth.ts";

export async function handleSQLStudio(req: HandlerInput): Promise<HandlerResult> {
  return await handleSQLStudioAuth(req);
}
