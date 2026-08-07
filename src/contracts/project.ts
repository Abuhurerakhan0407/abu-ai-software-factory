import { z } from "zod";

export const RepositoryNameSchema = z.string()
  .min(3)
  .max(200)
  .regex(
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
    "Repository must use owner/name format",
  );

export const ProjectStatusSchema = z.enum(["active", "paused", "archived"]);

export const DatabaseEnvironmentInputSchema = z.object({
  stagingDatabaseEnv: z.string().regex(/^[A-Z][A-Z0-9_]{2,80}$/),
  productionDatabaseEnv: z.string().regex(/^[A-Z][A-Z0-9_]{2,80}$/),
}).refine(
  (config) => config.stagingDatabaseEnv !== config.productionDatabaseEnv,
  "Staging and production database env keys must differ",
);

export const ProjectInputSchema = z.object({
  name: z.string().min(3).max(160),
  repository: RepositoryNameSchema,
  database: DatabaseEnvironmentInputSchema.optional(),
});

export const ProjectRecordSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(3).max(160),
  repository: RepositoryNameSchema,
  status: ProjectStatusSchema,
  config: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type ProjectInput = z.infer<typeof ProjectInputSchema>;
export type ProjectRecord = z.infer<typeof ProjectRecordSchema>;
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;
