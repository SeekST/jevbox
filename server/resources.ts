import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  HttpError,
  requireResource,
  visibleResources,
  type Actor,
  type Resource,
  type Store,
} from "./db";

export const resourceName = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .refine(
    (s) => !/[\x00-\x1f/\\]/.test(s),
    "Use a name without slashes or control characters",
  );
export const resourceDescription = z.string().max(1000).default("");

export type ResourceChange = {
  auditPrefix?: "" | "api.";
  // Runs inside the transaction after the change; throwing rolls it back.
  revalidate?: () => Promise<unknown>;
};

export function createResourceOperations(store: Store) {
  const now = () => new Date().toISOString();
  const audit = (a: Actor, action: string, resourceId: string) =>
    store.run(
      "INSERT INTO audit(org_id,user_id,action,resource_id,created) VALUES(?,?,?,?,?)",
      a.orgId,
      a.userId,
      action,
      resourceId,
      now(),
    );
  function change<T>(
    options: ResourceChange,
    work: (prefix: string) => Promise<T>,
  ) {
    return store.transaction(async () => {
      const result = await work(options.auditPrefix ?? "");
      await options.revalidate?.();
      return result;
    });
  }
  async function list(
    a: Actor,
    filter: { parentId?: string; kind?: Resource["kind"] } = {},
  ) {
    if (
      filter.parentId &&
      (await requireResource(store, a, filter.parentId)).kind !== "folder"
    )
      throw new HttpError(404, "Folder not found");
    return (await visibleResources(store, a)).filter(
      (r) =>
        (!filter.parentId || r.parent_id === filter.parentId) &&
        (!filter.kind || r.kind === filter.kind),
    );
  }
  function createFolder(
    a: Actor,
    input: { name: string; description: string; parentId: string | null },
    options: ResourceChange = {},
  ) {
    return change(options, async (prefix) => {
      if (
        input.parentId &&
        (await requireResource(store, a, input.parentId, "write")).kind !==
          "folder"
      )
        throw new HttpError(400, "Invalid parent");
      const id = randomUUID();
      await store.run(
        "INSERT INTO resources(id,org_id,owner_id,parent_id,kind,name,description,created) VALUES(?,?,?,?,'folder',?,?,?)",
        id,
        a.orgId,
        a.userId,
        input.parentId,
        input.name,
        input.description,
        now(),
      );
      await audit(a, `${prefix}folder.create`, id);
      return { id };
    });
  }
  function rename(
    a: Actor,
    id: string,
    input: { name: string; description?: string },
    options: ResourceChange = {},
  ) {
    return change(options, async (prefix) => {
      const r = await requireResource(store, a, id, "write");
      await store.run(
        "UPDATE resources SET name=?,description=COALESCE(?,description) WHERE id=?",
        input.name,
        input.description ?? null,
        r.id,
      );
      await audit(a, `${prefix}resource.update`, r.id);
    });
  }
  function move(
    a: Actor,
    id: string,
    parentId: string | null,
    options: ResourceChange = {},
  ) {
    return change(options, async (prefix) => {
      const resource = await requireResource(store, a, id, "share");
      await store.run(
        "UPDATE document_filing SET state='completed',outcome=?,attempt_id=NULL,error=NULL WHERE resource_id=?",
        JSON.stringify({ reason: "manual", parentId }),
        resource.id,
      );
      if (parentId === resource.parent_id) return;
      if (parentId) {
        const destination = await requireResource(store, a, parentId, "write");
        if (destination.kind !== "folder")
          throw new HttpError(400, "Choose a folder as the destination");
        let ancestor: string | null = parentId;
        const seen = new Set<string>();
        while (ancestor) {
          if (ancestor === resource.id || seen.has(ancestor))
            throw new HttpError(
              400,
              "A folder cannot be moved into itself or its descendants",
            );
          seen.add(ancestor);
          const parent: { parent_id: string | null } | undefined =
            await store.one(
              "SELECT parent_id FROM resources WHERE id=? AND org_id=?",
              ancestor,
              a.orgId,
            );
          ancestor = parent?.parent_id ?? null;
        }
      }
      await store.run(
        "UPDATE resources SET parent_id=?,access=CASE WHEN ?::text IS NULL AND access='inherit' THEN 'restricted' ELSE access END WHERE id=?",
        parentId,
        parentId,
        resource.id,
      );
      await audit(a, `${prefix}resource.move`, resource.id);
    });
  }
  function remove(
    a: Actor,
    selectedIds: string[],
    options: ResourceChange = {},
  ) {
    return change(options, async (prefix) => {
      for (const resourceId of selectedIds)
        await requireResource(store, a, resourceId, "share");
      const descendants = await store.all<{ id: string }>(
        `WITH RECURSIVE subtree AS (
          SELECT id FROM resources WHERE org_id=? AND id=ANY(?::text[])
          UNION
          SELECT r.id FROM resources r JOIN subtree s ON r.parent_id=s.id WHERE r.org_id=?
        ) SELECT id FROM subtree`,
        a.orgId,
        selectedIds,
        a.orgId,
      );
      const resourceIds = descendants.map((resource) => resource.id);
      for (const resourceId of resourceIds)
        if (!selectedIds.includes(resourceId))
          await requireResource(store, a, resourceId, "share");
      await store.run(
        "DELETE FROM resources WHERE org_id=? AND id=ANY(?::text[])",
        a.orgId,
        resourceIds,
      );
      for (const resourceId of resourceIds)
        await audit(a, `${prefix}resource.delete`, resourceId);
      return resourceIds.length;
    });
  }
  return { list, createFolder, rename, move, remove };
}
