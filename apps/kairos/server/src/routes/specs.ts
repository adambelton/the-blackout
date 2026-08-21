import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { serviceSpecs } from "../db/schema.js";

const specRoutes = new Hono();

specRoutes.get("/specs", async (c) => {
  const specs = await db.select().from(serviceSpecs);
  return c.json({ specs });
});

specRoutes.get("/specs/:service/:profile", async (c) => {
  const { service, profile } = c.req.param();
  const versions = await db
    .select()
    .from(serviceSpecs)
    .where(
      and(
        eq(serviceSpecs.serviceName, service),
        eq(serviceSpecs.eventProfileName, profile),
      ),
    );

  if (versions.length === 0) {
    return c.json({ error: `No specs found for ${service}/${profile}` }, 404);
  }

  return c.json({ versions });
});

specRoutes.post("/specs/:service/:profile/:version/promote", async (c) => {
  const { service, profile, version } = c.req.param();

  const target = await db.query.serviceSpecs.findFirst({
    where: and(
      eq(serviceSpecs.serviceName, service),
      eq(serviceSpecs.eventProfileName, profile),
      eq(serviceSpecs.version, version),
    ),
  });

  if (!target) {
    return c.json({ error: `Spec ${service}/${profile}@${version} not found` }, 404);
  }

  if (target.status === "archived") {
    return c.json({ error: `Cannot promote archived spec` }, 409);
  }

  if (target.status === "active") {
    return c.json({ error: `Spec is already active` }, 409);
  }

  const now = new Date();

  const promoted = await db.transaction(async (tx) => {
    await tx
      .update(serviceSpecs)
      .set({ status: "archived", archivedAt: now })
      .where(
        and(
          eq(serviceSpecs.serviceName, service),
          eq(serviceSpecs.eventProfileName, profile),
          eq(serviceSpecs.status, "active"),
        ),
      );

    const [row] = await tx
      .update(serviceSpecs)
      .set({ status: "active", activatedAt: now })
      .where(eq(serviceSpecs.id, target.id))
      .returning();

    return row;
  });

  return c.json(promoted);
});

export { specRoutes };
