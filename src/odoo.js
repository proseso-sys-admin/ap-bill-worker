const { normalizeOdooBaseUrl } = require("./utils");

class OdooClient {
  constructor(cfg) {
    this.baseUrl = normalizeOdooBaseUrl(cfg.baseUrl);
    this.db = cfg.db;
    this.login = cfg.login;
    this.password = cfg.password;
    this.uid = 0;
    this.endpoint = `${this.baseUrl}/jsonrpc`;
  }

  async _jsonRpc(service, method, args) {
    const payload = {
      jsonrpc: "2.0",
      method: "call",
      params: { service, method, args },
      id: Date.now()
    };

    const resp = await fetch(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const text = await resp.text();
    if (!resp.ok) throw new Error(`Odoo HTTP ${resp.status}: ${text.slice(0, 600)}`);

    const data = JSON.parse(text);
    if (data.error) {
      const msg = data.error?.data?.message || data.error?.message || JSON.stringify(data.error);
      throw new Error(`Odoo RPC error: ${msg}`);
    }
    return data.result;
  }

  async authenticate() {
    if (this.uid) return this.uid;
    const uid = await this._jsonRpc("common", "authenticate", [
      this.db,
      this.login,
      this.password,
      {}
    ]);
    this.uid = Number(uid) || 0;
    if (!this.uid) {
      throw new Error(`Odoo auth failed for ${this.baseUrl} / ${this.db} / ${this.login}`);
    }
    return this.uid;
  }

  async executeKw(model, method, args = [], kwargs = {}) {
    const uid = await this.authenticate();
    return this._jsonRpc("object", "execute_kw", [
      this.db,
      uid,
      this.password,
      model,
      method,
      args,
      kwargs
    ]);
  }

  async searchRead(model, domain, fields, kwargs = {}) {
    return this.executeKw(model, "search_read", [domain, fields], kwargs);
  }

  async search(model, domain, kwargs = {}) {
    return this.executeKw(model, "search", [domain], kwargs);
  }

  async create(model, vals, kwargs = {}) {
    return this.executeKw(model, "create", [vals], kwargs);
  }

  async write(model, ids, vals) {
    return this.executeKw(model, "write", [ids, vals], {});
  }
}

function kwWithCompany(companyId, extra = {}) {
  const cid = Number(companyId) || 0;
  const context = cid
    ? { allowed_company_ids: [cid], force_company: cid, company_id: cid }
    : {};
  if (extra.context) {
    Object.assign(context, extra.context);
    delete extra.context;
  }
  return { context, ...extra };
}

module.exports = {
  OdooClient,
  kwWithCompany
};
