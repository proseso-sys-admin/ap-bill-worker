import { describe, it, expect, vi } from "vitest";
import { verifyWebhookTenant } from "../src/webhookAuth.js";

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  };
}

function makeTarget(db, overrides = {}) {
  return {
    targetKey: `key-${db}`,
    targetCfg: { baseUrl: `https://${db}.odoo.com`, db, login: "x@y", password: "k" },
    companyId: 1,
    ...overrides
  };
}

describe("verifyWebhookTenant", () => {
  it("returns {ok:true, target} when slug matches a target and record exists", async () => {
    const targets = [makeTarget("proseso-accounting-test"), makeTarget("other-db")];
    const getTargets = vi.fn().mockResolvedValue(targets);
    const odooRead = vi.fn().mockResolvedValue([{ id: 42 }]);
    const makeClient = vi.fn().mockReturnValue({ searchRead: odooRead });
    const logger = makeLogger();

    const result = await verifyWebhookTenant({
      slug: "proseso-accounting-test",
      model: "documents.document",
      id: 42,
      getTargets,
      makeClient,
      logger
    });

    expect(result).toEqual({ ok: true, target: targets[0] });
    expect(makeClient).toHaveBeenCalledWith(targets[0].targetCfg);
    expect(odooRead).toHaveBeenCalledWith("documents.document", [["id", "=", 42]], ["id"], { limit: 1 });
  });

  it("returns {ok:false, status:404, reason:'unknown_tenant'} when slug does not match any target", async () => {
    const targets = [makeTarget("proseso-accounting-test")];
    const getTargets = vi.fn().mockResolvedValue(targets);
    const makeClient = vi.fn();
    const logger = makeLogger();

    const result = await verifyWebhookTenant({
      slug: "stranger-db",
      model: "documents.document",
      id: 42,
      getTargets,
      makeClient,
      logger
    });

    expect(result).toEqual({ ok: false, status: 404, reason: "unknown_tenant" });
    expect(makeClient).not.toHaveBeenCalled();
  });

  it("returns {ok:false, status:404, reason:'record_not_found'} when record does not exist in tenant", async () => {
    const targets = [makeTarget("proseso-accounting-test")];
    const getTargets = vi.fn().mockResolvedValue(targets);
    const odooRead = vi.fn().mockResolvedValue([]);
    const makeClient = vi.fn().mockReturnValue({ searchRead: odooRead });
    const logger = makeLogger();

    const result = await verifyWebhookTenant({
      slug: "proseso-accounting-test",
      model: "documents.document",
      id: 9999,
      getTargets,
      makeClient,
      logger
    });

    expect(result).toEqual({ ok: false, status: 404, reason: "record_not_found" });
  });

  it("returns {ok:false, status:502, reason:'odoo_error'} when Odoo read throws", async () => {
    const targets = [makeTarget("proseso-accounting-test")];
    const getTargets = vi.fn().mockResolvedValue(targets);
    const odooRead = vi.fn().mockRejectedValue(new Error("xmlrpc 500"));
    const makeClient = vi.fn().mockReturnValue({ searchRead: odooRead });
    const logger = makeLogger();

    const result = await verifyWebhookTenant({
      slug: "proseso-accounting-test",
      model: "documents.document",
      id: 42,
      getTargets,
      makeClient,
      logger
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(502);
    expect(result.reason).toBe("odoo_error");
  });

  it("rejects missing or invalid inputs with status 400", async () => {
    const logger = makeLogger();
    const common = { getTargets: vi.fn(), makeClient: vi.fn(), logger };

    expect(
      await verifyWebhookTenant({ slug: "", model: "documents.document", id: 1, ...common })
    ).toMatchObject({ ok: false, status: 400 });

    expect(
      await verifyWebhookTenant({ slug: "x", model: "", id: 1, ...common })
    ).toMatchObject({ ok: false, status: 400 });

    expect(
      await verifyWebhookTenant({ slug: "x", model: "documents.document", id: 0, ...common })
    ).toMatchObject({ ok: false, status: 400 });
  });

  it("with requireRecord=false, skips Odoo read and succeeds on tenant match alone", async () => {
    const targets = [makeTarget("proseso-accounting-test")];
    const getTargets = vi.fn().mockResolvedValue(targets);
    const odooRead = vi.fn();
    const makeClient = vi.fn().mockReturnValue({ searchRead: odooRead });
    const logger = makeLogger();

    const result = await verifyWebhookTenant({
      slug: "proseso-accounting-test",
      model: "documents.document",
      id: 2787,
      getTargets,
      makeClient,
      logger,
      requireRecord: false
    });

    expect(result).toEqual({ ok: true, target: targets[0] });
    expect(makeClient).not.toHaveBeenCalled();
    expect(odooRead).not.toHaveBeenCalled();
  });

  it("with requireRecord=false, still rejects unknown tenant slug with 404", async () => {
    const getTargets = vi.fn().mockResolvedValue([makeTarget("proseso-accounting-test")]);
    const makeClient = vi.fn();
    const logger = makeLogger();

    const result = await verifyWebhookTenant({
      slug: "ghost-db",
      model: "documents.document",
      id: 2787,
      getTargets,
      makeClient,
      logger,
      requireRecord: false
    });

    expect(result).toMatchObject({ ok: false, status: 404, reason: "unknown_tenant" });
  });

  it("accepts mail.message model and verifies the message record", async () => {
    const targets = [makeTarget("proseso-accounting-test")];
    const getTargets = vi.fn().mockResolvedValue(targets);
    const odooRead = vi.fn().mockResolvedValue([{ id: 7 }]);
    const makeClient = vi.fn().mockReturnValue({ searchRead: odooRead });
    const logger = makeLogger();

    const result = await verifyWebhookTenant({
      slug: "proseso-accounting-test",
      model: "mail.message",
      id: 7,
      getTargets,
      makeClient,
      logger
    });

    expect(result.ok).toBe(true);
    expect(odooRead).toHaveBeenCalledWith("mail.message", [["id", "=", 7]], ["id"], { limit: 1 });
  });
});
