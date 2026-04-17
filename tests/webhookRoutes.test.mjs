import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { attachWebhookRoutes } from "../src/webhookRoutes.js";

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeTargets(slugs) {
  return slugs.map((db) => ({
    targetKey: `key-${db}`,
    targetCfg: { baseUrl: `https://${db}.odoo.com`, db, login: "x@y", password: "k" },
    companyId: 1
  }));
}

function makeApp({ targets = makeTargets(["proseso-accounting-test"]), odooRows = [{ id: 42 }], handlers = {}, limiterOpts = { ratePerMinute: 1000, burst: 1000 } } = {}) {
  const app = express();
  app.use(express.json());
  const getTargets = vi.fn().mockResolvedValue(targets);
  const read = vi.fn().mockResolvedValue(odooRows);
  const makeClient = vi.fn().mockReturnValue({ searchRead: read });
  const defaultHandlers = {
    onDocumentUpload: vi.fn().mockResolvedValue({ ok: true, mode: "document-upload" }),
    onDocumentDelete: vi.fn().mockResolvedValue({ ok: true, mode: "document-delete" }),
    onChatterMessage: vi.fn().mockResolvedValue({ ok: true, mode: "chatter" }),
    onBsDocumentUpload: vi.fn().mockResolvedValue({ ok: true, mode: "bs-document-upload" }),
    onBsDocumentDelete: vi.fn().mockResolvedValue({ ok: true, mode: "bs-document-delete" }),
    onBsChatterMessage: vi.fn().mockResolvedValue({ ok: true, mode: "bs-chatter" })
  };
  const allHandlers = { ...defaultHandlers, ...handlers };
  attachWebhookRoutes(app, {
    getTargets,
    makeClient,
    logger: makeLogger(),
    handlers: allHandlers,
    limiterOpts
  });
  return { app, getTargets, read, makeClient, handlers: allHandlers };
}

describe("webhook routes — new /webhook/<type>/:slug form", () => {
  it("POST /webhook/document-upload/:slug returns 200 and calls handler with verified target", async () => {
    const { app, handlers } = makeApp();
    const res = await request(app)
      .post("/webhook/document-upload/proseso-accounting-test")
      .send({ _id: 42, _model: "documents.document", id: 42 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, mode: "document-upload" });
    expect(handlers.onDocumentUpload).toHaveBeenCalledTimes(1);
    const call = handlers.onDocumentUpload.mock.calls[0][0];
    expect(call.target.targetKey).toBe("key-proseso-accounting-test");
    expect(call.payload.doc_id).toBe(42);
    expect(call.payload.target_key).toBe("key-proseso-accounting-test");
  });

  it("POST /webhook/document-upload/:slug returns 404 when slug unknown", async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post("/webhook/document-upload/ghost-db")
      .send({ _id: 42, _model: "documents.document", id: 42 });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("unknown_tenant");
  });

  it("POST /webhook/document-upload/:slug returns 404 when record missing", async () => {
    const { app } = makeApp({ odooRows: [] });
    const res = await request(app)
      .post("/webhook/document-upload/proseso-accounting-test")
      .send({ _id: 9999, _model: "documents.document", id: 9999 });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("record_not_found");
  });

  it("POST /webhook/document-upload/:slug returns 400 on missing _id/_model", async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post("/webhook/document-upload/proseso-accounting-test")
      .send({});
    expect(res.status).toBe(400);
  });

  it("rate-limits requests per slug and returns 429 with Retry-After", async () => {
    const { app } = makeApp({ limiterOpts: { ratePerMinute: 60, burst: 1 } });
    const first = await request(app)
      .post("/webhook/document-upload/proseso-accounting-test")
      .send({ _id: 42, _model: "documents.document", id: 42 });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post("/webhook/document-upload/proseso-accounting-test")
      .send({ _id: 42, _model: "documents.document", id: 42 });
    expect(second.status).toBe(429);
    expect(second.headers["retry-after"]).toBeDefined();
  });

  it("POST /webhook/document-delete/:slug routes to onDocumentDelete", async () => {
    const { app, handlers } = makeApp();
    const res = await request(app)
      .post("/webhook/document-delete/proseso-accounting-test")
      .send({ _id: 42, _model: "documents.document", id: 42 });

    expect(res.status).toBe(200);
    expect(handlers.onDocumentDelete).toHaveBeenCalledTimes(1);
  });

  it("POST /webhook/document-delete/:slug succeeds when record is already gone (unlink fires after delete)", async () => {
    const { app, handlers, read } = makeApp({ odooRows: [] });
    const res = await request(app)
      .post("/webhook/document-delete/proseso-accounting-test")
      .send({ _id: 2787, _model: "documents.document", id: 2787 });

    expect(res.status).toBe(200);
    expect(handlers.onDocumentDelete).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
  });

  it("POST /webhook/bs-document-delete/:slug succeeds when record is already gone", async () => {
    const { app, handlers, read } = makeApp({ odooRows: [] });
    const res = await request(app)
      .post("/webhook/bs-document-delete/proseso-accounting-test")
      .send({ _id: 2787, _model: "documents.document", id: 2787 });

    expect(res.status).toBe(200);
    expect(handlers.onBsDocumentDelete).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
  });

  it("POST /webhook/document-delete/:slug still rejects unknown slug with 404", async () => {
    const { app, handlers } = makeApp();
    const res = await request(app)
      .post("/webhook/document-delete/ghost-db")
      .send({ _id: 42, _model: "documents.document", id: 42 });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("unknown_tenant");
    expect(handlers.onDocumentDelete).not.toHaveBeenCalled();
  });

  it("POST /webhook/chatter-message/:slug routes to onChatterMessage and verifies mail.message", async () => {
    const { app, handlers, read } = makeApp({ odooRows: [{ id: 7 }] });
    const res = await request(app)
      .post("/webhook/chatter-message/proseso-accounting-test")
      .send({ _id: 7, _model: "mail.message", id: 7 });

    expect(res.status).toBe(200);
    expect(handlers.onChatterMessage).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith("mail.message", [["id", "=", 7]], ["id"], { limit: 1 });
  });

  it("POST /webhook/bs-document-upload/:slug routes to onBsDocumentUpload", async () => {
    const { app, handlers } = makeApp();
    const res = await request(app)
      .post("/webhook/bs-document-upload/proseso-accounting-test")
      .send({ _id: 42, _model: "documents.document", id: 42 });

    expect(res.status).toBe(200);
    expect(handlers.onBsDocumentUpload).toHaveBeenCalledTimes(1);
  });

  it("POST /webhook/bs-document-delete/:slug routes to onBsDocumentDelete", async () => {
    const { app, handlers } = makeApp();
    const res = await request(app)
      .post("/webhook/bs-document-delete/proseso-accounting-test")
      .send({ _id: 42, _model: "documents.document", id: 42 });

    expect(res.status).toBe(200);
    expect(handlers.onBsDocumentDelete).toHaveBeenCalledTimes(1);
  });

  it("POST /webhook/bs-chatter-message/:slug routes to onBsChatterMessage", async () => {
    const { app, handlers } = makeApp({ odooRows: [{ id: 7 }] });
    const res = await request(app)
      .post("/webhook/bs-chatter-message/proseso-accounting-test")
      .send({ _id: 7, _model: "mail.message", id: 7 });

    expect(res.status).toBe(200);
    expect(handlers.onBsChatterMessage).toHaveBeenCalledTimes(1);
  });

  it("bubbles 500 when handler throws", async () => {
    const { app } = makeApp({
      handlers: { onDocumentUpload: vi.fn().mockRejectedValue(new Error("boom")) }
    });
    const res = await request(app)
      .post("/webhook/document-upload/proseso-accounting-test")
      .send({ _id: 42, _model: "documents.document", id: 42 });
    expect(res.status).toBe(500);
  });
});
