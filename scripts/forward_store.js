/* Forward-test positions. The project copy is forward.json in the repo, so every
   browser and phone sees the same picks; this browser keeps a working copy in
   localStorage and syncs it with the repo through the GitHub API. Reading needs
   nothing; saving needs a GitHub token (fine-grained, this repo only, Contents
   read/write) pasted once per browser on forward.html.
   Shape of one position:
     { id, t, name, sector, addedAt, updatedAt, entryDate, entryPrice, benchEntry,
       stop, signal: { score, quad, sectorRank, rs21, mfi, regime },
       status: "open" | "closed" | "deleted", closedAt?, exitDate?, exitPrice?, benchExit? }
   A deleted position stays as a small tombstone so a sync cannot bring it back. */

const FT_KEY = "mft-forward-v1";
const FT_TOKEN_KEY = "mft-gh-token";
const FT_REPO = "siwaritjun-test/money-flow-tracker";
const FT_BRANCH = "main";
const FT_FILE = "forward.json";

const ftStamp = p => p.updatedAt || p.closedAt || p.addedAt || "";

/** Union by id; where both sides have a position, the more recently changed one wins. */
function mergePositions(a, b) {
  const byId = new Map();
  for (const p of [...(a || []), ...(b || [])]) {
    if (!p || !p.id) continue;
    const cur = byId.get(p.id);
    if (!cur || ftStamp(p) > ftStamp(cur)) byId.set(p.id, p);
  }
  return [...byId.values()].sort((x, y) => (x.addedAt || "").localeCompare(y.addedAt || "") || x.id.localeCompare(y.id));
}

const ftSame = (a, b) => JSON.stringify(mergePositions(a, [])) === JSON.stringify(mergePositions(b, []));

function ftB64Encode(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const ftB64Decode = b64 => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), c => c.charCodeAt(0)));

const ForwardStore = {
  /** Everything, tombstones included. */
  raw() {
    try {
      const list = JSON.parse(localStorage.getItem(FT_KEY) || "[]");
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  },

  all() {
    return this.raw().filter(p => p.status !== "deleted");
  },

  save(list) {
    localStorage.setItem(FT_KEY, JSON.stringify(list));
    this.sync();
  },

  open() {
    return this.all().filter(p => p.status === "open");
  },

  openFor(ticker) {
    return this.open().find(p => p.t === ticker) || null;
  },

  add(pos) {
    const list = this.raw();
    const id = pos.t + "-" + Date.now().toString(36);
    const now = new Date().toISOString();
    list.push(Object.assign({ id, status: "open", addedAt: now, updatedAt: now }, pos));
    this.save(list);
    return id;
  },

  close(id, exit) {
    const list = this.raw();
    const p = list.find(x => x.id === id);
    if (!p || p.status !== "open") return;
    const now = new Date().toISOString();
    Object.assign(p, { status: "closed", closedAt: now, updatedAt: now }, exit);
    this.save(list);
  },

  remove(id) {
    const list = this.raw();
    const i = list.findIndex(p => p.id === id);
    if (i < 0) return;
    const p = list[i];
    list[i] = { id: p.id, t: p.t, addedAt: p.addedAt, status: "deleted", updatedAt: new Date().toISOString() };
    this.save(list);
  },

  exportJson() {
    return JSON.stringify({ kind: "mft-forward-test", version: 1, exportedAt: new Date().toISOString(), positions: this.all() }, null, 1);
  },

  /** Merge an export into this browser; positions already present (same id) are kept as-is. */
  importJson(text) {
    const data = JSON.parse(text);
    const incoming = Array.isArray(data) ? data : data && data.positions;
    if (!Array.isArray(incoming)) throw new Error("not a forward-test export");
    const valid = incoming.filter(p => p && p.id && p.t && p.entryDate && p.entryPrice > 0);
    const list = this.raw();
    const have = new Set(list.map(p => p.id));
    const added = valid.filter(p => !have.has(p.id));
    this.save(list.concat(added));
    return added.length;
  },

  /* ------------------------------------------------ sync with the repo */
  token() {
    try { return localStorage.getItem(FT_TOKEN_KEY) || ""; } catch (e) { return ""; }
  },

  setToken(tok) {
    if (tok) localStorage.setItem(FT_TOKEN_KEY, tok.trim());
    else localStorage.removeItem(FT_TOKEN_KEY);
  },

  /** { state: "idle"|"syncing"|"saved"|"readonly"|"error", message, at } */
  status: { state: "idle", message: "" },
  _listeners: [],
  onChange(fn) { this._listeners.push(fn); },
  _set(state, message) {
    this.status = { state, message, at: new Date() };
    this._listeners.forEach(fn => { try { fn(this.status); } catch (e) { /* a page render error must not stop sync */ } });
  },

  async _remote() {
    const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
    const tok = this.token();
    if (tok) headers.Authorization = "Bearer " + tok;
    const r = await fetch(`https://api.github.com/repos/${FT_REPO}/contents/${FT_FILE}?ref=${FT_BRANCH}&t=${Date.now()}`,
      { headers, cache: "no-store", signal: AbortSignal.timeout(10000) });
    if (r.status === 404) return { positions: [], sha: null };
    if (r.status === 401) throw new Error("GitHub rejected the token (expired or revoked?)");
    if (!r.ok) {
      // Unauthenticated API calls are rate-limited; the Pages copy may be a minute old but is always there.
      if (!tok) {
        const p = await fetch(FT_FILE + "?t=" + Date.now(), { cache: "no-store" });
        if (p.ok) return { positions: (await p.json()).positions || [], sha: null };
      }
      throw new Error("GitHub API HTTP " + r.status);
    }
    const j = await r.json();
    const data = JSON.parse(ftB64Decode(j.content));
    return { positions: Array.isArray(data.positions) ? data.positions : [], sha: j.sha };
  },

  async _put(positions, sha) {
    const open = positions.filter(p => p.status === "open").length;
    const body = {
      message: `forward test: save picks (${open} open)`,
      content: ftB64Encode(JSON.stringify({ kind: "mft-forward-test", version: 1, updated: new Date().toISOString(), positions }, null, 1) + "\n"),
      branch: FT_BRANCH,
    };
    if (sha) body.sha = sha;
    const r = await fetch(`https://api.github.com/repos/${FT_REPO}/contents/${FT_FILE}`, {
      method: "PUT", cache: "no-store", signal: AbortSignal.timeout(15000),
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", Authorization: "Bearer " + this.token() },
      body: JSON.stringify(body),
    });
    if (r.status === 409 || r.status === 422) return false;   // someone saved in between: re-read and retry
    if (r.status === 401) throw new Error("GitHub rejected the token (expired or revoked?)");
    if (r.status === 403 || r.status === 404) throw new Error("the token cannot write to " + FT_REPO + " (needs Contents: read and write)");
    if (!r.ok) throw new Error("GitHub API HTTP " + r.status);
    return true;
  },

  async _syncOnce() {
    this._set("syncing", "Syncing with the project…");
    for (let attempt = 0; attempt < 4; attempt++) {
      const remote = await this._remote();
      const merged = mergePositions(remote.positions, this.raw());
      if (!ftSame(merged, this.raw())) localStorage.setItem(FT_KEY, JSON.stringify(merged));
      if (ftSame(merged, remote.positions)) {
        this._set(this.token() ? "saved" : "readonly", this.token() ? "Saved to the project" : "Loaded from the project");
        return true;
      }
      if (!this.token()) {
        this._set("readonly", "This browser has picks the project doesn't — connect GitHub to save them");
        return true;
      }
      if (await this._put(merged, remote.sha)) {
        this._set("saved", "Saved to the project");
        return true;
      }
    }
    throw new Error("the file kept changing while saving; try again");
  },

  /** Pull the project copy into this browser and push anything new back. Calls are serialised. */
  sync() {
    if (typeof fetch === "undefined") return Promise.resolve(false);
    this._chain = (this._chain || Promise.resolve()).then(() => this._syncOnce()).catch(e => {
      this._set("error", "Not saved to the project: " + e.message);
      return false;
    });
    return this._chain;
  },
};

if (typeof module !== "undefined") {
  module.exports = { mergePositions };
}
