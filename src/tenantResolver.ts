import { Knex } from "knex";
import { TenantResolverOptions, TenantResolver } from "./types";

/**
 * Framework-agnostic tenant resolver.
 * Call the returned function inside your middleware/pre-handler to attach a tenant-bound knex to the request.
 */
export const createTenantResolver = <Req extends { [k: string]: any }>(
  opts: TenantResolverOptions<Req>
): TenantResolver<Req> => {
  const {
    manager,
    tenantId: tenantIdResolver,
    passwordProvider,
    authorizer,
    attach,
  } = opts;

  return async (req: Req): Promise<{ tenantId?: string; knex?: Knex }> => {
    const tenantId = await tenantIdResolver(req);
    if (!tenantId) return {};

    let password: string | undefined;
    if (passwordProvider) {
      password = await passwordProvider(tenantId);
    }

    const knex = manager.getTenant(tenantId, password);

    if (authorizer) {
      await authorizer(tenantId, req);
    }

    // default attach shape: req.tenantId + req.knex
    if (attach) {
      attach(req, tenantId, knex);
    } else {
      (req as any).tenantId = tenantId;
      (req as any).knex = knex;
    }

    return { tenantId, knex };
  };
};
