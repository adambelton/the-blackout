import { Hono } from "hono";
import {
  listSources,
  createSource,
  updateSource,
  deleteSource,
} from "../lib/radio-sources.js";
import { requireRole } from "../lib/auth-middleware.js";

export const radioSourceRoutes = new Hono();

// Radio sources are platform content — only admins should manage the
// catalogue. Writers inherit from the list via moderator dropdowns but
// they don't need CRUD access.
radioSourceRoutes.use("/radio-sources", requireRole("admin"));
radioSourceRoutes.use("/radio-sources/*", requireRole("admin"));

radioSourceRoutes.get("/radio-sources", async (c) => {
  return c.json(await listSources());
});

radioSourceRoutes.post("/radio-sources", async (c) => {
  const body = await c.req.json();
  if (
    typeof body.name !== "string" ||
    typeof body.streamUrl !== "string" ||
    typeof body.urlPattern !== "string" ||
    typeof body.defaultOffsetSeconds !== "number"
  ) {
    return c.json(
      { error: "name, streamUrl, urlPattern, and defaultOffsetSeconds are required" },
      400,
    );
  }

  try {
    const source = await createSource({
      name: body.name,
      streamUrl: body.streamUrl,
      urlPattern: body.urlPattern,
      defaultOffsetSeconds: body.defaultOffsetSeconds,
      transcode: typeof body.transcode === "boolean" ? body.transcode : false,
    });
    return c.json(source, 201);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

radioSourceRoutes.patch("/radio-sources/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();

  try {
    const source = await updateSource(id, {
      name: typeof body.name === "string" ? body.name : undefined,
      streamUrl: typeof body.streamUrl === "string" ? body.streamUrl : undefined,
      urlPattern: typeof body.urlPattern === "string" ? body.urlPattern : undefined,
      defaultOffsetSeconds:
        typeof body.defaultOffsetSeconds === "number" ? body.defaultOffsetSeconds : undefined,
      transcode: typeof body.transcode === "boolean" ? body.transcode : undefined,
    });
    if (!source) return c.json({ error: "Not found" }, 404);
    return c.json(source);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

radioSourceRoutes.delete("/radio-sources/:id", async (c) => {
  const id = c.req.param("id");
  try {
    await deleteSource(id);
    return c.body(null, 204);
  } catch (err) {
    if ((err as any)?.code === "23503") {
      return c.json({ error: "Source is referenced by one or more broadcasts" }, 409);
    }
    return c.json({ error: (err as Error).message }, 500);
  }
});
