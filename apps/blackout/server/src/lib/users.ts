import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { users } from "@blackout/auth";

const connectionString = process.env.DATABASE_URL!;
const client = postgres(connectionString, { prepare: false });
const authDb = drizzle(client, { schema: { users } });

export interface UserSummary {
  id: string;
  name: string;
  email: string;
  role: string | null;
  createdAt: Date;
}

export async function listUsers(): Promise<UserSummary[]> {
  const rows = await authDb
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(users.createdAt);
  return rows;
}

export async function setUserRole(
  id: string,
  role: "admin" | "writer" | null,
): Promise<UserSummary | null> {
  const [row] = await authDb
    .update(users)
    .set({ role })
    .where(eq(users.id, id))
    .returning({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      createdAt: users.createdAt,
    });
  return row ?? null;
}
