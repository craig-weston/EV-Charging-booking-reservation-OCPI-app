// Cloudflare Pages Function: /api/* → shared web-standard handler (see server/dispatch.ts).
import { handle, type PagesContext } from "../../server/live";

export const onRequest = (context: PagesContext): Promise<Response> => handle(context);
