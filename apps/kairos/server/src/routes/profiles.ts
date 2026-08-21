import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { eventProfiles } from "../db/schema.js";

const profileRoutes = new Hono();

profileRoutes.get("/profiles", async (c) => {
  const profiles = await db.select().from(eventProfiles);
  return c.json({ profiles });
});

profileRoutes.get("/profiles/:name", async (c) => {
  const { name } = c.req.param();
  const profile = await db.query.eventProfiles.findFirst({
    where: eq(eventProfiles.name, name),
  });

  if (!profile) {
    return c.json({ error: `Profile "${name}" not found` }, 404);
  }

  return c.json(profile);
});

export { profileRoutes };
