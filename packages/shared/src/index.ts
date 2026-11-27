import { z } from "zod";

export const HealthResponseSchema = z.object({
  db: z.enum(["ok", "error"]),
  redis: z.enum(["ok", "error"]),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const UserRoleSchema = z.enum(["ORGANIZER", "ATTENDEE"]);

export type UserRole = z.infer<typeof UserRoleSchema>;
